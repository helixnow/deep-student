/**
 * PDF 框选结构化提取（公式转 LaTeX / 三线表转 Markdown）：
 * 1. 先通过既有后端 OCR 通道（`chat_v2_perform_ocr`，回退 `ocr_extract_text`）提取框选画面中的字符与符号；
 * 2. 再调用既有轻量非流式对话接口 `call_llm_for_boundary` 将 OCR 原始文本整理为可直接编译的
 *    `$$ ... $$` LaTeX 公式或标准 GitHub-Flavored Markdown 表格；
 * 3. 若当前环境未配置 LLM 整理但 OCR 成功，优雅降级返回清洗后的 OCR 结果；
 *    若本地未启用 OCR，组件层提供一键「改用多模态对话提取」兜底（将 PNG 原图连同提取指令送入主对话）。
 */

import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from '@/utils/errorUtils';

export type RegionCaptureMode = 'ask' | 'pin' | 'latex' | 'table';

export interface StructuredExtractionResult {
  content: string;
  source: 'llm' | 'ocr';
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
        } else {
          reject(new Error('Failed to encode region image'));
        }
      };
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read region image'));
      reader.readAsDataURL(blob);
    });
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const mime = blob.type || 'image/png';
  return `data:${mime};base64,${btoa(binary)}`;
}

/**
 * 剥离模型可能包裹的 ```latex / ```markdown 代码围栏，并统一公式/表格的首尾格式。
 */
export function cleanExtractedStructuredText(raw: string, mode: 'latex' | 'table'): string {
  let cleaned = raw.trim();
  if (!cleaned) return '';

  // 去掉首尾代码围栏 ```latex ... ``` / ```markdown ... ``` / ``` ... ```
  const fenceMatch = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(cleaned);
  if (fenceMatch) {
    cleaned = fenceMatch[1]!.trim();
  }

  if (mode === 'latex') {
    // 若尚无 $$ 或 \begin{...} 包裹，统一补齐 $$ 块级公式，方便直接粘贴进笔记或 Markdown
    const hasMathDelimiter =
      cleaned.startsWith('$$') ||
      cleaned.startsWith('\\[') ||
      /^\\begin\{(?:equation|align|aligned|gather|matrix|bmatrix|pmatrix|cases)\*?\}/.test(cleaned);
    if (!hasMathDelimiter) {
      const strippedInline =
        cleaned.startsWith('$') && cleaned.endsWith('$') && cleaned.length > 2
          ? cleaned.slice(1, -1).trim()
          : cleaned;
      return `$$\n${strippedInline}\n$$`;
    }
    return cleaned;
  }

  return cleaned;
}

function buildFormattingPrompt(ocrText: string, mode: 'latex' | 'table'): string {
  if (mode === 'latex') {
    return [
      'You are an academic LaTeX transcription assistant.',
      'Convert the following OCR output from a cropped PDF equation/formula region into clean, standard, compilable LaTeX wrapped in $$ ... $$.',
      'Fix common OCR confusions (e.g. broken subscripts/superscripts, Greek letters, summation/integral limits, matrices).',
      'Output ONLY the LaTeX formula block, with no commentary or markdown code fences.',
      '',
      '[OCR Output]',
      ocrText,
    ].join('\n');
  }

  return [
    'You are an academic paper table transcription assistant.',
    'Convert the following OCR output from a cropped PDF table into a clean GitHub-Flavored Markdown table (| col | ... |).',
    'Preserve all column headers, model/method names, numeric metrics, ± standard deviations, and bold/best markers accurately.',
    'Output ONLY the Markdown table, with no commentary or code fences.',
    '',
    '[OCR Output]',
    ocrText,
  ].join('\n');
}

async function performRegionOcr(dataUrl: string): Promise<string> {
  try {
    const res = await invoke<{ ocr_text?: string }>('chat_v2_perform_ocr', {
      request: { images: [dataUrl] },
    });
    if (res?.ocr_text?.trim()) {
      return res.ocr_text.trim();
    }
  } catch {
    // 回退至通用 ocr_extract_text 通道
  }

  const commaIdx = dataUrl.indexOf(',');
  const base64Payload = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const fallbackText = await invoke<string>('ocr_extract_text', {
    imagePath: null,
    imageBase64: base64Payload,
  });
  return (fallbackText ?? '').trim();
}

export async function extractStructuredFromRegion(
  blob: Blob,
  mode: 'latex' | 'table',
): Promise<StructuredExtractionResult> {
  const dataUrl = await blobToDataUrl(blob);
  let ocrText = '';
  try {
    ocrText = await performRegionOcr(dataUrl);
  } catch (err) {
    throw new Error(getErrorMessage(err));
  }

  if (!ocrText) {
    throw new Error('EMPTY_OCR_RESULT');
  }

  try {
    const llmResult = await invoke<{ assistant_message?: string }>('call_llm_for_boundary', {
      prompt: buildFormattingPrompt(ocrText, mode),
    });
    const formatted = cleanExtractedStructuredText(llmResult?.assistant_message ?? '', mode);
    if (formatted) {
      return { content: formatted, source: 'llm' };
    }
  } catch {
    // LLM 整理不可用时优雅回退为清洗后的 OCR 结果
  }

  return {
    content: cleanExtractedStructuredText(ocrText, mode),
    source: 'ocr',
  };
}
