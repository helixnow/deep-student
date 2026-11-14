import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { ShadowDomPreview } from '@/components/ShadowDomPreview';

describe('ShadowDomPreview (iframe) sanitization', () => {
  it('strips unsafe CSS from template previews while preserving safe declarations', () => {
    const htmlContent = '<div>hello</div>';
    const cssContent = `
      @import url("https://evil.test/style.css");
      .bad { background: url("javascript:alert(1)"); }
      .good { color: red; }
    `;

    const { container } = render(
      <ShadowDomPreview htmlContent={htmlContent} cssContent={cssContent} />
    );

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const srcdoc = iframe?.getAttribute('srcdoc') || '';

    expect(srcdoc).not.toContain('@import');
    expect(srcdoc).not.toContain('javascript:');
    expect(srcdoc).toContain('color: red');
  });

  // D-154/D-166：模板自带脚本在预览中剥除（父 CSP 经 srcdoc 继承本来就拦截）；
  // 沙箱禁网与内部 resize helper 保留
  it('strips template scripts but keeps the network-blocked sandbox and internal resize helper', () => {
    const htmlContent = `
      <div id="target">before</div>
      <script>document.getElementById('target').textContent = 'after';</script>
    `;

    const { container } = render(
      <ShadowDomPreview htmlContent={htmlContent} cssContent="" />
    );

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const srcdoc = iframe?.getAttribute('srcdoc') || '';

    expect(srcdoc).toContain('<div>before</div>');
    expect(srcdoc).not.toContain("document.getElementById('target').textContent = 'after'");
    expect(srcdoc).toContain("connect-src 'none'");
    expect(srcdoc).toContain('sdp-resize');
  });

  it('renders content inside iframe with sandbox allowing scripts for internal helpers', () => {
    const { container } = render(
      <ShadowDomPreview htmlContent="<p>test</p>" cssContent="" />
    );

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute('sandbox')).toContain('allow-scripts');
  });
});
