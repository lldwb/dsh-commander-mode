/**
 * Worker Session 工具（0.8.0，opt-in）：
 * `commander_worker_spawn` / `commander_worker_send` / `commander_worker_status` / `commander_worker_stop`。
 *
 * 四个工具都是指挥者专用；执行者在 Worker Session 里只能通过 `commander_report` 汇报。
 * 工具只做参数校验与会话归属，真正的 Session/目录/槽位逻辑在 `lib/worker-sessions.js`。
 *
 * @module dsh-commander-mode/lib/worker-tools
 */

import { isDelegatedAgent } from './guard.js';
import { sessionIdOf } from './dispatch-gate.js';

const OUTPUT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: true });
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }];

/** 校验调用者是指挥者本人。 */
function requireCommander(exec) {
  if (isDelegatedAgent(exec?.agent)) throw new Error('只有指挥者本人能使用 Worker 工具；执行者请用 commander_report。');
  const sessionId = sessionIdOf(exec?.agent);
  if (sessionId === undefined) throw new Error('无法定位当前会话（agent.session.id 为空）。');
  return { agent: exec.agent, sessionId };
}

/** 取服务；缺失/未启用时给出可执行错误。 */
function requireWorkers(getWorkers) {
  const workers = typeof getWorkers === 'function' ? getWorkers() : undefined;
  if (workers === undefined || workers === null) {
    throw new Error('Worker Session 服务不可用（配置 workerSessions: true 且宿主提供 sessionController/workspaceRegistry 后才启用）；改用 specialist 或 Team。');
  }
  return workers;
}

/** 工具公共选项。 */
function common(name, description, properties, required = []) {
  return {
    name,
    description,
    parameters: { type: 'object', additionalProperties: false, properties, ...(required.length === 0 ? {} : { required }) },
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => true,
  };
}

/**
 * `commander_worker_spawn`：给一张工单开独立 Worker Session。
 *
 * @param {object} deps - 依赖。
 * @param {() => object | undefined} deps.getWorkers - 取 `commanderWorkers` 服务。
 * @returns {object} 工具定义。
 */
export function workerSpawnTool({ getWorkers }) {
  return {
    ...common(
      'commander_worker_spawn',
      '给一张**已有工单**开一个独立 Worker Session：自己的 DSH Session、自己的目录（配置 workRoot 下按工单 id 建），'
      + 'worker 只拿到工作工具，结束时用 `commander_report` 汇报。适合多文件改动 / 长任务 / 需要和别的任务隔离。'
      + '前置：计划已确认、工单已建（commander_ticket_create）；spawn 后工具立即返回，汇报会 steer 唤醒你。'
      + '注意：worker 以操作员身份执行，目录不是安全边界；prepareCommand 来自配置。',
      {
        ticket: { type: 'string', description: '工单 id（t-N），必须已存在且未结束。' },
        task: { type: 'string', description: '自包含的任务说明：目标、产出物、验收判据、写作用域、回报要求。' },
        title: { type: 'string', description: '可选的会话标题（默认“执行 <ticket>：<工单标题>”）。' },
      },
      ['ticket', 'task'],
    ),
    async execute(args, exec) {
      const { agent } = requireCommander(exec);
      const workers = requireWorkers(getWorkers);
      const ticketId = typeof args?.ticket === 'string' ? args.ticket.trim() : '';
      const task = typeof args?.task === 'string' ? args.task.trim() : '';
      if (ticketId === '' || task === '') throw new Error('commander_worker_spawn 需要 ticket 与 task。');
      return workers.spawn({ parentAgent: agent, ticketId, task, title: args?.title });
    },
  };
}

/**
 * `commander_worker_send`：给现有 Worker Session 追加指令。
 *
 * @param {object} deps - 依赖。
 * @param {() => object | undefined} deps.getWorkers - 取服务。
 * @returns {object} 工具定义。
 */
export function workerSendTool({ getWorkers }) {
  return {
    ...common(
      'commander_worker_send',
      '给已有 Worker Session 追加一条指令（纠偏、补验收要求、告诉它新的约束）。'
      + '它会作为一条用户角色消息进入 worker 的下一步；不要用它重复派同一任务。',
      {
        ticket: { type: 'string', description: '工单 id。' },
        text: { type: 'string', description: '要追加的指令（自包含，写清要它做什么/改什么）。' },
      },
      ['ticket', 'text'],
    ),
    async execute(args, exec) {
      const { agent } = requireCommander(exec);
      const workers = requireWorkers(getWorkers);
      const ticketId = typeof args?.ticket === 'string' ? args.ticket.trim() : '';
      const text = typeof args?.text === 'string' ? args.text.trim() : '';
      if (ticketId === '' || text === '') throw new Error('commander_worker_send 需要 ticket 与 text。');
      return workers.send({ parentAgent: agent, ticketId, text });
    },
  };
}

/**
 * `commander_worker_status`：查 Worker Session 是否还活着。
 *
 * @param {object} deps - 依赖。
 * @param {() => object | undefined} deps.getWorkers - 取服务。
 * @returns {object} 工具定义。
 */
export function workerStatusTool({ getWorkers }) {
  return {
    ...common(
      'commander_worker_status',
      '查看工单的 Worker Session 状态（session id、目录、是否仍可解析、agent 状态）与工单视图。'
      + '回答"进度如何"时优先用它和看板，不要轮询 list_agents。',
      { ticket: { type: 'string', description: '工单 id。' } },
      ['ticket'],
    ),
    async execute(args, exec) {
      const { agent } = requireCommander(exec);
      const workers = requireWorkers(getWorkers);
      const ticketId = typeof args?.ticket === 'string' ? args.ticket.trim() : '';
      if (ticketId === '') throw new Error('commander_worker_status 需要 ticket。');
      return workers.status({ parentAgent: agent, ticketId });
    },
  };
}

/**
 * `commander_worker_stop`：停止 Worker 当前回合。
 *
 * @param {object} deps - 依赖。
 * @param {() => object | undefined} deps.getWorkers - 取服务。
 * @returns {object} 工具定义。
 */
export function workerStopTool({ getWorkers }) {
  return {
    ...common(
      'commander_worker_stop',
      '停止 Worker 当前回合（保留 Session 与目录，之后可以 worker_send 续做）。'
      + '停止后会记录一条 blocked 汇报并唤醒你；不要用它代替"验收通过"。',
      {
        ticket: { type: 'string', description: '工单 id。' },
        reason: { type: 'string', description: '停止原因（写进工单回报）。' },
      },
      ['ticket'],
    ),
    async execute(args, exec) {
      const { agent } = requireCommander(exec);
      const workers = requireWorkers(getWorkers);
      const ticketId = typeof args?.ticket === 'string' ? args.ticket.trim() : '';
      if (ticketId === '') throw new Error('commander_worker_stop 需要 ticket。');
      return workers.stop({
        parentAgent: agent,
        ticketId,
        reason: typeof args?.reason === 'string' && args.reason.trim() !== '' ? args.reason.trim() : '由指挥者停止',
      });
    },
  };
}

/**
 * 构造四个 Worker 工具。
 *
 * @param {object} deps - 依赖。
 * @param {() => object | undefined} deps.getWorkers - 取 `commanderWorkers` 服务。
 * @returns {object[]} 工具定义数组。
 */
export function buildWorkerTools({ getWorkers }) {
  return [
    workerSpawnTool({ getWorkers }),
    workerSendTool({ getWorkers }),
    workerStatusTool({ getWorkers }),
    workerStopTool({ getWorkers }),
  ];
}
