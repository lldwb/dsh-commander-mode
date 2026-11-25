/**
 * 重启后续做：识别「被停止但还没做完」的下级，并催指挥官**复用**它们而不是新开。
 *
 * ## 用户诉求（2026-11-25）
 *
 * 「如果重启后应该复用之前被停止的会话，而不是单独开。比如用户说电脑重启或者应用重启之类的话。」
 *
 * ## 为什么这件事必须由插件提醒，而不能只靠协议
 *
 * 宿主重启 / 崩溃时，正在跑的小组长与子智能体被 `dispose`：**会话还在磁盘上、Agent 没了**。
 * 指挥官下一次被唤醒时，上下文里没有任何「上一轮的人还在」的痕迹 —— 它看到的是一个空团队，
 * 于是很自然地 `subagent` 再建一批新小组长：同一份活被做两遍，旧会话的上下文（已经跑过的
 * 侦察、已经改到一半的文件）全丢。
 *
 * 协议能写"要复用"，但**模型看不见"有哪些可复用"**；所以这里把事实摆到它眼前：
 * 每轮运行时上下文里列出「离线但可续做的下级」，并给出确定的恢复通道。
 *
 * ## 关键判据：离线 ≠ 被中断
 *
 * 正常做完的子代理也会离线。所以这里**只报"离线 + 可续做"这个事实**，不替模型断定
 * "它就是被中断的那批"——判据交给 `session_resume_subagents`（它会给出每个子代理的任务状态
 * 与可恢复性），插件只负责把"你有 N 个离线下级"这件事说出来。
 *
 * ## 读法（异步 → 同步缓存）
 *
 * `subagents.listDescendants()` 是异步的，而 `systemPrompt.context` 的 text 是同步渲染。
 * 所以沿用 `agent.js` 里团队快照的同一套模式：异步刷新 + 同步读缓存（过期最多少报一轮）。
 *
 * @module dsh-commander-mode/lib/reboot-resume
 */

/**
 * 运行时上下文里这一段的标题（模型看到的小标题）。
 */
export const REBOOT_RESUME_TITLE = '## 重启后续做：先复用离线下级，别新开';

/**
 * 判断一条 `listDescendants()` 行是不是「可直接续做的直接子级」。
 *
 * rc.5 的 `listDescendants` 递归返回后代：`kind` 是 `child` / `diagnostic`，`depth` 从 1 起。
 * 只有 `kind === 'child'`（可续做的委派子代理）才有 `sendMessage` 冷恢复通道。
 *
 * @param {unknown} row - `listDescendants()` 的一行。
 * @returns {boolean} 是否直接可续做子级。
 */
export function isContinuableChild(row) {
  if (row === null || typeof row !== 'object') return false;
  if (row.kind !== 'child') return false;
  if (typeof row.depth === 'number' && row.depth !== 1) return false;
  // rc.5 的 `mode` 可能缺省；缺省时按可续做处理（宁可多报一条清单，也不要漏掉可复用的人）。
  if (typeof row.mode === 'string' && row.mode !== 'continuable') return false;
  return typeof row.id === 'string' && row.id !== '';
}

/**
 * 把 `listDescendants()` 的行分成「在线」与「离线」两堆。
 *
 * @param {unknown[]} rows - `listDescendants()` 的返回值。
 * @param {(id: string) => boolean} isLive - 判断某个子会话当前是否有活 Agent。
 * @returns {{ online: object[], offline: object[] }} 分组结果（行形状 `{ id, name }`）。
 */
export function splitChildren(rows, isLive) {
  const online = [];
  const offline = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isContinuableChild(row)) continue;
    const id = String(row.id);
    // `list_agents` 的名字是相对根的完整路径（`reviewer/checker`）；没有就退回会话 id。
    const name = typeof row.path === 'string' && row.path !== ''
      ? row.path
      : (typeof row.name === 'string' && row.name !== '' ? row.name : id);
    const item = { id, name };
    let live = false;
    try {
      live = isLive(id) === true;
    } catch {
      // 读不到就按离线处理：报出来最多让模型多看一眼，漏报才会导致"新开一批"。
      live = false;
    }
    if (live) online.push(item);
    else offline.push(item);
  }
  return { online, offline };
}

