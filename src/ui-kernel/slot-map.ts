/**
 * 槽位名 → 贡献值类型的映射（FRONTEND-PLUGINIZATION §2.3）。
 *
 * 用声明合并登记：拥有槽位的一方（框架插件、契约文件、社区插件）写
 *
 * ```ts
 * declare module '@deepstudent/ui' {        // 仓库内：declare module '@/ui-kernel/slot-map'
 *   interface SlotMap { 'dashboard.widgets': DashboardWidget }
 * }
 * ```
 *
 * 之后 `ctx.ui.contribute('dashboard.widgets', …)`、`useSlot('dashboard.widgets')`、`<SlotOutlet name=…>` 都按该类型
 * 检查与推断；形状不对的贡献在编译期失败。未登记的槽位名照常可用（值为 `unknown`），显式泛型
 * （`useSlot<T>(name)`）保留为逃生口，兼容 v1 写法。
 *
 * 官方槽位的登记在 `contracts/*.ts` 旁边，随契约一起维护。
 */

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 由声明合并填充
export interface SlotMap {}

/** 已在 SlotMap 中登记的槽位名。 */
export type SlotName = keyof SlotMap & string;

/** 槽位的贡献值类型；未登记的槽位为 `unknown`。 */
export type SlotValue<K extends string> = K extends SlotName ? SlotMap[K] : unknown;

/** 未登记的槽位名（已登记的名字在此处为 `never`，保证类型化重载不会被宽松重载兜底）。 */
export type OpenSlotName<S extends string> = S extends SlotName ? never : S;
