import { describe, expect, it, vi } from 'vitest';

const { invoke, getFolder } = vi.hoisted(() => ({ invoke: vi.fn(), getFolder: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@/dstu', () => ({ folderApi: { getFolder } }));
import { loadKbScope, setKbScope } from '../kbScope';

describe('kb scope', () => {
  it('loads scope with a readable folder label and persists changes', async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === 'chat_v2_get_rag_scope' ? ['fld_math'] : undefined));
    getFolder.mockResolvedValue({ ok: true, value: { id: 'fld_math', title: '高等数学' } });
    expect(await loadKbScope('sess_1')).toEqual({ folderIds: ['fld_math'], label: '高等数学' });
    await setKbScope('sess_1', []);
    expect(invoke).toHaveBeenCalledWith('chat_v2_set_rag_scope', { sessionId: 'sess_1', folderIds: [] });
  });
});
