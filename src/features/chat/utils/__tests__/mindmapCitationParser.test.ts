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

  describe('node hint (#节点)', () => {
    it('old syntax yields no nodeHint and identical fields', () => {
      const [c] = parseMindmapCitations('见 [思维导图:mm_abc123:Python 基础]');
      expect(c).toEqual({
        fullMatch: '[思维导图:mm_abc123:Python 基础]',
        mindmapId: 'mm_abc123',
        title: 'Python 基础',
        start: 2,
        end: 2 + '[思维导图:mm_abc123:Python 基础]'.length,
      });
      expect(c).not.toHaveProperty('nodeHint');
    });

    it('does not treat # inside the title as a node hint', () => {
      const [c] = parseMindmapCitations('[思维导图:mm_cs01:C# 基础#2]');
      expect(c.mindmapId).toBe('mm_cs01');
      expect(c.title).toBe('C# 基础#2');
      expect(c.nodeHint).toBeUndefined();
    });

    it('parses node text hint with title', () => {
      const [c] = parseMindmapCitations('[思维导图:mm_mlsys#梯度同步 All-Reduce:第 3 章]');
      expect(c).toMatchObject({
        mindmapId: 'mm_mlsys',
        nodeHint: '梯度同步 All-Reduce',
        title: '第 3 章',
      });
    });

    it('parses node hint without title and for version ids', () => {
      const [a, b] = parseMindmapCitations('[思维导图:mm_x1#node_abc] 与 [导图:mv_v2#数据并行：概念:旧版]');
      expect(a).toMatchObject({ mindmapId: 'mm_x1', nodeHint: 'node_abc' });
      expect(a.title).toBeUndefined();
      expect(b).toMatchObject({ mindmapId: 'mv_v2', nodeHint: '数据并行：概念', title: '旧版' });
    });

    it('keeps title colons after the hint', () => {
      const [c] = parseMindmapCitations('[思维导图:mm_x1#节点:标题: 副标题]');
      expect(c).toMatchObject({ nodeHint: '节点', title: '标题: 副标题' });
    });

    it('generator emits hint after id and sanitizes separators', () => {
      expect(generateMindmapCitation('mm_a', '标题', '节点')).toBe('[思维导图:mm_a#节点:标题]');
      expect(generateMindmapCitation('mm_a', undefined, 'a:b]c')).toBe('[思维导图:mm_a#a：b c]');
      const [c] = parseMindmapCitations(generateMindmapCitation('mm_a', '标题', 'x:y'));
      expect(c).toMatchObject({ mindmapId: 'mm_a', nodeHint: 'x：y', title: '标题' });
    });
  });
});
