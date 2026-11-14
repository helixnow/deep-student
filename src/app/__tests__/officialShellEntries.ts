import type { ShellNavItem, ShellView, ViewShell } from '@/ui-kernel/contracts/shell';
import { createOfficialUiTestKernel } from '@/ui-plugins/testing/render';

/**
 * App 壳层的逐视图配置（侧栏类型、返回按钮、标题栏槽位、移动端启动器……）已从
 * App.tsx 的 currentView 分支移入官方 views / nav slot。源码契约仍读 App 的消费者
 * 表达式（readAppShellSource），配置值经真实内核与生产安装器从这里读。
 */
export async function readOfficialShellEntries(): Promise<{ views: Map<string, ShellView>; nav: ShellNavItem[] }> {
  const kernel = await createOfficialUiTestKernel();
  try {
    return {
      views: new Map(kernel.slots.list('views').map(({ key, value }) => [key, value as ShellView])),
      nav: kernel.slots.list('nav').map(({ value }) => value as ShellNavItem),
    };
  } finally {
    await kernel.dispose();
  }
}

/** 满足条件的视图 id，按字母序。 */
export function shellViewsWhere(views: Map<string, ShellView>, predicate: (shell: ViewShell) => boolean): string[] {
  return [...views].filter(([, view]) => predicate(view.shell ?? {})).map(([id]) => id).sort();
}
