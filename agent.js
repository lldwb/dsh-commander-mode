/**
 * `dsh-commander-mode/agent` —— 「指挥者模式」的**模式行**（agent preset 子行）。
 *
 * ## 它是什么
 *
 * 一个按会话生效的 agent preset 子行，把该会话的 agent 变成**指挥者**：接到任务先分析
 * 与侦察（只读），然后规划与拆分，**停下来让用户确认计划**，再把执行派给子代理；
 * 自己不动手写文件、不跑命令，遇到分歧或不确定就回头问用户。
 *
 * ## 两种派发通道
 *
 * 1. **多模型 specialist 名册**：用户在「设置 → 插件 → 指挥者模式」里配置任意多个
 *    specialist，每个绑定自己的 provider / model / 职责 / 人设。每个 specialist 暴露成
 *    一个前台工具 `subagent_<id>`。见 `lib/specialists.js`。
 * 2. **智能体团队**（Agent Teams）：`spawn_teammate` / `send_message` / `wait_agent` /
 *    `team_task_*`，适合需要长期存在、可对话、可共享任务板的具名队友。
 *
 * ## 本行不持有配置
 *
 * 配置在另一个行里：包根的 `index.js`（profile 顶层，行 id = `commander-mode` =
 * 设置命名空间）。原因见 `lib/settings-service.js` 的模块注释：preset 子行不在 Loader 的
 * entry 树里，声明在这一行上的 `Config` 设置页看不到。
 *
 * 所以本行通过 `commanderSettings` 服务读配置；**服务缺失时用默认值降级**（例如有人把
 * 这个出口当普通插件挂进别的 preset），绝不因为拿不到配置就不激活。
 *
 * ## 模式是怎么表达的
 *
 * 一段 system-prompt section，文本在**每次组装时重新计算**。协议每一步都在场；名册也实时
 * 读服务，所以设置页保存后，**新会话**立刻看到新的 specialist 工具。
 *
 * ## 边界说明（重要）
 *
 * 「指挥者不执行操作」有**两道**保障：协议（每轮重述）+ 门禁（`tools/pre-execute`
 * waterfall 确定性地拒绝 `write` / `edit` / `pwsh` / `bash` / `job_kill` /
 * `plugin_manager`，拒绝理由就是纠正指令）。
 *
 * ## 结算同步（0.4.0）
 *
 * 「任务完成了但任务板 / 计划清单 / 团队状态没同步」是长会话里最贵的一种失误：用户看到的
 * 进度是过期的。这里用两条**确定性**通道兜住，而不是只靠协议：
 *
 * - `systemPrompt.context`：每轮运行时上下文里的「指挥者·同步看板」，给出任务板 / 计划清单 /
 *   团队状态的实时快照，有未同步项时带纠正指令（**事前**）。
 * - `agent/turn-stopping`：回合即将结束仍有未同步项时注入一次提醒（**事后**，每回合一次）。
 *
 * 两条都只对指挥者生效；teammate 通过 `isDelegatedAgent` 排除。逻辑在 `lib/sync.js`。
 *
 * 同样是为了 teammate：preset scope 是共享的，所以在这个 scope 上注册的 prompt section
 * 也会进 teammate 的系统提示（实测 0.3.x 就是这样 —— 执行者被灌了整份"你不执行操作"）。
 * 0.4.0 起 section 的 text 按 agent 判定，子级一律返回空串：既省 token，也不再和它们的人设打架。
 *
 * 为什么不把工具从 preset 里裁掉：队友通过 `agentPresets.composeFrom()` 加入**父会话的
 * 同一个 preset scope**，裁剪会连它们一起废掉（per-child 的工具限制只能收紧、不能扩展）。
 * 而 specialist 走**独立 preset**（`lib/specialists.js`），根本看不到指挥者协议。
 *
 * @module dsh-commander-mode/agent
 */

import { randomUUID } from 'node:crypto';

import { DEFAULT_BLOCKED_TOOLS, DELEGATION_TOOLS, agentToolNames, evaluatePreExecute, isDelegatedAgent } from './lib/guard.js';
import { resolveConfig } from './lib/config.js';
import {
  COMMANDER_PROTOCOL,
  SKILL_DESCRIPTION,
  SKILL_NAME,
  SKILL_WHEN_TO_USE,
  renderModeOpening,
} from './lib/protocol.js';
import { installSpecialist } from './lib/specialists.js';
import {
  SYNC_CONTEXT_NAME,
  SYNC_CONTEXT_ORDER,
  buildSyncNudge,
  createSyncLedger,
  evaluateSync,
  recordBoard,
  recordPlan,
  renderSyncBoard,
} from './lib/sync.js';

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'commander-mode-agent';

