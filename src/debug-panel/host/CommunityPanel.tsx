import React from 'react';
import type { UiKernel } from '@/ui-kernel/kernel';
import { UiPluginScopeProvider, type UiPluginScopeValue } from '@/ui-kernel/react';

/** Community panels get their plugin scope and fail on their own; official panels render exactly as before. */
export class CommunityPanel extends React.Component<
  { scope: UiPluginScopeValue; panelId: string; kernel: UiKernel | null; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    const { kernel, scope, panelId } = this.props;
    kernel?.errors.report({ pluginId: scope.id, origin: scope.origin, phase: 'render', slot: 'debug.panels', entryId: panelId, error });
  }

  render() {
    if (this.state.failed) return null;
    return <UiPluginScopeProvider value={this.props.scope}>{this.props.children}</UiPluginScopeProvider>;
  }
}
