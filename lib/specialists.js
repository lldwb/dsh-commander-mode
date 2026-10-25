/**
 * 可配置的多模型 specialist 名册 —— 从配置到「每个 specialist 一个子代理工具」。
 *
 * ## 形态
 *
 * 名册里每一项最终变成两样东西：
 *
 * 1. 一个**独立 agent preset**（`commander-specialist-<id>-<hash>`），内含本插件
 *    `./specialist` 行注入的人设与纪律，以及一份完整的能力行（preset 是完整组合，
 *    漏了就得到没有文件系统/shell 的 agent）。
 * 2. 一个**模型工具** `subagent_<id>`：前台调用，把任务派给绑定了该 specialist
 *    provider/model 的子代理，等它结算后把最终答复带回来。
 *
 * ## 为什么是自实现，而不是 import `@deepseek-ai/dsh-tool-subagent`
 *
 * 实测（2026-10，dsh 0.2.1-rc.2，`dsh plugin add` 用 `link:` 安装）：
 * profile 插件的模块内部 ESM `import` 从**真实目录**向上解析，真实 profile 的
 * `profiles/node_modules` 拦截层不在链上，所以 `ERR_MODULE_NOT_FOUND`。要 import 就得
 * `pnpm add` 29 个随附包（还带第二份 cordis），与 dsh 版本强绑定。
 *
 * 所以这里用 `ctx.tools.register()`（编译后的 JSON Schema）+ `ctx.subagents.startActivation()`
 * 自己实现前台委派，保持**零随附包依赖**。契约抄自随附 `dsh-tool-subagent` 的 `execute`：
 *
 * ```js
 * request = { prompt: [{type:'text', text}], parent, agentPreset, agentOptions, maxDepth }
 * startActivation({ provider, label, request, signal, delivery: 'caller' })
 * // → { childId, messageId?, result, dispose }
 * const settled = await result   // { output: blocks[], stopReason, structured? }
 * ```
 *
 * `delivery: 'caller'` 是前台语义：结果由调用方消费，**不**往父会话注入 completion
 * notice（那是后台模式）。
 *
 * ## 为什么工具名是 `subagent_<id>`
 *
 * 与参考实现（dsh-multi-model-orchestrator）一致，也让模型一眼看出"这是派给某个
 * specialist 的通道"，而不是又一个普通工具。
 *
 * @module dsh-commander-mode/lib/specialists
 */

import { createHash } from 'node:crypto';

import { CAPABILITY_ROWS, specialistPresetPlugins } from './capabilities.js';
import { readMaxSpecialists, readSpecialists } from './config.js';

/** specialist 人设行的模块名（本包的 `./specialist` 出口）。 */
export const SPECIALIST_ROW_NAME = 'dsh-commander-mode/specialist';

/**
 * 工具名的后缀规则：`subagent_<id>`。
 *
 * @param {string} id - specialist id。
 * @returns {string} 工具名。
 */
export function specialistToolName(id) {
  return `subagent_${id}`;
}

/**
 * 名册条目的稳定指纹：id + 影响子代理行为的字段。
 *
 * 其中 `description` 与 `persona` 都**真的会进入 preset 内容**（前者是 preset 的展示描述、
 * 也会拼进人设首行；后者是附加人设），所以必须计入 —— 否则"只改了职责描述"会让新配置
 * 复用旧 preset id，撞上 `agentPresets.register()` 的 duplicate 检查。
 *
 * @param {object} specialist - 已清洗的名册项。
 * @returns {string} 8 位十六进制指纹。
 */
export function specialistFingerprint(specialist) {
  const material = [
    specialist.id,
    specialist.provider,
    specialist.model,
    specialist.reasoningEffort ?? '',
    specialist.maxTokens ?? '',
    specialist.description ?? '',
    specialist.persona ?? '',
  ].join('\u0000');
  return createHash('sha256').update(material).digest('hex').slice(0, 8);
}

/**
 * 该 specialist 的 agent preset id。
 *
 * 加指纹是因为 `agentPresets.register()` 不允许重复 id：重建时可能有一个旧 revision
 * 尚未释放，指纹让"配置变了"和"还没释放"两件事不会撞车。
 *
 * @param {object} specialist - 已清洗的名册项。
 * @returns {string} preset id。
 */
