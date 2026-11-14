import { expect, it } from 'vitest';
import { selectRoute } from '../src/bilibili-session.ts';
import { BiliRequestError } from '../src/bilibili-policy.ts';

it('auto_uses_the_app_account_without_requiring_a_browser_on_every_platform', () => {
  for (const ready of [false, true]) {
    for (const parsingOnly of [false, true]) {
      expect(selectRoute('auto', ready, parsingOnly, true)).toBe('native');
    }
  }
});

it('native_guest_keeps_the_capable_bridge_preference', () => {
  expect(selectRoute('auto', true, false, false)).toBe('browser_bridge');
  expect(selectRoute('auto', false, false, false)).toBe('native');
});

it('native_preference_never_overrides_an_explicit_route', () => {
  for (const nativeFirst of [false, true]) {
    expect(selectRoute('browser_bridge', true, false, nativeFirst)).toBe('browser_bridge');
    expect(() => selectRoute('browser_bridge', false, false, nativeFirst)).toThrow(BiliRequestError);
    expect(selectRoute('native', true, false, nativeFirst)).toBe('native');
    expect(selectRoute('proxy', true, false, nativeFirst)).toBe('proxy');
  }
  let code: string | null = null;
  try { selectRoute('browser_bridge', false, true, false); }
  catch (error) { code = (error as BiliRequestError).payload.code; }
  expect(code).toBe('bilibili-bridge-offline');
});
