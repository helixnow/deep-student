/**
 * ASR model detection helpers. The implementation lives in `asr.ts`; this
 * module stays as the import point used by `service.ts`.
 */
export {
  stripGatewayPrefix, isAsrModelName, isAsrModel, asrProviderSupported, asrProtocolForModel,
} from './asr.ts';
