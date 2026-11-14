/**
 * 「结算门禁」的测试（`lib/guard.js` 的 `evaluateTicketSettle`，7.2.0 新增）。
 *
 * ## 这条门禁为什么存在
 *
 * 用户 2026-11-14 原话：「**如果小组长的子智能体没有完成任务，不能视作小组长完成任务**」。
 *
 * 现场（session-062eb97a）：`bm-model-lead`（逆向汇总小组长）报的是 `STATUS: progress`，
 * 并明确写了「两个子智能体**仍在运行**……它们回报后我会再补一次提交回填最终结果——这是本
 * 任务唯一未闭合项」。指挥者仍然把它的工单结算成 `done`，直到用户指出「没有完成啊，逆向
 * 汇总的小组长的子智能体还没有完成任务呢」才纠正。
 *
 * ## 这里钉的是什么
 *
 * 1. **只拦"结算完成"**：`status: "done"` 被拦；`cancelled` / `progress` / `ready` 等不拦
 *    （`cancelled` 是放弃，`progress` 本来就还在进行）。
 * 2. **只拦指挥官**：小组长结算自己的活不归这条管。
 * 3. **只认正面证据**：子树里真有 `running` 的下级才拦；读不到（无 ledger / 无 subagents /
 *    无 sessionId / 快照抛错 / 工单没派过小组长）**一律放行** —— 门禁不能卡住收尾。
 * 4. **子树匹配按路径前缀**：`<lead>` 本身与 `<lead>/<child>` 都算，`<lead-other>` 不算
 *    （否则 `bm-model-lead` 会误伤 `bm-model-lead-2`）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateTicketSettle } from '../lib/guard.js';
import { LEAD, TEAMMATE } from './helpers.mjs';

/** 判定为"拒绝"并返回理由。 */
function denyReason(decision) {
  assert.ok(decision !== undefined, '应当被拒绝，实际放行了');
  assert.equal(decision.kind, 'deny');
  assert.equal(typeof decision.reason, 'string');
  assert.ok(decision.reason.length > 0, '拒绝理由不能为空（它是给模型的纠正指令）');
  return decision.reason;
}

/** 断言放行（`undefined` = 放行）。 */
function allows(decision, label) {
  assert.equal(decision, undefined, `${label} 应当放行，实际被拒绝：${decision?.reason}`);
}

const SESSION = 'session-lead';

/**
 * 造一个最小 ledger：`getTicket(id, sessionId, { allowMissing })` 返回给定工单。
 *
 * @param {object | null} ticket - 工单记录（含 `assignments[].ref`）。
 * @returns {object} ledger 替身。
 */
function makeLedger(ticket) {
  return {
    getTicket: (id, sessionId) => (id === ticket?.id ? ticket : null),
  };
}

/**
 * 造一个最小 subagents 服务：`listDescendants` 返回给定行。
 *
 * @param {object[]} rows - 子树行（形状 `{ kind, id, path, activity, depth }`）。
 * @returns {object} subagents 替身。
 */
function makeSubagents(rows) {
  return { listDescendants: async () => rows };
}

/** 一个"派过小组长"的工单。 */
function ticketWithLead(id = 't-339', ref = 'bm-model-lead') {
  return {
    id,
    status: 'working',
    assignments: [{ id: 'a-1', channel: 'team', toolName: 'subagent', ref, startedAt: 1, endedAt: null }],
  };
}

/** 一个下级行。 */
function childRow(path, activity = 'inactive') {
  return { kind: 'child', id: `s-${path}`, path, activity, depth: path.includes('/') ? 2 : 1 };
}

// ------------------------------------------------------------ 拒绝场景 ---

