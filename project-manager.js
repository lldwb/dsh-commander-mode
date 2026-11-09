/**
 * `dsh-commander-mode/project-manager` —— 「项目经理模式」的**模式行**（agent preset 子行）。
 *
 * ## 它是什么
 *
 * 一个按会话生效的 agent preset 子行：把会话的 agent 变成**项目经理**。它不写业务代码，
 * 而是用六位开发流程专家（架构 / 实现 / 审查 / 测试 / 安全 / 文档）跑一条**带门禁的
 * 六段流水线**：每段有输入、产出、验收判据与返工规则，未通过不许进入下一段。
 *
 * 与「指挥者模式」的区别：指挥者模式解决「谁来做」（不自己动手、把活派出去）；
 * 项目经理模式解决「按什么顺序做、每段怎么验收」（流水线 + 阶段门禁 + 技能方法）。
 *
 * ## 三样东西挂在 preset scope 上
 *
 * 1. **system-prompt section**（`project-manager:mode`，order 650）：项目经理协议；
 * 2. **六个专家工具** `subagent_<id>`：复用 `lib/specialists.js` 的 `installSpecialist`，
 *    名册来自 `commanderSettings`（与指挥者模式共用同一份），服务缺失时用出厂预置名册；
 *    默认异步派发（与指挥者模式一致）——工具立即返回，结算时用「【项目经理·派工完成】」
 *    通知唤醒项目经理。
 * 3. **`tools/pre-execute` 门禁**：① 执行边界（项目经理自己不写业务代码，复用
 *    `lib/guard.js`）；② **等待门禁**（2.0.0：超长 `wait_agent` 确定性拒绝）。
 *
 * 另外把协议注册成 skill（可选，失败不影响模式）。
 *
 * ## 为什么不带工单账本 / ticket / mandate / dispatch-gate
 *
 * 那些是「指挥者模式」的派活记账设施。项目经理模式的进度权威是**共享任务板 + 每段的
 * 落盘证据**，不需要再叠一层工单。所以本行不读 `commanderLedger`、也不注册工单工具。
 *
 * ## 与指挥者模式共用专家名册的坑（重要）
 *
 * 两个 preset 都会被 `@deepseek-ai/dsh-agent-preset` **急切挂载**，而
 * `agentPresets.register()` 对 preset id 是**全局唯一**的：两行都用同一份名册，会算出
 * 同一批 `commander-specialist-<id>-<hash>` id，后挂载的一行必然收到
 * `Duplicate agent preset`。这里不能因此丢掉整条专家通道 —— 检测到"重复"时说明 preset
 * 已由另一行注册好，本行**只补 `subagent_<id>` 工具**（`buildSpecialistToolDefinition`
 * 是纯函数，presetId 由 `specialistPresetId()` 复算，两边一致）。释放时本行只释放自己的
 * 工具，preset 的释放归注册它的那一行。
 *
 * @module dsh-commander-mode/project-manager
 */

import { randomUUID } from 'node:crypto';

import { resolveConfig } from './lib/config.js';
import { DEFAULT_BLOCKED_TOOLS, DELEGATION_TOOLS, agentToolNames, evaluatePreExecute, evaluateWaitCap, isDelegatedAgent } from './lib/guard.js';
import { DEFAULT_SPECIALISTS } from './lib/presets.js';
import { PROJECT_MANAGER_PROTOCOL } from './lib/project-manager.js';
import {
  MAX_RESULT_CHARS,
  buildSpecialistToolDefinition,
  installSpecialist,
  normalizeRoster,
  outputText,
  specialistPresetId,
} from './lib/specialists.js';

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'project-manager-agent';

/**
 * 本行缺了就干不了活的服务：没有 `systemPrompt` 就没有模式本身。
 *
 * `commanderSettings` / `tools` / `subagents` / `agentPresets` / `skills` 都是**可选**的
 * （各自用 `ctx.inject` / `ctx.get` 接线），服务缺失时用默认值降级。
 */
export const inject = ['systemPrompt'];

