/**
 * 「退化输出看门狗」的测试（`lib/degeneration-guard.js`，7.22.0 新增）。
 *
 * ## 现场（`94f76704` = 子智能体 `docs-checklist-spec`，2026-11-19）
 *
 * step 12 **单次输出 322,334 字**、`Emit` **5602 次** / `OK` **5115 次**、
 * **零工具调用**、持续 **11 分钟**，最后被 `max-tokens` 硬截断。
 *
 * 重复从第 **64,306** 字符开始，退化前是自我催促：
 * `Then write. Then verify. Then answer. Go. … I'll now emit the tool call. Then write. …`
 *
 * ## 判据的关键难点：**不能误报**
 *
 * 第一版按"片段出现次数"统计 —— 正常代码 `const value${i} = compute(input${i})` 让
 * 2 字符串 `"pu"` 出现 89 次、`if (condition && …)` 让 `"on"` 出现 166 次，全部误判。
 * 现在的判据只问一件事：**末尾是否由同一片段（≥8 字符）连续重复 ≥20 次**。
 *
 * ## 这里钉什么
 *
 * 1. 真实退化文本必须命中，且**尽早**命中（越早省的 token 越多）；
 * 2. 正常代码/文档/表格**零误报**；
 * 3. 同一次尝试**只报一次**（不能反复 cancel）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEGENERATION_PATTERN_MIN,
  DEGENERATION_REPEAT_MIN,
  DegenerationTracker,
  buildDegenerationNotice,
  collectStrings,
  detectDegeneration,
  frameDelta,
} from '../lib/degeneration-guard.js';

/** 拼一段正常的长文本（代码风格，内容各不相同）。 */
function normalCode(n = 60) {
  return Array.from({ length: n }, (_, i) => `  const value${i} = compute(input${i}, options${i});`).join('\n');
}
/** 拼一段正常的长文档。 */
function normalDoc(n = 40) {
  return Array.from({ length: n }, (_, i) => `- **要点 ${i}**：第 ${i} 条说明，内容与别条不同，长度也不一致。`).join('\n');
}
/** 拼一段正常表格。 */
function normalTable(n = 40) {
  return Array.from({ length: n }, (_, i) => `| ${i} | 用例${i} | 期望 ${i * 3} | 通过 |`).join('\n');
}

test('7.22.0：真实退化模式（Emit./Now./OK. 循环）必须命中', () => {
  const degenerate = Array.from({ length: 200 }, () => '.\n\nEmit.\n\nNow.\n\nOK.\n\n').join('');
  const result = detectDegeneration(degenerate);
  assert.equal(result.degenerate, true, '真实的 Emit/Now/OK 循环必须被识别');
  assert.ok(result.count >= DEGENERATION_REPEAT_MIN, JSON.stringify(result));
});

test('7.22.0：真实现场的自我催促也要能命中', () => {
  // 退化前那段："Then write. / Then verify. / Then answer. / Produce tool call." 反复出现，
  // **周期 66 字符**，超过 DEGENERATION_PATTERN_MAX（40）—— 靠短单元抓不到，
  // 由 LONG_CYCLE_BLOCKS（等分块比较）覆盖。
  const loop = 'Then write.\n\nThen verify.\n\nThen answer.\n\nProduce tool call.\n\n';
  assert.ok(loop.length > 40, `这个周期应当超过 patternMax：${loop.length}`);
  const text = loop.repeat(60);
  const result = detectDegeneration(text);
  assert.equal(result.degenerate, true, JSON.stringify(result));
});

test('7.22.0：真实退化文本 —— 尽早命中（越早省 token 越多）', () => {
  // 模拟：前 4000 字正常，之后开始退化
  const normal = normalDoc(120);            // 约 4000+ 字
  const degenerated = Array.from({ length: 300 }, () => '.\n\nEmit.\n\nNow.\n\nOK.\n\n').join('');
  const full = normal + degenerated;

  // 逐 200 字累积，找首次命中位置
  let acc = '';
  let hit = -1;
  for (let i = 0; i < full.length; i += 200) {
    acc += full.slice(i, i + 200);
    if (detectDegeneration(acc).degenerate) { hit = acc.length; break; }
  }
  assert.ok(hit > 0, '必须命中');
  const normalLen = normal.length;
  // 命中位置应接近退化起点，而不是拖到很后面
  assert.ok(hit - normalLen < 3000, `命中太晚：退化从 ${normalLen} 起，实际 ${hit} 才命中`);
});

