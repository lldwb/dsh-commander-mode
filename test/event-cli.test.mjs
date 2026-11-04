/**
 * `bin/commander-event.mjs` 的测试。
 *
 * 这是外部系统与指挥者之间的**跨进程契约**：参数、退出码、写入的文件格式、`--id` 幂等、
 * `--list` 输出都要钉住。用真实子进程跑脚本，和外部 CI 调用它的方式一致。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { normalizeEvent } from '../lib/events.js';

const execFileAsync = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'commander-event.mjs');

/** 临时目录。 */
function tempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'commander-event-cli-'));
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

test('发布事件：退出 0、写入 inbox/<id>.json，内容符合契约', async (t) => {
  const dir = tempDir(t);
  const result = await run(
    '--dir', dir,
    '--id', 'evt-test-1',
    '--ticket', 't-3',
    '--kind', 'ci-failed',
    '--summary', 'build #42 失败',
    '--detail', 'https://ci/42',
    '--source', 'github-actions',
    '--json',
  );
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.duplicate, false);
  assert.equal(output.id, 'evt-test-1');
  assert.equal(existsSync(join(dir, 'inbox', 'evt-test-1.json')), true);

  const stored = JSON.parse(readFileSync(join(dir, 'inbox', 'evt-test-1.json'), 'utf8'));
  const normalized = normalizeEvent(stored, { fallbackId: 'evt-test-1' });
  assert.deepEqual(normalized.errors, []);
  assert.equal(normalized.event.kind, 'ci-failed');
  assert.equal(normalized.event.summary, 'build #42 失败');
  assert.equal(normalized.event.detail, 'https://ci/42');
  assert.equal(normalized.event.source, 'github-actions');
  assert.equal(normalized.event.ticket, 't-3');
});

test('--session 也可作为路由；人类可读输出包含 id 与路径', async (t) => {
  const dir = tempDir(t);
  const result = await run('--dir', dir, '--session', 'session-1', '--kind', 'alert', '--summary', '磁盘 90%');
  assert.equal(result.code, 0);
  assert.match(result.stdout, /已写入事件/u);
  assert.match(result.stdout, /alert/u);
  assert.equal(readdirSync(join(dir, 'inbox')).filter((name) => name.endsWith('.json')).length, 1);
});

test('--id 幂等：同一 id 重复写入返回 duplicate 且不覆盖', async (t) => {
  const dir = tempDir(t);
  const first = await run('--dir', dir, '--id', 'evt-same', '--ticket', 't-1', '--kind', 'ci', '--summary', '第一次', '--json');
  assert.equal(first.code, 0);
  const second = await run('--dir', dir, '--id', 'evt-same', '--ticket', 't-1', '--kind', 'ci', '--summary', '第二次', '--json');
  assert.equal(second.code, 0);
  const output = JSON.parse(second.stdout);
  assert.equal(output.duplicate, true);
  const stored = JSON.parse(readFileSync(join(dir, 'inbox', 'evt-same.json'), 'utf8'));
  assert.equal(stored.summary, '第一次', '重复写入不应覆盖');
});

test('--list：列出待投递事件；空目录也能正常退出', async (t) => {
  const dir = tempDir(t);
  const empty = await run('--dir', dir, '--list');
  assert.equal(empty.code, 0);
  assert.match(empty.stdout, /没有待投递事件/u);

  await run('--dir', dir, '--id', 'evt-list', '--ticket', 't-2', '--kind', 'issue', '--summary', '新评论');
  const listed = await run('--dir', dir, '--list', '--json');
  assert.equal(listed.code, 0);
  const output = JSON.parse(listed.stdout);
  assert.equal(output.count, 1);
  assert.equal(output.events[0].event.id, 'evt-list');
  assert.equal(output.events[0].event.kind, 'issue');
});

test('用法错误：缺 kind/summary、缺路由、未知参数 → 退出 2', async (t) => {
  const dir = tempDir(t);
  const missingKind = await run('--dir', dir, '--ticket', 't-1', '--summary', 'x');
  assert.equal(missingKind.code, 2);
  assert.match(missingKind.stderr, /kind 必填/u);

  const missingRoute = await run('--dir', dir, '--kind', 'ci', '--summary', 'x');
  assert.equal(missingRoute.code, 2);
  assert.match(missingRoute.stderr, /ticket 与 session 至少写一个/u);

  const unknown = await run('--dir', dir, '--nope', 'x');
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /未知参数/u);
});

test('--help：退出 0 并给出退出码说明', async () => {
  const result = await run('--help');
  assert.equal(result.code, 0);
  assert.match(result.stdout, /0 已写入\/列出 \/ 2 用法错误 \/ 1 写盘失败/u);
});
