/** Value-only path for tool_args.rs::ensure_localized_error. Public input/output
 * remain strings; raw JSON numbers must not pass through JS number in between.
 */
import { objectLastWins, parseJsonDocument, stringifyJsonValue, type JsonNode } from '../util/portable.ts';

const string = (value: string): JsonNode => ({ kind: 'string', value });
const object = (entries: Iterable<readonly [string, JsonNode]>): JsonNode => ({
  kind: 'object', members: Array.from(entries, ([key, value]) => ({ key, value })),
});

export function localizedErrorJson(raw: string, defaultCode: string, messageKey: string, zh: string, en: string): string {
  let parsed: JsonNode | null;
  try { parsed = parseJsonDocument(raw); } catch { parsed = null; }
  const legacy = parsed?.kind === 'object';
  const payload = parsed?.kind === 'object' ? objectLastWins(parsed) : new Map<string, JsonNode>();
  if (!payload.has('code')) payload.set('code', string(defaultCode));
  if (!legacy) {
    const chars = [...raw];
    payload.set('detail', string(chars.slice(0, 2000).join('')));
    payload.set('detailTruncated', { kind: 'bool', value: chars.length > 2000 });
  }
  if (!payload.has('retryable')) payload.set('retryable', { kind: 'bool', value: false });
  const code = payload.get('code')!;
  const params = payload.get('messageParams');
  if (payload.get('messageKey')?.kind === 'string' && params?.kind === 'object'
      && payload.get('messageFallback')?.kind === 'object' && payload.get('message')?.kind === 'string') {
    const fields = objectLastWins(params);
    fields.set('code', code);
    payload.set('messageParams', object(fields));
  } else {
    payload.set('messageKey', string(messageKey));
    payload.set('messageParams', object([['code', code]]));
    payload.set('messageFallback', object([['zh-CN', string(zh)], ['en-US', string(en)]]));
    payload.set('message', string(`${zh} / ${en}`));
  }
  return stringifyJsonValue(object(payload));
}
