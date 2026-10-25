/**
 * `dsh-commander-mode` —— 浏览器半：设置页里的「专家名册」编辑器。
 *
 * ## 形态
 *
 * 手写的 ModuleLoader bundle，与内置设置页（`@deepseek-ai/dsh-client-ui-settings-shell`、
 * `...-settings-web-search`）以及本工作区兄弟插件 `dsh-web-search-opencode-ds/client.js`
 * 同构：`window.__ModuleLoader__.load({ id, factory })` + 惰性 CJS 工厂。**没有构建步骤**。
 *
 * 宿主按本包 `dsh.client` 声明发现它，并在
 * `/plugins/dsh-commander-mode/client.js` 上提供。
 *
 * `require` 只解析两个说明符：`react/jsx-runtime` 与
 * `@deepseek-ai/dsh-client-ui-primitives` —— 二者都是 shell 自身静态模块表
 * （`staticModules`）里的模块；内置设置页要求的正是同一对，这是它们已被预置的证据。
 *
 * ## 这个页面编辑什么
 *
 * 只编辑 Host 半 `lib/config.js` 里**唯一**的 volatile 字段 `specialists`
 * （`z.array(SpecialistSchema).default([]).volatile()`）。`maxSpecialists` /
 * `confirmPlan` / `escalateOnConflict` / `maxTeammates` / `blockedTools` /
 * `registerSkill` 都是加载期配置，**故意不在**本表单里——它们只能改 profile patch。
 *
 * 设置命名空间 = Loader 行 id = 本插件 `name` 导出 = `commander-mode`。三处必须一致，
 * 否则 `configForms.whileServed()` 永远为假，设置页会**静默消失且不报错**。
 *
 * ## 出厂预置名册与「恢复预置名册」
 *
 * 插件带一份出厂预置名册（architect / implementer / reviewer / tester /
 * security-auditor / doc-writer），与 Host 半 `lib/presets.js` 的 `DEFAULT_SPECIALISTS`
 * **逐项同值**；本文件内置了一份同值副本（见下方的内置名册常量）——客户端不能 import
 * Host 模块，`require` 只解析 shell 静态模块表。
 *
 * 「恢复预置名册」按钮**只把草稿改回这份清单并置 dirty，不写 Host**：用户还要点「保存」
 * 才落盘、点「放弃」可还原——天然二次确认，所以没有弹窗。草稿已经等于预置清单时按钮禁用。
 *
 * ## provider / model 可以为空（继承指挥者模型）
 *
 * 预置项的路由是空字符串 = **继承指挥者（父会话）的模型**：不同部署可用的模型完全不同，
 * 出厂名册不能硬编码任何 provider/model。所以两栏都允许留空，但**必须同时空或同时填**：
 * 只填一个说明路由不完整，保存前本地就报 `partialRoute` 错误（沿用 `row {row}` 定位）。
 *
 * ## 为什么自绘列表
 *
 * `SettingsFormModel` 的字段模型是「一个 spec = 一个顶层标量字段」，`plan()` 只会生成
 * `path:[field]` 的 set/unset，内置字段种类只有文本 / 数字，`SettingsValueField` 渲染的
 * 是**单行 input** —— 表达不了 array-of-objects。但 `SettingsForm` 本身是**纯展示组件**
 * （只读 `state/labels/onSave/onDiscard/children`，不耦合 `SettingsFormModel`），所以这
 * 里复用官方外壳拿到只读提示、脏检查与保存按钮，列表自己画。
 *
 * ## 写回路径
 *
 * `ctx.configForms.get(SETTINGS_NS)` 给的是一个 `ConfigFormController`：
 * `getSnapshot() / subscribe() / set(field, value)`。`scope.set('specialists', array)`
 * 内部就是 `mutate([{op:'set', path:['specialists'], value}], revision)`：
 * Host 侧 `applyPathOp` 在 path 末尾直接返回 `op.value`，所以**整数组替换合法**；
 * 写入落 profile 的 cordis patch，经 Loader 的 volatile-only 分支热提交，
 * Host 半收到 `loader/volatile-update` 后重建 specialist 工具。
 *
 * **生效边界（页面文案必须说清）**：工具注册会更新，但已经打开的会话保持它启动时的
 * 工具清单快照——所以「新建会话才会拿到新的 specialist 工具，当前会话保持启动时配置」。
 */

