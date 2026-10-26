/**
 * 模式目录隐藏的测试（`lib/preset-catalog.js`）。
 *
 * 这段代码解决一个具体的用户可见缺陷：每个 specialist 都注册成独立 preset 来承载人设，
 * 而这些 preset 会出现在**模式选择菜单**里 —— 用户看到六条「指挥官 specialist: …」，
 * 以为它们是可选模式。修复必须精确：**隐藏目录条目，但不能影响注册与挂载**（否则
 * specialist 工具会挂不上人设，专家就退化成"只有职责一句话"的普通子代理）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SPECIALIST_PRESET_PREFIX,
  hidePresetsFromCatalog,
  isSpecialistPresetId,
} from '../lib/preset-catalog.js';

/**
 * 一个尽量贴近真实 registry 的替身：`remoteExportList` 定义在**原型**上（真实实现由
 * `@Remote('list')` 装饰的类方法），返回 `{ presets }`。
 */
class FakeRegistry {
  constructor(presets) {
    this.presets = presets;
    this.listCalls = 0;
  }

  /** 内部方法：诊断/内部解析用它，不该被过滤。 */
  async list() {
    this.listCalls += 1;
    return this.presets.map((preset) => ({ ...preset }));
  }

  /** 目录的 UI 通道（Remote 'list'）。 */
  async remoteExportList() {
    return { presets: await this.list() };
  }
}

/** 一份混合目录：两个本插件 specialist + 一个普通模式。 */
function mixedPresets() {
  return [
    { id: 'standard', name: '标准模式', order: 1 },
    { id: `${SPECIALIST_PRESET_PREFIX}architect-d4b0e4a6`, name: '指挥官 specialist: architect', order: undefined },
    { id: 'cordis', name: '创造模式', order: 2 },
    { id: `${SPECIALIST_PRESET_PREFIX}reviewer-7817fced`, name: '指挥官 specialist: reviewer', order: undefined },
  ];
}

test('isSpecialistPresetId 只认本插件的前缀', () => {
  assert.equal(isSpecialistPresetId(`${SPECIALIST_PRESET_PREFIX}architect-d4b0e4a6`), true);
  assert.equal(isSpecialistPresetId('commander'), false);
  assert.equal(isSpecialistPresetId('standard'), false);
  assert.equal(isSpecialistPresetId('commander-specialist'), false, '前缀必须带连字符');
  assert.equal(isSpecialistPresetId(undefined), false);
  assert.equal(isSpecialistPresetId(42), false);
});

test('目录里不再出现 specialist preset，普通模式原样保留', async () => {
  const registry = new FakeRegistry(mixedPresets());
  const restore = hidePresetsFromCatalog(registry);

  const response = await registry.remoteExportList();
  assert.deepEqual(
    response.presets.map((preset) => preset.id),
    ['standard', 'cordis'],
    '只应剩下真正的可选模式',
  );
  restore();
});

test('internal list() 不受影响（诊断与内部解析仍能看到全部 preset）', async () => {
  // 关键：挂载 specialist 走的是 registry 内部解析，不走 remoteExportList。
  // 如果连 list() 也过滤，诊断工具会看不到这些 preset，排查"专家没挂上"时会误判。
  const registry = new FakeRegistry(mixedPresets());
  const restore = hidePresetsFromCatalog(registry);
  const rows = await registry.list();
  assert.equal(rows.length, 4, '内部 list() 必须仍返回全部 4 条');
  restore();
});

test('目录响应的其余字段原样透传（isDefault 等）', async () => {
  const registry = new FakeRegistry(mixedPresets());
  registry.remoteExportList = async function decorated() {
    return {
      presets: mixedPresets().map((preset) => ({ ...preset, isDefault: preset.id === 'standard' })),
      revision: 7,
    };
  };
  const restore = hidePresetsFromCatalog(registry);
  const response = await registry.remoteExportList();
  assert.equal(response.revision, 7, '非 presets 字段必须原样透传');
  assert.deepEqual(response.presets.map((preset) => preset.id), ['standard', 'cordis']);
  assert.equal(response.presets[0].isDefault, true);
  restore();
});

test('支持自定义判定（不只靠前缀）', async () => {
  const registry = new FakeRegistry(mixedPresets());
  const restore = hidePresetsFromCatalog(registry, (id) => id === 'cordis');
  const response = await registry.remoteExportList();
  assert.deepEqual(response.presets.map((preset) => preset.id), [
    'standard',
    `${SPECIALIST_PRESET_PREFIX}architect-d4b0e4a6`,
    `${SPECIALIST_PRESET_PREFIX}reviewer-7817fced`,
  ]);
  restore();
});

test('恢复函数把原方法放回，且幂等', async () => {
  const registry = new FakeRegistry(mixedPresets());
  const original = registry.remoteExportList;
  const restore = hidePresetsFromCatalog(registry);

  assert.notEqual(registry.remoteExportList, original, '包装后应是新函数');
  restore();
  assert.equal(registry.remoteExportList, original, '恢复后应回到原方法');
  restore(); // 幂等：再调一次不抛错
  const response = await registry.remoteExportList();
  assert.equal(response.presets.length, 4, '恢复后目录应恢复完整');
});

test('别人后来也包装过时，恢复不覆盖别人的包装', async () => {
  // 两个插件都想过滤目录时，卸载顺序不确定。我们只在自己那层仍在栈顶时恢复。
  const registry = new FakeRegistry(mixedPresets());
  const original = registry.remoteExportList;
  const restore = hidePresetsFromCatalog(registry);
  const ours = registry.remoteExportList;

  // 模拟另一个插件在我们的包装之上再包一层。
  const other = async function otherPlugin() {
    const response = await ours.call(this);
    return { presets: response.presets.filter((preset) => preset.id !== 'cordis') };
  };
  Object.defineProperty(registry, 'remoteExportList', { configurable: true, writable: true, value: other });

  restore();
  assert.equal(registry.remoteExportList, other, '不能把别人的包装覆盖掉');
  const response = await registry.remoteExportList();
  assert.deepEqual(response.presets.map((preset) => preset.id), ['standard'], '别人的过滤仍然生效');
  assert.notEqual(original, undefined);
});

test('服务不可替换时抛 TypeError，由调用方降级', () => {
  assert.throws(() => hidePresetsFromCatalog(null), TypeError);
  assert.throws(() => hidePresetsFromCatalog({}), TypeError);

  class FrozenRegistry {
    async remoteExportList() {
      return { presets: [] };
    }
  }
  const frozen = new FrozenRegistry();
  Object.defineProperty(frozen, 'remoteExportList', {
    configurable: false,
    writable: false,
    value: frozen.remoteExportList,
  });
  assert.throws(() => hidePresetsFromCatalog(frozen), TypeError);
});

test('目录响应形状异常时不炸（返回原值）', async () => {
  for (const weird of [undefined, null, 'nope', { presets: 'nope' }]) {
    const registry = new FakeRegistry(mixedPresets());
    registry.remoteExportList = async () => weird;
    const restore = hidePresetsFromCatalog(registry);
    assert.equal(await registry.remoteExportList(), weird, `异常响应 ${String(weird)} 应原样返回`);
    restore();
  }
});

test('preset 里缺 id 的条目也不会炸', async () => {
  const registry = new FakeRegistry([{ name: '没有 id 的怪条目' }, ...mixedPresets()]);
  const restore = hidePresetsFromCatalog(registry);
  const response = await registry.remoteExportList();
  assert.equal(response.presets.some((preset) => preset.id === undefined), true, '缺 id 的条目原样保留');
  restore();
});
