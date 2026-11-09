/**
 * 测试夹具：最小可用的 Cordis 上下文替身（`project-manager.test.mjs` / `workflow.test.mjs` 共用）。
 *
 * 为什么单独抽一个文件：`plugin.test.mjs` 的夹具是给「指挥者模式行」写的（带账本、看板、
 * turn-stopping 等），项目经理行只需要其中一小部分；复制一份会很快漂移。这里只提供
 * 两个新模式**真的用到**的东西：
 *
 * - `systemPrompt.section` / `skills.register` / `tools.register` / `agentPresets.register`
 *   / `subagents.startActivation` 的替身；
 * - `ctx.inject()` 的「依赖缺一个就不执行」语义（与真实 Cordis 一致）；
 * - `agentPresets.register` 的 **全局 id 唯一** 语义 —— 两个 preset 共用同一份专家名册时，
 *   后挂载的一行会收到 `Duplicate agent preset`。服务替身必须复现它，否则测试就测不到
 *   项目经理行的重复注册兜底。
 *
 * 本文件不是 `*.test.mjs`，不会被 `node --test "test/**\/*.test.mjs"` 当成用例。
 */

import { resolveConfig } from '../lib/config.js';
import { cloneDefaultSpecialists } from '../lib/presets.js';

/** 让排队的微任务/异步重建跑完。 */
export async function flush() {
  for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** 一个 Lead agent（没有父会话 = 不是被委派出来的子级）。 */
export const LEAD = Object.freeze({ id: 'session-lead', session: { id: 'session-lead', header: { id: 'session-lead' } } });

/** 一个 teammate（三个身份证据齐全）。 */
export const TEAMMATE = Object.freeze({
  id: 'session-child',
  session: { id: 'session-child', header: { id: 'session-child', parentSession: 'session-lead', origin: 'subagent', delegationDepth: 1 } },
});

/**
 * `commanderSettings` 服务的替身（配置行提供）。
 *
 * 默认选项直接取 `resolveConfig(undefined).options`，与 schema 默认值保持同一份，
 * 避免测试里的夹具默认值落后于真实默认值（例如 `maxWaitMs`）。
 *
 * @param {{ options?: object, specialists?: object[] }} [initial] - 初始选项与名册。
 * @returns {object} 服务替身。
 */
export function makeSettings(initial = {}) {
  let options = { ...resolveConfig(undefined).options, ...(initial.options ?? {}) };
  let roster = initial.specialists ?? [];
  const listeners = new Set();
  return {
    options: () => ({ ...options }),
    specialists: () => roster.slice(0, options.maxSpecialists).map((entry) => ({ ...entry })),
    maxSpecialists: () => options.maxSpecialists,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 测试助手：改名册并广播（等价于配置行收到 loader/volatile-update）。 */
    update(next) {
      roster = next;
      for (const listener of [...listeners]) listener([['specialists']]);
    },
    setOptions(next) {
      options = { ...options, ...next };
    },
    listenerCount: () => listeners.size,
  };
}

/** 出厂预置名册的副本（可安全传给 `makeSettings`）。 */
export function defaultRoster() {
  return cloneDefaultSpecialists();
}

/**
 * `subagents` 服务的替身：记录 `startActivation`，`result` 返回给定结算。
 *
 * @param {object} record - 记录对象（写入 `activations`）。
 * @param {Promise|object} [settlement] - 结算结果（可以是 Promise）。
 * @returns {object} 服务替身。
 */
function makeSubagents(record, settlement) {
  return {
    resolveMaxDepth: (depth) => depth,
    startActivation: async (request) => {
      record.activations.push(request);
      return { childId: 'child-1', result: Promise.resolve(settlement), dispose: async () => {} };
    },
  };
}

/** 一个可手动结算的 Promise（测试异步派发用）。 */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 一个 Cordis 上下文的替身。
 *
 * @param {object} [options] - 夹具开关。
 * @param {boolean} [options.withSkills] - 是否提供 `skills` 服务。
 * @param {boolean} [options.withSpecialistServices] - 是否提供 `tools` / `subagents` / `agentPresets`。
 * @param {boolean} [options.withCommanderSettings] - 是否提供 `commanderSettings` 服务。
 * @param {object} [options.settings] - `commanderSettings` 替身。
 * @param {Promise|object} [options.settlement] - 子代理结算结果。
 * @param {string[]} [options.preRegisteredPresets] - 预置"已被其它模式注册"的 preset id。
 * @returns {{ ctx: object, record: object, settings: object }} 上下文、记录与服务。
 */
export function makeCtx({
  withSkills = true,
  withSpecialistServices = true,
  withCommanderSettings = true,
  settings = makeSettings(),
  settlement = { output: [{ type: 'text', text: '子代理答复' }], stopReason: 'completed' },
  preRegisteredPresets = [],
} = {}) {
  const record = {
    sections: [],
    skills: [],
    listeners: [],
    warnings: [],
    effects: [],
    tools: [],
    presets: [],
    activations: [],
    /** 记录 `agent.steer()` 的替身收到的消息。 */
    steers: [],
    /** agentPresets 已注册的 id（用于复现重复注册错误）。 */
    presetIds: new Set(preRegisteredPresets),
  };
  const logger = {
    info: () => {},
    debug: () => {},
    warn: (...args) => record.warnings.push(args.map(String).join(' ')),
  };

  const services = {
    ...(withCommanderSettings ? { commanderSettings: settings } : {}),
    ...(withSkills ? {
      skills: {
        register: (definition) => {
          record.skills.push(definition);
          return () => {};
        },
      },
    } : {}),
    ...(withSpecialistServices ? {
      tools: {
        register: (definition) => {
          record.tools.push(definition);
          return () => {
            record.tools = record.tools.filter((entry) => entry !== definition);
          };
        },
      },
      subagents: makeSubagents(record, settlement),
      agentPresets: {
        register: async (definition) => {
          if (record.presetIds.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`);
          record.presetIds.add(definition.id);
          record.presets.push(definition);
          return async () => {
            record.presetIds.delete(definition.id);
            record.presets = record.presets.filter((entry) => entry !== definition);
          };
        },
      },
    } : {}),
  };

  const ctx = {
    logger,
    systemPrompt: {
      section: (definition) => {
        record.sections.push(definition);
        return () => {};
      },
    },
    on: (event, listener) => {
      record.listeners.push({ event, listener });
      return () => {};
    },
    effect: (callback) => {
      record.effects.push(callback);
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get: (name) => services[name],
    inject: (dependencies, callback) => {
      const available = {};
      for (const dependency of dependencies) {
        if (services[dependency] !== undefined) available[dependency] = services[dependency];
      }
      // 与真实 Cordis 一样：依赖缺一个，回调就不执行。
      if (Object.keys(available).length !== dependencies.length) return;
      callback({
        ...available,
        logger,
        effect: ctx.effect,
        on: ctx.on,
        get: ctx.get,
      });
    },
  };
  return { ctx, record, settings };
}

/**
 * 取某个事件的监听器。
 *
 * @param {object} record - `makeCtx()` 的记录。
 * @param {string} event - 事件名。
 * @returns {Function} 监听器。
 */
export function listenerOf(record, event) {
  const entry = record.listeners.find((item) => item.event === event);
  if (entry === undefined) throw new Error(`没有注册 ${event} 监听器`);
  return entry.listener;
}

/** 一个总是被调用到的 `next()`，记录自己被调了几次。 */
export function spyNext(value = { kind: 'allow' }) {
  const calls = { count: 0 };
  const next = () => {
    calls.count += 1;
    return Promise.resolve(value);
  };
  return { next, calls };
}