/**
 * 渲染「重启后续做」提示块。
 *
 * 没有离线子级时返回空串（不占 token、不制造噪音）。
 *
 * @param {object} input - 参数。
 * @param {{ id: string, name: string }[]} [input.offline] - 离线的可续做子级。
 * @param {{ id: string, name: string }[]} [input.online] - 在线的可续做子级。
 * @param {boolean} [input.resumeToolPresent] - 当前 agent 是否有 `session_resume_subagents`。
 * @returns {string} 上下文文本（可能为空串）。
 */
export function renderRebootResumeNotice({ offline = [], online = [], resumeToolPresent = true } = {}) {
  const off = (Array.isArray(offline) ? offline : []).filter(
    (item) => item !== null && typeof item === 'object' && typeof item.id === 'string' && item.id !== '',
  );
  if (off.length === 0) return '';

  const lines = [REBOOT_RESUME_TITLE, ''];
  lines.push(
    `你有 **${off.length} 个下级会话离线但仍在册**（Agent 不在了，会话与它的上下文都还在磁盘上）：`,
  );
  lines.push('');
  for (const item of off.slice(0, 8)) lines.push(`- \`${item.name}\`（\`${item.id}\`）`);
  if (off.length > 8) lines.push(`- …还有 ${off.length - 8} 个`);
  lines.push('');
  lines.push('**这类离线最常见的来源就是宿主重启 / 崩溃 / 长任务被打断。** 处置顺序：');
  lines.push('');
  if (resumeToolPresent) {
    lines.push('1. 先 `session_resume_subagents`（`dryRun: true` 先列清单，看每个下级的任务状态与可恢复性）；');
    lines.push('2. **只 resume 那些任务确实没做完的**，然后按它原有分工继续（它记得自己做到哪）；');
    lines.push('3. 确认没有可复用的（或 resume 失败）之后，才新建小组长；');
    lines.push('4. 新建时把「上一棒是谁、做到哪、产物在哪」写进任务书，别让它从零重做。');
  } else {
    lines.push('1. 用 `list_agents` 核对这些下级的名字与状态；本部署没有「恢复子代理」的工具，');
    lines.push('   所以**不要另开一批新小组长**做同一件事——先问用户是否要重开，或让用户恢复原会话；');
    lines.push('2. 需要新开时，把「上一棒是谁、做到哪、产物在哪」写进任务书，别让它从零重做。');
  }
  if (Array.isArray(online) && online.length > 0) {
    const live = online
      .filter((item) => item !== null && typeof item === 'object' && typeof item.id === 'string' && item.id !== '')
      .slice(0, 5);
    const names = live.map((item) => `\`${item.name}\``).join('、');
    lines.push('');
    lines.push(
      names === ''
        ? `（另有 ${online.length} 个下级当前在线，直接 send_message 继续即可。）`
        : `（另有 ${online.length} 个下级**在线**：${names} —— 直接 send_message 继续，不用恢复。）`,
    );
  }
  lines.push('');
  lines.push('> 已经**完成**并结算过的子代理也会离线——它们不需要 resume，别浪费一次恢复。');
  return lines.join('\n');
}

/**
 * 从 `listDescendants()` 快照里取出「可续做子级」的离线/在线分组（供缓存使用）。
 *
 * @param {unknown[]} rows - `listDescendants()` 的返回值。
 * @param {(id: string) => boolean} isLive - 判断活 Agent。
 * @returns {{ online: object[], offline: object[] }} 分组结果。
 */
export function snapshotChildren(rows, isLive) {
  return splitChildren(rows, isLive);
}
