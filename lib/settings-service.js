/**
 * `commanderSettings` 服务 —— 配置行（profile 顶层）与模式行（preset 子行）之间的桥。
 *
 * ## 为什么必须是两行
 *
 * 「指挥者模式」的模式行（`commander-mode-agent`）挂在 agent preset 的 `plugins` 里。
 * preset 子行是**运行时挂载**的 Cordis fiber，**不在 Loader 的 entry 树里**
 * （dsh-tool-cordis 的原话："runtime-created Agent preset trees are outside the Loader"）。
 * 而设置页的两条通路都读 Loader 树：
 *
 * - `Config.listConfigs` 读 `loader.entries()`；
 * - `settings.describe()` 读 `configEditor.configuration()`。
 *
 * 实测（dsh 0.2.1-rc.2）：把 `Config` 声明在 preset 子行上，两处都**看不到**该行，于是
 * `configForms.whileServed(['commander-mode'])` 永远为假，设置页卡片**静默消失**。
 *
 * 所以配置必须活在**profile 顶层行**（`commander-mode`，也就设置命名空间），而模式行
 * 通过这个服务读它。参考实现 `dsh-multi-model-orchestrator` 是同样的结构。
 *
 * ## 变化怎么传播
 *
 * volatile 字段（`specialists`）被设置页保存时，Loader 只更新运行中的引用并发出
 * `loader/volatile-update` —— 事件发给**配置行自己的 fiber**，preset 行收不到。所以由
 * 配置行在这里转成订阅通知；模式行订阅后重建 specialist preset/工具。
 *
 * @module dsh-commander-mode/lib/settings-service
 */

import {
  readMaxSpecialists,
  readSpecialists,
  resolveConfig,
} from './config.js';
import { resolveRoster } from './specialists.js';

/**
 * 配置行提供给模式行的服务。
 *
 * 方法都返回**当前值**（不缓存），所以 volatile 更新后下一次调用立刻读到新配置。
 */
export class CommanderSettings {
  /**
   * @param {object} ctx - 配置行的 Cordis 上下文。
   * @param {unknown} config - 配置行的 `Config`（volatile 字段是引用）。
   */
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    /** @type {Set<() => void>} */
    this.listeners = new Set();
  }

  /**
   * 加载期选项（confirmPlan / maxTeammates / blockedTools / …）。
   *
   * @returns {object} 与 0.1.x 的 `resolveConfig().options` 同形。
   */
  options() {
    return resolveConfig(this.config).options;
  }

  /**
   * 当前清洗后的 specialist 名册（实时读 volatile 引用）。
   *
   * @returns {object[]} 名册。
   */
  specialists() {
    return resolveRoster(this.config, { logger: this.ctx?.logger });
  }

  /**
   * 订阅"名册可能变了"的通知。
   *
   * 订阅者只需重建工具清单，**不要**在这里重新注册行 —— 行由 Loader 管理。
   *
   * @param {() => void} listener - 变更回调。
   * @returns {() => void} 退订函数。
   */
  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 广播一次变更（由配置行在 `loader/volatile-update` 时调用）。
   *
   * @param {string[]} [paths] - 变更字段路径，用于诊断。
   */
  notify(paths = []) {
    for (const listener of [...this.listeners]) {
      try {
        listener(paths);
      } catch (error) {
        this.ctx?.logger?.warn?.('commander-mode: 配置订阅者抛错：%o', error);
      }
    }
  }

  /**
   * 当前名册条数上限。
   *
   * @returns {number} 上限。
   */
  maxSpecialists() {
    return readMaxSpecialists(this.config);
  }
}

/** Cordis 服务名。 */
export const SETTINGS_SERVICE_NAME = 'commanderSettings';

/**
 * 创建并发布服务。
 *
 * @param {object} ctx - 配置行上下文。
 * @param {unknown} config - 配置行配置。
 * @returns {CommanderSettings} 服务实例。
 */
export function provideSettings(ctx, config) {
  const service = new CommanderSettings(ctx, config);

  // volatile 变化只发给**配置行自己的 fiber**；这里转成服务通知。
  ctx.on('loader/volatile-update', (paths) => {
    if (!Array.isArray(paths)) return;
    if (paths.some((path) => Array.isArray(path) && path[0] === 'specialists')) {
      service.notify(paths);
    }
  });

  ctx.provide(SETTINGS_SERVICE_NAME, service);
  return service;
}

/** 供测试与诊断：读原始名册（未清洗）。 */
export { readSpecialists };
