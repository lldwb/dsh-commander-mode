/**
 * 工单 → 共享任务板投影器（`lib/team-board-bridge.js`）的测试。
 *
 * 这层的两条硬要求：
 * 1. 纯函数（模板/合并/识别）必须逐字可测 —— 它决定用户在看板上看到什么；
 * 2. 所有 IO 失败都只能降级为 `undefined`，**绝不能抛给调用方**（投影坏掉不能影响工单）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  channelOf,
  createTeamBoardBridge,
  isProjectedTask,
  mergeDescription,
  projectContent,
  projectedTicketId,
  sanitizeWriteScopes,
  teamErrorCode,
} from '../lib/team-board-bridge.js';

const AGENT = { session: { id: 's-1', header: {} } };

/** 一张工单记录（账本内部记录形状）。 */
function ticket(overrides = {}) {
  return {
    id: 't-1',
    sessionId: 's-1',
    title: '实现登录',
    intent: '让用户能登录',
    acceptance: ['能登录', '错误有提示'],
    scope: ['src/login/**'],
    status: 'open',
    mandateId: 'm-1',
    teamTaskId: null,
    assignments: [],
    lastReport: null,
    execution: null,
    createdAt: 1,
    updatedAt: 1,
    endedAt: null,
    endReason: null,
    ...overrides,
  };
}

/** 带一次派发的工单。 */
function assignedTicket(overrides = {}) {
  return ticket({
    status: 'working',
    assignments: [{
      id: 'a-1',
      channel: 'team',
      toolName: 'subagent',
      ref: null,
      startedAt: 2,
      endedAt: null,
    }],
    ...overrides,
  });
}

/**
 * 一个最小的 `agentTeams` 服务替身：与真实 API 对齐（同步 get/list、异步 create/update、
 * CAS `TEAM_TASK_STALE_REVISION`、删除墓碑）。
 *
 * 6.0.0（DSH 0.2.2-rc.2）：旧 `tryMembership(agent)` 名册判据已移除，Team 的权威判据是
 * `isEnabled(agent) === true`；服务对象只需 `isEnabled` + 四个任务方法。
 *
 * @param {object[]} [initial] - 初始任务。
 * @returns {object} 服务。
 */
function makeService(initial = []) {
  const tasks = new Map(initial.map((task) => [task.id, { ...task }]));
  let counter = 100;
  const calls = [];
  const error = (code, message) => Object.assign(new Error(message), { code });

  const normalize = (task) => ({
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    description: task.description,
    status: task.status,
    ...(task.ownerName === undefined ? {} : { ownerName: task.ownerName }),
    blockedBy: [],
    writeScopes: Array.isArray(task.writeScopes) ? [...task.writeScopes] : [],
    ready: true,
    writeScopeWarnings: [],
  });

  return {
    calls,
    tasks,
    isEnabled: () => true,
    listTasks: () => [...tasks.values()].filter((task) => task.status !== 'deleted').map(normalize),
    getTask: (_agent, id) => {
      const task = tasks.get(id);
      if (task === undefined) throw error('TEAM_TASK_NOT_FOUND', `task ${id} not found`);
      return normalize(task);
    },
    createTask: async (_agent, request) => {
      calls.push({ action: 'create', request });
      const id = `task-${counter++}`;
      const created = {
        id,
        revision: 1,
        subject: request.subject,
        description: request.description,
        status: 'pending',
        blockedBy: [],
        writeScopes: request.writeScopes ?? [],
      };
      tasks.set(id, created);
      return normalize(created);
    },
    updateTask: async (_agent, request) => {
      calls.push({ action: request.action, taskId: request.taskId, owner: request.owner });
      const current = tasks.get(request.taskId);
      if (current === undefined) throw error('TEAM_TASK_NOT_FOUND', 'not found');
      if (request.expectedRevision !== current.revision) throw error('TEAM_TASK_STALE_REVISION', 'stale');
      let next;
      switch (request.action) {
        case 'claim':
          next = { ...current, status: 'in_progress', ownerName: 'lead' };
          break;
        case 'complete':
          if (current.status !== 'in_progress') throw error('TEAM_TASK_INVALID_TRANSITION', 'not in progress');
          next = { ...current, status: 'completed' };
          break;
        case 'reopen':
          next = { ...current, status: 'pending' };
          break;
        case 'reassign':
          next = { ...current, status: 'in_progress', ownerName: request.owner };
          break;
        case 'edit':
          next = {
            ...current,
            ...(request.subject === undefined ? {} : { subject: request.subject }),
            ...(request.description === undefined ? {} : { description: request.description }),
            ...(request.writeScopes === undefined ? {} : { writeScopes: [...request.writeScopes] }),
          };
          break;
        case 'delete':
          next = { ...current, status: 'deleted' };
          break;
        default:
          throw error('TEAM_INVALID_ARGUMENT', `unknown action ${request.action}`);
      }
      next = { ...next, revision: current.revision + 1 };
      tasks.set(next.id, next);
      return normalize(next);
    },
  };
}

