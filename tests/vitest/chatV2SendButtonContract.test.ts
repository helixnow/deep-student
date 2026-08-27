import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('chat v2 send button contract', () => {
  const inputBarSource = readFileSync(resolve(process.cwd(), 'src/features/chat/components/input-bar/InputBarUI.tsx'), 'utf-8');
  const toolbarSource = readFileSync(resolve(process.cwd(), 'src/features/chat/components/input-bar/ComposerToolbar.tsx'), 'utf-8');
  const packageSource = readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8');
  const shadcnVariablesSource = readFileSync(resolve(process.cwd(), 'src/styles/shadcn-variables.css'), 'utf-8');
  const themeColorsSource = readFileSync(resolve(process.cwd(), 'src/styles/theme-colors.css'), 'utf-8');
  it('uses the exact study-ui upward arrow glyph for chat send', () => {
    expect(packageSource).toContain('"@phosphor-icons/react": "^2.1.10"');
    expect(toolbarSource).toMatch(/from ['"]@phosphor-icons\/react['"]/);
    expect(toolbarSource).toContain('ArrowUp');
    expect(toolbarSource).toContain("const studyUiSendButtonAriaLabel = t('chatV2:inputBar.sendMessage');");
    expect(toolbarSource).toContain('<ArrowUp size={16} weight="bold" />');
    expect(toolbarSource).toContain('aria-label={studyUiSendButtonAriaLabel}');
    expect(toolbarSource).not.toContain('<Send size={16} strokeWidth={2.2} />');
    expect(toolbarSource).not.toContain('<ArrowUp size={16} strokeWidth={2.5} />');
    expect(toolbarSource).not.toContain('StudySendArrowIcon');
  });

  it('uses the study-ui button shell with black filled active and stop states', () => {
    const stopButtonStart = toolbarSource.indexOf('data-testid="btn-stop"');
    const stopButtonEnd = toolbarSource.indexOf('</DsButton>', stopButtonStart);
    const stopButtonSource = toolbarSource.slice(stopButtonStart, stopButtonEnd);

    expect(stopButtonStart).toBeGreaterThan(-1);
    expect(stopButtonEnd).toBeGreaterThan(stopButtonStart);
    expect(shadcnVariablesSource).toContain('--button-icon-size: 2rem;');
    expect(shadcnVariablesSource).toContain('--button-radius: 9px;');
    // --interactive-selected 已改为派生 token（theme 去色迁移），不再锁定硬编码 hex。
    // 通过派生链定义仍然保证 send button 的文字色稳定。
    expect(themeColorsSource).toMatch(/--interactive-selected:\s*color-mix\(/);
    expect(toolbarSource).toContain("const studyUiSendButtonSizeClass =");
    expect(toolbarSource).toContain('h-11 w-11 !rounded-full md:h-[var(--button-icon-size)] md:w-[var(--button-icon-size)]');
    expect(toolbarSource).toContain('[@media(pointer:coarse)]:!h-[var(--touch-target-size)] [@media(pointer:coarse)]:!w-[var(--touch-target-size)]');
    expect(toolbarSource).not.toContain('[@media(pointer:coarse)]:!h-11');
    expect(toolbarSource).not.toContain('[@media(pointer:coarse)]:!w-11');
    expect(toolbarSource).toMatch(/studyUiBlackActionButtonClass\s*=\s*['"]!border-black !bg-black hover:!bg-black active:!bg-black !text-white['"]/);
    expect(toolbarSource).toMatch(/studyUiSendButtonEmptyStateClass\s*=\s*['"]!border-transparent !bg-muted !text-muted-foreground hover:!bg-muted\/80 active:!bg-muted\/70['"]/);
    expect(toolbarSource).toContain("const studyUiButtonBaseClassName =");
    expect(toolbarSource).toContain('rounded-[var(--button-radius)] border text-ui font-medium leading-none tracking-[0.01em]');
    expect(toolbarSource).toContain("const studyUiButtonSizeIconClassName =");
    expect(toolbarSource).toContain('h-[var(--button-icon-size)] w-[var(--button-icon-size)] rounded-[var(--button-radius)]');
    expect(toolbarSource).toContain('studyUiButtonBaseClassName,');
    expect(toolbarSource).toContain('studyUiButtonSizeIconClassName,');
    expect(inputBarSource).toContain('const isComposerEmpty = !hasContent;');
    expect(inputBarSource).toContain('isComposerEmpty={isComposerEmpty}');
    expect(toolbarSource).toContain('isComposerEmpty ? studyUiSendButtonEmptyStateClass : studyUiBlackActionButtonClass');
    expect(stopButtonSource).toContain('variant="default"');
    expect(stopButtonSource).toContain('className={cn(studyUiBlackActionButtonClass,');
    expect(toolbarSource).not.toContain('inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap border text-[13px] font-medium leading-none tracking-[0.01em]');
    expect(toolbarSource).not.toContain('border-transparent bg-muted-foreground hover:bg-muted-foreground/90 active:bg-muted-foreground/85 text-[color:var(--interactive-selected)]" type="button"');
    expect(toolbarSource).not.toContain("disabledSend && studyUiSendButtonEmptyStateClass");
    expect(stopButtonSource).not.toContain('variant="danger"');
    expect(toolbarSource).not.toContain("!disabledSend && 'shadow-[var(--shadow-shell-soft)]'");
  });
});
