import { describe, expect, it, vi } from 'vitest';

const { get, setMetadata } = vi.hoisted(() => ({ get: vi.fn(), setMetadata: vi.fn() }));
vi.mock('@/dstu', () => ({
  dstu: { get, setMetadata },
  updatedAtToVersionToken: (ms: number) => `v${ms}`,
}));

import {
  attachNoteOrigin, chatCitationsToNoteMarkdown, noteOriginFromNode, parseNoteOrigin, serializeNoteOrigin,
} from '../noteOrigin';

describe('note origin', () => {
  it('round-trips chat and resource origins and rejects malformed values', () => {
    const chat = { kind: 'chat' as const, sessionId: 's1', messageId: 'm1', title: '复习讨论' };
    expect(parseNoteOrigin(serializeNoteOrigin(chat))).toEqual(chat);
    const res = { kind: 'resource' as const, resourceId: 'file_1', page: 12, title: '讲义' };
    expect(parseNoteOrigin(serializeNoteOrigin(res))).toEqual(res);
    expect(parseNoteOrigin('{"kind":"chat"}')).toBeNull();
    expect(parseNoteOrigin('not json')).toBeNull();
    expect(parseNoteOrigin(undefined)).toBeNull();
    expect(serializeNoteOrigin({ kind: 'chat', sessionId: 's', title: 'x'.repeat(200) }).length).toBeLessThan(512);
    expect(noteOriginFromNode({ metadata: { props: { _origin: serializeNoteOrigin(res) } } } as never)).toEqual(res);
  });

  it('merges the origin into existing props with the version baseline', async () => {
    get.mockResolvedValue({ ok: true, value: { id: 'note_a', updatedAt: 42, metadata: { props: { study_course: '高数' } } } });
    setMetadata.mockResolvedValue({ ok: true });
    expect(await attachNoteOrigin('note_a', { kind: 'chat', sessionId: 's1', messageId: 'm1' })).toBe(true);
    const [path, metadata, version] = setMetadata.mock.calls[0];
    expect(path).toBe('/note_a');
    expect(version).toBe('v42');
    expect(metadata.props.study_course).toBe('高数');
    expect(parseNoteOrigin(metadata.props._origin)).toMatchObject({ sessionId: 's1', messageId: 'm1' });
  });

  it('turns PDF citations into pdfref links and drops numbered badges', () => {
    const out = chatCitationsToNoteMarkdown(
      '定理见 [PDF@file_a:12] 与 [PDF@file_a:3-4]，参考 [知识库-2]。',
      (page) => `第 ${page} 页`,
      { buildPdfRefHref: (id, page) => `pdfref://${id}?page=${page}`, createCitationPattern: () => /\[(知识库)-(\d+)\]/g },
    );
    expect(out).toBe('定理见 [第 12 页](pdfref://file_a?page=12) 与 [第 3 页](pdfref://file_a?page=3)，参考。');
  });
});
