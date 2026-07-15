import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  enqueueAnkiLibraryCard,
  getFsrsStats,
  listAnkiLibraryCards,
  suspendFsrsCard,
  unsuspendFsrsCard,
} from '@/utils/chatApi';

describe('flashcard Library API contracts', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({});
  });

  it('sends the paginated list request with the Rust camelCase field names', async () => {
    await listAnkiLibraryCards({
      template_id: 'design-basic',
      search: 'tag',
      page: 3,
      page_size: 20,
    });

    expect(invokeMock).toHaveBeenCalledWith('list_anki_library_cards', {
      request: {
        templateId: 'design-basic',
        search: 'tag',
        page: 3,
        pageSize: 20,
      },
    });
  });

  it('uses content IDs for enqueue and state IDs for suspend mutations', async () => {
    await enqueueAnkiLibraryCard('anki-1');
    await suspendFsrsCard('state-1');
    await unsuspendFsrsCard('state-1');
    await getFsrsStats();

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'fsrs_enqueue_cards', {
      ankiCardIds: ['anki-1'],
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'fsrs_suspend_card', {
      cardStateId: 'state-1',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'fsrs_unsuspend_card', {
      cardStateId: 'state-1',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'fsrs_get_stats');
  });
});
