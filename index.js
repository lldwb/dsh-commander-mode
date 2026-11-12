/**
 * `dsh-commander-mode` —— 「指挥者模式」的**配置行**（profile 顶层）。
 *
 * ## 为什么配置必须活在这一行
 *
 * 模式行（`dsh-commander-mode/agent`）挂在 agent preset 的 `plugins` 里。preset 子行是
 * 运行时挂载的 Cordis fiber，**不在 Loader 的 entry 树里**；而设置页的两条通路
 * （`Config.listConfigs` 与 `settings.describe()`）都读那棵树。实测 dsh 0.2.1-rc.2：
 * 把 `Config` 声明在 preset 子行上时，设置命名空间不可达 —— 设置页卡片静默消失。
 *
 * 所以：
 *
 * - 这一行（**profile 顶层**）持有 `Config`、提供 `commanderSettings` 服务、关掉自动页；
 * - 模式行（`./agent`）通过服务读配置、订阅变更。
 *
 * ## 为什么行 name 必须是**裸包名**
 *
 * `dsh-client-modules` 判定"这个 Loader 行有没有 client 半"时，要求行的 `name` 是
 * **不带 `/` 的裸包说明符**（源码：`exactPackageSpecifier()` 对含 `/` 的说明符返回
 * `undefined`，于是 `resolveMeta()` 直接放弃该行）。所以配置行——也就是要让设置页找到的
 * 那一行——必须写 `name: 'dsh-commander-mode'`，不能写 ``'dsh-commander-mode/host'``。
 *
 * 这个约束是实测撞出来的：Host 侧设置投影全都通了（`status: schema`、volatile 可写、
 * 保存后 profile patch 真的变了），但页面清单里就是没有这个包的 client 半。
 *
 * ## 这一行没有任何工具
 *
 * 它只装配置与服务，不注册工具、不注入 prompt —— 所以不会把能力泄漏到别的模式里。
 *
 * ## 0.6.0：工单账本的宿主
 *
 * 这一行还是 `commanderLedger` 服务的宿主：工单要跨会话、跨回合、跨重启存在，而 preset 子行
 * 只在某个 agent 挂载期间存在。账本文件默认 `<DSH_HOME>/commander/<profile>.json`，原子写、
 * 损坏自动备份；初始化失败只降级（模式退化为无账本），绝不让插件起不来。
 *
 * @module dsh-commander-mode
 */

import { Config, resolveConfig } from './lib/config.js';
import { CommanderEventInbox, EVENTS_SERVICE_NAME } from './lib/event-inbox.js';
import { resolveLedgerFile } from './lib/ledger.js';
import { CommanderLedger, LEDGER_SERVICE_NAME } from './lib/ledger-service.js';
import { hidePresetsFromCatalog, isSpecialistPresetId } from './lib/preset-catalog.js';
import { provideSettings } from './lib/settings-service.js';
import { installForcedTeamMode } from './lib/team-mode.js';
import { CommanderWorkers, WORKERS_SERVICE_NAME } from './lib/worker-sessions.js';

/** Cordis 插件名。**必须与 Loader 行 id、设置命名空间、客户端 `SETTINGS_NS` 一致**。 */
export const name = 'commander-mode';

/**
 * 配置 schema。
 *
 * 必须从入口导出：Loader 读模块的 `Config` 导出来决定这一行有没有 schema、以及哪些
 * volatile 字段会出现在设置表单里。
 */
export { Config };

/**
 * 本行**不硬性依赖**任何服务来加载：设置页策略是可选的，`agentTeams` 也由下面的
 * `installForcedTeamMode()` 在运行时探测（缺失时记显式错误日志，而不是让整行不激活 ——
 * 那样用户连设置页都看不到，更难诊断）。
 */
export const inject = [];

/**
 * 注册配置行。
 *
 * @param {object} ctx - Cordis 插件上下文（profile 顶层）。
 * @param {unknown} config - 本行的 `Config`（volatile 字段是引用）。
 */
