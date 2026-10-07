import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('activity timeline thinking summary source', () => {
  const activityTimelineSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/ActivityTimeline/ActivityTimeline.tsx'),
    'utf-8'
  );
  const activityTimelineCssSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/ActivityTimeline/ActivityTimeline.css'),
    'utf-8'
  );
  const thinkingChainCssSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/renderers/ThinkingChain.css'),
    'utf-8'
  );
  const chatCssSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/styles/chat.css'),
    'utf-8'
  );

  it('keeps completed thinking auto-collapsed by default', () => {
    expect(activityTimelineSource).toContain('function readAutoCollapseSetting(): boolean');
    expect(activityTimelineSource).toContain('return !autoCollapseEnabled;');
    expect(activityTimelineSource).toContain('setIsExpanded(false);');
    expect(activityTimelineSource).not.toContain('preserveStickyOnCollapse');
    expect(activityTimelineSource).not.toContain('shouldStickSummary');
    expect(activityTimelineSource).not.toContain('thinking-summary-sticky');
  });

  it('pins the summary row only while expanded', () => {
    expect(activityTimelineSource).toContain("isExpanded && 'thinking-summary-row--pinned'");
    expect(activityTimelineCssSource).toContain('.thinking-summary-row--pinned {');
    expect(activityTimelineCssSource).toContain('position: sticky;');
    expect(activityTimelineCssSource).toContain('top: 0;');
    // 收起态不挂顶：class 由 isExpanded 单向驱动，不存在 sticky 常驻分支
    expect(activityTimelineSource).not.toContain('sticky top-0');
  });

  it('gives the thinking chain a fixed peek window while thinking', () => {
    expect(activityTimelineSource).toContain('const isPeeking = node.isThinking && !isUserToggled;');
    expect(activityTimelineSource).toContain("'activity-timeline-thinking-peek'");
    expect(activityTimelineSource).toContain("!isPeeking && 'activity-timeline-thinking-peek--expanded'");
    expect(activityTimelineCssSource).toContain('.activity-timeline-thinking-peek {');
    expect(activityTimelineCssSource).toContain('max-height: var(--chat-thinking-peek-height, 8.5rem);');
    // 展开态撤掉高度限制与渐隐 → 全部展开
    expect(activityTimelineCssSource).toContain('.activity-timeline-thinking-peek--expanded {');
    expect(activityTimelineCssSource).toContain('max-height: none;');
  });

  it('makes the peek window a scroll container that auto-follows the newest reasoning', () => {
    // 必须可滚动，overflow:hidden 会让 scrollTop 永远为 0，跟随失效
    expect(activityTimelineCssSource).toContain('overflow-y: auto;');
    expect(activityTimelineCssSource).toContain('overscroll-behavior: contain;');
    expect(activityTimelineCssSource).toContain('scrollbar-width: none;');
    expect(activityTimelineCssSource).toContain('.activity-timeline-thinking-peek::-webkit-scrollbar {');

    expect(activityTimelineSource).toContain('const PEEK_FOLLOW_THRESHOLD_PX = 48;');
    expect(activityTimelineSource).toContain('const peekViewportRef = useRef<HTMLDivElement>(null);');
    // 只有中间态跟随：展开态是正常文档流，不该被程序滚动拽走
    expect(activityTimelineSource).toContain('if (!isPeeking) {');
    expect(activityTimelineSource).toContain('if (!el || !isPeekPinnedRef.current) return;');
    expect(activityTimelineSource).toContain('ref={peekViewportRef}');
    expect(activityTimelineSource).toContain('onScroll={handlePeekScroll}');
    // rAF：等 markdown 把新段落写进 DOM，否则 scrollHeight 还是旧值
    expect(activityTimelineSource).toContain('requestAnimationFrame(() => {');
    expect(activityTimelineSource).toContain('return () => cancelAnimationFrame(frame);');
  });

  it('glides large jumps and snaps token-sized appends inside the peek window', () => {
    // 流式每个 token 只长几像素，一律平滑滚动会让动画永远走不完（看着像卡住）
    expect(activityTimelineSource).toContain('const PEEK_SNAP_THRESHOLD_PX = 96;');
    expect(activityTimelineSource).toContain('const distance = maxScrollTop - el.scrollTop;');
    expect(activityTimelineSource).toContain('if (distance <= 1) return;');
    expect(activityTimelineSource).toContain(
      'if (reduceMotion || distance <= PEEK_SNAP_THRESHOLD_PX || typeof el.scrollTo !== \'function\') {'
    );
    // 落位分支保留，供 reduce-motion / 无 scrollTo / 小步追加共用
    expect(activityTimelineSource).toContain('el.scrollTop = el.scrollHeight;');
    expect(activityTimelineSource).toContain(
      "el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });"
    );
    // 不用 CSS scroll-behavior：它会连用户自己的滚动一起改手感。
    // 词边界必需 —— overscroll-behavior 里也含 scroll-behavior 子串。
    expect(activityTimelineCssSource).not.toMatch(/\bscroll-behavior/);
    expect(activityTimelineCssSource).toContain('overscroll-behavior: contain;');
  });

  it('does not mistake its own smooth-scroll frames for the user scrolling up', () => {
    // 平滑滚动会逐帧派发 scroll，中间帧距底很远。没有这道闸，跟随会在
    // 第一次大跳跃后被自己判成「用户上滚」而永久停摆。
    expect(activityTimelineSource).toContain('const isPeekFollowingRef = useRef(false);');
    expect(activityTimelineSource).toContain('if (isPeekFollowingRef.current) {');
    expect(activityTimelineSource).toContain('isPeekFollowingRef.current = true;');
    // 标记只能由「真的滑到底」解除，否则用户翻看就再也记账不到
    expect(activityTimelineSource).toContain('if (isNearBottom) isPeekFollowingRef.current = false;');
    // 离开中间态时两个账本一起复位
    expect(activityTimelineSource).toContain('isPeekPinnedRef.current = true;');
    expect(activityTimelineSource).toContain('isPeekFollowingRef.current = false;');
  });

  it('fades both edges unconditionally and lets the last paragraph sink into the fade', () => {
    // 固定窗口的语义是"内容从这里进出"，少任何一头都会读成硬切
    const bothEdgesGradient = /mask-image: linear-gradient\(\s*to bottom,\s*transparent 0,\s*#000 var\(--chat-thinking-peek-fade, 18px\),\s*#000 calc\(100% - var\(--chat-thinking-peek-fade, 18px\)\),\s*transparent 100%\s*\);/;
    expect(activityTimelineCssSource).toMatch(bothEdgesGradient);
    // 不再按边下发记号
    expect(activityTimelineCssSource).not.toContain('data-peek-edge-top');
    expect(activityTimelineCssSource).not.toContain('data-peek-edge-bottom');
    expect(activityTimelineSource).not.toContain('syncPeekEdges');
    expect(activityTimelineSource).not.toContain('PEEK_EDGE_EPSILON_PX');
    expect(activityTimelineSource).not.toContain('dataset.peekEdge');

    // 贴底时底部渐隐要真盖住字：末段必须沉进渐隐带，否则渐隐全打在尾部 padding 上
    expect(activityTimelineCssSource).toContain(
      '.activity-timeline-thinking-peek > .activity-timeline-thinking-content {'
    );
    expect(activityTimelineCssSource).toContain('padding-bottom: 0;');
    expect(activityTimelineCssSource).toContain(
      '.activity-timeline-thinking-peek .thinking-chain-content:last-child .markdown-content > *:last-child'
    );
  });

  it('pins the summary row without a divider line', () => {
    expect(activityTimelineCssSource).toContain('.thinking-summary-row--pinned {');
    expect(activityTimelineCssSource).toContain('position: sticky;');
    // 展开态内容会从摘要行下方穿过，背景必须不透明，但不要分割线
    expect(activityTimelineCssSource).toContain('background: var(--surface-root);');
    expect(activityTimelineCssSource).not.toContain('box-shadow: 0 1px 0 0 var(--chat-thinking-border);');
  });

  it('wires the peek height and fade width to single chat token sources', () => {
    expect(chatCssSource).toContain('--chat-thinking-peek-height: 8.5rem;');
    expect(chatCssSource).toContain('--chat-thinking-peek-fade: 18px;');
  });

  it('gives each of the three states its own chevron direction', () => {
    expect(activityTimelineSource).toContain("node.isThinking ? 'thinking' : isExpanded ? 'expanded' : 'collapsed'");
    expect(activityTimelineSource).toContain('<CaretUpDown size={12} weight="bold" />');
    expect(activityTimelineSource).toContain('<CaretDown size={12} weight="bold" />');
    expect(activityTimelineSource).toContain('<CaretRight size={12} weight="bold" />');
    // 常驻 rotate:90 会把向下的箭头转成向左，三态必须靠 glyph 本身表达方向
    expect(activityTimelineSource).not.toContain('animate={{ rotate: isExpanded ? 90 : 0 }}');
  });

  it('uses a body-aligned summary row as the thinking trigger', () => {
    expect(activityTimelineSource).toContain('thinking-summary-trigger activity-timeline-thinking-trigger activity-timeline-summary w-full !h-7 !min-h-0 !justify-start !gap-1.5 !px-0 !py-0 !leading-7');
    expect(activityTimelineSource).toContain('text-muted-foreground hover:text-foreground');
    expect(activityTimelineCssSource).toContain('.thinking-summary-trigger:hover,');
    expect(activityTimelineCssSource).toContain('background: transparent;');
    expect(activityTimelineSource).not.toContain('group-hover:translate-x-0.5');
  });

  it('keeps the summary row in normal document flow without negative timeline offsets', () => {
    expect(activityTimelineSource).toContain('thinking-summary-row flex w-full max-w-full items-center');
    expect(activityTimelineSource).not.toContain('-ml-[28px]');
    expect(activityTimelineSource).not.toContain('pl-[28px]');
    expect(activityTimelineSource).not.toContain('-ml-[22px]');
  });

  it('keeps the thinking summary transparent so it matches adjacent timeline entries', () => {
    expect(activityTimelineCssSource).not.toContain('--surface-panel-strong');
    expect(activityTimelineSource).not.toContain('border-[color:var(--surface-divider)]');
  });

  it('keeps list markers inside the visible thinking-chain viewport', () => {
    expect(activityTimelineSource).toContain('className="activity-timeline-thinking-content py-2 pl-2 pr-1 text-gray-500 dark:text-gray-400"');
    expect(thinkingChainCssSource).toContain('padding-left: 1.5rem !important;');
    expect(thinkingChainCssSource).toContain('font-size: var(--chat-activity-detail-font-size, var(--chat-body-font-size));');
    expect(thinkingChainCssSource).toContain('font-weight: var(--chat-activity-detail-font-weight, var(--chat-body-font-weight));');
    expect(thinkingChainCssSource).toContain('list-style-position: outside;');
  });

  it('keeps thinking-chain details in normal flow under the summary row', () => {
    expect(activityTimelineSource).toContain('className="activity-timeline-thinking-details overflow-hidden"');
  });

  it('keeps timeline-to-answer spacing from stacking with markdown first-block margins', () => {
    expect(activityTimelineSource).toContain('activity-timeline__node flex gap-1.5');
    expect(activityTimelineSource).toContain("cn('activity-timeline'");
    expect(chatCssSource).toContain('--chat-activity-summary-font-size: var(--chat-body-font-size);');
    expect(chatCssSource).toContain('--chat-activity-detail-font-size: var(--chat-body-font-size);');
    expect(chatCssSource).toContain('--chat-activity-tool-detail-font-size: var(--chat-md-compact-font-size);');
    expect(chatCssSource).toContain('--chat-activity-status-font-size: var(--font-size-sm);');
    expect(activityTimelineCssSource).toContain('font-size: var(--chat-activity-summary-font-size, var(--chat-body-font-size, 1rem));');
    expect(activityTimelineCssSource).toContain('font-size: var(--chat-activity-detail-font-size, var(--chat-body-font-size, 1rem));');
    expect(activityTimelineCssSource).toContain('font-size: var(--chat-activity-tool-detail-font-size, var(--chat-md-compact-font-size, 0.9375rem));');
    expect(activityTimelineCssSource).toContain('margin-block: 0 var(--chat-activity-content-gap, 0.75rem);');
    expect(activityTimelineCssSource).toContain('padding-bottom: var(--chat-activity-node-gap, 0.75rem);');
    expect(activityTimelineCssSource).toContain('.activity-timeline__node:last-child');
    expect(activityTimelineCssSource).toContain('.activity-timeline + .block-renderer .markdown-content > p:first-child');
  });
});

describe('activity timeline → answer body spacing', () => {
  it('separates the thinking / tool row from the answer like other block gaps', () => {
    const chatCss = readFileSync(resolve(process.cwd(), 'src/features/chat/styles/chat.css'), 'utf8');
    expect(chatCss).toContain('--chat-activity-content-gap: 1.125rem;');
  });
});
