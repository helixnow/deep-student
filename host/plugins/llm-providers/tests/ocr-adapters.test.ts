import { describe, expect, it } from 'vitest';
import {
  DeepSeekOcrAdapter, GenericVlmAdapter, OcrAdapterFactory, OcrImageSource, PaddleOcrVlAdapter,
  extractJsonFromResponse, extractMarkdownText, ocrEngineTypeFromStr, parseDeepseekGrounding, parsePaddleJsonResponse,
} from '../api.ts';

describe('ocr adapter types', () => {
  it('test_engine_type_parsing', () => {
    expect(ocrEngineTypeFromStr('deepseek_ocr')).toBe('deepseek_ocr');
    expect(ocrEngineTypeFromStr('DeepSeek-OCR')).toBe('deepseek_ocr');
    expect(ocrEngineTypeFromStr('paddle_ocr_vl')).toBe('paddle_ocr_vl');
    expect(ocrEngineTypeFromStr('PaddleOCR-VL')).toBe('paddle_ocr_vl');
    expect(ocrEngineTypeFromStr('paddle_ocr_vl_v1')).toBe('paddle_ocr_vl_v1');
    expect(ocrEngineTypeFromStr('paddleocr-vl-v1')).toBe('paddle_ocr_vl_v1');
    expect(ocrEngineTypeFromStr('system_ocr')).toBe('system_ocr');
    expect(ocrEngineTypeFromStr('unknown')).toBe('paddle_ocr_vl');
  });

  it('test_image_source_to_data_url', () => {
    const base64 = OcrImageSource.fromBase64('image/png', 'abc123');
    expect(OcrImageSource.toDataUrl(base64)).toBe('data:image/png;base64,abc123');

    const path = OcrImageSource.fromPath('/path/to/image.png');
    expect(OcrImageSource.toDataUrl(path)).toBeNull();
  });
});

describe('ocr adapter factory', () => {
  it('test_create_adapters', () => {
    expect(OcrAdapterFactory.create('deepseek_ocr').engineType()).toBe('deepseek_ocr');
    expect(OcrAdapterFactory.create('paddle_ocr_vl').engineType()).toBe('paddle_ocr_vl');
    expect(OcrAdapterFactory.create('paddle_ocr_vl_v1').engineType()).toBe('paddle_ocr_vl_v1');
    expect(OcrAdapterFactory.create('generic_vlm').engineType()).toBe('generic_vlm');
  });

  it('test_create_from_str', () => {
    expect(OcrAdapterFactory.createFromStr('deepseek_ocr').engineType()).toBe('deepseek_ocr');
    expect(OcrAdapterFactory.createFromStr('paddle_ocr_vl').engineType()).toBe('paddle_ocr_vl');
  });

  it('creates system OCR and lists it only on supported platforms', () => {
    expect(OcrAdapterFactory.create('system_ocr').engineType()).toBe('system_ocr');
    const supported = process.platform === 'darwin' || process.platform === 'win32';
    expect(OcrAdapterFactory.availableEngines().includes('system_ocr')).toBe(supported);
    expect(OcrAdapterFactory.engineInfoList().some(info => info.engine_type === 'system_ocr')).toBe(supported);
  });

  it('test_validate_model', () => {
    expect(OcrAdapterFactory.validateModelForEngine('deepseek-ai/DeepSeek-OCR', 'deepseek_ocr')).toBe(true);
    expect(OcrAdapterFactory.validateModelForEngine('PaddlePaddle/PaddleOCR-VL-1.5', 'paddle_ocr_vl')).toBe(true);
    expect(OcrAdapterFactory.validateModelForEngine('PaddlePaddle/PaddleOCR-VL', 'paddle_ocr_vl_v1')).toBe(true);
    expect(OcrAdapterFactory.validateModelForEngine('zai-org/GLM-4.6V', 'glm4v_ocr')).toBe(true);
    expect(OcrAdapterFactory.validateModelForEngine('THUDM/GLM-4.1V-9B-Thinking', 'glm4v_ocr')).toBe(false);
    expect(OcrAdapterFactory.validateModelForEngine('Qwen/Qwen2.5-VL', 'deepseek_ocr')).toBe(false);
  });

  it('test_infer_engine', () => {
    expect(OcrAdapterFactory.inferEngineFromModel('zai-org/GLM-4.6V')).toBe('glm4v_ocr');
    expect(OcrAdapterFactory.inferEngineFromModel('deepseek-ai/DeepSeek-OCR')).toBe('deepseek_ocr');
    expect(OcrAdapterFactory.inferEngineFromModel('PaddlePaddle/PaddleOCR-VL-1.5')).toBe('paddle_ocr_vl');
    expect(OcrAdapterFactory.inferEngineFromModel('PaddlePaddle/PaddleOCR-VL')).toBe('paddle_ocr_vl_v1');
    expect(OcrAdapterFactory.inferEngineFromModel('Qwen/Qwen2.5-VL-7B')).toBe('generic_vlm');
    expect(OcrAdapterFactory.inferEngineFromModel('THUDM/GLM-4.1V-9B-Thinking')).toBe('generic_vlm');
  });
});

