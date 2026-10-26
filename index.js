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
 * @module dsh-commander-mode
 */

import { Config } from './lib/config.js';
import { hidePresetsFromCatalog, isSpecialistPresetId } from './lib/preset-catalog.js';
import { provideSettings } from './lib/settings-service.js';

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
 * 本行**不硬性依赖**任何服务：设置页策略是可选的。
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

  ctx.logger?.info?.('commander-mode: 配置行就绪（设置命名空间 commander-mode）');
}
