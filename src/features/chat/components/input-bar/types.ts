/**
 * Chat V2 - InputBar 类型定义
 *
 * V2 架构下的输入栏类型，遵循 SSOT 原则，所有状态从 Store 获取。
 */

import type { StoreApi } from 'zustand';
import type { ChatStore } from '../../core/types/store';
import type { AttachmentMeta, PanelStates } from '../../core/types/common';
import type { ModelInfo } from '../../utils/parseModelMentions';
import type { ContextRef } from '../../resources/types';
import type { ApprovalRequestData } from '../ToolApprovalCard';
import type { BlockingInteraction } from '../../core/types/store';
import type { PdfPageRefsState } from './usePdfPageRefs';
import type { DeepSeekReasoningOption, DeepSeekReasoningOptionValue } from '@/utils/deepseekReasoningControls';
import type { ContextWindowUsage } from './contextWindowUsage';

// ============================================================================
// 模型 @mention 自动完成状态
// ============================================================================

/**
 * 模型 @mention 自动完成状态
 * 由 useModelMentions Hook 返回，传递给 InputBarUI
 */
export interface ModelMentionState {
  /** 是否显示自动完成弹窗 */
  showAutoComplete: boolean;
  /** 当前搜索查询（@后的文本） */
  query: string;
  /** 模型建议列表 */
  suggestions: ModelInfo[];
  /** 当前选中的建议索引 */
  selectedIndex: number;
  /** 已选中的模型列表（渲染为 chips） */
  selectedModels: ModelInfo[];
}

/**
 * 模型 @mention 自动完成操作
 * 由 useModelMentions Hook 返回，传递给 InputBarUI
 */
export interface ModelMentionActions {
  /** 选择建议（添加到 chip 列表，返回清理后的输入值） */
  selectSuggestion: (model: ModelInfo) => string;
  /** 移除已选中的模型 */
  removeSelectedModel: (modelId: string) => void;
  /** 设置选中索引 */
  setSelectedIndex: (index: number) => void;
  /** 向上移动选择 */
  moveSelectionUp: () => void;
  /** 向下移动选择 */
  moveSelectionDown: () => void;
  /** 确认选择（添加到 chip 列表，返回清理后的输入值，无选中项返回 null） */
  confirmSelection: () => string | null;
  /** 关闭自动完成 */
  closeAutoComplete: () => void;
  /** 更新光标位置 */
  updateCursorPosition: (position: number) => void;
  /** 移除最后一个选中的模型（用于 Backspace 删除） */
  removeLastSelectedModel: () => void;
}

// ============================================================================
// InputBarV2 Props - 入口组件接收 Store
// ============================================================================

/**
 * InputBarV2 入口组件 Props
 * 只接收 Store 引用，所有状态从 Store 订阅
 */
export interface InputBarV2Props {
  /** V2 Store 引用 */
  store: StoreApi<ChatStore>;

  /** 占位符文本 */
  placeholder?: string;

  /** 发送快捷键模式：'enter' 或 'mod-enter' */
  sendShortcut?: 'enter' | 'mod-enter';

  /** 左侧额外内容（如 Logo 等） */
  leftAccessory?: React.ReactNode;

  /** 右侧额外按钮 */
  extraButtonsRight?: React.ReactNode;

  /** 靠近发送区的稳定工具插槽 */
  inputToolSlot?: React.ReactNode;

  /** 输入栏上方的固定 inline 面板（如 todo sample） */
  composerInlinePanel?: React.ReactNode;

  /** 自定义类名 */
  className?: string;

  /** 挂载后自动聚焦输入框（移动端空会话用于唤起键盘） */
  autoFocus?: boolean;

  /** 文件上传处理回调（可选，用于外部业务层处理文件） */
  onFilesUpload?: (files: File[]) => void;

  // ========== 教材侧栏控制（可选） ==========

  /** 教材侧栏是否打开 */
  textbookOpen?: boolean;
  /** 切换教材侧栏 */
  onTextbookToggle?: () => void;

  // ========== 多变体支持（可选） ==========

  /** 可用模型列表（用于 @模型 解析，触发多变体模式） */
  availableModels?: ModelInfo[];

  /** 获取已选中的模型（chips）- 发送前调用 */
  getSelectedModels?: () => ModelInfo[];
  /** 清空已选中的模型 - 发送成功后调用 */
  clearSelectedModels?: () => void;

}

// ============================================================================
// InputBarUI Props - 纯展示组件
// ============================================================================

/**
 * InputBarUI 纯展示组件 Props
 * 只通过 props 接收数据和回调，不订阅任何 Store
 */
export interface InputBarUIProps {
  // ========== 状态 ==========

  /** 输入框内容 */
  inputValue: string;

  /** 会话状态：是否可以发送 */
  canSend: boolean;