/**
 * 本行缺了就干不了活的服务：没有 `systemPrompt` 就没有模式本身。
 *
 * `commanderSettings` / `tools` / `subagents` / `agentPresets` / `skills` 都是**可选**的
 * （各自用 `ctx.inject` 接线），所以精简部署里模式照样成立，只是少一条通道。
 */
export const inject = ['systemPrompt'];

/**
 * prompt section 的落位：plan 策略（500）与 team 策略（600）之后、工具指导块之前。
 */
export const SECTION_ORDER = 650;

/** prompt section 名。 */
export const SECTION_NAME = 'commander:mode';

/**
 * 拿不到配置行服务时的默认选项。
 *
 * 用 `resolveConfig(undefined)` 而不是手抄一份，保证默认值与 schema 一致。
 */
export const FALLBACK_OPTIONS = Object.freeze(resolveConfig(undefined).options);

/**
 * 注册模式行。
 *
 * @param {object} ctx - Cordis 插件上下文（preset scope）。
 */
export function apply(ctx) {
  // ---------------------------------------------------------- 配置服务 ---

  /**
   * 取配置服务（可能晚到、也可能不存在）。
   *
   * @returns {object | undefined} `commanderSettings` 实例。
   */
  const readSettings = () => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('commanderSettings') : undefined;
    } catch {
      return undefined;
    }
  };

  /** 当前加载期选项（服务缺失时用默认值）。 */
  const readOptions = () => {
    try {
      return readSettings()?.options?.() ?? FALLBACK_OPTIONS;
    } catch (error) {
      ctx.logger?.warn?.('commander-mode: 读取配置失败，改用默认值：%o', error);
      return FALLBACK_OPTIONS;
    }
  };

  /**
   * 已**成功安装**的 specialist 名册快照。
   *
   * 协议里点名工具之前必须先确认工具真的在：名册里有、但 preset/工具注册失败的条目必须
   * 被排除 —— 否则模型会照着协议去调一个不存在的工具，当场卡住。
   */
  let installedRoster = [];

  /**
   * 取一个可选服务（可能还没被别的行提供，也可能这个部署里根本没有）。
   *
   * @param {string} name - 服务名。
   * @returns {object | undefined} 服务实例。
   */
  const getService = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  };

  // -------------------------------------------------- 结算同步（看板 + 兜底） ---

  //
  // 为什么需要这一块：长会话里任务板一直在动，而计划清单没人更新。实测一次三小时会话
  // （1111 个事件、3 个子代理）：`todo_write` 只调了 5 次，最后一次停在 +61 分钟，之后
  // 100 分钟里任务板完成/删除了 4 个任务，清单一次没动，直到用户亲口问「进度怎么不同步」。
  //
  // 协议只能降低概率，所以这里补两道确定性的：
  //
  // 1. **每轮运行时上下文**（`systemPrompt.context`）——把任务板 / 计划清单 / 团队状态
  //    的实时快照放在模型每一步都能读到的地方；有未同步项时直接给出纠正指令。这是"事前"。
  // 2. **回合结束兜底**（`agent/turn-stopping`）——回合要结束了还有未同步项时注入一条提醒，
  //    让模型在同一个回合里补完。这是"事后"。
  //
  // 两者都**只对指挥者本人**生效：teammate 走同一个 preset scope（`composeFrom`），所以
  // 必须用 `isDelegatedAgent` 区分，否则会给执行者注入"你该去同步任务板"的噪声。

  /** 每个 agent 一份同步账本；agent 是活对象，会话结束自然回收。 */
  const ledgers = new WeakMap();

  /**
   * 取（或创建）某个 agent 的同步账本。
   *
   * @param {object} agent - 活着的 agent。
   * @returns {object} 账本。
   */
  const ledgerOf = (agent) => {
    let ledger = ledgers.get(agent);
    if (ledger === undefined) {
      ledger = createSyncLedger();
      ledgers.set(agent, ledger);
    }
    return ledger;
  };

  /** 已经提醒过的回合（`sessionId:turn`）；只需要覆盖还可能在收尾的轮次。 */
  const nudgedTurns = new Set();

  /**
   * 读团队视图（任务板 + 成员）。
   *
   * 读不到一律返回 `undefined`（"未知"），让同步判定跳过而不是误报：
   * 这个部署可能根本没装「智能体团队」，或者当前 agent 还不是 Team 成员。
   *
   * @param {object} agent - 指挥者 agent。
   * @returns {{ tasks: object[], members: object[] } | undefined} 团队视图。
   */
  const readTeam = (agent) => {
    const service = getService('agentTeams');
    if (service === undefined) return undefined;
    try {
      // `tryMembership` 对"不是 Team 成员"返回 undefined；`listTasks` 在非成员上会抛。
      if (typeof service.tryMembership === 'function' && service.tryMembership(agent) === undefined) return undefined;
      const tasks = typeof service.listTasks === 'function' ? service.listTasks(agent) : [];
      const members = typeof service.listMembers === 'function' ? service.listMembers(agent) : [];
      return {
        tasks: Array.isArray(tasks) ? tasks : [],
        // Lead 自己也会出现在成员列表里；看板只关心执行者的状态。
        members: Array.isArray(members) ? members.filter((member) => member?.role !== 'lead') : [],
      };
    } catch (error) {
      ctx.logger?.debug?.('commander-mode: 读取团队状态失败（按未知处理）：%o', error);
      return undefined;
    }
  };

  /**
   * 同步能力的运行时开关：配置开启**且**这个部署里真有团队服务。
   *
   * @returns {boolean} 是否提供「指挥者·同步看板」。
   */
  const syncBoardEnabled = () => {
    try {
      return readOptions().syncGuard !== false && getService('agentTeams') !== undefined;
    } catch {
      return false;
    }
  };

  /**
   * 观测一次同步状态：读团队视图 → 更新账本 → 给出视图。
   *
   * @param {object} agent - 指挥者 agent。
   * @returns {{ view: object, members: object[] }} 视图与成员（读不到团队时 members 为空）。
   */
  const inspectSync = (agent) => {
    const ledger = ledgerOf(agent);
    const team = readTeam(agent);
    if (team !== undefined) recordBoard(ledger, team.tasks);
    return { view: evaluateSync(ledger), members: team?.members ?? [] };
  };

  // ---------------------------------------------------------------- 提示词 ---

  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context) => {
      try {
        // 0.4.0 修复：teammate / specialist 与指挥者共用同一个 preset scope，也会被问到
        // 这份 section。此前它们会收到完整的「指挥者模式」协议（"你不执行操作"），
        // 既浪费每个请求约 4 KB，又和它们自己的执行者人设冲突。子级一律返回空串。
        const agent = context?.agent;
        if (agent !== undefined && isDelegatedAgent(agent)) return '';
        return renderModeOpening({
          ...readOptions(),
          specialists: installedRoster,
          hasSpecialistTools: installedRoster.length > 0,
          syncBoard: syncBoardEnabled(),
        });
      } catch (error) {
        // prompt section 抛错会让该会话的每一步都失败，所以渲染失败就退化成
        // 「模式关闭」，而不是把会话弄挂。
        ctx.logger?.warn?.('commander-mode: 渲染 prompt section 失败：%o', error);
        return '';
      }
    },
  });

  // ------------------------------------------------------------ 同步看板 ---

  // `systemPrompt.context` 是**每轮**下发的运行时上下文（与用户请求同一条消息），
  // 实测比 section 的遵从率高得多；这里用它把"当前有没有未同步项"放在模型眼前。
  if (typeof ctx.systemPrompt.context === 'function') {
    ctx.systemPrompt.context({
      name: SYNC_CONTEXT_NAME,
      order: SYNC_CONTEXT_ORDER,
      text: (context) => {
        try {
          const agent = context?.agent;
          if (agent === undefined || isDelegatedAgent(agent)) return '';
          if (!syncBoardEnabled()) return '';
          const { view, members } = inspectSync(agent);
          return renderSyncBoard(view, members);
        } catch (error) {
          // 运行时上下文抛错会让每个请求都失败；读不到就当没有可报的。
          ctx.logger?.warn?.('commander-mode: 渲染同步看板失败：%o', error);
          return '';
        }
      },
    });
  }

  // 计划清单只在 `todo_write` 成功之后才算更新（整表替换语义）。记它的作用有两个：
  // ① 判断"任务结算之后计划清单有没有更新过"；② 看板里给出清单的完成进度。
  ctx.on('tools/post-execute', (exec, _result, next) => {
    try {
      if (exec?.name === 'todo_write') {
        const agent = exec.agent;
        if (agent !== undefined && !isDelegatedAgent(agent) && readOptions().syncGuard !== false) {
          const todos = exec.arguments?.todos;
          if (Array.isArray(todos)) {
            const ledger = ledgerOf(agent);
            // ⚠️ 顺序陷阱：模型可能在**同一步**里"先 task_update 结算、再 todo_write 同步"。
            // 任务板的变化要等到下一次求值（看板/兜底）才会被账本观测到；如果只在那一刻
            // 算 epoch，这次已经完全同步的写入会被误判成"清单落后于结算"。
            // 所以写清单时先把**当时真实的板**记成新基线：它代表"这次同步之后"的状态。
            const team = readTeam(agent);
            if (team !== undefined) recordBoard(ledger, team.tasks);
            recordPlan(ledger, todos);
          }
        }
      }
    } catch (error) {
      ctx.logger?.debug?.('commander-mode: 记录计划清单失败：%o', error);
    }
    return typeof next === 'function' ? next() : undefined;
  });

  // 回合要结束了、结算却还没同步 → 在同一个回合里补一次提醒（每回合最多一次）。
  // 这是"事后"的兜底：正常情况下运行时时上下文里的同步看板已经让模型在回复前就同步完。
  ctx.on('agent/turn-stopping', (payload) => {
    try {
      const agent = payload?.agent;
      if (agent === undefined || isDelegatedAgent(agent)) return;
      if (payload?.signal?.aborted === true) return;
      if (readOptions().syncGuard === false) return;
      if (!syncBoardEnabled()) return;
      if (typeof agent.inject !== 'function') return;

      const turn = payload?.turn;
      const key = `${String(agent.session?.id ?? agent.id)}:${String(turn)}`;
      if (nudgedTurns.has(key)) return; // 同一回合只兜一次，否则会死循环

      const { view } = inspectSync(agent);
      const text = buildSyncNudge(view);
      if (text === '') return;

      // 账本只需要覆盖那些还可能正在收尾的轮次。
      if (nudgedTurns.size > 256) nudgedTurns.clear();
      nudgedTurns.add(key);

      agent.inject({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        // 不是 `kind: 'user'`：这是插件提醒，不是用户发言（技能手势扫描只读真正的用户输入）。
        source: { kind: 'dsh-commander-mode', form: 'notice', summary: '结算同步提醒' },
      });
      ctx.logger?.info?.('commander-mode: 结算未同步，已注入一次兜底提醒（turn=%s）', String(turn));
    } catch (error) {
      // 兜底钩子自己出错绝不能把回合弄挂 —— 最坏情况是少一次提醒。
      ctx.logger?.warn?.('commander-mode: 结算同步兜底失败：%o', error);
    }
  });

  // ---------------------------------------------------------------- 门禁 ---

  /**
   * 该 agent 实际能用的工具名，以及其中有没有"把活派出去"的通道。
   *
   * 读 `agent.ctx.tools.schemas()` —— 在 agent 自己的作用域里求值，所以能看见 agent
   * 作用域注册的工具（Team 工具不在 preset scope 的视图里）。
   *
   * 读不到时返回 `undefined`（未知），判定按"有"处理；读到空视图同样当作"读不到"——
   * 0.1.x 的教训：`dsh-web-app` 把能力行全局禁用、工具在 preset 层，空视图被当成事实会
   * 让门禁整个失效。
   *
   * specialist 工具名是动态的（`subagent_<id>`），这里按前缀识别：只要工具视图里有
   * `subagent_*`，它就有派发通道 —— 不看配置名册，因为"配置里有"不等于"这个会话里有"。
   */
  const inspectAgentTools = (agent) => {
    const availableTools = agentToolNames(agent);
    if (availableTools === undefined) return { availableTools, canDelegate: undefined };
    return {
      availableTools,
      canDelegate: availableTools.some(
        (toolName) => DELEGATION_TOOLS.includes(toolName) || toolName.startsWith('subagent_'),
      ),
    };
  };

  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      const toolName = typeof exec?.name === 'string' ? exec.name : '';
      const blockedSet = new Set(readOptions().blockedTools ?? DEFAULT_BLOCKED_TOOLS);
      // 快路径：绝大多数调用既不在拦截清单里，也不是 Lead 发起的。
      if (blockedSet.has(toolName) && !isDelegatedAgent(exec?.agent)) {
        const { availableTools, canDelegate } = inspectAgentTools(exec.agent);
        const decision = evaluatePreExecute({
          agent: exec.agent,
          name: toolName,
          blocked: blockedSet,
          canDelegate,
          availableTools,
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

  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (skillCtx) => {
      // `registerSkill` 是加载期开关：拿不到配置服务时按默认（注册）处理。
      const enabled = (() => {
        try {
          return readSettings()?.options?.().registerSkill !== false;
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

  // ------------------------------------------------------------ specialist ---

  /**
   * specialist 的安装与重建。
   *
   * 配置在配置行里、名册是 volatile：设置页保存后 Loader 只热更新配置行的引用，然后配置行
   * 通过服务广播。这里订阅该广播，释放旧 preset/工具、按新名册重新注册。已经打开的会话保留
   * 它启动时的工具（DSH 的既定语义，设置页文案里也写明）。
   *
   * 缺服务时的降级：`tools` / `subagents` / `agentPresets` / `commanderSettings` 任何一个
   * 不存在，就只注册协议与门禁、不注册 specialist 工具 —— 模式退化为「只会做协议的普通
   * agent」，而不是把会话弄挂。
   */
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools', 'subagents', 'agentPresets', 'commanderSettings'], (toolCtx) => {
      try {
        /** 已安装 specialist 的异步释放函数。 */
        let disposers = [];
        /** 串行化重建，避免两次通知交错注册。 */
        let queue = Promise.resolve();
        /** 子级作用域已销毁。 */
        let disposed = false;

        const settings = toolCtx.commanderSettings;

        /**
         * 取 `subagents` 服务（可能晚于本行出现）。
         *
         * @returns {object | undefined} 服务实例。
         */
        const getSubagents = () => {
          try {
            return typeof toolCtx.get === 'function' ? toolCtx.get('subagents') : toolCtx.subagents;
          } catch {
            return undefined;
          }
        };

        /** 释放当前已安装的全部 specialist（失败不阻断其余释放）。 */
        const releaseAll = async () => {
          const previous = disposers;
          disposers = [];
          for (const dispose of previous) {
            try {
              await dispose();
            } catch (error) {
              toolCtx.logger?.warn?.('commander-mode: 释放 specialist 失败：%o', error);
            }
          }
        };

        /** 按当前名册重建 specialist preset 与工具。 */
        const rebuild = () => {
          queue = queue.then(async () => {
            if (disposed) return;
            await releaseAll();
            // 先清空协议视图：重建期间旧工具已经释放，此时协议不能还点名它们。
            installedRoster = [];
            const roster = settings.specialists();
            const enabled = new Set(roster.map((specialist) => specialist.id));
            const installed = [];
            for (const specialist of roster) {
              try {
                disposers.push(
                  await installSpecialist({
                    ctx: toolCtx,
                    specialist,
                    getSubagents,
                    isEnabled: () => enabled.has(specialist.id) && settings.specialists().some((entry) => entry.id === specialist.id),
                  }),
                );
                installed.push(specialist);
              } catch (error) {
                // 单个 specialist 注册失败（例如 preset id 冲突）不应拖垮整个模式，也不能
                // 留在协议里 —— 协议点名一个没挂上的工具会让模型当场卡住。
                toolCtx.logger?.warn?.('commander-mode: 安装 specialist "%s" 失败：%o', specialist.id, error);
              }
            }
            installedRoster = installed;
            toolCtx.logger?.info?.('commander-mode: 已安装 %d 个 specialist 工具', installed.length);
          }).catch((error) => {
            toolCtx.logger?.warn?.('commander-mode: 重建 specialist 失败：%o', error);
          });
          return queue;
        };

        // 配置行广播"名册变了" → 重建。退订函数跟着本行作用域释放。
        toolCtx.effect(() => settings.subscribe(() => void rebuild()), 'commander-mode: roster subscription');

        toolCtx.effect(() => {
          void rebuild();
          return () => {
            disposed = true;
            void queue.then(releaseAll).catch(() => {});
          };
        }, 'commander-mode: specialist tools');
      } catch (error) {
        // 接线层自己出错时只损失 specialist 通道，**不能**让整行 broken ——
        // 那会让指挥者协议与门禁一起消失，模式整个失效。
        ctx.logger?.warn?.('commander-mode: specialist 接线失败，本会话退化为无 specialist 通道：%o', error);
      }
    });
  }

  ctx.logger?.info?.('commander-mode: 模式行就绪（配置来自 commanderSettings 服务）');
}
