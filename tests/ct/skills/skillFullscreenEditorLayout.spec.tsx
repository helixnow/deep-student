import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import { SkillFullscreenEditor } from '@/components/skills-management/SkillFullscreenEditor';
import { llmUsageToolsSkill } from '@/features/chat/skills/builtin-tools/llm-usage-tools';

test('keeps skill content beside the line-number gutter', async ({ mount }) => {
  const component = await mount(
    <div style={{ width: 1200, height: 900 }}>
      <SkillFullscreenEditor
        open
        theme="light"
        onClose={() => undefined}
        location="builtin"
        onSave={async () => undefined}
        skill={llmUsageToolsSkill}
      />
    </div>,
  );

  await expect(component.locator('.skill-codemirror-editor .cm-editor')).toBeVisible({ timeout: 5000 });
  await component.evaluate(async () => {
    const stylesheet = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
      .find((link) => link.href.includes('SkillFullscreenEditor'));
    if (stylesheet && !stylesheet.sheet) {
      await new Promise<void>((resolve) => stylesheet.addEventListener('load', () => resolve(), { once: true }));
    }
    document.querySelectorAll<HTMLStyleElement>('style').forEach((style) => {
      if (style.textContent?.includes('cm-scroller {display: flex !important')) style.remove();
    });
  });
  const metrics = await component.locator('.skill-codemirror-editor').evaluate((root) => {
    const gutter = root.querySelector<HTMLElement>('.cm-gutters');
    const content = root.querySelector<HTMLElement>('.cm-content');
    const line = root.querySelector<HTMLElement>('.cm-line');
    const lineNumber = [...root.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')]
      .find((element) => window.getComputedStyle(element).visibility !== 'hidden');
    if (!gutter || !content || !line || !lineNumber) throw new Error('missing CodeMirror geometry');
    const rect = (element: HTMLElement) => {
      const value = element.getBoundingClientRect();
      return { left: value.left, top: value.top, width: value.width, height: value.height };
    };
    return {
      gutter: rect(gutter),
      content: rect(content),
      line: rect(line),
      lineNumber: rect(lineNumber),
      scrollerDisplay: window.getComputedStyle(root.querySelector<HTMLElement>('.cm-scroller')!).display,
      guttersDisplay: window.getComputedStyle(gutter).display,
    };
  });
  expect(metrics.scrollerDisplay).toBe('flex');
  expect(metrics.guttersDisplay).toBe('flex');
  expect(metrics.line.left).toBeGreaterThanOrEqual(metrics.gutter.left + metrics.gutter.width);
  expect(Math.abs(metrics.line.top - metrics.lineNumber.top)).toBeLessThanOrEqual(20);
});
