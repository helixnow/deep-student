import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat v2 input bar radius contract', () => {
  const inputBarSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/InputBarUI.tsx'),
    'utf-8'
  );
  const plusMenuSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/ComposerPlusMenu.tsx'),
    'utf-8'
  );
  const toolbarSource = readFileSync(
    resolve(process.cwd(), 'src/features/chat/components/input-bar/ComposerToolbar.tsx'),
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

  it('uses a smaller desktop control radius while keeping the mobile plus affordance circular', () => {
    const iconButtonClassStart = toolbarSource.indexOf('const iconButtonClass =');
    const iconButtonClassEnd = toolbarSource.indexOf(';', iconButtonClassStart);
    const iconButtonClass = toolbarSource.slice(iconButtonClassStart, iconButtonClassEnd);
    const thinkingRuntimeDataTest = toolbarSource.indexOf('data-testid="thinking-runtime-control"');
    const thinkingRuntimeStart = toolbarSource.lastIndexOf('<span', thinkingRuntimeDataTest);
    const thinkingRuntimeEnd = toolbarSource.indexOf('{/* 🆕 媒体处理中提示', thinkingRuntimeStart);
    const thinkingRuntimeControl = toolbarSource.slice(thinkingRuntimeStart, thinkingRuntimeEnd);

    expect(toolbarSource).toContain('--radius-shell-control');
    expect(iconButtonClass).toContain('rounded-[var(--radius-shell-control)]');
    expect(iconButtonClass).not.toContain('rounded-full');
    expect(plusMenuSource).toContain("isMobile && '!rounded-full'");
    expect(thinkingRuntimeControl).toContain('rounded-[var(--radius-shell-control)]');
    expect(thinkingRuntimeControl).not.toContain('rounded-lg');
  });

  it('keeps only the primary send and stop affordances circular inside the composer', () => {
    expect(toolbarSource).toContain("const studyUiSendButtonSizeClass =\n  'h-11 w-11 !rounded-full");
    const stopButtonStart = toolbarSource.indexOf('data-testid="btn-stop"');
    const stopButtonEnd = toolbarSource.indexOf('</DsButton>', stopButtonStart);
    const stopButton = toolbarSource.slice(stopButtonStart, stopButtonEnd);
    const sendButtonStart = toolbarSource.indexOf('data-testid="btn-send"');
    const sendButtonEnd = toolbarSource.indexOf('</button>', sendButtonStart);
    const sendButton = toolbarSource.slice(sendButtonStart, sendButtonEnd);

    expect(stopButton).toContain('!rounded-full');
    expect(stopButton).toContain('max-md:!w-11 max-md:!h-11');
    expect(sendButton).toContain('studyUiSendButtonSizeClass');
  });
});