/** prompt section 的落位：与指挥者协议同一层（team 策略 600 之后、工具指导块之前）。 */
export const SECTION_ORDER = 650;

/** prompt section 名（与指挥者模式的 `commander:mode` 不冲突）。 */
export const SECTION_NAME = 'project-manager:mode';

/** 协议注册成 skill 时的名字。 */
export const SKILL_NAME = 'project-manager';

/** skill 描述。 */
export const SKILL_DESCRIPTION = '项目经理模式：用六位开发流程专家（架构 / 实现 / 审查 / 测试 / 安全 / 文档）跑一条带门禁的项目流水线，只编排与验收、不自己写业务代码。';

/** skill 的 `whenToUse` 行。 */
export const SKILL_WHEN_TO_USE = '当一个项目要从架构一路做到文档、需要按阶段派工并逐段验收时；也用于"你当项目经理，安排六位专家把这件事做完"这类请求。';

/**
 * 拿不到配置行服务时的默认选项。
 *
 * 用 `resolveConfig(undefined)` 而不是手抄一份，保证默认值与 schema 一致。
 */
export const FALLBACK_OPTIONS = Object.freeze(resolveConfig(undefined).options);

/**
 * 注册项目经理模式行。
 *
 * @param {object} ctx - Cordis 插件上下文（preset scope）。
 */
