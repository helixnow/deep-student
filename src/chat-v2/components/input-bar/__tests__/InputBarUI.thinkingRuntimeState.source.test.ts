import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('InputBarUI thinking runtime state visibility', () => {
  const inputBarSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/components/input-bar/InputBarUI.tsx'),
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
    const menuBranchStart = inputBarSource.indexOf('{hasThinkingDepthMenu ? (');
    const menuBranchEnd = inputBarSource.indexOf(') : (', menuBranchStart);
    const menuBranch = inputBarSource.slice(menuBranchStart, menuBranchEnd);

    expect(menuBranchStart).toBeGreaterThan(-1);
    expect(menuBranchEnd).toBeGreaterThan(menuBranchStart);
    expect(menuBranch).toContain('data-testid="thinking-runtime-menu-trigger"');
    expect(menuBranch).not.toContain('onClick={onToggleThinking}');
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
    expect(leftToolbar).not.toContain('data-testid="thinking-runtime-control"');
    expect(rightToolbar).toContain('data-testid="thinking-runtime-control"');
    expect(rightToolbar).not.toContain('data-testid="btn-toggle-attachments"');
    expect(rightToolbar.indexOf('data-testid="thinking-runtime-control"')).toBeLessThan(
      rightToolbar.indexOf('data-testid="btn-send"')
    );
  });
});
