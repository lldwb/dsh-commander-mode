/**
 * **停滞看门狗**：空闲但有活时，主动把指挥官叫醒一次（7.16.0）。
 *
 * ## 为什么必须做这个（用户第 3 次报同一个问题）
 *
 * 到 7.15.0 为止，插件所有"防退化"能力都是**看板**——只在**回合运行时**渲染：
 *
 * ```
 * systemPrompt.context  → 只在有回合时下发
 * agent/turn-stopping   → 只在回合要结束时触发
 * ```
 *
 * 于是出现一个结构性死角：
 *
 * > **告警的可见性建立在"它正在运行"这个前提上，而"停下来"这件事恰恰是"它不运行"。**
 *
 * 实测 `session-1d8c8c60`（2026-11-17，重启后 582 个事件）：
 * - 13 个回合间隙、累计空闲 **134.2 分钟**；
 * - 唤醒源：**用户消息 3 次 / 下级通知 10 次 / 自己 0 次**；
 * - 最近一次：turn 162 结束（14:44:47）→ 空闲 **11 分钟** → 用户「进度如何了？」才继续。
 *
 * 且重启后 `长会话体检`、`dispatch-focus` **确实在报**（说明 7.10.0 已生效）——
 * 但 `all-idle-stalled` 报不报都没用：**检测不会唤醒任何东西**。
 *
 * ## 与"不要定期检查进度"的关系（用户 2026-11-15 的口径）
 *
 * 那条要求禁止的是 **agent 自己轮询**（"定期去检查进度"），不是禁止**插件**在
 * "没人干活但活还在"时投递一次唤醒。两者区别：
 *
 * | | agent 轮询 | 本看门狗 |
 * |---|---|---|
 * | 谁发起 | 指挥官自己反复查 | 插件检测到**停滞事实**后叫醒一次 |
 * | 触发条件 | 定时无条件 | 只有"无回合 + 无下级在跑 + 还有未结算工作 + 不在等用户"才触发 |
 * | 频率 | 每回合都查 | 每次停滞只叫一次（冷却期） |
 *
 * 它更像 CI 失败告警，而不是轮询。
 *
 * ## 三层防噪（都来自 7.11.0 那 98 次刷屏的教训）
 *
 * 1. **必须有活**：没有可推进的未结算工作就不叫（等用户的项不算）；
 * 2. **必须真停**：得有宽限期（默认 5 分钟）——刚结束回合的收尾不算停滞；
 * 3. **冷却**：同一会话一次停滞只叫一次（默认 20 分钟冷却），绝不每隔一分钟刷。
 *
 * @module dsh-commander-mode/lib/stall-watchdog
 */

/**
 * 空闲多久算"停滞"（默认 **90 秒**）。
 *
 * ## 为什么从 5 分钟改成 90 秒（2026-11-18 实测）
 *
 * 7.16.0 用 5 分钟宽限，结果：`session-1d8c8c60` 在 **04:08:12** 结算完最后一项后结束回合，
 * 空闲 **3 分 17 秒**时用户就发「继续推进」把它叫醒了（04:11:32）——**用户比看门狗先动**。
 * 也就是说宽限期一旦超过用户的容忍时间，看门狗就永远来不及。
 *
 * 90 秒的依据：回合结束后的"收尾"（写报告、落盘）在模型侧是**同一回合内**完成的，
 * 回合结束后 90 秒仍无人无活，就是真的停了。真在收尾的回合不会进入这个判定
 * （`turnRunning` 为真时直接返回）。
 */
export const STALL_GRACE_MS = 90 * 1000;

/**
 * 回合刚结束、**还有 open 工单却没人在跑**时，额外用这个更短的宽限（默认 15 秒）。
 *
 * 这是最强的停滞信号：它刚刚"确认没活了"并结束回合，但台账里明明还有未结算项，
 * 而且没有任何下级会回来叫它——**这种不该等**。
 */
export const STALL_GRACE_AFTER_TURN_MS = 15 * 1000;

