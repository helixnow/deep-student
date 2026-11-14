import { expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ launch: vi.fn(), navigate: vi.fn() }));
vi.mock('../../shared/workbenchHost', () => ({
  isWorkbenchHostEnabled: () => true,
  launchWorkbenchApp: host.launch,
}));
vi.mock('../../events/app', () => ({
  APP_EVENTS: { NAVIGATE_TO_VIEW: 'NAVIGATE_TO_VIEW' },
  dispatchAppEvent: host.navigate,
}));

it('routes a cold mindmap through one host opener instead of launching duplicate Notes windows', async () => {
  const { getAppKernel } = await import('../bootstrap');
  const kernel = getAppKernel();
  let unregister: (() => void) | undefined;
  host.navigate.mockImplementation(() => {
    unregister = kernel.anchors.registerAnchorRevealHandler('mindmap', {
      canHandle: () => 'exact-mounted', reveal: () => true,
    });
  });
  expect(await kernel.anchors.reveal({ kind: 'mindmap', resourceId: 'mm_cold', nodeId: 'node_1' }))
    .toMatchObject({ ok: true, outcome: 'opened-and-revealed' });
  expect(host.navigate).toHaveBeenCalledExactlyOnceWith('NAVIGATE_TO_VIEW', {
    view: 'learning-hub', openResource: '/mm_cold',
  });
  expect(host.launch).not.toHaveBeenCalled();
  unregister?.();
  await kernel.dispose();
});
