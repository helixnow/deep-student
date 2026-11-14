import { OcrAdapterFactory, ocrEngineInfoToJson, type OcrEngineInfo } from './factory.ts';
import type { OcrAdapter, OcrEngineType } from '../../api.ts';

/**
 * ocr_adapters/factory.rs `OcrAdapterFactory` exposed as a Cordis service so
 * other lanes (media/docs, qbank) can obtain adapters without importing
 * implementation files directly.
 */
export class OcrAdapterService {
  readonly version = 1 as const;

  createAdapter(engine: OcrEngineType): OcrAdapter { return OcrAdapterFactory.create(engine); }

  createAdapterFromStr(engine: string): OcrAdapter { return OcrAdapterFactory.createFromStr(engine); }

  availableEngines(): OcrEngineType[] { return OcrAdapterFactory.availableEngines(); }

  engineInfoList(): OcrEngineInfo[] { return OcrAdapterFactory.engineInfoList(); }

  engineInfoToJson(info: OcrEngineInfo): ReturnType<typeof ocrEngineInfoToJson> {
    return ocrEngineInfoToJson(info);
  }
}
