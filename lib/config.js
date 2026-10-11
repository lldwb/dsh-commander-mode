/**
 * `dsh-commander-mode` 的配置解析。
 *
 * 本插件**故意不声明** `Config` schema：Loader 行的 `config` 无论有没有 schema 都是
 * 未经验证地交给 `apply`，而跳过 schemastery 能让这个包保持**零依赖** ——
 * `install_bundle` 不需要往它的 `node_modules` 里装任何东西就能成功。因此每个字段都
 * 在这里解析：带一个写明了的默认值，未知键会被报出来而不是被默默忽略。
 *
 * @module dsh-commander-mode/lib/config
 */

import { DEFAULT_BLOCKED_TOOLS } from './guard.js';

/** 本插件读取的每一个字段，及其默认值。 */
export const DEFAULTS = Object.freeze({
  /**
   * 并行子代理的建议上限，会写进协议。
   *
   * 这不是硬限制（插件管不到 spawn_teammate），而是给模型一个具体的数字：没有数字时
   * 它倾向于一次开一堆 teammate，而每个 teammate 都是一份独立的上下文与 token 预算。
   */
  maxTeammates: 4,
  /**
   * 是否强制"规划/拆分完成后先让用户确认"。
   *
   * 默认 `true`，这是用户对这个模式的核心要求。关掉它，模式会退化成"先斩后奏的调度员"。
   */
  confirmPlan: true,
  /**
   * 是否强制"子代理之间有分歧时交回用户"。
   */
  escalateOnConflict: true,
  /** 是否把长文协议注册成 skill（`commander-mode`）。 */
  registerSkill: true,
  /**
   * 指挥者**不许自己调用**的工具名。
   *
   * 默认拦下"改变工作区或宿主状态"的那几个（见 `lib/guard.js`）。只读工具与派发工具
   * 永远不该出现在这里。传 `[]` 可以整个关掉门禁，只留协议约束。
   */
  blockedTools: DEFAULT_BLOCKED_TOOLS,
});

/** 非空字符串返回 true。 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 把数字夹到闭区间内；不是有限数时回退。 */
function clampNumber(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * 把 Loader 行的原始 config 解析成插件运行时使用的选项对象。
 *
 * @param {unknown} raw - 本插件 Loader 行的 `config` 对象。
 * @returns {{ options: object, warnings: string[] }} 解析后的选项，以及值得在 apply 时
 *   记入日志的非致命问题。
 */
export function resolveConfig(raw) {
  const warnings = [];
  const config = raw !== null && typeof raw === 'object' ? raw : {};
  if (raw !== undefined && raw !== null && typeof raw !== 'object') {
    warnings.push(`config 必须是对象，实际是 ${typeof raw}；改用默认值`);
  }

  const unknown = Object.keys(config).filter((key) => !(key in DEFAULTS));
  if (unknown.length > 0) {
    warnings.push(`未知配置键 ${unknown.join(', ')} —— 已知键：${Object.keys(DEFAULTS).join(', ')}`);
  }

  const maxTeammates = clampNumber(config.maxTeammates, DEFAULTS.maxTeammates, 1, 12);
  if (config.maxTeammates !== undefined && !Number.isFinite(Number(config.maxTeammates))) {
    warnings.push(`maxTeammates "${String(config.maxTeammates)}" 不是数字；改用 ${DEFAULTS.maxTeammates}`);
  }

  let blockedTools = [...DEFAULT_BLOCKED_TOOLS];
  if (config.blockedTools !== undefined) {
    if (Array.isArray(config.blockedTools)) {
      blockedTools = config.blockedTools
        .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
        .map((entry) => entry.trim());
    } else {
      warnings.push('blockedTools 必须是字符串数组；已改用默认拦截清单');
    }
  }

  return {
    options: {
      maxTeammates,
      confirmPlan: config.confirmPlan === undefined ? DEFAULTS.confirmPlan : config.confirmPlan !== false,
      escalateOnConflict:
        config.escalateOnConflict === undefined ? DEFAULTS.escalateOnConflict : config.escalateOnConflict !== false,
      registerSkill: config.registerSkill === undefined ? DEFAULTS.registerSkill : config.registerSkill !== false,
      blockedTools,
    },
    warnings,
  };
}

/** 保留给将来的路径型配置；当前本插件不读写任何文件。 */
export function isPathLike(value) {
  return isNonEmptyString(value) && /[\\/]/u.test(value);
}
