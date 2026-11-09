/**
 * 执行边界的覆盖面测试（2.2.0）。
 *
 * ## 为什么要有这一组
 *
 * 历史事故 session-a0c0b646（2026-11-09）：指挥者模式下本地 `write` / `edit` / `pwsh`
 * 都是 0 次（确实派出去了），但它**自己**跑了 51 次 `ssh_exec`、2 次 `ssh_upload`、
 * 1 次 `ssh_job`，在远程 PC 上 dir/ver/powershell 一路操作。用户看到的就是"指挥者亲力亲为"。
 *
 * 根因：`blockedTools` 只列了本地六个工具，而判据本该是"会不会改变工作区 / 宿主 /
 * 外部系统的状态"——远程执行、桌面注入、浏览器改动、模拟器控制、持久终端与 `pwsh` 同类。
 *
 * 这一组锁两件事：① 这些执行类工具默认全拦；② 各插件的**只读半边**仍然放行
 * （只读侦察是指挥者的本职，拦了就等于把人堵在原地）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_BLOCKED_TOOLS,
  evaluatePreExecute,
} from '../lib/guard.js';

/** 默认拦截清单里必须有的执行类工具（按插件分组）。 */
const EXECUTION_TOOLS = [
  // 本地
  'write', 'edit', 'pwsh', 'bash', 'job_kill', 'plugin_manager',
  // 远程执行
  'ssh_exec', 'ssh_job', 'ssh_upload', 'ssh_download', 'ssh_fetch',
  // 桌面注入
  'desktop_mouse_click', 'desktop_mouse_drag', 'desktop_key_press', 'desktop_type_text',
  'desktop_ui_invoke', 'desktop_ui_set_value', 'desktop_window_focus',
  // 浏览器改动
  'browser_navigate', 'browser_click', 'browser_type', 'browser_fill', 'browser_evaluate',
  'browser_upload_file', 'browser_handle_dialog',
  // 模拟器控制
  'android_emulator_start', 'android_apk_install', 'android_app_launch', 'android_ui_tap',
  'android_ui_input',
  // 持久终端
  'terminal_open', 'terminal_send', 'terminal_signal', 'terminal_close',
  // 仓库状态
  'create_worktree',
];

/** 各执行类插件的只读半边：必须放行。 */
const READONLY_TOOLS = [
  'read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch', 'skill',
  'session_search', 'session_event_search',
  'ssh_host', 'job_output', 'job_list',
  'desktop_screenshot', 'desktop_screen_info', 'desktop_ui_dump', 'desktop_windows_list',
  'browser_status', 'browser_snapshot', 'browser_screenshot', 'browser_console',
  'browser_network', 'browser_list_pages', 'browser_ping', 'browser_wait_for',
  'android_status', 'android_screenshot', 'android_ui_dump', 'android_logcat', 'android_ui_wait',
  'terminal_read', 'terminal_list',
  'todo_write', 'ask_user_question', 'present',
  'spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
];

test('执行类工具默认全拦：远程执行 / 桌面注入 / 浏览器改动 / 模拟器 / 终端 / worktree', () => {
  for (const name of EXECUTION_TOOLS) {
    assert.ok(DEFAULT_BLOCKED_TOOLS.includes(name), `默认拦截清单缺少 ${name}`);
  }
});

test('只读半边与调度工具默认放行（拦了等于把人堵在原地）', () => {
  for (const name of READONLY_TOOLS) {
    assert.ok(!DEFAULT_BLOCKED_TOOLS.includes(name), `${name} 是只读/调度工具，不该被拦`);
  }
});

test('指挥者自己调用执行类工具被拒，且拒因点名"远程/桌面/浏览器/模拟器/终端"', () => {
  // 根 agent 的 session.header 里**没有** parentSession / origin=subagent / delegationDepth>0，
  // 否则 isDelegatedAgent 会把它当成子代理（门禁对子代理一律放行，这是刻意的 fail-open）。
  const lead = { session: { header: {} }, ctx: { tools: { schemas: () => [{ name: 'read' }, { name: 'spawn_teammate' }] } } };
  for (const name of ['ssh_exec', 'desktop_mouse_click', 'browser_navigate', 'android_ui_tap', 'terminal_send', 'create_worktree']) {
    const decision = evaluatePreExecute({ agent: lead, name, availableTools: ['read', 'spawn_teammate'], canDelegate: true });
    assert.equal(decision?.kind, 'deny', `${name} 应当被拒`);
    for (const phrase of ['远程执行', '桌面注入', '浏览器操作', '模拟器控制', '持久终端']) {
      assert.ok(decision.reason.includes(phrase), `拒因缺少「${phrase}」：${decision.reason.slice(0, 120)}`);
    }
  }
});

test('只读半边即使被列进清单也走"子代理/无派发通道"的放行分支（边界不变）', () => {
  // 只是确认 evaluatePreExecute 的既有语义没被这次扩展改变：非清单工具一律放行。
  const lead = { session: { header: {} }, ctx: { tools: { schemas: () => [{ name: 'spawn_teammate' }] } } };
  for (const name of ['browser_snapshot', 'desktop_ui_dump', 'android_logcat', 'terminal_read', 'ssh_host']) {
    assert.equal(evaluatePreExecute({ agent: lead, name, availableTools: ['spawn_teammate'], canDelegate: true }), undefined);
  }
});
