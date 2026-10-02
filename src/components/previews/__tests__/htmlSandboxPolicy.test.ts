import { describe, expect, it } from 'vitest';
import { getHtmlSandboxPermissions, sanitizeHtmlForPreview } from '../htmlSandboxPolicy';

const LAB_BACK = `<div class="lab-opt" data-opt="D" onclick="toggle(this)">D. 以上都是</div>
<script>document.querySelectorAll('.lab-opt').forEach(function(o){ if (o.dataset.opt === 'D') o.classList.add('correct'); });</script>`;

describe('htmlSandboxPolicy', () => {
  it('keeps template scripts, onclick and data attributes for card templates', () => {
    const out = sanitizeHtmlForPreview(LAB_BACK, 'template-safe');
    expect(out).toContain('<script>');
    expect(out).toContain('data-opt="D"');
    expect(out).toContain('onclick="toggle(this)"');
    // 沙箱只给脚本权限，不给同源
    expect(getHtmlSandboxPermissions('template-safe')).toBe('allow-scripts');
  });

  it('still strips embeds and load handlers in template mode', () => {
    const out = sanitizeHtmlForPreview('<img src="x" onerror="alert(1)"><iframe src="https://x"></iframe><form></form>', 'template-safe');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('<form');
  });

  it('chat mode stays script-free', () => {
    const out = sanitizeHtmlForPreview(LAB_BACK, 'chat-safe');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('data-opt');
    expect(getHtmlSandboxPermissions('chat-safe')).toBe('');
  });
});