test('7.2.0：小组长的子智能体还在跑 → 结算 done 被拒绝', async () => {
  // 这正是 session-062eb97a 的现场：`bm-model-lead/u3-field-diff` 仍在 running。
  const decision = await evaluateTicketSettle({
    agent: LEAD,
    name: 'commander_ticket_update',
    args: { ticket: 't-339', status: 'done' },
    ledger: makeLedger(ticketWithLead()),
    subagents: makeSubagents([
      childRow('bm-model-lead', 'inactive'),
      childRow('bm-model-lead/u3-field-diff', 'running'),
    ]),
    sessionId: SESSION,
  });
  const reason = denyReason(decision);
  // 理由必须点名"谁还在跑"（可核对），并给出纠正阶梯。
  assert.ok(reason.includes('bm-model-lead/u3-field-diff'), `理由应点名还在跑的下级：${reason}`);
  assert.ok(reason.includes('t-339'), '理由应点名工单');
  assert.ok(reason.includes('send_message'), '理由要给出下一步工具');
  assert.ok(reason.includes('STATUS: ready'), '理由要写清"让它报 ready"');
  assert.ok(reason.includes('不要重试'), '理由要明确不要重试本工具');
});

test('7.2.0：小组长自己还在跑（没有下级行）→ 也拒绝', async () => {
  // 它自己都没收手，当然不算完成。
  const decision = await evaluateTicketSettle({
    agent: LEAD,
    name: 'commander_ticket_update',
    args: { ticket: 't-339', status: 'done' },
    ledger: makeLedger(ticketWithLead()),
    subagents: makeSubagents([childRow('bm-model-lead', 'running')]),
    sessionId: SESSION,
  });
  denyReason(decision);
});

test('7.2.0：status 大小写不敏感（DONE 也要拦）', async () => {
  const decision = await evaluateTicketSettle({
    agent: LEAD,
    name: 'commander_ticket_update',
    args: { ticket: 't-339', status: 'DONE' },
    ledger: makeLedger(ticketWithLead()),
    subagents: makeSubagents([childRow('bm-model-lead/x', 'running')]),
    sessionId: SESSION,
  });
  denyReason(decision);
});

test('7.2.0：多个下级同时 running → 理由里最多列 4 个并给总数', async () => {
  const rows = [
    childRow('lead/a', 'running'),
    childRow('lead/b', 'running'),
    childRow('lead/c', 'running'),
    childRow('lead/d', 'running'),
    childRow('lead/e', 'running'),
    childRow('lead/f', 'running'),
  ];
  const decision = await evaluateTicketSettle({
    agent: LEAD,
    name: 'commander_ticket_update',
    args: { ticket: 't-339', status: 'done' },
    ledger: makeLedger(ticketWithLead('t-339', 'lead')),
    subagents: makeSubagents(rows),
    sessionId: SESSION,
  });
  const reason = denyReason(decision);
  assert.ok(reason.includes('等 6 个'), `应给出总数：${reason}`);
});

// ------------------------------------------------------------ 放行场景 ---

test('7.2.0：下级全部 inactive → 放行（可以结算）', async () => {
  const decision = await evaluateTicketSettle({
    agent: LEAD,
    name: 'commander_ticket_update',
    args: { ticket: 't-339', status: 'done' },
    ledger: makeLedger(ticketWithLead()),
    subagents: makeSubagents([
      childRow('bm-model-lead', 'inactive'),
      childRow('bm-model-lead/u3-field-diff', 'inactive'),
      childRow('bm-model-lead/ui-frame-u1u6', 'inactive'),
    ]),
    sessionId: SESSION,
  });
  allows(decision, '下级已全部收尾');
});

test('7.2.0：cancelled 是放弃，不拦', async () => {
  // 放弃不需要"下级做完"这个前提。
  for (const status of ['cancelled', 'progress', 'ready', 'blocked', 'failed', 'waiting']) {
    const decision = await evaluateTicketSettle({
      agent: LEAD,
      name: 'commander_ticket_update',
      args: { ticket: 't-339', status },
      ledger: makeLedger(ticketWithLead()),
      subagents: makeSubagents([childRow('bm-model-lead/x', 'running')]),
      sessionId: SESSION,
    });
    allows(decision, `status=${status} 不是结算完成`);
  }
});

