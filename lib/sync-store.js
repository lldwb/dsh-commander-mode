/**
 * 同步账本的**持久化快照**（7.12.0）。
 *
 * ## 为什么需要它（实测事故）
 *
 * `session-1d8c8c60` 跑了 **52 小时 / 127 回合**，宿主中途重启过。而同步账本是
 * `agent.js` 里的 `const ledgers = new WeakMap()` + `createSyncLedger()` —— **纯内存**，
 * agent 一重建就全丢：
 *
 * - `plan` 归零 → 看板从 11-16 02:51 起**再也没有「计划清单」那一段**（前一天的
 *   「计划清单 2/8 已完成」是重启前写的）；
 * - `plan-stale` 因此**一次都没触发**（52 小时里 0 次），而按事实它应该从清单停更那一刻
 *   起一直响——**检测静默失效，没人发现**；
 * - `dispatchTargets`（7.10.0 的派活集中统计）同样归零 → "派活过度集中"重启后报不出来。
 *
 * 结论：**所有"防退化检测"都建立在"进程不重启"这个假设上，而长会话必然重启过。**
 *
 * ## 这份快照存什么 / 不存什么
 *
 * 存：**跨回合必须延续的判断依据**——`epoch` 单调序号、`plan`、任务板各任务的
 * `terminalEpoch`/`changedAt`、派活通道计数、`turns`、`dispatchTargets`、`staleNudged`。
 *
 * 不存：可以从别处重建的东西。成员快照（`listDescendants` 每次现读）、`recentDelegations`
 * 环形缓冲（只影响 channel-drift 的短期判据，丢了最多晚一轮才报）。
 *
 * ## 边界
 *
 * - **有界**：任务最多 `MAX_SNAPSHOT_TASKS` 条、派活目标最多 `MAX_SNAPSHOT_TARGETS` 个，
 *   防止长期会话把账本撑大；
 * - **容错**：任何字段非法就退回默认值，**绝不因为快照坏了让模式起不来**；
 * - **可比**：`schema` 不匹配就整份丢弃（宁可从零开始，也不要按错误语义继续判断）。
 *
 * @module dsh-commander-mode/lib/sync-store
 */

import { createSyncLedger } from './sync.js';

/** 快照格式版本：改字段语义时 +1，旧快照会被整份丢弃。 */
export const SNAPSHOT_SCHEMA = 1;

/** 快照里最多保留多少个任务（超出的按最近变化裁剪）。 */
export const MAX_SNAPSHOT_TASKS = 200;

/** 快照里最多保留多少个派活目标。 */
export const MAX_SNAPSHOT_TARGETS = 50;

/**
 * 把一个同步账本压成可持久化的纯 JSON 快照。
 *
 * @param {object} ledger - `createSyncLedger()` 的产物。
 * @returns {object} 快照（永远是合法 JSON）。
 */
export function toSnapshot(ledger) {
  const source = ledger !== null && typeof ledger === 'object' ? ledger : {};
  const tasks = source.tasks instanceof Map ? [...source.tasks.values()] : [];

  // 任务太多时只留"最近变化"的那些：`terminalEpoch`/`changedAt` 越大越新。
  const boundedTasks = tasks
    .filter((task) => task !== null && typeof task === 'object' && typeof task.id === 'string')
    .sort((a, b) => (Number(b.changedAt) || 0) - (Number(a.changedAt) || 0))
    .slice(0, MAX_SNAPSHOT_TASKS)
    .map((task) => ({
      id: task.id,
      status: typeof task.status === 'string' ? task.status : 'unknown',
      terminalEpoch: Number(task.terminalEpoch) || 0,
      changedAt: Number(task.changedAt) || 0,
      ownerName: typeof task.ownerName === 'string' ? task.ownerName : '',
      ready: task.ready !== false,
      ...(typeof task.ticketStatus === 'string' && task.ticketStatus !== '' ? { ticketStatus: task.ticketStatus } : {}),
    }));

  const targets = source.dispatchTargets !== null && typeof source.dispatchTargets === 'object'
    ? Object.entries(source.dispatchTargets)
      .filter(([, n]) => Number.isFinite(n) && n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SNAPSHOT_TARGETS)
    : [];

  const plan = source.plan !== null && typeof source.plan === 'object' && Array.isArray(source.plan.items)
    ? {
      total: Number(source.plan.total) || 0,
      openCount: Number(source.plan.openCount) || 0,
      epoch: Number(source.plan.epoch) || 0,
      items: source.plan.items
        .filter((item) => item !== null && typeof item === 'object' && typeof item.content === 'string')
        .slice(0, 200)
        .map((item) => ({ content: item.content.slice(0, 300), status: typeof item.status === 'string' ? item.status : 'pending' })),
    }
    : undefined;

  return {
    schema: SNAPSHOT_SCHEMA,
    savedAt: Date.now(),
    epoch: Number(source.epoch) || 0,
    terminalEpoch: Number(source.terminalEpoch) || 0,
    turns: Number(source.turns) || 0,
    staleNudged: source.staleNudged === true,
    plan,
    tasks: boundedTasks,
    dispatchTargets: Object.fromEntries(targets),
    delegations: {
      team: Number(source.delegations?.team) || 0,
      oneShot: Number(source.delegations?.oneShot) || 0,
    },
  };
}