  /** 🆕 队列模式启用（流式中可入队） */
  queueEnabled?: boolean;

  /** 🆕 队列已满（达到上限） */
  queueFull?: boolean;

  /** 🆕 是否可提交（idle 或 队列模式且未满）；默认与 canSend 一致 */
  canSubmit?: boolean;

  /** 会话状态：是否可以中断 */
  canAbort: boolean;

  /** 是否正在流式生成 */
  isStreaming: boolean;

  /** 最近一次完成回复后的上下文窗口占用 */
  contextWindowUsage?: ContextWindowUsage | null;

  /** 附件列表 */
  attachments: AttachmentMeta[];

  /** 面板状态 */
  panelStates: PanelStates;

  /** 禁用原因（可选） */
  disabledReason?: string;

  /** 🔧 会话切换 key，变化时重置内部状态（如 isReady、token 估算延迟） */
  sessionSwitchKey?: number;

  // ========== 回调 ==========

  /** 输入内容变化 */
  onInputChange: (value: string) => void;

  /** 发送消息（可能是异步） */
  onSend: () => void | Promise<void>;

  /** 中断流式（可能是异步） */
  onAbort: () => void | Promise<void>;

  /** 添加附件 */
  onAddAttachment: (attachment: AttachmentMeta) => void;

  /** 更新附件（按 ID 原地更新，避免闪烁） */
  onUpdateAttachment: (attachmentId: string, updates: Partial<AttachmentMeta>) => void;

  /** 移除附件 */
  onRemoveAttachment: (attachmentId: string) => void;

  /** 清空附件 */
  onClearAttachments: () => void;

  /** 文件上传处理 */
  onFilesUpload?: (files: File[]) => void;

  /** 设置面板状态 */
  onSetPanelState: (panel: keyof PanelStates, open: boolean) => void;

  // ========== UI 配置 ==========

  /** 占位符文本 */
  placeholder?: string;

  /** 发送快捷键模式 */
  sendShortcut?: 'enter' | 'mod-enter';

  /** 左侧额外内容 */
  leftAccessory?: React.ReactNode;

  /** 右侧额外按钮 */
  extraButtonsRight?: React.ReactNode;

  /** 靠近发送区的稳定工具插槽 */
  inputToolSlot?: React.ReactNode;

  /** 输入栏上方的固定 inline 面板（如 todo sample） */
  composerInlinePanel?: React.ReactNode;

  /** 自定义类名 */
  className?: string;

  /** 挂载后自动聚焦输入框（移动端空会话用于唤起键盘） */
  autoFocus?: boolean;

  // ========== 模式插件面板渲染 ==========

  /** 渲染 RAG 面板（模式插件提供） */
  renderRagPanel?: () => React.ReactNode;
  /** 渲染模型选择面板（模式插件提供） */
  renderModelPanel?: (options?: { hideHeader?: boolean; onClose?: () => void }) => React.ReactNode;
  /** 渲染高级设置面板（模式插件提供） */
  renderAdvancedPanel?: () => React.ReactNode;
  /** 渲染 MCP 工具面板（模式插件提供） */
  renderMcpPanel?: () => React.ReactNode;
  /** 渲染技能选择面板 */
  renderSkillPanel?: () => React.ReactNode;
  /** 打开当前对话模型面板（统一入口，承接单模型 / 对比 / 重试） */
  onOpenRuntimeModelPanel?: (mode?: 'single' | 'compare') => void;

  // ========== MCP 选中状态 ==========

  /** 是否有 MCP 服务器被选中（用于控制图标亮起） */
  mcpEnabled?: boolean;
  /** 选中的非内置 MCP 服务器数量（用于显示气泡数字） */
  selectedMcpServerCount?: number;
  /** 清除所有选中的 MCP 服务器 */
  onClearMcpServers?: () => void;

  // ========== 教材侧栏控制 ==========

  /** 教材侧栏是否打开 */
  textbookOpen?: boolean;
  /** 切换教材侧栏 */
  onTextbookToggle?: () => void;

  // ========== 模型 @mention 自动完成 ==========

  /** 模型 @mention 自动完成状态 */
  modelMentionState?: ModelMentionState;
  /** 模型 @mention 自动完成操作 */
  modelMentionActions?: ModelMentionActions;

  /** 当前 runtime 菜单中展示的生效模型摘要 */
  runtimeModelLabel?: string;
  /** 当前 runtime 菜单中展示的生效模型供应商摘要 */
  runtimeModelProviderLabel?: string;
  /** 当前 runtime 菜单中用于渲染 provider icon 的模型标识 */
  runtimeModelIconId?: string;
  /** 当前 runtime 菜单中生效模型的配置 id */
  runtimeCurrentModelId?: string | null;
  /** runtime 菜单使用的轻量模型列表 */
  runtimeModelOptions?: Array<{
    id: string;
    label: string;
    providerLabel?: string;
    iconId?: string;
  }>;
  /** runtime 菜单中直接选择单模型 */
  onSelectRuntimeModel?: (modelId: string) => void;
  // ========== 推理模式开关 ==========

