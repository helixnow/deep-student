import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('MessageList scroll-to-bottom source contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/MessageList.tsx'),
    'utf-8'
  );

  it('keeps the floating control as an icon-only jump-to-bottom affordance', () => {
    expect(source).toContain("t('messageList.scrollToBottom'");
    expect(source).toContain("data-slot=\"message-list-scroll-to-bottom\"");
    expect(source).toContain("import Z_INDEX from '@/config/zIndex';");
    expect(source).toContain('aria-label={scrollToBottomLabel}');
    expect(source).toContain("title={scrollToBottomLabel}");
    expect(source).toContain('className="pointer-events-none absolute inset-x-0 bottom-2 px-4 md:bottom-3 md:px-8"');
    // P0-4: 键盘/输入栏遮挡时按钮容器整体上抬，锚定在输入栏上沿
    expect(source).toContain('zIndex: Z_INDEX.inputBar - 10,');
    expect(source).toContain("transform: inputOverlapPx > 0 ? `translateY(-${inputOverlapPx}px)` : undefined,");
    expect(source).toContain('<ThreadContentShell className="pointer-events-none overflow-visible">');
    expect(source).toContain('className="t-panel-slide ml-auto w-fit"');
    expect(source).toContain("data-open={showScrollToBottom ? 'true' : 'false'}");
    expect(source).toContain('aria-hidden={!showScrollToBottom}');
    expect(source).toContain("['--panel-translate-y' as string]: '12px'");
    expect(source).toContain("['--panel-open-dur' as string]: '300ms'");
    expect(source).toContain("['--panel-close-dur' as string]: '220ms'");
    expect(source).toContain('tabIndex={showScrollToBottom ? 0 : -1}');
    expect(source).toContain("'pointer-events-auto ml-auto flex h-10 w-10 items-center justify-center rounded-full'");
    // P1-8: 视觉 40px + 透明伪元素扩大到 ≥44px 触控命中区
    expect(source).toContain("'relative after:absolute after:-inset-1 after:rounded-full after:content-[\\'\\']'");
    expect(source).toContain("'border border-[color:var(--button-utility-border)] bg-[color:var(--button-utility-surface)]'");
    expect(source).toContain("'text-[color:var(--button-utility-foreground)] transition-colors duration-150'");
    expect(source).toContain("'hover:border-[color:var(--button-utility-border)] hover:bg-[color:var(--button-utility-hover)] hover:text-[color:var(--button-utility-foreground)]'");
    expect(source).toContain("'active:bg-[color:var(--button-utility-active)]'");
    expect(source).toContain('<ArrowDown size={16} weight="bold" />');
    expect(source).not.toContain('<span>新内容</span>');
    expect(source).not.toContain('shadow-md');
    expect(source).not.toContain('hover:shadow-lg');
    expect(source).not.toContain('<ThreadContentShell className="pointer-events-none px-4 md:px-8">');
    expect(source).not.toContain("'hover:bg-[var(--interactive-hover)] hover:text-foreground'");
    expect(source).not.toContain("'hover:border-[color:var(--button-utility-border)] hover:bg-[color:var(--button-utility-hover)] hover:text-[color:var(--text-primary)]'");
  });

  it('classifies reader scrolls via the observedTop ledger (device-agnostic)', () => {
    // 账本法（deepseek-harness ChatView 同款）：所有程序化写入经 writeScroll 记账，
    // scroll 事件里偏离 min(observedTop, floor) 才算读者滚动——
    // 滚轮/触控板/滚动条拖拽/键盘/触摸全覆盖，浏览器收缩 clamp 天然免疫
    expect(source).toContain('const observedTopRef = useRef(0);');
    expect(source).toContain('const atBottomRef = useRef(true);');
    expect(source).toContain('const writeScroll = useCallback((top: number) => {');
    expect(source).toContain('observedTopRef.current = el.scrollTop;');
    expect(source).toContain('Math.abs(el.scrollTop - Math.min(observedTopRef.current, floor)) > 0.5');
    expect(source).toContain('floor - el.scrollTop <= BOTTOM_THRESHOLD_PX');
    expect(source).toContain("el.addEventListener('scroll', onScroll, { passive: true })");
    expect(source).toContain('setShowScrollToBottom(!isAtBottom);');
    expect(source).toContain('atBottomRef.current = isAtBottom;');
    // 按钮可见性由位置决定，而非流式状态
    expect(source).toContain("data-open={showScrollToBottom ? 'true' : 'false'}");
    expect(source).not.toContain('{showScrollToBottom && isStreaming && (');
  });

  it('eliminates device-specific intent listeners, scroll locks and shrink heuristics', () => {
    expect(source).not.toContain('userScrollInteractionRef');
    expect(source).not.toContain('dropExplainedByShrink');
    expect(source).not.toContain('programmaticScrollLockRef');
    expect(source).not.toContain('programmaticScrollUnlockTimerRef');
    expect(source).not.toContain('resumeAutoScrollRef');
    expect(source).not.toContain('isAutoScrollingRef');
    expect(source).not.toContain('syncScrollStateRef');
    expect(source).not.toContain('resetScrollBaselineRef');
    expect(source).not.toContain('onUserScrollUp');
    expect(source).not.toContain("viewportElement.addEventListener('pointerdown'");
    expect(source).not.toContain("viewportElement.addEventListener('keydown'");
  });

  it('follows bottom via layout effect + ResizeObserver instead of a rAF polling loop', () => {
    expect(source).toContain('const followBottom = useCallback(() => {');
    expect(source).toContain('if (!el || !atBottomRef.current) return;');
    expect(source).toContain('writeScroll(el.scrollHeight);');
    // 常驻 RO 跟随（不限流式），log 节点随 listEpoch remount 时用 state 重新观察
    expect(source).toContain('new ResizeObserver(() => { followBottom(); })');
    expect(source).toContain('const [logElement, setLogElement] = useState<HTMLElement | null>(null);');
    expect(source).toContain('ref={setLogElement}');
    // 不再有 rAF 吸底循环 / 降频轮询 / 缓动追赶
    expect(source).not.toContain('scrollLoop');
    expect(source).not.toContain('IDLE_POLL_MS');
    expect(source).not.toContain('distance * 0.35');
  });

  it('transfers scroll ownership to bottom-follow when streaming starts', () => {
    // 发送即回底：统一布局效应里做所有权转移，替代旧的"用户消息对齐顶部"定位
    //（旧实现因助手占位无 min-height 且 rAF 循环立即接管，已退化为 toBottom）
    expect(source).toContain('if (isStreaming && !wasStreaming) {');
    expect(source).toContain('atBottomRef.current = true;');
    expect(source).not.toContain('userMessageEl');
    expect(source).not.toContain('scrollToIndex(messageOrder.length - 2');
  });

  it('settles history-insertion compensation in the layout effect (ledger-recorded)', () => {
    // 插入检测与 initialMessageCount 累加在 render 阶段（由 previousOrder !==
    // messageOrder + prevMessageOrderRef 写回保护，StrictMode 重放恰好执行一次）——
    // 累加必须在 render：isNewlyAppended 入场动画门槛在 render 中消费该计数；
    // 补偿写入统一在提交后的布局效应结算，且走 writeScroll 记账
    expect(source).toContain('lastInsertedCountRef.current = insertedBeforeExisting;');
    expect(source).toContain('initialMessageCountRef.current += insertedBeforeExisting;');
    expect(source).toContain('const insertedCount = lastInsertedCountRef.current;');
    expect(source).toContain('writeScroll(pending.scrollTop + delta);');
    expect(source).not.toContain('initialMessageCountRef.current += insertedCount;');
    expect(source).not.toContain('historyInsertionRef');
  });

  it('gates virtualizer size-change adjustments while following', () => {
    // virtual-core 的实例属性（非构造选项）：跟随时禁止补偿写入（会被账本误判为
    // 读者滚离），阅读时保持 core 默认（仅补偿视口上方的行）
    expect(source).toContain('virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {');
    expect(source).toContain('if (atBottomRef.current) return false;');
    expect(source).toContain("instance.scrollDirection !== 'backward'");
  });

  it('uses transitions-dev panel reveal semantics for fade-out', () => {
    expect(source).toContain('className="t-panel-slide ml-auto w-fit"');
    expect(source).toContain('aria-hidden={!showScrollToBottom}');
  });
});
