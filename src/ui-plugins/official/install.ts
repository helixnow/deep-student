import type { UiKernel, UiPlugin } from '../../ui-kernel/kernel';
import { compareCodePoints } from '@/ui-sdk/order';
import { excludedOfficialUiPlugins, officialUiPlugins } from './plugins';

// 领域入口只能声明元数据/懒加载工厂，不在这里同步导入页面组件。
// `meta.platforms` 不含当前平台、或生产构建中 `meta.devOnly` 的插件由内核跳过（构建时也不进包，见 ./plugins.ts）。

/**
 * 官方 UI 插件的唯一安装入口（builtin 来源）。首帧前由 `installOfficialUiPlugins` 乐观安装；
 * 随功能模块晚加载的官方插件（`dstu.ui.chat`，见 `features/chat/plugins/official.ts`）在模块就绪时经此安装。
 * 与 Host 的对账由内核按 `meta.host` / `requiresHost` 与 `ctx.ui.pair` 完成。
 */
export function installOfficialUiPlugin(kernel: UiKernel, plugin: UiPlugin): Promise<boolean> {
  return kernel.install(plugin, { origin: 'builtin' });
}

/**
 * 先装构建时排除的官方插件的元数据桩（内核据此记下被跳过的插件和它们的槽位），再按 `order` 装其余官方插件。
 * 桩只在运行平台与构建目标不一致时才会真的装上，此时立即卸载，等同于没有这个插件。
 */
export async function installOfficialUiPlugins(
  kernel: UiKernel,
  plugins: readonly UiPlugin[] = officialUiPlugins,
  excluded: readonly UiPlugin[] = excludedOfficialUiPlugins,
): Promise<void> {
  for (const stub of excluded) if (await installOfficialUiPlugin(kernel, stub)) await kernel.unload(stub.meta.id);
  const ordered = [...plugins].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || compareCodePoints(a.meta.id, b.meta.id));
  for (const plugin of ordered) await installOfficialUiPlugin(kernel, plugin);
}
