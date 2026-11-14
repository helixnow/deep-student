import { describe, expect, it } from 'vitest';
import { parseBridgeJson } from '../src/bridge.ts';

describe('bridge.rs parse_bridge_json uses serde_json::from_str and str::trim (X6-UD-0017/0018)', () => {
  it('parse_bridge_json (bridge.rs:153) reports InvalidJson for a lone surrogate, including the nested string layer', () => {
    const outer = parseBridgeJson('{"ok":true,"value":"\\ud800"}');
    expect(outer.ok).toBe(false);
    expect(outer).toMatchObject({ ok: false, error: { kind: 'InvalidJson' } });
    if (!outer.ok && outer.error.kind === 'InvalidJson') {
      expect(outer.error.message).toMatch(/^unexpected end of hex escape at line 1 column \d+; raw=/u);
    }
    const inner = parseBridgeJson(JSON.stringify('{"ok":true,"value":"\\udc00"}'));
    expect(inner.ok).toBe(false);
    expect(inner).toMatchObject({ ok: false, error: { kind: 'InvalidJson' } });
    if (!inner.ok && inner.error.kind === 'InvalidJson') expect(inner.error.message).toMatch(/^nested string parse: lone leading surrogate in hex escape /u);
  });

  it('parse_bridge_json uses Rust str::trim: U+FEFF is not trimmed, U+0085 is', () => {
    const bom = parseBridgeJson('\ufeff{"ok":true,"value":1}');
    expect(bom.ok).toBe(false);
    if (!bom.ok) expect(bom.error.kind).toBe('InvalidJson');
    expect(parseBridgeJson('\u0085{"ok":true,"value":1}\u0085').ok).toBe(true);
  });

});