test('7.22.0：正常代码 / 文档 / 表格 零误报（第一版在这里全错）', () => {
  for (const [label, sample] of [
    ['代码', normalCode(80)],
    ['文档', normalDoc(60)],
    ['表格', normalTable(60)],
    // 长行重复但内容不同（代码块常见），片段 > 40 字符，不该算退化
    ['相似长行', Array.from({ length: 40 }, (_, i) => `if (condition${i} && anotherCondition${i} && thirdCondition) { doSomething${i}(); }`).join('\n')],
  ]) {
    const result = detectDegeneration(sample);
    assert.equal(result.degenerate, false, `${label} 不应误报：${JSON.stringify(result)}`);
  }
});

test('7.22.0：重复单元最短 8 字符（短片段不配叫退化）', () => {
  assert.equal(DEGENERATION_PATTERN_MIN, 8);
  // 8 字符片段连续重复 → 命中（注意必须超过 2000 字符窗口才会判：8×300=2400）
  const ok = 'ABCDEFGH'.repeat(300);
  assert.ok(ok.length > 2000, `要超过窗口：${ok.length}`);
  assert.equal(detectDegeneration(ok).degenerate, true, '8 字符稳定重复应命中');

  // 关键是**不能靠短片段高频定罪**：正常代码里 `"pu"` / `"on"` 出现几十上百次，
  // 第一版按次数统计就误报了；现在只认"末尾连续重复"，所以不会。
  const varied = Array.from({ length: 200 }, (_, i) => `compute(input${i}, options${i})`).join(' ');
  assert.equal(detectDegeneration(varied).degenerate, false, '正常代码不应因短片段高频被判退化');
});

test('7.22.0：文本不够窗口长度时永不上报（不猜）', () => {
  assert.equal(detectDegeneration('Emit. Now. OK.'.repeat(5)).degenerate, false);
  assert.equal(detectDegeneration('').degenerate, false);
  assert.equal(detectDegeneration(undefined).degenerate, false);
});

test('7.22.0：Tracker 同一次尝试只报一次（不能反复 cancel）', () => {
  const tracker = new DegenerationTracker();
  let fired = 0;
  // 先喂正常内容
  for (let i = 0; i < 30; i += 1) {
    const r = tracker.push({ type: 'chunk', chunk: { type: 'text-delta', text: `正常的第 ${i} 句，内容各不相同。` } });
    if (r.degenerate) fired += 1;
  }
  assert.equal(fired, 0, '正常内容不该触发');
  // 再喂退化内容
  for (let i = 0; i < 200; i += 1) {
    const r = tracker.push({ type: 'chunk', chunk: { type: 'text-delta', text: '\n\nEmit.\n\nNow.\n\nOK.\n\n' } });
    if (r.degenerate) fired += 1;
  }
  assert.equal(fired, 1, `只该报一次，实际 ${fired}`);
});

test('7.22.0：Tracker 的 reset 让下一次尝试重新计数', () => {
  const tracker = new DegenerationTracker();
  // 用运行时**真实 frame 形状**（`AssistantStreamFrame` 的 chunk 分支带 attemptId）。
  const textFrame = (text) => ({ type: 'chunk', attemptId: 'b885b225-5bed-468c-b45c-518d4b85f8d', revision: 1, index: 0, time: 0, chunk: { type: 'text-delta', text } });
  for (let i = 0; i < 200; i += 1) tracker.push(textFrame('Emit.\n\nNow.\n\nOK.\n\n'));
  assert.equal(tracker.fired, true);
  tracker.reset();
  assert.equal(tracker.fired, false);
  // reset 后正常内容不会立刻命中
  const r = tracker.push(textFrame('这是一段新的正常文本。'));
  assert.equal(r.degenerate, false);
});