describe('generic vlm adapter', () => {
  it('test_generic_vlm_adapter', () => {
    const adapter = new GenericVlmAdapter();
    expect(adapter.engineType()).toBe('generic_vlm');
    expect(adapter.supportsMode('free_ocr')).toBe(true);
    expect(adapter.supportsMode('grounding')).toBe(false);

    const prompt = adapter.buildPrompt('free_ocr');
    expect(prompt).toContain('markdown');
  });
});

describe('deepseek ocr adapter', () => {
  it('test_deepseek_adapter_prompt', () => {
    const adapter = new DeepSeekOcrAdapter();
    expect(adapter.buildPrompt('grounding')).toContain('<|grounding|>');
    expect(adapter.buildPrompt('free_ocr')).toBe('Free OCR.');
  });

  it('test_parse_grounding', () => {
    const raw = 'Some text before.\n<|ref|>问题1<|/ref|><|det|>[[100,200,300,400]]<|/det|>\nSome text after.';
    const spans = parseDeepseekGrounding(raw);

    expect(spans).toHaveLength(1);
    expect(spans[0]!.label).toBe('问题1');
    expect(spans[0]!.bbox_0_999_xyxy).toEqual([100, 200, 300, 400]);
  });

  it('test_parse_response', () => {
    const adapter = new DeepSeekOcrAdapter();
    const raw = '<|ref|>题目<|/ref|><|det|>[[50,60,150,160]]<|/det|>这是题目内容';

    const result = adapter.parseResponse(raw, 1000, 800, 0, '/path/to/image.png', 'grounding');
    expect(result.page_index).toBe(0);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]).toEqual({
      label: '题目',
      text: '这是题目内容',
      bbox_normalized: [0.05, 0.06, 0.1, 0.1],
      bbox_pixels: [50, 48, 100, 80],
    });
    expect(result.markdown_text).toBe('这是题目内容');
  });

  it('test_parse_grounding_malformed_markers', () => {
    const plain = '纯文本响应，没有任何 grounding 标记。'.repeat(2000);
    expect(parseDeepseekGrounding(plain)).toHaveLength(0);

    expect(parseDeepseekGrounding('<|ref|>未闭合标签 然后是正文')).toHaveLength(0);

    const raw = '<|ref|>无框<|/ref|>正文<|ref|>有框<|/ref|><|det|>[[1,2,3,4]]<|/det|>';
    const spans = parseDeepseekGrounding(raw);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.label).toBe('无框');
    expect(spans[0]!.bbox_0_999_xyxy).toEqual([1, 2, 3, 4]);

    expect(parseDeepseekGrounding('<|ref|>标签<|/ref|><|det|>[[1,2,3,4]]')).toHaveLength(0);
  });

  it('test_extract_markdown', () => {
    const raw = '<|grounding|>Normal text <|ref|>label<|/ref|><|det|>[[0,0,100,100]]<|/det|> more text';
    const markdown = extractMarkdownText(raw);

    expect(markdown).not.toContain('<|');
    expect(markdown).toContain('Normal text');
    expect(markdown).toContain('more text');
  });
});

