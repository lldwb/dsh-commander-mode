/**
 * 外部事件纯函数（`lib/events.js`）的测试。
 *
 * 事件文件是**跨进程契约**（外部系统写、插件读），所以字段校验与渲染文本要钉住：
 * 坏了的事件不能让指挥者看到一句无法行动的噪声，也不能让队列卡死。
 */

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  EVENT_LIMITS,
  eventFileName,
  isSafeEventId,
  normalizeEvent,
  renderEventNotice,
  resolveEventDir,
} from '../lib/events.js';

/** 一条合法事件。 */
function valid(overrides = {}) {
  return {
    kind: 'ci-failed',
    summary: 'build #42 失败：test/auth 3 个用例',
    ticket: 't-3',
    ...overrides,
  };
}

test('resolveEventDir：默认在账本同级 events/，stateDir 三种写法都跟着账本走', () => {
  const env = { DSH_HOME: 'C:\\dsh-home', DSH_PROFILE: 'desktop' };
  assert.equal(resolveEventDir({ env }), join('C:\\dsh-home', 'commander', 'events'));
  // stateDir 是目录：<DSH_HOME>/<stateDir>/events
  assert.equal(resolveEventDir({ stateDir: 'my-state', env }), join('C:\\dsh-home', 'my-state', 'events'));
  // stateDir 是文件：dirname(file)/events
  const file = join('C:\\dsh-home', 'custom', 'ledger.json');
  assert.equal(resolveEventDir({ stateDir: file, env }), join(dirname(file), 'events'));
});

test('normalizeEvent：必填缺失直接判无效，并说明缺什么', () => {
  assert.deepEqual(normalizeEvent({ summary: 'x', ticket: 't-1' }).errors, ['kind 必填（事件类型，例如 ci-failed / issue-comment / alert）']);
  assert.deepEqual(normalizeEvent({ kind: 'ci', ticket: 't-1' }).errors, ['summary 必填（一句话说清发生了什么、要人/指挥者做什么）']);
  assert.deepEqual(normalizeEvent({ kind: 'ci', summary: 'x' }).errors, ['ticket 与 session 至少写一个（事件要投递给哪个指挥者会话）']);
  assert.deepEqual(normalizeEvent(null).errors, ['事件必须是 JSON 对象']);
  assert.deepEqual(normalizeEvent([1, 2]).errors, ['事件必须是 JSON 对象']);
});

test('normalizeEvent：清洗字段、补缺省 id/createdAt、截断超长字段', () => {
  const { event, errors } = normalizeEvent(valid({ detail: ' 细节 ', source: ' github-actions ', session: '' }), { now: 1793787000000 });
  assert.deepEqual(errors, []);
  assert.equal(event.version, 1);
  assert.equal(event.kind, 'ci-failed');
  assert.equal(event.summary, 'build #42 失败：test/auth 3 个用例');
  assert.equal(event.detail, '细节');
  assert.equal(event.source, 'github-actions');
  assert.equal(event.session, '');
  assert.equal(event.ticket, 't-3');
  assert.match(event.id, /^evt-1793787000000-/u);
  assert.equal(event.createdAt, 1793787000000);

  // 文件名兜底 id；显式 id 优先。
  assert.equal(normalizeEvent(valid(), { fallbackId: 'evt-1-ab', now: 1 }).event.id, 'evt-1-ab');
  assert.equal(normalizeEvent(valid({ id: ' mine ' }), { fallbackId: 'x' }).event.id, 'mine');

  // 超长截断。
  const long = normalizeEvent(valid({ summary: 's'.repeat(5000), kind: 'k'.repeat(200) }), { now: 1 }).event;
  assert.equal(long.summary.length, EVENT_LIMITS.summary);
  assert.equal(long.kind.length, EVENT_LIMITS.kind);
});

test('renderEventNotice：包含类型/摘要/工单/来源/事件 id 与"这不是用户消息"的边界', () => {
  const { event } = normalizeEvent(valid({
    detail: 'https://ci.example.com/builds/42',
    source: 'github-actions',
  }), { now: 1 });
  const text = renderEventNotice(event);
  for (const phrase of [
    '【指挥者·外部事件】ci-failed',
    'build #42 失败：test/auth 3 个用例',
    'https://ci.example.com/builds/42',
    '关联工单：t-3',
    '来源：github-actions',
    `事件 ID：${event.id}`,
    '这是外部系统推送的事件，不是用户消息',
    'ask_user_question',
  ]) {
    assert.ok(text.includes(phrase), `缺少：${phrase}`);
  }
});

test('eventFileName / isSafeEventId：文件名只接受安全字符（防路径穿越）', () => {
  assert.equal(isSafeEventId('evt-1-ab'), true);
  assert.equal(isSafeEventId('../../etc/passwd'), false);
  assert.equal(isSafeEventId('a/b'), false);
  assert.equal(isSafeEventId(''), false);
  assert.equal(eventFileName({ id: 'evt-1-ab' }), 'evt-1-ab.json');
  // 不安全 id 退化成时间戳文件，不会跳目录。
  assert.doesNotMatch(eventFileName({ id: '../evil' }), /evil/u);
});