export function apply(ctx, config) {
  // ① 发布配置服务：模式行靠它读 option / 名册，并订阅 volatile 变化。
  provideSettings(ctx, config);

  // ①.5 发布工单账本服务（0.6.0）：模式行/工单工具靠它读写，账本是唯一写者。
  //
  //     为什么不放在模式行：账本要跨会话、跨回合、跨重启存在，而 preset 子行只在某个
  //     agent 挂载期间存在；配置行是 profile 顶层、进程级常驻，是天然宿主。
  //     写盘失败只降级（内存继续），绝不因为账本坏了让模式起不来。
  const options = resolveConfig(config).options;

  // ①.5 工单账本（0.6.0）：模式行/工单工具靠它读写，账本是唯一写者。
  //     用本地变量把实例传给下面的 worker 块 —— **不要**在同一 apply 里用 ctx.get() 回读：
  //     实测（0.8.0 E2E）provide 后同 tick 读不到，会误判"没有账本"而静默跳过 worker。
  let ledgerService = null;
  if (options.ledger !== false) {
    try {
      const file = resolveLedgerFile({ stateDir: options.stateDir });
      const ledger = new CommanderLedger({
        file,
        logger: ctx.logger,
        maxTickets: options.maxTickets,
      });
      const loaded = ledger.load();
      ctx.provide(LEDGER_SERVICE_NAME, ledger);
      ledgerService = ledger;
      for (const warning of loaded.warnings) ctx.logger?.warn?.('commander-mode: %s', warning);
      ctx.logger?.info?.('commander-mode: 工单账本就绪（%s，%d 张工单）', file, ledger.state.tickets.length);
    } catch (error) {
      // 账本初始化失败：模式仍可用，只是没有工单/授权门禁（降级到 0.5 行为）。
      ctx.logger?.warn?.('commander-mode: 工单账本初始化失败，已降级为无账本模式：%o', error);
    }
  }

  // ①.6 发布 Worker Session 执行器（0.8.0+，opt-in）：每工单独立 Session + 目录。
  //
  //     依赖宿主的 sessionController / workspaceRegistry / agents，但**不用 ctx.inject**：
  //     这些服务可能在 apply 之后才就绪，而服务内部每次都按需 ctx.get。这样：
  //     - 桌面/Web profile 里正常可用；
  //     - headless 等缺服务的部署里，spawn 会精确报告缺哪个服务，而不是整个服务不发布。
  if (options.workerSessions === true && ledgerService !== null) {
    try {
      const workers = new CommanderWorkers({
        ctx,
        ledger: ledgerService,
        getOptions: () => resolveConfig(config).options,
        logger: ctx.logger,
      });
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => workers.install(), 'commander-mode: worker sessions');
      } else {
        workers.install();
      }
      ctx.provide(WORKERS_SERVICE_NAME, workers);
      ctx.logger?.info?.('commander-mode: Worker Session 执行器就绪（opt-in）');
    } catch (error) {
      ctx.logger?.warn?.('commander-mode: Worker Session 初始化失败（模式其余部分不受影响）：%o', error);
    }
  }

  // ①.7 外部事件投递器（1.1.0，默认开）：轮询 `<stateDir>/events/inbox/`，把外部系统
  //     （CI / 告警 / 定时巡检）写来的事件 `steer` 给对应的指挥者会话，空闲会话会被唤醒。
  //     与 worker 不同，这里**不需要**宿主额外服务就能起来（steer 时才去 ctx.get）；
  //     agents/sessions 缺失时事件留在 inbox，等环境恢复或用户手工处理。
  if (options.eventInbox !== false && ledgerService !== null) {
    try {
      const events = new CommanderEventInbox({
        ctx,
        ledger: ledgerService,
        getOptions: () => resolveConfig(config).options,
        logger: ctx.logger,
      });
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => events.install(), 'commander-mode: external events');
      } else {
        events.install();
      }
      ctx.provide(EVENTS_SERVICE_NAME, events);
      ctx.logger?.info?.('commander-mode: 外部事件投递器就绪（%s）', events.directory());
    } catch (error) {
      ctx.logger?.warn?.('commander-mode: 外部事件投递器初始化失败（模式其余部分不受影响）：%o', error);
    }
  }

  // ② 关掉自动生成的设置页：本包自带 client 半（「设置 → 插件 → 指挥者模式」）。
  //    放在可选子级里：没有 settings 服务的部署也要能跑；策略绑在插件自己的 fiber 上，
  //    Loader 重载本行时会一起释放。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      try {
        settingsCtx.effect(
          () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
          'commander-mode: settings presentation policy',
        );
      } catch (error) {
        // 关掉自动页失败不是致命问题：最坏情况是设置里多一个自动生成的卡片。
        ctx.logger?.warn?.('commander-mode: 无法关闭自动设置页：%o', error);
      }
    });
  }

  // ③ 把 specialist preset 从**模式菜单**里隐藏。
  //
  //    每位专家都要一份独立 preset 来承载人设（0.2.x 起 tool-subagent/subagents 不再接受
  //    persona 参数），而注册出来的 preset 默认会出现在模式选择菜单里 —— 用户会看到六条
  //    「指挥官 specialist: …」，像是可选模式。它们不是模式，只是指挥者内部的专家。
  //
  //    这里只包 `remoteExportList`（目录的 UI 通道），不碰注册/挂载：工具照常按 id 挂载、
  //    人设照常生效，只是不再出现在菜单里。细节见 `lib/preset-catalog.js`。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['agentPresets'], (presetCtx) => {
      try {
        presetCtx.effect(
          () => hidePresetsFromCatalog(presetCtx.agentPresets, isSpecialistPresetId),
          'commander-mode: hide specialist presets from the mode menu',
        );
      } catch (error) {
        // 隐藏失败只是菜单里多出几行，不影响专家本身能否被调用 —— 降级为警告。
        ctx.logger?.warn?.('commander-mode: 无法从模式菜单隐藏 specialist preset：%o', error);
      }
    });
  }

  // ④ 智能体团队：指挥官会话**默认启用且不可关闭**（用户 2026-11-12 硬要求）。
  //
  //    DSH 0.2.2-rc.2 把 Agent Teams 改成**按根会话选择**（`team/mode` 事件），新会话默认
  //    关闭；Team 的四个任务工具在关闭时连 schema 都不出现。而「指挥者模式」的三层指挥链
  //    （指挥官 → 小组长 → 子智能体）完全建立在 Team 上 —— 关掉 Team 等于模式失效。
  //
  //    所以这一行（profile 顶层、进程级常驻）做两件事：
  //
  //    1. `agent/created`：根 agent 且会话 preset 是 `commander` → `setEnabled(agent, true)`；
  //    2. `session/event`：指挥官会话出现 `team/mode { enabled: false }` → 立刻重开并记日志。
  //
  //    没有"关闭团队"的配置项：这是硬约束，不是可调选项。
  installForcedTeamMode(ctx);

  ctx.logger?.info?.('commander-mode: 配置行就绪（设置命名空间 commander-mode）');
}
