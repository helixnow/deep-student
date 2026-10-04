import { describe, expect, it } from 'vitest';

import { isDanglingCitationStart, makeCitationRemarkPlugin } from '../citationRemarkPlugin';

function runPlugin(text: string) {
  const tree: any = {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
  };
  makeCitationRemarkPlugin()()(tree);
  return tree.children[0].children as any[];
}

describe('citationRemarkPlugin media timestamp refs', () => {
  it('parses [媒体@id:mm:ss] into a media-ref placeholder with seconds', () => {
    const children = runPlugin('见 [媒体@file_abc123:12:34] 的讲解');
    expect(children[0]).toMatchObject({ type: 'text', value: '见 ' });
    expect(children[1].type).toBe('html');
    expect(children[1].value).toContain('data-media-ref="true"');
    expect(children[1].value).toContain('data-media-source="file_abc123"');
    expect(children[1].value).toContain('data-media-seconds="754"');
    expect(children[1].value).toContain('▶ 12:34');
    expect(children[2]).toMatchObject({ type: 'text', value: ' 的讲解' });
  });

  it('parses h:mm:ss for media longer than an hour', () => {
    const [node] = runPlugin('[媒体@file_x:1:02:03]');
    expect(node.value).toContain('data-media-seconds="3723"');
    expect(node.value).toContain('▶ 1:02:03');
  });

  it('accepts the English alias and normalises the label', () => {
    const [node] = runPlugin('[Media@file_y:5:07]');
    expect(node.value).toContain('data-media-seconds="307"');
    expect(node.value).toContain('▶ 05:07');
  });

  it('leaves malformed timestamps as plain text', () => {
    const children = runPlugin('[媒体@file_x:12:99] and [媒体@file_x:abc]');
    expect(children).toHaveLength(1);
    expect(children[0].type).toBe('text');
  });

  it('coexists with PDF refs in the same text node', () => {
    const children = runPlugin('[PDF@tb_1:3] 与 [媒体@file_2:00:10]');
    const html = children.filter((c) => c.type === 'html').map((c) => c.value);
    expect(html).toHaveLength(2);
    expect(html[0]).toContain('data-pdf-ref="true"');
    expect(html[1]).toContain('data-media-seconds="10"');
  });

  it('keeps half-streamed media refs from being truncated', () => {
    expect(isDanglingCitationStart('媒')).toBe(true);
    expect(isDanglingCitationStart('媒体@file_1:12')).toBe(true);
    expect(isDanglingCitationStart('Media@file_1')).toBe(true);
  });
});
