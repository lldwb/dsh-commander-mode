/**
 * **退化输出看门狗**：模型陷入重复循环时，在生成中途掐断（7.22.0）。
 *
 * ## 现场（`94f76704` = 子智能体 `docs-checklist-spec`，2026-11-19）
 *
 * 它在 step 12 **单次输出 322,334 字**、`Emit` 出现 **5602 次** / `OK` **5115 次**，
 * **没有任何工具调用**，持续 **11 分钟**，最后被 `max-tokens` 硬截断
 * （回合结束原因 `{"kind":"max-tokens"}`）。
 *
 * 重复开始于第 64,306 字符，退化前是**自我催促**：
 *
 * ```
 * Then write. Then verify. Then answer. Go. … Produce tool call. Then write. …
 * I'll now emit the tool call. Then write. …
 * ```
 *
 * 即：**它在"决定调用工具"这一步陷入了自我循环**（agentic loop stall），
 * 而每次循环都占着输出 token —— 这是纯粹的浪费，且会烧掉整个回合的预算。
 *
 * ## 为什么能掐断（读运行时源码确证）
 *
 * `@deepseek-ai/dsh-agent-loop` 的流式循环：
 *
 * ```js
 * for await (const chunk of stream) {
 *   signal.throwIfAborted();   // ← 每个 chunk 都检查
 *   live.push(chunk);
 * }
 * ```
 *
 * 而 `agent/request` 是个 **waterfall**，payload 带 `{ agent, turn, step, signal }`
 * （`dsh-compaction-basic` 正是这么用的）。所以：**拿到 signal → abort() →
 * 运行时在下一个 chunk 处抛 aborted**，这一回合以中断收场，不再继续烧 token。
 *
 * ## 判据（不依赖 frame 的具体结构）
 *
 * 流式 frame 的形状由运行时定义、可能变化，所以这里**不解析字段名**：
 * 递归收集 frame 里所有字符串，累积成尾部窗口，然后检测
 * **「某个 ≤40 字符的片段在尾部窗口里重复 ≥N 次」**。
 *
 * 实测依据：该会话的退化正是「`Emit.` / `Now.` / `OK.` 三个短句无限重复」，
 * 以及「`Then write. Then verify. Then answer.` 反复出现」——都会被这条判据命中；
 * 而正常的代码/文档输出不会在 2000 字符内把同一短句重复 20 次。
 *
 * @module dsh-commander-mode/lib/degeneration-guard
 */

/** 尾部窗口大小（字符）：只看最近这么多文本判断重复。 */
export const DEGENERATION_WINDOW = 2000;

/** 片段最长多少个字符（短句级重复；太长的重复可能是正常代码块）。 */
export const DEGENERATION_PATTERN_MAX = 40;

/**
 * 片段最短多少个字符。
 *
 * ⚠️ 第一版从 2 开始，结果正常代码里的 `"pu"` / `"on"` 被判成退化——
 * **短片段在正常文本里天然高频**。8 个字符以上才配叫"重复单元"。
 */
export const DEGENERATION_PATTERN_MIN = 8;

/** 同一片段**连续**重复多少次判定为退化。 */
export const DEGENERATION_REPEAT_MIN = 20;

/**
 * 长周期重复检测时搜到的最大周期（7.22.0）。
 *
 * 实测现场有一段 **66 字符周期**的自我催促，超过 `DEGENERATION_PATTERN_MAX`，
 * 按短单元抓不到；直接搜 41..200 的周期即可覆盖（要求末尾连续 3 个周期完全相同）。
 */
export const LONG_CYCLE_MAX = 200;

/**
 * 从任意结构里递归收集字符串（不依赖 frame 的字段名）。
 *
 * @param {unknown} value - 任意值。
 * @param {string[]} [out] - 累积目标。
 * @param {number} [depth] - 递归深度（防止环）。
 * @returns {string[]} 收集到的字符串。
 */
export function collectStrings(value, out = [], depth = 0) {
  try {
    if (depth > 6) return out;
    if (typeof value === 'string') {
      if (value !== '') out.push(value);
      return out;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 200)) collectStrings(item, out, depth + 1);
      return out;
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
    }
    return out;
  } catch {
    return out;
  }
}

