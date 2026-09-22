import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { exportResourceById } from './exportResource';

const mocks = vi.hoisted(() => ({
  exportResource: vi.fn(), exportFormats: vi.fn(), getNoteEditor: vi.fn(),
  saveTextFile: vi.fn(), copyTextToClipboard: vi.fn(), notify: vi.fn(),
}));
vi.mock('@/dstu', () => ({ dstu: { exportResource: mocks.exportResource, exportFormats: mocks.exportFormats } }));
vi.mock('@/utils/fileManager', () => ({ fileManager: { saveTextFile: mocks.saveTextFile } }));
vi.mock('@/utils/clipboardUtils', () => ({ copyTextToClipboard: mocks.copyTextToClipboard }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: mocks.notify }));
vi.mock('@/features/workbench/agent/drivers/noteDriver', () => ({ getNoteEditor: mocks.getNoteEditor }));
const t = ((key: string) => key) as TFunction;
const header = '---\nid: note_1\ntitle: "Note"\n---\n\n';

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Desktop');
  mocks.exportFormats.mockResolvedValue({ ok: true, value: ['markdown'] });
  mocks.exportResource.mockResolvedValue({ ok: true, value: {
    payloadType: 'text', content: header + 'disk only', suggestedFilename: 'Note.md',
  } });
  mocks.saveTextFile.mockResolvedValue({ path: '/export/Note.md', canceled: false });
  mocks.copyTextToClipboard.mockResolvedValue(true);
});

describe('note export full draft contract', () => {
  it('materializes before plain export and keeps layout Markdown on explicit layout export', async () => {
    let windowed = true;
    const materialize = vi.fn(async () => { windowed = false; });
    const plain = vi.fn(() => { expect(windowed).toBe(false); return 'left\n\nright\n'; });
    const layout = '<!-- ds:columns -->\nleft and right\n';
    mocks.getNoteEditor.mockReturnValue({
      getFullDocument: () => ({ noteId: 'note_1', revision: 4, markdown: layout }),
      materializeFullDocument: materialize, isDocumentWindowed: () => windowed, getPlainMarkdown: plain,
    });
    expect(await exportResourceById('note_1', t)).toBe(true);
    expect(mocks.saveTextFile.mock.calls[0][0].content).toBe(header + 'left\n\nright\n');
    expect(materialize).toHaveBeenCalledOnce();
    expect(await exportResourceById('note_1', t, undefined, 'layout')).toBe(true);
    expect(mocks.saveTextFile.mock.calls[1][0].content).toBe(header + layout);
    expect(plain).toHaveBeenCalledOnce();
  });
  it('keeps export metadata and includes the latest unsaved prefix and hidden tail in the owning window', async () => {
    let markdown = 'initial draft';
    mocks.getNoteEditor.mockReturnValue({ getFullDocument: () => ({ noteId: 'note_1', revision: 3, markdown }) });
    mocks.exportResource.mockImplementation(async () => {
      markdown = 'latest UNSAVED prefix\nHIDDEN tail\n\n';
      return { ok: true, value: { payloadType: 'text', content: header + 'disk only', suggestedFilename: 'Note.md' } };
    });
    expect(await exportResourceById('note_1', t, 'window-A')).toBe(true);
    expect(mocks.getNoteEditor).toHaveBeenCalledWith('note_1', 'window-A');
    expect(mocks.saveTextFile.mock.calls[0][0].content).toBe(header + markdown);
  });

  it('mobile copy uses the same complete draft and preserves an empty draft', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
    mocks.getNoteEditor.mockReturnValue({ getFullDocument: () => ({ noteId: 'note_1', revision: 4, markdown: '' }) });
    expect(await exportResourceById('note_1', t)).toBe(true);
    expect(mocks.copyTextToClipboard).toHaveBeenCalledWith(header);
    expect(mocks.saveTextFile).not.toHaveBeenCalled();
  });

  it('does not export stale disk content when a mounted editor cannot provide its full draft', async () => {
    mocks.getNoteEditor.mockReturnValue({ getMarkdown: () => 'visible only' });
    expect(await exportResourceById('note_1', t)).toBe(false);
    expect(mocks.saveTextFile).not.toHaveBeenCalled();
  });

  it('uses the complete persisted export for an unopened note', async () => {
    expect(await exportResourceById('note_1', t)).toBe(true);
    expect(mocks.saveTextFile.mock.calls[0][0].content).toBe(header + 'disk only');
  });
});