  /** 是否启用推理/思维链模式 */
  enableThinking?: boolean;
  /** 当前推理状态展示文案，例如“推理: max”或“推理: 关闭” */
  thinkingStateLabel?: string;
  /** 当前生效模型是否不支持推理模式 */
  thinkingUnsupported?: boolean;
  /** 当前模型支持的运行时推理深度选项；为空且没有 runtime 模型菜单时按钮保持 toggle-only */
  thinkingDepthOptions?: DeepSeekReasoningOption[];
  /** 当前归一化后的运行时推理深度 */
  thinkingDepthValue?: DeepSeekReasoningOptionValue;
  /** 切换推理模式 */
  onToggleThinking?: () => void;
  /** 设置 Chat 运行时推理深度；只改 ChatParams，不改设置页模型默认值 */
  onSetThinkingDepth?: (value: DeepSeekReasoningOptionValue | 'off') => void;

  // ★ 2026-01 改造：Anki 工具已迁移到内置 MCP 服务器
  // enableAnkiTools 和 onToggleAnkiTools 已移除

  // ========== Skills 技能系统（多选模式） ==========

  /** 当前激活的技能 ID 列表（支持多选） */
  activeSkillIds?: string[];
  /** 是否有通过工具调用加载的技能 */
  hasLoadedSkills?: boolean;
  /** 切换技能激活状态 */
  onToggleSkill?: (skillId: string) => void;
  /** 一键清除所有激活的技能 */
  onClearAllSkills?: () => void;

  // ========== 🔧 P1-27: 上下文引用可视化 ==========

  /** 待发送的上下文引用列表 */
  pendingContextRefs?: ContextRef[];
  /** 移除单个上下文引用 */
  onRemoveContextRef?: (resourceId: string) => void;
  /** 清空所有上下文引用 */
  onClearContextRefs?: () => void;
  /** 附件上传创建 ContextRef 后回调（避免跨模块全局事件） */
  onContextRefCreated?: (payload: { contextRef: ContextRef; attachmentId: string }) => void;

  // ========== 🆕 阻塞交互请求 ==========

  /** 待处理的阻塞交互（工具审批/用户提问/工具限制） */
  pendingApprovalRequest?: BlockingInteraction | null;
  /** 会话 ID（用于审批响应） */
  sessionId?: string;

  // ========== PDF 页码引用（精准提问） ==========

  /** 当前选中的 PDF 页码引用 */
  pdfPageRefs?: PdfPageRefsState | null;
  /** 移除单个页码引用 */
  onRemovePdfPageRef?: (page: number) => void;
  /** 清空所有页码引用 */
  onClearPdfPageRefs?: () => void;

}

// ============================================================================
// useInputBarV2 返回类型
// ============================================================================

/**
 * useInputBarV2 Hook 返回类型
 */
export interface UseInputBarV2Return {
  // ========== 从 Store 订阅的状态 ==========

  /** 输入框内容 */
  inputValue: string;

  /** 是否可以发送 */
  canSend: boolean;

  /** 是否可以中断 */
  canAbort: boolean;

  /** 是否正在流式生成 */
  isStreaming: boolean;

  /** 附件列表 */
  attachments: AttachmentMeta[];

  /** 面板状态 */
  panelStates: PanelStates;

  // ========== 封装的 Actions ==========

  /** 设置输入内容 */
  setInputValue: (value: string) => void;

  /** 发送消息 */
  sendMessage: () => Promise<void>;

  /** 中断流式 */
  abortStream: () => Promise<void>;

  /** 添加附件 */
  addAttachment: (attachment: AttachmentMeta) => void;

  /** 更新附件（原地更新，避免闪烁） */
  updateAttachment: (attachmentId: string, updates: Partial<AttachmentMeta>) => void;

  /** 移除附件 */
  removeAttachment: (attachmentId: string) => void;

  /** 清空附件 */
  clearAttachments: () => void;

  /** 设置面板状态 */
  setPanelState: (panel: keyof PanelStates, open: boolean) => void;

  /** 完成流式（正常结束时调用，reason 默认 'success'） */
  completeStream: (reason?: 'success' | 'error' | 'cancelled') => void;
}

// ============================================================================
// 辅助类型
// ============================================================================

/**
 * 附件上传状态
 */
export type AttachmentUploadStatus = 'pending' | 'uploading' | 'ready' | 'error';

/**
 * 面板名称
 */
export type PanelName = keyof PanelStates;
