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
 * 1. 语义与随附声明器一致：`agentPresets.register(config)` 收到**完整**的 preset 定义；
 *    3.7.0 起 `plugins` 由各声明模块从 `lib/preset-plugins.js` 注入（YAML 只给
 *    `{ id, name, description, order }`），所以 `Config` 里 `plugins` 是**可选**的；
 * 2. 卸载时释放：`ctx.effect` 的 disposer 必须调用 `unregister`；
 * 3. 注册晚于卸载（竞态）：effect 先释放、注册后完成时，仍要立刻调 unregister，不能漏；
 * 4. 注册失败只记 warning，不抛（模式自己还要能起）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  PresetDeclarationConfig,
  declarePreset,
} from '../lib/preset-declaration.js';
import { CAPABILITY_ROWS } from '../lib/capabilities.js';
import { apply as applyCommander, name as commanderName, packageSkillsDir } from '../preset-commander.js';

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

/** 与本包 patch 同形的 config（3.7.0 起只有声明元数据，没有 plugins）。 */
function sampleConfig(id) {
  return {
    id,
    name: id === 'commander' ? '指挥者模式' : '项目经理模式',
    description: '测试用描述',
    order: id === 'commander' ? 7 : 8,
  };
}

// ---------------------------------------------------------------- 配置形状 ---

test('Config：id 必填，plugins 可选（3.7.0 起由声明模块注入）', () => {
  const parsed = PresetDeclarationConfig(sampleConfig('commander'));
  assert.equal(parsed.id, 'commander');
  assert.equal(parsed.order, 7);
  // schemastery 给可选数组补默认值 `[]`；调用方（声明模块）随后用自己拼装的列表覆盖它。
  assert.deepEqual(parsed.plugins, [], 'YAML 不提供 plugins 时是空数组');
  // id 必填：缺了直接拒绝（声明器不该猜）。
  assert.throws(() => PresetDeclarationConfig({ name: 'x' }));
  // plugins 可选：这是 3.7.0 的关键变化——YAML 不写它也能通过 schema，
  // 否则两个模式行会被 schema 挡下、整个模式不激活。
  assert.doesNotThrow(() => PresetDeclarationConfig({ id: 'x' }));
  // 但给了就必须是数组（防手写 YAML 写错形状）。
  assert.throws(() => PresetDeclarationConfig({ id: 'x', plugins: 'nope' }));
});

// ---------------------------------------------------------------- 注册 ---

test('5.0.0：声明模块注入 plugins（能力行 + 模式行 + 可选工作流行）', async () => {
  const { ctx, record } = makeCtx();
  const config = sampleConfig('commander');
  await applyCommander(ctx, config);
  assert.equal(record.registrations.length, 1, '应注册一次');
  const definition = record.registrations[0];
  assert.equal(definition.id, 'commander');
  assert.equal(definition.order, config.order);
  assert.equal(definition.name, config.name);
  // plugins 不再来自 YAML，而是由 lib/preset-plugins.js 拼装：
  // 能力行（18）+ 模式行 + 可选工作流行。
  assert.equal(definition.plugins.length, CAPABILITY_ROWS.length + 2, '行数不对');
  assert.deepEqual(
    definition.plugins.slice(-2).map((entry) => entry.id),
    ['commander-mode-agent', 'project-dev-workflow'],
    '模式行与工作流行应在最后',
  );
  assert.equal(record.disposers.length, 1, '应挂一个 effect');
  assert.equal(record.disposers[0].label, 'preset-commander: preset commander');
});

test('5.0.0：统一模式的 skill-filesystem 带本包 skills/ 目录', async () => {
  const skillsDir = packageSkillsDir();
  assert.ok(typeof skillsDir === 'string' && (skillsDir.endsWith('skills\\') || skillsDir.endsWith('skills/')), `skills 目录应存在：${skillsDir}`);

  const { ctx, record } = makeCtx();
  await applyCommander(ctx, sampleConfig('commander'));
  const skillFs = record.registrations[0].plugins.find((entry) => entry.id === 'skill-filesystem');
  assert.deepEqual(skillFs.config, { customSkillDirs: [skillsDir] });
});

test('插件名稳定（Loader 诊断与测试都依赖它）', () => {
  assert.equal(commanderName, 'preset-commander-declaration');
});

test('3.7.0：cordis.patch.yml 里两个 preset 的 config 能通过声明器 schema', () => {
  // 真实 Loader 在 apply 之前会拿导出的 Config 校验本行 config。YAML 只写元数据之后，
  // 这里用一个最小逐行解析还原出 config，跑一遍 schema —— 挡住"手写 YAML 漏键 / 写错类型
  // → 整个模式不激活"这类只有真实加载才暴露的问题（headless 沙箱不绑 preset，测不到）。
  const patch = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const blockOf = (presetId) => {
    const start = patch.indexOf(`    - id: ${presetId}\n`);
    assert.ok(start >= 0, `找不到 ${presetId}`);
    const next = patch.slice(start + 1).search(/\n {4}- id: /u);
    return patch.slice(start, next < 0 ? patch.length : start + 1 + next);
  };
  for (const [presetId, expectedId] of [
    ['preset-commander', 'commander'],
  ]) {
    const block = blockOf(presetId);
    /** 取 `config:` 下 8 空格缩进的标量值。 */
    const field = (key) => new RegExp(`\\n {8}${key}: (.+)\\n`, 'u').exec(block)?.[1]?.trim();
    const config = {
      id: field('id'),
      name: field('name'),
      description: field('description'),
      order: Number(field('order')),
    };
    assert.equal(config.id, expectedId, `${presetId} 的 config.id 不对`);
    assert.ok(Number.isInteger(config.order), `${presetId} 的 order 必须是整数`);
    assert.doesNotThrow(() => PresetDeclarationConfig(config), `${presetId} 的 config 过不了 schema`);
    // plugins 不写 —— 由声明模块注入。
    assert.equal(field('plugins'), undefined, `${presetId} 不应在 YAML 里写 plugins`);
  }
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
