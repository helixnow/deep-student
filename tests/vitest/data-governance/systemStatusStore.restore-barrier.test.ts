import { beforeEach, describe, expect, it } from 'vitest';
import { useSystemStatusStore } from '@/stores/systemStatusStore';

describe('restore maintenance barrier', () => {
  beforeEach(() => {
    useSystemStatusStore.setState({
      maintenanceMode: false,
      maintenanceReason: null,
      maintenanceRequiresRestart: false,
      maintenanceGeneration: 0,
    });
  });

  it('cannot be cleared by finally after restart is required', () => {
    const store = useSystemStatusStore.getState();
    store.enterMaintenanceMode('restoring');
    useSystemStatusStore.getState().requireMaintenanceRestart('restart required');
    const generation = useSystemStatusStore.getState().maintenanceGeneration;

    useSystemStatusStore.getState().exitMaintenanceMode();

    expect(useSystemStatusStore.getState()).toMatchObject({
      maintenanceMode: true,
      maintenanceReason: 'restart required',
      maintenanceRequiresRestart: true,
      maintenanceGeneration: generation,
    });
  });

  it('still clears ordinary maintenance sessions', () => {
    useSystemStatusStore.getState().enterMaintenanceMode('exporting');
    useSystemStatusStore.getState().exitMaintenanceMode();

    expect(useSystemStatusStore.getState()).toMatchObject({
      maintenanceMode: false,
      maintenanceReason: null,
      maintenanceRequiresRestart: false,
    });
  });
});
