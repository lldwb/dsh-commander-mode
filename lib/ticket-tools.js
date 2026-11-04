/**
 * 工单工具（0.6.0）：`commander_ticket_create` / `commander_ticket_update` / `commander_tickets`。
 *
 * ## 为什么做成工具而不是"模型自己记"
 *
 * 记忆是概率性的；账本是确定性的。工单要跨轮次、跨压缩、跨重启存在，必须落到账本服务。
 * 这三个工具就是模型与账本之间的**唯一合法入口**（账本服务不暴露给子代理）。
 *
 * ## 与协议的关系
 *
 * - 建工单：计划确认后、派发前；
 * - 更新工单：执行者回报后（或指挥者只读验收后）；
 * - 列工单：每轮看板之外，需要主动查状态时用。
 *
 * 工具描述要写成**可执行的契约**（参数、前置条件、下一步），因为它在决策点被读到的概率
 * 远高于长协议。
 *
 * @module dsh-commander-mode/lib/ticket-tools
 */

import { isDelegatedAgent } from './guard.js';
import { sessionIdOf } from './dispatch-gate.js';
import { PLAN_CONFIRM_LABEL, PLAN_QUESTION_ID, ticketView } from './tickets.js';

/** 工具返回值的 schema（账本对象是开放的，只要求是对象）。 */
const OUTPUT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: true });

/** 统一的渲染：JSON 文本。 */
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }];

/** 可更新的状态（六态 + 两个终态）。 */
const UPDATE_STATUSES = Object.freeze([
  'progress',
  'waiting',
  'ready',
  'blocked',
  'failed',
  'dropped',
  'done',
  'cancelled',
]);

/** 六态回报集合。 */
const REPORT_STATUSES = new Set(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']);

/**
 * 取账本服务；缺失时给出可执行错误（而不是静默成功）。
 *
 * @param {() => object | undefined} getLedger - 读取服务。
 * @returns {object} 账本服务。
 */
function requireLedger(getLedger) {
  const ledger = typeof getLedger === 'function' ? getLedger() : undefined;
  if (ledger === undefined || ledger === null) {
    throw new Error(
      '工单账本服务不可用（这个部署里没有 commanderLedger，或配置关闭了它）。' +
        '不要假装建过工单：请在正文里说明计划与步骤，靠看板/任务板同步，或让用户检查插件是否加载成功。',
    );
  }
  return ledger;
}

/** 校验调用者是指挥者本人。 */
function requireCommander(exec) {
  if (isDelegatedAgent(exec?.agent)) {
    throw new Error('只有指挥者本人能使用工单工具；执行者请用报告回传（STATUS: …）。');
  }
  const sessionId = sessionIdOf(exec?.agent);
  if (sessionId === undefined) {
    throw new Error('无法定位当前会话（agent.session.id 为空），工单工具需要一个指挥者会话。');
  }
  return sessionId;
}

/**
 * `commander_ticket_create` 的定义。
 *
 * @param {object} deps - 依赖。
 * @param {() => object | undefined} deps.getLedger - 取账本服务。
 * @returns {object} 工具定义。
 */
export function ticketCreateTool({ getLedger }) {
  return {
    name: 'commander_ticket_create',
    description:
      '建一张工单：本模式下**每一件被派出去的活**都必须挂在一张工单上。'
      + '用法：计划被用户确认之后、派发之前调用；一张工单可以对应多次派发（实现/返工/审查）。'
      + `前置条件：用户已确认计划（\`ask_user_question\` 的问题 id=\`${PLAN_QUESTION_ID}\`，选项「${PLAN_CONFIRM_LABEL}」）。`
      + '没有计划授权时也能建工单，但派发会被门禁拒绝。'
      + '参数：title（一句话交付物）、intent（目标与背景）、acceptance（验收判据数组）、scope（写作用域数组，只是提示不是锁）。'
      + '返回工单 id（t-N）与当前状态；派发时把它带在 specialist 的 ticket 参数或 Team 的 `[ticket:t-N]` 标记里。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: '一句话说清这件活要交付什么（≤200 字符）。' },
        intent: { type: 'string', description: '目标与背景：为什么要做、边界在哪（可选）。' },
        acceptance: {
          type: 'array',
          items: { type: 'string' },
          description: '验收判据：怎样算完成（可选，但建议至少一条）。',
        },
        scope: {
          type: 'array',
          items: { type: 'string' },
          description: '写作用域：允许执行者改哪些文件/目录（可选；只是提示，不是锁）。',
        },
      },
      required: ['title'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => true,
    execute(args, exec) {
      const sessionId = requireCommander(exec);
      const ledger = requireLedger(getLedger);
      const ticket = ledger.createTicket({
        sessionId,
        title: args?.title,
        intent: typeof args?.intent === 'string' ? args.intent : '',
        acceptance: Array.isArray(args?.acceptance) ? args.acceptance : [],
        scope: Array.isArray(args?.scope) ? args.scope : [],
      });
      const mandate = ledger.activeMandate(sessionId);
      return {
        ticket,
        mandate_pending: mandate === null,
        note: mandate === null
          ? `还没有计划授权：派发前先用 ask_user_question（id=\`${PLAN_QUESTION_ID}\`，确认选项「${PLAN_CONFIRM_LABEL}」）让用户确认计划。`
          : `已继承计划授权 ${mandate.id}；派发时带上 ticket=\`${ticket.id}\`。`,
      };
    },
  };
}

/**
 * `commander_ticket_update` 的定义。
 *
 * @param {object} deps - 依赖。
 * @param {() => object | undefined} deps.getLedger - 取账本服务。
 * @returns {object} 工具定义。
 */
export function ticketUpdateTool({ getLedger }) {
  return {
    name: 'commander_ticket_update',
    description:
      '更新工单：记录执行者回报、或指挥者验收/结算/取消。'
      + '`status` 六态：progress（在推进）/ waiting（等外部触发）/ ready（可验收）/ blocked（受阻等用户）/ failed（失败）/ dropped（无需处理）；'
      + '另有 done（验收通过，结束）/ cancelled（取消，结束）。'
      + '结构约束：blocked/failed 时用 question 写清"需要用户决定什么"；ready 时用 summary 写"做了什么、怎么验证"。'
      + '不要用它替代执行者回报：执行者的最终答复里应带 `STATUS: <六态>` 行，指挥者核对后再更新工单。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ticket: { type: 'string', description: '工单 id（t-N）。' },
        status: { type: 'string', enum: [...UPDATE_STATUSES], description: '目标状态。' },
        summary: { type: 'string', description: '发生了什么 / 做了什么（≤2000 字符）。' },
        question: { type: 'string', description: '需要用户回答的具体问题（blocked/failed 时用）。' },
        reason: { type: 'string', description: '结束原因（done/cancelled 时用）。' },
        title: { type: 'string', description: '修改标题（可选）。' },
        intent: { type: 'string', description: '修改目标与背景（可选）。' },
        acceptance: { type: 'array', items: { type: 'string' }, description: '修改验收判据（可选）。' },
        scope: { type: 'array', items: { type: 'string' }, description: '修改写作用域（可选）。' },
      },
      required: ['ticket'],
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => true,
    execute(args, exec) {
      const sessionId = requireCommander(exec);
      const ledger = requireLedger(getLedger);
      const ticketId = typeof args?.ticket === 'string' ? args.ticket.trim() : '';
      if (ticketId === '') throw new Error('缺少 ticket 参数：传工单 id（先用 commander_tickets 查）。');
      const status = typeof args?.status === 'string' ? args.status.toLowerCase() : undefined;
      const summary = typeof args?.summary === 'string' ? args.summary : '';
      const question = typeof args?.question === 'string' ? args.question : '';
      const reason = typeof args?.reason === 'string' ? args.reason : '';

      // 先允许修改描述字段（不改变状态）。
      const descriptionPatch = {};
      for (const key of ['title', 'intent', 'acceptance', 'scope']) {
        if (args?.[key] !== undefined) descriptionPatch[key] = args[key];
      }
      if (Object.keys(descriptionPatch).length > 0) ledger.updateTicket(ticketId, sessionId, descriptionPatch);

      let ticket;
      if (status === undefined) {
        ticket = ticketView(ledger.getTicket(ticketId, sessionId));
      } else if (REPORT_STATUSES.has(status)) {
        ticket = ledger.recordReport(ticketId, sessionId, { status, summary, question });
      } else if (status === 'done' || status === 'cancelled') {
        ticket = ledger.setStatus(ticketId, sessionId, status, { reason, summary });
      } else {
        throw new Error(`未知状态 ${status}；允许：${UPDATE_STATUSES.join(' / ')}。`);
      }
      return { ticket, attention: ledger.attention(sessionId, 10 * 60 * 1000) };
    },
  };
}

