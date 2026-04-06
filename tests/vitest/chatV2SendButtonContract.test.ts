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

  it('uses the same study-ui send button token family and empty-state classes', () => {
    expect(shadcnVariablesSource).toContain('--button-icon-size: 2rem;');
    expect(shadcnVariablesSource).toContain('--button-radius: 9px;');
    expect(themeColorsSource).toContain('--interactive-selected: #E9E9E9;');
    expect(themeColorsSource).toContain('--button-prominent-bg: color-mix(in oklab, hsl(var(--primary)) 90%, hsl(var(--background)) 10%);');
    expect(themeColorsSource).toContain('--button-prominent-hover-bg: color-mix(in oklab, hsl(var(--primary)) 94%, hsl(var(--foreground)) 6%);');
    expect(themeColorsSource).toContain('--button-prominent-active-bg: color-mix(in oklab, hsl(var(--primary)) 84%, hsl(var(--foreground)) 16%);');
    expect(themeColorsSource).toContain('--button-prominent-border: color-mix(in oklab, hsl(var(--primary)) 34%, hsl(var(--border)) 66%);');
    expect(inputBarSource).toMatch(/studyUiSendButtonSizeClass\s*=\s*['"]h-11 w-11 !rounded-full md:h-\[var\(--button-icon-size\)\] md:w-\[var\(--button-icon-size\)\]['"]/);
    expect(inputBarSource).toMatch(/studyUiSendButtonEmptyStateClass\s*=\s*['"]!border-transparent !bg-muted-foreground hover:!bg-muted-foreground\/90 active:!bg-muted-foreground\/85 !text-\[color:var\(--interactive-selected\)\]['"]/);
    expect(inputBarSource).toContain("const studyUiButtonBaseClassName =");
    expect(inputBarSource).toContain('rounded-[var(--button-radius)] border text-[13px] font-medium leading-none tracking-[0.01em]');
    expect(inputBarSource).toContain("const studyUiButtonTonePrimaryClassName =");
    expect(inputBarSource).toContain('border-[color:var(--button-prominent-border)] bg-[var(--button-prominent-bg)] text-primary-foreground hover:bg-[var(--button-prominent-hover-bg)] active:bg-[var(--button-prominent-active-bg)]');
    expect(inputBarSource).toContain("const studyUiButtonSizeIconClassName =");
    expect(inputBarSource).toContain('h-[var(--button-icon-size)] w-[var(--button-icon-size)] rounded-[var(--button-radius)]');
    expect(studyUiThreadCanvasSource).toContain('h-11 w-11 rounded-full md:h-[var(--button-icon-size)] md:w-[var(--button-icon-size)]');
    expect(studyUiThreadCanvasSource).toContain('border-transparent bg-muted-foreground hover:bg-muted-foreground/90 active:bg-muted-foreground/85 text-[color:var(--interactive-selected)]');
    expect(inputBarSource).toContain('studyUiButtonBaseClassName,');
    expect(inputBarSource).toContain('studyUiButtonTonePrimaryClassName,');
    expect(inputBarSource).toContain('studyUiButtonSizeIconClassName,');
    expect(inputBarSource).not.toContain('inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap border text-[13px] font-medium leading-none tracking-[0.01em]');
    expect(inputBarSource).not.toContain('border-transparent bg-muted-foreground hover:bg-muted-foreground/90 active:bg-muted-foreground/85 text-[color:var(--interactive-selected)]" type="button"');
    expect(inputBarSource).toContain('const isComposerEmpty = !hasContent;');
    expect(inputBarSource).toContain('isComposerEmpty && studyUiSendButtonEmptyStateClass');
    expect(inputBarSource).not.toContain("disabledSend && studyUiSendButtonEmptyStateClass");
    expect(inputBarSource).not.toContain("!disabledSend && 'shadow-[var(--shadow-shell-soft)]'");
  });
});
