import { isJsonObject, parseJsonLossless, stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
export {
  PluginQuotaExceededError,
  PluginSchemaDowngradeWriteError,
  type FieldEnvelope,
  type PluginPutOptions,
  ensurePluginSyncRecordsTable,
  createScopedPluginSyncStore,
} from '../repository/plugin-sync-sandbox.ts';

function sorted(value: DbJson): DbJson {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isJsonObject(value)) return value;
  const result: Record<string, DbJson> = Object.create(null);
  for (const key of Object.keys(value).sort()) result[key] = sorted(value[key]!);
  return result;
}
const canonical = (value: DbJson): string => stringifyJsonLossless(sorted(value));

export interface PluginFencedBlock {
  blockId: string; pluginId: string; schemaVersion: number; recordRef: string;
  pluginVersion: string; fallbackTitle: string; fallbackMarkdown: string; inlineData?: DbJson;
}
function validateBlockHeader(blockId: string, pluginId: string, schemaVersion: number): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(blockId) || !/^[A-Za-z0-9_.-]+$/.test(pluginId)
    || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new Error('Invalid plugin block header');
}
export function encodePluginFencedBlock(block: PluginFencedBlock): string {
  const { blockId, pluginId, schemaVersion, ...data } = block;
  validateBlockHeader(blockId, pluginId, schemaVersion);
  const body: Record<string, DbJson> = { recordRef: data.recordRef, pluginVersion: data.pluginVersion,
    fallbackTitle: data.fallbackTitle, fallbackMarkdown: data.fallbackMarkdown };
  if (data.inlineData !== undefined) body.inlineData = data.inlineData;
  return `<!-- ds:block-id=${blockId} -->\n\`\`\`ds-plugin:${pluginId}:v${schemaVersion}\n${canonical(body).replace(/`/g, '\\u0060')}\n\`\`\``;
}
export function decodePluginFencedBlock(markdownBlock: string): PluginFencedBlock {
  const match = /^<!-- ds:block-id=([A-Za-z0-9_-]+) -->\r?\n```ds-plugin:([A-Za-z0-9_.-]+):v([0-9]+)\r?\n([^\r\n`]+)\r?\n```\s*$/.exec(markdownBlock);
  if (!match) throw new Error('Invalid plugin fenced block');
  const [, blockId, pluginId, version, json] = match;
  const data = parseJsonLossless(json!);
  if (!isJsonObject(data) || ['recordRef', 'pluginVersion', 'fallbackTitle', 'fallbackMarkdown'].some(key => typeof data[key] !== 'string')) {
    throw new Error('Invalid plugin block payload');
  }
  validateBlockHeader(blockId!, pluginId!, Number(version));
  return { ...data, blockId: blockId!, pluginId: pluginId!, schemaVersion: Number(version) } as unknown as PluginFencedBlock;
}