/** 取投影器。 */
function bridgeFor(service) {
  return createTeamBoardBridge({ getService: (name) => (name === 'agentTeams' ? service : undefined), logger: undefined });
}

// ---------------------------------------------------------------- 纯函数 ---

test('channelOf：没有派发是 none，非法通道归 none', () => {
  assert.equal(channelOf(ticket()), 'none');
  assert.equal(channelOf(assignedTicket()), 'team');
  assert.equal(channelOf(ticket({ assignments: [{ channel: 'specialist' }] })), 'specialist');
  assert.equal(channelOf(ticket({ assignments: [{ channel: '胡说' }] })), 'none');
  assert.equal(channelOf(null), 'none');
});

test('projectContent：前三行 marker + 验收判据 + 执行者', () => {
  const content = projectContent(assignedTicket({ id: 't-7', title: '跑测试' }));
  const lines = content.description.split('\n');
  assert.equal(lines[0], '[commander:ticket=t-7]');
  assert.equal(lines[1], '[commander:channel=team]');
  assert.equal(lines[2], '[commander:status=working]');
  assert.match(content.description, /## 验收判据\n- 能登录\n- 错误有提示/u);
  assert.match(content.description, /## 执行者\nTeam 通道：owner 由插件自动绑定/u);
  assert.equal(content.subject, '跑测试');
  assert.deepEqual(content.writeScopes, ['src/login/**']);
});

test('projectContent：空 intent/acceptance/scope 也有稳定输出', () => {
  const content = projectContent(ticket({ intent: '', acceptance: [], scope: [] }));
  assert.match(content.description, /（无背景说明）/u);
  assert.match(content.description, /- （未填写）/u);
  assert.deepEqual(content.writeScopes, []);
});

test('projectContent：subject 截断到 200、描述截断到 16384', () => {
  const content = projectContent(ticket({
    title: 'x'.repeat(300),
    intent: 'y'.repeat(20_000),
    acceptance: ['z'.repeat(20_000)],
  }));
  assert.equal(content.subject.length, 200);
  assert.equal(content.description.length, 16_384);
  assert.ok(content.description.startsWith('[commander:ticket=t-1]'), '截断不能切掉 marker');
});

// ------------------------------------- 写作用域清洗（3.3.0，会话 def6609d） ---
//
// 运行时 `agentTeams.createTask()` 的 `writeScope()` 规则（内联一份做断言，防止实现漂移）：
// `\` → `/`、去前导 `./` 与尾随 `/` 之后，不能以 `/` 开头、不能是盘符开头、
// 不能有空段 / `.` / `..` 段。
/**
 * 与运行时 `writeScope()` 对齐的校验（测试用）。
 *
 * @param {string} scope - 待校验值。
 * @returns {boolean} 是否合法。
 */
function isValidWriteScope(scope) {
  const normalized = String(scope).replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (normalized === '') return false;
  if (normalized.startsWith('/')) return false;
  if (/^[a-z]:/iu.test(normalized)) return false;
  return !normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

test('sanitizeWriteScopes：绝对路径一律丢弃（否则 createTask 抛 TEAM_INVALID_WRITE_SCOPE）', () => {
  // 会话 def6609d 的死锁根因：工单 scope 是 Windows 绝对路径，原样透传让投影失败。
  const scopes = [
    'E:\\repo\\tools\\x', // Windows 盘符 + 反斜杠
    'E:/repo/src', // Windows 盘符 + 正斜杠
    '/root/x', // POSIX 绝对路径
    '\\\\server\\share\\x', // UNC
    'src/app.js', // 合法相对路径
  ];
  assert.deepEqual(sanitizeWriteScopes(scopes), ['src/app.js']);
  for (const dropped of ['E:\\a\\b', 'E:/a/b', '/root/x', '\\\\server\\share\\x']) {
    assert.ok(!sanitizeWriteScopes([dropped]).includes(dropped), `绝对路径应被丢弃：${dropped}`);
  }
});

test('sanitizeWriteScopes：规范化相对路径（\\ → /、去 ./ 与尾随 /）', () => {
  assert.deepEqual(
    sanitizeWriteScopes(['src\\a.js', './docs/', 'a/b/']),
    ['src/a.js', 'docs', 'a/b'],
  );
  // 已经是规范形态的原样保留。
  assert.deepEqual(sanitizeWriteScopes(['src/login/**']), ['src/login/**']);
});

test('sanitizeWriteScopes：丢弃空段 / . / .. 段与空项', () => {
  const scopes = ['a/../b', 'a/./b', 'a//b', '', '   ', './', '..', '.', null, undefined];
  assert.deepEqual(sanitizeWriteScopes(scopes), []);
  // 混合输入里只留合法项。
  assert.deepEqual(sanitizeWriteScopes(['a/../b', 'ok/x', 'C:\\y']), ['ok/x']);
  // 非字符串项按 String() 宽容处理（scope 是 advisory 字段，写作用域只用于板上的重叠提示）：
  // 数字 42 会变成相对路径 '42'。若将来决定丢弃非字符串，这里会失败提醒同步改契约。
  assert.deepEqual(sanitizeWriteScopes([42, 'ok/x']), ['42', 'ok/x']);
});

test('sanitizeWriteScopes：去重保序，上限 40 条', () => {
  assert.deepEqual(sanitizeWriteScopes(['a', 'b', 'a', './b', 'c']), ['a', 'b', 'c']);
  const many = Array.from({ length: 50 }, (_, index) => `dir-${index}/x`);
  const capped = sanitizeWriteScopes(many);
  assert.equal(capped.length, 40, '默认上限 40');
  assert.deepEqual(capped, many.slice(0, 40), '截断保序');
  // limit 可覆盖；非法 limit 回退默认 40。
  assert.deepEqual(sanitizeWriteScopes(['a', 'b', 'c'], 2), ['a', 'b']);
  assert.equal(sanitizeWriteScopes(many, 0).length, 40);
  assert.equal(sanitizeWriteScopes(many, Number.NaN).length, 40);
});

test('sanitizeWriteScopes：非数组输入返回空数组（投影器对坏 scope 宽容）', () => {
  for (const value of [undefined, null, 'src/a', 42, {}, { get: () => ['a'] }]) {
    assert.deepEqual(sanitizeWriteScopes(value), []);
  }
});

test('projectContent：writeScopes 里每一项都能通过运行时 writeScope() 校验', () => {
  // 这是端到端的契约：清洗后的输出必须真的能被 agentTeams.createTask() 接受。
  const content = projectContent(ticket({
    scope: ['E:\\repo\\tools\\x', '/root/x', 'src\\app.js', './docs/', 'a/../b', 'src/app.js'],
  }));
  assert.deepEqual(content.writeScopes, ['src/app.js', 'docs']);
  for (const scope of content.writeScopes) {
    assert.ok(isValidWriteScope(scope), `writeScopes 里出现了运行时会拒绝的值：${scope}`);
  }
  // 工单本身仍保留完整 scope（清洗只影响任务板上的 advisory 字段）。
  const original = ticket({ scope: ['E:\\a\\b'] });
  projectContent(original);
  assert.deepEqual(original.scope, ['E:\\a\\b'], '不能改动工单记录');
});

test('isProjectedTask / projectedTicketId：只认第一行 marker', () => {
  const task = { description: '[commander:ticket=t-3]\n其余' };
  assert.equal(isProjectedTask(task), true);
  assert.equal(projectedTicketId(task), 't-3');
  assert.equal(isProjectedTask({ description: '正文里提到 [commander:ticket=t-3]' }), false);
  assert.equal(isProjectedTask({ description: '' }), false);
  assert.equal(isProjectedTask(null), false);
  assert.equal(projectedTicketId({ description: 'x' }), null);
});

test('mergeDescription：空描述 / 我们的模板 / 收养来的任务', () => {
  const content = projectContent(ticket({ id: 't-5' }));
  assert.equal(mergeDescription('', content, 't-5'), content.description);
  // 我们生成的模板（含验收判据节）→ 全量刷新
  assert.equal(mergeDescription(content.description, content, 't-5'), content.description);
  // 收养：marker 插到最前，正文保留
  const legacy = '按模型自己写的任务说明';
  const adopted = mergeDescription(legacy, content, 't-5');
  assert.ok(adopted.startsWith('[commander:ticket=t-5]\n[commander:channel=none]\n[commander:status=open]\n\n'));
  assert.match(adopted, /按模型自己写的任务说明/u);
  // 已收养的任务：只刷新 marker，正文保留
  const refreshed = mergeDescription(adopted, { ...content, status: 'review', channel: 'team' }, 't-5');
  assert.ok(refreshed.startsWith('[commander:ticket=t-5]\n[commander:channel=team]\n[commander:status=review]\n\n'));
  assert.match(refreshed, /按模型自己写的任务说明/u);
});

test('teamErrorCode：直接 code / cause 里的 code / 无 code', () => {
  assert.equal(teamErrorCode({ code: 'X' }), 'X');
  assert.equal(teamErrorCode({ cause: { code: 'Y' } }), 'Y');
  assert.equal(teamErrorCode(new Error('plain')), '');
  assert.equal(teamErrorCode(null), '');
});

// ---------------------------------------------------------------- 可用性 ---

test('available：服务缺失 / Team 未开启 / 方法缺失时全部 no-op', async () => {
  // 6.0.0（DSH 0.2.2-rc.2）：判据从 `tryMembership(agent)` 改成
  // `agentTeams.isEnabled(agent) === true` —— 成员就是标准 subagent，没有"成员名册"可查。
  const none = createTeamBoardBridge({ getService: () => undefined });
  assert.equal(none.available(AGENT), undefined);
  assert.equal(await none.createProjection(AGENT, ticket()), undefined);

  // Team 未开启（本模式强制开启，但服务可能属于别的部署/会话）。
  const disabled = { isEnabled: () => false, createTask: async () => ({}), getTask: () => ({}), listTasks: () => [], updateTask: async () => ({}) };
  assert.equal(createTeamBoardBridge({ getService: () => disabled }).available(AGENT), undefined);
  // `isEnabled` 返回非 true（undefined）也按"未开启"处理。
  const unknown = { ...disabled, isEnabled: () => undefined };
  assert.equal(createTeamBoardBridge({ getService: () => unknown }).available(AGENT), undefined);

  // 服务在但方法不全：不能半可用（缺 listTasks 会让"收养旧任务"静默失败）。
  const incomplete = { isEnabled: () => true };
  assert.equal(createTeamBoardBridge({ getService: () => incomplete }).available(AGENT), undefined);
});

// ---------------------------------------------------------------- 创建/收养 ---

test('createProjection：新建任务并返回 taskId', async () => {
  const service = makeService();
  const bridge = bridgeFor(service);
  const result = await bridge.createProjection(AGENT, ticket());
  assert.equal(result.taskId, 'task-100');
  const created = service.tasks.get('task-100');
  assert.equal(created.subject, '实现登录');
  assert.deepEqual(created.writeScopes, ['src/login/**']);
  assert.ok(created.description.startsWith('[commander:ticket=t-1]'));
});

test('createProjection：已有 teamTaskId 时复用，不重复建', async () => {
  const service = makeService([{ id: 'task-9', revision: 1, subject: '旧', description: '[commander:ticket=t-1]\n…', status: 'pending', writeScopes: [] }]);
  const bridge = bridgeFor(service);
  const result = await bridge.createProjection(AGENT, ticket({ teamTaskId: 'task-9' }));
  assert.equal(result.taskId, 'task-9');
  assert.equal(service.tasks.size, 1);
});

test('createProjection：收养模型自己建的旧任务（描述里提到工单）', async () => {
  const service = makeService([{
    id: 'task-3',
    revision: 1,
    subject: '模型自己建的任务',
    description: '按 [ticket:t-1] 实现登录',
    status: 'pending',
    writeScopes: [],
  }]);
  const bridge = bridgeFor(service);
  const result = await bridge.createProjection(AGENT, ticket());
  assert.equal(result.taskId, 'task-3');
  assert.equal(service.tasks.size, 1, '不能新建第二张');
  assert.ok(service.tasks.get('task-3').description.startsWith('[commander:ticket=t-1]'));
  assert.match(service.tasks.get('task-3').description, /按 \[ticket:t-1\] 实现登录/u);
});

test('createProjection：createTask 抛错 → 返回 undefined，不抛', async () => {
  const service = makeService();
  service.createTask = async () => {
    throw new Error('TEAM_TASK_LIMIT');
  };
  const bridge = bridgeFor(service);
  assert.equal(await bridge.createProjection(AGENT, ticket()), undefined);
});

test('投影失败记 warn（带 teamErrorCode），不再静默吞掉（会话 def6609d 根因之一）', async () => {
  // 旧实现只记 debug → 投影失败在日志里看不见，用户只看到"派发门禁拒绝 + 门禁自相矛盾"。
  // 3.3.0 起失败必须 warn，且带上运行时错误码（例如 TEAM_INVALID_WRITE_SCOPE）。
  const warnings = [];
  const debugs = [];
  const service = makeService();
  service.createTask = async () => {
    throw Object.assign(new Error('writeScopes 非法'), { code: 'TEAM_INVALID_WRITE_SCOPE' });
  };
  const bridge = createTeamBoardBridge({
    getService: (name) => (name === 'agentTeams' ? service : undefined),
    logger: { warn: (...args) => warnings.push(args), debug: (...args) => debugs.push(args) },
  });
  assert.equal(await bridge.createProjection(AGENT, ticket()), undefined, '失败仍要降级返回 undefined');
  assert.equal(warnings.length, 1, '失败必须记 warn');
  assert.match(String(warnings[0][0]), /共享任务板投影失败/u);
  assert.equal(warnings[0][2], 'TEAM_INVALID_WRITE_SCOPE', 'warn 里要带运行时错误码');
  assert.ok(warnings[0][1].includes('创建共享任务'), '要说明是哪个动作失败');
  // 失败路径不再走 debug（否则又会被当成"无害降级"忽略掉）。
  assert.equal(debugs.length, 0);
});

test('投影失败：没有 error.code 时 warn 里写 unknown（仍要可见）', async () => {
  const warnings = [];
  const service = makeService();
  service.createTask = async () => {
    throw new Error('网络错误');
  };
  const bridge = createTeamBoardBridge({
    getService: (name) => (name === 'agentTeams' ? service : undefined),
    logger: { warn: (...args) => warnings.push(args), debug: () => {} },
  });
  assert.equal(await bridge.createProjection(AGENT, ticket()), undefined);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][2], 'unknown');
});

// ---------------------------------------------------------------- 同步 ---

test('syncProjection：working → in_progress；描述同步为最新状态', async () => {
  const service = makeService([{
    id: 'task-1',
    revision: 1,
    subject: '实现登录',
    description: projectContent(ticket()).description,
    status: 'pending',
    writeScopes: ['src/login/**'],
  }]);
  const bridge = bridgeFor(service);
  const before = projectContent(ticket()).description;
  assert.ok(before.includes('[commander:status=open]'));
  const result = await bridge.syncProjection(AGENT, ticket({ teamTaskId: 'task-1', status: 'working', assignments: assignedTicket().assignments }));
  assert.equal(result.taskId, 'task-1');
  assert.ok(result.task.description.includes('[commander:status=working]'));
  assert.ok(result.task.description.includes('[commander:channel=team]'));
});

test('syncProjection：done → pending 任务先 claim 再 complete', async () => {
  const service = makeService([{
    id: 'task-2',
    revision: 1,
    subject: '实现登录',
    description: projectContent(ticket()).description,
    status: 'pending',
    writeScopes: [],
  }]);
  const bridge = bridgeFor(service);
  const result = await bridge.syncProjection(AGENT, ticket({ teamTaskId: 'task-2', status: 'done' }));
  assert.equal(result.task.status, 'completed');
  assert.deepEqual(service.calls.filter((call) => call.action === 'claim' || call.action === 'complete').map((call) => call.action), ['claim', 'complete']);
});

test('syncProjection：cancelled → delete', async () => {
  const service = makeService([{
    id: 'task-3',
    revision: 1,
    subject: 'x',
    description: projectContent(ticket()).description,
    status: 'in_progress',
    writeScopes: [],
  }]);
  const bridge = bridgeFor(service);
  const result = await bridge.syncProjection(AGENT, ticket({ teamTaskId: 'task-3', status: 'cancelled' }));
  assert.equal(result.task.status, 'deleted');
  assert.equal(service.calls.at(-1).action, 'delete');
});

test('syncProjection：非终态工单遇到 completed 任务 → reopen', async () => {
  const service = makeService([{
    id: 'task-4',
    revision: 1,
    subject: 'x',
    description: projectContent(ticket()).description,
    status: 'completed',
    writeScopes: [],
  }]);
  const bridge = bridgeFor(service);
  const result = await bridge.syncProjection(AGENT, ticket({ teamTaskId: 'task-4', status: 'working' }));
  assert.equal(result.task.status, 'pending');
  assert.ok(service.calls.some((call) => call.action === 'reopen'), '应有一次 reopen');
});

test('syncProjection：任务被删除且工单未结束 → 重建并返回新 taskId', async () => {
  const service = makeService();
  service.tasks.set('task-5', { id: 'task-5', revision: 1, subject: 'x', description: 'gone', status: 'deleted', writeScopes: [] });
  const bridge = bridgeFor(service);
  const result = await bridge.syncProjection(AGENT, ticket({ teamTaskId: 'task-5', status: 'open' }));
  assert.notEqual(result.taskId, 'task-5');
  assert.ok(result.task.description.startsWith('[commander:ticket=t-1]'));
});

test('syncProjection：终态工单 + 已删除任务 → 不重建（不复活）', async () => {
  const service = makeService();
  service.tasks.set('task-6', { id: 'task-6', revision: 1, subject: 'x', description: 'gone', status: 'deleted', writeScopes: [] });
  const bridge = bridgeFor(service);
  assert.equal(await bridge.syncProjection(AGENT, ticket({ teamTaskId: 'task-6', status: 'done' })), undefined);
  assert.equal(service.tasks.size, 1);
});

test('syncProjection：revision 冲突 → 重读重试一次后成功', async () => {
  const service = makeService([{
    id: 'task-7',
    revision: 1,
    subject: 'x',
    description: projectContent(ticket()).description,
    status: 'pending',
    writeScopes: [],
  }]);
  let sabotaged = false;
  const original = service.updateTask;
  service.updateTask = async (agent, request) => {
    if (!sabotaged && request.action !== 'create') {
      sabotaged = true;
      // 模拟别人先改了一次：revision 前进，第一次调用必然 stale。
      const current = service.tasks.get(request.taskId);
      service.tasks.set(request.taskId, { ...current, revision: current.revision + 1 });
    }
    return await original(agent, request);
  };
  const bridge = createTeamBoardBridge({ getService: () => service });
  const result = await bridge.syncProjection(AGENT, ticket({ teamTaskId: 'task-7', status: 'working' }));
  assert.ok(sabotaged);
  assert.ok(result !== undefined);
});

// ---------------------------------------------------------------- 绑定 ---

test('bindOwner：pending 任务 reassign 到队友', async () => {
  const service = makeService([{
    id: 'task-8',
    revision: 1,
    subject: 'x',
    description: projectContent(ticket()).description,
    status: 'pending',
    writeScopes: [],
  }]);
  const bridge = bridgeFor(service);
  const bound = await bridge.bindOwner(AGENT, ticket({ teamTaskId: 'task-8' }), 'reviewer');
  assert.equal(bound.ownerName, 'reviewer');
  assert.equal(bound.status, 'in_progress');
  assert.deepEqual(service.calls.at(-1), { action: 'reassign', taskId: 'task-8', owner: 'reviewer' });
});

test('bindOwner：没映射 / 任务已结束 / 无名字 → 跳过', async () => {
  const service = makeService([{
    id: 'task-9',
    revision: 1,
    subject: 'x',
    description: projectContent(ticket()).description,
    status: 'completed',
    writeScopes: [],
  }]);
  const bridge = bridgeFor(service);
  assert.equal(await bridge.bindOwner(AGENT, ticket({ teamTaskId: 'task-9' }), 'reviewer'), undefined);
  assert.equal(await bridge.bindOwner(AGENT, ticket({ teamTaskId: null }), 'reviewer'), undefined);
  assert.equal(await bridge.bindOwner(AGENT, ticket({ teamTaskId: 'task-9' }), ''), undefined);
  assert.equal(service.calls.length, 0);
});

test('bindOwner：服务抛错 → 返回 undefined，不抛', async () => {
  const service = makeService([{
    id: 'task-10',
    revision: 1,
    subject: 'x',
    description: projectContent(ticket()).description,
    status: 'pending',
    writeScopes: [],
  }]);
  service.updateTask = async () => {
    throw new Error('boom');
  };
  const bridge = bridgeFor(service);
  assert.equal(await bridge.bindOwner(AGENT, ticket({ teamTaskId: 'task-10' }), 'reviewer'), undefined);
});
