/**
 * 插件级测试：用 mock 的 Cordis 上下文驱动真正的 `apply()`。
 *
 * 这里证明三件单元测试证明不了的事：
 *
 * 1. **接线是对的** —— prompt section、skill、以及 `tools/pre-execute` 监听器都真的
 *    注册上了，而且用的是约定的名字与 order。
 * 2. **监听器的契约是对的** —— 拒绝时返回决策，放行时**调用 `next()`**。第二点尤其
 *    重要：waterfall 里直接返回 `{ kind: 'allow' }` 会短路掉后面的监听器（包括用户
 *    审批那道门），那是绕过安全检查，不是放行。
 * 3. **门禁自己出错时不弄挂工具调用** —— 抛错一律降级为放行。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, SECTION_NAME, SECTION_ORDER } from '../index.js';

// ---------------------------------------------------------------- 夹具 ---

/** 一个 Cordis 上下文的替身，记录插件注册了什么。 */
function makeCtx({ withSkills = true } = {}) {
  const record = { sections: [], skills: [], listeners: [], warnings: [], effects: [] };
  const ctx = {
    logger: {
      info: () => {},
      debug: () => {},
      warn: (...args) => record.warnings.push(args.map(String).join(' ')),
    },
    systemPrompt: {
      section: (definition) => {
        record.sections.push(definition);
        return () => {};
      },
    },
    on: (event, listener) => {
      record.listeners.push({ event, listener });
      return () => {};
    },
    effect: (callback) => {
      record.effects.push(callback);
      return callback();
    },
  };
  if (withSkills) {
    ctx.inject = (dependencies, callback) => {
      const services = {};
      for (const dependency of dependencies) {
        services[dependency] = {
          register: (definition) => {
            record.skills.push(definition);
            return () => {};
          },
        };
      }
      callback({ ...services, effect: (callback_) => callback_(), logger: ctx.logger });
    };
  }
  return { ctx, record };
}

/** 跑一次 apply，返回记录。 */
function boot(config = {}, ctxOptions = {}) {
  const { ctx, record } = makeCtx(ctxOptions);
  apply(ctx, config);
  return record;
}

/** 取 `tools/pre-execute` 的监听器。 */
function preExecute(record) {
  const entry = record.listeners.find((item) => item.event === 'tools/pre-execute');
  assert.ok(entry, '没有注册 tools/pre-execute 监听器');
  return entry.listener;
}

/** 一个 Lead agent。 */
const LEAD = { id: 'session-lead', session: { header: { id: 'session-lead' } } };

/** 一个 teammate。 */
const TEAMMATE = {
  id: 'session-child',
  session: { header: { id: 'session-child', parentSession: 'session-lead', origin: 'subagent', delegationDepth: 1 } },
};

/** 一个总是被调用到的 `next()`，记录自己被调了几次。 */
function spyNext(value = { kind: 'allow' }) {
  const calls = { count: 0 };
  const next = () => {
    calls.count += 1;
    return Promise.resolve(value);
  };
  return { next, calls };
}

// ---------------------------------------------------------------- 接线 ---

test('注册了指挥者 prompt section，名字与 order 是约定的', () => {
  const record = boot();
  assert.equal(record.sections.length, 1);
  assert.equal(record.sections[0].name, SECTION_NAME);
  assert.equal(record.sections[0].order, SECTION_ORDER);
  assert.equal(SECTION_NAME, 'commander:mode');
  // 排在 team 策略（600）之后、工具指导块之前。
  assert.equal(SECTION_ORDER, 650);
});

test('section 文本每次求值都是完整的指挥者协议', () => {
  const record = boot();
  const text = record.sections[0].text({ agent: LEAD });
  assert.ok(typeof text === 'string' && text.length > 500);
  assert.ok(text.includes('指挥者'));
  assert.ok(text.includes('ask_user_question'));
});

test('注册了 commander-mode skill', () => {
  const record = boot();
  assert.equal(record.skills.length, 1);
  assert.equal(record.skills[0].name, 'commander-mode');
  assert.equal(record.skills[0].source, 'runtime');
  assert.ok(record.skills[0].content.includes('指挥者'));
  assert.deepEqual(record.skills[0].invocation, { modelInvocable: true, userInvocable: true });
});

test('registerSkill: false 时不注册 skill', () => {
  assert.equal(boot({ registerSkill: false }).skills.length, 0);
});

test('没有 skills 服务的部署里不炸', () => {
  // 可选依赖：缺了就不注册，而不是让插件整个不激活。
  const record = boot({}, { withSkills: false });
  assert.equal(record.skills.length, 0);
  assert.equal(record.sections.length, 1);
  assert.equal(record.listeners.length, 1);
});

test('注册了 tools/pre-execute 监听器', () => {
  const record = boot();
  assert.deepEqual(record.listeners.map((item) => item.event), ['tools/pre-execute']);
});

// ---------------------------------------------------------------- 监听器 ---

test('指挥者自己调用 write 会被拒绝', async () => {
  const listener = preExecute(boot());
  const { next, calls } = spyNext();
  const decision = await listener({ name: 'write', agent: LEAD }, next);
  assert.equal(decision.kind, 'deny');
  assert.ok(decision.reason.includes('write'));
  assert.equal(calls.count, 0, '拒绝时不该调用 next');
});

