/**
 * `resource.types` 查表入口：所有消费者只经这里读类型能力，不再写 switch。
 *
 * 未知类型（含 `all`、`folder`、`retrieval`、空串、`__proto__`、插件自有类型未注册）
 * 一律走否定结果：没有定义、没有预览、不支持任何操作。调用方需要兜底文案时自己给
 * fallback key，不把未知类型悄悄伪装成 `file`。
 */
import type { ResourceOperation, ResourceTypeDefinition } from './contracts';
import {
  OFFICIAL_RESOURCE_TYPES,
  OFFICIAL_RESOURCE_TYPE_IDS,
  OFFICIAL_RESOURCE_TYPE_UI,
  RESOURCE_TYPE_APP_ID,
  RESOURCE_TYPE_SOURCE_DB,
  type OfficialResourceType,
  type ResourceTypeUi,
} from './official';

function own<T>(record: Readonly<Record<string, T>>, key: string | null | undefined): T | undefined {
  if (typeof key !== 'string' || !key) return undefined;
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** 官方类型定义；未知类型 undefined。 */
export function getOfficialResourceTypeDefinition(
  type: string | null | undefined,
): ResourceTypeDefinition | undefined {
  return own(OFFICIAL_RESOURCE_TYPES, type);
}

/** 官方类型 UI 投影；未知类型 undefined。 */
export function getOfficialResourceTypeUi(type: string | null | undefined): ResourceTypeUi | undefined {
  return own(OFFICIAL_RESOURCE_TYPE_UI, type);
}

/** 资源类型是否支持某个操作。未知类型一律 false。 */
export function supportsResourceOperation(
  type: string | null | undefined,
  operation: ResourceOperation,
): boolean {
  return getOfficialResourceTypeDefinition(type)?.operations.includes(operation) ?? false;
}

/** 资源类型的预览面板；未知类型 undefined。 */
export function resourceTypePreview(
  type: string | null | undefined,
): ResourceTypeDefinition['preview'] | undefined {
  return getOfficialResourceTypeDefinition(type)?.preview;
}

/** 资源类型的单数名称 i18n key；未知类型返回 fallback（缺省不翻译自身）。 */
export function resourceTypeLabelKey(type: string | null | undefined, fallback = ''): string {
  return getOfficialResourceTypeDefinition(type)?.labelKey ?? fallback;
}

/** 资源类型 → workbench 应用 typeId；聚合/未知类型 null。 */
export function resourceTypeAppId(type: string | null | undefined): string | null {
  return own(RESOURCE_TYPE_APP_ID, type) ?? null;
}

/** 资源类型 → 来源数据库；未知类型 undefined。 */
export function resourceTypeSourceDb(type: string | null | undefined): string | undefined {
  return own(RESOURCE_TYPE_SOURCE_DB, type);
}

/** 资源类型 → 回收站资源组；没有回收站分组的类型 undefined。 */
export function resourceTypeTrashGroup(type: string | null | undefined): string | undefined {
  return getOfficialResourceTypeUi(type)?.trashType;
}

/** 全部官方类型 id（稳定顺序）。 */
export function listOfficialResourceTypeIds(): readonly OfficialResourceType[] {
  return OFFICIAL_RESOURCE_TYPE_IDS;
}

/** 官方类型收窄；未知类型 null。 */
export function asResourceType(type: string | null | undefined): OfficialResourceType | null {
  return own(OFFICIAL_RESOURCE_TYPES, type) ? (type as OfficialResourceType) : null;
}
