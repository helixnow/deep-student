import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('InputBarUI thinking runtime state visibility', () => {
  const inputBarSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/InputBarUI.tsx'),
    'utf-8'
  );

  it('renders the current thinking state as a minimal visible control, not only as tooltip text', () => {
    expect(inputBarSource).toContain('data-testid="thinking-runtime-minimal-control"');
    expect(inputBarSource).toContain('data-testid="thinking-runtime-state-label"');
    expect(inputBarSource).toContain('{thinkingStateLabel}');
  });

  it('keeps depth menu labels terse without slower suffix copy', () => {
    expect(inputBarSource).not.toContain('thinkingDepthExpensive');
  });

  it('opens the depth menu instead of toggling directly when depth options exist', () => {
    const menuBranchStart = inputBarSource.indexOf('{hasThinkingRuntimeMenu ? (');
    const menuBranchEnd = inputBarSource.indexOf(') : (', menuBranchStart);
    const menuBranch = inputBarSource.slice(menuBranchStart, menuBranchEnd);

    expect(menuBranchStart).toBeGreaterThan(-1);
    expect(menuBranchEnd).toBeGreaterThan(menuBranchStart);
    expect(menuBranch).toContain('data-testid="thinking-runtime-menu-trigger"');
    expect(menuBranch).not.toContain('onClick={onToggleThinking}');
  });

  it('orders reasoning depth choices before the off action', () => {
    const menuGroupStart = inputBarSource.indexOf("label={t('chatV2:inputBar.thinkingDepthTitle', '推理强度')}");
    const menuGroupEnd = inputBarSource.indexOf('</AppMenuGroup>', menuGroupStart);
    const menuGroup = inputBarSource.slice(menuGroupStart, menuGroupEnd);

    expect(menuGroupStart).toBeGreaterThan(-1);
    expect(menuGroupEnd).toBeGreaterThan(menuGroupStart);
    expect(menuGroup.indexOf('thinkingDepthOptions.map')).toBeLessThan(
      menuGroup.indexOf("<AppMenuSeparator />")
    );
    expect(menuGroup.indexOf("<AppMenuSeparator />")).toBeLessThan(
      menuGroup.indexOf("t('chatV2:inputBar.thinkingOff', '关闭')")
    );
  });

  it('adds the runtime model selector to the thinking runtime menu', () => {
    const menuBranchStart = inputBarSource.indexOf('{hasThinkingRuntimeMenu ? (');
    const menuBranchEnd = inputBarSource.indexOf('</AppMenuContent>', menuBranchStart);
    const menuBranch = inputBarSource.slice(menuBranchStart, menuBranchEnd);

    expect(menuBranchStart).toBeGreaterThan(-1);
    expect(menuBranchEnd).toBeGreaterThan(menuBranchStart);
    expect(inputBarSource).toContain("t('chatV2:inputBar.runtimeModelTitle', '模型')");
    expect(inputBarSource).toContain('onOpenRuntimeModelPanel');
    expect(menuBranch).toContain('<AppMenuGroup label={runtimeModelTitle}>');
    expect(menuBranch).toContain('runtimeModelOptions.length > 0 ? (');
    expect(menuBranch).toContain('<AppMenuSub openOnClick>');
    expect(menuBranch).toContain('<AppMenuSubTrigger');
    expect(menuBranch).toContain('<AppMenuSubContent');
    expect(menuBranch).toContain('runtimeModelSearchPlaceholder');
    expect(menuBranch).toContain('groupedRuntimeModelOptions.map');
    expect(menuBranch).toContain("handleOpenRuntimeModelPanel('compare')");
    expect(menuBranch).toContain('<AppMenuItem');
    expect(inputBarSource).toContain("t('chatV2:inputBar.chooseRuntimeModel', '选择模型')");
    expect(menuBranch).toContain('onSelectRuntimeModel?.(model.id)');
    expect(menuBranch).toContain('runtimeCurrentModelId');
  });

  it('places attachment on the left and reasoning depth in the former right attachment slot', () => {
    const leftStart = inputBarSource.indexOf('{/* 左侧按钮 - 窄屏时可横向滚动 */}');
    const rightStart = inputBarSource.indexOf('{/* 右侧按钮 - 固定不滚动 */}');
    const panelStart = inputBarSource.indexOf('{/* 🔧 面板容器 - 用于检测点击是否在面板内 */}');
    const leftToolbar = inputBarSource.slice(leftStart, rightStart);
    const rightToolbar = inputBarSource.slice(rightStart, panelStart);

    expect(leftStart).toBeGreaterThan(-1);
    expect(rightStart).toBeGreaterThan(leftStart);
    expect(panelStart).toBeGreaterThan(rightStart);
    expect(leftToolbar).toContain('data-testid="btn-toggle-attachments"');
    expect(leftToolbar).not.toContain('data-testid="btn-toggle-model"');
    expect(leftToolbar).not.toContain('data-testid="thinking-runtime-control"');
    expect(rightToolbar).toContain('data-testid="thinking-runtime-control"');
    expect(rightToolbar).not.toContain('data-testid="btn-toggle-attachments"');
    expect(rightToolbar.indexOf('data-testid="thinking-runtime-control"')).toBeLessThan(
      rightToolbar.indexOf('data-testid="btn-send"')
    );
  });

  it('places the context window usage ring immediately before the thinking runtime control', () => {
    const rightStart = inputBarSource.indexOf('{/* 右侧按钮 - 固定不滚动 */}');
    const panelStart = inputBarSource.indexOf('{/* 🔧 面板容器 - 用于检测点击是否在面板内 */}');
    const rightToolbar = inputBarSource.slice(rightStart, panelStart);

    expect(inputBarSource).toContain('data-testid="context-window-usage-control"');
    expect(rightToolbar).toContain('<ContextWindowUsageRing');
    expect(rightToolbar.indexOf('<ContextWindowUsageRing')).toBeLessThan(
      rightToolbar.indexOf('data-testid="thinking-runtime-control"')
    );
  });

  it('renders the context window usage meter as a plain rounded ring from 12 o clock clockwise', () => {
    const ringStart = inputBarSource.indexOf('function ContextWindowUsageRing');
    const ringEnd = inputBarSource.indexOf('function getStageLabel', ringStart);
    const ringSource = inputBarSource.slice(ringStart, ringEnd);

    expect(ringStart).toBeGreaterThan(-1);
    expect(ringEnd).toBeGreaterThan(ringStart);
    expect(ringSource).toContain('data-testid="context-window-usage-tooltip-bar"');
    expect(ringSource).toContain('className="h-4 w-4 rounded-full');
    expect(ringSource).toContain('<svg');
    expect(ringSource).toContain('strokeLinecap="round"');
    expect(ringSource).toContain('strokeDasharray={ringCircumference}');
    expect(ringSource).toContain('strokeDashoffset={ringProgressOffset}');
    expect(ringSource).toContain('transform="rotate(-90 8 8)"');
    expect(ringSource).not.toContain('data-testid="context-window-usage-progress-cap"');
    expect(ringSource).not.toContain('conic-gradient(from 0deg');
    expect(ringSource).not.toContain('conic-gradient(from -90deg');
    expect(ringSource).not.toContain('boxShadow');
    expect(ringSource).not.toContain('inset-[3px]');
    expect(ringSource).not.toContain('inset-[6px]');
    expect(ringSource).not.toContain('transform: `rotate(${usedDegrees})`');
    expect(ringSource).toContain('width: `${usage.usedPercent}%`');
  });

  it('keeps the context window usage meter monochrome and minimal', () => {
    const ringStart = inputBarSource.indexOf('function ContextWindowUsageRing');
    const ringEnd = inputBarSource.indexOf('function getStageLabel', ringStart);
    const ringSource = inputBarSource.slice(ringStart, ringEnd);

    expect(ringStart).toBeGreaterThan(-1);
    expect(ringEnd).toBeGreaterThan(ringStart);
    expect(ringSource).toContain("const contextUsageColor = 'var(--text-primary)'");
    expect(ringSource).toContain('background: contextUsageColor');
    expect(ringSource).not.toContain('getContextUsageTone');
    expect(ringSource).not.toContain('hsl(var(--warning))');
    expect(ringSource).not.toContain('hsl(var(--destructive))');
  });

  it('keeps tooltip support without adding a hover state to the ring control', () => {
    const ringStart = inputBarSource.indexOf('function ContextWindowUsageRing');
    const ringEnd = inputBarSource.indexOf('function getStageLabel', ringStart);
    const ringSource = inputBarSource.slice(ringStart, ringEnd);

    expect(ringStart).toBeGreaterThan(-1);
    expect(ringEnd).toBeGreaterThan(ringStart);
    expect(ringSource).toContain('<CommonTooltip content={tooltipContent} position="top" disabled={disabled}>');
    expect(ringSource).not.toContain('hover:bg-[color:var(--button-utility-hover)]');
    expect(ringSource).not.toContain('hover:text-[color:var(--text-primary)]');
    expect(ringSource).not.toContain('group-hover:scale-105');
    expect(ringSource).not.toContain('className="group inline-flex');
  });

  it('does not mount the input token estimate badge in the right action rail', () => {
    const rightStart = inputBarSource.indexOf('{/* 右侧按钮 - 固定不滚动 */}');
    const panelStart = inputBarSource.indexOf('{/* 🔧 面板容器 - 用于检测点击是否在面板内 */}');
    const rightToolbar = inputBarSource.slice(rightStart, panelStart);

    expect(rightStart).toBeGreaterThan(-1);
    expect(panelStart).toBeGreaterThan(rightStart);
    expect(inputBarSource).not.toContain("import { InputTokenEstimate } from '../TokenUsageDisplay';");
    expect(rightToolbar).not.toContain('<InputTokenEstimate');
  });

  it('uses a plus icon for the attachment toggle button', () => {
    const buttonStart = inputBarSource.indexOf('data-testid="btn-toggle-attachments"');
    const buttonEnd = inputBarSource.indexOf('</NotionButton>', buttonStart);
    const attachmentButton = inputBarSource.slice(buttonStart, buttonEnd);

    expect(buttonStart).toBeGreaterThan(-1);
    expect(buttonEnd).toBeGreaterThan(buttonStart);
    expect(attachmentButton).toContain('<Plus size={18} weight="bold" />');
    expect(attachmentButton).not.toContain('<Paperclip size={18} />');
    expect(attachmentButton).not.toContain('attachmentBadgeLabel');
    expect(attachmentButton).not.toContain('rounded-full border bg-primary');
  });

  it('lets the input shell background token follow its surrounding composer surface', () => {
    const shellStart = inputBarSource.indexOf('ref={inputContainerRef}');
    const shellEnd = inputBarSource.indexOf('>', shellStart);
    const inputShell = inputBarSource.slice(shellStart, shellEnd);

    expect(shellStart).toBeGreaterThan(-1);
    expect(shellEnd).toBeGreaterThan(shellStart);
    expect(inputShell).toContain('bg-[color:var(--unified-input-shell-surface,var(--shell-inspector-panel))]');
    expect(inputShell).not.toContain('bg-[color:var(--surface-elevated)]');
  });
});
