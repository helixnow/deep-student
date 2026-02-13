import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { ShadowDomPreview } from '@/components/ShadowDomPreview';

describe('ShadowDomPreview (iframe) sanitization', () => {
  it('strips unsafe CSS (@import, javascript: in url())', async () => {
    const htmlContent = `<div>hello</div>`;
    const cssContent = `
      @import url("https://evil.test/style.css");
      .bad { background: url("javascript:alert(1)"); }
      .good { color: red; }
    `;

    const { container } = render(
      <ShadowDomPreview htmlContent={htmlContent} cssContent={cssContent} />
    );

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).not.toBeNull();

    await waitFor(() => {
      const doc = iframe.contentDocument;
      expect(doc).not.toBeNull();
      const styles = doc!.querySelectorAll('style');
      const allCss = Array.from(styles).map(s => s.textContent).join('');
      expect(allCss).not.toContain('@import');
      expect(allCss).not.toContain('javascript:');
      expect(allCss).toContain('color: red');
    });
  });

  it('allows script tags to execute inside iframe for template interactivity', async () => {
    const htmlContent = `
      <div id="target">before</div>
      <script>document.getElementById('target').textContent = 'after';</script>
    `;

    const { container } = render(
      <ShadowDomPreview htmlContent={htmlContent} cssContent="" />
    );

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).not.toBeNull();

    await waitFor(() => {
      const doc = iframe.contentDocument;
      expect(doc).not.toBeNull();
      const target = doc!.getElementById('target');
      expect(target?.textContent).toBe('after');
    });
  });

  it('renders content inside iframe with sandbox allowing scripts', () => {
    const { container } = render(
      <ShadowDomPreview htmlContent="<p>test</p>" cssContent="" />
    );

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    expect(iframe.getAttribute('sandbox')).toContain('allow-scripts');
  });
});
