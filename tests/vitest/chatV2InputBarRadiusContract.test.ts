import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat v2 input bar radius contract', () => {
  const inputBarSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/components/input-bar/InputBarUI.tsx'),
    'utf-8'
  );
  const shadcnVariablesSource = readFileSync(
    resolve(process.cwd(), 'src/styles/shadcn-variables.css'),
    'utf-8'
  );

  it('uses the shell toolbar radius for the composer instead of oversized hard-coded corners', () => {
    expect(shadcnVariablesSource).toContain('--radius-shell-toolbar: 16px;');
    expect(inputBarSource).toContain('rounded-[var(--radius-shell-toolbar)]');
    expect(inputBarSource).not.toContain('rounded-[28px]');
  });

  it('keeps the drag overlay radius inherited from the composer shell', () => {
    expect(inputBarSource).toContain('rounded-[inherit]');
    expect(inputBarSource).not.toContain('rounded-[26px]');
  });

  it('uses a smaller control radius for secondary composer toolbar controls', () => {
    const iconButtonClassStart = inputBarSource.indexOf('const iconButtonClass =');
    const iconButtonClassEnd = inputBarSource.indexOf(';', iconButtonClassStart);
    const iconButtonClass = inputBarSource.slice(iconButtonClassStart, iconButtonClassEnd);
    const leftToolbarStart = inputBarSource.indexOf('{/* 左侧按钮 - 窄屏时可横向滚动 */}');
    const rightToolbarStart = inputBarSource.indexOf('{/* 右侧按钮 - 固定不滚动 */}');
    const leftToolbar = inputBarSource.slice(leftToolbarStart, rightToolbarStart);
    const thinkingRuntimeDataTest = inputBarSource.indexOf('data-testid="thinking-runtime-control"');
    const thinkingRuntimeStart = inputBarSource.lastIndexOf('<span', thinkingRuntimeDataTest);
    const thinkingRuntimeEnd = inputBarSource.indexOf('{/* 🆕 媒体处理中提示 */}', thinkingRuntimeStart);
    const thinkingRuntimeControl = inputBarSource.slice(thinkingRuntimeStart, thinkingRuntimeEnd);

    expect(inputBarSource).toContain('--radius-shell-control');
    expect(iconButtonClass).toContain('rounded-[var(--radius-shell-control)]');
    expect(iconButtonClass).not.toContain('rounded-full');
    expect(leftToolbar).toContain('inline-flex rounded-[var(--radius-shell-control)]');
    expect(leftToolbar).not.toContain('inline-flex rounded-full');
    expect(thinkingRuntimeControl).toContain('rounded-[var(--radius-shell-control)]');
    expect(thinkingRuntimeControl).not.toContain('rounded-lg');
  });

  it('keeps only the primary send and stop affordances circular inside the composer', () => {
    expect(inputBarSource).toContain("const studyUiSendButtonSizeClass =\n    'h-11 w-11 !rounded-full");
    expect(inputBarSource).toContain("className={cn(studyUiBlackActionButtonClass, '!w-8 !h-8 !rounded-full shadow-sm')}");
  });
});
