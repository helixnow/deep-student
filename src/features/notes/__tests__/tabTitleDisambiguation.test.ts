import { describe, expect, it } from 'vitest';
import { disambiguateTabTitles } from '../tabTitleDisambiguation';

describe('disambiguateTabTitles (S1-06 multi-tab same-prefix disambiguation)', () => {
  it('disambiguates 4+ Latin notes sharing an arbitrary hyphenated prefix into distinct labels', () => {
    const items = [
      { key: 'note:1', title: 'ProjectX-Alpha' },
      { key: 'note:2', title: 'ProjectX-Beta' },
      { key: 'note:3', title: 'ProjectX-Gamma' },
      { key: 'note:4', title: 'ProjectX-Delta' },
    ];
    const map = disambiguateTabTitles(items);

    const displays = items.map((item) => map.get(item.key)!.display);
    expect(new Set(displays).size).toBe(4);
    expect(map.get('note:1')).toMatchObject({ disambiguated: true, distinguishing: 'Alpha', fullTitle: 'ProjectX-Alpha' });
    expect(map.get('note:2')).toMatchObject({ disambiguated: true, distinguishing: 'Beta', fullTitle: 'ProjectX-Beta' });
    expect(map.get('note:3')).toMatchObject({ disambiguated: true, distinguishing: 'Gamma', fullTitle: 'ProjectX-Gamma' });
    expect(map.get('note:4')).toMatchObject({ disambiguated: true, distinguishing: 'Delta', fullTitle: 'ProjectX-Delta' });
  });

  it('disambiguates 4+ long CJK notes sharing the same prefix without splitting characters', () => {
    const items = [
      { key: 'note:c1', title: '高等数学期中复习笔记 - 第一章 极限' },
      { key: 'note:c2', title: '高等数学期中复习笔记 - 第二章 导数' },
      { key: 'note:c3', title: '高等数学期中复习笔记 - 第三章 积分' },
      { key: 'note:c4', title: '高等数学期中复习笔记 - 第四章 级数' },
    ];
    const map = disambiguateTabTitles(items);

    const displays = items.map((item) => map.get(item.key)!.display);
    expect(new Set(displays).size).toBe(4);
    expect(map.get('note:c1')!.distinguishing).toContain('第一章 极限');
    expect(map.get('note:c2')!.distinguishing).toContain('第二章 导数');
    expect(map.get('note:c3')!.distinguishing).toContain('第三章 积分');
    expect(map.get('note:c4')!.distinguishing).toContain('第四章 级数');
  });

  it('handles mixed open tabs (unrelated notes alongside a 4-note same-prefix cluster)', () => {
    const items = [
      { key: 'note:home', title: 'Welcome' },
      { key: 'note:a', title: 'Quarterly-Architecture-Review-Frontend' },
      { key: 'note:b', title: 'Quarterly-Architecture-Review-Backend' },
      { key: 'note:c', title: 'Quarterly-Architecture-Review-Storage' },
      { key: 'note:d', title: 'Quarterly-Architecture-Review-Security' },
    ];
    const map = disambiguateTabTitles(items);

    expect(map.get('note:home')).toMatchObject({ disambiguated: false, display: 'Welcome' });
    expect(map.get('note:a')!.distinguishing).toBe('Frontend');
    expect(map.get('note:b')!.distinguishing).toBe('Backend');
    expect(map.get('note:c')!.distinguishing).toBe('Storage');
    expect(map.get('note:d')!.distinguishing).toBe('Security');
  });

  it('snaps common prefixes to boundaries so numeric suffixes like 01..04 stay intact', () => {
    const items = [
      { key: 'note:1', title: '2026-Spring-Linear-Algebra-Lecture-01' },
      { key: 'note:2', title: '2026-Spring-Linear-Algebra-Lecture-02' },
      { key: 'note:3', title: '2026-Spring-Linear-Algebra-Lecture-03' },
      { key: 'note:4', title: '2026-Spring-Linear-Algebra-Lecture-04' },
    ];
    const map = disambiguateTabTitles(items);

    expect(items.map((item) => map.get(item.key)!.distinguishing)).toEqual(['01', '02', '03', '04']);
  });

  it('recursively disambiguates nested sub-clusters sharing an even longer prefix', () => {
    const items = [
      { key: 'note:1', title: 'Workspace-ExtremelyLongSubsystemModule-Alpha' },
      { key: 'note:2', title: 'Workspace-ExtremelyLongSubsystemModule-Beta' },
      { key: 'note:3', title: 'Workspace-OtherArea-Gamma' },
      { key: 'note:4', title: 'Workspace-OtherArea-Delta' },
    ];
    const map = disambiguateTabTitles(items);

    expect(map.get('note:1')!.distinguishing).toBe('Alpha');
    expect(map.get('note:2')!.distinguishing).toBe('Beta');
    expect(map.get('note:3')!.distinguishing).toBe('Gamma');
    expect(map.get('note:4')!.distinguishing).toBe('Delta');
  });

  it('preserves short non-colliding titles and handles identical or strict-prefix titles safely', () => {
    const shortItems = [
      { key: 'note:1', title: '课堂笔记' },
      { key: 'note:2', title: '第二笔记' },
      { key: 'note:3', title: '第三笔记' },
    ];
    const shortMap = disambiguateTabTitles(shortItems);
    expect(shortItems.map((i) => shortMap.get(i.key)!.display)).toEqual(['课堂笔记', '第二笔记', '第三笔记']);

    const strictPrefixItems = [
      { key: 'note:base', title: 'ResearchPaper' },
      { key: 'note:1', title: 'ResearchPaper-Introduction' },
      { key: 'note:2', title: 'ResearchPaper-Methodology' },
      { key: 'note:3', title: 'ResearchPaper-Conclusion' },
    ];
    const strictMap = disambiguateTabTitles(strictPrefixItems);
    expect(strictMap.get('note:base')!.display).toBe('ResearchPaper');
    expect(strictMap.get('note:1')!.distinguishing).toBe('Introduction');
    expect(strictMap.get('note:2')!.distinguishing).toBe('Methodology');
    expect(strictMap.get('note:3')!.distinguishing).toBe('Conclusion');

    const identicalItems = [
      { key: 'note:dup1', title: 'Long-Identical-Note-Title' },
      { key: 'note:dup2', title: 'Long-Identical-Note-Title' },
    ];
    const dupMap = disambiguateTabTitles(identicalItems);
    expect(dupMap.get('note:dup1')!.display).toBe('Long-Identical-Note-Title');
    expect(dupMap.get('note:dup2')!.display).toBe('Long-Identical-Note-Title');
  });
});
