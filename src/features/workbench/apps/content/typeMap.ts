/**
 * 资源类型 → workbench 应用 typeId 映射（P8）
 *
 * learning-hub 的 ResourceType 与 workbench typeId 目前同名（设计文档 §9.1），
 * 但两个体系各自演化，这里维护显式映射表而不是隐式同名假设：
 * - files 窗口双击资源时用它决定 launch 哪个应用；
 * - resourceSync 用 RESOURCE_APP_TYPE_IDS 判断哪些窗口是"资源窗口"。
 */
import type { ResourceType } from '@/features/learning-hub/types';

/** 七类内容应用的 typeId（apps/content/register.ts 注册） */
export const CONTENT_APP_TYPE_IDS = [
  'note',
  'textbook',
  'exam',
  'translation',
  'essay',
  'image',
  'file',
] as const;

export type ContentAppTypeId = (typeof CONTENT_APP_TYPE_IDS)[number];

/** 思维导图应用 typeId（apps/mindmap/register.ts 注册） */
export const MINDMAP_APP_TYPE_ID = 'mindmap' as const;

/**
 * instanceKey=resourceId 的全部资源应用 typeId。
 * 资源删除联动（resourceSync）按此集合关窗。
 */
export const RESOURCE_APP_TYPE_IDS: ReadonlySet<string> = new Set([
  ...CONTENT_APP_TYPE_IDS,
  MINDMAP_APP_TYPE_ID,
]);

const RESOURCE_TYPE_TO_APP_TYPE_ID = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    note: 'note',
    textbook: 'textbook',
    exam: 'exam',
    translation: 'translation',
    essay: 'essay',
    image: 'image',
    file: 'file',
    mindmap: MINDMAP_APP_TYPE_ID,
  } satisfies Partial<Record<ResourceType, string>>),
);

/**
 * learning-hub ResourceType → workbench typeId。
 * 不可开窗的类型（'all' 等聚合视图）返回 null。
 */
export function resourceTypeToAppTypeId(type: ResourceType | string): string | null {
  if (typeof type !== 'string' || !type) return null;
  return RESOURCE_TYPE_TO_APP_TYPE_ID[type] ?? null;
}
