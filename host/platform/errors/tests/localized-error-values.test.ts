import { expect, it } from 'vitest';
import { ensure_localized_error } from '../api.ts';

// Production consumer: vfs/src/tools/retrieval-executor.ts:52 -> public F4 error wrapper.
// Rust dstu-core/tool_args.rs:49-102 parses/serializes Value with arbitrary_precision + preserve_order.
const wrap = (raw: string) => ensure_localized_error(raw, 'DEFAULT', 'tools.error', '失败', 'Failed');

it('F4-V2-10 localized error strings retain exact Value numbers instead of rounding or null', () => {
  const result = wrap('{"code":9007199254740993,"current":{"n":1e400,"f":1.0,"zero":-0,"exp":1E7}}');
  expect(result).toBe('{"code":9007199254740993,"current":{"n":1e+400,"f":1.0,"zero":0,"exp":1e+7},"retryable":false,"messageKey":"tools.error","messageParams":{"code":9007199254740993},"messageFallback":{"zh-CN":"失败","en-US":"Failed"},"message":"失败 / Failed"}');
});

it('F4-V2-10 complete localized contracts keep fields but normalize params.code without losing precision', () => {
  const result = wrap('{"code":18446744073709551615,"messageKey":"keep","messageParams":{"action":"read","code":"old"},"messageFallback":{},"message":"keep"}');
  expect(result).toBe('{"code":18446744073709551615,"messageKey":"keep","messageParams":{"action":"read","code":18446744073709551615},"messageFallback":{},"message":"keep","retryable":false}');
});

it('F4-V2-10 Value duplicate keys are last-wins at first position and special names remain data', () => {
  const result = wrap('{"code":"first","__proto__":{"code":"hidden"},"code":"last"}');
  expect(result).toBe('{"code":"last","__proto__":{"code":"hidden"},"retryable":false,"messageKey":"tools.error","messageParams":{"code":"last"},"messageFallback":{"zh-CN":"失败","en-US":"Failed"},"message":"失败 / Failed"}');
});

it('F4-V2-10 malformed Value strings and excessive depth are wrapped as plain bounded details', () => {
  for (const raw of ['{"message":"\\ud800"}', '{"nested":' + '['.repeat(128) + ']'.repeat(128) + '}']) {
    const result = JSON.parse(wrap(raw));
    expect(result).toEqual({ code: 'DEFAULT', detail: raw, detailTruncated: false, retryable: false,
      messageKey: 'tools.error', messageParams: { code: 'DEFAULT' },
      messageFallback: { 'zh-CN': '失败', 'en-US': 'Failed' }, message: '失败 / Failed' });
  }
});
