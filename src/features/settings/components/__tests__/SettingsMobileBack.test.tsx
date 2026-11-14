import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import settingsPlugin from '@/ui-plugins/official/settings';
import { useSettingsShellStore } from '@/stores/settingsShellStore';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import type { VendorConfig } from '@/types';
import type { useMcpEditorSection } from '../McpEditorSection';
import type { useSettingsVendorState } from '../useSettingsVendorState';
import type { createMcpServerOps } from '../mcp-editor/mcpServerOps';
import { Settings } from '../Settings';

const captured = vi.hoisted(() => ({
  headerBack: null as (() => void) | null,
  mcp: null as ReturnType<typeof useMcpEditorSection> | null,
  vendor: null as ReturnType<typeof useSettingsVendorState> | null,
  ops: null as ReturnType<typeof createMcpServerOps> | null,
}));

// Keep the real Settings registration and all navigation/cleanup/state hooks.
// Only replace layout rendering and backend I/O; the button invokes the exact
// onMenuClick callback Settings passes to useMobileHeader (not a test rewire).
vi.mock('@/components/layout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/layout')>()),
  useMobileHeader: (_id: string, config: { onMenuClick: () => void }) => {
    captured.headerBack = config.onMenuClick;
  },
  MobileSlidingLayout: ({ screenPosition = 'center' }: { screenPosition?: string }) => (
    <div data-testid="mobile-screen" data-position={screenPosition} />
  ),
}));
vi.mock('@/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/platform')>()),
  isMobilePlatform: () => true,
}));
vi.mock('@/hooks/useBreakpoint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useBreakpoint')>()),
  useBreakpoint: () => ({ isSmallScreen: true }),
  useIsMobile: () => true,
}));
vi.mock('@/hooks/useVendorModels', () => {
  const stable = {
    vendors: [], modelProfiles: [], modelAssignments: {}, resolvedApiConfigs: [],
    loading: false, saving: false,
    upsertVendor: vi.fn(), deleteVendor: vi.fn(), upsertModelProfile: vi.fn(), deleteModelProfile: vi.fn(),
    saveModelAssignments: vi.fn(), persistModelProfiles: vi.fn(), persistVendors: vi.fn(),
  };
  return { useVendorModels: () => stable };
});
vi.mock('@/mcp/mcpService', () => ({
  McpService: {
    fetchServerTools: vi.fn(async () => []),
    fetchServerPrompts: vi.fn(async () => []),
    fetchServerResources: vi.fn(async () => []),
    getCachedToolsSnapshot: () => ({}),
    getCachedPromptsSnapshot: () => ({}),
    getCachedResourcesSnapshot: () => ({}),
    status: vi.fn(async () => ({ servers: [] })),
    onStatus: () => () => {},
  },
}));
vi.mock('../McpEditorSection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../McpEditorSection')>();
  return { useMcpEditorSection: (...args: Parameters<typeof useMcpEditorSection>) => {
    captured.mcp = actual.useMcpEditorSection(...args);
    return captured.mcp;
  } };
});
vi.mock('../useSettingsVendorState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../useSettingsVendorState')>();
  return { useSettingsVendorState: (...args: Parameters<typeof useSettingsVendorState>) => {
    captured.vendor = actual.useSettingsVendorState(...args);
    return captured.vendor;
  } };
});
vi.mock('../mcp-editor/mcpServerOps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mcp-editor/mcpServerOps')>();
  return { createMcpServerOps: (...args: Parameters<typeof createMcpServerOps>) => {
    captured.ops = actual.createMcpServerOps(...args);
    return captured.ops;
  } };
});

let kernel: UiKernel;
let view: ReturnType<typeof render>;
afterEach(async () => {
  view?.unmount();
  await kernel?.dispose();
});

async function mountSettings() {
  useSettingsShellStore.setState({ activeTab: 'mcp' });
  kernel = new UiKernel();
  await kernel.install(settingsPlugin, { origin: 'builtin' });
  view = render(<UiKernelProvider kernel={kernel}>
    <button onClick={() => captured.headerBack!()}>Settings back</button>
    <Settings onBack={() => {}} />
  </UiKernelProvider>);
  await screen.findByTestId('mobile-screen');
  act(() => dispatchAppEvent(APP_EVENTS.SETTINGS_NAVIGATE_TAB, { tab: 'mcp' }));
}
const expectPosition = (position: string) => waitFor(() =>
  expect(screen.getByTestId('mobile-screen')).toHaveAttribute('data-position', position));

describe('Settings mobile header back cleanup', () => {
  it('opens MCP preview, returns via the mobile header, then opens preview again', async () => {
    await mountSettings();
    const openPreview = () => captured.ops!.handlePreviewServer({ id: 'example', name: 'Example' }, 0);
    await act(async () => { await openPreview(); });
    await expectPosition('right');
    expect(captured.mcp!.mcpPreview.open).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Settings back' }));
    await expectPosition('center');
    // Attempt the second open even on the broken version: leftover open=true
    // prevents the real preview-panel effect from opening the right screen.
    const openAfterBack = captured.mcp!.mcpPreview.open;
    await act(async () => { await openPreview(); });
    await expectPosition('right');
    expect(openAfterBack).toBe(false);
    expect(captured.mcp!.mcpPreview.open).toBe(true);
  });

  it.each(['vendorConfig', 'modelEditor', 'mcpTool', 'mcpPolicy'] as const)(
    'clears %s editing state on mobile header back', async (panel) => {
      await mountSettings();
      const vendor = { id: 'vendor', name: 'Vendor', providerType: 'openai', baseUrl: '' } as VendorConfig;
      const open = () => {
        if (panel === 'vendorConfig') captured.vendor!.handleOpenVendorModal(vendor);
        if (panel === 'modelEditor') captured.vendor!.handleOpenModelEditor(vendor);
        if (panel === 'mcpTool') captured.mcp!.handleCreateMcpTool();
        if (panel === 'mcpPolicy') captured.mcp!.handleOpenMcpPolicy();
      };
      act(open);
      await expectPosition('right');
      if (panel === 'mcpTool') act(() => captured.mcp!.setMcpToolModal(prev => ({ ...prev, error: 'invalid draft' })));
      fireEvent.click(screen.getByRole('button', { name: 'Settings back' }));
      await expectPosition('center');
      if (panel === 'vendorConfig') {
        expect(captured.vendor!.vendorModalOpen).toBe(false);
        expect(captured.vendor!.editingVendor).toBeNull();
      }
      if (panel === 'modelEditor') expect(captured.vendor!.modelEditor).toBeNull();
      if (panel === 'mcpTool') {
        expect(captured.mcp!.mcpToolModal.open).toBe(false);
        expect(captured.mcp!.mcpToolModal.error).toBeNull();
      }
      if (panel === 'mcpPolicy') expect(captured.mcp!.mcpPolicyModal.open).toBe(false);
      act(open);
      await expectPosition('right');
    },
  );
});
