#!/usr/bin/env node
/**
 * `commander-status` —— 指挥者账本的只读状态检查（0.9.0）。
 *
 * 用途：给"外部巡检"用（dsh 的 schedule / 系统任务计划 / CI cron）：
 *
 * ```text
 * node <plugin>/bin/commander-status.mjs --profile desktop
 * ```
 *
 * 退出码（与 Super-agent 的 status 脚本同思路，便于 schedule 按码决策）：
 * - 0：没有未结束工单（健康/空闲）
 * - 1：有未结束工单，但没有待人工项（在跑）
 * - 2：有待人工项（待验收 / 受阻 / 失败 / 等回答 / 停滞）——需要人
 * - 3：账本不可读（损坏 / 读失败 / schema 不支持）——需要人检查
 *
 * 只读：不写账本、不清理、不备份损坏文件（备份交给插件运行时）。
 *
 * @module dsh-commander-mode/bin/commander-status
 */

import { existsSync } from 'node:fs';

import { resolveLedgerFile } from '../lib/ledger.js';
import { loadLedgerFile } from '../lib/ledger.js';
import { attentionOf, isTerminal, ticketStage, ticketView } from '../lib/tickets.js';

/** 默认停滞阈值（与配置默认一致：10 分钟）。 */
const DEFAULT_STALL_MS = 10 * 60 * 1000;

/** 解析命令行。 */
function parseArgs(argv) {
  const options = { profile: undefined, ledger: undefined, stallMs: DEFAULT_STALL_MS, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--profile') options.profile = argv[(index += 1)];
    else if (arg === '--ledger') options.ledger = argv[(index += 1)];
    else if (arg === '--stall-ms') options.stallMs = Number(argv[(index += 1)]);
    else if (arg === '--stall-minutes') options.stallMs = Number(argv[(index += 1)]) * 60_000;
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length);
    else if (arg.startsWith('--ledger=')) options.ledger = arg.slice('--ledger='.length);
    else if (arg.startsWith('--stall-ms=')) options.stallMs = Number(arg.slice('--stall-ms='.length));
  }
  if (!Number.isFinite(options.stallMs) || options.stallMs < 60_000) options.stallMs = DEFAULT_STALL_MS;
  return options;
}

/** 帮助文本。 */
function helpText() {
  return [
    '用法：node bin/commander-status.mjs [--profile <name>] [--ledger <path>] [--stall-minutes <n>] [--json]',
    '',
    '退出码：0 空闲 / 1 有在跑工单 / 2 有待人工项 / 3 账本不可读',
    '默认账本：<DSH_HOME>/commander/<DSH_PROFILE>.json',
  ].join('\n');
}

/** 主流程。 */
function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return 0;
  }
  const file = typeof options.ledger === 'string' && options.ledger !== ''
    ? options.ledger
    : resolveLedgerFile({
      stateDir: '',
      env: {
        ...process.env,
        ...(options.profile === undefined ? {} : { DSH_PROFILE: options.profile }),
      },
    });
  if (!existsSync(file)) {
    const empty = { ledger: file, schema_version: null, open: 0, tickets: [], attention: [], note: '账本不存在（尚未使用指挥者模式）' };
    process.stdout.write(options.json ? `${JSON.stringify(empty, null, 2)}\n` : `commander-status: ${file} 不存在（空闲）\n`);
    return 0;
  }
  const loaded = loadLedgerFile({ file, backupCorrupt: false });
  if (typeof loaded.warning === 'string' && loaded.warning !== '') {
    const failed = { ledger: file, error: loaded.warning, open: null, tickets: [], attention: [] };
    process.stderr.write(options.json ? `${JSON.stringify(failed, null, 2)}\n` : `commander-status: 账本不可读：${loaded.warning}\n`);
    return 3;
  }
  const now = Date.now();
  const tickets = loaded.state.tickets;
  const open = tickets.filter((ticket) => !isTerminal(ticket));
  const attention = open
    .map((ticket) => ({ id: ticket.id, title: ticket.title, stage: ticketStage(ticket), ...(attentionOf(ticket, now, options.stallMs) ?? {}) }))
    .filter((item) => typeof item.code === 'string');
  const report = {
    ledger: file,
    schema_version: loaded.state.schemaVersion,
    open: open.length,
    concerns: attention.length,
    tickets: open.map((ticket) => ({
      id: ticket.id,
      title: ticket.title,
      stage: ticketStage(ticket),
      status: ticket.status,
      execution: ticket.execution === null ? null : ticket.execution.sessionId,
      last_report: ticket.lastReport === null ? null : { status: ticket.lastReport.status, at: ticket.lastReport.at },
      ...(attentionOf(ticket, now, options.stallMs) === undefined ? {} : { concern: attentionOf(ticket, now, options.stallMs) }),
    })),
    attention: attention.map((item) => ({ id: item.id, code: item.code, detail: item.detail })),
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const lines = [`commander-status: ${attention.length === 0 ? (open.length === 0 ? '空闲' : '在跑') : '需要人工处理'}（${file}）`];
    for (const ticket of report.tickets) {
      lines.push(`- ${ticket.id} [${ticket.stage}] ${ticket.title}${ticket.execution === null ? '' : `（${ticket.execution}）`}`);
    }
    for (const item of report.attention) lines.push(`⚠️ ${item.detail}`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  if (attention.length > 0) return 2;
  if (open.length > 0) return 1;
  return 0;
}

process.exitCode = main();
