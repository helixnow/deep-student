import { describe, expect, it } from 'vitest';
import {
  parseDeepseekGrounding, projectToPixels, safeSlice,
  type DeepseekGroundingSpan,
} from '../src/deepseek_ocr_parser.ts';

describe('deepseek_ocr_parser.rs', () => {
  it('test_parse_simple_grounding', () => {
    const raw = 'Some text before.\n<|ref|>问题1<|/ref|><|det|>[[100,200,300,400]]<|/det|>\nSome text after.';
    const spans = parseDeepseekGrounding(raw);

    expect(spans.length).toBe(1);
    expect(spans[0]!.label).toBe('问题1');
    expect(spans[0]!.bbox_0_999_xyxy).toEqual([100, 200, 300, 400]);
  });

  it('test_parse_multiple_bboxes', () => {
    // DeepSeek-OCR 可能输出多个框，我们只取第一个
    const raw = '<|ref|>题目<|/ref|><|det|>[[50,60,150,160],[200,210,300,310]]<|/det|>';
    const spans = parseDeepseekGrounding(raw);

    expect(spans.length).toBe(1);
    expect(spans[0]!.bbox_0_999_xyxy).toEqual([50, 60, 150, 160]);
  });

  it('test_project_to_pixels', () => {
    const spans: DeepseekGroundingSpan[] = [{
      label: 'test',
      bbox_0_999_xyxy: [0, 0, 999, 999],
      raw_text: '',
      following_text: 'hello',
    }];

    const regions = projectToPixels(spans, 1000, 800);

    expect(regions.length).toBe(1);
    // (0, 0, 999, 999) 在 0-999 坐标系 -> (0, 0, 1000, 800) 像素坐标
    expect(Math.abs(regions[0]!.bbox_px_xywh[0]! - 0)).toBeLessThan(1);
    expect(Math.abs(regions[0]!.bbox_px_xywh[1]! - 0)).toBeLessThan(1);
    expect(Math.abs(regions[0]!.bbox_px_xywh[2]! - 1000)).toBeLessThan(2); // 允许舍入误差
    expect(Math.abs(regions[0]!.bbox_px_xywh[3]! - 800)).toBeLessThan(2);
  });

  it('test_safe_slice_utf8_boundaries', () => {
    // 测试中文字符边界安全性
    const s = '前<|ref|>问题A<|/ref|>后';

    // "问题A" 的字节位置：
    // "前" = 3 bytes (0xE5 0x89 0x8D)
    // "<|ref|>" = 7 bytes
    // "问" = 3 bytes (0xE9 0x97 0xAE)
    // "题" = 3 bytes (0xE9 0xA2 0x98)
    // "A" = 1 byte

    // 正常情况：正确的字符边界
    expect(safeSlice(s, 10, 16)).toBe('问题');

    // 危险情况1：start 在 UTF-8 字符中间（会自动向前回退到字符边界）
    expect(safeSlice(s, 11, 16)).toBe('问题');

    // 危险情况2：end 在 UTF-8 字符中间（会自动向后调整）
    expect(safeSlice(s, 10, 14).length).toBeGreaterThan(0);

    // 边界情况：索引超出范围
    expect(safeSlice(s, 0, 1000)).toBe(s);

    // 边界情况：start > end
    expect(safeSlice(s, 20, 10)).toBe('');
  });

  it('test_parse_complex_chinese_content', () => {
    // 测试包含复杂中文内容的解析，确保不会 panic
    const raw = `题目文本：
        <|ref|>下列关于分子结构的说法正确的是（ ）<|/ref|><|det|>[[50,100,800,150]]<|/det|>
        A. H₂O 分子是直线型
        <|ref|>选项A<|/ref|><|det|>[[100,200,300,250]]<|/det|>
        B. CO₂ 分子是弯曲型
        <|ref|>选项B<|/ref|><|det|>[[100,300,300,350]]<|/det|>
        这是后续文本`;

    const spans = parseDeepseekGrounding(raw);

    // 验证解析结果
    expect(spans.length).toBe(3);

    // 验证第一个标签包含中文
    expect(spans[0]!.label).toContain('分子');
    expect(spans[0]!.bbox_0_999_xyxy.length).toBe(4);

    // 验证第二个标签
    expect(spans[1]!.label).toBe('选项A');

    // 验证第三个标签
    expect(spans[2]!.label).toBe('选项B');

    // 验证跟随文本被正确提取
    expect(spans[2]!.following_text).toContain('这是后续文本');
  });

  it('test_safe_slice_emoji_boundaries', () => {
    // 测试 emoji 等多字节字符（4 字节 UTF-8）
    const s = '前😀<|ref|>后';
    // "前" = 3 bytes
    // "😀" = 4 bytes (0xF0 0x9F 0x98 0x80)
    // "<|ref|>" = 7 bytes

    // 在 emoji 中间切割（会自动调整）
    const slice = safeSlice(s, 4, 10);
    expect(slice.length).toBeGreaterThan(0);

    // 验证返回的字符串是有效的 UTF-8
    expect(slice).not.toContain('\uFFFD');
    expect(Buffer.from(slice, 'utf8').toString('utf8')).toBe(slice);
  });

  it('test_parse_grounding_with_mixed_content', () => {
    // 测试混合内容：中文、英文、数字、特殊符号
    const raw = '<|ref|>问题1：计算 √2 的值（保留2位小数）<|/ref|><|det|>[[10,20,30,40]]<|/det|>';
    const spans = parseDeepseekGrounding(raw);

    expect(spans.length).toBe(1);
    expect(spans[0]!.label).toContain('√');
    expect(spans[0]!.label).toContain('问题');
    expect(spans[0]!.bbox_0_999_xyxy).toEqual([10, 20, 30, 40]);
  });

  it('test_safe_slice_edge_cases', () => {
    const s = '测试';

    // 完全超出范围
    expect(safeSlice(s, 100, 200)).toBe('');

    // start = 0, end = 0
    expect(safeSlice(s, 0, 0)).toBe('');

    // 完整字符串
    expect(safeSlice(s, 0, Buffer.byteLength(s, 'utf8'))).toBe('测试');

    // 空字符串
    expect(safeSlice('', 0, 10)).toBe('');
  });
});
