import { describe, expect, it } from 'vitest';
import { CARD_FACE_HELPER_SCRIPT } from '@/components/anki/utils/cardMedia';
import { getHtmlSandboxPermissions, sanitizeHtmlForPreview } from '../htmlSandboxPolicy';

const LAB_BACK = `<div class="lab-opt" data-opt="D" onclick="toggle(this)">D. 以上都是</div>
<script>document.querySelectorAll('.lab-opt').forEach(function(o){ if (o.dataset.opt === 'D') o.classList.add('correct'); });</script>`;

describe('htmlSandboxPolicy', () => {
  // D-154/D-166：模板脚本在预览中剥除（生产 CSP 本来就拦截），onclick/data-* 保留。
  it('strips template scripts but keeps onclick and data attributes for card templates', () => {
    const out = sanitizeHtmlForPreview(LAB_BACK, 'template-safe');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('classList.add');
    expect(out).toContain('data-opt="D"');
    expect(out).toContain('onclick="toggle(this)"');
    // 沙箱只给脚本权限，不给同源
    expect(getHtmlSandboxPermissions('template-safe')).toBe('allow-scripts');
  });

  it('keeps only the exact app-owned card face helper script', () => {
    const out = sanitizeHtmlForPreview(`<div>x</div>${CARD_FACE_HELPER_SCRIPT}${LAB_BACK}`, 'template-safe');
    expect(out.match(/<script>/g)).toHaveLength(1);
    expect(out).toContain(CARD_FACE_HELPER_SCRIPT);
    expect(out).not.toContain('classList.add');
  });

  it('strips a script that differs from the helper by one character', () => {
    const tampered = CARD_FACE_HELPER_SCRIPT.replace('stopAll', 'stopAlx');
    expect(tampered).not.toBe(CARD_FACE_HELPER_SCRIPT);
    expect(tampered.length).toBe(CARD_FACE_HELPER_SCRIPT.length);
    const out = sanitizeHtmlForPreview(`<div>x</div>${tampered}`, 'template-safe');
    expect(out).not.toContain('<script');
    expect(out).toContain('<div>x</div>');
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
