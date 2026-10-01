/**
 * StreamingBlockRenderer 完成块渲染跳过测试（2026-09-25 长会话性能治理）
 *
 * 契约：已完成块（isComplete）的 .stream-block wrapper 携带
 * content-visibility:auto + contain-intrinsic-size（离屏块跳过 layout/paint）；
 * 流式中的活动块（isComplete=false）不携带（必须真实参与吸底 layout）。
 */

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { StreamingBlockRenderer } from '../StreamingBlockRenderer';

const CV_STYLE_MARKER = 'content-visibility';

function streamBlockStyles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.stream-block')).map(
    (el) => el.getAttribute('style') ?? '',
  );
}

describe('StreamingBlockRenderer completed-block content-visibility', () => {
  it('已完成消息：全部块携带渲染跳过样式', () => {
    const content = '# 标题\n\n第一段内容。\n\n```ts\nconst a = 1;\n```\n\n收尾段落。';
    const { container } = render(<StreamingBlockRenderer content={content} isStreaming={false} />);

    const blocks = container.querySelectorAll('.stream-block');
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const style of streamBlockStyles(container)) {
      expect(style).toContain(CV_STYLE_MARKER);
    }
  });

  it('流式中的活动块不携带渲染跳过样式（已完成前缀块携带）', () => {
    const { container } = render(
      <StreamingBlockRenderer content={'前缀已完成段落。\n\n活跃正文中'} isStreaming />,
    );

    const styles = streamBlockStyles(container);
    expect(styles.length).toBeGreaterThanOrEqual(2);
    // 最后一块 = 活动块（data-complete="false"）→ 无 content-visibility
    expect(styles[styles.length - 1]).not.toContain(CV_STYLE_MARKER);
    // 前缀已完成块 → 携带
    for (const style of styles.slice(0, -1)) {
      expect(style).toContain(CV_STYLE_MARKER);
    }
  });
});