describe('deepseek bbox parsing (Rust f64 grammar)', () => {
  const spanFor = (coords: string): number[] | undefined => {
    const spans = parseDeepseekGrounding(`<|ref|>label<|/ref|><|det|>${coords}<|/det|>`);
    return spans.length === 0 ? undefined : spans[0]!.bbox_0_999_xyxy;
  };

  it('parse_bbox_array_rejects_empty_and_non_decimal_segments', () => {
    expect(spanFor('[[1,,3,4]]')).toBeUndefined();
    expect(spanFor('[[1,2,3,]]')).toBeUndefined();
    expect(spanFor('[[0x10,2,3,4]]')).toBeUndefined();
    expect(spanFor('[[1_000,2,3,4]]')).toBeUndefined();
    expect(spanFor('[[]]')).toBeUndefined();
  });

  it('parse_bbox_array_accepts_rust_float_syntax', () => {
    expect(spanFor('[[+1,.5,3.,4e0]]')).toEqual([1, 0.5, 3, 4]);
    expect(spanFor('[[1e2,2E2,3e+2,4e-0]]')).toEqual([100, 200, 300, 4]);
  });

  it('parse_bbox_array_requires_exactly_four_numbers', () => {
    expect(spanFor('[[1,2,3]]')).toBeUndefined();
    expect(spanFor('[[1,2,3,4,5]]')).toBeUndefined();
  });
});

describe('paddle ocr adapter', () => {
  it('test_paddle_adapter_prompt', () => {
    const adapter = new PaddleOcrVlAdapter();
    expect(adapter.buildPrompt('free_ocr')).toBe('OCR:');
    expect(adapter.buildPrompt('grounding')).toBe('OCR:');
    expect(adapter.buildPrompt('formula')).toBe('Formula Recognition:');
    expect(adapter.buildPrompt('table')).toBe('Table Recognition:');
    expect(adapter.buildPrompt('chart')).toBe('Chart Recognition:');
  });

  it('test_repetition_penalty', () => {
    const adapter = new PaddleOcrVlAdapter();
    expect(adapter.recommendedRepetitionPenalty()).not.toBeNull();
    expect(adapter.recommendedRepetitionPenalty()).toBe(1.1);
  });

  it('test_parse_json_response', () => {
    const response = '```json\n{\n  "blocks": [\n    {\n      "type": "text",\n      "content": "Hello World",\n      "bbox": [0.1, 0.2, 0.3, 0.4]\n    }\n  ],\n  "markdown": "Hello World"\n}\n```';

    const result = parsePaddleJsonResponse(response, 1000, 800);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]!.text).toBe('Hello World');
    expect(result.regions[0]!.bbox_normalized).toEqual([0.1, 0.2, 0.19999999999999998, 0.2]);
    expect(result.regions[0]!.bbox_pixels).toEqual([100, 160, 199.99999999999997, 160]);
  });

  it('test_extract_json', () => {
    expect(extractJsonFromResponse('```json\n{"test": true}\n```')).toBe('{"test": true}');
    expect(extractJsonFromResponse('Some text {"test": true} more text')).toBe('{"test": true}');
  });

  it('test_parse_free_ocr_response', () => {
    const adapter = new PaddleOcrVlAdapter();
    const response = '# Title\n\nThis is some text content.';

    const result = adapter.parseResponse(response, 1000, 800, 0, '/test.png', 'free_ocr');
    expect(result.regions).toHaveLength(1);
    expect(result.markdown_text).toBe('# Title\n\nThis is some text content.');
    expect(result.regions[0]).toEqual({ label: 'document', text: '# Title\n\nThis is some text content.', raw_output: response });
  });
});
