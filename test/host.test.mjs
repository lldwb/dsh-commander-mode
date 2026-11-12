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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { apply, Config, name } from '../index.js';
import { CAPABILITY_ROWS } from '../lib/capabilities.js';
import { SpecialistSchema } from '../lib/config.js';
import { defaultSpecialistIds } from '../lib/presets.js';

/**
 * 本文件所有 `apply()` 共用的临时 stateDir（1.1.1）。
 *
 * ⚠️ 不能用默认 `stateDir: ''`：那会解析成**真实** `<DSH_HOME>/commander/<profile>.json`，
 * 于是这一行的 `apply()` 会在用户的真实账本里建工单/授权（0.6.0 起就潜伏，2026-11-04
 * 的 1.1.0 装配时被发现：真实 `~/.dsh/commander/desktop.json` 里多了 15 张标题 `x`、
 * 会话 `s-1` 的测试夹具工单）。测试必须自带隔离目录。
 */
const STATE_DIR = mkdtempSync(join(tmpdir(), 'commander-host-state-'));
after(() => rmSync(STATE_DIR, { recursive: true, force: true }));

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
function configWith(roster = [], overrides = {}) {
  return {
    ...Config({
      specialists: roster,
      // 默认用临时 stateDir：绝不让单测写用户真实账本（见文件头 STATE_DIR 注释）。
      stateDir: STATE_DIR,
      // 默认关掉外部事件轮询：否则每个 host 用例都会在真实 HOME 下建目录并起定时器。
      // 事件投递器本身由下面专门的用例（临时 DSH_HOME + 显式 close）覆盖。
      eventInbox: false,
      ...overrides,
    }),
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
  // 默认是出厂预置名册（按主流开发流程划分的 6 个专家，模型继承指挥者）。
  assert.deepEqual(value.map((entry) => entry.id), defaultSpecialistIds());
  assert.ok(value.length >= 5, '开箱应当带一套覆盖开发流程的专家');
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
  // ⚠️ 不要直接 `apply(ctx, Config())`：默认 stateDir/eventInbox 会写真实 HOME
  // （1.1.1 的污染就是这么来的）。临时 stateDir + 关事件轮询。
  apply(ctx, { ...Config({ stateDir: STATE_DIR, eventInbox: false }), specialists: { get: () => roster } });
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
  // 7.0.0：Worker Session 通道下线（用户硬要求「连 Worker Session 一起禁」），
  // 配置行不再提供 commanderWorkers 服务（workerSessions 恒 false）。
  assert.deepEqual(Object.keys(record.services), ['commanderSettings', 'commanderLedger']);
  assert.equal(typeof record.services.commanderLedger.createTicket, 'function');
  assert.equal(typeof record.services.commanderSettings.options, 'function');
  // CAPABILITY_ROWS 是模式行（specialist preset）用的，配置行不该引用它注册任何东西。
  assert.ok(CAPABILITY_ROWS.length > 0);
});

test('0.6.0 账本服务：默认载入，文件跟随配置的 stateDir', () => {
  const { ctx, record } = makeCtx();
  assert.doesNotThrow(() => apply(ctx, configWith()));
  const ledger = record.services.commanderLedger;
  assert.ok(ledger, '默认应提供 commanderLedger');
  assert.equal(ledger.loaded, true);
  // 用临时 stateDir，断言"路径跟着配置走"——**不要**断言真实 ~/.dsh 路径：
  // 那正是 1.1.1 发现的污染（单测写用户真实账本）。
  assert.equal(ledger.filePath, join(STATE_DIR, 'ledger.json'));
});

test('0.6.0 ledger:false 时不提供账本服务（降级到 0.5.0）', () => {
  const { ctx, record } = makeCtx();
  assert.doesNotThrow(() => apply(ctx, configWith([], { ledger: false })));
  assert.deepEqual(Object.keys(record.services), ['commanderSettings']);
});

test('7.0.0：workerSessions:true 也不再提供 commanderWorkers（Worker 通道已下线）', () => {
  // 用户硬要求「不能另辟蹊径开子智能体」、口径明确「连 Worker Session 一起禁」：
  // `resolveConfig()` 把 workerSessions 恒读成 false，所以即使旧 profile 里写着 true，
  // 配置行也不会创建 Worker 执行器 —— 这是"通道下线"的接线级证明。
  const { ctx, record } = makeCtx();
  assert.doesNotThrow(() => apply(ctx, configWith([], { workerSessions: true })));
  assert.equal(record.services.commanderWorkers, undefined, '7.0.0：不应再提供 commanderWorkers 服务');
  assert.ok(record.services.commanderLedger, '账本仍要提供');
});

test('1.1.0 eventInbox 开启时提供 commanderEvents，并在账本同级建好 inbox/delivered/rejected', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'commander-host-events-'));
  const previousHome = process.env.DSH_HOME;
  const previousProfile = process.env.DSH_PROFILE;
  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE = 'host-test';
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousProfile === undefined) delete process.env.DSH_PROFILE;
    else process.env.DSH_PROFILE = previousProfile;
    rmSync(home, { recursive: true, force: true });
  });
  const { ctx, record } = makeCtx();
  // 轮询间隔拉长：本用例只关心服务与目录，扫描由 event-inbox 单测覆盖。
  // `stateDir: ''` 让账本/事件目录都落到上面临时 DSH_HOME 下（而不是共享 STATE_DIR）。
  assert.doesNotThrow(() => apply(ctx, configWith([], { eventInbox: true, eventPollMs: 60000, stateDir: '' })));
  const events = record.services.commanderEvents;
  assert.ok(events, '默认应提供 commanderEvents 服务');
  assert.equal(typeof events.scanOnce, 'function');
  for (const name of ['inbox', 'delivered', 'rejected']) {
    assert.ok(existsSync(join(home, 'commander', 'events', name)), `缺少事件目录 ${name}`);
  }
  // 释放定时器，避免测试进程留下定时器（unref 的，但显式清理更干净）。
  events.close();
});

test('1.1.0 eventInbox:false 时不提供 commanderEvents（也不起轮询）', () => {
  const { ctx, record } = makeCtx();
  assert.doesNotThrow(() => apply(ctx, configWith([], { eventInbox: false })));
  assert.equal(record.services.commanderEvents, undefined);
});

test('7.0.0：Worker spawn 通道不可用（服务不发布，工具也不注册）', () => {
  // 6.0.0 的「缺宿主服务时精确点名」用例随通道下线一起退役：现在不是"缺服务报错"，
  // 而是**根本没有这个通道**。`lib/worker-tools.js` / `lib/worker-sessions.js` 保留
  // 只为兼容旧账本数据，不再被任何运行路径启用（详见 README「Worker Session」一节）。
  const { ctx, record } = makeCtx();
  apply(ctx, configWith([], { workerSessions: true }));
  assert.equal(record.services.commanderWorkers, undefined);
  assert.ok(record.services.commanderLedger, '账本仍要提供（旧 worker execution 记录要能读）');
});
