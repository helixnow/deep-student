import { describe, expect, it } from 'vitest';

import { allowNavigation } from '../navigationPolicy';

describe('browser navigation policy', () => {
  it('allows user-controlled public HTTP and relies on chrome to mark it insecure', () => {
    expect(allowNavigation('http://example.com/')).toEqual({ ok: true });
  });

  it('keeps public HTTP blocked for the agent until full mode is enabled', () => {
    expect(allowNavigation('http://example.com/', 'local_whitelist', true)).toEqual({
      ok: false,
      reason: 'non_loopback_http',
    });
    expect(allowNavigation('http://example.com/', 'full', true)).toEqual({ ok: true });
  });

  it('continues to reject privileged schemes for both control modes', () => {
    expect(allowNavigation('file:///tmp/private')).toEqual({
      ok: false,
      reason: 'forbidden_scheme',
      scheme: 'file',
    });
    expect(allowNavigation('javascript:alert(1)', 'full', true)).toEqual({
      ok: false,
      reason: 'forbidden_scheme',
      scheme: 'javascript',
    });
  });
});
