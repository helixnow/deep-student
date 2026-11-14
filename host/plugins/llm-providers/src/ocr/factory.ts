import type { JsonObject, OcrAdapter, OcrEngineType } from '../../api.ts';
import { DeepSeekOcrAdapter } from './deepseek.ts';
import { GenericVlmAdapter, Glm4vOcrAdapter } from './generic.ts';
import { PaddleOcrVlAdapter } from './paddle.ts';
import { SystemOcrAdapter, isPlatformSupported } from './system.ts';
import { ocrEngineTypeFromStr } from './types.ts';

/** ocr_adapters/factory.rs:16: glm-4.5v+ vision models, excluding 4.1v and older (Rust `\d` is Unicode Nd). */
const GLM_VISION_RE = /glm-(?:4\.[5-9]|4\.\p{Nd}{2,}|[5-9](?:\.\p{Nd}+)?)v/iu;

/** ocr_adapters/factory.rs:190 `OcrEngineInfo`; serialized with camelCase keys. */
export interface OcrEngineInfo {
  engine_type: OcrEngineType;
  name: string;
  description: string;
  recommended_model: string;
  supports_grounding: boolean;
  is_free: boolean;
  is_dedicated_ocr: boolean;
}

export function ocrEngineInfoToJson(info: OcrEngineInfo): JsonObject {
  return {
    engineType: info.engine_type,
    name: info.name,
    description: info.description,
    recommendedModel: info.recommended_model,
    supportsGrounding: info.supports_grounding,
    isFree: info.is_free,
    isDedicatedOcr: info.is_dedicated_ocr,
  };
}

/** ocr_adapters/factory.rs:20 `OcrAdapterFactory`. */
export class OcrAdapterFactory {
  static isSystemOcrSupported(): boolean { return isPlatformSupported(); }

  static create(engineType: OcrEngineType): OcrAdapter {
    switch (engineType) {
      case 'deepseek_ocr': return new DeepSeekOcrAdapter();
      case 'paddle_ocr_vl': return new PaddleOcrVlAdapter('paddle_ocr_vl');
      case 'paddle_ocr_vl_v1': return new PaddleOcrVlAdapter('paddle_ocr_vl_v1');
      case 'glm4v_ocr': return new Glm4vOcrAdapter();
      case 'generic_vlm': return new GenericVlmAdapter();
      case 'system_ocr': return new SystemOcrAdapter();
    }
  }

  static createFromStr(engineType: string): OcrAdapter {
    return OcrAdapterFactory.create(ocrEngineTypeFromStr(engineType));
  }

  static availableEngines(): OcrEngineType[] {
    const engines: OcrEngineType[] = ['glm4v_ocr', 'deepseek_ocr', 'paddle_ocr_vl', 'paddle_ocr_vl_v1', 'generic_vlm'];
    if (OcrAdapterFactory.isSystemOcrSupported()) engines.push('system_ocr');
    return engines;
  }

  static engineInfoList(): OcrEngineInfo[] {
    const list: OcrEngineInfo[] = [
      {
        engine_type: 'deepseek_ocr',
        name: 'DeepSeek-OCR',
        description: '专业 OCR 模型，支持 Grounding 坐标输出，适合题目集识别',
        recommended_model: 'deepseek-ai/DeepSeek-OCR',
        supports_grounding: true,
        is_free: false,
        is_dedicated_ocr: true,
      },
      {
        engine_type: 'paddle_ocr_vl',
        name: 'PaddleOCR-VL-1.5',
        description: '百度开源 OCR 视觉语言模型 1.5 版，支持 109 种语言，精度 94.5%，完全免费',
        recommended_model: 'PaddlePaddle/PaddleOCR-VL-1.5',
        supports_grounding: false,
        is_free: true,
        is_dedicated_ocr: true,
      },
      {
        engine_type: 'paddle_ocr_vl_v1',
        name: 'PaddleOCR-VL',
        description: '百度开源 OCR 视觉语言模型旧版，完全免费，作为 1.5 版的备用',
        recommended_model: 'PaddlePaddle/PaddleOCR-VL',
        supports_grounding: false,
        is_free: true,
        is_dedicated_ocr: true,
      },
      {
        engine_type: 'glm4v_ocr',
        name: 'GLM-4.6V',
        description: '智谱 106B MoE 多模态模型，支持 bbox_2d 坐标输出，题目集导入优先引擎',
        recommended_model: 'zai-org/GLM-4.6V',
        supports_grounding: true,
        is_free: false,
        is_dedicated_ocr: false,
      },
      {
        engine_type: 'generic_vlm',
        name: '通用多模态模型',
        description: '使用通用 VLM 进行 OCR，适合简单文档识别',
        recommended_model: 'Qwen/Qwen2.5-VL-7B-Instruct',
        supports_grounding: false,
        is_free: false,
        is_dedicated_ocr: false,
      },
    ];
    if (OcrAdapterFactory.isSystemOcrSupported()) {
      list.push({
        engine_type: 'system_ocr',
        name: '系统 OCR',
        description: '调用操作系统内置 OCR 引擎，免费离线，无需 API Key',
        recommended_model: 'system',
        supports_grounding: false,
        is_free: true,
        is_dedicated_ocr: true,
      });
    }
    return list;
  }

  /** ocr_adapters/factory.rs:145 `validate_model_for_engine`. */
  static validateModelForEngine(model: string, engineType: OcrEngineType): boolean {
    const modelLower = model.toLowerCase();
    switch (engineType) {
      case 'deepseek_ocr': return modelLower.includes('deepseek') && modelLower.includes('ocr');
      case 'paddle_ocr_vl':
      case 'paddle_ocr_vl_v1': return modelLower.includes('paddleocr') || modelLower.includes('paddlepaddle');
      case 'glm4v_ocr': return GLM_VISION_RE.test(model);
      case 'generic_vlm': return true;
      case 'system_ocr': return modelLower === 'system' || modelLower === '';
    }
  }

  /** ocr_adapters/factory.rs:166 `infer_engine_from_model`. */
  static inferEngineFromModel(model: string): OcrEngineType {
    const modelLower = model.toLowerCase();
    if (modelLower === 'system') return 'system_ocr';
    if (GLM_VISION_RE.test(model)) return 'glm4v_ocr';
    if (modelLower.includes('deepseek') && modelLower.includes('ocr')) return 'deepseek_ocr';
    if (modelLower.includes('paddleocr-vl-1') || modelLower.includes('paddleocr_vl_1')) return 'paddle_ocr_vl';
    if (modelLower.includes('paddle') || modelLower.includes('paddleocr')) return 'paddle_ocr_vl_v1';
    return 'generic_vlm';
  }
}
