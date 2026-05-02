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
    expect(componentSource).toContain('setTimeout');
    expect(styleSource).toContain('.app-menu-content');
    expect(styleSource).toContain('transform-origin: top left;');
    expect(styleSource).toContain('opacity: 0;');
    expect(styleSource).toContain('transition:');
    expect(styleSource).toContain('prefers-reduced-motion: reduce');
    expect(styleSource).toContain('.app-menu-origin-bottom');
    expect(styleSource).toContain('.app-menu-closing');
  });

  it('gives ModelMentionPopover the same dropdown close-state hooks', () => {
    const source = readSource('src/chat-v2/components/input-bar/ModelMentionPopover.tsx');

    expect(source).toContain('t-dropdown');
    expect(source).toContain('is-open');
    expect(source).toContain('is-closing');
    expect(source).toContain('--dropdown-close-dur');
    expect(source).toContain('setTimeout');
  });

  it('lets Sheet read the shared transition tokens for overlay and panel motion', () => {
    const source = readSource('src/components/ui/shad/Sheet.tsx');

    expect(source).toContain('--modal-open-dur');
    expect(source).toContain('--modal-close-dur');
    expect(source).toContain('--panel-open-dur');
    expect(source).toContain('data-[state=open]:animate-in');
    expect(source).toContain('data-[state=closed]:animate-out');
  });
});
