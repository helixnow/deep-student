/** Chat V2 run-scoped 流事件身份解析（model2_pipeline.rs chat_v2_* helpers）。 */
export const CHAT_V2_STREAM_GENERATION_MARKER = '__stream_generation__';

export interface ChatV2StreamIdentity {
  sessionId: string;
  variantId: string | null;
  runId: string | null;
}

function generationValue(raw: string): number | bigint | null {
  if (!/^\+?\d+$/.test(raw)) return null;
  const value = BigInt(raw);
  if (value > 0xffff_ffff_ffff_ffffn) return null;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

/** 会话与代际：`chat_v2_event_{session}[_var_...][__stream_generation__N]`。 */
export function chatV2SessionScopeAndGeneration(
  streamEvent: string,
): [string, number | bigint | null] | null {
  const prefix = 'chat_v2_event_';
  if (!streamEvent.startsWith(prefix)) return null;
  const rawScope = streamEvent.slice(prefix.length);
  let scope = rawScope;
  let generation: number | bigint | null = null;
  const markerIndex = rawScope.lastIndexOf(CHAT_V2_STREAM_GENERATION_MARKER);
  if (markerIndex >= 0) {
    const rawGeneration = rawScope.slice(markerIndex + CHAT_V2_STREAM_GENERATION_MARKER.length);
    generation = generationValue(rawGeneration);
    if (generation === null) return null;
    scope = rawScope.slice(0, markerIndex);
  }
  const variantIndex = scope.lastIndexOf('_var_');
  const sessionId = variantIndex >= 0 ? scope.slice(0, variantIndex) : scope;
  return [sessionId, generation];
}

/** 遥测身份三元组；代际后缀不入身份。 */
export function chatV2StreamIdentity(streamEvent: string): ChatV2StreamIdentity | null {
  const prefix = 'chat_v2_event_';
  if (!streamEvent.startsWith(prefix)) return null;
  const rawScope = streamEvent.slice(prefix.length);
  let scope = rawScope;
  const markerIndex = rawScope.lastIndexOf(CHAT_V2_STREAM_GENERATION_MARKER);
  if (markerIndex >= 0) {
    const rawGeneration = rawScope.slice(markerIndex + CHAT_V2_STREAM_GENERATION_MARKER.length);
    if (generationValue(rawGeneration) === null) return null;
    scope = rawScope.slice(0, markerIndex);
  }
  const variantIndex = scope.lastIndexOf('_var_');
  if (variantIndex < 0) {
    return { sessionId: scope, variantId: null, runId: null };
  }
  const sessionId = scope.slice(0, variantIndex);
  const variantAndRun = scope.slice(variantIndex + '_var_'.length);
  const runIndex = variantAndRun.lastIndexOf('_run_');
  if (runIndex < 0) {
    return { sessionId, variantId: variantAndRun, runId: null };
  }
  return {
    sessionId,
    variantId: variantAndRun.slice(0, runIndex),
    runId: variantAndRun.slice(runIndex + '_run_'.length),
  };
}
