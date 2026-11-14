// Port of `src-tauri/tests/browser_capability_contract.rs::embedded_browser_permissions_are_scoped_per_webview`.
// The Tauri capability files remain the ACL source consumed by the Electron shell
// (`electron/shell/capabilities.ts`), so the per-WebView scoping invariant still holds.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BROWSER_CONTENT_LABEL } from '../src/session.ts';

function capability(name: string): Record<string, unknown> {
  const url = new URL(`../../../../resources/app/capabilities/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Record<string, unknown>;
}

function assertWebviewScope(value: Record<string, unknown>, expectedLabel: string): void {
  expect(value.windows).toBeUndefined();
  expect(value.webviews).toEqual([expectedLabel]);
}

describe('tests/browser_capability_contract.rs', () => {
  it('embedded_browser_permissions_are_scoped_per_webview', () => {
    const defaultCapability = capability('default');
    const browserCapability = capability('browser-content');

    assertWebviewScope(defaultCapability, 'main');
    assertWebviewScope(browserCapability, BROWSER_CONTENT_LABEL);

    expect(browserCapability.permissions).toEqual(['allow-browser-content-user-input']);
    expect(browserCapability.local).toBe(false);
    expect(browserCapability.remote).toEqual({ urls: ['https://*/*', 'http://*/*'] });

    const defaultPermissions = defaultCapability.permissions;
    expect(Array.isArray(defaultPermissions)).toBe(true);
    expect((defaultPermissions as unknown[]).includes('allow-application-commands')).toBe(true);
  });
});
