/**
 * React 消费入口：有 UI 内核时优先读 `resource.types` 槽位，没有 Provider（轻量窗口）
 * 或槽位未声明时回落到官方表。社区类型因此可以按 key 覆盖/新增，而官方表仍是首帧兜底。
 */
import { useMemo } from 'react';
import { useOptionalSlot } from '@/ui-kernel/react';
import type { ResourceOperation, ResourceTypeDefinition } from './contracts';
import {
  getOfficialResourceTypeDefinition,
  getOfficialResourceTypeUi,
  supportsResourceOperation,
} from './lookup';
import type { ResourceTypeUi } from './official';

function definitionFromSlot(
  entries: readonly { key?: string; value: ResourceTypeDefinition }[] | undefined,
  type: string,
): ResourceTypeDefinition | undefined {
  if (!entries) return undefined;
  return entries.find((entry) => (entry.key ?? entry.value.type) === type)?.value;
}

/** 某个资源类型的定义：槽位优先，官方表兜底；未知类型 undefined。 */
export function useResourceTypeDefinition(type: string): ResourceTypeDefinition | undefined {
  const entries = useOptionalSlot('resource.types');
  return useMemo(
    () => definitionFromSlot(entries, type) ?? getOfficialResourceTypeDefinition(type),
    [entries, type],
  );
}

/** 某个资源类型是否支持某操作。 */
export function useSupportsResourceOperation(type: string, operation: ResourceOperation): boolean {
  const definition = useResourceTypeDefinition(type);
  return definition ? definition.operations.includes(operation) : supportsResourceOperation(type, operation);
}

/** 某个资源类型的消费者 UI 投影；社区自定义类型没有投影时返回 undefined。 */
export function useResourceTypeUi(type: string): ResourceTypeUi | undefined {
  return useMemo(() => getOfficialResourceTypeUi(type), [type]);
}