/** 同一个会话两次唤醒之间的最小间隔（默认 20 分钟）：防止变成轮询。 */
export const STALL_COOLDOWN_MS = 20 * 60 * 1000;

/**
 * 判断"现在该不该叫醒它"（纯函数，便于测试）。
 *
 * @param {object} [input] - 判定输入。
 * @param {number} [input.now] - 当前时间戳。
 * @param {number} [input.lastActiveAt] - 最后一次"有动作"的时间（回合结束/开始都算）。
 * @param {boolean} [input.turnRunning] - 当前是否有回合在跑。
 * @param {number} [input.runningChildren] - 正在跑的下级数量。
 * @param {number} [input.openWork] - 可推进的未结算工作数（已排除等用户的）。
 * @param {boolean} [input.waitingOnUser] - 是否在等用户输入（等就不叫）。
 * @param {number} [input.lastWokeAt] - 上次被本看门狗唤醒的时间。
 * @param {boolean} [input.justEndedTurn] - 是否刚结束回合（用更短的宽限）。
 * @param {number} [input.graceMs] - 宽限期。
 * @param {number} [input.cooldownMs] - 冷却期。
 * @returns {{ wake: boolean, reason: string }} 判定结果。
 */
export function shouldWakeStall({
  now = Date.now(),
  lastActiveAt = 0,
  turnRunning = false,
  runningChildren = 0,
  openWork = 0,
  waitingOnUser = false,
  lastWokeAt = 0,
  justEndedTurn = false,
  graceMs = STALL_GRACE_MS,
  cooldownMs = STALL_COOLDOWN_MS,
} = {}) {
  try {
    if (turnRunning) return { wake: false, reason: 'turn-running' };
    if (waitingOnUser) return { wake: false, reason: 'waiting-on-user' };
    if (openWork <= 0) return { wake: false, reason: 'no-open-work' };
    // 还有下级在跑：它们结束时会走通知链（7.5.0 已补唤醒），不需要看门狗插嘴。
    if (runningChildren > 0) return { wake: false, reason: 'children-running' };
    if (!Number.isFinite(lastActiveAt) || lastActiveAt <= 0) return { wake: false, reason: 'unknown-activity' };
    const grace = justEndedTurn ? STALL_GRACE_AFTER_TURN_MS : graceMs;
    if (now - lastActiveAt < grace) return { wake: false, reason: 'within-grace' };
    if (Number.isFinite(lastWokeAt) && lastWokeAt > 0 && now - lastWokeAt < cooldownMs) {
      return { wake: false, reason: 'cooldown' };
    }
    return { wake: true, reason: 'stalled' };
  } catch {
    return { wake: false, reason: 'error' };
  }
}

/**
 * 生成唤醒文本（极短：它只需要知道"你停了，还有活"）。
 *
 * @param {object} [input] - 参数。
 * @param {number} [input.idleMinutes] - 空闲了多少分钟。
 * @param {number} [input.openWork] - 还有几项可推进的工作。
 * @returns {string} 唤醒文本。
 */
export function buildStallNotice({ idleMinutes = 0, openWork = 0 } = {}) {
  const idle = Number.isFinite(idleMinutes) ? Math.max(0, Math.round(idleMinutes)) : 0;
  const work = Number.isFinite(openWork) ? Math.max(0, Math.round(openWork)) : 0;
  return [
    `【停滞看门狗】你已经空闲 ${idle} 分钟，但看板上还有 ${work} 项可推进的未结算工作，`,
    '而且当前**没有下级在跑**——不会有完成通知来叫醒你。',
    '现在就推进：`send_message` 让空闲小组长续做，或 `subagent` 建人；能并行的就一次派 2-3 条。',
    '确实只能等外部输入（用户答复 / 第三方结果）才收尾的，在回复里写明"等什么、由谁解除"。',
    '不要只回一句"继续"就算处理——要有具体派发或明确阻塞项。',
  ].join('');
}
