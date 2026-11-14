/** 作用域字段规范化和执行参数指纹。 */
import type { JsonValue } from '../../api.ts';
import { rustTrim } from '../../../../platform/util/index.ts';
import { asJsonObject, cloneJson, compareUtf8, extractStrField, jsonField, jsonPresent,
  jsonStringField, jsonToString, rawHash, ROOT_BINDING_FIELD, sortedStrings,
  type JsonObject } from './core.ts';
import { isLocalShellExecuteTool } from './classification.ts';
import { normalizedShellExecutionControls, normalizedShellRuntimeLocation,
  platformSandboxContract, shellEnvPlanHash, shellSkillRootId } from './env.ts';
import { analyzeShellCommand, commandPrefix } from './shell-analysis.ts';

export function extractSortedStringArray(args: JsonValue, fieldName: string): string | null {
  const value = jsonField(args, fieldName);
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return null;
  const normalized = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const trimmed = rustTrim(item);
    if (trimmed === '') return null;
    normalized.add(trimmed);
  }
  return JSON.stringify(sortedStrings(normalized));
}

export function extractGenericScopeIdentity(args: JsonValue): string | null {
  const pathField = extractStrField(args, ['path', 'file_path', 'filepath', 'targetPath', 'target_path']);
  if (pathField !== null) return pathField;
  const idField = extractStrField(args, [
    'noteId', 'note_id', 'canvasNoteId', 'mindmapId', 'mindmap_id', 'qbankId', 'qbank_id',
    'memoryId', 'memory_id', 'resourceId', 'resource_id', 'fileId', 'file_id', 'docxId',
    'docx_id', 'xlsxId', 'xlsx_id', 'pptxId', 'pptx_id',
  ]);
  if (idField !== null) return idField;
  const command = jsonStringField(args, 'command');
  return command === null ? null : commandPrefix(command);
}

export function canonicalScopeValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(item => canonicalScopeValue(item));
  const object = asJsonObject(value);
  if (object === null) return value;
  const canonical: JsonObject = {};
  for (const key of Object.keys(object).sort(compareUtf8)) {
    canonical[key] = canonicalScopeValue(object[key]!);
  }
  return canonical;
}

export function filteredArgsFingerprint(args: JsonValue, excludedFields: readonly string[]): string | null {
  const filtered = cloneJson(args);
  const object = asJsonObject(filtered);
  if (object !== null) for (const field of excludedFields) delete object[field];
  return `args:${rawHash(jsonToString(canonicalScopeValue(filtered)))}`;
}

export function shellScopeFingerprint(toolName: string, args: JsonValue): string | null {
  const command = jsonStringField(args, 'command');
  if (command === null) return null;
  const analysis = analyzeShellCommand(command);
  if (!isLocalShellExecuteTool(toolName, args)) {
    return `uncontrolled=${rawHash(jsonToString(canonicalScopeValue(args)))}`;
  }
  const [rootId, cwd] = normalizedShellRuntimeLocation(args);
  const allowNetwork = jsonPresent(args, ['allow_network', 'allowNetwork']);
  const networkAllowed = typeof allowNetwork === 'boolean' ? allowNetwork : false;
  const skillRootId = shellSkillRootId(args) ?? '-';
  const rootBinding = extractStrField(args, [ROOT_BINDING_FIELD]) ?? 'unbound';
  const [timeoutMs, maxOutputBytes, trackFileChanges] = normalizedShellExecutionControls(args);
  const sandbox = platformSandboxContract();
  const envPlanHash = shellEnvPlanHash(args);
  if (envPlanHash === null) return null;
  return `root=${rootId};binding=${rootBinding};cwd=${cwd};net=${networkAllowed};skill=${skillRootId};env=${envPlanHash};sandbox=${sandbox.backend};shell=${sandbox.shellKind};encoding=${sandbox.outputEncoding};timeout=${timeoutMs};maxout=${maxOutputBytes};track=${trackFileChanges};cmd=${rawHash(analysis.trimmed)}`;
}
