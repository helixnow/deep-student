import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf-8');

describe('AppMenu / ModelMentionPopover / Sheet transition contracts', () => {
  it('loads the shared transitions.dev variables and dropdown hook globally', () => {
    const tailwindSource = readSource('src/styles/tailwind.css');
    const transitionSource = readSource('src/styles/transitions-dev.css');

    expect(tailwindSource).toContain("@import './transitions-dev.css';");
    expect(transitionSource).toContain('--dropdown-close-dur');
    expect(transitionSource).toContain('--modal-open-dur');
    expect(transitionSource).toContain('--panel-open-dur');
    expect(transitionSource).toContain('.t-dropdown');
    expect(transitionSource).toContain('prefers-reduced-motion: reduce');
  });

  it('keeps AppMenu on the dropdown transition hooks with closing state cleanup', () => {
    const styleSource = readSource('src/components/ui/app-menu/AppMenu.css');
    const componentSource = readSource('src/components/ui/app-menu/AppMenu.tsx');

    expect(componentSource).toContain('app-menu-closing');
    expect(componentSource).toContain('--dropdown-close-dur');
    expect(componentSource).toContain('useMotionPresence');
    expect(styleSource).toContain('.app-menu-content');
    expect(styleSource).toContain('transform-origin: top left;');
    expect(styleSource).toContain('opacity: 0;');
    expect(styleSource).toContain('transition:');
    expect(styleSource).toContain('prefers-reduced-motion: reduce');
    expect(styleSource).toContain('.app-menu-origin-bottom');
    expect(styleSource).toContain('.app-menu-closing');
  });

  it('gives ModelMentionPopover the same dropdown close-state hooks', () => {
    const source = readSource('src/features/chat/components/input-bar/ModelMentionPopover.tsx');

    expect(source).toContain('t-dropdown');
    expect(source).toContain('is-open');
    expect(source).toContain('is-closing');
    expect(source).toContain('--dropdown-close-dur');
    expect(source).toContain('useMotionPresence');
  });

  it('lets Sheet read the shared transition tokens for overlay and panel motion', () => {
    const sheetSource = readSource('src/components/ui/shad/Sheet.tsx');
    const motionSource = readSource('src/styles/ui-motion.css');
    const tailwindSource = readSource('src/styles/tailwind.css');

    expect(tailwindSource).toContain("@import './ui-motion.css';");
    expect(sheetSource).toContain('ui-fade-in ui-fade-out');
    expect(motionSource).toContain('var(--modal-open-dur');
    expect(motionSource).toContain('.ui-fade-out[data-state="closed"]');
    expect(motionSource).toContain('var(--modal-close-dur');

    expect(sheetSource).toContain('ui-slide-in-right ui-slide-out-right');
    expect(motionSource).toContain('var(--panel-open-dur');
    expect(motionSource).toContain('.ui-slide-out-right[data-state="closed"]');
    expect(motionSource).toContain('var(--panel-close-dur');
  });

  it('pairs Select zoom-fade enter with the existing zoom-fade exit class', () => {
    const selectSource = readSource('src/components/ui/shad/Select.tsx');
    expect(selectSource).toContain('ui-zoom-fade-in');
    expect(selectSource).toContain('ui-zoom-fade-out');
  });
});
