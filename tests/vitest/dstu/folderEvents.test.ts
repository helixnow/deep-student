import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DSTU_FOLDER_CHANGE_EVENT,
  emitDstuFolderChange,
  type DstuFolderChangeDetail,
} from '@/dstu/folderEvents';

describe('DSTU folder change events', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes the structural mutation detail on the shared browser event', () => {
    const listener = vi.fn();
    window.addEventListener(DSTU_FOLDER_CHANGE_EVENT, listener);

    const detail: DstuFolderChangeDetail = {
      kind: 'item-moved',
      folderId: 'folder_target',
      itemId: 'note_1',
      itemType: 'note',
    };
    emitDstuFolderChange(detail);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toBeInstanceOf(CustomEvent);
    expect((listener.mock.calls[0]?.[0] as CustomEvent<DstuFolderChangeDetail>).detail).toEqual(detail);
    window.removeEventListener(DSTU_FOLDER_CHANGE_EVENT, listener);
  });
});
