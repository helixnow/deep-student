import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import {
  buildHtmlSandboxDocument,
  getHtmlSandboxPermissions,
  sanitizeCssForPreview,
  sanitizeHtmlForPreview,
} from '@/components/previews/htmlSandboxPolicy';
import { HtmlSandboxPreview } from '@/components/previews/HtmlSandboxPreview';

describe('html sandbox preview policy', () => {
  it('builds chat-safe documents with strict CSP and stripped active content', () => {
    const html = '<div>ok</div><script>alert(1)</script><link rel="stylesheet" href="https://evil.test/a.css">';
    const css = '@import url("https://evil.test/a.css"); .ok { color: red; background: url("javascript:alert(1)"); }';

    const safeHtml = sanitizeHtmlForPreview(html, 'chat-safe');
    const safeCss = sanitizeCssForPreview(css, 'chat-safe');
    const doc = buildHtmlSandboxDocument({
      html: safeHtml,
      css: safeCss,
      mode: 'chat-safe',
    });

    expect(safeHtml).toContain('<div>ok</div>');
    expect(safeHtml).not.toContain('<script');
    expect(safeHtml).not.toContain('<link');
    expect(safeCss).toContain('color: red');
    expect(safeCss).not.toContain('@import');
    expect(safeCss).not.toContain('javascript:');
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("script-src 'none'");
  });

  it('strips user scripts in template-safe mode but keeps script-enabled sandbox for internal helpers', () => {
    const html = '<div id="target">before</div><script>document.body.dataset.ready = "yes"</script>';
    const safeHtml = sanitizeHtmlForPreview(html, 'template-safe');
    const doc = buildHtmlSandboxDocument({
      html: safeHtml,
      css: '',
      mode: 'template-safe',
    });

    expect(safeHtml).not.toContain('<script>');
    expect(doc).toContain("script-src 'unsafe-inline'");
    expect(doc).toContain("sdp-resize");
    expect(getHtmlSandboxPermissions('template-safe')).toBe('allow-scripts');
  });

  it('uses locked-down iframe sandbox for chat-safe mode', () => {
    expect(getHtmlSandboxPermissions('chat-safe')).toBe('');
  });
});

describe('HtmlSandboxPreview', () => {
  it('renders a safe chat preview iframe with strict sandbox and generated srcDoc', () => {
    const { container } = render(
      <HtmlSandboxPreview
        mode="chat-safe"
        htmlContent="<div>hello</div><script>alert(1)</script>"
        cssContent=".x { color: red; }"
        title="chat html preview"
      />
    );

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('sandbox')).toBe('');
    expect(iframe?.getAttribute('srcdoc')).toContain('<div>hello</div>');
    expect(iframe?.getAttribute('srcdoc')).not.toContain('<script>alert(1)</script>');
    expect(iframe?.getAttribute('srcdoc')).toContain("default-src 'none'");
  });

  it('renders template-safe previews with script-enabled sandbox', () => {
    const { container } = render(
      <HtmlSandboxPreview
        mode="template-safe"
        htmlContent="<div id='target'>before</div><script>document.body.dataset.ready='yes'</script>"
        cssContent=""
        title="template html preview"
      />
    );

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe?.getAttribute('srcdoc')).not.toContain("document.body.dataset.ready='yes'");
    expect(iframe?.getAttribute('srcdoc')).toContain('sdp-resize');
  });
});
