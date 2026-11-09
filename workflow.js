/**
 * `dsh-commander-mode/workflow` —— 「项目开发工作流」组件（preset 子行）。
 *
 * ## 它是什么
 *
 * 六段流水线的**执行手册**：架构 → 实现 → 审查 → 测试 → 安全 → 文档。每段写清目的、
 * 必做动作、必须落盘的产物、验收判据、失败返工规则、对应专家与团队用法，并给出本包
 * `skills/` 目录里 19 个方法 skill 的阶段归位。
 *
 * 它通常与「项目经理模式」一起挂载（同一个 preset），section order 640 略早于项目经理
 * 协议（650）：先给执行手册，再给责任边界与门禁。单独挂载也能用——它不依赖项目经理行。
 *
 * ## 只读、无状态
 *
 * 不持有 Config、不注册工具、不读账本；失败一律降级（section 渲染失败返回空串，
 * skill 注册失败只记 warning），绝不能让 preset 因为这一行起不来。
 *
 * @module dsh-commander-mode/workflow
 */

import { isDelegatedAgent } from './lib/guard.js';
import { WORKFLOW_PROTOCOL } from './lib/workflow.js';

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'project-dev-workflow';

/** 没有 `systemPrompt` 就没有这条协议本身。 */
export const inject = ['systemPrompt'];

/** prompt section 的落位：项目经理协议（650）之前、team 策略（600）之后。 */
export const SECTION_ORDER = 640;

/** prompt section 名（与指挥者/项目经理协议都不冲突）。 */
export const SECTION_NAME = 'project-workflow:mode';

/** 协议注册成 skill 时的名字。 */
export const SKILL_NAME = 'project-dev-workflow';

/** skill 描述。 */
export const SKILL_DESCRIPTION = '项目开发工作流：六段流水线（架构/实现/审查/测试/安全/文档）的执行步骤、落盘产物、验收判据、返工规则，以及 19 个方法 skill 的阶段归位。';

/** skill 的 `whenToUse` 行。 */
export const SKILL_WHEN_TO_USE = '当一个项目要按架构→实现→审查→测试→安全→文档的顺序推进、需要知道每段该做什么与拿什么证据时。';

/**
 * 注册项目开发工作流行。
 *
 * @param {object} ctx - Cordis 插件上下文（preset scope）。
 */
export function apply(ctx) {
  // ---------------------------------------------------------------- 提示词 ---

  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context) => {
      try {
        // 执行手册只给项目经理看：teammate 走同一个 preset scope，但它们是执行者，
        // 收到"六段流水线"只会和自己的定位打架（与指挥者模式 0.4.0 的修复同理）。
        const agent = context?.agent;
        if (agent !== undefined && isDelegatedAgent(agent)) return '';
        return WORKFLOW_PROTOCOL;
      } catch (error) {
        ctx.logger?.warn?.('project-dev-workflow: 渲染 prompt section 失败：%o', error);
        return '';
      }
    },
  });

  // ---------------------------------------------------------------- skill ---

  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (skillCtx) => {
      try {
        skillCtx.effect(
          () =>
            skillCtx.skills.register({
              name: SKILL_NAME,
              description: SKILL_DESCRIPTION,
              whenToUse: SKILL_WHEN_TO_USE,
              source: 'runtime',
              content: WORKFLOW_PROTOCOL,
              invocation: { modelInvocable: true, userInvocable: true },
            }),
          `project-dev-workflow: skill ${SKILL_NAME}`,
        );
      } catch (error) {
        // skill 只是加载入口；失败不影响 section 照常注入。
        ctx.logger?.warn?.('project-dev-workflow: 无法注册 %s skill：%o', SKILL_NAME, error);
      }
    });
  }
}