/**
 * 判断一段文本是否已经进入重复退化。
 *
 * ## ⚠️ 第一版按"片段出现次数"统计，**误报严重**
 *
 * 实测：正常代码 `const value${i} = compute(input${i}, options);` 让 2 字符片段 `"pu"`
 * 出现 89 次被判退化；`if (condition && …)` 让 `"on"` 出现 166 次也被判退化。
 * **短片段在正常文本里必然高频**，按次数统计根本不能用。
 *
 * ## 现在的判据：末尾是否由**同一片段连续重复**构成
 *
 * 只问一个问题：把尾部窗口切成等长块后，**最后若干块是否完全相同**。
 * 退化的定义就是"同一个片段一遍遍地重复"，正常文本的末尾几乎不可能这样
 * （代码块可能重复相似行，但那不是**同一字符串**，且不会被判定为同一片段连续 N 次）。
 *
 * 从短到长试候选周期（`8..patternMax`），要求**至少连续重复 repeatMin 次**且
 * 覆盖尾部窗口的大半，取最长的那个作为结论（更长 = 更可信）。
 *
 * @param {string} text - 累积文本（内部只看尾部窗口）。
 * @param {object} [options] - 参数。
 * @param {number} [options.window] - 窗口大小。
 * @param {number} [options.patternMax] - 片段最大长度。
 * @param {number} [options.repeatMin] - 连续重复次数阈值。
 * @returns {{ degenerate: boolean, pattern?: string, count?: number }} 判定结果。
 */
export function detectDegeneration(text, options = {}) {
  try {
    const window = Number.isFinite(options.window) ? options.window : DEGENERATION_WINDOW;
    const patternMax = Number.isFinite(options.patternMax) ? options.patternMax : DEGENERATION_PATTERN_MAX;
    const repeatMin = Number.isFinite(options.repeatMin) ? options.repeatMin : DEGENERATION_REPEAT_MIN;
    const source = typeof text === 'string' ? text : '';
    if (source.length < window) return { degenerate: false };
    const tail = source.slice(-window);

    let best = { degenerate: false };
    for (let len = DEGENERATION_PATTERN_MIN; len <= patternMax; len += 1) {
      const piece = tail.slice(-len);
      if (piece.trim() === '') continue;
      // 从末尾往前数：连续多少个"整块"都等于 piece
      let count = 0;
      for (let end = tail.length; end - len >= 0; end -= len) {
        if (tail.slice(end - len, end) !== piece) break;
        count += 1;
        if (count >= repeatMin) break;
      }
      if (count >= repeatMin) {
        // 取更长的片段作为结论（更长 = 更可能是真正的重复单元）
        if (!best.degenerate || len > (best.pattern ?? '').length) {
          best = { degenerate: true, pattern: piece, count };
        }
      }
    }
    if (best.degenerate) return best;

    // ---- 长周期重复（7.22.0 补）：上面只覆盖 ≤patternMax 的单元 ----
    // 实测现场有一段 **66 字符周期**的自我催促（"Then write.\n\nThen verify.\n\n
    // Then answer.\n\nProduce tool call.\n\n"），按短单元抓不到。
    // 做法：直接搜周期 p（patternMax+1 .. LONG_CYCLE_MAX），要求**末尾连续 3 个周期完全相同**。
    // ⚠️ 不能用"把窗口等分成 k 块再比"——周期不能整除块长时永远对不上（第一版就这么错的）。
    for (let p = patternMax + 1; p <= LONG_CYCLE_MAX; p += 1) {
      if (tail.length < p * 3) break;
      const p1 = tail.slice(-p);
      const p2 = tail.slice(-2 * p, -p);
      if (p1 !== p2) continue;
      const p3 = tail.slice(-3 * p, -2 * p);
      if (p2 !== p3) continue;
      if (p1.trim() === '') continue;
      return { degenerate: true, pattern: p1.slice(0, 60), count: 3 };
    }

    return best;
  } catch {
    return { degenerate: false };
  }
}

/**
 * 给模型的**中断说明**（abort 之后它会看到这段文字，避免它以为自己被无故打断）。
 *
 * @param {object} [input] - 参数。
 * @param {string} [input.pattern] - 被判定重复的片段。
 * @param {number} [input.count] - 重复次数。
 * @returns {string} 说明文本。
 */