/**
 * 把持久化的快照恢复到账本里（就地改写）。
 *
 * 任何非法/不匹配的部分都**静默跳过**——恢复失败最坏等于"回到今天之前的行为"
 * （从零开始统计），绝不能让模式起不来。
 *
 * @param {object} ledger - 目标账本（`createSyncLedger()` 的产物）。
 * @param {unknown} snapshot - `toSnapshot()` 存下来的东西（可能来自磁盘、可能已损坏）。
 * @returns {boolean} 是否真的恢复了内容。
 */
export function applySnapshot(ledger, snapshot) {
  try {
    if (ledger === null || typeof ledger !== 'object') return false;
    if (snapshot === null || typeof snapshot !== 'object') return false;
    if (Number(snapshot.schema) !== SNAPSHOT_SCHEMA) return false;

    const epoch = Number(snapshot.epoch) || 0;
    const terminalEpoch = Number(snapshot.terminalEpoch) || 0;
    ledger.epoch = Math.max(Number(ledger.epoch) || 0, epoch);
    ledger.terminalEpoch = Math.max(Number(ledger.terminalEpoch) || 0, terminalEpoch);
    ledger.turns = Math.max(Number(ledger.turns) || 0, Number(snapshot.turns) || 0);
    if (snapshot.staleNudged === true) ledger.staleNudged = true;

    // 计划清单：整份恢复（它是一份快照，不是累积计数）。
    if (snapshot.plan !== null && typeof snapshot.plan === 'object' && Array.isArray(snapshot.plan.items)) {
      const items = snapshot.plan.items
        .filter((item) => item !== null && typeof item === 'object' && typeof item.content === 'string')
        .map((item) => ({ content: item.content, status: typeof item.status === 'string' ? item.status : 'pending' }));
      ledger.plan = {
        items,
        total: items.length,
        openCount: items.filter((item) => item.status !== 'completed').length,
        epoch: Number(snapshot.plan.epoch) || ledger.epoch,
      };
    }

    // 任务板：Map 重建（这是 plan-stale 判断"谁先谁后"的依据，必须恢复）。
    if (Array.isArray(snapshot.tasks)) {
      const map = new Map();
      for (const task of snapshot.tasks) {
        if (task === null || typeof task !== 'object' || typeof task.id !== 'string') continue;
        map.set(task.id, {
          id: task.id,
          status: typeof task.status === 'string' ? task.status : 'unknown',
          subject: '',
          ownerName: typeof task.ownerName === 'string' ? task.ownerName : '',
          ready: task.ready !== false,
          blockedBy: [],
          ticketStatus: typeof task.ticketStatus === 'string' ? task.ticketStatus : '',
          terminalEpoch: Number(task.terminalEpoch) || 0,
          changedAt: Number(task.changedAt) || 0,
        });
      }
      if (map.size > 0) ledger.tasks = map;
    }

    // 派活分布：并集（磁盘上的 + 进程内的），取最大值，避免重启后归零。
    const targets = snapshot.dispatchTargets;
    if (targets !== null && typeof targets === 'object') {
      const merged = ledger.dispatchTargets !== null && typeof ledger.dispatchTargets === 'object'
        ? { ...ledger.dispatchTargets }
        : {};
      for (const [name, count] of Object.entries(targets)) {
        if (typeof name !== 'string' || name === '') continue;
        const n = Number(count);
        if (!Number.isFinite(n) || n <= 0) continue;
        merged[name] = Math.max(Number(merged[name]) || 0, n);
      }
      if (Object.keys(merged).length > 0) ledger.dispatchTargets = merged;
    }

    // 通道计数：取最大值（两边都在数同一件事）。
    if (snapshot.delegations !== null && typeof snapshot.delegations === 'object') {
      const team = Number(snapshot.delegations.team) || 0;
      const oneShot = Number(snapshot.delegations.oneShot) || 0;
      if (ledger.delegations === undefined) ledger.delegations = { team: 0, oneShot: 0 };
      ledger.delegations.team = Math.max(Number(ledger.delegations.team) || 0, team);
      ledger.delegations.oneShot = Math.max(Number(ledger.delegations.oneShot) || 0, oneShot);
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * 新建一个已恢复快照的同步账本（给 `agent.js` 用）。
 *
 * @param {unknown} snapshot - 持久化快照（可为 `undefined`）。
 * @returns {object} 账本。
 */
export function createRestoredLedger(snapshot) {
  const ledger = createSyncLedger();
  applySnapshot(ledger, snapshot);
  return ledger;
}