test('放行时必须走 next()，不能自己返回 allow', async () => {
  // 直接返回 { kind: 'allow' } 会短路掉后面的监听器（含用户审批门禁）——那是绕过安全检查。
  const listener = preExecute(boot());

  for (const exec of [
    { name: 'read', agent: LEAD },
    { name: 'write', agent: TEAMMATE },
    { name: 'spawn_teammate', agent: LEAD },
  ]) {
    const { next, calls } = spyNext();
    const decision = await listener(exec, next);
    assert.deepEqual(decision, { kind: 'allow' });
    assert.equal(calls.count, 1, `${exec.name} 应当放行并调用 next`);
  }
});

test('teammate 写文件必须放行（否则子代理干不了活）', async () => {
  const listener = preExecute(boot());
  for (const name of ['write', 'edit', 'pwsh', 'bash']) {
    const { next, calls } = spyNext();
    const decision = await listener({ name, agent: TEAMMATE }, next);
    assert.equal(decision.kind, 'allow');
    assert.equal(calls.count, 1);
  }
});

test('blockedTools 可以收窄或放宽', async () => {
  const custom = preExecute(boot({ blockedTools: ['pwsh'] }));
  assert.equal((await custom({ name: 'pwsh', agent: LEAD }, () => Promise.resolve({ kind: 'allow' }))).kind, 'deny');
  assert.equal(
    (await custom({ name: 'write', agent: LEAD }, () => Promise.resolve({ kind: 'allow' }))).kind,
    'allow',
    'write 不在自定义清单里，应当放行',
  );

  const off = preExecute(boot({ blockedTools: [] }));
  assert.equal((await off({ name: 'write', agent: LEAD }, () => Promise.resolve({ kind: 'allow' }))).kind, 'allow');
});

test('没有派发工具时放行，避免会话死锁', async () => {
  const listener = preExecute(boot());
  // Lead 自己的 scope 里一个派发工具都没有 —— 既不能自己动手又没法派活 = 死锁。
  const strandedLead = {
    id: 'session-lead',
    session: { header: { id: 'session-lead' } },
    ctx: { tools: { schemas: () => [{ name: 'read' }, { name: 'write' }] } },
  };
  const { next, calls } = spyNext();
  const decision = await listener({ name: 'write', agent: strandedLead }, next);
  assert.equal(decision.kind, 'allow');
  assert.equal(calls.count, 1);
});

test('agent 自己的 scope 里有 spawn_teammate 时照常拦截', async () => {
  const listener = preExecute(boot());
  const normalLead = {
    id: 'session-lead',
    session: { header: { id: 'session-lead' } },
    ctx: { tools: { schemas: () => [{ name: 'spawn_teammate' }, { name: 'read' }, { name: 'write' }] } },
  };
  const { next } = spyNext();
  const decision = await listener({ name: 'write', agent: normalLead }, next);
  assert.equal(decision.kind, 'deny');
});

test('监听器自己出错时放行，而不是让工具调用失败', async () => {
  const record = boot();
  const listener = preExecute(record);
  const hostile = {
    id: 'session-lead',
    get session() {
      throw new Error('boom');
    },
  };
  const { next, calls } = spyNext();
  const decision = await listener({ name: 'write', agent: hostile }, next);
  assert.equal(decision.kind, 'allow');
  assert.equal(calls.count, 1);
  // 出错路径不应当被记成 warning —— 身份读不出来是预期内的降级，不是异常。
  assert.deepEqual(record.warnings, []);
});

test('exec 形状异常时不炸', async () => {
  const listener = preExecute(boot());
  for (const exec of [undefined, null, {}, { name: undefined }, { name: 42 }, 'nope']) {
    const { next, calls } = spyNext();
    const decision = await listener(exec, next);
    assert.equal(decision.kind, 'allow');
    assert.equal(calls.count, 1);
  }
});

test('没有 next 时返回 undefined，不冒充 allow', async () => {
  // 放行路径上必须把决定权交回链上（返回 undefined），而不能自己造一个
  // `{ kind: 'allow' }` —— 那会短路掉后面的监听器（含用户审批门禁）。
  const listener = preExecute(boot());
  assert.equal(await listener({ name: 'read', agent: LEAD }, undefined), undefined);
  // 拒绝路径不依赖 next：判定成立就直接返回决策。
  assert.equal((await listener({ name: 'write', agent: LEAD }, undefined)).kind, 'deny');
});

// ---------------------------------------------------------------- 配置 ---

test('未知配置键会被报出来', () => {
  const record = boot({ nope: 1 });
  assert.ok(record.warnings.some((line) => line.includes('未知配置键')));
});

test('非数组的 blockedTools 会被报出来并回退到默认清单', async () => {
  const record = boot({ blockedTools: 'write' });
  assert.ok(record.warnings.some((line) => line.includes('blockedTools')));
  const listener = preExecute(record);
  assert.equal((await listener({ name: 'write', agent: LEAD }, () => Promise.resolve({ kind: 'allow' }))).kind, 'deny');
});