export function buildDegenerationNotice({ pattern = '', count = 0 } = {}) {
  const shown = typeof pattern === 'string' ? pattern.trim().slice(0, 40) : '';
  return [
    '【退化输出看门狗】你刚才的输出陷入了重复循环',
    shown === '' ? '' : `（片段「${shown}」重复了约 ${count} 次）`,
    '，插件已在生成中途打断以免烧掉整个回合的输出预算。',
    '',
    '**这不是任务失败，是输出方式错了**。接下来请：',
    '1. **立刻调用工具**（`write` / `edit` / `pwsh`）把要做的事做出来——',
    '   **不要再用文字描述"我将要做什么"**；',
    '2. 写长文档/长代码时**分段写**：每次 `write` 只写一个文件或一段（≤200 行），',
    '   写完立刻落盘，不要在回复里贴整篇内容；',
    '3. 不要重复复述计划。计划说一次就够，然后直接执行。',
  ].filter((line) => line !== '').join('\n');
}

/**
 * 从 `agent/assistant-stream` 的 frame 里取增量文本（7.22.0）。
 *
 * 运行时结构（读 `dsh-headless` 的消费代码确证）：
 * `frame.type` 是 `start` / `end` / 其它，`frame.chunk.type` 是
 * `reasoning-delta` / `text-delta` 等，`chunk.text` 是增量。
 *
 * **宽松兜底**：结构变了也不会静默失效——递归收集字符串。
 *
 * @param {unknown} frame - `agent/assistant-stream` 的 frame。
 * @returns {string} 增量文本；取不到返回空串。
 */
export function frameDelta(frame) {
  try {
    if (frame === null || typeof frame !== 'object') return '';
    if (frame.type === 'start' || frame.type === 'end') return '';
    const chunk = frame.chunk;
    if (chunk !== null && typeof chunk === 'object') {
      if (typeof chunk.text === 'string') return chunk.text;
      // `reasoning-chunks` 之类的批量形态：dt 里有文本
      if (Array.isArray(chunk.dt)) return collectStrings(chunk.dt).join('');
    }
    // 兜底：只取直接字符串（避免把 tool-call 的参数也算进重复统计）
    return collectStrings(frame).join('');
  } catch {
    return '';
  }
}

/**
 * 每个会话的退化检测状态机（7.22.0）。
 *
 * 由 `agent.js` 的 `agent/assistant-stream` 监听器驱动：
 * 每次 `push()` 一段增量，内部累积尾部窗口并判定；判定退化后**只报一次**
 * （返回 `{ degenerate: true }` 那一次），调用方负责 `agent.cancel()` + `followup()`。
 */
export class DegenerationTracker {
  /** @param {object} [options] - 参数。 */
  constructor(options = {}) {
    this.window = Number.isFinite(options.window) ? options.window : DEGENERATION_WINDOW;
    this.patternMax = Number.isFinite(options.patternMax) ? options.patternMax : DEGENERATION_PATTERN_MAX;
    this.repeatMin = Number.isFinite(options.repeatMin) ? options.repeatMin : DEGENERATION_REPEAT_MIN;
    /** 已累积的尾部文本（只留 window 的两倍，避免无限增长）。 */
    this.tail = '';
    /** 本次尝试是否已经报过（同一 attempt 只掐一次）。 */
    this.fired = false;
  }

  /** 新的一次 assistant 尝试开始 → 重置。 */
  reset() {
    this.tail = '';
    this.fired = false;
  }

  /**
   * 追加一段增量并判定。
   *
   * @param {unknown} frame - `agent/assistant-stream` 的 frame。
   * @returns {{ degenerate: boolean, pattern?: string, count?: number }} 判定结果；
   *   **只有第一次命中时** `degenerate` 为 `true`。
   */
  push(frame) {
    try {
      if (this.fired) return { degenerate: false };
      const delta = frameDelta(frame);
      if (delta !== '') {
        this.tail += delta;
        if (this.tail.length > this.window * 2) this.tail = this.tail.slice(-this.window * 2);
      }
      const result = detectDegeneration(this.tail, {
        window: this.window,
        patternMax: this.patternMax,
        repeatMin: this.repeatMin,
      });
      if (result.degenerate) {
        this.fired = true;
        return result;
      }
      return { degenerate: false };
    } catch {
      return { degenerate: false };
    }
  }
}

