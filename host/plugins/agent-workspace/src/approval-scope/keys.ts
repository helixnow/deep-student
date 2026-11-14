/** 审批作用域的内存键和持久化键。 */
import type { JsonValue } from '../../api.ts';
import { sha256Hex } from '../runtime-path-values.ts';
import { jsonToString } from './core.ts';
import { extractScopeIdentity } from './scope.ts';

export function makeRuntimeScopeKeyV2(toolName: string, args: JsonValue): string | null {
  const identity = extractScopeIdentity(toolName, args);
  return identity === null ? null : `${identity[0]}::${identity[1]}`;
}

export function makeRuntimeScopeKeyV1(toolName: string, args: JsonValue): string {
  return `${toolName}::${jsonToString(args)}`;
}

export function makeSettingKeyV2(toolName: string, args: JsonValue): string | null {
  const identity = extractScopeIdentity(toolName, args);
  if (identity === null) return null;
  return `tool_approval.scope.${identity[0]}.${sha256Hex(identity[1])}`;
}

export function makeSettingKeyV1(toolName: string, args: JsonValue): string {
  return `tool_approval.scope.${toolName}.${sha256Hex(jsonToString(args))}`;
}

export function makeRuntimeScopeKey(toolName: string, args: JsonValue): string {
  return makeRuntimeScopeKeyV2(toolName, args) ?? makeRuntimeScopeKeyV1(toolName, args);
}

export function makeSettingKey(toolName: string, args: JsonValue): string {
  return makeSettingKeyV2(toolName, args) ?? makeSettingKeyV1(toolName, args);
}
