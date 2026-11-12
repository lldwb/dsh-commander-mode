/**
 * 工单状态机（`lib/tickets.js`）的测试。
 *
 * 这一层是 0.6.0 的"确定性内核"：所有状态迁移、授权判定、看板渲染都是纯函数。纯函数
 * 测试能钉住真实会话里最难复现的东西 —— 停滞、终态、计划变更后的旧工单、计划确认格式。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PLAN_CONFIRM_LABEL,
  PLAN_QUESTION_ID,
  TICKET_STATUS,
  applyReport,
  applyStatus,
  attentionOf,
  createTicketRecord,
  findPlanQuestion,
  isOpen,
  isPlanConfirmed,
  isStalled,
  isTerminal,
  needsPerson,
  parseReportStatus,
  planHash,
  recordAssignment,
  renderTicketBoard,
  settleAssignment,
  ticketStage,
  ticketView,
} from '../lib/tickets.js';

const AT = 1_700_000_000_000;

/** 一个刚建好的工单。 */
function ticket(overrides = {}) {
  return {
    ...createTicketRecord({ id: 't-1', sessionId: 's-1', title: '实现 X', at: AT }),
    ...overrides,
  };
}

// ---------------------------------------------------------------- 状态机 ---

test('新工单：open / queued / 非终态', () => {
  const row = ticket();
  assert.equal(row.status, TICKET_STATUS.OPEN);
  assert.equal(ticketStage(row), 'queued');
  assert.equal(isTerminal(row), false);
  assert.equal(isOpen(row), true);
  assert.equal(needsPerson(row), false);
});

test('Assignment 把工单推进到 working，并保留历史', () => {
  const row = recordAssignment(ticket(), { id: 'a-1', channel: 'specialist', toolName: 'subagent_implementer', at: AT + 1 });
  assert.equal(row.status, TICKET_STATUS.WORKING);
  assert.equal(row.assignments.length, 1);
  assert.equal(row.assignments[0].id, 'a-1');
  assert.equal(row.assignments[0].endedAt, null);
  // 原对象不被修改（纯函数）。
  assert.equal(ticket().assignments.length, 0);
});

test('六态回报映射到工单状态与阶段', () => {
  const cases = [
    ['progress', TICKET_STATUS.WORKING, 'working'],
    ['waiting', TICKET_STATUS.WAITING, 'idle'],
    ['ready', TICKET_STATUS.REVIEW, 'review'],
    ['blocked', TICKET_STATUS.BLOCKED, 'blocked'],
    ['failed', TICKET_STATUS.FAILED, 'failed'],
    ['dropped', TICKET_STATUS.CANCELLED, 'ended'],
  ];
  for (const [status, expectedStatus, expectedStage] of cases) {
    const row = applyReport(ticket(), { status, summary: 'x', at: AT + 2 });
    assert.equal(row.status, expectedStatus, status);
    assert.equal(ticketStage(row), expectedStage, status);
  }
});

test('未知回报状态抛可执行错误', () => {
  assert.throws(() => applyReport(ticket(), { status: 'done', at: AT }), /未知的回报状态/u);
});

test('ready 进入待验收；blocked/failed 需要人', () => {
  const review = applyReport(ticket(), { status: 'ready', summary: '做完了', at: AT });
  assert.equal(needsPerson(review), true);
  assert.equal(attentionOf(review, AT, 60_000).code, 'review');
  const blocked = applyReport(ticket(), { status: 'blocked', summary: '缺权限', at: AT });
  assert.equal(needsPerson(blocked), true);
  assert.match(attentionOf(blocked, AT, 60_000).detail, /缺权限/u);
  const failed = applyReport(ticket(), { status: 'failed', summary: '挂了', at: AT });
  assert.equal(attentionOf(failed, AT, 60_000).code, 'failed');
});

test('结构化 question 进入 attention（answer）', () => {
  const row = applyReport(ticket(), { status: 'blocked', summary: '等你选方案', question: '选 A 还是 B？', at: AT });
  const attention = attentionOf(row, AT, 60_000);
  assert.equal(attention.code, 'answer');
  assert.match(attention.detail, /选 A 还是 B/u);
});

