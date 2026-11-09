/**
 * 自带的极简 preset 声明器 —— 语义等价于随附的 `@deepseek-ai/dsh-agent-preset`。
 *
 * ## 为什么不用随附声明器
 *
 * 插件页「包含的组件」里每一行的标题由**该行的模块名**决定：
 * `declaredRows()` 会调 `pluginPackages.metaOf(row.name, base)` 读该模块的
 * `locale/*.json`（见 Host 的 `plugin-manager` 实现）。本包有两个模式（指挥者 /
 * 项目经理），如果两行都写成 `name: '@deepseek-ai/dsh-agent-preset'`，两行解析到同一个
 * 模块、只能拿到同一份 locale，于是标题必然都是「Agent 预设定义」——用户分不清哪行是
 * 哪个模式。
 *
 * 改用本包的两个子路径模块（`dsh-commander-mode/preset-commander` /
 * `dsh-commander-mode/preset-project-manager`）后，每行都有自己的
 * `<模块>/locale/*.json` 与 `<模块>/icon`，标题就是「指挥者模式」/「项目经理模式」。
 *
 * ## 语义保持
 *
 * 随附声明器做的事就一件：把 `{ id, name, description, order, plugins }` 交给
 * `ctx.agentPresets.register()`，并在卸载时释放。这里做同一件事，差别只有两点：
 *
 * 1. 用普通 `apply` + `ctx.effect`，而不是 `Service.init` 生成器 —— 注入
 *    `agentPresets` 后注册时机等价，释放由 effect 负责；
 * 2. **不设置 `EntryGroup.key`**：非 group 行的配置会被 Loader 递归求值 `!!js`
 *    （`internal/config` 钩子：group 行保留表达式给子行，普通行才 `interpolate`），
 *    所以本行拿到的 `plugins` 里 `disabled` 已是布尔、`customSkillDirs` 已是字符串数组；
 *    registry 的 `mountPreset` 再按普通 entry list 挂载，行为与随附声明器一致。
 *
 * @module dsh-commander-mode/lib/preset-declaration
 */

import z from '@deepseek-ai/schemastery';

/**
 * preset 声明的配置形状 —— 与随附声明器的 `Config` 一致。
 *
 * `plugins` 用 `z.array(z.any())`：子行结构由 Loader 与 preset registry 负责，
 * 声明器不该重新定义它（否则 DSH 升级新增字段时这里会挡路）。
 */
export const PresetDeclarationConfig = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  order: z.number(),
  plugins: z.array(z.any()).required(),
});

/**
 * 注册一个 preset，并把释放挂到当前插件作用域上。
 *
 * 注册是异步的（`agentPresets.register()` 返回 Promise<unregister>）：加载期不等它，
 * 但卸载时必须等它完成再调用 unregister，否则会漏释放（precise 语义：cancelled 后
 * 一旦注册完成就立刻释放）。
 *
 * @param {object} ctx - Cordis 插件上下文（必须已注入 `agentPresets`）。
 * @param {object} config - 本行 config（`PresetDeclarationConfig` 解析后的对象）。
 * @param {string} label - 日志前缀（例如 `preset-commander`）。
 * @returns {Promise<void>} 注册结果（失败只记 warning，不影响插件其余部分）。
 */
export function declarePreset(ctx, config, label) {
  const definition = config ?? {};
  const id = typeof definition.id === 'string' && definition.id.trim() !== '' ? definition.id : 'unnamed';
  let cancelled = false;
  /** @type {undefined | (() => unknown)} */
  let release;

  const registration = Promise.resolve()
    .then(() => ctx.agentPresets.register(definition))
    .then((disposer) => {
      if (typeof disposer !== 'function') return;
      if (cancelled) {
        // 作用域已经销毁，但注册刚刚完成：立刻释放，不要让 preset 留在注册表里。
        Promise.resolve(disposer).then((fn) => fn?.()).catch(() => {});
        return;
      }
      release = disposer;
    })
    .catch((error) => {
      // 注册失败（id 重复、plugins 结构非法……）只记日志：模式自己还要能起。
      ctx.logger?.warn?.(`${label}: 注册 agent preset 失败：%o`, error);
    });

  ctx.effect(
    () => () => {
      cancelled = true;
      void registration.then(() => {
        try {
          release?.();
        } catch (error) {
          ctx.logger?.warn?.(`${label}: 释放 agent preset 失败：%o`, error);
        }
      });
    },
    `${label}: preset ${id}`,
  );

  return registration;
}