export function specialistPresetId(specialist) {
  return `commander-specialist-${specialist.id}-${specialistFingerprint(specialist)}`;
}

/**
 * specialist 的人设与纪律文本。
 *
 * 这段文字会通过 `./specialist` 行注入到该 specialist 的 system prompt。它必须让子代理
 * 明确三件事：它是被派来的执行者、一次只做一件内聚的事、以及怎么回报。
 *
 * @param {object} specialist - 已清洗的名册项。
 * @returns {string} 人设文本。
 */
export function renderSpecialistPersona(specialist) {
  const lines = [
    `你是「${specialist.id}」（${specialist.description}），由指挥者派活的开发 specialist。`,
    '',
    '## 你的职责',
    '',
    '你独占一个内聚任务与一个验收目标，直到它完成或结算。在你的范围内：先读懂相关代码再改，只做聚焦的改动，',
    '跑覆盖你改动的检查，最后向指挥者报告：改了哪些文件、跑了什么命令与结果、风险与遗留。',
    '',
    '## 边界',
    '',
    '- **超出这次派活的独立任务不要顺手做**：如果你发现派活里混进了多个独立或互相重叠的任务，先向指挥者报告范围冲突，不要动手。',
    '- **任务与你的定位差距大时先报告，不要硬做**：如果你被派来的任务在领域、产出类型或所需技能上明显不属于职责里写的范围'
      + '（例如你负责代码审查，却被派去做依赖漏洞扫描或资料调研），先说明"任务与我的定位不符"，'
      + '并给出你认为合适的定位，让指挥者改派给匹配的执行者或新开一个子智能体。'
      + '**不要**自行扩大范围、不要勉强接单、也不要沉默地按自己的理解做。',
    '- 不要扮演指挥者、不要再把活派给别的 agent —— 你的委派深度预算只够你自己。',
    '- 必要检查失败时，**不要**声称完成。',
    '',
    '## 可靠性',
    '',
    '- 同一个工具或执行协议错误连续出现两次后，改用最简单的有效替代调用，或直接报告阻塞；不要继续重复失败或没有有效输出的调用。',
    '- 报告要能被指挥者直接验收：文件路径、命令、结果、风险，一个都不能少。',
  ];
  if (typeof specialist.persona === 'string' && specialist.persona.trim() !== '') {
    lines.push('', '## 附加人设', '', specialist.persona.trim());
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- 名册 ---

/** 非空字符串（trim 后）。 */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 清洗名册：去重、trim、丢弃缺必填项的条目、按上限截断。
 *
 * 设置页会先做一遍校验，但 Host 半必须自己兜底 —— 配置也可能来自 profile patch 手写。
 *
 * @param {unknown} entries - 原始名册（可能不可信）。
 * @param {object} [options] - 清洗选项。
 * @param {number} [options.maxSpecialists] - 上限（0 表示禁用名册）。
 * @param {{ warn: Function }} [options.logger] - 记录被丢弃条目的日志器。
 * @returns {object[]} 清洗后的名册。
 */
export function normalizeRoster(entries, options = {}) {
  const maxSpecialists = Number.isSafeInteger(options.maxSpecialists) && options.maxSpecialists >= 0 ? options.maxSpecialists : 20;
  if (!Array.isArray(entries) || maxSpecialists === 0) return [];

  const seen = new Set();
  const roster = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!/^[a-z][a-z0-9_-]{0,47}$/u.test(id)) {
      options.logger?.warn?.('commander-mode: 名册条目 id "%s" 非法，已跳过', String(entry.id));
      continue;
    }
    if (seen.has(id)) {
      options.logger?.warn?.('commander-mode: 名册里 id "%s" 重复，保留第一个', id);
      continue;
    }
    const provider = nonEmpty(entry.provider) ? entry.provider.trim() : '';
    const model = nonEmpty(entry.model) ? entry.model.trim() : '';
    const description = nonEmpty(entry.description) ? entry.description.trim() : '';
    if (description === '') {
      options.logger?.warn?.('commander-mode: 名册条目 "%s" 缺 description（定位），已跳过', id);
      continue;
    }
    // provider/model 两栏要么都空、要么都填：
    // - 都空 = 继承指挥者（父会话）的模型路由（出厂预置名册就是这种形态）；
    // - 只填一栏 = 路由不完整，无法构造 agentOptions，跳过并警告。
    const routeProvided = provider !== '' && model !== '';
    if (!routeProvided && (provider !== '' || model !== '')) {
      options.logger?.warn?.(
        'commander-mode: 名册条目 "%s" 的 provider/model 只填了一栏（要么都填、要么都留空=继承指挥者模型），已跳过',
        id,
      );
      continue;
    }
    // 上限检查放在合法性校验**之后**：否则一条本来就会被丢弃的坏条目也会触发
    // "名册超过上限"的警告，让用户以为配置超编。
    if (roster.length >= maxSpecialists) {
      options.logger?.warn?.('commander-mode: 名册超过 maxSpecialists=%d，多余的条目被忽略', maxSpecialists);
      break;
    }
    const specialist = { id, provider, model, description };
    if (nonEmpty(entry.persona)) specialist.persona = entry.persona.trim();
    if (nonEmpty(entry.reasoningEffort)) specialist.reasoningEffort = entry.reasoningEffort.trim();
    if (typeof entry.maxTokens === 'number' && Number.isSafeInteger(entry.maxTokens) && entry.maxTokens >= 1) {
      specialist.maxTokens = entry.maxTokens;
    }
    seen.add(id);
    roster.push(specialist);
  }
  return roster;
}

