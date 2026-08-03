import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeWorkspaceResource,
  findWorkspaceHostForResource,
  forgetWorkspaceResource,
  hasUnsavedNotesWorkspaceChanges,
  getWorkspaceOpenResources,
  registerWorkspaceHost,
  requestWorkspaceResource,
  resetWorkspaceRegistryForTests,
  setWorkspaceActiveResource,
} from '../workspaceRegistry';

describe('notes workspace registry', () => {
  afterEach(() => resetWorkspaceRegistryForTests());

  it('queues an external resource request until the single host mounts', async () => {
    const resource = { type: 'note' as const, id: 'note-queued' };
    const openResource = vi.fn(async () => undefined);
    const requested = requestWorkspaceResource(resource, 'notes-window');

    expect(openResource).not.toHaveBeenCalled();
    registerWorkspaceHost('notes-window', { openResource });

    await expect(requested).resolves.toBe('notes-window');
    expect(openResource).toHaveBeenCalledWith(resource);
    expect(findWorkspaceHostForResource(resource)).toBe('notes-window');
  });

  it('uses the host tab list as authoritative and forgets directly closed tabs', () => {
    const note = { type: 'note' as const, id: 'note-open' };
    const mindmap = { type: 'mindmap' as const, id: 'map-open' };
    let tabs = [note, mindmap];
    registerWorkspaceHost('notes-window', {
      openResource: vi.fn(),
      listResources: () => tabs,
    });
    setWorkspaceActiveResource('notes-window', note);

    expect(getWorkspaceOpenResources()).toEqual([note, mindmap]);
    tabs = [mindmap];
    forgetWorkspaceResource(note, 'notes-window');
    expect(getWorkspaceOpenResources()).toEqual([mindmap]);
  });

  it('closes the internal resource instead of its shared OS window', async () => {
    const resource = { type: 'mindmap' as const, id: 'map-delete' };
    const closeResource = vi.fn(async () => undefined);
    registerWorkspaceHost('notes-window', {
      openResource: vi.fn(),
      closeResource,
    });
    setWorkspaceActiveResource('notes-window', resource);

    await expect(closeWorkspaceResource(resource)).resolves.toBe(true);
    expect(closeResource).toHaveBeenCalledWith(resource);
    expect(findWorkspaceHostForResource(resource)).toBeNull();
  });

  it('aggregates unsaved state from every mounted workspace host', () => {
    const clean = vi.fn(() => false);
    const dirty = vi.fn(() => true);
    registerWorkspaceHost('notes-one', { openResource: vi.fn(), hasUnsavedChanges: clean });
    registerWorkspaceHost('notes-two', { openResource: vi.fn(), hasUnsavedChanges: dirty });

    expect(hasUnsavedNotesWorkspaceChanges()).toBe(true);
    expect(clean).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenCalledTimes(1);
  });

  it('fails safe when an unsaved-state checker throws', () => {
    registerWorkspaceHost('notes-one', {
      openResource: vi.fn(),
      hasUnsavedChanges: () => {
        throw new Error('editor state unavailable');
      },
    });

    expect(hasUnsavedNotesWorkspaceChanges()).toBe(true);
  });
});
