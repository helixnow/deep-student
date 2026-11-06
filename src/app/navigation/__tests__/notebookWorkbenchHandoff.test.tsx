import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bus = vi.hoisted(() => ({ launch: vi.fn(), enabled: true }));
vi.mock('@/features/workbench/core/workbenchBus', () => ({
  PDF_PAGE_ACTIVATION_TYPE_IDS: [],
  workbenchBus: { isEnabled: () => bus.enabled, launch: bus.launch },
}));
vi.mock('@/features/workbench/core/handoffDescriptor', () => ({ consumeHandoffDescriptor: () => null }));
vi.mock('@/features/workbench/apps/registerAll', () => ({}));
vi.mock('@/utils/platform', () => ({ isMobilePlatform: () => false }));

import { useClassicToWorkbenchHandoff, WORKBENCH_APP_BY_CLASSIC_VIEW } from '@/app/hooks/useClassicToWorkbenchHandoff';

beforeEach(() => { bus.launch.mockReset(); bus.enabled = true; });

describe('classic notes to notebook OS handoff', () => {
  it('maps the new notebook library separately from the existing resource library', () => {
    expect(WORKBENCH_APP_BY_CLASSIC_VIEW.notes).toBe('notebook');
    expect(WORKBENCH_APP_BY_CLASSIC_VIEW['learning-hub']).toBe('files');
  });

  it('launches the independent notebook app when enabling the desktop OS from notes', async () => {
    const { rerender } = renderHook(({ enabled }) => useClassicToWorkbenchHandoff(enabled, 'notes', null), {
      initialProps: { enabled: false },
    });
    expect(bus.launch).not.toHaveBeenCalled();
    act(() => rerender({ enabled: true }));
    await waitFor(() => expect(bus.launch).toHaveBeenCalledWith({
      typeId: 'notebook', instanceKey: undefined, payload: undefined, reason: 'api',
    }));
  });
});