test('7.2.0：小组长（子级）结算自己的活不归这条管', async () => {
  const decision = await evaluateTicketSettle({
    agent: TEAMMATE,
    name: 'commander_ticket_update',
    args: { ticket: 't-339', status: 'done' },
    ledger: makeLedger(ticketWithLead()),
    subagents: makeSubagents([childRow('bm-model-lead/x', 'running')]),
    sessionId: SESSION,
  });
  allows(decision, '子级调用');
});

test('7.2.0：路径前缀不能误伤（bm-model-lead 不该拦 bm-model-lead-2）', async () => {
  const decision = await evaluateTicketSettle({
    agent: LEAD,
    name: 'commander_ticket_update',
    args: { ticket: 't-339', status: 'done' },
    ledger: makeLedger(ticketWithLead('t-339', 'bm-model-lead')),
    subagents: makeSubagents([
      childRow('bm-model-lead', 'inactive'),
      // 另一个小组长的下级还在跑 —— 不是这张工单的人，不该拦。
      childRow('bm-model-lead-2/other', 'running'),
    ]),
    sessionId: SESSION,
  });
  allows(decision, '别的子树还在跑不影响这张工单');
});

// -------------------------------------------------------- 读不到 → 放行 ---

test('7.2.0：任何一处读不到都放行（门禁不能卡住收尾）', async () => {
  const base = {
    agent: LEAD,
    name: 'commander_ticket_update',
    args: { ticket: 't-339', status: 'done' },
    ledger: makeLedger(ticketWithLead()),
    subagents: makeSubagents([childRow('bm-model-lead/x', 'running')]),
    sessionId: SESSION,
  };

  allows(await evaluateTicketSettle({ ...base, ledger: undefined }), '没有 ledger');
  allows(await evaluateTicketSettle({ ...base, subagents: undefined }), '没有 subagents');
  allows(await evaluateTicketSettle({ ...base, sessionId: undefined }), '没有 sessionId');
  allows(await evaluateTicketSettle({ ...base, name: 'team_task_update' }), '别的工具');
  allows(
    await evaluateTicketSettle({ ...base, args: { ticket: 't-999', status: 'done' } }),
    '工单查不到',
  );
  allows(
    await evaluateTicketSettle({ ...base, args: { status: 'done' } }),
    '没给 ticket id',
  );
  // 工单存在但没派过小组长（比如用户直接让指挥者验收一个空工单）。
  allows(
    await evaluateTicketSettle({
      ...base,
      ledger: makeLedger({ id: 't-339', assignments: [] }),
    }),
    '工单没派过小组长',
  );
  // 快照抛错：按"读不到"处理。
  allows(
    await evaluateTicketSettle({
      ...base,
      subagents: { listDescendants: async () => { throw new Error('boom'); } },
    }),
    '子树读取抛错',
  );
  // ledger 抛错：同上。
  allows(
    await evaluateTicketSettle({
      ...base,
      ledger: { getTicket: () => { throw new Error('boom'); } },
    }),
    '账本读取抛错',
  );
  // 非对象行 / 非 child 行不能参与判定。
  allows(
    await evaluateTicketSettle({
      ...base,
      subagents: makeSubagents([
        null,
        'not-a-row',
        { kind: 'root', path: 'bm-model-lead', activity: 'running' },
        { kind: 'child', path: 'bm-model-lead', activity: 'running' },
      ].slice(0, 3)),
    }),
    '只有非 child 行',
  );
});

test('7.2.0：assignments 里的空 ref 被跳过（不会因为空串匹配到所有路径）', async () => {
  const decision = await evaluateTicketSettle({
    agent: LEAD,
    name: 'commander_ticket_update',
    args: { ticket: 't-339', status: 'done' },
    ledger: makeLedger({
      id: 't-339',
      assignments: [
        { id: 'a-1', ref: '' },
        { id: 'a-2', ref: '   ' },
        { id: 'a-3', ref: null },
      ],
    }),
    subagents: makeSubagents([childRow('anyone/x', 'running')]),
    sessionId: SESSION,
  });
  allows(decision, '没有有效 ref');
});