window.__ModuleLoader__.load({
  id: 'dsh-commander-mode',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    // #region static requires（只用 shell 静态模块表里的说明符）
    const h = require('react/jsx-runtime');
    const P = require('@deepseek-ai/dsh-client-ui-primitives');
    // #endregion

    // #region locales
    /**
     * 英文文案。
     *
     * 与 `locale/en.json` 的 `settings` 段**逐键对齐**：JSON 是包清单文本
     * （`ctx.locale.resolveText` 的 LocalizedText，给插件卡片/设置页标题用），
     * 而这里内联的才是运行时真正注册的词典
     * （`ctx.locale.register(NS, { zh, en })`）——两者保持同键，避免维护漂移。
     */
    const en = {
      title: 'Commander specialists',
      description: 'You decide, subagents do the work. Ships with six built-in specialists (architecture, implementation, review, testing, security, docs); add, remove, or bind each to its own model.',
      intro:
        'Click a row to edit it. Restore brings back the six built-in specialists (draft only — press Save to apply). The roster applies to new sessions; the one you have open keeps what it started with.',
      emptyTitle: 'No specialists yet',
      empty: 'The commander can still delegate through Agent Teams. Add a specialist here to give a role its own prompt and, if you want, its own model.',
      add: 'Add specialist',
      addHint: 'Append an empty specialist row and expand it for editing.',
      remove: 'Remove',
      removeHint: 'Remove this specialist from the draft. Press Save to apply it.',
      reset: 'Restore built-in roster',
      resetHint: 'Restore only rewrites the draft with the six built-in specialists; nothing is saved until you press Save.',
      resetDone: 'Built-in roster restored in the draft. Review it, then press Save.',
      countUnit: 'specialists',
      countInherited: '{count} inherit the commander model',
      save: 'Save',
      saving: 'Saving…',
      savingFailed: 'The deployment did not accept this roster; your edits were kept for you to correct.',
      savedHint: 'Roster saved. New sessions get the updated specialist tools; the current session keeps the roster it started with.',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so its roster cannot be configured right now.',
      fieldId: 'Id',
      fieldProvider: 'Provider',
      fieldModel: 'Model',
      fieldDescription: 'Responsibility',
      fieldPersona: 'Persona (optional)',
      fieldReasoningEffort: 'Reasoning effort (optional)',
      fieldMaxTokens: 'Max output tokens (optional)',
      hintId: 'Lowercase letters, digits, "-" and "_"; starts with a letter, max 48 chars. Becomes part of the tool name.',
      hintProvider: 'Provider id registered here (e.g. deepseek). Leave both blank to inherit the commander model.',
      hintModel: 'Model id this specialist runs on. Fill provider and model together, or leave both blank.',
      hintDescription: 'What this specialist is responsible for; the commander sees this when it picks someone.',
      hintPersona: 'Extra system-prompt text. Leave blank to derive it from the responsibility.',
      hintReasoningEffort: 'Leave blank to use the model default.',
      hintMaxTokens: 'A positive integer; blank uses the model default.',
      invalidId: 'row {row}: the id must match ^[a-z][a-z0-9_-]{0,47}$',
      duplicateId: 'row {row}: the id "{id}" is used twice',
      missingDescription: 'row {row}: the responsibility is required',
      partialRoute: 'row {row}: fill both provider and model, or leave both blank to inherit the commander model',
      invalidMaxTokens: 'row {row}: max output tokens must be a positive integer',
      rowLabel: 'Specialist {row}',
      expand: 'Expand to edit this specialist',
      collapse: 'Collapse this specialist',
      summaryInherited: 'inherits model',
      summaryInheritedHint: 'Uses the commander (parent session) model. Fill provider and model to give it its own.',
      summaryOwnRouteHint: 'Uses its own provider/model route for every child it starts.',
      summaryNoDescription: '(no responsibility yet)'
    };

    /** 简体中文文案（与 en 逐键对齐）。 */
    const zh = {
      title: '指挥者专家名册',
      description: '你只做判断，子代理做执行。开箱六位开发流程专家（架构 / 实现 / 审查 / 测试 / 安全 / 文档），可增删、可绑定各自模型。',
      intro:
        '点一行展开编辑；「恢复预置名册」放回出厂六位专家（只改草稿，点「保存」生效）。名册对新会话生效，当前已打开的会话保持启动时的名册。',
      emptyTitle: '还没有专家',
      empty: '指挥者仍可通过「智能体团队」派活。在这里添加专家，可以把某个定位固化下来，并（可选）绑定它的专属模型。',
      add: '添加专家',
      addHint: '追加一行空白专家，并自动展开编辑。',
      remove: '删除',
      removeHint: '从草稿里删掉这位专家；点「保存」后才会生效。',
      reset: '恢复预置名册',
      resetHint: '重置只会把出厂预置的六位专家放回草稿，点「保存」才会写入。',
      resetDone: '预置名册已放回草稿。确认后再点「保存」才会写入。',
      countUnit: '位专家',
      countInherited: '{count} 位继承你的模型',
      save: '保存',
      saving: '保存中…',
      savingFailed: '本部署没有接受这份名册，已保留你的改动供你修正。',
      savedHint: '名册已保存。新会话会拿到更新后的专家工具；当前会话保持启动时的名册。',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置名册。',
      fieldId: 'Id',
      fieldProvider: '提供方',
      fieldModel: '模型',
      fieldDescription: '职责',
      fieldPersona: '角色提示词（可选）',
      fieldReasoningEffort: '推理等级（可选）',
      fieldMaxTokens: '最大输出 Token（可选）',
      hintId: '小写字母、数字、"-" 与 "_"；字母开头，最长 48 字符。它会成为工具名的一部分。',
      hintProvider: '本部署注册的提供方 id（如 deepseek）。两栏都空 = 继承指挥者模型。',
      hintModel: '该专家使用的模型 id。提供方与模型要么都填、要么都空。',
      hintDescription: '该专家负责什么；指挥者选人时会看到这段说明。',
      hintPersona: '追加给该专家的系统提示词。留空表示从职责推导。',
      hintReasoningEffort: '留空表示使用模型默认值。',
      hintMaxTokens: '正整数；留空表示使用模型默认值。',
      invalidId: '第 {row} 行：id 必须匹配 ^[a-z][a-z0-9_-]{0,47}$',
      duplicateId: '第 {row} 行：id "{id}" 重复了',
      missingDescription: '第 {row} 行：职责不能为空',
      partialRoute: '第 {row} 行：提供方与模型要么都填，要么都空（都空 = 继承指挥者模型）',
      invalidMaxTokens: '第 {row} 行：最大输出 Token 必须是正整数',
      rowLabel: '专家 {row}',
      expand: '展开编辑这位专家',
      collapse: '收起这位专家',
      summaryInherited: '继承模型',
      summaryInheritedHint: '使用指挥者（父会话）的模型。填上提供方与模型可以让它用自己的。',
      summaryOwnRouteHint: '它派出的子代理固定使用这个提供方/模型路由。',
      summaryNoDescription: '（还没写职责）'
    };
    // #endregion

    /** 本页面拥有的词典命名空间（只影响文案，与设置命名空间无关）。 */
    const NS = 'settings.commanderMode';

    /**
     * 本页面编辑的 Host 设置命名空间 = Loader 行 id = 本插件 `name` 导出。
     * 客户端不能 import Host 包，所以这里必须**重复拼一遍**。
     */
    const SETTINGS_NS = 'commander-mode';

    /** 名册在 Config 里的字段名（Host `Config.specialists`、客户端 `scope.set` 共用）。 */
    const ROSTER_FIELD = 'specialists';

    /**
     * 名册条目的字段定义，与 `lib/config.js` 的 `SpecialistSchema` 一一对应。
     * `labelKey` / `hintKey` 分开写，避免字段名与卡片文案键撞名
     * （`description` 既是字段名，也是卡片一句话的键）。
     */
    const FIELD_SPECS = [
      { field: 'id', kind: 'text', required: true, maxLength: 48, labelKey: 'fieldId', hintKey: 'hintId' },
      // provider/model 可空：两栏都空 = 继承指挥者（父会话）的模型路由。
      // 合法性不在这里表达，而在 validateDraft 的「同时空或同时填」检查里。
      { field: 'provider', kind: 'text', required: false, labelKey: 'fieldProvider', hintKey: 'hintProvider' },
      { field: 'model', kind: 'text', required: false, labelKey: 'fieldModel', hintKey: 'hintModel' },
      {
        field: 'description',
        kind: 'multiline',
        required: true,
        rows: 3,
        labelKey: 'fieldDescription',
        hintKey: 'hintDescription'
      },
      {
        field: 'persona',
        kind: 'multiline',
        required: false,
        rows: 4,
        labelKey: 'fieldPersona',
        hintKey: 'hintPersona'
      },
      {
        field: 'reasoningEffort',
        kind: 'text',
        required: false,
        labelKey: 'fieldReasoningEffort',
        hintKey: 'hintReasoningEffort'
      },
      {
        field: 'maxTokens',
        kind: 'text',
        required: false,
        numeric: true,
        labelKey: 'fieldMaxTokens',
        hintKey: 'hintMaxTokens'
      }
    ];

    /** 校验规则：与 Host 半 `SpecialistSchema` 的 `.pattern()` 必须完全一致。 */
    const SPECIALIST_ID = /^[a-z][a-z0-9_-]{0,47}$/;

    /**
     * 出厂预置名册，与 Host 半 `lib/presets.js` 的 `DEFAULT_SPECIALISTS` **逐项同值**
     * （id / provider / model / description / persona 五个键、字段顺序也一致）。
     *
     * 为什么客户端要再存一份：client bundle 不能 import Host 模块（`require` 只解析
     * shell 静态模块表里的两个说明符），而「重置」必须在不往返 Host 的情况下立刻改草稿。
     * 一致性由 `test/presets.test.mjs`（Host 侧）与离线校验脚本（比对本常量）守护。
     *
     * `provider` / `model` 是空字符串 = **继承指挥者（父会话）的模型路由**：不同部署可用
     * 的模型完全不同，预置名册不能硬编码任何路由。用户要给某个专家绑定专属模型时，
     * 在表单里把两栏都填上即可。
     */
    const DEFAULT_ROSTER = Object.freeze([
      {
        id: 'architect',
        provider: '',
        model: '',
        description: '系统架构与拆分：把需求拆成可独立验收的任务，给出技术方案、接口与数据模型设计；不直接写实现。',
        persona:
          '你关注边界与取舍：先确认约束（规模、性能、兼容性、已有约定），再给方案。'
          + '方案要能被执行者直接落地——写清模块边界、接口签名、数据流与失败路径，指出关键风险与替代方案。'
          + '不要替实现者写完整代码。'
      },
      {
        id: 'implementer',
        provider: '',
        model: '',
        description: '代码实现：按既定方案写或改代码，补齐边界处理与必要的注释；产出可运行的改动与自检结果。',
        persona:
          '你先读懂现有代码与约定再动手，改动用最小必要范围实现目标，不顺手重构无关部分。'
          + '实现后必须自检（构建、类型检查、相关测试至少一项），并在报告里写清改了哪些文件、怎么验证的。'
          + '发现方案本身有问题时先报告，不要擅自改变设计。'
      },
      {
        id: 'reviewer',
        provider: '',
        model: '',
        description: '代码审查：检查正确性、可维护性、风格一致性与潜在缺陷，给出按严重程度排序的具体意见。',
        persona:
          '你只审查、不实现。逐条给出**可定位**的意见（文件、位置、问题、建议），并标注严重程度'
          + '（阻断 / 应修 / 建议）。没把握的地方明确说"不确定"，不要把猜测写成结论。'
          + '最后给一句总体结论：可合并 / 修完再看。'
      },
      {
        id: 'tester',
        provider: '',
        model: '',
        description: '测试：设计并补齐覆盖改动的测试，运行验证并报告通过/失败明细；复现缺陷时给出最小步骤。',
        persona:
          '你以"怎么证明它是错的"为出发点设计用例：正常路径、边界、异常与回归。'
          + '用例要独立、可重复、不依赖外部网络与人工步骤；失败时给出最小复现与期望/实际对比。'
          + '不要为了让测试变绿而放宽断言。'
      },
      {
        id: 'security-auditor',
        provider: '',
        model: '',
        description: '安全审计：依赖漏洞、注入与越权、密钥与敏感信息泄漏、不安全默认值；给出风险等级与修复建议。',
        persona:
          '你按攻击面排查：输入边界、权限模型、依赖供应链、日志与配置中的敏感信息。'
          + '每条发现都要有证据（文件/命令/输出）与风险等级，并区分"确定漏洞"与"需要确认的疑点"。'
          + '不要为了凑数报告理论风险；也不要在报告里复述密钥原文。'
      },
      {
        id: 'doc-writer',
        provider: '',
        model: '',
        description: '文档：README、API 说明、使用与迁移文档；面向真实读者写清"是什么、怎么用、边界在哪"。',
        persona:
          '你写给人看：先给最短可用的快速开始，再补细节；命令与代码块必须可直接复制运行。'
          + '以仓库现状为准（先读代码与现有文档），不臆造尚未实现的行为；不确定的地方标注"未验证"。'
          + '保持术语与仓库一致。'
      }
    ]);

    // #region 纯函数：校验 / 清洗 / 草稿
    /** 格式化文案里的 {占位符}。 */
    function format(template, values) {
      return template.replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
      );
    }

    /** 新建一行空白草稿（`renderKey` 让 React 在增删行时保持输入焦点稳定）。 */
    let nextRenderKey = 0;
    function createDraft() {
      nextRenderKey += 1;
      return {
        renderKey: 'specialist-' + nextRenderKey,
        id: '',
        provider: '',
        model: '',
        description: '',
        persona: '',
        reasoningEffort: '',
        maxTokens: ''
      };
    }

    /** Host 名册项（JSON）→ 编辑草稿（全部字段变成字符串，便于受控输入）。 */
    function toDraft(entry) {
      nextRenderKey += 1;
      const value = entry !== null && typeof entry === 'object' ? entry : {};
      return {
        renderKey: 'specialist-' + nextRenderKey,
        id: typeof value.id === 'string' ? value.id : '',
        provider: typeof value.provider === 'string' ? value.provider : '',
        model: typeof value.model === 'string' ? value.model : '',
        description: typeof value.description === 'string' ? value.description : '',
        persona: typeof value.persona === 'string' ? value.persona : '',
        reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : '',
        maxTokens:
          typeof value.maxTokens === 'number' && Number.isFinite(value.maxTokens) ? String(value.maxTokens) : ''
      };
    }

    /** 读 `scope.getSnapshot().value[ROSTER_FIELD]`，容错成草稿数组。 */
    function readRoster(snapshot) {
      const roster = snapshot !== undefined && snapshot !== null ? snapshot.value : undefined;
      const entries = roster !== undefined && roster !== null ? roster[ROSTER_FIELD] : undefined;
      return Array.isArray(entries) ? entries.map(toDraft) : [];
    }

    /**
     * 校验草稿，返回第一条错误（已本地化、可直接显示）或 `undefined`。
     *
     * 规则（与 Host `SpecialistSchema` + 空路由语义一致）：
     * - `id` 必填、匹配 pattern、名册内唯一；
     * - `description` 必填；
     * - `provider` / `model` **两栏要么都填、要么都空**（都空 = 继承指挥者模型）；
     * - `maxTokens` 留空或正整数。
     *
     * 这里挡不住的 Host 也会拒绝，但提前拦下能告诉用户**第几行、哪个字段**。
     */
    function validateDraft(rows, t) {
      const seen = new Set();
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const rowNumber = index + 1;
        const id = row.id.trim();
        if (!SPECIALIST_ID.test(id)) return format(t('invalidId'), { row: rowNumber });
        if (seen.has(id)) return format(t('duplicateId'), { row: rowNumber, id });
        seen.add(id);
        // provider/model 两栏要么都填、要么都空。都空 = 继承指挥者（父会话）的模型路由；
        // 只填一个说明路由不完整，是一份坏配置，就地拦下而不是交给 Host 猜。
        const hasProvider = row.provider.trim() !== '';
        const hasModel = row.model.trim() !== '';
        if (hasProvider !== hasModel) return format(t('partialRoute'), { row: rowNumber });
        if (row.description.trim() === '') return format(t('missingDescription'), { row: rowNumber });
        if (row.maxTokens.trim() !== '') {
          const maxTokens = Number(row.maxTokens.trim());
          if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
            return format(t('invalidMaxTokens'), { row: rowNumber });
          }
        }
      }
      return undefined;
    }

    /**
     * 草稿 → 写入 Host 的 JSON。
     *
     * 两类字段的「空值」处理**故意不同**：
     * - `provider` / `model` 空串**显式保留**（`provider: ''` / `model: ''`）。空串是
     *   有语义的合法值 = 继承指挥者模型；省略键虽然也会被 Host schema 的 `.default('')`
     *   补上，但显式往返更稳、也避免「省略」被误读成「用户没配过这一栏」。
     * - 其余可选字段（`persona` / `reasoningEffort` / `maxTokens`）空则**省略该键**：
     *   Host 的 `cloneJsonShaped` 拒绝数组里的 `undefined`，而 `""` 会让「未配置」与
     *   「配置为空串」不可区分；`maxTokens: null` 还会撞 `z.number()` 的类型校验。
     *   `maxTokens` 在这里转成数字。
     */
    function toRoster(rows) {
      return rows.map((row) => {
        const entry = {
          id: row.id.trim(),
          provider: row.provider.trim(),
          model: row.model.trim(),
          description: row.description.trim()
        };
        const persona = row.persona.trim();
        if (persona !== '') entry.persona = persona;
        const reasoningEffort = row.reasoningEffort.trim();
        if (reasoningEffort !== '') entry.reasoningEffort = reasoningEffort;
        const maxTokens = row.maxTokens.trim();
        if (maxTokens !== '') entry.maxTokens = Number(maxTokens);
        return entry;
      });
    }

    /**
     * 预置名册规范化后的 JSON（惰性缓存）。
     *
     * 每次投影都要拿它和草稿比较（`isDefaultRoster`），所以只归一化一次：
     * 既避免重复计算，也避免每次都消耗 `toDraft` 的 renderKey 计数器。
     */
    let presetRosterJson;
    function defaultRosterJson() {
      if (presetRosterJson === undefined) {
        presetRosterJson = JSON.stringify(toRoster(DEFAULT_ROSTER.map((entry) => toDraft(entry))));
      }
      return presetRosterJson;
    }
    // #endregion

    // #region 最小 snapshot store（React useSyncExternalStore 契约）
    /**
     * 宿主把 `inject().hooks` 里的每个值包装成 `use<Key>(selector)`，底层是
     * `useSyncExternalStore(store.subscribe, store.getSnapshot)`。
     * 所以这里只要 `{getSnapshot, subscribe}`；未变化时必须返回**同一引用**。
     */
    function createStore(initial) {
      let snapshot = initial;
      const listeners = new Set();
      return {
        getSnapshot() {
          return snapshot;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        set(next) {
          if (next === snapshot) return;
          snapshot = next;
          for (const listener of Array.from(listeners)) listener();
        }
      };
    }
    // #endregion

    // #region 控制器：读 Host → 草稿 → 保存
    /**
     * 名册卡片的全部状态与动作。状态来源只有一个：`scope.getSnapshot()`
     * （Host settings 的客户端镜像）；本地只多保存「编辑中的草稿」与
     * 「脏 / 保存中 / 失败」三个 UI 标志。
     */
    class SpecialistsCardController {
      /**
       * @param scope - `ctx.configForms.get(SETTINGS_NS)`。
       * @param ctx - 浏览器插件上下文（只用可选 logger）。
       */
      constructor(scope, ctx) {
        this.scope = scope;
        this.ctx = ctx;
        this.t = (key) => key;
        /** 编辑草稿；`dirty` 为假时始终等于 Host 当前值。 */
        this.draft = readRoster(scope.getSnapshot());
        /** Host 当前值（用于 discard 与脏判断）。 */
        this.stored = this.draft;
        this.dirty = false;
        this.saving = false;
        this.failed = false;
        this.error = undefined;
        this.notice = undefined;
        /**
         * 已展开的专家行（`renderKey` 集合）。默认**全部折叠**：一个专家的表单有七个字段，
         * 六个预置专家全部展开会铺满好几屏，设置页几乎没法用。
         */
        this.expanded = new Set();
        this.store = createStore(this.projection());
        this.unsubscribe = scope.subscribe(() => {
          this.refreshFromHost();
        });
        this.refreshFromHost();
      }

      /** 读 Host 最新值。未编辑时同步草稿；编辑中只更新 stored，避免覆盖用户输入。 */
      refreshFromHost() {
        this.stored = readRoster(this.scope.getSnapshot());
        if (!this.dirty) this.draft = this.stored;
        this.publish();
      }

      /** 页面快照。`SettingsForm` 直接读前六个字段。 */
      projection() {
        const snapshot = this.scope.getSnapshot();
        const available = snapshot !== undefined && snapshot.status === 'ready';
        const writable = available && snapshot.writable === true;
        return {
          available,
          writable,
          dirty: this.dirty,
          invalid: this.error !== undefined,
          saving: this.saving,
          failed: this.failed,
          // 有东西可重置 = 草稿与出厂预置名册不同；相同时按钮禁用。
          canReset: !this.isDefaultRoster(),
          rows: this.draft,
          /** 已展开行的 `renderKey` 集合（视图据此决定渲染字段还是摘要）。 */
          expanded: this.expanded,
          error: this.error,
          notice: this.notice
        };
      }

      publish() {
        this.store.set(this.projection());
      }

      /** 重算脏标志（草稿与 Host 值逐字段等价即视为干净）。 */
      recomputeDirty() {
        this.dirty = JSON.stringify(toRoster(this.draft)) !== JSON.stringify(toRoster(this.stored));
        if (!this.dirty) this.failed = false;
      }

      /**
       * 草稿是否已经等于出厂预置名册。
       *
       * 比较的是**草稿**而非 Host 值：按钮语义是「把默认清单放进草稿」，
       * 所以只要草稿已经是预置清单就没有可重置的东西（再点也不会有变化）。
       *
       * 注意预置名册先归一化成草稿形状：`DEFAULT_ROSTER` 是 Host 形状（可选项键可能缺省），
       * 而 `toRoster` 只接受字段齐全的草稿行。归一化结果已缓存（`defaultRosterJson`）。
       */
      isDefaultRoster() {
        return JSON.stringify(toRoster(this.draft)) === defaultRosterJson();
      }

      /** 改一个字段。 */
      patch(index, field, value) {
        if (!this.projection().writable) return;
        this.draft = this.draft.map((row, position) =>
          position === index ? Object.assign({}, row, { [field]: value }) : row,
        );
        this.error = undefined;
        this.notice = undefined;
        this.recomputeDirty();
        this.publish();
      }

      /**
       * 展开 / 收起一行。
       *
       * 默认全部折叠（见构造函数里的 `expanded`）。点击标题栏切换；展开状态只影响视图，
       * 不进草稿、不参与脏判断。
       */
      toggle(index) {
        const row = this.draft[index];
        if (row === undefined) return;
        const key = row.renderKey;
        if (this.expanded.has(key)) this.expanded.delete(key);
        else this.expanded.add(key);
        this.publish();
      }

      /** 展开某一行（新增行、校验失败行用它）。 */
      expandRow(index) {
        const row = this.draft[index];
        if (row === undefined) return;
        this.expanded.add(row.renderKey);
      }

      /** 展开所有行（校验错误定位不到具体行时的兜底）。 */
      expandAll() {
        this.expanded = new Set(this.draft.map((row) => row.renderKey));
      }

      /** 全部收起。 */
      collapseAll() {
        this.expanded = new Set();
      }

      /** 追加一行。 */
      add() {
        if (!this.projection().writable) return;
        const draft = createDraft();
        this.draft = this.draft.concat([draft]);
        // 新行是空的，折叠着用户根本不知道该填什么 —— 直接展开。
        this.expanded.add(draft.renderKey);
        this.error = undefined;
        this.notice = undefined;
        this.recomputeDirty();
        this.publish();
      }

      /** 删除一行。 */
      remove(index) {
        if (!this.projection().writable) return;
        const removed = this.draft[index];
        this.draft = this.draft.filter((_, position) => position !== index);
        if (removed !== undefined) this.expanded.delete(removed.renderKey);
        this.error = undefined;
        this.notice = undefined;
        this.recomputeDirty();
        this.publish();
      }

      /** 丢弃草稿（SettingsForm 卸载时也会调一次）。 */
      discard() {
        this.draft = this.stored.map((row) => Object.assign({}, row));
        this.dirty = false;
        this.failed = false;
        this.error = undefined;
        this.notice = undefined;
        this.collapseAll();
        this.publish();
      }

      /**
       * 「恢复预置名册」：**只把草稿改回出厂预置清单，不写 Host**。
       *
       * 这是刻意的：重置后用户还要点「保存」才落盘，点「放弃」可还原——天然二次确认，
       * 不需要弹窗。保存路径与手动编辑完全一致（`scope.set(ROSTER_FIELD, array)`）。
       */
      reset() {
        if (!this.projection().writable) return;
        this.draft = DEFAULT_ROSTER.map((entry) => toDraft(entry));
        // 重置后整份名册换了一批行，旧的展开 key 全部失效 —— 收拢成默认折叠态，
        // 让用户先看全貌再决定展开哪一行。
        this.collapseAll();
        this.error = undefined;
        this.notice = this.t('resetDone');
        this.recomputeDirty();
        this.publish();
      }

      /**
       * 保存：校验 → `scope.set(ROSTER_FIELD, array)`。
       *
       * 一次调用就是一次原子的「整数组替换」；返回 `false` 表示被拒
       * （revision 冲突、schema 拒绝，或被 home patch / 命令行覆盖层挡住），
       * 此时保留草稿并置 `failed`，由 `SettingsForm` 显示失败文案。
       */
      async save() {
        if (this.saving) return;
        const t = this.t;
        const reason = validateDraft(this.draft, t);
        if (reason !== undefined) {
          this.error = reason;
          // 错误信息里带行号（`第 {row} 行` / `row {row}`）：展开那一行，否则用户只能看到
          // 一句"第 3 行有问题"却找不到是哪一行在折叠状态下藏起来的。
          this.revealErrorRow(reason);
          this.publish();
          return;
        }
        const roster = toRoster(this.draft);
        this.saving = true;
        this.failed = false;
        this.error = undefined;
        this.notice = undefined;
        this.publish();
        let accepted = false;
        try {
          accepted = await this.scope.set(ROSTER_FIELD, roster);
        } catch (cause) {
          accepted = false;
          this.ctx?.logger?.warn?.('commander-mode: 名册保存失败', cause);
        } finally {
          this.saving = false;
        }
        if (accepted) {
          this.draft = roster.map(toDraft);
          this.stored = this.draft.map((row) => Object.assign({}, row));
          this.dirty = false;
          this.failed = false;
          // 保存成功后收拢：行对象换成了新的，旧 key 失效；也让用户看到"保存完成"的全貌。
          this.collapseAll();
          this.notice = t('savedHint');
        } else {
          this.failed = true;
        }
        this.publish();
      }

      /**
       * 从校验错误文案里解析行号并展开该行；解析不到就全展开。
       *
       * 文案由 locale 提供（中英两种），行号以第一个出现的数字为准：
       * - 中文：`第 3 行：...`
       * - 英文：`row 3: ...`
       *
       * @param {string} reason - `validateDraft` 返回的错误文案。
       */
      revealErrorRow(reason) {
        const match = /(?:第\s*|row\s+)(\d+)/u.exec(typeof reason === 'string' ? reason : '');
        if (match === null) {
          this.expandAll();
          return;
        }
        const rowNumber = Number(match[1]);
        if (!Number.isSafeInteger(rowNumber) || rowNumber < 1) {
          this.expandAll();
          return;
        }
        this.expandRow(rowNumber - 1);
      }

      /** 交给槽位的 `inject()`：hooks → `use<Key>`，其余键直接成为 props。 */
      inject() {
        return {
          hooks: { specialistsCard: this.store },
          save: () => this.save(),
          discard: () => this.discard(),
          add: () => this.add(),
          reset: () => this.reset(),
          remove: (index) => this.remove(index),
          patch: (index, field, value) => this.patch(index, field, value),
          toggle: (index) => this.toggle(index)
        };
      }

      /** 释放订阅（由 `ctx.effect` 持有）。 */
      dispose() {
        this.unsubscribe();
      }
    }
    // #endregion

    // #region 视图
    const styles = {
      intro: { margin: '0 0 10px', fontSize: '12px', opacity: 0.68, lineHeight: 1.6 },
      /** 统计 + 操作的同一行：左边告诉用户"有多少"，右边是动作。 */
      toolbar: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        marginBottom: '8px',
        flexWrap: 'wrap'
      },
      count: { margin: 0, fontSize: '12px', opacity: 0.7 },
      countStrong: { fontWeight: 600, opacity: 1, fontVariantNumeric: 'tabular-nums' },
      countInherited: { opacity: 0.55 },
      list: { display: 'grid', gap: '8px', marginTop: '4px' },
      /** 空态：独立成块，而不是挤在工具栏里当一行灰字。 */
      emptyBlock: {
        display: 'grid',
        gap: '8px',
        justifyItems: 'center',
        alignContent: 'center',
        minHeight: '150px',
        padding: '28px 24px',
        border: '1px dashed var(--border-color, #d8dce3)',
        borderRadius: '10px',
        textAlign: 'center'
      },
      emptyTitle: { margin: 0, fontSize: '14px', fontWeight: 600 },
      empty: { margin: 0, fontSize: '12px', opacity: 0.62, lineHeight: 1.7, maxWidth: '52ch' },
      /**
       * 一行专家。折叠时紧凑（只占一行），展开时左侧出现强调竖条 —— 让"正在编辑哪一行"
       * 一眼可见（折叠/展开共用同一个容器，避免展开后整块布局跳动）。
       */
      row: {
        border: '1px solid var(--border-color, #d8dce3)',
        borderRadius: '8px',
        borderLeft: '3px solid transparent',
        padding: '8px 12px',
        display: 'grid',
        gap: '10px',
        background: 'transparent'
      },
      rowOpen: {
        borderLeft: '3px solid var(--accent-color, #4c6ef5)',
        // 用中灰半透明而不是极淡的白：深色主题下 rgba(255,255,255,0.04) 几乎看不见。
        background: 'var(--surface-subtle, rgba(127, 127, 127, 0.10))',
        // 上下给一点间距：展开块与相邻折叠行的边界更清楚（否则两块像连在一起）。
        margin: '4px 0',
        padding: '10px 12px'
      },
      rowHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' },
      /**
       * 标题栏即展开开关（整块可点）。默认折叠：一个专家的表单有七个字段，
       * 六个预置专家全部展开会铺满好几屏。
       */
      rowToggle: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flex: '1 1 auto',
        minWidth: 0,
        margin: 0,
        padding: '2px 0',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer'
      },
      chevron: { flex: '0 0 auto', fontSize: '10px', opacity: 0.55, width: '10px' },
      /** id 用等宽字体：它是工具名的一部分，等宽更容易扫读与核对。 */
      rowTitle: {
        margin: 0,
        fontSize: '13px',
        fontWeight: 600,
        flex: '0 0 auto',
        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)'
      },
      /** 模型路由 badge：一眼区分"继承指挥者模型"与"绑定专属模型"。 */
      modelBadge: {
        flex: '0 0 auto',
        padding: '1px 6px',
        borderRadius: '999px',
        border: '1px solid var(--border-color, #d8dce3)',
        fontSize: '11px',
        opacity: 0.75,
        whiteSpace: 'nowrap'
      },
      modelBadgeOwn: {
        borderColor: 'var(--accent-color, #4c6ef5)',
        opacity: 0.95
      },
      rowSummary: {
        margin: 0,
        fontSize: '12px',
        opacity: 0.58,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0
      },
      rowSummaryEmpty: { fontStyle: 'italic', opacity: 0.45 },
      /** 展开后的字段区：与标题栏用一条细线隔开，视觉上不会再"糊成一团"。 */
      panel: {
        display: 'grid',
        gap: '10px',
        paddingTop: '10px',
        borderTop: '1px solid var(--border-color, #e6e9ef)'
      },
      /**
       * 展开后的字段网格：**3 列**。
       *
       * 7 个字段排 3 列：id / 提供方 / 模型 一行，推理等级 / 最大输出 一行（各占 1 列，
       * 第三列留给说明留白比 4 列把最后一个字段甩到第二行更平衡），职责与角色提示词各占整行。
       */
      grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
        gap: '12px 14px'
      },
      field: { display: 'grid', gap: '4px', minWidth: 0 },
      label: { fontSize: '12px', fontWeight: 500 },
      /** hint：11px/0.55 在窄列里读着吃力，放大一点、提高对比。 */
      hint: { margin: 0, fontSize: '12px', opacity: 0.65, lineHeight: 1.55 },
      control: {
        boxSizing: 'border-box',
        width: '100%',
        minHeight: '34px',
        border: '1px solid var(--border-color, #c9ced8)',
        borderRadius: '6px',
        padding: '6px 8px',
        color: 'inherit',
        background: 'var(--input-bg, transparent)',
        font: 'inherit'
      },
      multiline: { resize: 'vertical' },
      /**
       * 删除是危险/次要操作：**无边框**、低对比（6 行并排时不抢注意力），
       * 危险语义靠 title 提示。
       */
      removeButton: {
        flex: '0 0 auto',
        minHeight: '26px',
        border: 'none',
        borderRadius: '6px',
        padding: '3px 8px',
        color: 'inherit',
        background: 'transparent',
        cursor: 'pointer',
        fontSize: '11px',
        opacity: 0.45
      },
      addButton: {
        minHeight: '34px',
        border: '1px solid var(--border-color, #c9ced8)',
        borderRadius: '6px',
        padding: '6px 12px',
        color: 'inherit',
        background: 'var(--button-bg, transparent)',
        cursor: 'pointer'
      },
      toolbarActions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      alert: { margin: 0, fontSize: '12px', color: 'var(--danger-color, #c93434)' },
      notice: { margin: 0, fontSize: '12px', opacity: 0.75 }
    };

    /** 一个受控字段：label + 控件 + hint。 */
    function FieldRow(props) {
      const spec = props.spec;
      const controlStyle = spec.kind === 'multiline' ? Object.assign({}, styles.control, styles.multiline) : styles.control;
      const onChange = (event) => {
        props.onEdit(spec.field, event.target.value);
      };
      const control =
        spec.kind === 'multiline'
          ? h.jsx('textarea', {
              id: props.idPrefix + '-' + spec.field,
              style: controlStyle,
              rows: spec.rows !== undefined ? spec.rows : 3,
              value: props.value,
              disabled: props.disabled,
              onChange
            })
          : h.jsx('input', {
              id: props.idPrefix + '-' + spec.field,
              style: controlStyle,
              type: 'text',
              inputMode: spec.numeric === true ? 'numeric' : undefined,
              value: props.value,
              maxLength: spec.maxLength,
              disabled: props.disabled,
              onChange
            });
      return h.jsxs('div', {
        style: styles.field,
        children: [
          h.jsx('label', { style: styles.label, htmlFor: props.idPrefix + '-' + spec.field, children: props.label }),
          control,
          h.jsx('p', { style: styles.hint, children: props.hint })
        ]
      });
    }

    /**
     * 按插件页要求渲染一句话说明（`view === 'summary'`）或整张设置卡片。
     *
     * props 由宿主注入：`view`、`t`、`useSpecialistsCard(selector)`、
     * `save / discard / add / reset / remove / patch`。
     */
    function SpecialistsCard(props) {
      const t = props.t;
      const state = props.useSpecialistsCard((snapshot) => snapshot);
      if (props.view === 'summary') return t('description');

      const formLabels = {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('savingFailed'),
        save: t('save'),
        saving: t('saving')
      };
      const disabled = !state.writable;

      const rows = state.rows.map((row, index) => {
        const rowNumber = index + 1;
        const idPrefix = 'commander-specialist-' + row.renderKey;
        const expanded = state.expanded instanceof Set ? state.expanded.has(row.renderKey) : false;
        const fields = FIELD_SPECS.map((spec) =>
          h.jsx(
            FieldRow,
            {
              spec,
              idPrefix,
              value: row[spec.field],
              disabled,
              label: t(spec.labelKey),
              hint: t(spec.hintKey),
              onEdit: (field, value) => {
                props.patch(index, field, value);
              }
            },
            spec.field,
          ),
        );
        const title = row.id.trim() === '' ? format(t('rowLabel'), { row: rowNumber }) : row.id.trim();
        // 折叠时的摘要：模型路由 badge + 职责。让用户不展开也能判断"这行是谁、跑在什么模型上"。
        const inherited = row.provider.trim() === '' && row.model.trim() === '';
        const route = inherited ? t('summaryInherited') : row.provider.trim() + '/' + row.model.trim();
        const hasDescription = row.description.trim() !== '';
        const summary = hasDescription ? row.description.trim() : t('summaryNoDescription');
        return h.jsxs(
          'div',
          {
            style: expanded ? Object.assign({}, styles.row, styles.rowOpen) : styles.row,
            children: [
              h.jsxs('div', {
                style: styles.rowHead,
                children: [
                  // 标题栏整块是展开/收起开关：只做视觉与可点击性，不改任何字段。
                  h.jsxs('button', {
                    type: 'button',
                    style: styles.rowToggle,
                    'aria-expanded': expanded,
                    title: expanded ? t('collapse') : t('expand'),
                    onClick: () => {
                      props.toggle(index);
                    },
                    children: [
                      h.jsx('span', { style: styles.chevron, children: expanded ? '▾' : '▸' }),
                      h.jsx('span', { style: styles.rowTitle, children: title }),
                      h.jsx('span', {
                        style: inherited ? styles.modelBadge : Object.assign({}, styles.modelBadge, styles.modelBadgeOwn),
                        title: inherited ? t('summaryInheritedHint') : t('summaryOwnRouteHint'),
                        children: route
                      }),
                      expanded
                        ? null
                        : h.jsx('span', {
                            style: hasDescription ? styles.rowSummary : Object.assign({}, styles.rowSummary, styles.rowSummaryEmpty),
                            children: summary
                          })
                    ]
                  }),
                  h.jsx('button', {
                    type: 'button',
                    style: styles.removeButton,
                    disabled,
                    title: t('removeHint'),
                    onClick: () => {
                      props.remove(index);
                    },
                    children: t('remove')
                  })
                ]
              }),
              expanded
                ? h.jsx('div', {
                    style: styles.panel,
                    children: [
                      h.jsxs('div', {
                        style: styles.grid,
                        children: [
                          // 3 列 × auto-fit：前两行各放 3 个短字段，第三列的空位由
                          // 说明文字自然占据；职责与角色提示词各占整行。
                          fields[0], // id
                          fields[1], // provider
                          fields[2], // model
                          fields[5], // reasoningEffort
                          fields[6], // maxTokens
                          h.jsx('div', { style: Object.assign({}, styles.field, { gridColumn: '1 / -1' }), children: fields[3] }), // description
                          h.jsx('div', { style: Object.assign({}, styles.field, { gridColumn: '1 / -1' }), children: fields[4] }) // persona
                        ]
                      })
                    ]
                  })
                : null
            ]
          },
          row.renderKey,
        );
      });

      // 统计：有多少专家、其中多少继承指挥者的模型。折叠态下一眼看清整体配置。
      const inheritedCount = state.rows.filter(
        (row) => row.provider.trim() === '' && row.model.trim() === '',
      ).length;
      const countLine = h.jsxs('p', {
        style: styles.count,
        children: [
          h.jsx('strong', { style: styles.countStrong, children: String(state.rows.length) }),
          ' ' + t('countUnit'),
          inheritedCount > 0
            ? h.jsx('span', { style: styles.countInherited, children: ' · ' + format(t('countInherited'), { count: inheritedCount }) })
            : null
        ]
      });

      return h.jsxs(P.SettingsForm, {
        labels: formLabels,
        state,
        onSave: props.save,
        onDiscard: props.discard,
        children: [
          h.jsx('p', { style: styles.intro, children: t('intro') }),
          h.jsxs('div', {
            style: styles.toolbar,
            children: [
              countLine,
              h.jsxs('div', {
                style: styles.toolbarActions,
                children: [
                  // 「恢复预置名册」只改草稿：disabled 的条件是只读，或草稿已经等于预置清单。
                  h.jsx('button', {
                    type: 'button',
                    style: styles.addButton,
                    disabled: disabled || !state.canReset,
                    title: t('resetHint'),
                    onClick: props.reset,
                    children: t('reset')
                  }),
                  h.jsx('button', {
                    type: 'button',
                    style: styles.addButton,
                    disabled,
                    title: t('addHint'),
                    onClick: props.add,
                    children: '+ ' + t('add')
                  })
                ]
              })
            ]
          }),
          // 这里**不再**常显一行「重置只会…」：intro 已经说明"重置只改草稿、保存才生效"，
          // 按钮 title 也有完整说明。常显那行只会把统计行和列表隔开、同件事说两遍。
          state.rows.length === 0
            ? h.jsxs('div', {
                style: styles.emptyBlock,
                children: [
                  h.jsx('p', { style: styles.emptyTitle, children: t('emptyTitle') }),
                  h.jsx('p', { style: styles.empty, children: t('empty') })
                ]
              })
            : h.jsx('div', { style: styles.list, children: rows }),
          state.error !== undefined ? h.jsx('p', { style: styles.alert, role: 'alert', children: state.error }) : null,
          state.notice !== undefined ? h.jsx('p', { style: styles.notice, role: 'status', children: state.notice }) : null
        ]
      });
    }
    // #endregion

    /** 必需服务（cordis fiber inject）。 */
    const inject = ['slots', 'locale', 'configForms'];

    /**
     * 在 Host 提供本插件设置命名空间期间挂载设置页。
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'commander-mode: 词典');

      const card = new SpecialistsCardController(ctx.configForms.get(SETTINGS_NS), ctx);
      card.t = t;
      ctx.effect(() => () => card.dispose(), 'commander-mode: 名册订阅');

      ctx.effect(
        () =>
          ctx.configForms.whileServed([SETTINGS_NS], () =>
            ctx.slots.inject('plugins.item', () =>
              ctx.slots.register(
                {
                  name: 'plugins.item',
                  // 用**自己的** id：新 id 并排新增，复用别人的 id 会顶掉别人。
                  id: 'commander-mode',
                  // 官方「终端」与「网页搜索」在 40/41；排在它们之后。
                  order: 43,
                  label: () => t('title'),
                  locale: NS,
                  inject: () => card.inject()
                },
                SpecialistsCard,
              ),
            ),
          ),
        'commander-mode: 设置页',
      );
    }

    exports.NS = NS;
    exports.SETTINGS_NS = SETTINGS_NS;
    exports.ROSTER_FIELD = ROSTER_FIELD;
    exports.SPECIALIST_ID = SPECIALIST_ID;
    exports.FIELD_SPECS = FIELD_SPECS;
    // 与 Host `lib/presets.js` 的 DEFAULT_SPECIALISTS 逐项同值；导出便于离线校验
    // 两边不漂移（运行时不消费这个导出）。
    exports.DEFAULT_ROSTER = DEFAULT_ROSTER;
    // 诊断/离线测试用：让 `node --test` 或校验脚本能直接比对内联词典与
    // locale/*.json 的 `settings` 段是否逐键对齐（运行时不消费这个导出）。
    exports.DICTIONARIES = { zh, en };
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
