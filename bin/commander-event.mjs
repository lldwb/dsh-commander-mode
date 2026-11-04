#!/usr/bin/env node
/**
 * `commander-event` —— 往指挥者的**外部事件**队列里写一条事件（1.1.0）。
 *
 * 用途：让 dsh 之外的世界（CI、告警、Issue 评论、定时巡检）能把事件推进指挥者会话。
 * 指挥者进程里的 `commander-mode` 配置行会轮询 `events/inbox/`，把事件 `steer` 给对应
 * 会话 —— 空闲的指挥者会被唤醒。**它只投递事件，不建工单、不派活。**
 *
 * ```powershell
 * node <插件目录>\bin\commander-event.mjs --profile desktop `
 *   --ticket t-3 --kind ci-failed --summary "build #42 失败：test/auth 3 个用例" `
 *   --detail "https://ci.example.com/builds/42" --source github-actions
 * ```
 *
 * 退出码：
 * - 0：已写入（`--id` 重复时也算成功，输出 `duplicate: true`）或 `--list` 成功；
 * - 2：用法错误（缺 kind/summary，或既没 ticket 也没 session）；
 * - 1：写文件失败（目录不可写等）。
 *
 * @module dsh-commander-mode/bin/commander-event
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { EVENT_INBOX_DIR, eventFileName, normalizeEvent, resolveEventDir } from '../lib/events.js';
import { readInbox } from '../lib/event-inbox.js';
import { resolveLedgerFile } from '../lib/ledger.js';

/** 解析命令行。支持 `--key value` 与 `--key=value`。 */
function parseArgs(argv) {
  const options = { json: false, list: false, help: false };
  const keys = new Set(['kind', 'summary', 'detail', 'source', 'ticket', 'session', 'id', 'profile', 'ledger', 'dir']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = (eq < 0 ? arg.slice(2) : arg.slice(2, eq)).trim();
      if (!keys.has(name)) {
        options.unknown = [...(options.unknown ?? []), name];
        continue;
      }
      if (eq >= 0) options[name] = arg.slice(eq + 1);
      else {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
          options[name] = '';
        } else {
          options[name] = value;
          index += 1;
        }
      }
    }
  }
  return options;
}

/** 帮助文本。 */
function helpText() {
  return [
    '用法：node bin/commander-event.mjs --kind <类型> --summary <一句话> (--ticket <t-N> | --session <id>)',
    '                                   [--detail <长文本>] [--source <来源>] [--id <事件 id>]',
    '                                   [--profile <p>] [--ledger <账本文件>] [--dir <事件目录>]',
    '                                   [--json] [--list]',
    '',
    '退出码：0 已写入/列出 / 2 用法错误 / 1 写盘失败',
    '默认事件目录：<账本所在目录>/events（空 stateDir 时 = <DSH_HOME>/commander/events）。',
  ].join('\n');
}

/** 事件目录解析。 */
function eventDirOf(options) {
  if (typeof options.dir === 'string' && options.dir.trim() !== '') return options.dir.trim();
  const ledgerFile = typeof options.ledger === 'string' && options.ledger.trim() !== ''
    ? options.ledger.trim()
    : resolveLedgerFile({
      stateDir: '',
      env: {
        ...process.env,
        ...(options.profile === undefined ? {} : { DSH_PROFILE: options.profile }),
      },
    });
  return join(dirname(ledgerFile), 'events');
}

/** `--list`：列出待投递事件。 */
function list(options, dir) {
  const { entries } = readInbox(dir, { limit: 200 });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ dir, count: entries.length, events: entries }, null, 2)}\n`);
    return 0;
  }
  if (entries.length === 0) {
    process.stdout.write(`commander-event: ${dir} 没有待投递事件\n`);
    return 0;
  }
  const lines = [`commander-event: ${dir} 有 ${entries.length} 条待投递事件`];
  for (const entry of entries) {
    if (entry.event === null) lines.push(`- ${entry.name} [无法解析] ${entry.errors.join('；')}`);
    else {
      lines.push(`- ${entry.event.id} [${entry.event.kind}] ${entry.event.summary}${entry.event.ticket === '' ? '' : `（工单 ${entry.event.ticket}）`}`);
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/** 写一条事件。 */
function publish(options, dir) {
  const { event, errors } = normalizeEvent(options, { now: Date.now() });
  if (event === null) {
    process.stderr.write(`commander-event: 事件无效：${errors.join('；')}\n`);
    return 2;
  }
  // `--id` 让外部系统可以重试同一条事件（至少一次投递 → 幂等写入）。
  const name = eventFileName(event);
  const inbox = join(dir, EVENT_INBOX_DIR);
  const target = join(inbox, name);
  if (existsSync(target)) {
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, duplicate: true, id: event.id, file: target })}\n`);
    else process.stdout.write(`commander-event: 事件 ${event.id} 已存在（重复写入，未覆盖）：${target}\n`);
    return 0;
  }
  mkdirSync(inbox, { recursive: true });
  const temporary = join(inbox, `.${name}.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(temporary, `${JSON.stringify(event, null, 2)}\n`, 'utf8');
  renameSync(temporary, target);
  if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, duplicate: false, id: event.id, file: target })}\n`);
  else process.stdout.write(`commander-event: 已写入事件 ${event.id} [${event.kind}] → ${target}\n`);
  return 0;
}

/** 主流程。 */
function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.unknown !== undefined && options.unknown.length > 0) {
    process.stderr.write(`commander-event: 未知参数 ${options.unknown.map((name) => `--${name}`).join(', ')}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  const dir = eventDirOf(options);
  try {
    if (options.list) return list(options, dir);
    return publish(options, dir);
  } catch (error) {
    process.stderr.write(`commander-event: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

process.exitCode = main();
