import { describe, expect, it } from 'vitest';
import { sanitizeRenderedDom } from '../sanitizeRenderedDom';

describe('sanitizeRenderedDom', () => {
  it('preserves presentation gradients and filters while removing scripts', () => {
    const container = document.createElement('div');
    container.innerHTML = `<svg viewBox="0 0 10 10">
      <defs>
        <linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient>
        <filter id="f"><feGaussianBlur stdDeviation="2"/></filter>
      </defs>
      <rect width="10" height="10" fill="url(#g)" filter="url(#f)"/>
      <script>alert(1)</script>
    </svg>`;

    sanitizeRenderedDom(container);

    expect(container.querySelector('linearGradient, lineargradient')).not.toBeNull();
    expect(container.querySelector('stop')).not.toBeNull();
    expect(container.querySelector('filter')).not.toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });
});
