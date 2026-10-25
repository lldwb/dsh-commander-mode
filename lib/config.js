/**
 * `dsh-commander-mode` 的配置：schema、默认值、读取器。
 *
 * ## 为什么这里终于声明了 `Config`
 *
 * 0.1.x 故意不声明 schema（零依赖）。0.2.0 加了「可配置的多模型 specialist 名册」，
 * 而 DSH 的规则是：**只有声明了 `Config` 的行才会出现在「设置 → 插件」里**，只有打了
 * `.volatile()` 的字段才能被设置页读写。所以名册必须走 schema。
 *
 * 代价是引入唯一一个依赖 `@deepseek-ai/schemastery`（装进本包 `node_modules` —— profile
 * 下解析不到随附包，见 `dsh-plugin-settings-page` skill §5）。其余能力仍然全部通过
 * `ctx` 拿，不 import 任何随附包。
 *
 * ## 两条硬约束
 *
 * 1. **`cordis.patch.yml` 里写过的每个键这里都必须声明**：按 id 定向的 patch 会**整块
 *    替换** `config`，不做深合并；而声明了 schema 之后，未知键会被 schema 拒绝。
 * 2. **`.volatile()` 只能加在数组这一层**：schemastery 禁止 volatile 嵌套 volatile，
 *    名册元素里的字段不能再各自 volatile。
 *
 * ## 读 volatile 字段要宽容
 *
 * 解析后的 volatile 字段是**引用**（有 `.get()`），但单测与手写解析路径拿到的是普通值。
 * `readSpecialists()` / `readMaxSpecialists()` 同时接受两种形态。
 *
 * @module dsh-commander-mode/lib/config
 */

import z from '@deepseek-ai/schemastery';

import { DEFAULT_BLOCKED_TOOLS } from './guard.js';
import { cloneDefaultSpecialists } from './presets.js';

// ---------------------------------------------------------------- schema ---

/**
 * 一个 specialist 的配置形状。
 *
 * `id` 同时是工具名的后缀（`subagent_<id>`），所以限制成 kebab/snake 风格的小写标识符：
 * 它要能出现在工具名里，也要能被人一眼认出来是谁。
 *
 * ## provider / model 是可空的
 *
 * 出厂预置名册里这两栏是空串，语义 = **继承指挥者（父会话）的模型路由**。原因很实际：
 * 预置名册不能硬编码任何 provider/model —— 不同部署可用的模型完全不同，写死了在别人的
 * 部署里就是一条坏配置。用户想给某个专家绑定专属模型时，在设置页把两栏都填上。
 *
 * 校验上要求**两栏要么都空、要么都填**（一半填一半空 = 路由不完整）：schema 表达不了
 * 这种跨字段约束，由 `lib/specialists.js` 的 `normalizeRoster()` 兜底。
 */
export const SpecialistSchema = z.object({
  id: z.string().required().pattern(/^[a-z][a-z0-9_-]{0,47}$/),
  provider: z.string().default(''),
  model: z.string().default(''),
  description: z.string().required(),
  persona: z.string(),
  reasoningEffort: z.string(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
});

/**
 * 本插件 Loader 行的完整配置。
 *
 * `specialists` 是**唯一**的 volatile 字段：设置页只编辑它，其余都是加载期配置
 * （改它们要改 profile patch / 重新加载）。
 *
 * `specialists` 的默认值是**出厂预置名册**（`lib/presets.js`，按主流软件开发生命周期
 * 划分的 6 个专家，模型继承指挥者）。用户要开箱为空，可以在 profile patch 里显式写
 * `specialists: []`。
 */
export const Config = z.object({
  specialists: z.array(SpecialistSchema).default(cloneDefaultSpecialists()).volatile(),

  /** 名册条数上限（防御性：每个 specialist 都意味着一个 preset + 一个工具）。 */
  maxSpecialists: z.number().step(1).min(0).default(20),

  /** 是否强制"规划/拆分完成后先让用户确认"——本模式的核心要求。 */
  confirmPlan: z.boolean().default(true),

  /** 是否强制"子代理之间有分歧时交回用户"。 */
  escalateOnConflict: z.boolean().default(true),

  /** 写进协议的建议并行上限。 */
  maxTeammates: z.number().step(1).min(1).max(12).default(4),

  /** 指挥者**不许自己调用**的工具名；传 `[]` 只留协议约束。 */
  blockedTools: z.array(z.string()).default([...DEFAULT_BLOCKED_TOOLS]),

  /** 是否把长文协议注册成 skill（`commander-mode`）。 */
  registerSkill: z.boolean().default(true),
});

// ---------------------------------------------------------------- 读取 ---

/** 取引用或普通值背后的真实值。 */
function liveValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get();
  return value;
}

