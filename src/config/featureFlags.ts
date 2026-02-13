/**
 * 功能开关（Feature Flags）
 *
 * 清理说明（2026-01）：
 * - 错题库/桥接/数学工作流等旧实现已彻底清理
 * - 知识图谱和记忆内化工作流为新实现，保留
 */

// =============================================================================
// 聊天宿主重构 Feature Flags
// =============================================================================

/**
 * 聊天宿主重构进度记录
 *
 * 记录各模块的拆分/重构完成状态。
 * 当前阶段：新版 ChatHost 已完成完整实现，与旧版功能等价。
 *
 * @see note/聊天组件拆分方案.md
 */
export const CHAT_HOST_FLAGS = {
  // Phase 1: 虚拟滚动（任务 A）- 已完成
  enableVirtualScroll: true,

  // Phase 2: UI Store 外置（任务 B）- 已完成
  useUIStore: true,

  // Phase 3: Hooks 提取（任务 C/D）- 已完成
  useNewMessageStream: true,
  useNewAutoSave: true,
  useNewChatRuntime: true,  // CompatRuntime 已集成
  useNewAnkiMode: true,     // ✅ Anki 模式已集成

  // Phase 4: 组件拆分 - 已完成
  useNewMessageList: true,
  useNewChatInput: true,    // 任务 E - 已完成
  useNewChatHeader: true,   // 已内置

  // Phase 5: 完整功能集成 - 已完成
  useNewAttachments: true,    // ✅ 附件处理已集成
  useNewLearnMode: true,      // ✅ 学习模式已集成
  useNewUserPreferences: true, // ✅ 用户偏好已集成
  useNewMessageOperations: true, // ✅ 消息操作（删除/重试/编辑）已集成

  // 新版 ChatHost 完整替换 - 已启用
  useNewChatHost: true,
} as const;

/**
 * 聊天宿主 Feature Flag 类型
 */
export type ChatHostFlagKey = keyof typeof CHAT_HOST_FLAGS;

/**
 * 检查聊天宿主 Feature Flag 是否启用
 * @param flag - Flag 名称
 * @returns 是否启用
 */
export function isChatHostFlagEnabled(flag: ChatHostFlagKey): boolean {
  return CHAT_HOST_FLAGS[flag];
}

// =============================================================================
// 多变体聊天 Feature Flags
// =============================================================================

/**
 * 多变体聊天功能开关
 * 
 * 用于控制多模型选择和并行变体视图的显示。
 * 设置为 false 时，即使消息有多个变体，也只显示激活变体的内容（降级为单变体展示）。
 */
export const MULTI_VARIANT_FLAGS = {
  /**
   * 是否显示多模型选择 UI（chips 模式）
   * - true: 允许用户在输入栏选择多个模型，启用并行变体生成
   * - false: 隐藏多模型选择 UI，使用单模型模式
   */
  enableMultiModelSelect: true,

  /**
   * 是否显示并行变体视图
   * - true: 多变体消息以并排卡片形式展示，允许用户切换/对比
   * - false: 即使消息有多个变体，也只展示激活变体（降级展示）
   */
  enableParallelVariantView: true,
} as const;

/**
 * 多变体 Feature Flag 类型
 */
export type MultiVariantFlagKey = keyof typeof MULTI_VARIANT_FLAGS;

/**
 * 检查多变体 Feature Flag 是否启用
 * @param flag - Flag 名称
 * @returns 是否启用
 */
export function isMultiVariantFlagEnabled(flag: MultiVariantFlagKey): boolean {
  return MULTI_VARIANT_FLAGS[flag];
}

/**
 * 检查多模型选择是否启用
 * @returns 是否启用多模型选择 UI
 */
export function isMultiModelSelectEnabled(): boolean {
  return MULTI_VARIANT_FLAGS.enableMultiModelSelect;
}

/**
 * 检查并行变体视图是否启用
 * @returns 是否启用并行变体视图
 */
export function isParallelVariantViewEnabled(): boolean {
  return MULTI_VARIANT_FLAGS.enableParallelVariantView;
}
