import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  callback: undefined as undefined | ((event: { payload: Record<string, unknown> }) => void),
  unlisten: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mocks.listen,
}));

import {
  PDF_ANNOTATIONS_CHANGED_EVENT,
  matchesPdfAnnotationResource,
  resolvePdfAnnotationSaveBaseline,
  subscribePdfAnnotationChanges,
} from '../pdfAnnotationEvents';

describe('PDF annotation refresh events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callback = undefined;
    mocks.listen.mockImplementation(async (_event: string, callback: typeof mocks.callback) => {
      mocks.callback = callback;
      return mocks.unlisten;
    });
  });

  it('matches both canonical paths and textbook ids without cross-resource refreshes', () => {
    expect(matchesPdfAnnotationResource('/folder/file_123', { resource_path: '/folder/file_123' })).toBe(true);
    expect(matchesPdfAnnotationResource('/folder/file_123', { textbook_id: 'file_123' })).toBe(true);
    expect(matchesPdfAnnotationResource('/folder/file_123', { textbook_id: 'file_999' })).toBe(false);
  });

  it('subscribes to the real event and forwards only matching committed changes', async () => {
    const onChange = vi.fn();
    const unlisten = await subscribePdfAnnotationChanges('/folder/file_123', onChange);

    expect(mocks.listen).toHaveBeenCalledWith(PDF_ANNOTATIONS_CHANGED_EVENT, expect.any(Function));
    mocks.callback?.({ payload: { textbook_id: 'file_other', updated_at: 'rev-1' } });
    expect(onChange).not.toHaveBeenCalled();

    const payload = { textbook_id: 'file_123', kind: 'highlights', updated_at: 'rev-2' };
    mocks.callback?.({ payload });
    expect(onChange).toHaveBeenCalledWith(payload);

    unlisten();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it('recovers OCC conflicts while allowing unrelated textbook revisions', () => {
    const committed = [{ id: 'hl-1', text: 'old' }];
    expect(
      resolvePdfAnnotationSaveBaseline('rev-1', JSON.stringify(committed), 'rev-2', committed),
    ).toEqual({ status: 'save', expectedRevision: 'rev-2' });

    const external = [{ id: 'hl-1', text: 'external edit' }];
    expect(
      resolvePdfAnnotationSaveBaseline('rev-1', JSON.stringify(committed), 'rev-2', external),
    ).toEqual({ status: 'reload', revision: 'rev-2', highlights: external });

    expect(resolvePdfAnnotationSaveBaseline(null, '[]', 'rev-2', [])).toEqual({
      status: 'missing_revision',
    });
  });
});