/**
 * 读当前名册（未经清洗，保持用户写入的原样）。
 *
 * @param {unknown} config - `apply` 收到的配置对象（字段可能是引用）。
 * @returns {object[]} 名册数组；不是数组时返回 `[]`。
 */
export function readSpecialists(config) {
  const value = liveValue(config?.specialists);
  return Array.isArray(value) ? value : [];
}

/**
 * 读名册条数上限。
 *
 * @param {unknown} config - `apply` 收到的配置对象。
 * @returns {number} 上限（非负整数，异常时 20）。
 */
export function readMaxSpecialists(config) {
  const value = liveValue(config?.maxSpecialists);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 20;
}

/**
 * 读一个布尔开关。
 *
 * @param {unknown} value - 引用或普通值。
 * @param {boolean} fallback - 缺省值。
 * @returns {boolean} 开关值。
 */
export function readFlag(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 读 `blockedTools`：非空字符串数组，去重保序；非法值退回默认清单。
 *
 * @param {unknown} value - 引用或普通值。
 * @param {string[]} [fallback] - 回退清单。
 * @returns {{ tools: string[], warning: string | undefined }} 工具名与（可选的）解析警告。
 */
export function readBlockedTools(value, fallback = [...DEFAULT_BLOCKED_TOOLS]) {
  const live = liveValue(value);
  if (live === undefined || live === null) return { tools: fallback, warning: undefined };
  if (!Array.isArray(live)) return { tools: fallback, warning: `blockedTools 必须是字符串数组；已改用默认拦截清单` };
  const tools = [];
  for (const entry of live) {
    if (typeof entry !== 'string' || entry.trim() === '') continue;
    if (!tools.includes(entry.trim())) tools.push(entry.trim());
  }
  return { tools, warning: undefined };
}

/**
 * 读 `maxTeammates`：夹到 1–12。
 *
 * @param {unknown} value - 引用或普通值。
 * @returns {number} 建议并行上限。
 */
export function readMaxTeammates(value) {
  const live = liveValue(value);
  // null 按"未配置"处理：手写 patch 里留空一行会得到 YAML null，而 Number(null) === 0
  // 会让协议静默变成"建议并行 1 个"，与 undefined/NaN 的 4 不一致。
  if (live === undefined || live === null) return 4;
  const number = typeof live === 'number' ? live : Number(live);
  if (!Number.isFinite(number)) return 4;
  return Math.min(12, Math.max(1, Math.round(number)));
}

/**
 * 已知的配置键（= `Config` 声明的全部字段）。
 *
 * schemastery 对未知键是**保留**而不是拒绝（实测：`Config({nope:1})` 的结果里仍有
 * `nope`），所以拼错的键会静默存在。这里显式列出来，让 `resolveConfig` 能把它报成
 * warning —— 配置拼错时"看起来没生效"是最难查的一类问题。
 */
export const KNOWN_CONFIG_KEYS = Object.freeze([
  'specialists',
  'maxSpecialists',
  'confirmPlan',
  'escalateOnConflict',
  'maxTeammates',
  'blockedTools',
  'registerSkill',
]);

/**
 * 把配置解析成插件运行时使用的选项对象。
 *
 * 与 0.1.x 的区别：`specialists` 不再在这里清洗（它随设置页实时变化，见
 * `lib/specialists.js` 的 `resolveRoster()`），这里只给出稳定的加载期选项与警告。
 *
 * @param {unknown} raw - `apply` 收到的配置对象。
 * @returns {{ options: object, warnings: string[] }} 选项与非致命问题。
 */
export function resolveConfig(raw) {
  const warnings = [];
  const config = raw !== null && typeof raw === 'object' ? raw : {};
  if (raw !== undefined && raw !== null && typeof raw !== 'object') {
    warnings.push(`config 必须是对象，实际是 ${typeof raw}；改用默认值`);
  }

  const unknown = Object.keys(config).filter((key) => !KNOWN_CONFIG_KEYS.includes(key));
  if (unknown.length > 0) {
    warnings.push(`未知配置键 ${unknown.join(', ')} —— 已知键：${KNOWN_CONFIG_KEYS.join(', ')}`);
  }

  const blocked = readBlockedTools(config.blockedTools);
  if (blocked.warning !== undefined) warnings.push(blocked.warning);

  return {
    options: {
      confirmPlan: readFlag(liveValue(config.confirmPlan), true),
      escalateOnConflict: readFlag(liveValue(config.escalateOnConflict), true),
      registerSkill: readFlag(liveValue(config.registerSkill), true),
      maxTeammates: readMaxTeammates(config.maxTeammates),
      blockedTools: blocked.tools,
      maxSpecialists: readMaxSpecialists(config),
    },
    warnings,
  };
}
