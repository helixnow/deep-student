import { describe, expect, it } from 'vitest';
import {
  BRIDGE_GLOBAL, DEFAULT_EVAL_TIMEOUT_MS, INPUT_NONCE_MARKER, INIT_SCRIPT, SESSION_ID_MARKER,
  bridgeScripts, buildTypeArgs, callScript, finishScriptResult, initScriptForSession, parseBridgeJson,
  type BridgeResult,
} from '../src/bridge.ts';
import { bridgeErrorMessage, type BridgeError } from '../src/command-result.ts';

function unwrap<T>(result: BridgeResult<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
}
function error(result: BridgeResult<unknown>): BridgeError {
  if (result.ok) throw new Error('expected an error result');
  return result.error;
}

describe('crates/dstu-browser/src/browser/bridge.rs::tests', () => {
  it('init_script_is_nonempty_and_defines_global', () => {
    expect(INIT_SCRIPT.length).toBeGreaterThan(500);
    expect(INIT_SCRIPT).toContain('__dsBrowserBridge');
    expect(INIT_SCRIPT).toContain('password');
    expect(INIT_SCRIPT).toContain('BLOCKED');
    expect(INIT_SCRIPT).toContain('ax-lite');
    expect(INIT_SCRIPT).toContain('function snapshot');
    expect(INIT_SCRIPT.includes('function typeText') || INIT_SCRIPT.includes('type:')).toBe(true);
  });

  it('session_init_script_keeps_input_capability_lexical', () => {
    const nonce = '00112233445566778899aabbccddeeff';
    const script = unwrap(initScriptForSession('bs_"quoted', nonce));

    expect(script).not.toContain(SESSION_ID_MARKER);
    expect(script).not.toContain(INPUT_NONCE_MARKER);
    expect(script).toContain('var sessionId = "bs_\\"quoted"');
    expect(script).toContain(`var nonce = "${nonce}"`);
    expect(script).toContain('event.isTrusted !== true');
    expect(script).toContain('browser_content_user_input');
    expect(script).not.toContain('window.__dsBrowserInputNonce');
  });

  it('session_init_script_rejects_malformed_nonce', () => {
    expect(initScriptForSession('bs_test', 'short').ok).toBe(false);
    expect(initScriptForSession('bs_test', 'zz112233445566778899aabbccddeeff').ok).toBe(false);
  });

  it('parse_envelope_ok', () => {
    const raw = '{"ok":true,"v":1,"epoch":2,"data":{"count":1}}';
    const envelope = unwrap(parseBridgeJson(raw));
    const data = unwrap(envelope.intoResult());
    expect((data as { count: number }).count).toBe(1);
  });

  it('parse_envelope_double_encoded_string', () => {
    const inner = '{"ok":true,"v":1,"epoch":1,"data":{"status":"ready"}}';
    const raw = JSON.stringify(inner);
    const envelope = unwrap(parseBridgeJson(raw));
    const data = unwrap(envelope.intoResult());
    expect((data as { status: string }).status).toBe('ready');
  });

  it('parse_envelope_password_blocked', () => {
    const raw = `{
      "ok": false,
      "v": 1,
      "epoch": 3,
      "error": {
        "code": "BLOCKED",
        "message": "password fields cannot be typed by agent bridge",
        "details": { "reason": "password_field", "ref": "e1" }
      }
    }`;
    const envelope = unwrap(parseBridgeJson(raw));
    const result = envelope.intoResult();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Bridge');
    if (result.error.kind !== 'Bridge') return;
    expect(result.error.code).toBe('BLOCKED');
    expect(result.error.message).toContain('password');
    expect((result.error.details as { reason: string }).reason).toBe('password_field');
  });

  it('call_script_embeds_json_args_safely', () => {
    const malicious = '{"interactiveOnly":true,"x":"</script>"}';
    const script = callScript('snapshot', malicious);
    expect(script).toContain(malicious);
    expect(script).toContain('__dsBrowserBridge');
    expect(script).toContain('JSON.stringify');
    expect(script.includes('eval(')).toBe(false);
  });

  it('type_script_builder_json_escapes_quotes', () => {
    const text = 'hello"world\n<script>';
    const args = buildTypeArgs('e1', text);
    expect(args).toContain('hello\\"world');
    expect(() => JSON.parse(args)).not.toThrow();
    expect(bridgeScripts().type('e1', text)).toContain(args);
  });

  it('unsupported_message_mentions_platforms', () => {
    const message = bridgeErrorMessage({ kind: 'Unsupported', message: 'Linux WebKitGTK' });
    expect(message.includes('Unsupported') || message.includes('unsupported') || message.includes('Linux')).toBe(true);
  });

  it('finish_script_result_maps_eval_error', () => {
    const result = finishScriptResult({ ok: false, error: 'evaluateJavaScript error: boom' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Eval');
    if (result.error.kind !== 'Eval') return;
    expect(result.error.message).toContain('boom');
  });

  it('finish_script_result_maps_invalid_json', () => {
    expect(error(finishScriptResult({ ok: true, value: 'not-json' })).kind).toBe('InvalidJson');
  });

  it('finish_script_result_parses_double_encoded_ok', () => {
    const inner = '{"ok":true,"v":1,"epoch":1,"data":{"status":"ready"}}';
    const raw = JSON.stringify(inner);
    const data = unwrap(finishScriptResult({ ok: true, value: raw }));
    expect((data as { status: string }).status).toBe('ready');
  });

  it('finish_script_result_maps_bridge_error_envelope', () => {
    const raw = '{"ok":false,"v":1,"epoch":0,"error":{"code":"EVAL_THROW","message":"x"}}';
    const result = finishScriptResult({ ok: true, value: raw });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Bridge');
    if (result.error.kind !== 'Bridge') return;
    expect(result.error.code).toBe('EVAL_THROW');
  });

  it('timeout_error_is_explicit', () => {
    const err: BridgeError = { kind: 'Timeout', milliseconds: 10_000 };
    const message = bridgeErrorMessage(err);
    expect(message.includes('timed out') || message.includes('timeout') || message.includes('10s')).toBe(true);
    expect(err.kind).toBe('Timeout');
  });

  it('default_eval_timeout_is_ten_seconds', () => {
    expect(DEFAULT_EVAL_TIMEOUT_MS).toBe(10_000);
  });

  it('eval_with_result_is_unsupported_off_win_mac_linux', () => {
    const err: BridgeError = {
      kind: 'Unsupported',
      message: 'eval_with_result requires with_webview platform callback',
    };
    expect(bridgeErrorMessage(err).toLowerCase()).toContain('unsupported');
  });
});

describe('bridge helpers beyond the Rust unit tests', () => {
  it('rejects empty and structurally invalid envelopes', () => {
    expect(error(parseBridgeJson('   ')).kind).toBe('InvalidJson');
    expect(error(parseBridgeJson('[]')).kind).toBe('InvalidJson');
    expect(error(parseBridgeJson('{"ok":true,"v":"1"}')).kind).toBe('InvalidJson');
    expect(error(parseBridgeJson('{"ok":true,"error":{"code":1}}')).kind).toBe('InvalidJson');
  });

  it('defaults missing error bodies and data like serde', () => {
    const missing = unwrap(parseBridgeJson('{"ok":false}')).intoResult();
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error).toEqual({
      kind: 'Bridge', code: 'UNKNOWN',
      message: 'bridge returned ok=false without error', details: null,
    });
    const okEnvelope = unwrap(parseBridgeJson('{"ok":true}'));
    expect(unwrap(okEnvelope.intoResult())).toBeNull();
    expect(BRIDGE_GLOBAL).toBe('__dsBrowserBridge');
  });

  it('macos_eval_with_result_roundtrip', () => {
    // Rust test is `#[ignore]` (live WKWebView anchor); its body asserts the eval timeout.
    expect(DEFAULT_EVAL_TIMEOUT_MS).toBe(10_000);
  });

  it('linux_eval_with_result_roundtrip', () => {
    // Rust test is `#[ignore]` (live WebKitGTK anchor); its body asserts the eval timeout.
    expect(DEFAULT_EVAL_TIMEOUT_MS).toBe(10_000);
  });

  it('builds every client payload with JSON-embedded arguments', () => {
    const scripts = bridgeScripts();
    expect(scripts.ready()).toContain('b.ready()');
    expect(scripts.snapshot(true)).toContain('{"interactiveOnly":true}');
    expect(scripts.click('e1')).toContain('{"ref":"e1"}');
    expect(scripts.setInputFiles('e1', [{ name: 'a.txt' }])).toContain('b.setInputFiles(args[0], args[1])');
    expect(scripts.scroll({ direction: 'down' })).toContain('{"direction":"down"}');
    expect(scripts.highlight('e1')).toContain('"durationMs":800');
  });
});
