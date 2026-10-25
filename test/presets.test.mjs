/**
 * 出厂预置名册的测试（`lib/presets.js`）。
 *
 * 这份清单同时被三方使用，任何两方漂移都会产生"看起来配置好了其实没生效"的故障：
 *
 * 1. **Host**：schema 默认值 → 新装插件开箱就有这些专家；
 * 2. **设置页「重置」**：client 半内置同一份清单，点重置要恢复成"出厂状态"；
 * 3. **README / 文档**：用户据此理解每个专家的边界。
 *
 * 所以这里既断言清单本身的结构（按主流开发流程覆盖、id 合法、模型留空=继承），
 * 也断言 client.js 里的内置副本与它**逐项同值**（client 不能 import Host 模块：
 * client bundle 只能 require shell 静态模块，所以只能靠测试守住一致性）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_SPECIALISTS,
  cloneDefaultSpecialists,
  defaultSpecialistIds,
} from '../lib/presets.js';

// ---------------------------------------------------------------- 结构 ---

test('预置名册覆盖主流软件开发生命周期的关键环节', () => {
  // 用户要求"按主流的软件开发流程提前预制一些专家"：需求/架构 → 实现 → 审查 → 测试
  // → 安全 → 文档。少任何一个环节，开箱名册就盖不住一次完整迭代。
  assert.deepEqual(defaultSpecialistIds(), [
    'architect',
    'implementer',
    'reviewer',
    'tester',
    'security-auditor',
    'doc-writer',
  ]);
});

test('每个预置专家的 id 合法（它要拼进工具名）', () => {
  // `subagent_<id>` 是工具名；非法 id 会让 `tools.register()` 整个失败。
  for (const specialist of DEFAULT_SPECIALISTS) {
    assert.match(specialist.id, /^[a-z][a-z0-9_-]{0,47}$/u, `非法 id：${specialist.id}`);
    assert.ok(!specialist.id.endsWith('-'), `${specialist.id} 不应以连字符结尾`);
  }
  assert.equal(new Set(defaultSpecialistIds()).size, DEFAULT_SPECIALISTS.length, 'id 必须唯一');
});

test('每个预置专家的 provider / model 都是空串（继承指挥者模型）', () => {
  // 这是"开箱即用"的关键：预置名册不能硬编码任何 provider/model —— 不同部署可用的模型
  // 完全不同。空 = 子 agent 从父会话继承 route，任何部署都能用。
  for (const specialist of DEFAULT_SPECIALISTS) {
    assert.equal(specialist.provider, '', `${specialist.id}.provider 必须留空`);
    assert.equal(specialist.model, '', `${specialist.id}.model 必须留空`);
  }
});

test('每个预置专家都有非空的定位描述与专属人设', () => {
  // description 是指挥者选人的依据、也是设置页那一行的职责；persona 是追加人设。
  // 两者都不能空：空的定位会让定位匹配规则失效，空的人设等于没有专门化。
  for (const specialist of DEFAULT_SPECIALISTS) {
    assert.ok(specialist.description.length >= 20, `${specialist.id} 的定位描述太短`);
    assert.ok(specialist.persona.length >= 30, `${specialist.id} 的人设太短`);
    assert.ok(!specialist.description.includes('undefined'), `${specialist.id} 的定位里不能有 undefined`);
  }
});

test('预置名册条目字段与 SpecialistSchema 对齐（五键，无多余键）', () => {
  // 设置页保存时会按 schema 的五个键过滤；多一个键会在往返中丢失，制造"保存后变了"。
  const allowed = new Set(['id', 'provider', 'model', 'description', 'persona']);
  for (const specialist of DEFAULT_SPECIALISTS) {
    for (const key of Object.keys(specialist)) {
      assert.ok(allowed.has(key), `${specialist.id} 有 schema 不认识的键：${key}`);
    }
  }
});

test('模块常量的每个条目都是冻结的（运行时不能改出厂清单）', () => {
  assert.ok(Object.isFrozen(DEFAULT_SPECIALISTS));
  for (const specialist of DEFAULT_SPECIALISTS) {
    assert.ok(Object.isFrozen(specialist), `${specialist.id} 应被冻结`);
  }
});

test('cloneDefaultSpecialists 返回可修改的深拷贝', () => {
  // schema 的 `.default(cloneDefaultSpecialists())` 拿到的是解析期副本；这里保证调用方
  // 可以安全地改（例如设置页 reset 后的草稿编辑），而不会影响常量。
  const copy = cloneDefaultSpecialists();
  assert.deepEqual(copy, DEFAULT_SPECIALISTS);
  copy[0].description = '临时修改';
  assert.notEqual(DEFAULT_SPECIALISTS[0].description, '临时修改');
  // 浅拷贝也够：值都是字符串，没有嵌套结构。
  assert.notEqual(copy[0], DEFAULT_SPECIALISTS[0]);
});

// ------------------------------------------------ client 内置副本一致性 ---

test('client.js 内置的出厂名册与 lib/presets.js 逐项同值', () => {
  // client 半不能 import Host 模块（只能 require shell 静态模块表里的东西），所以它
  // **必须**内置一份用于「重置」的清单。这份测试是两处唯一的同步机制。
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');

  for (const specialist of DEFAULT_SPECIALISTS) {
    assert.ok(source.includes(`id: '${specialist.id}'`), `client.js 缺少预置专家 ${specialist.id}`);
    // 定位描述整句必须出现（重置后草稿里的定位要与 Host 默认一致）。
    assert.ok(
      source.includes(specialist.description),
      `client.js 里 ${specialist.id} 的定位描述与 lib/presets.js 不一致`,
    );
  }

  // 反向：client 里不能再多出 Host 没有的预置 id（否则重置会造出"Host 不认识"的条目）。
  //
  // 锚点必须精确：早先版本用 `indexOf('DEFAULT_ROSTER')` + 固定长度窗口，结果文件头注释
  // 里提到这个字面量就会把 bundle id 等无关条目圈进来，误报"Host 不认识的 id"。
  // 现在从 `const DEFAULT_ROSTER` 切到它的 `]);` 结束，窗口由代码结构决定。
  const blockStart = source.indexOf('const DEFAULT_ROSTER');
  assert.ok(blockStart >= 0, 'client.js 必须有 `const DEFAULT_ROSTER`');
  const blockEnd = source.indexOf(']);', blockStart);
  assert.ok(blockEnd > blockStart, 'DEFAULT_ROSTER 的结束标记 `]);` 必须存在');
  const rosterBlock = source.slice(blockStart, blockEnd);
  const declaredIds = [...rosterBlock.matchAll(/id: '([a-z][a-z0-9_-]{0,47})'/gu)].map((match) => match[1]);
  const defaultIds = new Set(defaultSpecialistIds());
  assert.equal(declaredIds.length, DEFAULT_SPECIALISTS.length, 'DEFAULT_ROSTER 的条目数必须与 Host 一致');
  for (const id of declaredIds) {
    assert.ok(defaultIds.has(id), `client.js 的 DEFAULT_ROSTER 里有 Host 不认识的 id：${id}`);
  }
});
