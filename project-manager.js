/**
 * `dsh-commander-mode/project-manager` —— 「项目经理模式」的**模式行**（agent preset 子行）。
 *
 * ## 它是什么
 *
 * 一个按会话生效的 agent preset 子行：把会话的 agent 变成**项目经理**。它不写业务代码，
 * 而是用六位开发流程专家（架构 / 实现 / 审查 / 测试 / 安全 / 文档）跑一条**带门禁的
 * 六段流水线**：每段有输入、产出、验收判据与返工规则，未通过不许进入下一段。
 *
 * 3.0.0 起这六位是**专家小组长**（`spawn_teammate` 建出的 L1 队友）：每段由项目经理
 * 建一位小组长并 `send_message` 派单，小组长可以自己执行，也可以把子任务交给下级
 * 子智能体（`subagent_<id>`）。团队模型正文来自 `lib/team-model.js` 的 `TEAM_MODEL`，
 * 与指挥官协议共用同一份（项目经理模式 = 指挥官模式的特化版）。
 *
 * 与「指挥者模式」的区别：指挥者模式解决「谁来做」（不自己动手、把活派出去）；
 * 项目经理模式解决「按什么顺序做、每段怎么验收」（流水线 + 阶段门禁 + 技能方法）。
 *
 * ## 模式继承关系：项目经理模式 = 指挥者模式 + Agent 预设定义
 *
 * 本行**不是**另起一套模式，而是派生出来的：
 *
 * - **继承指挥者模式**：能力行清单（`cordis.patch.yml` 的 CAPABILITIES 块，逐字节一致）、
 *   专家名册与 `subagent_<id>` 工具（同一个 `commanderSettings` 服务；3.0.0 起这些工具
 *   由**专家小组长**调用，项目经理不直接调）、
 *   `tools/pre-execute` 执行门禁（复用 `lib/guard.js`）、禁止等待门禁
 *   （`evaluateWaitForbidden()`，3.1.0 硬禁用、无开关）、五条工作纪律（`lib/discipline.js`
 *   单一真源）、异步派工与「【项目经理·派工完成】」唤醒语义。
 * - **继承「Agent 预设定义」**（`@deepseek-ai/dsh-agent-preset`）：preset 的声明方式与
 *   生命周期都由它管——本行只往 `preset-project-manager` 里加自己的子行；该声明器被禁用
 *   或缺失时，指挥者模式与项目经理模式会一起从模式菜单消失。
 * - **本行新增**：六段流水线协议（`lib/project-manager.js`）与门禁接线；不含工单账本、
 *   不含 Mandate/dispatch-gate（那是指挥者模式的派活记账，PM 的进度权威是共享任务板 +
 *   每段落盘证据）。
 *
 * ## 三样东西挂在 preset scope 上
 *
 * 1. **system-prompt section**（`project-manager:mode`，order 650）：项目经理协议；
 * 2. **六个专家工具** `subagent_<id>`：复用 `lib/specialists.js` 的 `installSpecialist`，
 *    名册来自 `commanderSettings`（与指挥者模式共用同一份），服务缺失时用出厂预置名册；
 *    默认异步派发（与指挥者模式一致）——工具立即返回，结算时用「【项目经理·派工完成】」
 *    通知唤醒**调用它的小组长**（3.0.0 起项目经理不直接调这些工具）。
 * 3. **`tools/pre-execute` 门禁**：① 执行边界（项目经理自己不写业务代码，复用
 *    `lib/guard.js`）；② **层级门禁**（3.0.0：任务板进展/排期与工单推进状态只由小组长写、
 *    项目经理不直接派子智能体，受 `delegationHierarchy` 控制）；③ **禁止等待门禁**
 *    （3.1.0：`wait_agent` 对项目经理无条件拒绝，**没有开关**）。
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
import { DEFAULT_BLOCKED_TOOLS, DELEGATION_TOOLS, agentToolNames, evaluateBoardWrite, evaluatePreExecute, evaluateSpecialistDispatch, evaluateTicketWrite, evaluateWaitForbidden, hasUsableDispatchChannel, isDelegatedAgent, isSpecialistDispatchTool } from './lib/guard.js';
import { DEFAULT_SPECIALISTS } from './lib/presets.js';
import { PROJECT_MANAGER_PROTOCOL, leaderNameForSpecialist } from './lib/project-manager.js';
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
 * 需要走层级门禁判定的工具名（廉价过滤）。
 *
 * 三条门禁只关心「任务板写入 / 工单写入 / 子智能体派发」这几类工具。先用名字过滤，
 * 避免每次工具调用都去读 agent 的工具视图（`agentToolNames`）——那是给拒绝理由用的，
 * 只有真要拒绝时才需要。
 *
 * @param {string} toolName - 工具名。
 * @returns {boolean} 是否需要跑层级门禁判定。
 */