test('手动状态：done/cancelled 进终态，不能更新成 working/open', () => {
  const done = applyStatus(ticket(), 'done', { at: AT + 5, reason: '验收通过' });
  assert.equal(done.status, TICKET_STATUS.DONE);
  assert.equal(done.endedAt, AT + 5);
  assert.equal(done.endReason, '验收通过');
  assert.equal(isTerminal(done), true);
  const cancelled = applyStatus(ticket(), 'cancelled', { at: AT + 6, reason: '不需要了' });
  assert.equal(cancelled.status, TICKET_STATUS.CANCELLED);
  assert.throws(() => applyStatus(ticket(), 'open', { at: AT }), /不能把工单更新为/u);
  assert.throws(() => applyStatus(ticket(), 'working', { at: AT }), /不能把工单更新为/u);
});

test('终态工单的后续回报不覆盖终态', () => {
  const done = applyStatus(ticket(), 'done', { at: AT });
  const after = applyReport(done, { status: 'ready', summary: 'late', at: AT + 1 });
  assert.equal(after.status, TICKET_STATUS.DONE);
});

// ---------------------------------------------------------------- 停滞 ---

test('停滞：派发后超过阈值且没有新回报', () => {
  const row = recordAssignment(ticket(), { id: 'a-1', channel: 'specialist', toolName: 'subagent_implementer', at: AT });
  assert.equal(isStalled(row, AT + 30 * 60_000, 10 * 60_000), true);
  assert.equal(isStalled(row, AT + 5 * 60_000, 10 * 60_000), false);
  assert.equal(attentionOf(row, AT + 30 * 60_000, 10 * 60_000).code, 'stalled');
});

test('有更新的回报就不算停滞；阈值非法时不算', () => {
  const row = recordAssignment(ticket(), { id: 'a-1', channel: 'specialist', toolName: 'x', at: AT });
  const reported = applyReport(row, { status: 'progress', summary: '在跑', at: AT + 20 * 60_000 });
  assert.equal(isStalled(reported, AT + 40 * 60_000, 10 * 60_000), false);
  assert.equal(isStalled(row, AT + 40 * 60_000, 0), false);
});

test('终态/等待/验收阶段不判停滞', () => {
  const done = applyStatus(ticket(), 'done', { at: AT });
  assert.equal(isStalled(done, AT + 60 * 60_000, 60_000), false);
  const review = applyReport(ticket(), { status: 'ready', summary: 'x', at: AT });
  assert.equal(isStalled(review, AT + 60 * 60_000, 60_000), false);
});

// ---------------------------------------------------------------- 授权 ---

test('findPlanQuestion 只认固定 id', () => {
  assert.equal(findPlanQuestion({ questions: [{ id: 'other' }, { id: PLAN_QUESTION_ID, question: '计划' }] }).question, '计划');
  assert.equal(findPlanQuestion({ questions: [{ id: 'other' }] }), undefined);
  assert.equal(findPlanQuestion(null), undefined);
});

test('计划确认必须精确选中「确认，开始执行」或自定义以"确认"开头', () => {
  const question = {
    id: PLAN_QUESTION_ID,
    question: '这个计划可以吗？',
    options: [{ label: PLAN_CONFIRM_LABEL }, { label: '需要调整' }],
  };
  const value = (selected, custom) => ({ answers: [{ id: PLAN_QUESTION_ID, selected, ...(custom === undefined ? {} : { custom }) }] });
  assert.equal(isPlanConfirmed(question, value([PLAN_CONFIRM_LABEL])).confirmed, true);
  assert.equal(isPlanConfirmed(question, value(['需要调整'])).confirmed, false);
  assert.equal(isPlanConfirmed(question, value([])).confirmed, false);
  assert.equal(isPlanConfirmed(question, value([], '确认，可以')).confirmed, true);
  assert.equal(isPlanConfirmed(question, value([], '先等等')).confirmed, false);
  assert.equal(isPlanConfirmed(question, { answers: [] }).confirmed, false);
  assert.equal(isPlanConfirmed(question, null).confirmed, false);
});

test('planHash 绑定用户看到的计划文本与选项；措辞不同哈希不同', () => {
  const a = planHash({ id: PLAN_QUESTION_ID, question: '计划 A', options: [{ label: PLAN_CONFIRM_LABEL }] });
  const b = planHash({ id: PLAN_QUESTION_ID, question: '计划 A', options: [{ label: PLAN_CONFIRM_LABEL }] });
  const c = planHash({ id: PLAN_QUESTION_ID, question: '计划 B', options: [{ label: PLAN_CONFIRM_LABEL }] });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/u);
});

