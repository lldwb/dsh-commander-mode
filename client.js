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
      description: 'Configure the specialist roster the commander delegates work to.',
      intro:
        'Each specialist becomes a delegation target. The id is part of its tool name, so keep it lowercase, unique and stable. Saving updates the roster for new sessions; the session you have open keeps the roster it started with.',
      empty: 'No specialists configured. The commander still runs and can still delegate through Agent Teams; add a specialist here to give it a dedicated model.',
      add: 'Add specialist',
      remove: 'Remove',
      reset: 'Restore built-in roster',
      resetHint:
        'Restore only rewrites the draft with the six built-in specialists; nothing is saved until you press Save.',
      resetDone: 'Built-in roster restored in the draft. Review it, then press Save.',
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
      hintId: 'Lowercase letters, digits, "-" and "_"; must start with a letter, at most 48 characters. It becomes part of the delegation tool name.',
      hintProvider: 'Provider id as registered in this deployment (for example deepseek). Leave provider and model both blank to inherit the commander model.',
      hintModel: 'Model id the specialist runs on. Provider and model must be filled together or left blank together.',
      hintDescription: 'What this specialist is responsible for; shown to the commander when it delegates.',
      hintPersona: 'Extra system-prompt text for the specialist. Leave blank to derive it from the responsibility.',
      hintReasoningEffort: 'Leave blank to use the model default.',
      hintMaxTokens: 'A positive integer; leave blank to use the model default.',
      invalidId: 'row {row}: the id must match ^[a-z][a-z0-9_-]{0,47}$',
      duplicateId: 'row {row}: the id "{id}" is used twice',
      missingDescription: 'row {row}: the responsibility is required',
      partialRoute: 'row {row}: fill both provider and model, or leave both blank to inherit the commander model',
      invalidMaxTokens: 'row {row}: max output tokens must be a positive integer',
      rowLabel: 'Specialist {row}'
    };

    /** 简体中文文案（与 en 逐键对齐）。 */
    const zh = {
      title: '指挥者专家名册',
      description: '配置指挥者委派工作时使用的专家名册。',
      intro:
        '每一行是一个专家，都会成为可委派的目标。id 会成为工具名的一部分，因此必须小写、唯一且保持稳定。保存后新会话才会拿到新的专家工具；当前已经打开的会话保持它启动时的名册。',
      empty: '尚未配置任何专家。指挥者仍可通过「智能体团队」派发；在这里添加专家可以给它一个专属模型。',
      add: '添加专家',
      remove: '删除',
      reset: '恢复预置名册',
      resetHint: '重置只会把出厂预置的六个专家放回草稿，不会直接保存；还需要点「保存」才会写入。',
      resetDone: '预置名册已放回草稿。确认后再点「保存」才会写入。',
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
      hintId: '小写字母、数字、"-" 与 "_"；必须以字母开头，最长 48 个字符。它会成为委派工具名的一部分。',
      hintProvider: '本部署注册的提供方 id（例如 deepseek）。两栏都留空 = 继承指挥者的模型。',
      hintModel: '该专家使用的模型 id。提供方与模型要么都填、要么都空。',
      hintDescription: '该专家负责什么；指挥者委派时会看到这段说明。',
      hintPersona: '追加给该专家的系统提示词。留空表示从职责推导。',
      hintReasoningEffort: '留空表示使用模型默认值。',
      hintMaxTokens: '正整数；留空表示使用模型默认值。',
      invalidId: '第 {row} 行：id 必须匹配 ^[a-z][a-z0-9_-]{0,47}$',
      duplicateId: '第 {row} 行：id "{id}" 重复了',
      missingDescription: '第 {row} 行：职责不能为空',
      partialRoute: '第 {row} 行：提供方与模型要么都填，要么都空（都空 = 继承指挥者模型）',
      invalidMaxTokens: '第 {row} 行：最大输出 Token 必须是正整数',
      rowLabel: '专家 {row}'
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

      /** 追加一行。 */
      add() {
        if (!this.projection().writable) return;
        this.draft = this.draft.concat([createDraft()]);
        this.error = undefined;
        this.notice = undefined;
        this.recomputeDirty();
        this.publish();
      }

      /** 删除一行。 */
      remove(index) {
        if (!this.projection().writable) return;
        this.draft = this.draft.filter((_, position) => position !== index);
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
          this.notice = t('savedHint');
        } else {
          this.failed = true;
        }
        this.publish();
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
          patch: (index, field, value) => this.patch(index, field, value)
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
      intro: { margin: '0 0 12px', fontSize: '12px', opacity: 0.65, lineHeight: 1.6 },
      toolbar: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        marginBottom: '12px',
        flexWrap: 'wrap'
      },
      list: { display: 'grid', gap: '10px' },
      empty: { margin: 0, fontSize: '13px', opacity: 0.6 },
      row: {
        border: '1px solid var(--border-color, #d8dce3)',
        borderRadius: '8px',
        padding: '12px',
        display: 'grid',
        gap: '10px'
      },
      rowHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
      rowTitle: { margin: 0, fontSize: '13px', fontWeight: 600 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: '10px' },
      field: { display: 'grid', gap: '4px', minWidth: 0 },
      label: { fontSize: '12px', fontWeight: 500 },
      hint: { margin: 0, fontSize: '11px', opacity: 0.55, lineHeight: 1.5 },
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
      removeButton: {
        minHeight: '30px',
        border: '1px solid var(--border-color, #c9ced8)',
        borderRadius: '6px',
        padding: '4px 10px',
        color: 'inherit',
        background: 'transparent',
        cursor: 'pointer',
        fontSize: '12px'
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
      resetHint: { margin: '0 0 12px', fontSize: '11px', opacity: 0.55, lineHeight: 1.5 },
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
        return h.jsxs(
          'div',
          {
            style: styles.row,
            children: [
              h.jsxs('div', {
                style: styles.rowHead,
                children: [
                  h.jsx('p', { style: styles.rowTitle, children: title }),
                  h.jsx('button', {
                    type: 'button',
                    style: styles.removeButton,
                    disabled,
                    onClick: () => {
                      props.remove(index);
                    },
                    children: t('remove')
                  })
                ]
              }),
              h.jsxs('div', {
                style: styles.grid,
                children: [
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
          },
          row.renderKey,
        );
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
              state.rows.length === 0 ? h.jsx('p', { style: styles.empty, children: t('empty') }) : h.jsx('span', {}),
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
                    onClick: props.add,
                    children: '+ ' + t('add')
                  })
                ]
              })
            ]
          }),
          h.jsx('p', { style: styles.resetHint, children: t('resetHint') }),
          h.jsx('div', { style: styles.list, children: rows }),
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
