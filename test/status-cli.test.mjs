/**
 * `bin/commander-status.mjs` 的测试。
 *
 * 巡检脚本是"外部监护"的入口，退出码就是协议：0 空闲 / 1 在跑 / 2 需要人 / 3 账本不可读。
 * 这里用真实子进程跑脚本，钉住输出 JSON 与退出码；并验证**只读**（不备份损坏文件）。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { CommanderLedger } from '../lib/ledger-service.js';
import { emptyLedger } from '../lib/ledger.js';

const execFileAsync = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'commander-status.mjs');

/** 建临时目录。 */
function tempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'commander-status-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** 跑脚本，返回 `{code, stdout, stderr}`（非零退出不抛）。 */
async function run(...args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args], { windowsHide: true });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** 建一个带内容的账本文件。 */
async function ledgerFile(directory, build) {
  const file = join(directory, 'ledger.json');
  const ledger = new CommanderLedger({ file });
  ledger.load();
  build(ledger);
  return file;
}

test('空账本/不存在：退出 0（空闲）', async (t) => {
  const directory = tempDir(t);
  const missing = await run('--ledger', join(directory, 'nope.json'), '--json');
  assert.equal(missing.code, 0);
  assert.equal(JSON.parse(missing.stdout).open, 0);

  const file = join(directory, 'empty.json');
  writeFileSync(file, `${JSON.stringify(emptyLedger(), null, 2)}\n`);
  const result = await run('--ledger', file, '--json');
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).open, 0);
});

test('在跑（working）但无待人工项：退出 1', async (t) => {
  const directory = tempDir(t);
  const file = await ledgerFile(directory, (ledger) => {
    ledger.recordMandate({ sessionId: 's-1', planHash: 'h', planSummary: 'p' });
    const ticket = ledger.createTicket({ sessionId: 's-1', title: '实现 X' });
    ledger.recordAssignment(ticket.id, 's-1', { channel: 'specialist', toolName: 'subagent_implementer' });
  });
  const result = await run('--ledger', file, '--json');
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.open, 1);
  assert.equal(report.tickets[0].stage, 'working');
  assert.equal(report.attention.length, 0);
});

test('待验收 / 等回答 / 停滞：退出 2 并列出 attention', async (t) => {
  const directory = tempDir(t);
  const file = await ledgerFile(directory, (ledger) => {
    ledger.recordMandate({ sessionId: 's-1', planHash: 'h', planSummary: 'p' });
    const review = ledger.createTicket({ sessionId: 's-1', title: '待验收' });
    ledger.recordReport(review.id, 's-1', { status: 'ready', summary: '完成' });
    const blocked = ledger.createTicket({ sessionId: 's-1', title: '受阻' });
    ledger.recordReport(blocked.id, 's-1', { status: 'blocked', summary: '缺权限', question: '要不要改配置？' });
  });
  const result = await run('--ledger', file, '--json');
  assert.equal(result.code, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.concerns, 2);
  assert.ok(report.attention.some((item) => item.code === 'review'));
  assert.ok(report.attention.some((item) => item.code === 'answer'));
});

test('损坏账本：退出 3，且只读巡检不备份文件', async (t) => {
  const directory = tempDir(t);
  const file = join(directory, 'ledger.json');
  writeFileSync(file, '{ broken json', 'utf8');
  const result = await run('--ledger', file, '--json');
  assert.equal(result.code, 3);
  assert.match(result.stderr, /损坏|不可读/u);
  const names = readdirSync(directory);
  assert.deepEqual(names, ['ledger.json'], '巡检不应产生 .corrupt 备份');
  assert.equal(readdirSync(directory).filter((name) => name.includes('corrupt')).length, 0);
});

test('人类可读输出包含工单与 attention 行', async (t) => {
  const directory = tempDir(t);
  const file = await ledgerFile(directory, (ledger) => {
    ledger.createTicket({ sessionId: 's-1', title: '一个任务' });
  });
  const result = await run('--ledger', file);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /在跑/u);
  assert.match(result.stdout, /t-1 \[/u);
  assert.match(result.stdout, /一个任务/u);
});

test('1.1.0 外部事件：报告 events_pending 但不改退出码（待投递不是"待人工项"）', async (t) => {
  const directory = tempDir(t);
  const file = await ledgerFile(directory, (ledger) => {
    ledger.createTicket({ sessionId: 's-1', title: '在跑' });
  });
  // 事件目录 = 账本同级 events/inbox（1.1.0 契约）。
  const inbox = join(directory, 'events', 'inbox');
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, 'evt-1.json'), JSON.stringify({ kind: 'ci', summary: 'x', ticket: 't-1' }), 'utf8');
  writeFileSync(join(inbox, 'evt-2.json'), JSON.stringify({ kind: 'ci', summary: 'y', session: 's-1' }), 'utf8');

  const json = await run('--ledger', file, '--json');
  assert.equal(json.code, 1, '待投递事件不算待人工项，退出码保持"在跑"');
  assert.equal(JSON.parse(json.stdout).events_pending, 2);

  const human = await run('--ledger', file);
  assert.equal(human.code, 1);
  assert.match(human.stdout, /外部事件：2 条待投递/u);
});

test('--help：退出 0 并给出退出码说明', async () => {
  const result = await run('--help');
  assert.equal(result.code, 0);
  assert.match(result.stdout, /0 空闲 \/ 1 有在跑工单 \/ 2 有待人工项 \/ 3 账本不可读/u);
});