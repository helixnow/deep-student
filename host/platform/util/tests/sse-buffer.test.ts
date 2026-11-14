/**
 * `dstu-util/src/utf8_stream.rs::tests` 8 条 +
 * `dstu-util/src/utils/sse_buffer.rs::tests` 20 条精确移植。
 *
 * 全部经 `host/platform/util/api.ts` 的公开生产入口调用；L01/L02 的流式管线
 * 应改用同一实现，不再各自维护 SseEventBuffer 副本。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  SseEventBuffer,
  SseLineBuffer,
  Utf8StreamDecoder,
  extractStreamDataPayload,
  setSseBufferLogger,
} from '../api.ts';

const encoder = new TextEncoder();

afterEach(() => {
  setSseBufferLogger(null);
});

describe('dstu-util/src/utf8_stream.rs::tests', () => {
  it('test_ascii_passthrough', () => {
    const decoder = new Utf8StreamDecoder();
    expect(decoder.decode(encoder.encode('hello'))).toBe('hello');
    expect(decoder.decode(encoder.encode(' world'))).toBe(' world');
    expect(decoder.flush()).toBe('');
  });

  it('test_chinese_char_split_across_chunks', () => {
    const bytes = encoder.encode('中');
    const decoder = new Utf8StreamDecoder();
    expect(decoder.decode(bytes.subarray(0, 1))).toBe('');
    expect(decoder.hasPending()).toBe(true);
    expect(decoder.decode(bytes.subarray(1))).toBe('中');
    expect(decoder.hasPending()).toBe(false);
    expect(decoder.flush()).toBe('');
  });

  it('test_chinese_text_split_at_every_position', () => {
    const text = '流式回复中文测试：你好，世界！🌍';
    const bytes = encoder.encode(text);
    for (let split = 1; split < bytes.length; split += 1) {
      const decoder = new Utf8StreamDecoder();
      let result = '';
      result += decoder.decode(bytes.subarray(0, split));
      result += decoder.decode(bytes.subarray(split));
      result += decoder.flush();
      expect(result, `切分点 ${split} 处解码结果不一致`).toBe(text);
    }
  });

  it('test_four_byte_emoji_split_three_ways', () => {
    const bytes = encoder.encode('🚀');
    const decoder = new Utf8StreamDecoder();
    let result = '';
    for (const byte of bytes) result += decoder.decode(Uint8Array.of(byte));
    result += decoder.flush();
    expect(result).toBe('🚀');
  });

  it('test_sse_line_split_mid_char', () => {
    const full = 'data: {"content":"数学题"}\n';
    const bytes = encoder.encode(full);
    const idx = full.indexOf('学') + 1;
    const decoder = new Utf8StreamDecoder();
    let result = '';
    result += decoder.decode(bytes.subarray(0, idx));
    result += decoder.decode(bytes.subarray(idx));
    expect(result).toBe(full);
  });

  it('test_truly_invalid_bytes_replaced', () => {
    const decoder = new Utf8StreamDecoder();
    const out = decoder.decode(Uint8Array.from([0x61, 0xff, 0x62]));
    expect(out).toBe('a\uFFFDb');
    expect(decoder.hasPending()).toBe(false);
  });

  it('test_flush_incomplete_tail_becomes_replacement', () => {
    const decoder = new Utf8StreamDecoder();
    expect(decoder.decode(encoder.encode('中').subarray(0, 1))).toBe('');
    expect(decoder.flush()).toBe('\uFFFD');
    expect(decoder.hasPending()).toBe(false);
  });

  it('test_empty_chunk', () => {
    const decoder = new Utf8StreamDecoder();
    expect(decoder.decode(new Uint8Array(0))).toBe('');
    const chinese = encoder.encode('中');
    expect(decoder.decode(chinese.subarray(0, 2))).toBe('');
    expect(decoder.decode(new Uint8Array(0))).toBe('');
    expect(decoder.decode(chinese.subarray(2))).toBe('中');
  });
});

describe('dstu-util/src/utils/sse_buffer.rs::tests', () => {
  it('test_complete_lines', () => {
    const buffer = new SseLineBuffer();
    const lines = buffer.processChunk('data: {"test": "value1"}\ndata: {"test": "value2"}\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('data: {"test": "value1"}');
    expect(lines[1]).toBe('data: {"test": "value2"}');
    expect(buffer.hasRemaining()).toBe(false);
  });

  it('test_incomplete_line', () => {
    const buffer = new SseLineBuffer();
    const lines1 = buffer.processChunk('data: {"test": "val');
    expect(lines1).toHaveLength(0);
    expect(buffer.hasRemaining()).toBe(true);

    const lines2 = buffer.processChunk('ue1"}\ndata: {"test": "value2"}\n');
    expect(lines2).toHaveLength(2);
    expect(lines2[0]).toBe('data: {"test": "value1"}');
    expect(lines2[1]).toBe('data: {"test": "value2"}');
    expect(buffer.hasRemaining()).toBe(false);
  });

  it('test_mixed_complete_and_incomplete', () => {
    const buffer = new SseLineBuffer();
    const lines = buffer.processChunk('data: {"test": "value1"}\ndata: {"test": "par');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('data: {"test": "value1"}');
    expect(buffer.hasRemaining()).toBe(true);

    const lines2 = buffer.processChunk('tial"}\n');
    expect(lines2).toHaveLength(1);
    expect(lines2[0]).toBe('data: {"test": "partial"}');
    expect(buffer.hasRemaining()).toBe(false);
  });

  it('test_flush_remaining', () => {
    const buffer = new SseLineBuffer();
    buffer.processChunk('incomplete line without newline');
    expect(buffer.hasRemaining()).toBe(true);
    expect(buffer.flush()).toBe('incomplete line without newline');
    expect(buffer.hasRemaining()).toBe(false);
  });

  it('test_done_marker', () => {
    expect(SseLineBuffer.checkDoneMarker('data: [DONE]')).toBe(true);
    expect(SseLineBuffer.checkDoneMarker('  data: [DONE]  ')).toBe(true);
    expect(SseLineBuffer.checkDoneMarker('data: {"done": true}')).toBe(false);
  });

  it('test_empty_chunk', () => {
    const buffer = new SseLineBuffer();
    const lines = buffer.processChunk('');
    expect(lines).toHaveLength(0);
    expect(buffer.hasRemaining()).toBe(false);
  });

  it('test_buffer_overflow_protection', () => {
    const buffer = new SseLineBuffer(32);
    let lines = buffer.processChunk('data: ok\n');
    expect(lines).toEqual(['data: ok']);

    lines = buffer.processChunk('data: short');
    expect(lines).toHaveLength(0);
    expect(buffer.hasRemaining()).toBe(true);

    lines = buffer.processChunk('_this_is_way_too_long_for_limit!');
    expect(lines).toHaveLength(0);
    expect(buffer.hasRemaining()).toBe(false);

    lines = buffer.processChunk('data: recovered\n');
    expect(lines).toEqual(['data: recovered']);
  });

  it('test_buffer_exactly_at_limit', () => {
    const buffer = new SseLineBuffer(16);
    let lines = buffer.processChunk('1234567890123456');
    expect(lines).toHaveLength(0);
    expect(buffer.hasRemaining()).toBe(true);

    lines = buffer.processChunk('X');
    expect(lines).toHaveLength(0);
    expect(buffer.hasRemaining()).toBe(false);
  });

  it('test_multiple_chunks_with_fragmentation', () => {
    const buffer = new SseLineBuffer();
    const chunks = [
      'data: {"',
      'test": "',
      'value1"}\n',
      'data: {"test2',
      '": "value2"}\nda',
      'ta: [DONE]\n',
    ];
    const allLines: string[] = [];
    for (const chunk of chunks) allLines.push(...buffer.processChunk(chunk));
    const remaining = buffer.flush();
    if (remaining !== null) allLines.push(remaining);

    expect(allLines).toHaveLength(3);
    expect(allLines[0]).toBe('data: {"test": "value1"}');
    expect(allLines[1]).toBe('data: {"test2": "value2"}');
    expect(allLines[2]).toBe('data: [DONE]');
  });

  it('event_buffer_keeps_event_name_with_data_payload', () => {
    const buffer = new SseEventBuffer();
    const events = buffer.processBytes(
      encoder.encode('event: response.output_text.delta\ndata: {"delta":"framed"}\n\n'),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toBe('event: response.output_text.delta\ndata: {"delta":"framed"}');
  });

  it('event_buffer_preserves_utf8_split_across_byte_chunks', () => {
    const buffer = new SseEventBuffer();
    const source = 'data: {"type":"response.output_text.delta","delta":"中文"}\n\n';
    const bytes = encoder.encode(source);
    const split = source.indexOf('中') + 1;

    expect(buffer.processBytes(bytes.subarray(0, split))).toEqual([]);
    const events = buffer.processBytes(bytes.subarray(split));

    expect(events).toEqual([source.trim()]);
    expect(events[0]!.includes('\uFFFD')).toBe(false);
  });

  it('event_buffer_no_replacement_char_when_chinese_split_in_two_chunks', () => {
    const source = 'data: {"choices":[{"delta":{"content":"中"}}]}\n';
    const bytes = encoder.encode(source);
    const split = source.indexOf('中') + 1;

    const buffer = new SseEventBuffer();
    const first = buffer.processBytes(bytes.subarray(0, split));
    expect(first).toEqual([]);

    const second = buffer.processBytes(bytes.subarray(split));
    expect(second).toEqual([source.trim()]);
    expect(second[0]!.includes('\uFFFD')).toBe(false);
    expect(buffer.flush()).toEqual([]);
  });

  it('event_buffer_reassembles_multibyte_content_split_at_every_byte_boundary', () => {
    const source = 'data: {"choices":[{"delta":{"content":"中文乱码测试🚀"}}]}\n\n';
    const bytes = encoder.encode(source);
    for (let split = 1; split < bytes.length; split += 1) {
      const buffer = new SseEventBuffer();
      const events = buffer.processBytes(bytes.subarray(0, split));
      for (const event of events) {
        expect(event.includes('\uFFFD'), `切分点 ${split} 处提前产生 U+FFFD`).toBe(false);
      }
      events.push(...buffer.processBytes(bytes.subarray(split)));
      events.push(...buffer.flush());
      expect(events, `切分点 ${split} 处事件重组失败`).toEqual([source.trim()]);
    }
  });

  it('event_buffer_flush_marks_stream_truncated_mid_character', () => {
    const buffer = new SseEventBuffer();
    const bytes = encoder.encode('data: 中');
    expect(buffer.processBytes(bytes.subarray(0, bytes.length - 1))).toEqual([]);
    expect(buffer.flush()).toEqual(['data: \uFFFD']);
  });

  it('event_buffer_emits_single_newline_done_tail', () => {
    const buffer = new SseEventBuffer();
    const events = buffer.processBytes(encoder.encode('data:[DONE]\n'));
    expect(events).toEqual(['data:[DONE]']);
    expect(SseEventBuffer.checkDoneMarker(events[0]!)).toBe(true);
    expect(buffer.flush()).toEqual([]);
  });

  it('event_buffer_flushes_unterminated_event_block', () => {
    const buffer = new SseEventBuffer();
    expect(buffer.processBytes(encoder.encode('event: response.output_text.delta\ndata: {"delta":"tail"}'))).toEqual([]);
    expect(buffer.flush()).toEqual(['event: response.output_text.delta\ndata: {"delta":"tail"}']);
  });

  it('event_buffer_preserves_jsonl_lines', () => {
    const buffer = new SseEventBuffer();
    const events = buffer.processBytes(encoder.encode('{"message":1}\n{"message":2}\n'));
    expect(events).toEqual(['{"message":1}', '{"message":2}']);
    expect(buffer.flush()).toEqual([]);
  });

  it('stream_payload_accepts_bare_json_without_misreading_sse_metadata', () => {
    expect(extractStreamDataPayload('{"message":1}')).toBe('{"message":1}');
    expect(extractStreamDataPayload('event: message\n: keep-alive')).toBeNull();
    expect(extractStreamDataPayload(': keep-alive')).toBeNull();
  });

  it('stream_payload_strips_single_and_multiple_trailing_cr', () => {
    expect(extractStreamDataPayload('data: a\r')).toBe('a');
    expect(extractStreamDataPayload('data: a\r\r\r')).toBe('a');
    expect(extractStreamDataPayload('data:a\r\r')).toBe('a');
    expect(extractStreamDataPayload('data:\r\r')).toBe('');
  });

  it('stream_payload_mixed_multiline_strips_all_trailing_cr', () => {
    expect(extractStreamDataPayload('event: message\r\ndata: a\r\r\ndata: b\r\n\r\n')).toBe('a\nb');
    expect(extractStreamDataPayload('id: 1\r\ndata: first\r\r\ndata: second\r\r\r\n')).toBe('first\nsecond');
  });

  it('stream_payload_preserves_internal_cr_in_data_body', () => {
    expect(extractStreamDataPayload('data: a\rb\r\r')).toBe('a\rb');
    expect(extractStreamDataPayload('data: a\rb\r\r\ndata: c\rd\r\n')).toBe('a\rb\nc\rd');
  });

  it('event_buffer_enforces_combined_size_limit', () => {
    const buffer = new SseEventBuffer(24);
    expect(buffer.processBytes(encoder.encode('event: response.test\n'))).toEqual([]);
    expect(buffer.processBytes(encoder.encode('data: {"too":"large"}'))).toEqual([]);
    expect(buffer.flush()).toEqual([]);
  });

  it('event_buffer_long_single_line_split_across_many_chunks_is_linear', () => {
    const buffer = new SseEventBuffer();
    const body = `data: {"delta":"${'这是超长思考内容与题目输出，用来模拟题量大时模型把整段结果塞进一条 data 行。'.repeat(2000)}"}\n`;
    const bytes = encoder.encode(body);
    const chunkSize = 17;
    const fed: string[] = [];
    const chunks = Math.ceil(bytes.length / chunkSize);
    for (let i = 0; i < chunks; i += 1) {
      const events = buffer.processBytes(bytes.subarray(i * chunkSize, (i + 1) * chunkSize));
      if (i < chunks - 1) expect(events, '尚未收全整行（含换行前一字符）前不应产出事件').toEqual([]);
      fed.push(...events);
    }
    fed.push(...buffer.flush());
    expect(fed).toHaveLength(1);
    expect(fed[0]).toBe(body.trim());
    expect(fed[0]!.includes('\uFFFD')).toBe(false);
  });

  it('routes overflow and truncated utf8 diagnostics to the configured logger', () => {
    const calls: Array<{ level: string; message: string }> = [];
    setSseBufferLogger((level, message) => calls.push({ level, message }));

    const lineBuffer = new SseLineBuffer(8);
    lineBuffer.processChunk('123456789');
    const decoder = new Utf8StreamDecoder();
    decoder.decode(encoder.encode('中').subarray(0, 1));
    decoder.flush();

    expect(calls.some(call => call.level === 'error')).toBe(true);
    expect(calls.some(call => call.level === 'warn')).toBe(true);
  });
});
