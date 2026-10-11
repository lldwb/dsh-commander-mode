/**
 * `dsh-commander-mode` —— DeepSeek Harness 的指挥者模式。
 *
 * ## 它是什么
 *
 * 一个按会话生效的模式，把 agent 变成**指挥者**：接到任务先分析与侦察（只读），
 * 然后规划与拆分，**停下来让用户确认计划**，再把执行派给子代理（Agent Teams），
 * 自己不动手写文件、不跑命令，遇到分歧或不确定就回头问用户。
 *
 * ## 模式是怎么表达的
 *
 * 这个模式就是一段 system-prompt section，其文本在**每次组装时重新计算**——与随附
 * plan mode、以及 `dsh-interview-mode` 用的是同一套机制。要点是：协议在每一个请求里
 * 都被重新陈述，所以一个跑了几十轮、开了好几个子代理的会话也不会漂移，不需要哪一轮
 * 记得去重读它。
 *
 * 本插件**无状态**：不写文件、不存会话数据、不注册工具。装上就生效，卸下就干净——
 * 这也意味着它没有任何"改完不生效"的缓存面。
 *
 * ## 派发通道：依赖「智能体团队」组合包
 *
 * 指挥者用 `spawn_teammate` / `send_message` / `wait_agent` / `list_agents` /
 * `interrupt_agent` / `team_task_*` 派活。这九个 Team 工具由
 * `@deepseek-ai/dsh-experimental-agent-team-profile`（插件页的「智能体团队」）提供：
 * `tool-agent-team` 把它们注册在每个 Team 成员 agent **自己的 ctx** 上，Lead 是隐式
 * Team 的 Lead，因此也是成员 —— 与 preset 声明无关，本插件的 patch 不需要（也不该）
 * 重复声明它们。
 *
 * 那个组合包同时禁用了旧的 `tool-subagent*` 控件，所以本插件的 patch **不镜像**
 * standard 的 delegation 组里那四个 subagent 行（详见 `cordis.patch.yml` 文件头）。
 *
 * 用户在插件页关掉「智能体团队」时，门禁的 `canDelegate` 检查会让放行兜住，模式退化
 * 成"只会做协议的普通 agent"，而不是把会话卡死。
 *
 * ## 边界说明（重要）
 *
 * 「指挥者不执行操作」有**两道**保障：
 *
 * 1. **协议**（system-prompt section，每轮重述）——告诉模型它是指挥者，该派活。
 * 2. **门禁**（`tools/pre-execute` waterfall，见 `lib/guard.js`）——确定性拒绝指挥者
 *    自己调用 `write` / `edit` / `pwsh` / `bash` / `job_kill` / `plugin_manager`，
 *    并把纠正指令作为错误信息回给模型。
 *
 * 为什么不是"把工具从 preset 里裁掉"：子代理通过 `agentPresets.composeFrom()` 加入
 * **父会话的同一个 preset scope**，裁剪会连子代理一起废掉（per-child 的工具限制只能
 * 收紧、不能扩展）。所以能力行必须保留，边界落在"谁可以调用"这一层。
 *
 * @module dsh-commander-mode
 */

import { resolveConfig } from './lib/config.js';
import { DELEGATION_TOOLS, agentToolNames, evaluatePreExecute, isDelegatedAgent } from './lib/guard.js';
import {
  COMMANDER_PROTOCOL,
  SKILL_DESCRIPTION,
  SKILL_NAME,
  SKILL_WHEN_TO_USE,
  renderModeOpening,
} from './lib/protocol.js';

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'commander-mode';

/** 本插件缺了就干不了活的服务。 */
export const inject = ['systemPrompt'];

/**
 * prompt section 的落位。
 *
 * 紧跟在 plan 策略（500）与 team 策略（600）之后、各工具的指导块之前，这样指挥者
 * 协议的分量高于工具说明，又不会挤掉部署身份。
 */
export const SECTION_ORDER = 650;

/** prompt section 名。 */
export const SECTION_NAME = 'commander:mode';

/**
 * 注册插件。
 *
 * @param {object} ctx - Cordis 插件上下文。
 * @param {unknown} config - 本插件 Loader 行的 `config`。
 */
export function apply(ctx, config) {
  const { options, warnings } = resolveConfig(config);
  for (const warning of warnings) ctx.logger?.warn?.('commander-mode: %s', warning);

  // ---------------------------------------------------------------- 提示词 ---

  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: () => {
      try {
        return renderModeOpening(options);
      } catch (error) {
        // prompt section 抛错会让该会话的每一步都失败，所以渲染失败就退化成
        // 「模式关闭」，而不是把会话弄挂。
        ctx.logger?.warn?.('commander-mode: 渲染 prompt section 失败：%o', error);
        return '';
      }
    },
  });

  // ---------------------------------------------------------------- 门禁 ---

  /**
   * 被拦截的工具名，查一次就够。
   */
  const blockedSet = new Set(options.blockedTools);

  /**
   * 该 agent 是否有"把活派出去"的工具。
   *
   * 读 `agent.ctx.tools.schemas()` —— 在 agent 自己的作用域里求值，所以能看见 agent
   * 作用域注册的 Team 工具（它们不在 preset scope 的视图里）。读不到时返回
   * `undefined`（未知），调用方按"有"处理。
   */
  const canDelegateFor = (agent) => {
    const names = agentToolNames(agent);
    if (names === undefined) return undefined;
    return names.some((toolName) => DELEGATION_TOOLS.includes(toolName));
  };

  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      const toolName = typeof exec?.name === 'string' ? exec.name : '';
      // 快路径：绝大多数调用既不在拦截清单里，也不是 Lead 发起的。
      if (blockedSet.has(toolName) && !isDelegatedAgent(exec?.agent)) {
        const decision = evaluatePreExecute({
          agent: exec.agent,
          name: toolName,
          blocked: blockedSet,
          canDelegate: canDelegateFor(exec.agent),
        });
        if (decision !== undefined) {
          ctx.logger?.info?.('commander-mode: 拒绝指挥者自己调用 %s（已要求改为派发）', toolName);
          return decision;
        }
      }
    } catch (error) {
      // 门禁自己出错时绝不能让工具调用失败——放行，交回默认行为。
      ctx.logger?.warn?.('commander-mode: 门禁判定失败，已放行：%o', error);
    }
    return typeof next === 'function' ? next() : undefined;
  });

  // ---------------------------------------------------------------- skill ---

  if (options.registerSkill && typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (skillCtx) => {
      try {
        skillCtx.effect(
          () =>
            skillCtx.skills.register({
              name: SKILL_NAME,
              description: SKILL_DESCRIPTION,
              whenToUse: SKILL_WHEN_TO_USE,
              source: 'runtime',
              content: COMMANDER_PROTOCOL,
              invocation: { modelInvocable: true, userInvocable: true },
            }),
          `commander-mode: skill ${SKILL_NAME}`,
        );
      } catch (error) {
        ctx.logger?.warn?.('commander-mode: 无法注册 %s skill：%o', SKILL_NAME, error);
      }
    });
  }

  ctx.logger?.info?.(
    'commander-mode: 就绪（maxTeammates=%d, confirmPlan=%s, escalateOnConflict=%s）',
    options.maxTeammates,
    options.confirmPlan,
    options.escalateOnConflict,
  );
}
