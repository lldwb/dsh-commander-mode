/**
 * `dsh-commander-mode/specialist` —— specialist preset 里的人设行。
 *
 * ## 它为什么必须是一个独立的插件行
 *
 * 每个 specialist 都跑在**自己独立的 agent preset** 里（而不是 join 指挥者的 preset），
 * 否则它会同时看到指挥官协议，于是拒绝自己动手 —— 那正是这个模式最糟糕的故障。
 * 但 DSH 的 tool-subagent 在 0.2.x 已不再接受 `persona` 参数，人设只能由 preset 的组合
 * 承载：`lib/specialists.js` 把这一行连同能力行一起注册成一个 preset。
 *
 * ## 输入
 *
 * Loader 行 `config.persona` 是一段已渲染好的文本（由 `renderSpecialistPersona()` 生成，
 * 含职责、边界、可靠性要求与附加人设）。本插件**不声明** `Config`：这段文本完全由
 * 父插件生成并校验过，再经过一次 schema 只会多一个失败点。
 *
 * @module dsh-commander-mode/specialist
 */

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'commander-specialist';

/** 人设注入依赖的服务。 */
export const inject = ['systemPrompt'];

/** 人设 section 名（每个 specialist preset 各自独立的 scope，不会撞名）。 */
export const SECTION_NAME = 'commander:specialist';

/**
 * 落位：紧跟在部署身份之后、各工具指导块之前。它与指挥官协议用同一个 order，但两者
 * 永远不会出现在同一个 preset 里 —— 这正是分离的目的。
 */
export const SECTION_ORDER = 650;

/**
 * 注册人设 section。
 *
 * @param {object} ctx - Cordis 插件上下文（specialist preset scope）。
 * @param {unknown} config - 本插件行的 `config`（期望 `{ persona: string }`）。
 */
export function apply(ctx, config) {
  const persona = config !== null && typeof config === 'object' && typeof config.persona === 'string' ? config.persona : '';
  if (persona.trim() === '') {
    ctx.logger?.warn?.('commander-specialist: 缺少 persona，该 specialist 将没有专属人设');
    return;
  }
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    // 文本在注册时已经确定：人设不随运行期变化，而 specialist preset 的 id 带内容指纹，
    // 所以"改了人设就换一个 preset"是这个设计的既定行为。
    text: () => persona,
  });
}
