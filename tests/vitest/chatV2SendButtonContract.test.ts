import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('chat v2 send button contract', () => {
  const inputBarSource = readFileSync(resolve(process.cwd(), 'src/chat-v2/components/input-bar/InputBarUI.tsx'), 'utf-8');
  const packageSource = readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8');
  const shadcnVariablesSource = readFileSync(resolve(process.cwd(), 'src/styles/shadcn-variables.css'), 'utf-8');
  const themeColorsSource = readFileSync(resolve(process.cwd(), 'src/styles/theme-colors.css'), 'utf-8');
  const studyUiThreadCanvasSource = readFileSync(resolve(process.cwd(), 'study-ui/src/components/content/ThreadCanvas.tsx'), 'utf-8');

  it('uses the exact study-ui upward arrow glyph for chat send', () => {
    expect(packageSource).toContain('"@phosphor-icons/react": "^2.1.10"');
    expect(inputBarSource).toMatch(/from ['"]@phosphor-icons\/react['"]/);
    expect(inputBarSource).toContain('ArrowUp');
    expect(inputBarSource).toContain("const studyUiSendButtonAriaLabel = '发送消息';");
    expect(inputBarSource).toContain('<ArrowUp size={16} weight="bold" />');
    expect(studyUiThreadCanvasSource).toContain('aria-label="发送消息"');
    expect(inputBarSource).toContain('aria-label={studyUiSendButtonAriaLabel}');
    expect(inputBarSource).not.toContain('<Send size={16} strokeWidth={2.2} />');
    expect(inputBarSource).not.toContain('<ArrowUp size={16} strokeWidth={2.5} />');
    expect(inputBarSource).not.toContain('StudySendArrowIcon');
  });

  it('uses the study-ui button shell with black filled active and stop states', () => {
    const stopButtonStart = inputBarSource.indexOf('data-testid="btn-stop"');
    const stopButtonEnd = inputBarSource.indexOf('</NotionButton>', stopButtonStart);
    const stopButtonSource = inputBarSource.slice(stopButtonStart, stopButtonEnd);

    expect(stopButtonStart).toBeGreaterThan(-1);
    expect(stopButtonEnd).toBeGreaterThan(stopButtonStart);
    expect(shadcnVariablesSource).toContain('--button-icon-size: 2rem;');
    expect(shadcnVariablesSource).toContain('--button-radius: 9px;');
    // --interactive-selected 已改为派生 token（theme 去色迁移），不再锁定硬编码 hex。
    // 通过派生链定义仍然保证 send button 的文字色稳定。
    expect(themeColorsSource).toMatch(/--interactive-selected:\s*color-mix\(/);
    expect(inputBarSource).toMatch(/studyUiSendButtonSizeClass\s*=\s*['"]h-11 w-11 !rounded-full md:h-\[var\(--button-icon-size\)\] md:w-\[var\(--button-icon-size\)\]['"]/);
    expect(inputBarSource).toMatch(/studyUiBlackActionButtonClass\s*=\s*['"]!border-black !bg-black hover:!bg-black active:!bg-black !text-white['"]/);
    expect(inputBarSource).toMatch(/studyUiSendButtonEmptyStateClass\s*=\s*['"]!border-transparent !bg-muted-foreground hover:!bg-muted-foreground\/90 active:!bg-muted-foreground\/85 !text-\[color:var\(--interactive-selected\)\]['"]/);
    expect(inputBarSource).toContain("const studyUiButtonBaseClassName =");
    expect(inputBarSource).toContain('rounded-[var(--button-radius)] border text-[13px] font-medium leading-none tracking-[0.01em]');
    expect(inputBarSource).toContain("const studyUiButtonSizeIconClassName =");
    expect(inputBarSource).toContain('h-[var(--button-icon-size)] w-[var(--button-icon-size)] rounded-[var(--button-radius)]');
    expect(studyUiThreadCanvasSource).toContain('h-11 w-11 shrink-0 rounded-full lg:h-[var(--button-icon-size)] lg:w-[var(--button-icon-size)]');
    expect(studyUiThreadCanvasSource).toContain('border-transparent bg-muted-foreground hover:bg-muted-foreground/90 active:bg-muted-foreground/85 text-[color:var(--interactive-selected)]');
    expect(inputBarSource).toContain('studyUiButtonBaseClassName,');
    expect(inputBarSource).toContain('studyUiButtonSizeIconClassName,');
    expect(inputBarSource).toContain('const isComposerEmpty = !hasContent;');
    expect(inputBarSource).toContain('isComposerEmpty ? studyUiSendButtonEmptyStateClass : studyUiBlackActionButtonClass');
    expect(stopButtonSource).toContain('variant="default"');
    expect(stopButtonSource).toContain('className={cn(studyUiBlackActionButtonClass,');
    expect(inputBarSource).not.toContain('inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap border text-[13px] font-medium leading-none tracking-[0.01em]');
    expect(inputBarSource).not.toContain('border-transparent bg-muted-foreground hover:bg-muted-foreground/90 active:bg-muted-foreground/85 text-[color:var(--interactive-selected)]" type="button"');
    expect(inputBarSource).not.toContain("disabledSend && studyUiSendButtonEmptyStateClass");
    expect(stopButtonSource).not.toContain('variant="danger"');
    expect(inputBarSource).not.toContain("!disabledSend && 'shadow-[var(--shadow-shell-soft)]'");
  });
});
