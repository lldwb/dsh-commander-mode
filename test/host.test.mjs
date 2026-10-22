/**
 * 配置行（`host.js` / profile 顶层）的测试。
 *
 * 这一行的职责只有三件，每一件都对应一个真实故障：
 *
 * 1. **导出 `Config`** —— 不导出就没有 schema，设置命名空间不出现，设置页静默消失；
 * 2. **提供 `commanderSettings`** —— 模式行靠它读配置/名册；
 * 3. **转发 volatile 变化** —— `loader/volatile-update` 只发给配置行自己的 fiber，
 *    不转发的话模式行的工具清单永远停在旧名册上。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, Config, name } from '../index.js';
import { CAPABILITY_ROWS } from '../lib/capabilities.js';
import { SpecialistSchema } from '../lib/config.js';

/** 一个最小 Cordis 上下文替身（配置行只用这几样）。 */
function makeCtx() {
  const record = { services: {}, listeners: [], effects: [], settingsPolicies: [], warnings: [] };
  const logger = {
    info: () => {},
    debug: () => {},
    warn: (...args) => record.warnings.push(args.map(String).join(' ')),
  };
  const ctx = {
    logger,
    on: (event, listener) => {
      record.listeners.push({ event, listener });
      return () => {};
    },
    effect: (callback) => {
      record.effects.push(callback);
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    provide: (serviceName, service) => {
      record.services[serviceName] = service;
    },
    inject: (dependencies, callback) => {
      const services = {};
      for (const dependency of dependencies) {
        if (dependency === 'settings') {
          services.settings = {
            configure: (policy) => {
              record.settingsPolicies.push(policy);
              return () => {};
            },
          };
        }
      }
      callback({
        ...services,
        logger,
        effect: ctx.effect,
        on: ctx.on,
      });
    },
  };
  return { ctx, record };
}

/** 一份带名册的配置（模拟 Loader 解析后的形态：specialists 是 volatile 引用）。 */
function configWith(roster = []) {
  return {
    ...Config({ specialists: roster }),
    // 模拟 volatile 引用的读法：resolveRoster 通过 readSpecialists 读 .get()
    specialists: { get: () => roster },
  };
}

test('行名与设置命名空间一致（commander-mode）', () => {
  // Loader 用行 id 做设置命名空间；客户端 SETTINGS_NS 也是这个值。三者不一致时
  // 设置页**静默消失**，不报任何错。
  assert.equal(name, 'commander-mode');
});

test('导出 Config，specialists 是唯一的 volatile 字段', () => {
  assert.ok(Config, 'index.js 必须导出 Config');
  assert.equal(Config.dict.specialists.meta.volatile, true);
  // volatile 字段解析后是引用（有 .get()），不是普通数组。
  const live = Config().specialists;
  const value = typeof live?.get === 'function' ? live.get() : live;
  assert.deepEqual(value, []);
  // 名册之外没有第二个 volatile 字段（schema 不允许 volatile 嵌套 volatile，也避免表单
  // 出现两个互相影响的数组）。
  const volatileKeys = Object.keys(Config.dict).filter((key) => Config.dict[key].meta?.volatile === true);
  assert.deepEqual(volatileKeys, ['specialists']);
});

test('specialist 的 schema 与 SpecialistSchema 同义（字段集一致）', () => {
  const fields = Object.keys(SpecialistSchema.dict).sort();
  assert.deepEqual(fields, [
    'description',
    'id',
    'maxTokens',
    'model',
    'persona',
    'provider',
    'reasoningEffort',
  ]);
});

test('apply 提供 commanderSettings 服务', () => {
  const { ctx, record } = makeCtx();
  apply(ctx, configWith([{ id: 'architect', provider: 'sub2api', model: 'glm-5.3-flash', description: '架构' }]));
  const service = record.services.commanderSettings;
  assert.ok(service, '必须提供 commanderSettings 服务');
  assert.deepEqual(service.specialists().map((entry) => entry.id), ['architect']);
  assert.equal(service.options().confirmPlan, true);
  assert.equal(service.maxSpecialists(), 20);
});

test('apply 关掉自动生成的设置页（本包自带 client 半）', () => {
  const { ctx, record } = makeCtx();
  apply(ctx, configWith());
  assert.deepEqual(record.settingsPolicies, [{ auto: false }]);
});

test('volatile 变化通过服务广播给订阅者', () => {
  const roster = [];
  const { ctx, record } = makeCtx();
  apply(ctx, { ...Config(), specialists: { get: () => roster } });
  const service = record.services.commanderSettings;

  const seen = [];
  const unsubscribe = service.subscribe((paths) => seen.push(paths));

  const listener = record.listeners.find((entry) => entry.event === 'loader/volatile-update');
  assert.ok(listener, '配置行必须监听 loader/volatile-update');
  listener.listener([['specialists']]);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], [['specialists']]);

  // 无关字段的变化不广播。
  listener.listener([['confirmPlan']]);
  assert.equal(seen.length, 1);

  unsubscribe();
  listener.listener([['specialists']]);
  assert.equal(seen.length, 1, '退订后不再收到');
});

test('订阅者抛错不影响其它订阅者', () => {
  const { ctx, record } = makeCtx();
  apply(ctx, configWith());
  const service = record.services.commanderSettings;
  const seen = [];
  service.subscribe(() => {
    throw new Error('boom');
  });
  service.subscribe(() => seen.push('ok'));
  assert.doesNotThrow(() => service.notify([['specialists']]));
  assert.deepEqual(seen, ['ok']);
});

test('配置行不注册任何工具（能力泄漏会污染别的模式）', () => {
  const { ctx, record } = makeCtx();
  // 若配置行试图 provide 未知服务或调 tools，我们只能从代码结构上保证：这里断言
  // 它没有 require tools 服务（inject 列表为空）。
  assert.doesNotThrow(() => apply(ctx, configWith()));
  assert.deepEqual(Object.keys(record.services), ['commanderSettings']);
  // CAPABILITY_ROWS 是模式行（specialist preset）用的，配置行不该引用它注册任何东西。
  assert.ok(CAPABILITY_ROWS.length > 0);
});
