import { describe, expect, it } from 'vitest';

import {
  generateMindmapCitation,
  hasMindmapCitations,
  parseMindmapCitations,
} from '../mindmapCitationParser';

describe('mindmapCitationParser', () => {
  it('parses current mindmap citations with title', () => {
    const text = '请看这个导图 [思维导图:mm_abc123:Python 基础]';
    const citations = parseMindmapCitations(text);

    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      mindmapId: 'mm_abc123',
      title: 'Python 基础',
    });
  });

  it('parses version citations (mv_*)', () => {
    const text = '对比旧版本 [思维导图:mv_old123:旧版结构]';
    const citations = parseMindmapCitations(text);

    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      mindmapId: 'mv_old123',
      title: '旧版结构',
    });
  });

  it('detects mindmap citations for version ids', () => {
    expect(hasMindmapCitations('回看 [思维导图:mv_ver_01]')).toBe(true);
  });

  it('keeps citation generator backward compatible', () => {
    expect(generateMindmapCitation('mm_new001', '新版本')).toBe('[思维导图:mm_new001:新版本]');
  });
});