/**
 * 从插件配置里取当前名册。
 *
 * 每次调用都重新读 volatile 引用，所以设置页保存后新调用立刻看到新名册。
 *
 * @param {unknown} config - `apply` 收到的配置对象。
 * @param {object} [options] - 清洗选项。
 * @returns {object[]} 清洗后的名册。
 */
export function resolveRoster(config, options = {}) {
  return normalizeRoster(readSpecialists(config), {
    ...options,
    maxSpecialists: readMaxSpecialists(config),
  });
}

// ---------------------------------------------------------------- preset ---

/**
 * 一个 specialist 的 agent preset 定义（交给 `ctx.agentPresets.register()`）。
 *
 * @param {object} specialist - 已清洗的名册项。
 * @returns {{ id: string, name: string, description: string, plugins: object[] }} preset 定义。
 */
export function specialistPresetDefinition(specialist) {
  return {
    id: specialistPresetId(specialist),
    name: `指挥官 specialist: ${specialist.id}`,
    description: specialist.description,
    plugins: specialistPresetPlugins({
      personaSectionName: SPECIALIST_ROW_NAME,
      persona: renderSpecialistPersona(specialist),
    }),
  };
}

// ---------------------------------------------------------------- 工具 ---

/** 把 activation 的最终输出块压成纯文本。 */
export function outputText(output) {
  if (!Array.isArray(output)) return '';
  const parts = [];
  for (const block of output) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

/** 结果文本的硬上限：子代理可能说很多，指挥者不需要全文。 */
export const MAX_RESULT_CHARS = 12000;

/**
 * 把 `startActivation()` 的结算结果渲染成工具返回值。
 *
 * @param {{ output?: unknown[], stopReason?: string }} settled - activation 的 result。
 * @returns {{ childId: string, stopReason: string, text: string, truncated: boolean }} 工具值。
 */
export function renderSettlement(settled) {
  const stopReason = typeof settled?.stopReason === 'string' ? settled.stopReason : 'unknown';
  let text = outputText(settled?.output).trim();
  if (text === '') {
    text = stopReason === 'completed' ? '（子代理没有留下收尾文本）' : `（子代理没有留下收尾文本；停止原因：${stopReason}）`;
  }
  const truncated = text.length > MAX_RESULT_CHARS;
  if (truncated) text = `${text.slice(0, MAX_RESULT_CHARS)}\n\n…（已截断，原始长度 ${text.length} 字符）`;
  return { childId: '', stopReason, text, truncated };
}

/**
 * 工具的输出 schema。
 *
 * ⚠️ DSH 的 JSON Schema 子集要求 `required` 放在**顶层数组**里，属性内写 `required: true`
 * 会被 `JsonSchemaError` 拒绝（实测）。
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    childId: { type: 'string', description: '本次派发创建的子会话 id。' },
    stopReason: { type: 'string', description: '结算原因：completed / error / 其他适配器取值。' },
    text: { type: 'string', description: '子代理的最终答复文本（可能已截断）。' },
    truncated: { type: 'boolean', description: '答复是否因过长被截断。' },
  },
  required: ['childId', 'stopReason', 'text', 'truncated'],
};

/** 解除一个工具定义时用的空实现（`ctx.tools.register()` 返回 disposer）。 */
function noop() {}

/**
 * 构造一个 specialist 工具定义。
 *
 * @param {object} options - 构造参数。
 * @param {object} options.specialist - 已清洗的名册项。
 * @param {string} options.presetId - 该 specialist 的 agent preset id。
 * @param {() => object | undefined} options.getSubagents - 取 `subagents` 服务（可能晚到）。
 * @param {() => boolean} [options.isEnabled] - 该 specialist 是否仍在当前名册里。
 * @returns {object} 可交给 `ctx.tools.register()` 的定义。
 */
export function buildSpecialistToolDefinition({ specialist, presetId, getSubagents, isEnabled = () => true }) {
  const toolName = specialistToolName(specialist.id);
  // 空路由 = 继承指挥者（父会话）的模型：预置名册不能硬编码 provider/model，
  // 所以默认形态下这里没有 route 文本，也不向 startActivation 传 agentOptions。
  const hasRoute = nonEmpty(specialist.provider) && nonEmpty(specialist.model);
  const route = hasRoute ? `${specialist.provider}/${specialist.model}` : '继承指挥者的模型';
  const reasoning = specialist.reasoningEffort === undefined ? '' : `，推理等级 ${specialist.reasoningEffort}`;
  const maxTokens = specialist.maxTokens === undefined ? '' : `，输出上限 ${specialist.maxTokens} tokens`;

  return {
    name: toolName,
    description:
      `把一个**属于该定位**的任务派给 specialist「${specialist.id}」（${specialist.description}）。` +
      `它运行在 ${route}${reasoning}${maxTokens} 上，看不到你与用户的对话，所以 task 必须自包含：` +
      '目标与背景、产出物、验收判据、写作用域、回报格式都要写清。' +
      '这是**前台**调用：工具会阻塞到该 specialist 结算，然后把它的最终答复返回给你。' +
      '⚠️ 本工具只适用于上面那句定位：如果任务的性质（领域 / 产出类型 / 所需技能）与它差距大，' +
      '不要硬派——改用另一个定位匹配的工具，或在 Team 通道里按该定位新开一个子智能体。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: {
          type: 'string',
          description: '完整、自包含的派活说明：目标与背景、具体产出物、验收判据、写作用域、回报格式。',
        },
        description: {
          type: 'string',
          description: '3-8 个字的任务摘要，用于界面展示。省略时用 specialist 的职责描述。',
        },
      },
      required: ['task'],
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `specialist「${specialist.id}」结算（${value.stopReason}）\n\n${value.text}`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (!isEnabled()) {
        throw new Error(
          `specialist「${specialist.id}」已不在当前名册里（设置页可能刚改过）。不要再调用 \`${toolName}\`；` +
            '请按最新名册重新规划，或改用其它派发通道。',
        );
      }
      const subagents = getSubagents();
      if (subagents === undefined) {
        throw new Error(
          '这个部署里没有可用的 subagents 服务，specialist 通道不可用。请改用「智能体团队」或 workflow；' +
            '都没有时把任务写进正文请用户决定——不要自己动手。',
        );
      }
      const parent = exec?.agent;
      if (parent === undefined || parent === null) {
        throw new Error(`\`${toolName}\` 需要一个发起调用的 agent（exec.agent 为空）。`);
      }

      // 空路由（provider/model 都空）= 继承指挥者的模型：**不传** `agentOptions`，
      // 由 `resolveChildAgentOptions(parent, undefined, depth)` 从父 Agent 继承 route。
      // 这正是出厂预置名册开箱可用的原因 —— 用户不需要先知道任何 provider/model id。
      const agentOptions = hasRoute
        ? { provider: specialist.provider, model: specialist.model }
        : undefined;
      if (agentOptions !== undefined) {
        if (specialist.reasoningEffort !== undefined) agentOptions.reasoningEffort = specialist.reasoningEffort;
        if (specialist.maxTokens !== undefined) agentOptions.maxTokens = specialist.maxTokens;
      }

      const maxDepth = subagents.resolveMaxDepth(1);
      let started;
      try {
        started = await subagents.startActivation({
          provider: 'spawn',
          label: typeof args.description === 'string' && args.description.trim() !== '' ? args.description.trim() : specialist.description.slice(0, 60),
          request: {
            prompt: [{ type: 'text', text: args.task }],
            parent,
            agentPreset: presetId,
            ...(agentOptions === undefined ? {} : { agentOptions }),
            ...(maxDepth === undefined ? {} : { maxDepth }),
          },
          signal: exec.signal,
          delivery: 'caller',
        });
      } catch (error) {
        // 启动失败（容量满 ACTIVATION_LIMIT_REACHED、preset 挂了、父级失效……）是一条
        // **可执行的**结论：让指挥者重新规划或稍后再派，而不是让它看见一段栈。
        throw new Error(
          `specialist「${specialist.id}」没能启动：${error instanceof Error ? error.message : String(error)}。` +
            '不要重复同样的调用；先判断是容量/名称/依赖问题，必要时改派其它通道或向用户上报阻塞。',
        );
      }

      let settled;
      try {
        settled = await started.result;
      } catch (error) {
        // 结算失败（capture/cleanup 失败）也要作为结果交回：任务仍未完成，但指挥者需要知道
        // 原因才能决定是重试、改派还是报 BLOCKER。
        return {
          childId: String(started.childId ?? ''),
          stopReason: 'error',
          text: `specialist「${specialist.id}」的结算失败：${error instanceof Error ? error.message : String(error)}。这个任务仍未完成。`,
          truncated: false,
        };
      }

      const value = renderSettlement(settled);
      return { ...value, childId: String(started.childId ?? '') };
    },
  };
}