const isHierarchyGatedTool = (toolName) => toolName === 'team_task_update'
  || toolName === 'commander_ticket_update'
  || isSpecialistDispatchTool(toolName);

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
        // 3.4.0：本部署没有智能体团队时，协议里"派单只有一条通道：spawn_teammate"
        // 会指向不存在的工具。补一条显式覆盖，告诉它改用一次性子智能体
        // （门禁 `evaluateSpecialistDispatch()` 已按"没有 Team 通道"降级放行）。
        const tools = agentToolNames(agent);
        const hasTeam = !Array.isArray(tools) || tools.includes('spawn_teammate') || tools.includes('send_message');
        if (hasTeam) return PROJECT_MANAGER_PROTOCOL;
        return [
          PROJECT_MANAGER_PROTOCOL,
          '',
          '> ⚠️ **本部署没有智能体团队**：上文提到的 `spawn_teammate` / `send_message` / `wait_agent` /',
          '> `team_task_*` / `list_agents` / `interrupt_agent` **都不存在**，专家小组长这一层建不起来。',
          '> 改用一次性子智能体派每段任务：`subagent_architect` / `subagent_implementer` / `subagent_reviewer` /',
          '> `subagent_tester` / `subagent_security-auditor` / `subagent_doc-writer`（前台调用、结果直接返回；',
          '> 由你自己承担拆解、验收与核对）。仍然**不要自己写业务代码**。',
        ].join('\n');
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
         * 异步派发结算：把子智能体的最终答复（或失败原因）作为通知送回**调用该工具的小组长**。
         *
         * 3.0.0 起项目经理不直接调 `subagent_<id>`：这些工具是专家小组长用来派下级子智能体的，
         * 所以通知的收件人是小组长，正文点名它、并给出下一步（按验收判据核对 / 结算任务板 /
         * 返工）。项目经理自己靠 `send_message` 与任务板掌握进度，不用长 `wait_agent` 等结果。
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
                const leader = leaderNameForSpecialist(specialistId);
                steerManager(
                  agent,
                  [
                    `【项目经理·派工完成】小组长 ${leader} 派出的 ${toolName} 已结算（child ${childId}，专家 ${specialistId}，stopReason ${stopReason}）。`,
                    '',
                    text,
                    '',
                    '下一步：按该段的验收判据核对产物与证据（文件、命令输出、测试结果）；通过就把该段任务结算（`team_task_update` `complete`，带 revision）并向项目经理回报结论，不通过就打回返工（同一问题连续两次换人 / 回架构段）。',
                    '等待其它下级时用 ≤60000ms 的短等待；不要长等，也不要轮询。',
                  ].join('\n'),
                  `派工完成：${toolName}`,
                );
              } catch (error) {
                toolCtx.logger?.warn?.('project-manager: 处理异步结算失败：%o', error);
              }
            },
            (error) => {
              const message = error instanceof Error ? error.message : String(error);
              const leader = leaderNameForSpecialist(specialistId);
              steerManager(
                agent,
                [
                  `【项目经理·派工完成】小组长 ${leader} 派出的 ${toolName} 异步结算**失败**（child ${childId}，专家 ${specialistId}）。`,
                  `错误：${message}`,
                  '',
                  '下一步：先只读核对产物；能继续就补派，需要用户决定或跨段取舍就上报项目经理（`send_message`）。不要重复派同一任务。',
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
                // 3.4.0：按"真的能调用"算派活通道（排除 blockedTools 与层级门禁关掉的通道），
                // 否则用户把派发工具写进 blockedTools 时会变成"既不能动手也不能派活"。
                const canDelegate = hasUsableDispatchChannel({
                  availableTools,
                  blocked: blockedSet,
                  delegationHierarchy: readOptions().delegationHierarchy !== false,
                });
                const decision = evaluatePreExecute({
                  agent,
                  name: toolName,
                  blocked: blockedSet,
                  canDelegate,
                  availableTools,
                  // 3.0.0：层级门禁开启时，执行边界的拒因必须优先给 Team 通道（不能教 Lead 调 subagent_<id>）。
                  delegationHierarchy: readOptions().delegationHierarchy !== false,
                });
                if (decision !== undefined) {
                  ctx.logger?.info?.('project-manager: 拒绝项目经理自己调用 %s（已要求改为派给专家）', toolName);
                  return decision;
                }
              }
            }

            // ② 层级门禁（3.0.0，与指挥者模式共用 lib/guard.js 的同三条判定）：
            //    任务板进展/排期与工单推进状态只由小组长写；项目经理不直接派子智能体。
            //    受 `delegationHierarchy` 控制，`false` 时只留协议约束。
            if (readOptions().delegationHierarchy !== false && isHierarchyGatedTool(toolName)) {
              const availableTools = agentToolNames(agent);
              const boardDecision = evaluateBoardWrite({ agent, name: toolName, args: exec?.arguments, availableTools });
              if (boardDecision !== undefined) {
                ctx.logger?.info?.('project-manager: 拒绝项目经理改任务板进展（应让 owner 小组长结算）');
                return boardDecision;
              }
              const ticketDecision = evaluateTicketWrite({ agent, name: toolName, args: exec?.arguments, availableTools });
              if (ticketDecision !== undefined) {
                ctx.logger?.info?.('project-manager: 拒绝项目经理改工单推进状态（应让 owner 小组长回报）');
                return ticketDecision;
              }
              const dispatchDecision = evaluateSpecialistDispatch({ agent, name: toolName, availableTools });
              if (dispatchDecision !== undefined) {
                ctx.logger?.info?.('project-manager: 拒绝项目经理直接派子智能体 %s（应交给小组长）', toolName);
                return dispatchDecision;
              }
            }

            // ③ 3.1.0 / 3.2.0「禁止等待子智能体」：本模式里任何 agent 调 `wait_agent`
            //    都**无条件拒绝**。用户 2026-11-11 补充要求：禁止等待、不设开关；随后追加
            //    「不要等」→ 整条链都不许等（项目经理、专家小组长、子智能体一视同仁）。
            //    不读任何配置项。
            const waitDecision = evaluateWaitForbidden({ name: toolName });
            if (waitDecision !== undefined) {
              ctx.logger?.info?.('project-manager: 拒绝 wait_agent（禁止等待，无开关，整条链生效）');
              return waitDecision;
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

  ctx.logger?.info?.('project-manager: 模式行就绪（六段流水线 / 六位专家小组长 / 门禁）');
}
