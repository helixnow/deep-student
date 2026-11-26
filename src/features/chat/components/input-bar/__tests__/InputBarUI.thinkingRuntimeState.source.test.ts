import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ★ 拆分后：底部工具栏（T3 Code 风格模型与推理强度选择器 / 水位环 / 发送停止）在 ComposerToolbar.tsx，
// 三栏弹出内容在 T3ModelSelectorPopover.tsx，InputBarUI.tsx 只保留壳体与编排。
describe('InputBarUI T3 Code model & thinking runtime selector source contract', () => {
  const inputBarSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/InputBarUI.tsx'),
    'utf-8'
  );
  const toolbarSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/ComposerToolbar.tsx'),
    'utf-8'
  );
  const t3PopoverSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/T3ModelSelectorPopover.tsx'),
    'utf-8'
  );

  it('renders the current model or thinking state as a minimal visible control, not only as tooltip text', () => {
    expect(toolbarSource).toContain('data-testid="thinking-runtime-minimal-control"');
    expect(toolbarSource).toContain('data-testid="thinking-runtime-state-label"');
    expect(toolbarSource).toContain('{thinkingRuntimeTriggerLabel}');
  });

  it('prioritizes the runtime model name in the T3 Code pill trigger with graceful fallback', () => {
    expect(toolbarSource).toContain(
      'runtimeModelLabel || resolvedThinkingTriggerLabel || runtimeModelTitle'
    );
    expect(toolbarSource).toContain('data-testid="thinking-runtime-unavailable-badge"');
  });

  it('keeps depth menu labels terse without slower suffix copy', () => {
    expect(inputBarSource).not.toContain('thinkingDepthExpensive');
    expect(toolbarSource).not.toContain('thinkingDepthExpensive');
    expect(t3PopoverSource).not.toContain('thinkingDepthExpensive');
  });

  it('opens the T3 Code unified popover instead of toggling directly when menu options exist', () => {
    const menuBranchStart = toolbarSource.indexOf('{hasThinkingRuntimeMenu ? (');
    const menuBranchEnd = toolbarSource.indexOf(') : (', menuBranchStart);
    const menuBranch = toolbarSource.slice(menuBranchStart, menuBranchEnd);

    expect(menuBranchStart).toBeGreaterThan(-1);
    expect(menuBranchEnd).toBeGreaterThan(menuBranchStart);
    expect(menuBranch).toContain('data-testid="thinking-runtime-menu-trigger"');
    expect(menuBranch).not.toContain('onClick={onToggleThinking}');
  });

  it('mounts the lazy T3 Code 3-column selector inside the right-aligned popover', () => {
    const triggerStart = toolbarSource.indexOf('data-testid="thinking-runtime-menu-trigger"');
    const contentStart = toolbarSource.indexOf('<AppMenuContent', triggerStart);
    const contentEnd = toolbarSource.indexOf('</AppMenuContent>', contentStart);
    const menuContent = toolbarSource.slice(contentStart, contentEnd);

    expect(triggerStart).toBeGreaterThan(-1);
    expect(contentStart).toBeGreaterThan(triggerStart);
    expect(menuContent).toContain('align="end"');
    expect(menuContent).toContain('<LazyT3ModelSelectorPopover');
    expect(menuContent).toContain('options={runtimeModelOptions}');
    expect(menuContent).toContain('currentModelId={runtimeCurrentModelId}');
    expect(menuContent).toContain('multiSelect={runtimeModelMultiSelect}');
    expect(menuContent).toContain('permissionPreset={permissionPreset}');
    expect(menuContent).toContain('onPermissionPresetChange={onPermissionPresetChange}');
  });

  it('implements the 3-column T3 Code structure (rail + search/list with ⌘1..⌘9 + reasoning pane + permission footer)', () => {
    expect(t3PopoverSource).toContain('data-testid="t3-provider-rail"');
    expect(t3PopoverSource).toContain('data-testid="t3-rail-favorites"');
    expect(t3PopoverSource).toContain('data-testid="t3-model-list-pane"');
    expect(t3PopoverSource).toContain('data-testid="t3-model-search-input"');
    expect(t3PopoverSource).toContain('t3-model-shortcut-');
    expect(t3PopoverSource).toContain('data-testid="t3-reasoning-pane"');
    expect(t3PopoverSource).toContain('data-testid="t3-reasoning-empty"');
    expect(t3PopoverSource).toContain('没有可选的推理强度');
    expect(t3PopoverSource).toContain('data-testid="t3-picker-footer"');
    expect(t3PopoverSource).toContain('data-testid="t3-permission-trigger"');
    expect(t3PopoverSource).toContain('<DsAlertDialog');
    expect(t3PopoverSource).not.toContain('window.confirm');
  });

  it('uses the transitions-dev text state swap for changes in the trigger label', () => {
    const triggerStart = toolbarSource.indexOf('data-testid="thinking-runtime-menu-trigger"');
    const triggerEnd = toolbarSource.indexOf('</button>', triggerStart);
    const triggerSource = toolbarSource.slice(triggerStart, triggerEnd);

    expect(triggerStart).toBeGreaterThan(-1);
    expect(triggerEnd).toBeGreaterThan(triggerStart);
    expect(toolbarSource).toContain("import { TextSwap } from '@/components/ui/TextSwap';");
    expect(toolbarSource).toContain('function ResizingThinkingLabel');
    expect(triggerSource).toContain('<ResizingThinkingLabel');
    expect(triggerSource).toContain('text={thinkingRuntimeTriggerLabel}');
    expect(toolbarSource).toContain('className="t-resize inline-block whitespace-nowrap"');
    expect(toolbarSource).toContain('style={labelWidth ? { width: labelWidth } : undefined}');
  });

  it('uses colored brand glyph icons in the T3 Code trigger pill', () => {
    const triggerStart = toolbarSource.indexOf('data-testid="thinking-runtime-menu-trigger"');
    const triggerEnd = toolbarSource.indexOf('</button>', triggerStart);
    const triggerSource = toolbarSource.slice(triggerStart, triggerEnd);
    const providerIconStart = triggerSource.indexOf('<ProviderIcon');
    const providerIconEnd = triggerSource.indexOf('/>', providerIconStart);
    const providerIconSource = triggerSource.slice(providerIconStart, providerIconEnd);

    expect(triggerStart).toBeGreaterThan(-1);
    expect(triggerEnd).toBeGreaterThan(triggerStart);
    expect(providerIconStart).toBeGreaterThan(-1);
    expect(providerIconEnd).toBeGreaterThan(providerIconStart);
    expect(providerIconSource).toContain('modelId={resolvedTriggerBrandIconId}');
    expect(providerIconSource).toContain('size={15}');
    expect(providerIconSource).toContain('variant="color"');
    expect(providerIconSource).toContain('renderMode="glyph"');
  });

  it('places attachment on the left and model/reasoning pill in the right action cluster before send', () => {
    const leftStart = toolbarSource.indexOf('{/* 左侧按钮 - 窄屏时可横向滚动 */}');
    const rightStart = toolbarSource.indexOf('{/* 右侧按钮 - 固定不滚动 */}');
    const leftToolbar = toolbarSource.slice(leftStart, rightStart);
    const rightToolbar = toolbarSource.slice(rightStart);

    expect(leftStart).toBeGreaterThan(-1);
    expect(rightStart).toBeGreaterThan(leftStart);
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
    const rightStart = toolbarSource.indexOf('{/* 右侧按钮 - 固定不滚动 */}');
    const rightToolbar = toolbarSource.slice(rightStart);

    expect(toolbarSource).toContain('data-testid="context-window-usage-control"');
    expect(rightToolbar).toContain('<ContextWindowUsageRing');
    expect(rightToolbar.indexOf('<ContextWindowUsageRing')).toBeLessThan(
      rightToolbar.indexOf('data-testid="thinking-runtime-control"')
    );
  });

  it('renders the context window usage meter as a plain rounded ring from 12 o clock clockwise', () => {
    const ringStart = toolbarSource.indexOf('function ContextWindowUsageRing');
    const ringEnd = toolbarSource.indexOf('export interface ComposerToolbarProps', ringStart);
    const ringSource = toolbarSource.slice(ringStart, ringEnd);

    expect(ringStart).toBeGreaterThan(-1);
    expect(ringEnd).toBeGreaterThan(ringStart);
    expect(ringSource).toContain('className="h-4 w-4 rounded-full"');
    expect(ringSource).toContain('<svg');
    expect(ringSource).toContain('strokeLinecap="round"');
    expect(ringSource).toContain('strokeDasharray={ringCircumference}');
    expect(ringSource).toContain('strokeDashoffset={ringProgressOffset}');
    expect(ringSource).toContain('transform="rotate(-90 8 8)"');
  });

  it('uses tiered context usage colors at high-water thresholds', () => {
    const ringStart = toolbarSource.indexOf('function ContextWindowUsageRing');
    const ringEnd = toolbarSource.indexOf('export interface ComposerToolbarProps', ringStart);
    const ringSource = toolbarSource.slice(ringStart, ringEnd);
    const popoverSource = readFileSync(
      resolve(process.cwd(), 'src/features/chat/components/input-bar/ContextUsagePopover.tsx'),
      'utf-8'
    );

    expect(ringSource).toContain('const contextUsageColor =');
    expect(ringSource).toContain("'hsl(var(--danger))'");
    expect(ringSource).toContain("'hsl(var(--warning))'");
    expect(ringSource).toContain("'var(--text-primary)'");
    expect(ringSource).toContain('stroke={contextUsageColor}');
    expect(popoverSource).toContain('const usageColor =');
  });

  it('does not mount the input token estimate badge in the right action rail', () => {
    const rightStart = toolbarSource.indexOf('{/* 右侧按钮 - 固定不滚动 */}');
    const rightToolbar = toolbarSource.slice(rightStart);

    expect(rightStart).toBeGreaterThan(-1);
    expect(inputBarSource).not.toContain("import { InputTokenEstimate } from '../TokenUsageDisplay';");
    expect(toolbarSource).not.toContain("import { InputTokenEstimate } from '../TokenUsageDisplay';");
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
