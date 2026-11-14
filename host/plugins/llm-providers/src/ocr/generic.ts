import type { OcrEngineType, OcrMode, OcrPageResult, OcrRegion } from '../../api.ts';
import { rustTrim } from '../../../../platform/util/portable.ts';
import { BaseOcrAdapter } from './base.ts';
import { LATEX_OUTPUT_BRIEF, LATEX_OUTPUT_BRIEF_EN } from './prompts.ts';

function documentRegion(response: string): OcrRegion {
  return { label: 'document', text: rustTrim(response), raw_output: response };
}

function textResult(
  engine: OcrEngineType,
  response: string,
  imageWidth: number,
  imageHeight: number,
  pageIndex: number,
  imagePath: string,
  mode: OcrMode,
): OcrPageResult {
  return {
    page_index: pageIndex,
    image_path: imagePath,
    image_width: imageWidth,
    image_height: imageHeight,
    regions: [documentRegion(response)],
    markdown_text: rustTrim(response),
    engine,
    mode,
  };
}

/** ocr_adapters/mod.rs:176 `Glm4vOcrAdapter`. */
export class Glm4vOcrAdapter extends BaseOcrAdapter {
  engineType(): OcrEngineType { return 'glm4v_ocr'; }
  supportsMode(_mode: OcrMode): boolean { return true; }

  buildPrompt(mode: OcrMode): string {
    switch (mode) {
      case 'free_ocr': return `请将图片中的所有文本内容转换为 Markdown 格式，保持原有排版结构。${LATEX_OUTPUT_BRIEF}`;
      case 'grounding': return `请识别图片中的所有文本区域，输出每个区域的文本内容和位置坐标 bbox_2d [x1,y1,x2,y2]。${LATEX_OUTPUT_BRIEF}`;
      case 'formula': return `请提取图片中的所有数学公式，转换为 LaTeX 格式输出。${LATEX_OUTPUT_BRIEF}`;
      case 'table': return '请提取图片中的表格，转换为 Markdown 表格格式输出。';
      case 'chart': return '请分析图片中的图表，详细描述其内容、数据和趋势。';
    }
  }

  override parseResponse(
    response: string, imageWidth: number, imageHeight: number, pageIndex: number, imagePath: string, mode: OcrMode,
  ): OcrPageResult {
    return textResult('glm4v_ocr', response, imageWidth, imageHeight, pageIndex, imagePath, mode);
  }

  override recommendedMaxTokens(_mode: OcrMode): number { return 8192; }
}

/** ocr_adapters/mod.rs:248 `GenericVlmAdapter`. */
export class GenericVlmAdapter extends BaseOcrAdapter {
  engineType(): OcrEngineType { return 'generic_vlm'; }

  /** L4 fix: generic VLMs cannot emit grounding coordinates. */
  supportsMode(mode: OcrMode): boolean { return mode !== 'grounding'; }

  buildPrompt(mode: OcrMode): string {
    switch (mode) {
      case 'free_ocr':
      case 'grounding':
        return `Convert the document to markdown. Preserve the structure and formatting as much as possible. ${LATEX_OUTPUT_BRIEF_EN}`;
      case 'formula': return `Extract and convert all mathematical formulas in the image to LaTeX format. ${LATEX_OUTPUT_BRIEF_EN}`;
      case 'table': return 'Extract the table from the image and convert it to markdown table format.';
      case 'chart': return 'Analyze the chart in the image and describe its content in detail.';
    }
  }

  override parseResponse(
    response: string, imageWidth: number, imageHeight: number, pageIndex: number, imagePath: string, mode: OcrMode,
  ): OcrPageResult {
    return textResult('generic_vlm', response, imageWidth, imageHeight, pageIndex, imagePath, mode);
  }
}
