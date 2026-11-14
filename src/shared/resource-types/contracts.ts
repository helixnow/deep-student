/**
 * `resource.types` 消费契约。
 *
 * W17 `interfaces/ui-runtime.md` §4 的类型已由 `cfee05ef` 发布到
 * `src/ui-kernel/contracts/content.ts`（SlotMap 同时声明），SDK 从
 * `@deepstudent/ui` 再导出。仓库内消费者统一经本文件转出，避免两处形状漂移；
 * W17 只发布类型，不把槽位加进 `BUILTIN_SLOTS`，槽位声明与官方表由 W37 提供。
 */
export type {
  ResourceOperation,
  ResourceTypeDefinition,
} from '@/ui-kernel/contracts/content';