export function apply(ctx) {
  // ---------------------------------------------------------- 配置服务 ---

  /**
   * 取一个可选服务（可能晚到，也可能这个部署里根本没有）。
   *
   * @param {object} from - 上下文（外层 ctx 或 inject 收到的子上下文）。
   * @param {string} service - 服务名。
   * @returns {object | undefined} 服务实例。
   */
  const getService = (from, service) => {
    try {
      return typeof from?.get === 'function' ? from.get(service) : undefined;
    } catch {
      return undefined;
    }
  };

  /** 当前加载期选项（配置服务缺失时用默认值）。 */
  const readOptions = () => {
    try {
      return getService(ctx, 'commanderSettings')?.options?.() ?? FALLBACK_OPTIONS;
    } catch (error) {
      ctx.logger?.warn?.('project-manager: 读取配置失败，改用默认值：%o', error);
      return FALLBACK_OPTIONS;
    }
  };

  /**
   * 当前专家名册：优先配置服务（与指挥者模式共用），服务缺失时用出厂预置名册。
   *
   * 空数组是用户的显式选择（清空名册），不能被换成默认值。
   *
   * @returns {object[]} 未清洗的名册。
   */
  const readRosterEntries = () => {
    try {
      const roster = getService(ctx, 'commanderSettings')?.specialists?.();
      if (Array.isArray(roster)) return roster;
    } catch (error) {
      ctx.logger?.warn?.('project-manager: 读取专家名册失败，改用出厂预置名册：%o', error);
    }
    return DEFAULT_SPECIALISTS;
  };

  // ---------------------------------------------------------------- 提示词 ---

  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context) => {
      try {
        // teammate 通过 `agentPresets.composeFrom()` 加入父会话的同一个 preset scope，
        // 也会被问到这份 section。把"你是项目经理"灌给执行者会和它们的人设打架，
        // 所以子级一律返回空串（与指挥者模式 0.4.0 的修复同一个理由）。
        const agent = context?.agent;
        if (agent !== undefined && isDelegatedAgent(agent)) return '';
        return PROJECT_MANAGER_PROTOCOL;
      } catch (error) {
        // prompt section 抛错会让该会话的每一步都失败，所以渲染失败就退化成空串。
        ctx.logger?.warn?.('project-manager: 渲染 prompt section 失败：%o', error);
        return '';
      }
    },
  });

  // ---------------------------------------------------------------- skill ---

  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (skillCtx) => {
      // `registerSkill` 是加载期开关：拿不到配置服务时按默认（注册）处理。
      const enabled = (() => {
        try {
          return getService(skillCtx, 'commanderSettings')?.options?.().registerSkill !== false;
        } catch {
          return true;
        }
      })();
      if (!enabled) return;
      try {
        skillCtx.effect(
          () =>
            skillCtx.skills.register({
              name: SKILL_NAME,
              description: SKILL_DESCRIPTION,
              whenToUse: SKILL_WHEN_TO_USE,
              source: 'runtime',
              content: PROJECT_MANAGER_PROTOCOL,
              invocation: { modelInvocable: true, userInvocable: true },
            }),
          `project-manager: skill ${SKILL_NAME}`,
        );
      } catch (error) {
        ctx.logger?.warn?.('project-manager: 无法注册 %s skill：%o', SKILL_NAME, error);
      }
    });
  }

  // ---------------------------------------------------------------- 专家 ---

  if (typeof ctx.inject === 'function') {
    // 注意：`commanderSettings` **不在** inject 列表里（与指挥者模式行不同）。它缺失时
    // 这里要用出厂预置名册降级安装六位专家，而不是让整段专家通道静默消失——那种降级
    // 会让模式只剩协议、派不了活。服务在下面按需 `ctx.get`。
    ctx.inject(['tools', 'subagents', 'agentPresets'], (toolCtx) => {
      try {
        /** 已安装专家工具的异步释放函数。 */
        let disposers = [];
        /** 串行化重建，避免两次通知交错注册。 */
        let queue = Promise.resolve();
        /** 子级作用域已销毁。 */
        let disposed = false;
        /** 当前已成功挂上工具的专家 id（诊断与日志用）。 */
        let installedRoster = [];

        /** 异步 activation 的生命周期 signal（与工具调用脱钩；作用域销毁时中止）。 */
        const asyncController = new AbortController();
        try {
          toolCtx.effect(() => () => {
            try {
              asyncController.abort(new Error('project-manager scope disposed'));
            } catch {
              // 已中止不影响释放。
            }
          }, 'project-manager: async delegation lifetime');
        } catch {
          // 没有 effect 的宿主：最多是作用域销毁时 child 继续跑，不影响正常路径。
        }

        /**
         * 取 `subagents` 服务（可能晚于本行出现）。
         *
         * @returns {object | undefined} 服务实例。
         */
        const getSubagents = () => getService(toolCtx, 'subagents') ?? toolCtx.subagents;

        /** 判断错误是不是"该 preset 已被另一行注册"。 */
        const isDuplicatePresetError = (error) => {
          const message = error instanceof Error ? error.message : String(error);
          return /Duplicate agent preset/u.test(message);
        };

        /**
         * 用一条运行时通知唤醒项目经理（异步派发结算时）。
         *
         * 用 `agent.steer()`（不是 inject）：steer 会**唤醒**空闲 agent。
         *
         * @param {object} agent - 项目经理 agent。
         * @param {string} text - 通知正文。
         * @param {string} summary - 一行摘要。
         * @returns {boolean} 是否投递成功。
         */
        const steerManager = (agent, text, summary) => {
          try {
            if (agent === null || typeof agent !== 'object' || typeof agent.steer !== 'function') return false;
            agent.steer({
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text }],
              source: { kind: 'dsh-commander-mode', form: 'notice', summary },
            });
            return true;
          } catch (error) {
            toolCtx.logger?.warn?.('project-manager: 投递完成通知失败（会话可能已关闭）：%o', error);
            return false;
          }
        };

        /**
         * 异步派发结算：把专家的最终答复（或失败原因）作为通知送回项目经理。
         *
         * 项目经理模式没有账本，所以这里只做一件事：唤醒 + 给出下一步（核对验收判据 /
         * 返工 / 继续推进）。不建议、也不允许经理用长 `wait_agent` 等结果。
         *
         * @param {object} info - `installSpecialist` 的异步启动回调参数。
         * @returns {void}
         */
        const onAsyncStarted = ({ agent, childId, toolName, specialistId, result }) => {
          Promise.resolve(result).then(
            (settled) => {
              try {
                let text = outputText(settled?.output).trim();
                if (text === '') {
                  const reason = typeof settled?.stopReason === 'string' ? settled.stopReason : 'unknown';
                  text = reason === 'completed' ? '（专家没有留下收尾文本）' : `（没有收尾文本；停止原因：${reason}）`;
                }
                if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n…（已截断，原始 ${text.length} 字符）`;
                const stopReason = typeof settled?.stopReason === 'string' ? settled.stopReason : 'unknown';
                steerManager(
                  agent,
                  [
                    `【项目经理·派工完成】${toolName} 已结算（child ${childId}，专家 ${specialistId}，stopReason ${stopReason}）。`,
                    '',
                    text,
                    '',
                    '下一步：按该段的验收判据核对产物与证据（文件、命令输出、测试结果）；不通过就打回返工（同一问题连续两次换人 / 回架构段），通过再进入下一段。',
                    '等待其它专家时用 ≤60000ms 的短等待；不要长等，也不要轮询。',
                  ].join('\n'),
                  `派工完成：${toolName}`,
                );
              } catch (error) {
                toolCtx.logger?.warn?.('project-manager: 处理异步结算失败：%o', error);
              }
            },
            (error) => {
              const message = error instanceof Error ? error.message : String(error);
              steerManager(
                agent,
                [
                  `【项目经理·派工完成】${toolName} 异步结算**失败**（child ${childId}，专家 ${specialistId}）。`,
                  `错误：${message}`,
                  '',
                  '下一步：先只读核对产物；能继续就补派，需要用户决定就用 `ask_user_question` 上报。不要重复派同一任务。',
                ].join('\n'),
                `派工失败：${toolName}`,
              );
            },
          );
        };

        /** 释放当前已安装的全部专家工具（失败不阻断其余释放）。 */
        const releaseAll = async () => {
          const previous = disposers;
          disposers = [];
          for (const dispose of previous) {
            try {
              await dispose();
            } catch (error) {
              toolCtx.logger?.warn?.('project-manager: 释放专家工具失败：%o', error);
            }
          }
        };

        /**
         * 给一个专家挂工具（若 preset 已被别的模式注册，只补工具，不重复注册 preset）。
         *
         * @param {object} specialist - 已清洗的名册项。
         * @param {() => boolean} isEnabled - 该专家是否仍在当前名册里。
         * @returns {Promise<() => Promise<void>>} 释放函数。
         */
        const mountSpecialist = async (specialist, isEnabled) => {
          const asyncMode = readOptions().asyncDelegation !== false;
          const shared = {
            specialist,
            getSubagents,
            isEnabled,
            asyncMode,
            onAsyncStarted,
            asyncSignal: () => asyncController.signal,
          };
          try {
            return await installSpecialist({ ctx: toolCtx, ...shared });
          } catch (error) {
            if (!isDuplicatePresetError(error)) throw error;
            // 另一个模式（指挥者模式）已经用同一份名册注册过这个 preset。重复注册是
            // 全局 id 冲突，不是配置错误——本模式只需要补上自己的 `subagent_<id>` 工具。
            toolCtx.logger?.info?.(
              'project-manager: 专家 %s 的 preset 已由其它模式注册，本模式复用并只挂工具',
              specialist.id,
            );
            const disposeTool = toolCtx.tools.register(
              buildSpecialistToolDefinition({ ...shared, presetId: specialistPresetId(specialist) }),
            );
            return async () => {
              try {
                disposeTool?.();
              } catch {
                // 工具可能已随作用域销毁。
              }
            };
          }
        };

        /** 按当前名册重建专家工具。 */
        const rebuild = () => {
          queue = queue.then(async () => {
            if (disposed) return;
            await releaseAll();
            installedRoster = [];
            const roster = normalizeRoster(readRosterEntries(), {
              maxSpecialists: readOptions().maxSpecialists,
              logger: toolCtx.logger,
            });
            const enabled = new Set(roster.map((specialist) => specialist.id));
            const installed = [];
            for (const specialist of roster) {
              try {
                disposers.push(await mountSpecialist(specialist, () => enabled.has(specialist.id)));
                installed.push(specialist);
              } catch (error) {
                // 单个专家注册失败（例如工具名冲突）不应拖垮整个模式，也不留在协议里点名。
                toolCtx.logger?.warn?.('project-manager: 安装专家 "%s" 失败：%o', specialist.id, error);
              }
            }
            installedRoster = installed;
            toolCtx.logger?.info?.('project-manager: 已安装 %d 个开发流程专家工具', installed.length);
          }).catch((error) => {
            toolCtx.logger?.warn?.('project-manager: 重建专家工具失败：%o', error);
          });
          return queue;
        };

        // 配置行广播"名册变了" → 重建（与指挥者模式同一份服务）。
        const settings = getService(toolCtx, 'commanderSettings');
        if (settings !== undefined && typeof settings.subscribe === 'function') {
          toolCtx.effect(() => settings.subscribe(() => void rebuild()), 'project-manager: roster subscription');
        }

        toolCtx.effect(() => {
          void rebuild();
          return () => {
            disposed = true;
            void queue.then(releaseAll).catch(() => {});
          };
        }, 'project-manager: specialist tools');
      } catch (error) {
        // 接线层自己出错时只损失专家通道，**不能**让整行 broken ——
        // 那会让项目经理协议与门禁一起消失，模式整个失效。
        ctx.logger?.warn?.('project-manager: 专家接线失败，本会话退化为无专家通道：%o', error);
      }
    });
  }

  // ---------------------------------------------------------------- 门禁 ---

  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (toolCtx) => {
      try {
        toolCtx.effect(() => toolCtx.on('tools/pre-execute', (exec, next) => {
          try {
            const toolName = typeof exec?.name === 'string' ? exec.name : '';
            const agent = exec?.agent;

            // ① 执行边界：项目经理本人不许写业务代码。
            //    子代理必须放行（宁可漏拦，不可拦死——身份读不出来时 isDelegatedAgent 返回 true）。
            if (!isDelegatedAgent(agent)) {
              const blockedSet = new Set(readOptions().blockedTools ?? DEFAULT_BLOCKED_TOOLS);
              if (blockedSet.has(toolName)) {
                const availableTools = agentToolNames(agent);
                const canDelegate = availableTools === undefined
                  ? undefined
                  : availableTools.some((name) => DELEGATION_TOOLS.includes(name) || name.startsWith('subagent_'));
                const decision = evaluatePreExecute({ agent, name: toolName, blocked: blockedSet, canDelegate, availableTools });
                if (decision !== undefined) {
                  ctx.logger?.info?.('project-manager: 拒绝项目经理自己调用 %s（已要求改为派给专家）', toolName);
                  return decision;
                }
              }
            }

            // ② 等待门禁（2.0.0）：超长 wait_agent 确定性拒绝。只拦超长等待，
            //    list_agents / team_task_list / send_message 这些"读状态 / 唤醒队友"的工具不受影响。
            const waitReason = evaluateWaitCap({
              name: toolName,
              args: exec?.arguments,
              maxWaitMs: readOptions().maxWaitMs,
            });
            if (typeof waitReason === 'string' && waitReason !== '') {
              ctx.logger?.info?.('project-manager: 拒绝超长 wait_agent（上限 %dms）', readOptions().maxWaitMs);
              return { kind: 'deny', reason: waitReason };
            }
          } catch (error) {
            // 门禁自己出错时绝不能让工具调用失败——放行，交回默认行为。
            ctx.logger?.warn?.('project-manager: 门禁判定失败，已放行：%o', error);
          }
          return typeof next === 'function' ? next() : undefined;
        }), 'project-manager: guards');
      } catch (error) {
        ctx.logger?.warn?.('project-manager: 注册门禁失败，本会话退化为只有协议约束：%o', error);
      }
    });
  }

  ctx.logger?.info?.('project-manager: 模式行就绪（六段流水线 / 六位专家 / 门禁）');
}
