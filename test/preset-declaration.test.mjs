/**
 * 自带 preset 声明器的单元测试（2.1.0）。
 *
 * ## 为什么本包要自带声明器
 *
 * 插件页「包含的组件」每一行的标题由**该行的模块名**决定：Host 的 `declaredRows()` 调
 * `pluginPackages.metaOf(row.name, base)` 读该模块的 `locale/*.json`。两个模式若都写成
 * `name: '@deepseek-ai/dsh-agent-preset'`，两行解析到同一模块、只能拿到同一份 locale，
 * 标题就都是「Agent 预设定义」——分不清谁是谁。改成两个子路径模块后每行有自己的
 * `locale/*.json` 与 `icon`。
 *
 * ## 这里守什么
 *
 * 1. 语义与随附声明器一致：`agentPresets.register(config)` 收到**完整**的本行 config，
 *    且 config 形状是 `{ id, name, description, order, plugins }`；
 * 2. 卸载时释放：`ctx.effect` 的 disposer 必须调用 `unregister`；
 * 3. 注册晚于卸载（竞态）：effect 先释放、注册后完成时，仍要立刻调 unregister，不能漏；
 * 4. 注册失败只记 warning，不抛（模式自己还要能起）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PresetDeclarationConfig,
  declarePreset,
} from '../lib/preset-declaration.js';
import { apply as applyCommander, name as commanderName } from '../preset-commander.js';
import { apply as applyManager, name as managerName } from '../preset-project-manager.js';

/**
 * 最小 ctx 替身：记录 effect / register / warn。
 *
 * @param {object} [options] - 夹具开关。
 * @param {(definition: object) => Promise<Function>} [options.register] - 自定义注册行为。
 * @returns {object} 记录对象。
 */
function makeCtx({ register } = {}) {
  const record = {
    registrations: [],
    disposers: [],
    warnings: [],
  };
  const ctx = {
    agentPresets: {
      register(definition) {
        record.registrations.push(definition);
        if (register) return register(definition);
        return Promise.resolve(async () => {
          record.released = (record.released ?? 0) + 1;
        });
      },
    },
    effect(callback, label) {
      const disposer = callback();
      record.disposers.push({ disposer, label });
      return () => {};
    },
    logger: {
      warn: (...args) => record.warnings.push(args),
    },
  };
  return { ctx, record };
}

/** 与本包 patch 同形的 config。 */
function sampleConfig(id) {
  return {
    id,
    name: id === 'commander' ? '指挥者模式' : '项目经理模式',
    description: '测试用描述',
    order: id === 'commander' ? 7 : 8,
    plugins: [
      { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
      { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: false },
    ],
  };
}

// ---------------------------------------------------------------- 配置形状 ---

test('Config 与随附声明器同形：id 必填、plugins 为数组、order 是数字', () => {
  const parsed = PresetDeclarationConfig(sampleConfig('commander'));
  assert.equal(parsed.id, 'commander');
  assert.equal(parsed.order, 7);
  assert.equal(parsed.plugins.length, 2);
  // id 必填：缺了直接拒绝（声明器不该猜）。
  assert.throws(() => PresetDeclarationConfig({ plugins: [] }));
  // plugins 必填。
  assert.throws(() => PresetDeclarationConfig({ id: 'x' }));
});

// ---------------------------------------------------------------- 注册 ---

test('两个模块各自把自己的 config 原样交给 agentPresets.register', async () => {
  for (const [apply, expectedId, expectedLabel] of [
    [applyCommander, 'commander', 'preset-commander'],
    [applyManager, 'project-manager', 'preset-project-manager'],
  ]) {
    const { ctx, record } = makeCtx();
    const config = sampleConfig(expectedId);
    await apply(ctx, config);
    assert.equal(record.registrations.length, 1, `${expectedLabel}: 应注册一次`);
    const definition = record.registrations[0];
    assert.equal(definition.id, expectedId);
    assert.equal(definition.order, config.order);
    assert.deepEqual(definition.plugins, config.plugins, 'plugins 必须原样传递（不重排、不裁剪）');
    assert.equal(record.disposers.length, 1, `${expectedLabel}: 应挂一个 effect`);
    assert.equal(record.disposers[0].label, `${expectedLabel}: preset ${expectedId}`);
  }
});

test('插件名稳定（Loader 诊断与测试都依赖它）', () => {
  assert.equal(commanderName, 'preset-commander-declaration');
  assert.equal(managerName, 'preset-project-manager-declaration');
});

// ---------------------------------------------------------------- 释放 ---

test('卸载时调用 unregister（preset 不留在注册表里）', async () => {
  const { ctx, record } = makeCtx();
  await applyCommander(ctx, sampleConfig('commander'));
  const { disposer } = record.disposers[0];
  await disposer();
  // 释放是异步的（要等注册完成），等一个微任务队列。
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(record.released, 1, '必须调用一次 unregister');
});

test('竞态：effect 先释放、注册后完成 → 注册完成时立刻释放，不漏', async () => {
  /** 手动控制注册完成时机。 */
  let finishRegistration;
  const register = () =>
    new Promise((resolve) => {
      finishRegistration = resolve;
    });
  const { ctx, record } = makeCtx({ register });
  const config = sampleConfig('commander');

  const pending = applyCommander(ctx, config);
  // 注册还没完成就先卸载（作用域销毁）。
  const { disposer } = record.disposers[0];
  await disposer();
  assert.equal(record.released, undefined, '注册没完成时还不能释放');

  // 注册此刻完成 —— 应该立刻释放，而不是把 preset 留在注册表里。
  finishRegistration(async () => {
    record.released = (record.released ?? 0) + 1;
  });
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(record.released, 1, '注册晚于卸载时也要释放');
});

test('注册失败只记 warning，不抛（模式自己还要能起）', async () => {
  const { ctx, record } = makeCtx({
    register: () => Promise.reject(new Error('Duplicate agent preset: commander')),
  });
  await assert.doesNotReject(() => applyCommander(ctx, sampleConfig('commander')));
  assert.equal(record.warnings.length, 1);
  const [label] = record.warnings[0];
  assert.match(String(label), /preset-commander/u);
});

// ---------------------------------------------------------------- 边界 ---

test('config 缺失或 id 为空时用 unnamed 记日志，不抛', async () => {
  for (const config of [undefined, {}, { plugins: [] }, { id: '   ', plugins: [] }]) {
    const { ctx, record } = makeCtx();
    await assert.doesNotReject(() => declarePreset(ctx, config, 'preset-x'));
    assert.equal(record.disposers.length, 1);
    assert.match(String(record.disposers[0].label), /unnamed/u);
  }
});