/**
 * `commander_tickets` 的定义。
 *
 * @param {object} deps - 依赖。
 * @param {() => object | undefined} deps.getLedger - 取账本服务。
 * @returns {object} 工具定义。
 */
export function ticketsTool({ getLedger }) {
  return {
    name: 'commander_tickets',
    description:
      '查看当前会话的工单、计划授权与待人工项。默认只看未结束的工单；需要历史时传 include_ended=true。'
      + '用途：派发前确认 ticket id；验收/收尾前核对还有哪些没结算；用户问"进度如何"时据此回答（不要用 list_agents / team_task_list 轮询）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include_ended: { type: 'boolean', description: '是否包含已结束的工单（默认 false）。' },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => true,
    execute(args, exec) {
      const sessionId = requireCommander(exec);
      const ledger = requireLedger(getLedger);
      const includeEnded = args?.include_ended === true;
      const summary = ledger.summary(sessionId);
      const attention = ledger.attention(sessionId, 10 * 60 * 1000);
      if (!includeEnded) {
        // summary.tickets 已只含未结束的（listTickets 默认）。
        return { ...summary, attention };
      }
      return {
        ...summary,
        attention,
        tickets: ledger.listTickets(sessionId, { includeEnded: true }).map(ticketView),
      };
    },
  };
}

/**
 * 一次性构造三个工具定义。
 *
 * @param {object} deps - 依赖。
 * @param {() => object | undefined} deps.getLedger - 取账本服务。
 * @returns {object[]} 工具定义数组。
 */
export function buildTicketTools({ getLedger }) {
  return [
    ticketCreateTool({ getLedger }),
    ticketUpdateTool({ getLedger }),
    ticketsTool({ getLedger }),
  ];
}
