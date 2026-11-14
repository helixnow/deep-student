/**
 * 配对 Host 半降级时的视图（FE-A3）：沿用 `FeatureUnavailablePanel`。
 *
 * 面板只读 `systemStatusStore.componentHealth`，所以挂载期间把降级项并入其中；启动同步
 * （`useSystemStatusSync` / `main.tsx`）会整体覆盖该列表，覆盖后再并回。最后一个视图卸载时移除。
 * 本模块经 `React.lazy` 加载，归属 UI 层（`src/components/`）：官方 UI 插件（`src/ui-plugins/`）
 * 与 `@deepstudent/ui`（`src/ui-sdk/`）都能向下引用它，插件树不因此反向依赖 SDK。
 */
import { useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FeatureUnavailablePanel } from '@/components/system-status/FeatureUnavailablePanel';
import { useSystemStatusStore, type StartupComponentIssue } from '@/stores/systemStatusStore';

export interface HostUnavailablePanelProps {
  hostId: string;
  titleKey: string;
  reason?: string;
}

/** 降级项在 `componentHealth` 中的组件名（加前缀，避免与后端组件同名）。 */
export const hostIssueComponent = (hostId: string) => `host:${hostId}`;

const mounted = new Map<string, { count: number; issue: StartupComponentIssue; off: () => void }>();

function hasIssue(list: readonly StartupComponentIssue[], issue: StartupComponentIssue): boolean {
  return list.some((entry) => entry.component === issue.component && entry.status === issue.status && entry.reason === issue.reason);
}

function merge(issue: StartupComponentIssue): void {
  const { componentHealth, setComponentHealth } = useSystemStatusStore.getState();
  if (hasIssue(componentHealth, issue)) return;
  setComponentHealth([...componentHealth.filter((entry) => entry.component !== issue.component), issue]);
}

function retain(issue: StartupComponentIssue): () => void {
  const current = mounted.get(issue.component);
  if (current && current.issue.reason === issue.reason) {
    current.count += 1;
  } else {
    current?.off();
    merge(issue);
    const off = useSystemStatusStore.subscribe((state) => {
      if (!hasIssue(state.componentHealth, issue)) merge(issue);
    });
    mounted.set(issue.component, { count: (current?.count ?? 0) + 1, issue, off });
  }
  return () => {
    const entry = mounted.get(issue.component);
    if (!entry || --entry.count > 0) return;
    entry.off();
    mounted.delete(issue.component);
    const { componentHealth, setComponentHealth } = useSystemStatusStore.getState();
    setComponentHealth(componentHealth.filter((item) => item.component !== issue.component));
  };
}

export default function HostUnavailablePanel({ hostId, titleKey, reason }: HostUnavailablePanelProps) {
  const { t } = useTranslation();
  const component = hostIssueComponent(hostId);
  useLayoutEffect(() => retain({ component, status: 'degraded', reason: reason || null, dependency: null }), [component, reason]);
  return <FeatureUnavailablePanel component={component} title={t(titleKey)} />;
}
