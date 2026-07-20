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

  it('renders reasoning depth as a slider with an off stop when thinking can be disabled', () => {
    const menuGroupStart = inputBarSource.indexOf(') : hasThinkingDepthMenu ? (');
    const menuGroupEnd = inputBarSource.indexOf(') : hasThinkingToggleMenu ? (', menuGroupStart);
    const menuGroup = inputBarSource.slice(menuGroupStart, menuGroupEnd);

    expect(menuGroupStart).toBeGreaterThan(-1);
    expect(menuGroupEnd).toBeGreaterThan(menuGroupStart);
    expect(menuGroup).toContain('<ThinkingDepthSlider');
    expect(menuGroup).toContain('options={thinkingDepthOptions}');
    expect(menuGroup).toContain('value={thinkingDepthValue}');
    expect(menuGroup).toContain('enabled={!!enableThinking}');
    expect(menuGroup).toContain("offLabel={t('chatV2:inputBar.thinkingOff', '关闭')}");
    expect(menuGroup).toContain("efficientLabel={t('chatV2:inputBar.thinkingDepthEfficient', '更高效')}");
    expect(menuGroup).toContain("smartLabel={t('chatV2:inputBar.thinkingDepthSmart', '更智能')}");
  });

  it('keeps a menu-item fallback without an off action for forced-thinking models', () => {
    const menuGroupStart = inputBarSource.indexOf(') : hasThinkingDepthMenu ? (');
    const menuGroupEnd = inputBarSource.indexOf(') : hasThinkingToggleMenu ? (', menuGroupStart);
    const menuGroup = inputBarSource.slice(menuGroupStart, menuGroupEnd);

    expect(menuGroup).toContain('thinkingCanDisable ? (');
    // 滑块必带"关闭"档；不可关闭推理的模型退回菜单列表且不渲染关闭项
    const fallbackStart = menuGroup.indexOf('thinkingDepthOptions.map');
    expect(fallbackStart).toBeGreaterThan(-1);
    const fallback = menuGroup.slice(fallbackStart);
    expect(fallback).not.toContain('<AppMenuSeparator />');
    expect(fallback).not.toContain("t('chatV2:inputBar.thinkingOff', '关闭')");
  });

  it('anchors the reasoning menu to the stable right edge while depth labels change', () => {
    const triggerStart = inputBarSource.indexOf('data-testid="thinking-runtime-menu-trigger"');
    const contentStart = inputBarSource.indexOf('<AppMenuContent', triggerStart);
    const contentEnd = inputBarSource.indexOf('>', contentStart);
    const menuContent = inputBarSource.slice(contentStart, contentEnd);

    expect(triggerStart).toBeGreaterThan(-1);
    expect(contentStart).toBeGreaterThan(triggerStart);
    expect(menuContent).toContain('align="end"');
  });

  it('uses the transitions-dev text state swap for changes in the trigger label', () => {
    const triggerStart = inputBarSource.indexOf('data-testid="thinking-runtime-menu-trigger"');
    const triggerEnd = inputBarSource.indexOf('</button>', triggerStart);
    const triggerSource = inputBarSource.slice(triggerStart, triggerEnd);

    expect(triggerStart).toBeGreaterThan(-1);
    expect(triggerEnd).toBeGreaterThan(triggerStart);
    expect(inputBarSource).toContain("import { TextSwap } from '@/components/ui/TextSwap';");
    expect(inputBarSource).toContain('function ResizingThinkingLabel');
    expect(triggerSource).toContain('<ResizingThinkingLabel');
    expect(triggerSource).toContain('text={thinkingRuntimeTriggerLabel}');
    expect(inputBarSource).toContain("className=\"t-resize inline-block whitespace-nowrap\"");
    expect(inputBarSource).toContain('style={labelWidth ? { width: labelWidth } : undefined}');
    expect(triggerSource).not.toContain('max-w-[5.75rem]');
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
    expect(leftToolbar).toContain('<ComposerPlusMenu');
    expect(leftToolbar).not.toContain('data-testid="btn-toggle-model"');
    expect(leftToolbar).not.toContain('data-testid="thinking-runtime-control"');
    expect(rightToolbar).toContain('data-testid="thinking-runtime-control"');
    expect(rightToolbar).not.toContain('<ComposerPlusMenu');
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

  it('uses tiered context usage colors at high-water thresholds', () => {
    const ringStart = inputBarSource.indexOf('function ContextWindowUsageRing');
    const ringEnd = inputBarSource.indexOf('function getStageLabel', ringStart);
    const ringSource = inputBarSource.slice(ringStart, ringEnd);

    expect(ringStart).toBeGreaterThan(-1);
    expect(ringEnd).toBeGreaterThan(ringStart);
    expect(ringSource).toContain('const contextUsageColor =');
    expect(ringSource).toContain("usage.usedPercent >= 90");
    expect(ringSource).toContain("usage.usedPercent >= 75");
    expect(ringSource).toContain("'hsl(var(--danger))'");
    expect(ringSource).toContain("'hsl(var(--warning))'");
    expect(ringSource).toContain("'var(--text-primary)'");
    expect(ringSource).toContain('background: contextUsageColor');
    expect(ringSource).toContain('stroke={contextUsageColor}');
    expect(ringSource).not.toContain('getContextUsageTone');
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

  it('uses the monochrome provider icon in the thinking runtime trigger', () => {
    const triggerStart = inputBarSource.indexOf('data-testid="thinking-runtime-menu-trigger"');
    const triggerEnd = inputBarSource.indexOf('</button>', triggerStart);
    const triggerSource = inputBarSource.slice(triggerStart, triggerEnd);
    const providerIconStart = triggerSource.indexOf('<ProviderIcon');
    const providerIconEnd = triggerSource.indexOf('/>', providerIconStart);
    const providerIconSource = triggerSource.slice(providerIconStart, providerIconEnd);

    expect(triggerStart).toBeGreaterThan(-1);
    expect(triggerEnd).toBeGreaterThan(triggerStart);
    expect(providerIconStart).toBeGreaterThan(-1);
    expect(providerIconEnd).toBeGreaterThan(providerIconStart);
    expect(providerIconSource).toContain('modelId={runtimeModelIconId}');
    expect(providerIconSource).toContain('size={15}');
    expect(providerIconSource).toContain('variant="mono"');
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
    const plusMenuSource = readFileSync(
      resolve(process.cwd(), 'src/features/chat/components/input-bar/ComposerPlusMenu.tsx'),
      'utf-8'
    );
    const buttonStart = plusMenuSource.indexOf('data-testid="btn-toggle-attachments"');
    const buttonEnd = plusMenuSource.indexOf('</DsButton>', buttonStart);
    const attachmentButton = plusMenuSource.slice(buttonStart, buttonEnd);

    expect(buttonStart).toBeGreaterThan(-1);
    expect(buttonEnd).toBeGreaterThan(buttonStart);
    expect(attachmentButton).toContain('<Plus size={18} weight="bold"');
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