test('7.22.0：frameDelta 能从真实 frame 结构取增量，start/end 返回空', () => {
  assert.equal(frameDelta({ type: 'start', attemptId: 'a', turn: 1, step: 1 }), '');
  assert.equal(frameDelta({ type: 'end', attemptId: 'a', outcome: { kind: 'committed' } }), '');
  assert.equal(frameDelta({ type: 'chunk', chunk: { type: 'text-delta', text: 'hello' } }), 'hello');
  assert.equal(frameDelta({ type: 'chunk', chunk: { type: 'reasoning-delta', text: 'thinking' } }), 'thinking');
  // 批量形态：texts 数组
  assert.equal(frameDelta({ type: 'chunk', chunk: { type: 'reasoning-chunks', dt: [], texts: ['a', 'b'] } }), 'ab');
  assert.equal(frameDelta(null), '');
  assert.equal(frameDelta(undefined), '');
  assert.equal(frameDelta(42), '');
});

// ── 7.25.2：frame 元数据绝不能进重复检测 ─────────────────────────────────────
// 现场 `b885b225`（2026-11-20）：「1.8.50 回归验证」小组长一分钟内被看门狗连掐 6 次、
// 烧掉 26 个回合。报出来的重复片段是 `chunkb885b225-5bed-468c-b45c-518d4b85f8d`
// —— `chunk` 是 frame.type、后面是 frame.attemptId，**根本没有模型文本参与**。
// 旧实现末尾的 `collectStrings(frame)` 兜底把它们当正文拼进窗口，每帧都产生同一串
// 40 字符，于是「同一片段连续重复 ≥3 次」恒成立。
test('7.25.2：frameDelta 只认文本，绝不把 frame.type / attemptId 当正文', () => {
  const attemptId = 'b885b225-5bed-468c-b45c-518d4b85f8d';
  const base = { attemptId, revision: 3, index: 1, time: 1795167595956 };
  // 这些帧全都没有正文；旧实现会返回 `chunk<attemptId>...`。
  const noTextFrames = [
    { type: 'chunk', ...base, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
    { type: 'chunk', ...base, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: ' ' } } },
    { type: 'chunk', ...base, chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } },
    {
      type: 'chunk', ...base,
      chunk: {
        type: 'tool-call-chunks', index: 1, dt: [23, 243, 0, 0], id: 'call_00_x13282fqengf9taoc0fges46',
        name: 'pwsh', args: ['{"', 'command', '": ', '"', 'Get-Date', '"}'],
      },
    },
  ];
  for (const frame of noTextFrames) {
    const delta = frameDelta(frame);
    assert.equal(delta, '', `不该从元数据取到文本：${JSON.stringify(delta)}（frame=${frame.chunk.type}）`);
    assert.ok(!delta.includes(attemptId), 'attemptId 绝不能进正文');
    assert.ok(!delta.includes('chunk'), 'frame.type 绝不能进正文');
  }
});

