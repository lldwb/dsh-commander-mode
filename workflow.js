/**
 * `dsh-commander-mode/workflow` —— 「项目开发工作流」组件（preset 子行）。
 *
 * ## 它是什么
 *
 * 一份**可选执行手册**的**按需加载入口**：六段工作流（架构 → 实现 → 审查 → 测试 →
 * 安全 → 文档）每段的目的、必做动作、必须落盘的产物、验收判据、失败返工规则、对应专家
 * 与团队用法，以及本包 `skills/` 目录里 20 个方法 skill 的阶段归位。
 *
 * ## 3.6.0：从「常驻协议」拆成「按需 skill」
 *
 * 3.5.0 及以前这一行还会注册一个 **system-prompt section（order 640）**，把整份手册每轮
 * 注入项目经理模式；配合项目经理协议里"六段每段都必须走完、顺序固定"的写法，连发版打包、
 * 交接这类任务也被拆成六段串行（真实会话 session-137678b5：六张任务 blocked_by 串成一条链，
 * 架构段先开工）。3.6.0 起这一行**只注册 skill**：
 *
 * - 不再注入常驻 prompt —— 项目经理模式不再默认携带六段流水线；
 * - 项目经理与专家小组长都可以用 `skill` 工具**按需加载**（`invocation` 同时开放
 *   `modelInvocable` 与 `userInvocable`），并且可以只读需要的那一段；
 * - 需要完整方法时才加载，**不加载也能正常干活**。
 *
 * 它仍然可以和项目经理模式一起挂载（同一个 preset），但**不依赖**它：单独挂载也能用。
 *
 * ## 只读、无状态
 *
 * 不持有 Config、不注册工具、不读账本；skill 注册失败只记 warning，绝不能让 preset
 * 因为这一行起不来。
 *
 * @module dsh-commander-mode/workflow
 */

import { WORKFLOW_PROTOCOL } from './lib/workflow.js';

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'project-dev-workflow';

/** skill 名（`skill` 工具的参数）。 */
export const SKILL_NAME = 'project-dev-workflow';

/** skill 描述（列表里显示，必须自己说清"可选、按需"）。 */
export const SKILL_DESCRIPTION = '可选的六段开发工作流执行手册（架构/实现/审查/测试/安全/文档）：每段的目的、必做动作、落盘产物、验收判据与返工规则，以及 20 个方法 skill 的阶段归位。按需加载，可只读其中一段；不是强制流程。';

/** skill 的 `whenToUse` 行。 */
export const SKILL_WHEN_TO_USE = '从零开发或大改造一个项目/功能、需要完整交付链（实现→独立审查→独立测试→安全审计→文档）时；或只需要其中某一段的检查清单时（例如只查审查清单）。发版打包、交接、单点修复、排障不需要加载它。';

/**
 * 注册项目开发工作流 skill（不再注册常驻 prompt section）。
 *
 * @param {object} ctx - Cordis 插件上下文（preset scope）。
 */
export function apply(ctx) {
  if (typeof ctx.inject !== 'function') return;

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
      // skill 只是加载入口；失败不影响 preset 其余部分（也不该让整行 broken）。
      ctx.logger?.warn?.('project-dev-workflow: 无法注册 %s skill：%o', SKILL_NAME, error);
    }
  });
}
