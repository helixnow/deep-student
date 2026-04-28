import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ChatContainer empty composer layout source contract', () => {
  const containerSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/components/ChatContainer.tsx'),
    'utf-8'
  );
  const beautifySource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/styles/chat-beautify.css'),
    'utf-8'
  );
  const inputBarTypesSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/components/input-bar/types.ts'),
    'utf-8'
  );
  const inputBarV2Source = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/components/input-bar/InputBarV2.tsx'),
    'utf-8'
  );
  const inputBarUiSource = readFileSync(
    resolve(process.cwd(), 'src/chat-v2/components/input-bar/InputBarUI.tsx'),
    'utf-8'
  );

  it('uses a golden-ratio composer layout only for empty input-enabled threads', () => {
    expect(containerSource).toContain('shouldUseEmptyComposerLayout');
    expect(containerSource).toContain('const messageCount = useStore(store, (s) => s.messageOrder.length);');
    expect(containerSource).toContain('messageCount === 0');
    expect(containerSource).toContain('showInputBar &&');
    expect(containerSource).toContain('chat-empty-composer-layout');
    expect(containerSource).toContain('chat-empty-composer-layout__input');
  });

  it('animates composer docking with a restrained non-linear transform transition', () => {
    expect(containerSource).toContain('chat-composer-motion-frame');
    expect(containerSource).toContain('chat-composer-motion-frame--empty');
    expect(containerSource).toContain('chat-composer-motion-frame--docked');
    expect(beautifySource).toContain('--chat-composer-motion-duration: 210ms');
    expect(beautifySource).toContain('--chat-composer-motion-ease: cubic-bezier(0.2, 0.8, 0.2, 1)');
    expect(beautifySource).toContain('@keyframes chatComposerDockIn');
    expect(beautifySource).toContain('@keyframes chatComposerFloatIn');
    expect(beautifySource).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('positions the empty composer on the golden-ratio visual axis', () => {
    expect(beautifySource).toContain('--chat-empty-composer-top-space: 0.382fr');
    expect(beautifySource).toContain('--chat-empty-composer-bottom-space: 0.618fr');
    expect(beautifySource).toContain('grid-template-rows: var(--chat-empty-composer-top-space) auto var(--chat-empty-composer-bottom-space)');
    expect(beautifySource).toContain('.chat-v2 .chat-empty-composer-layout__input.unified-input-docked');
  });

  it('keeps the empty composer input shell surface aligned with the surrounding page', () => {
    const emptyInputStart = beautifySource.indexOf('.chat-v2 .chat-empty-composer-layout__input.unified-input-docked');
    const emptyInputEnd = beautifySource.indexOf('}', emptyInputStart);
    const emptyInputRule = beautifySource.slice(emptyInputStart, emptyInputEnd);

    expect(emptyInputStart).toBeGreaterThan(-1);
    expect(emptyInputEnd).toBeGreaterThan(emptyInputStart);
    expect(emptyInputRule).toContain('--unified-input-shell-surface: var(--surface-root);');
    expect(emptyInputRule).toContain('background: var(--surface-root);');
  });

  it('keeps empty mobile conversations docked at the bottom and autofocuses the keyboard-safe input', () => {
    expect(containerSource).toContain("import { useMobileLayoutSafe } from '@/components/layout/MobileLayoutContext';");
    expect(containerSource).toContain('const isMobile = mobileLayout?.isMobile ??');
    expect(containerSource).toContain('const shouldUseDesktopEmptyComposerLayout = shouldUseEmptyComposerLayout && !isMobile;');
    expect(containerSource).toContain('const shouldAutoFocusMobileEmptyComposer = shouldUseEmptyComposerLayout && isMobile;');
    expect(containerSource).toContain('shouldUseDesktopEmptyComposerLayout ? (');
    expect(containerSource).toContain("renderInputBar(undefined, 'docked', shouldAutoFocusMobileEmptyComposer)");

    expect(inputBarTypesSource).toContain('autoFocus?: boolean;');
    expect(inputBarV2Source).toContain('autoFocus');
    expect(inputBarV2Source).toContain('autoFocus={autoFocus}');
    expect(inputBarUiSource).toContain('autoFocus = false');
    expect(inputBarUiSource).toContain('textarea.focus({ preventScroll: true });');
    expect(inputBarUiSource).toContain('window.visualViewport');
    expect(inputBarUiSource).toContain('--unified-input-keyboard-inset');
    expect(inputBarUiSource).toContain('keyboardInsetPx');
  });
});
