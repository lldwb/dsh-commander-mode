/**
 * 把 **specialist preset 从模式目录里隐藏**（但保留注册）。
 *
 * ## 要解决的问题
 *
 * 每个 specialist 都需要一份独立人设。DSH 0.2.x 的 `tool-subagent`/`subagents` 已不再
 * 接受 `persona` 参数，人设只能由**独立 agent preset** 承载 —— 所以 `lib/specialists.js`
 * 给每位专家注册一个 `commander-specialist-<id>-<hash>` preset。
 *
 * 副作用：`agentPresets.register()` 注册的东西会出现在**模式选择菜单**里。用户会看到
 * 「指挥官 specialist: architect / implementer / …」六条 —— 它们不是可选模式，只是指挥者
 * 内部的专家，不该出现在那儿。
 *
 * ## 怎么隐藏
 *
 * 模式目录的 UI 通道是 `agentPresets.remoteExportList()`（`@Remote('list')`），它返回
 * `{ presets: [...] }`。这里把它包一层，过滤掉 `isHidden()` 命中的 preset：
 *
 * - **只影响目录读取**（UI 列表），不影响 `register` / `retain` / `mount` ——
 *   specialist 工具仍然按 id 挂载，人设照常生效；
 * - `list()` 这个内部方法不动，诊断（`inspectCompositions`）仍能看到全部 preset。
 *
 * ## 为什么这么绕
 *
 * `remoteExportList` 定义在 registry 的**原型**上，而某些部署里 `ctx.agentPresets` 拿到的是
 * 服务代理，代理对象上直接赋值不会影响 Remote 分派实际调用的那个对象。所以这里沿原型链
 * 找到方法真正的 owner，再在 owner 上 `defineProperty` 覆盖 —— 直接调用与 Remote 分派
 * 都解析到同一个包装函数。参考实现（dsh-multi-model-orchestrator）用同样的手法隐藏它的
 * legacy preset。
 *
 * @module dsh-commander-mode/lib/preset-catalog
 */

/** specialist preset id 的前缀（见 `lib/specialists.js` 的 `specialistPresetId()`）。 */
export const SPECIALIST_PRESET_PREFIX = 'commander-specialist-';

/**
 * 判断一个 preset id 是否是「本插件为 specialist 动态注册的」那种。
 *
 * @param {unknown} id - preset id。
 * @returns {boolean} 是否应当从模式目录里隐藏。
 */
export function isSpecialistPresetId(id) {
  return typeof id === 'string' && id.startsWith(SPECIALIST_PRESET_PREFIX);
}

/** 沿原型链找到方法 owner 及其属性描述符。 */
function findMethodOwner(target, name) {
  let owner = target;
  let descriptor = owner === null || owner === undefined ? undefined : Object.getOwnPropertyDescriptor(owner, name);
  while (descriptor === undefined && owner !== null && owner !== undefined) {
    owner = Object.getPrototypeOf(owner);
    descriptor = owner === null || owner === undefined ? undefined : Object.getOwnPropertyDescriptor(owner, name);
  }
  return { owner, descriptor };
}

/**
 * 把目录读取（`remoteExportList`）包一层，过滤掉 `isHidden(id)` 命中的 preset。
 *
 * @param {object} agentPresets - `ctx.agentPresets` 服务实例（或其代理）。
 * @param {(id: string) => boolean} [isHidden] - 判定函数，默认隐藏本插件的 specialist preset。
 * @returns {() => void} 恢复函数（幂等；服务已重载/已被别人换掉时安全退出）。
 * @throws {TypeError} 服务上找不到可替换的 `remoteExportList` 时抛出（由调用方降级处理）。
 */
export function hidePresetsFromCatalog(agentPresets, isHidden = isSpecialistPresetId) {
  if (agentPresets === null || typeof agentPresets !== 'object') {
    throw new TypeError('agentPresets 服务不可用');
  }
  const originalList = agentPresets.remoteExportList;
  if (typeof originalList !== 'function') {
    throw new TypeError('agentPresets.remoteExportList 不是函数');
  }

  const filteredList = async function filteredRemoteExportList(...args) {
    const response = await originalList.apply(this, args);
    if (response === null || typeof response !== 'object' || !Array.isArray(response.presets)) return response;
    return {
      ...response,
      presets: response.presets.filter((preset) => !isHidden(preset?.id)),
    };
  };

  const { owner, descriptor } = findMethodOwner(agentPresets, 'remoteExportList');
  if (owner === null || owner === undefined || descriptor === undefined) {
    throw new TypeError('agentPresets.remoteExportList 不可替换（找不到方法 owner）');
  }
  const replaceable =
    descriptor.writable === true || (descriptor.writable === undefined && descriptor.configurable === true);
  if (!replaceable) {
    throw new TypeError('agentPresets.remoteExportList 不可替换（属性不可写）');
  }

  Object.defineProperty(owner, 'remoteExportList', {
    ...descriptor,
    value: filteredList,
  });

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    // 只恢复"仍然是我们这层包装"的情况：别人后来也包装过时不要覆盖别人的。
    if (owner.remoteExportList !== filteredList) return;
    Object.defineProperty(owner, 'remoteExportList', {
      ...descriptor,
      value: originalList,
    });
  };
}
