import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CARD_FACE_HELPER_SCRIPT } from '@/components/anki/utils/cardMedia';
import {
  buildHtmlSandboxDocument,
  getHtmlSandboxCsp,
  getHtmlSandboxPermissions,
  sanitizeHtmlForPreview,
} from '../htmlSandboxPolicy';

function directive(csp: string, name: string): string[] {
  return csp.split(';').map((entry) => entry.trim().split(/\s+/))
    .find(([key]) => key === name)?.slice(1) ?? [];
}

const documentHtml = buildHtmlSandboxDocument({
  html: sanitizeHtmlForPreview(`<div>长背面</div>${CARD_FACE_HELPER_SCRIPT}`, 'template-safe'),
  css: '',
  mode: 'template-safe',
  fidelity: 'anki',
});
const frameDocument = new DOMParser().parseFromString(documentHtml, 'text/html');
const trustedHashes = Array.from(frameDocument.querySelectorAll('script')).map((script) =>
  `'sha256-${createHash('sha256').update(script.textContent ?? '').digest('base64')}'`,
);

for (const configPath of ['src-tauri/tauri.conf.json', 'config/dev-phone-window.json']) {
  describe(`card sandbox helpers under ${configPath}`, () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), configPath), 'utf8'));
    const scripts = directive(config.app.security.csp, 'script-src');

    it('authorizes the exact rendered resize and media helper scripts', () => {
      expect(trustedHashes).toHaveLength(2);
      for (const hash of trustedHashes) expect(scripts).toContain(hash);
    });

    it('does not allow arbitrary inline scripts or wildcard script sources', () => {
      expect(scripts).not.toContain("'unsafe-inline'");
      expect(scripts).not.toContain('*');
      expect(scripts.filter((source) => source.startsWith("'sha256-"))).toEqual(trustedHashes);
    });
  });
}

describe('card iframe isolation', () => {
  it('keeps scripts isolated from the application origin and backend', () => {
    expect(getHtmlSandboxPermissions('template-safe')).toBe('allow-scripts');
    expect(directive(getHtmlSandboxCsp('template-safe'), 'connect-src')).toEqual(["'none'"]);
    expect(directive(getHtmlSandboxCsp('template-safe'), 'frame-src')).toEqual(["'none'"]);
    expect(getHtmlSandboxPermissions('chat-safe')).toBe('');
    expect(directive(getHtmlSandboxCsp('chat-safe'), 'script-src')).toEqual(["'none'"]);
  });
});
