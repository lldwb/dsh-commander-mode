/**
 * 出厂预置名册 —— 按主流软件开发生命周期划分的一组专职子代理。
 *
 * ## 为什么默认不空
 *
 * 0.2.x 的默认名册是空的：装上插件什么都不能派，用户得先去设置页配一遍才用得起来。
 * 而"指挥者模式"的价值在于**分工**——开箱有一套覆盖开发流程的专家，用户第一次选中这个
 * 模式就能直接派活，之后按自己的项目增删。
 *
 * ## 为什么 provider / model 是空字符串
 *
 * 不同部署可用的模型完全不同（本地模型、订阅 provider、内网网关……），预置名册**不能**
 * 硬编码任何 `provider/model`：写死了在别人的部署里就是一条坏配置。
 *
 * 空路由的语义是**继承指挥者（父会话）的模型**——`startActivation` 不传 `agentOptions`
 * 时，子 agent 从父 Agent 那里继承 route（见 `lib/specialists.js` 的 `buildSpecialistToolDefinition`）。
 * 用户想给某个专家绑定专属模型时，在设置页把两栏都填上即可。
 *
 * ## 与设置页「重置」的关系
 *
 * 设置页的「重置为预置专家」按钮把草稿恢复成这份清单（**仍需点保存才落盘**）。client 半
 * 内置了同一份数据（它不能 import 本模块：client bundle 只能 require shell 静态模块），
 * 一致性由 `test/presets.test.mjs` 与 client 的离线校验守护。
 *
 * @module dsh-commander-mode/lib/presets
 */

/**
 * 出厂预置名册。
 *
 * 每一项的 `description` 就是**定位**：指挥者据此判断任务该派给谁，用户也据此理解
 * 每个专家的边界。`persona` 是追加到该专家人设末尾的专属提示词（语气 / 侧重 / 特有纪律）。
 *
 * 字段顺序与 `SpecialistSchema` 一致：id / provider / model / description / persona。
 *
 * ⚠️ 数组与每个条目都会被**冻结**（deep freeze）：它是"出厂状态"的唯一真源，运行时任何
 * 路径都不该能改它。需要可变副本时用 `cloneDefaultSpecialists()`。
 */
export const DEFAULT_SPECIALISTS = Object.freeze(
  [
    {
      id: 'architect',
      provider: '',
      model: '',
      description: '系统架构与拆分：把需求拆成可独立验收的任务，给出技术方案、接口与数据模型设计；不直接写实现。',
      persona:
        '你关注边界与取舍：先确认约束（规模、性能、兼容性、已有约定），再给方案。'
        + '方案要能被执行者直接落地——写清模块边界、接口签名、数据流与失败路径，指出关键风险与替代方案。'
        + '不要替实现者写完整代码。',
    },
    {
      id: 'implementer',
      provider: '',
      model: '',
      description: '代码实现：按既定方案写或改代码，补齐边界处理与必要的注释；产出可运行的改动与自检结果。',
      persona:
        '你先读懂现有代码与约定再动手，改动用最小必要范围实现目标，不顺手重构无关部分。'
        + '实现后必须自检（构建、类型检查、相关测试至少一项），并在报告里写清改了哪些文件、怎么验证的。'
        + '发现方案本身有问题时先报告，不要擅自改变设计。',
    },
    {
      id: 'reviewer',
      provider: '',
      model: '',
      description: '代码审查：检查正确性、可维护性、风格一致性与潜在缺陷，给出按严重程度排序的具体意见。',
      persona:
        '你只审查、不实现。逐条给出**可定位**的意见（文件、位置、问题、建议），并标注严重程度'
        + '（阻断 / 应修 / 建议）。没把握的地方明确说"不确定"，不要把猜测写成结论。'
        + '最后给一句总体结论：可合并 / 修完再看。',
    },
    {
      id: 'tester',
      provider: '',
      model: '',
      description: '测试：设计并补齐覆盖改动的测试，运行验证并报告通过/失败明细；复现缺陷时给出最小步骤。',
      persona:
        '你以"怎么证明它是错的"为出发点设计用例：正常路径、边界、异常与回归。'
        + '用例要独立、可重复、不依赖外部网络与人工步骤；失败时给出最小复现与期望/实际对比。'
        + '不要为了让测试变绿而放宽断言。',
    },
    {
      id: 'security-auditor',
      provider: '',
      model: '',
      description: '安全审计：依赖漏洞、注入与越权、密钥与敏感信息泄漏、不安全默认值；给出风险等级与修复建议。',
      persona:
        '你按攻击面排查：输入边界、权限模型、依赖供应链、日志与配置中的敏感信息。'
        + '每条发现都要有证据（文件/命令/输出）与风险等级，并区分"确定漏洞"与"需要确认的疑点"。'
        + '不要为了凑数报告理论风险；也不要在报告里复述密钥原文。',
    },
    {
      id: 'doc-writer',
      provider: '',
      model: '',
      description: '文档：README、API 说明、使用与迁移文档；面向真实读者写清"是什么、怎么用、边界在哪"。',
      persona:
        '你写给人看：先给最短可用的快速开始，再补细节；命令与代码块必须可直接复制运行。'
        + '以仓库现状为准（先读代码与现有文档），不臆造尚未实现的行为；不确定的地方标注"未验证"。'
        + '保持术语与仓库一致。',
    },
  ].map((specialist) => Object.freeze(specialist)),
);

/** 出厂预置名册的 id 列表（供测试与诊断做结构性断言）。 */
export function defaultSpecialistIds() {
  return DEFAULT_SPECIALISTS.map((specialist) => specialist.id);
}

/**
 * 深拷贝一份出厂名册。
 *
 * 默认值是模块级冻结常量；Loader 会把 schema 默认值解析进配置对象，调用方可能原地修改
 * 其中的数组/对象。返回全新对象，避免"某个会话改了默认值、所有会话跟着变"。
 *
 * @returns {object[]} 可安全修改的副本。
 */
export function cloneDefaultSpecialists() {
  return DEFAULT_SPECIALISTS.map((specialist) => ({ ...specialist }));
}