// ---------------------------------------------------------------- 安装 ---

/**
 * 安装一个 specialist（preset + 工具），返回异步释放函数。
 *
 * @param {object} options - 安装参数。
 * @param {object} options.ctx - 插件上下文（preset scope）。
 * @param {object} options.specialist - 已清洗的名册项。
 * @param {() => object | undefined} options.getSubagents - 取 `subagents` 服务。
 * @param {() => boolean} [options.isEnabled] - 该 specialist 是否仍在当前名册里。
 * @returns {Promise<() => Promise<void>>} 释放函数。
 */
export async function installSpecialist({ ctx, specialist, getSubagents, isEnabled }) {
  const definition = specialistPresetDefinition(specialist);
  const unregisterPreset = await ctx.agentPresets.register(definition);

  let disposeTool;
  try {
    disposeTool = ctx.tools.register(
      buildSpecialistToolDefinition({
        specialist,
        presetId: definition.id,
        getSubagents,
        isEnabled,
      }),
    );
  } catch (error) {
    await unregisterPreset();
    throw error;
  }

  return async () => {
    try {
      disposeTool?.();
    } catch {
      // 工具可能已随作用域销毁，释放失败不影响后续。
    }
    await unregisterPreset();
  };
}

/**
 * 当前名册里适合安装的一组 specialist —— 名册为空时返回空数组。
 *
 * @param {unknown} config - 插件配置。
 * @param {object} [options] - 清洗选项。
 * @returns {object[]} 清洗后的名册。
 */
export function currentSpecialists(config, options = {}) {
  return resolveRoster(config, options);
}

/** 名册里所有 specialist 的工具名。 */
export function rosterToolNames(roster) {
  return roster.map((specialist) => specialistToolName(specialist.id));
}