test('7.25.2：只有元数据帧时 Tracker 永不判退化（b885b225 误报回归）', () => {
  const attemptId = 'b885b225-5bed-468c-b45c-518d4b85f8d';
  const tracker = new DegenerationTracker();
  let fired = 0;
  // 模拟真实一轮：start → 若干 block-start/tool-call-chunks（参数里带重复内容）→ end
  for (let attempt = 0; attempt < 5; attempt += 1) {
    tracker.reset();
    for (let i = 0; i < 200; i += 1) {
      const frames = [
        { type: 'chunk', attemptId, revision: attempt, index: 0, time: 0, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
        { type: 'chunk', attemptId, revision: attempt, index: 1, time: 0, chunk: { type: 'tool-call-chunks', index: 1, dt: [1, 0, 0], id: 'call_00_x', name: 'pwsh', args: ['Set-Location E:\\', '顺灵 Boardmate', '; $f=...'] } },
        { type: 'chunk', attemptId, revision: attempt, index: 2, time: 0, chunk: { type: 'block-end', index: 1, block: { type: 'tool-call', args: { command: 'x' } } } },
      ];
      for (const frame of frames) if (tracker.push(frame).degenerate) fired += 1;
    }
  }
  assert.equal(fired, 0, `纯元数据帧不该判退化，实际误报 ${fired} 次`);
});

test('7.25.2：复现现场 —— 3 个相同元数据帧曾足以判退化，修复后不再', () => {
  // ⚠️ 这是 b885b225 的**最小复现**（数字都是实测的）：
  //
  // 1. 一轮里先有 ≥2000 字正常输出（`detectDegeneration` 只在 `source.length >= window` 时判）；
  // 2. 末尾连续出现 3 个 `block-start` 帧（reasoning 一个、tool-call 一个，加上重试再来一个）；
  // 3. 旧 `frameDelta` 对每个 block-start 帧都返回 `chunk<attemptId><block-start><blockType>`（63 字符），
  //    三个完全相同 → 长周期分支（41..200）以 p=63 命中，`count` 恒为 3；
  // 4. `buildDegenerationNotice` 把 pattern 截到 40 字符，于是提示里出现
  //    `chunkb885b225-5bed-468c-b45c-518d4b85f8d` —— 与用户截图**一字不差**。
  const id = 'b885b225-5bed-468c-b45c-518d4b85f8d7:7';
  const blockStart = { type: 'chunk', attemptId: id, revision: 1, index: 0, time: 0, chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } };

  // 旧实现（元数据进窗口）：手工拼出它当时的窗口
  const legacyDelta = 'chunk' + id + 'block-starttool-call';
  const padding = '正常的推理内容，每一句都不一样。'.repeat(200);
  const legacyResult = detectDegeneration(padding + legacyDelta.repeat(3));
  assert.equal(legacyResult.degenerate, true, '旧窗口形状确实会命中（这就是当时的误报）');
  assert.ok(legacyResult.pattern.startsWith('chunk' + id), JSON.stringify(legacyResult));
  const shown = buildDegenerationNotice({ pattern: legacyResult.pattern, count: legacyResult.count }).split('\n')[1];
  assert.ok(shown.includes('chunkb885b225-5bed-468c-b45c-518d4b85f8d'), `提示文案应与现场一致：${shown}`);

  // 新实现：同样的帧序列，窗口里只有正常文本，一个字符都不该进检测器
  const tracker = new DegenerationTracker();
  for (const ch of padding) tracker.push({ type: 'chunk', attemptId: id, revision: 1, index: 0, time: 0, chunk: { type: 'text-delta', text: ch } });
  let fired = 0;
  for (let i = 0; i < 3; i += 1) if (tracker.push(blockStart).degenerate) fired += 1;
  assert.equal(fired, 0, '修复后同样的元数据帧不该再触发退化判定');
  assert.equal(tracker.tail.includes('b885b225'), false, 'tail 里不该出现 attemptId');
});

test('7.25.2：真实文本退化仍能在真实 frame 形状下命中（收紧后没有失去能力）', () => {
  const attemptId = 'b885b225-5bed-468c-b45c-518d4b85f8d';
  const tracker = new DegenerationTracker();
  let fired = 0;
  for (let i = 0; i < 300; i += 1) {
    const frame = { type: 'chunk', attemptId, revision: 1, index: 0, time: 0, chunk: { type: 'text-delta', text: '.\n\nEmit.\n\nNow.\n\nOK.\n\n' } };
    if (tracker.push(frame).degenerate) fired += 1;
  }
  assert.equal(fired, 1, '真实退化文本必须仍然命中且只报一次');
});

test('7.22.0：collectStrings 递归收字符串（结构变了也不静默失效）', () => {
  const out = collectStrings({ a: 'x', b: ['y', { c: 'z' }], d: 1, e: null });
  assert.deepEqual(out.sort(), ['x', 'y', 'z']);
  // 深度/环保护
  const cyclic = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(() => collectStrings(cyclic));
});

test('7.22.0：中断说明必须点明"改用工具 / 分段写"（否则下次还会退化）', () => {
  const text = buildDegenerationNotice({ pattern: 'Emit.\n\nNow', count: 42 });
  assert.ok(text.includes('退化输出看门狗'), text);
  assert.ok(text.includes('重复循环'), text);
  assert.ok(text.includes('工具'), text);
  assert.ok(text.includes('分段'), text);
  assert.ok(text.includes('不是任务失败'), text);
});