// ---------------------------------------------------------------- 解析 ---

test('parseReportStatus 容忍常见格式，识别六态', () => {
  for (const status of ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']) {
    assert.equal(parseReportStatus(`做了些事\nSTATUS: ${status}\n验证：…`).status, status);
  }
  assert.equal(parseReportStatus('- STATUS: ready').status, 'ready');
  assert.equal(parseReportStatus('**STATUS:** blocked').status, 'blocked');
  assert.equal(parseReportStatus('status：ready').status, 'ready');
  assert.equal(parseReportStatus('STATUS: done'), undefined, 'done 不是六态');
  assert.equal(parseReportStatus('没有状态行'), undefined);
  assert.equal(parseReportStatus(''), undefined);
  assert.equal(parseReportStatus(null), undefined);
});

// ---------------------------------------------------------------- 看板 ---

test('看板：空工单且无授权时不产生噪声', () => {
  assert.equal(renderTicketBoard({ tickets: [], mandate: null, now: AT, stallMs: 60_000 }), '');
});

test('看板：未确认授权 + 进行中工单', () => {
  const row = recordAssignment(ticket(), { id: 'a-1', channel: 'specialist', toolName: 'x', at: AT });
  const text = renderTicketBoard({ tickets: [row], mandate: null, now: AT + 1000, stallMs: 10 * 60_000 });
  assert.match(text, /指挥者·工单看板/u);
  assert.match(text, /计划授权：\*\*未确认\*\*/u);
  assert.match(text, /工单 1 项进行中/u);
  assert.match(text, /t-1\[working\]/u);
});

test('看板：已确认授权显示摘要；待人工项带动作', () => {
  const review = applyReport(ticket(), { status: 'ready', summary: '实现完成', at: AT });
  const text = renderTicketBoard({
    tickets: [review],
    mandate: { id: 'm-1', planSummary: '实现 X 并补测试' },
    now: AT,
    stallMs: 10 * 60_000,
  });
  assert.match(text, /计划授权：已确认（实现 X 并补测试）/u);
  assert.match(text, /t-1\[review\]/u);
  assert.match(text, /commander_ticket_update/u);
});

test('看板最多列 maxItems 项，按需要人优先排序', () => {
  const rows = [];
  for (let index = 1; index <= 8; index += 1) {
    rows.push(recordAssignment(ticket({ id: `t-${index}`, title: `任务${index}` }), {
      id: `a-${index}`, channel: 'specialist', toolName: 'x', at: AT,
    }));
  }
  // 让 t-8 待验收（应排最前）。
  rows[7] = applyReport(rows[7], { status: 'ready', summary: 'ok', at: AT });
  const text = renderTicketBoard({ tickets: rows, mandate: { id: 'm-1', planSummary: 'p' }, now: AT, stallMs: 60_000, maxItems: 2 });
  const match = /工单 8 项进行中(?:（已结束 0 项）)?：(.+)。/u.exec(text);
  assert.ok(match, text);
  assert.match(match[1], /t-8\[review\]/u);
  assert.equal(match[1].split('、').length, 2);
});

test('ticketView 只输出可读字段与最近回报', () => {
  const row = settleAssignment(
    recordAssignment(ticket(), { id: 'a-1', channel: 'team', toolName: 'subagent', at: AT }),
    AT + 1,
    'teammate-1',
  );
  const view = ticketView(row);
  assert.equal(view.id, 't-1');
  assert.equal(view.stage, 'working');
  assert.equal(view.assignments[0].ref, 'teammate-1');
  assert.equal(view.last_report, null);
  assert.equal('intent' in view, false);
});

test('1.2.0：新工单的 teamTaskId 为 null，视图输出 team_task_id', () => {
  const record = createTicketRecord({ id: 't-9', sessionId: 's-1', title: '实现 X', at: AT });
  assert.equal(record.teamTaskId, null);
  assert.equal(ticketView(record).team_task_id, null);
  assert.equal(ticketView({ ...record, teamTaskId: 'task-3' }).team_task_id, 'task-3');
});

test('1.2.0：teamTaskId 不参与状态迁移（迁移后仍然保留）', () => {
  const row = applyStatus({ ...ticket(), teamTaskId: 'task-7' }, 'done', { at: AT + 10 });
  assert.equal(row.teamTaskId, 'task-7');
  assert.equal(ticketView(row).team_task_id, 'task-7');
});
