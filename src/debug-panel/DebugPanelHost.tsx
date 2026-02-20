import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
// ★ 图谱模块已废弃 - IrecAutoNotePlugin 已移除
// import IrecAutoNotePlugin from './plugins/IrecAutoNotePlugin';
// ★ ExamSheetWorkbench 已废弃（2026-02 清理）- ExamSheetLifecyclePlugin 已移除
// import ExamSheetLifecyclePlugin from './plugins/ExamSheetLifecyclePlugin';
import DeepSeekOcrDebugPlugin from './plugins/DeepSeekOcrDebugPlugin';
import WebSearchDebugPlugin from './plugins/WebSearchDebugPlugin';
import UnifiedDragDropDebugPlugin from './plugins/UnifiedDragDropDebugPlugin';
import AnkiGenerationDebugPlugin from './plugins/AnkiGenerationDebugPlugin';
import McpDebugPlugin from './plugins/McpDebugPlugin';
import ImageAttachmentInspectorPlugin from './plugins/ImageAttachmentInspectorPlugin';
import ImagePreviewDebugPlugin from './plugins/ImagePreviewDebugPlugin';
// ★ ExamSheetToAnalysisBridgeMonitor 已废弃（2026-01 清理）
// ★ ExamSheetWorkbench 已废弃（2026-02 清理）- 以下插件已移除：
// import { ExamSheetWorkbenchRenderMonitor } from './plugins/ExamSheetWorkbenchRenderMonitor';
// import { ExamSheetCollapseDebugPlugin } from './plugins/ExamSheetCollapseDebugPlugin';
// ★ 图谱模块已废弃 - GraphRagDebugPlugin 已移除
// import GraphRagDebugPlugin from './plugins/GraphRagDebugPlugin';
import LayoutDebugPlugin from './plugins/LayoutDebugPlugin';
import FloatingPanelDebugPlugin from './plugins/FloatingPanelDebugPlugin';
// ★ 图谱模块已废弃 - GraphEdgeDebugPlugin 已移除
// import GraphEdgeDebugPlugin from './plugins/GraphEdgeDebugPlugin';
import NotesTypographyDebugPlugin from './plugins/NotesTypographyDebugPlugin';
import NotesOutlineDebugPlugin from './plugins/NotesOutlineDebugPlugin';
import CrepeEditorDebugPlugin from './plugins/CrepeEditorDebugPlugin';
import CrepeDragDropDebugPlugin from './plugins/CrepeDragDropDebugPlugin';
import ScrollAreaDebugPlugin from './plugins/ScrollAreaDebugPlugin';
import CrepeImageUploadDebugPlugin from './plugins/CrepeImageUploadDebugPlugin';
import EssayGradingTooltipDebugPlugin from './plugins/EssayGradingTooltipDebugPlugin';
import { DEBUG_PANEL_PLUGIN_IDS } from '../config/debugPanel';
import SessionLoadFlowDebugPlugin from './plugins/SessionLoadFlowDebugPlugin';
import SessionSwitchPerfDebugPlugin from './plugins/SessionSwitchPerfDebugPlugin';
import ChatV2ImagePreviewDebugPlugin from './plugins/ChatV2ImagePreviewDebugPlugin';
import MultiVariantDebugPlugin from './plugins/MultiVariantDebugPlugin';
import MultiAgentDebugPlugin from './plugins/MultiAgentDebugPlugin';
import SubagentTestPlugin from './plugins/SubagentTestPlugin';
import SubagentMessageFlowDebugPlugin from './plugins/SubagentMessageFlowDebugPlugin';
import ThinkingBlockDebugPlugin from './plugins/ThinkingBlockDebugPlugin';
import { debugMasterSwitch } from './debugMasterSwitch';
import DstuDebugPlugin from './plugins/DstuDebugPlugin';
import AttachmentInjectionDebugPlugin from './plugins/AttachmentInjectionDebugPlugin';
import AttachmentOcrRequestAuditPlugin from './plugins/AttachmentOcrRequestAuditPlugin';
import MediaProcessingDebugPlugin from './plugins/MediaProcessingDebugPlugin';
// ★ 多模态索引已禁用，暂时隐藏调试插件入口。恢复时取消注释即可。
// import PdfMultimodalDebugPlugin from './plugins/PdfMultimodalDebugPlugin';
import FinderDragDropDebugPlugin from './plugins/FinderDragDropDebugPlugin';
import SelectionBoxDebugPlugin from './plugins/SelectionBoxDebugPlugin';
// ★ 图谱模块已废弃 - GraphSidebarDebugPlugin 已移除
// import GraphSidebarDebugPlugin from './plugins/GraphSidebarDebugPlugin';
import PageLifecycleDebugPlugin from './plugins/PageLifecycleDebugPlugin';
import EditRetryDebugPlugin from './plugins/EditRetryDebugPlugin';
import ChatAnkiWorkflowDebugPlugin from './plugins/ChatAnkiWorkflowDebugPlugin';
import TemplateDesignerWorkflowDebugPlugin from './plugins/TemplateDesignerWorkflowDebugPlugin';
import MindMapBlurHoverDebugPlugin from './plugins/MindMapBlurHoverDebugPlugin';
import AttachmentPipelineTestPlugin from './plugins/AttachmentPipelineTestPlugin';
import ChatInteractionTestPlugin from './plugins/ChatInteractionTestPlugin';
import CitationTestPlugin from './plugins/CitationTestPlugin';
import MultiVariantTestPlugin from './plugins/MultiVariantTestPlugin';
import WorkspaceOrchestrationTestPlugin from './plugins/WorkspaceOrchestrationTestPlugin';
import ToolCallLifecycleDebugPlugin from './plugins/ToolCallLifecycleDebugPlugin';
import ExamSheetProcessingDebugPlugin from './plugins/ExamSheetProcessingDebugPlugin';

export interface DebugPanelHostProps {
  visible: boolean;
  onClose: () => void;
  currentStreamId?: string;
}

export interface DebugPanelPluginProps extends DebugPanelHostProps {
  isActive: boolean;
  isActivated: boolean;
}

const HOME_PLUGIN_ID = 'home';

type PluginGroup = {
  id: string;
  labelKey: string;
  descriptionKey: string;
};

type DebugPanelPluginEntry = {
  id: string;
  labelKey: string;
  descriptionKey: string;
  Component: React.ComponentType<DebugPanelPluginProps>;
  labelDefault?: string;
  descriptionDefault?: string;
  groupId: PluginGroup['id'];
};

const PLUGIN_GROUPS: PluginGroup[] = [
  {
    id: 'chat-timeline',
    labelKey: 'debug_panel.group.chat_timeline.title',
    descriptionKey: 'debug_panel.group.chat_timeline.desc',
  },
  {
    id: 'exam-workflow',
    labelKey: 'debug_panel.group.exam_workflow.title',
    descriptionKey: 'debug_panel.group.exam_workflow.desc',
  },
  {
    id: 'cards-template',
    labelKey: 'debug_panel.group.cards_template.title',
    descriptionKey: 'debug_panel.group.cards_template.desc',
  },
  {
    id: 'graph-research',
    labelKey: 'debug_panel.group.graph_research.title',
    descriptionKey: 'debug_panel.group.graph_research.desc',
  },
  {
    id: 'input-pipeline',
    labelKey: 'debug_panel.group.input_pipeline.title',
    descriptionKey: 'debug_panel.group.input_pipeline.desc',
  },
  {
    id: 'notes-editor',
    labelKey: 'debug_panel.group.notes_editor.title',
    descriptionKey: 'debug_panel.group.notes_editor.desc',
  },
  {
    id: 'infra-quality',
    labelKey: 'debug_panel.group.infra_quality.title',
    descriptionKey: 'debug_panel.group.infra_quality.desc',
  },
];

const PLUGINS: DebugPanelPluginEntry[] = [
  // ★ 图谱模块已废弃 - irec-auto-note 和 graph-sidebar-debug 插件已移除
  {
    id: 'session-load-flow',
    labelKey: 'debug_panel.plugin_session_load_flow',
    descriptionKey: 'debug_panel.plugin_session_load_flow_desc',
    Component: SessionLoadFlowDebugPlugin,
    labelDefault: '会话加载流程',
    descriptionDefault: '追踪从分析库点击会话到聊天历史显示的完整数据流，诊断会话加载问题。',
    groupId: 'infra-quality',
  },
  {
    id: 'session-switch-perf',
    labelKey: 'debug_panel.plugin_session_load_perf',
    descriptionKey: 'debug_panel.plugin_session_load_perf_desc',
    Component: SessionSwitchPerfDebugPlugin,
    labelDefault: '会话加载性能监控',
    descriptionDefault: '监控会话新建/加载各阶段耗时，定位性能瓶颈，优化加载效率。支持时间线可视化和瓶颈自动检测。',
    groupId: 'infra-quality',
  },
  {
    id: 'multi-variant-debug',
    labelKey: 'debug_panel.plugin_multi_variant',
    descriptionKey: 'debug_panel.plugin_multi_variant_desc',
    Component: MultiVariantDebugPlugin,
    labelDefault: '多变体并行调试',
    descriptionDefault: '追踪 @模型 选择到后端并行执行的完整数据流，诊断多变体模式触发问题。',
    groupId: 'chat-timeline',
  },
  {
    id: 'multi-agent-debug',
    labelKey: 'debug_panel.plugin_multi_agent',
    descriptionKey: 'debug_panel.plugin_multi_agent_desc',
    Component: MultiAgentDebugPlugin,
    labelDefault: '多 Agent 调试',
    descriptionDefault: '监控多 Agent 工作区状态、Agent 列表和消息流，支持预设 Prompt 一键启动调试，可复制完整运行日志。',
    groupId: 'chat-timeline',
  },
  {
    id: 'subagent-test',
    labelKey: 'debug_panel.plugin_subagent_test',
    descriptionKey: 'debug_panel.plugin_subagent_test_desc',
    Component: SubagentTestPlugin,
    labelDefault: '子代理自动测试',
    descriptionDefault: '一键启动子代理自动测试，实时记录 UI 渲染情况、用户交互和生命周期事件，生成测试报告。',
    groupId: 'chat-timeline',
  },
  {
    id: 'subagent-message-flow-debug',
    labelKey: 'debug_panel.plugin_subagent_message_flow',
    descriptionKey: 'debug_panel.plugin_subagent_message_flow_desc',
    Component: SubagentMessageFlowDebugPlugin,
    labelDefault: '子代理消息流调试',
    descriptionDefault: '诊断子代理嵌入视图中助手消息不显示的问题，全链路打点追踪 Adapter 创建、storeApi 状态、stream_start 事件处理。',
    groupId: 'chat-timeline',
  },
  {
    id: 'workspace-orchestration-test',
    labelKey: 'debug_panel.plugin_workspace_orchestration_test',
    descriptionKey: 'debug_panel.plugin_workspace_orchestration_test_desc',
    Component: WorkspaceOrchestrationTestPlugin,
    labelDefault: '多 Agent 编排自动测试',
    descriptionDefault: '场景化自动测试多 Agent / 子代理工作区：真实 sendMessage 触发编排，捕获 workspace 事件、tool_call、Store 快照与持久化一致性，生成可下载报告。',
    groupId: 'chat-timeline',
  },
  {
    id: 'thinking-block-debug',
    labelKey: 'debug_panel.plugin_thinking_block',
    descriptionKey: 'debug_panel.plugin_thinking_block_desc',
    Component: ThinkingBlockDebugPlugin,
    labelDefault: 'Thinking 块调试',
    descriptionDefault: '监听 thinking 块流式生成和数据库保存流程，诊断刷新后 thinking 丢失问题。',
    groupId: 'chat-timeline',
  },
  {
    id: 'attachment-injection-debug',
    labelKey: 'debug_panel.plugin_attachment_injection',
    descriptionKey: 'debug_panel.plugin_attachment_injection_desc',
    Component: AttachmentInjectionDebugPlugin,
    labelDefault: '附件注入调试',
    descriptionDefault: '追踪附件上传到消息发送的完整数据流，包括 VFS 上传、资源创建、引用解析、内容格式化等关键阶段。',
    groupId: 'chat-timeline',
  },
  {
    id: 'attachment-ocr-request-audit',
    labelKey: 'debug_panel.plugin_attachment_ocr_request_audit',
    descriptionKey: 'debug_panel.plugin_attachment_ocr_request_audit_desc',
    Component: AttachmentOcrRequestAuditPlugin,
    labelDefault: '附件/OCR 请求体审计',
    descriptionDefault: '监听 PDF/图片上传、OCR 流水线、注入模式选择，以及前端构造和后端接收的请求体摘要，校验多模态/文本模型是否收到预期内容。',
    groupId: 'chat-timeline',
  },
  // ★ 多模态索引已禁用，暂时隐藏 PDF 多模态调试插件。恢复时取消注释即可。
  // {
  //   id: 'pdf-multimodal-debug',
  //   labelKey: 'debug_panel.plugin_pdf_multimodal',
  //   descriptionKey: 'debug_panel.plugin_pdf_multimodal_desc',
  //   Component: PdfMultimodalDebugPlugin,
  //   labelDefault: 'PDF 多模态调试',
  //   descriptionDefault: '专门调试 PDF 图片模式注入问题，追踪 isMultimodal、includeImage、multimodalBlocks 等关键状态。',
  //   groupId: 'chat-timeline',
  // },
  {
    id: 'media-processing-debug',
    labelKey: 'debug_panel.plugin_media_processing',
    descriptionKey: 'debug_panel.plugin_media_processing_desc',
    Component: MediaProcessingDebugPlugin,
    labelDefault: '媒体预处理调试',
    descriptionDefault: '追踪 PDF/图片附件预处理的完整生命周期，包括文本提取、页面渲染、图片压缩、OCR 处理、向量索引等阶段。实时监控后端事件和 Store 状态。',
    groupId: 'chat-timeline',
  },
  {
    id: 'edit-retry-debug',
    labelKey: 'debug_panel.plugin_edit_retry',
    descriptionKey: 'debug_panel.plugin_edit_retry_desc',
    Component: EditRetryDebugPlugin,
    labelDefault: '编辑/重试调试',
    descriptionDefault: '追踪编辑重发和重试的完整流程，诊断编辑无响应、重试未清空后续消息等问题。',
    groupId: 'chat-timeline',
  },
  // ★ exam-sheet-lifecycle 插件已废弃（ExamSheetWorkbench 组件已移除，2026-02 清理）
  {
    id: 'deepseek-ocr-debug',
    labelKey: 'debug_panel.plugin_deepseek_ocr',
    descriptionKey: 'debug_panel.plugin_deepseek_ocr_desc',
    Component: DeepSeekOcrDebugPlugin,
    labelDefault: 'DeepSeek-OCR 调试',
    descriptionDefault: '细粒度监控 DeepSeek-OCR 识别全流程：请求构建、模型响应、Grounding 解析、坐标转换、最终结果。支持按阶段和日志级别过滤，可复制完整日志。',
    groupId: 'input-pipeline',
  },
  {
    id: 'web-search-debug',
    labelKey: 'debug_panel.plugin_web_search',
    descriptionKey: 'debug_panel.plugin_web_search_desc',
    Component: WebSearchDebugPlugin,
    labelDefault: '外部搜索调试',
    descriptionDefault: '监听外部搜索开启、调用、上下文注入和来源信息，捕获搜索流程全链路日志。',
    groupId: 'input-pipeline',
  },
  {
    id: 'unified-drag-drop',
    labelKey: 'debug_panel.plugin_unified_drag_drop',
    descriptionKey: 'debug_panel.plugin_unified_drag_drop_desc',
    Component: UnifiedDragDropDebugPlugin,
    labelDefault: '统一拖拽调试',
    descriptionDefault: '全面监控所有拖拽上传区域的细粒度日志，包括拖拽事件、文件验证、转换处理、回调执行等全流程。',
    groupId: 'input-pipeline',
  },
  {
    id: 'finder-drag-drop',
    labelKey: 'debug_panel.plugin_finder_drag_drop',
    descriptionKey: 'debug_panel.plugin_finder_drag_drop_desc',
    Component: FinderDragDropDebugPlugin,
    labelDefault: 'Finder 拖放调试',
    descriptionDefault: '监听 Learning Hub 文件管理器的 dnd-kit 拖放事件，调试文件移动到文件夹功能。',
    groupId: 'input-pipeline',
  },
  {
    id: 'selection-box-debug',
    labelKey: 'debug_panel.plugin_selection_box',
    descriptionKey: 'debug_panel.plugin_selection_box_desc',
    Component: SelectionBoxDebugPlugin,
    labelDefault: '框选调试',
    descriptionDefault: '监听 Learning Hub 框选功能，记录光标位置与框选框端点的偏移量，用于调试框选位置问题。',
    groupId: 'input-pipeline',
  },
  {
    id: 'anki-generation-debug',
    labelKey: 'debug_panel.plugin_anki_generation',
    descriptionKey: 'debug_panel.plugin_anki_generation_desc',
    Component: AnkiGenerationDebugPlugin,
    labelDefault: 'Anki 制卡日志',
    descriptionDefault: '集中查看制卡流程的关键埋点、事件、异常与导出状态，支持关键字过滤与级别筛选。',
    groupId: 'cards-template',
  },
  {
    id: 'chatanki-workflow-debug',
    labelKey: 'debug_panel.plugin_chatanki_workflow',
    descriptionKey: 'debug_panel.plugin_chatanki_workflow_desc',
    Component: ChatAnkiWorkflowDebugPlugin,
    labelDefault: 'ChatAnki 全链路调试',
    descriptionDefault: '监控 chatanki_run/wait/status 工具调用、后端 anki_generation_event 事件、block 状态变化，支持一键复制/下载日志。',
    groupId: 'cards-template',
  },
  {
    id: 'template-designer-workflow-debug',
    labelKey: 'debug_panel.plugin_template_designer_workflow',
    descriptionKey: 'debug_panel.plugin_template_designer_workflow_desc',
    Component: TemplateDesignerWorkflowDebugPlugin,
    labelDefault: '模板设计师全链路调试',
    descriptionDefault: '监控 template_list/get/validate/create/update/fork/preview/delete 工具调用、mcp_tool 块状态变化和模板渲染结果，支持一键复制/下载日志。',
    groupId: 'cards-template',
  },
  {
    id: 'mcp-debug',
    labelKey: 'debug_panel.plugin_mcp_debug',
    descriptionKey: 'debug_panel.plugin_mcp_debug_desc',
    Component: McpDebugPlugin,
    labelDefault: 'MCP 调试',
    descriptionDefault: '全面监控 MCP 配置、连接状态、Stdio 消息收发、工具调用等全链路日志，支持多服务器和智能节流。',
    groupId: 'infra-quality',
  },
  {
    id: 'image-attachment-inspector',
    labelKey: 'debug_panel.plugin_image_inspector',
    descriptionKey: 'debug_panel.plugin_image_inspector_desc',
    Component: ImageAttachmentInspectorPlugin,
    labelDefault: '图片附件检查器',
    descriptionDefault: '检查每条用户消息的图片来源（image_base64、content、textbook_pages、_meta等），检测重复和扩散问题。',
    groupId: 'input-pipeline',
  },
  {
    id: 'image-preview-debug',
    labelKey: 'debug_panel.plugin_image_preview',
    descriptionKey: 'debug_panel.plugin_image_preview_desc',
    Component: ImagePreviewDebugPlugin,
    labelDefault: '图片预览调试',
    descriptionDefault: '追踪错题导学图片预览的完整生命周期：缩略图点击 → 预览器打开 → 图片加载，自动诊断问题根因。',
    groupId: 'input-pipeline',
  },
  {
    id: 'chatv2-image-preview-debug',
    labelKey: 'debug_panel.plugin_chatv2_image_preview',
    descriptionKey: 'debug_panel.plugin_chatv2_image_preview_desc',
    Component: ChatV2ImagePreviewDebugPlugin,
    labelDefault: 'Chat V2 图片预览',
    descriptionDefault: '追踪 Chat V2 图片预览：VFS 引用加载 → 缩略图渲染 → InlineImageViewer 打开，诊断 container 查找问题。',
    groupId: 'chat-v2',
  },
  // ★ exam-sheet-analysis-bridge 插件已废弃（2026-01 清理）
  // ★ exam-sheet-render-monitor 和 exam-sheet-collapse-debug 插件已废弃（ExamSheetWorkbench 组件已移除，2026-02 清理）
  // ★ 图谱模块已废弃 - graph-rag-debug 和 graph-edge-debug 插件已移除
  {
    id: 'page-lifecycle-debug',
    labelKey: 'debug_panel.plugin_page_lifecycle',
    descriptionKey: 'debug_panel.plugin_page_lifecycle_desc',
    Component: PageLifecycleDebugPlugin,
    labelDefault: '页面生命周期监控',
    descriptionDefault: '监控侧边栏各页面的挂载/卸载/显示/隐藏状态，诊断保活机制是否生效和页面重复加载问题。支持一键复制诊断报告。',
    groupId: 'infra-quality',
  },
  {
    id: 'layout-debug',
    labelKey: 'debug_panel.plugin_layout_debug',
    descriptionKey: 'debug_panel.plugin_layout_debug_desc',
    Component: LayoutDebugPlugin,
    labelDefault: '布局调试器',
    descriptionDefault: '实时监测页面关键元素（content-header、content-body、page-container）的尺寸、定位、重叠和间隙，精确定位布局问题根因。',
    groupId: 'infra-quality',
  },
  {
    id: 'floating-panel-debug',
    labelKey: 'debug_panel.plugin_floating_panel_debug',
    descriptionKey: 'debug_panel.plugin_floating_panel_debug_desc',
    Component: FloatingPanelDebugPlugin,
    labelDefault: '外部面板定位调试',
    descriptionDefault: '诊断输入栏外部面板（RAG、MCP、对话控制等）的定位问题：监听面板状态、捕获定位链、检测CSS冲突、计算可用空间，精确定位面板位置异常根因。',
    groupId: 'infra-quality',
  },
  {
    id: 'notes-typography-debug',
    labelKey: 'debug_panel.plugin_notes_typography',
    descriptionKey: 'debug_panel.plugin_notes_typography_desc',
    Component: NotesTypographyDebugPlugin,
    labelDefault: '笔记排版样式调试',
    descriptionDefault: '监控笔记模块排版样式（字号/行距/字体）的完整生命周期：editor事件、syncTypography调用、applyStyle执行、状态快照、问题检测等，支持一键复制日志。',
    groupId: 'notes-editor',
  },
  {
    id: 'notes-outline-debug',
    labelKey: 'debug_panel.plugin_notes_outline_debug',
    descriptionKey: 'debug_panel.plugin_notes_outline_debug_desc',
    Component: NotesOutlineDebugPlugin,
    labelDefault: '笔记大纲滚动调试',
    descriptionDefault: '监听大纲点击→事件派发→Crepe滚动→DOM状态的完整链路，自动捕获日志、状态快照与诊断结果，支持一键复制。',
    groupId: 'notes-editor',
  },
  {
    id: 'crepe-editor-debug',
    labelKey: 'debug_panel.plugin_crepe_editor_debug',
    descriptionKey: 'debug_panel.plugin_crepe_editor_debug_desc',
    Component: CrepeEditorDebugPlugin,
    labelDefault: 'Crepe编辑器生命周期调试',
    descriptionDefault: '全面监控 Crepe 编辑器的完整生命周期：初始化、依赖加载、DOM状态、编辑器事件、错误捕获等。实时显示 data-ready、contentEditable、pointer-events 等关键属性，并提供自动诊断和一键复制。',
    groupId: 'notes-editor',
  },
  {
    id: 'crepe-drag-drop-debug',
    labelKey: 'debug_panel.plugin_crepe_drag_drop_debug',
    descriptionKey: 'debug_panel.plugin_crepe_drag_drop_debug_desc',
    Component: CrepeDragDropDebugPlugin,
    labelDefault: 'Crepe拖放调试',
    descriptionDefault: '全面监控 Crepe 编辑器拖放功能的完整生命周期：dragstart/dragover/drop 事件、BlockService 状态、dataTransfer 数据、事件传播等。实时诊断拖放问题，支持一键复制日志。',
    groupId: 'notes-editor',
  },
  {
    id: 'scroll-area-debug',
    labelKey: 'debug_panel.plugin_scroll_area_debug',
    descriptionKey: 'debug_panel.plugin_scroll_area_debug_desc',
    Component: ScrollAreaDebugPlugin,
    labelDefault: '滚动区域调试',
    descriptionDefault: '全面监控 CustomScrollArea 与 ProseMirror 选区的交互：MutationObserver/ResizeObserver 触发、滚动条状态变化、选区变化、DOM 尺寸变化等。用于诊断选中文本时滚动条闪烁问题。',
    groupId: 'notes-editor',
  },
  {
    id: 'crepe-image-upload-debug',
    labelKey: 'debug_panel.plugin_crepe_image_upload_debug',
    descriptionKey: 'debug_panel.plugin_crepe_image_upload_debug_desc',
    Component: CrepeImageUploadDebugPlugin,
    labelDefault: 'Crepe图片上传调试',
    descriptionDefault: '全面监控 Crepe 编辑器图片上传的完整生命周期：点击检测、选择器匹配、Tauri环境检测、文件对话框、文件读取、节点更新等。实时诊断图片上传失败问题，支持一键复制诊断报告。',
    groupId: 'notes-editor',
  },
  {
    id: 'essay-grading-tooltip-debug',
    labelKey: 'debug_panel.plugin_essay_grading_tooltip',
    descriptionKey: 'debug_panel.plugin_essay_grading_tooltip_desc',
    Component: EssayGradingTooltipDebugPlugin,
    labelDefault: '作文批改 Tooltip 调试',
    descriptionDefault: '全面监控作文批改模块 Tooltip 的完整生命周期：DOM 挂载/卸载、尺寸位置、计算样式、溢出检测等。实时捕获快照，自动诊断样式问题，支持一键复制诊断报告。',
    groupId: 'exam-workflow',
  },
  {
    id: 'dstu-debug',
    labelKey: 'debug_panel.plugin_dstu_debug',
    descriptionKey: 'debug_panel.plugin_dstu_debug_desc',
    Component: DstuDebugPlugin,
    labelDefault: 'DSTU API 调试',
    descriptionDefault: '监听所有 DSTU API 调用（createEmpty、create、update 等），实时显示请求参数、响应结果和错误信息，支持过滤、复制和导出。',
    groupId: 'infra-quality',
  },
  {
    id: 'mindmap-blur-hover-debug',
    labelKey: 'debug_panel.plugin_mindmap_blur_hover',
    descriptionKey: 'debug_panel.plugin_mindmap_blur_hover_desc',
    Component: MindMapBlurHoverDebugPlugin,
    labelDefault: '思维导图悬浮模糊监听',
    descriptionDefault: '监听思维导图节点 hover 时的样式与坐标状态，采集可复制日志（viewport transform、边透明度、节点小数坐标等）用于复现与定位文字模糊根因。',
    groupId: 'infra-quality',
  },
  {
    id: 'attachment-pipeline-test',
    labelKey: 'debug_panel.plugin_attachment_pipeline_test',
    descriptionKey: 'debug_panel.plugin_attachment_pipeline_test_desc',
    Component: AttachmentPipelineTestPlugin,
    labelDefault: '附件流水线自动化测试',
    descriptionDefault: '自动测试所有 附件类型×注入模式×模型类型 排列组合（24用例），通过 DOM 模拟真实上传流程，捕获前后端管线日志，验证注入模式规范化和多模态检测。',
    groupId: 'chat-timeline',
  },
  {
    id: 'chat-interaction-test',
    labelKey: 'debug_panel.plugin_chat_interaction_test',
    descriptionKey: 'debug_panel.plugin_chat_interaction_test_desc',
    Component: ChatInteractionTestPlugin,
    labelDefault: '聊天交互自动化测试',
    descriptionDefault: '通过 DOM 模拟用户点击，自动测试 发送→流式中断→重试→换模型重试→编辑重发→重新发送→多变体 全链路（7步），验证请求体变化和 model icon 完整性。',
    groupId: 'chat-timeline',
  },
  {
    id: 'citation-test',
    labelKey: 'debug_panel.plugin_citation_test',
    descriptionKey: 'debug_panel.plugin_citation_test_desc',
    Component: CitationTestPlugin,
    labelDefault: '引用生成与解引用测试',
    descriptionDefault: '自动测试引用解析全格式覆盖（中/英文类型名/图片后缀/边界）、Source Adapter 数据桥接（citations/toolOutput/混合块）、DOM 渲染验证和持久化往返完整性，共 5 步。',
    groupId: 'chat-timeline',
  },
  {
    id: 'multi-variant-test',
    labelKey: 'debug_panel.plugin_multi_variant_test',
    descriptionKey: 'debug_panel.plugin_multi_variant_test_desc',
    Component: MultiVariantTestPlugin,
    labelDefault: '多变体自动化测试',
    descriptionDefault: '3 变体并行的 18 步全自动边缘测试：发送/取消/重试/切换/删除/持久化/DOM/Icon，通过 DOM 模拟真实用户操作。',
    groupId: 'chat-timeline',
  },
  {
    id: 'tool-call-lifecycle-debug',
    labelKey: 'debug_panel.plugin_tool_call_lifecycle',
    descriptionKey: 'debug_panel.plugin_tool_call_lifecycle_desc',
    Component: ToolCallLifecycleDebugPlugin,
    labelDefault: '工具调用生命周期',
    descriptionDefault: '监控工具调用前后端完整链路：preparing→start→chunk→end/error，检测顺序异常和超时，可复制完整时序日志。',
    groupId: 'chat-timeline',
  },
  {
    id: 'exam-sheet-processing-debug',
    labelKey: 'debug_panel.plugin_exam_sheet_processing',
    descriptionKey: 'debug_panel.plugin_exam_sheet_processing_desc',
    Component: ExamSheetProcessingDebugPlugin,
    labelDefault: '题目集识别生命周期',
    descriptionDefault: '监控两阶段题目集识别全链路：invoke→SessionCreated→OCR逐页→OCR完成→解析逐页→Completed/Failed，检测事件丢失和卡住，可复制完整时序日志。',
    groupId: 'exam-workflow',
  },
];

const FAVORITES_STORAGE_KEY = 'DSTU_DEBUG_FAVORITES';
const ACTIVATED_STORAGE_KEY = 'DSTU_DEBUG_ACTIVATED';

const STORAGE_KEYS = {
  POSITION: 'DSTU_DBG_POS',
  SIZE: 'DSTU_DBG_SIZE',
};

const DebugPanelHost: React.FC<DebugPanelHostProps> = ({ visible, onClose, currentStreamId }) => {
  const { t } = useTranslation('common');
  const [portalEl, setPortalEl] = React.useState<HTMLElement | null>(null);
  const [pos, setPos] = React.useState<{ x: number; y: number }>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.POSITION);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          return parsed;
        }
      }
    } catch {
      // localStorage 不可用或数据损坏，使用默认位置
    }
    return { x: 12, y: 12 };
  });
  const [size, setSize] = React.useState<{ w: number; h: number }>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.SIZE);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (typeof parsed.w === 'number' && typeof parsed.h === 'number') {
          return parsed;
        }
      }
    } catch {
      // localStorage 不可用或数据损坏，使用默认尺寸
    }
    return { w: Math.min(720, Math.floor(window.innerWidth * 0.92)), h: Math.floor(window.innerHeight * 0.5) };
  });
  const [dragging, setDragging] = React.useState(false);
  const [resizing, setResizing] = React.useState(false);
  const dragStart = React.useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const sizeStart = React.useRef<{ sw: number; sh: number; sx: number; sy: number }>({ sw: 0, sh: 0, sx: 0, sy: 0 });

  const [activePluginId, setActivePluginId] = React.useState<string>(HOME_PLUGIN_ID);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [favoriteIds, setFavoriteIds] = React.useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(FAVORITES_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          return new Set(parsed.filter((id): id is string => typeof id === 'string'));
        }
      }
    } catch {
      // localStorage 不可用或收藏数据损坏，重置为空
    }
    return new Set();
  });
  const [activatedIds, setActivatedIds] = React.useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(ACTIVATED_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          return new Set(parsed.filter((id): id is string => typeof id === 'string'));
        }
      }
    } catch {}
    return new Set();
  });

  // 调试总开关状态
  const [masterSwitchEnabled, setMasterSwitchEnabled] = React.useState(() => debugMasterSwitch.isEnabled());

  // 监听总开关变化
  React.useEffect(() => {
    const unsubscribe = debugMasterSwitch.addListener((enabled) => {
      setMasterSwitchEnabled(enabled);
    });
    return unsubscribe;
  }, []);

  const handleToggleMasterSwitch = React.useCallback(() => {
    debugMasterSwitch.toggle();
  }, []);

  const toggleFavorite = React.useCallback((pluginId: string) => {
    setFavoriteIds(prev => {
      const next = new Set(prev);
      if (next.has(pluginId)) {
        next.delete(pluginId);
      } else {
        next.add(pluginId);
      }
      try {
        localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch {
        // localStorage 写入失败（如配额已满），收藏仍在内存中生效
      }
      return next;
    });
  }, []);

  const activatePlugin = React.useCallback((pluginId: string) => {
    setActivatedIds(prev => {
      if (prev.has(pluginId)) return prev;
      const next = new Set(prev);
      next.add(pluginId);
      try {
        localStorage.setItem(ACTIVATED_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch {}
      return next;
    });
  }, []);

  // 支持程序化选择插件（通过 URL 参数或 localStorage）
  React.useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const targetPlugin = urlParams.get('debug-plugin') || localStorage.getItem('DSTU_DEBUG_PLUGIN');
    
    if (targetPlugin && targetPlugin !== HOME_PLUGIN_ID) {
      const pluginExists = PLUGINS.some(p => p.id === targetPlugin);
      if (pluginExists) {
        setActivePluginId(targetPlugin);
        activatePlugin(targetPlugin);
        // 清除 localStorage 标记（避免持久影响）
        localStorage.removeItem('DSTU_DEBUG_PLUGIN');
      }
    }
  }, [activatePlugin]);

  // 当切换插件时自动记录激活态
  React.useEffect(() => {
    if (activePluginId && activePluginId !== HOME_PLUGIN_ID) {
      activatePlugin(activePluginId);
    }
  }, [activePluginId, activatePlugin]);

  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.id = 'dstu-debugger-portal';
    el.style.position = 'relative';
    el.style.zIndex = '2147483647';
    document.body.appendChild(el);
    setPortalEl(el);
    return () => {
      try {
        document.body.removeChild(el);
      } catch (e) {
        console.warn('[DebugPanel] portal 元素移除失败（可能已被外部移除）:', e);
      }
      setPortalEl(null);
    };
  }, []);

  React.useEffect(() => {
    const handleMove = (ev: MouseEvent) => {
      if (dragging) {
        setPos(prev => {
          const next = {
            x: Math.max(0, ev.clientX - dragStart.current.dx),
            y: Math.max(0, ev.clientY - dragStart.current.dy),
          };
          return next;
        });
      } else if (resizing) {
        const dx = ev.clientX - sizeStart.current.sx;
        const dy = ev.clientY - sizeStart.current.sy;
        setSize(prev => ({
          w: Math.max(360, sizeStart.current.sw + dx),
          h: Math.max(240, sizeStart.current.sh + dy),
        }));
      }
    };

    const handleUp = () => {
      if (dragging) {
        try {
          localStorage.setItem(STORAGE_KEYS.POSITION, JSON.stringify(pos));
        } catch {}
      }
      if (resizing) {
        try {
          localStorage.setItem(STORAGE_KEYS.SIZE, JSON.stringify(size));
        } catch {}
      }
      setDragging(false);
      setResizing(false);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [dragging, resizing, pos, size]);

  React.useEffect(() => {
    const clamp = () => {
      const vw = window.innerWidth || 1024;
      const vh = window.innerHeight || 768;
      setPos(prev => {
        const nx = Math.min(Math.max(0, prev.x ?? 0), Math.max(0, vw - 120));
        const ny = Math.min(Math.max(0, prev.y ?? 0), Math.max(0, vh - 80));
        if (nx !== prev.x || ny !== prev.y) {
          return { x: nx, y: ny };
        }
        return prev;
      });
      setSize(prev => {
        const nw = Math.min(Math.max(360, prev.w ?? 360), Math.max(360, vw - 24));
        const nh = Math.min(Math.max(220, prev.h ?? 220), Math.max(220, vh - 24));
        if (nw !== prev.w || nh !== prev.h) {
          return { w: nw, h: nh };
        }
        return prev;
      });
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => {
      window.removeEventListener('resize', clamp);
    };
  }, []);

  const pluginItems = React.useMemo(
    () =>
      PLUGINS.map(plugin => ({
        ...plugin,
        label: String(t(plugin.labelKey, plugin.labelDefault ?? plugin.labelKey)),
        description: String(t(plugin.descriptionKey, plugin.descriptionDefault ?? plugin.descriptionKey)),
      })),
    [t],
  );

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredPlugins = React.useMemo(
    () =>
      pluginItems.filter(plugin => {
        if (!normalizedQuery) return true;
        return (
          plugin.label.toLowerCase().includes(normalizedQuery) ||
          plugin.description.toLowerCase().includes(normalizedQuery)
        );
      }),
    [pluginItems, normalizedQuery],
  );

  const groupedPlugins = React.useMemo(
    () =>
      PLUGIN_GROUPS.map(group => {
        const items = filteredPlugins
          .filter(plugin => plugin.groupId === group.id)
          .sort((a, b) => {
            const aFav = favoriteIds.has(a.id);
            const bFav = favoriteIds.has(b.id);
            if (aFav !== bFav) {
              return aFav ? -1 : 1;
            }
            return a.label.localeCompare(b.label);
          });
        return { group, items };
      }).filter(group => group.items.length > 0),
    [filteredPlugins, favoriteIds],
  );

  const favoriteCount = favoriteIds.size;
  const visibleCount = filteredPlugins.length;

  // 只检查 portalEl，不检查 visible，确保面板保活
  if (!portalEl) {
    return null;
  }

  const isHome = activePluginId === HOME_PLUGIN_ID;

  const panel = (
    <div
      className="dstu-dbg-root fixed z-[2147483647]"
      style={{ 
        left: pos.x, 
        top: pos.y, 
        width: size.w, 
        height: size.h,
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        transition: 'opacity 0.2s ease-in-out',
        // 当不可见时，降低 z-index，避免遮挡悬浮球
        zIndex: visible ? 2147483647 : 2147483500
      }}
    >
      <div className="dstu-dbg flex flex-col h-full bg-[hsl(var(--card)/0.97)] backdrop-blur-xl border border-[hsl(var(--border))] rounded-xl shadow-2xl shadow-[hsl(var(--foreground)/0.1)]">
        <div
          className="dbg-header flex items-center justify-between px-3 py-2 border-b border-[hsl(var(--border))] cursor-move bg-[hsl(var(--muted)/0.3)] rounded-t-xl"
          onMouseDown={ev => {
            setDragging(true);
            dragStart.current = { dx: ev.clientX - pos.x, dy: ev.clientY - pos.y };
          }}
          onDoubleClick={() => {
            setPos({ x: 12, y: 12 });
            setSize({ w: Math.min(720, Math.floor(window.innerWidth * 0.92)), h: Math.floor(window.innerHeight * 0.5) });
          }}
        >
          <div className="flex items-center gap-2">
            <div className="text-xs font-semibold text-[hsl(var(--foreground))] tracking-tight">Analysis Panel</div>
            <div className="inline-flex gap-1.5 ml-1 flex-wrap" onMouseDown={ev => ev.stopPropagation()}>
              <NotionButton
                onClick={() => setActivePluginId(HOME_PLUGIN_ID)}
                variant={isHome ? 'primary' : 'ghost'}
                size="sm"
                className="text-[10px] h-6 px-2"
              >
                {t('debug_panel.home')}
              </NotionButton>
            </div>
          </div>
          <div className="flex items-center gap-1.5" onMouseDown={ev => ev.stopPropagation()}>
            {/* 调试日志总开关 */}
            <NotionButton
              onClick={handleToggleMasterSwitch}
              variant={masterSwitchEnabled ? 'success' : 'ghost'}
              size="sm"
              className="text-[10px] h-6 px-2"
              title={masterSwitchEnabled 
                ? t('debug_panel.master_switch_on', '日志输出已开启，点击关闭') 
                : t('debug_panel.master_switch_off', '日志输出已关闭，点击开启')
              }
            >
              {masterSwitchEnabled 
                ? t('debug_panel.logs_on', '日志开') 
                : t('debug_panel.logs_off', '日志关')
              }
            </NotionButton>
            <NotionButton
              onClick={onClose}
              variant="ghost"
              size="sm"
              className="text-[10px] h-6 px-2"
              title={t('debug_panel.minimize', '最小化')}
            >
              {t('debug_panel.minimize', '最小化')}
            </NotionButton>
          </div>
        </div>
        <div className="flex-1 flex flex-col overflow-auto" onMouseDown={ev => ev.stopPropagation()}>
          {isHome ? (
            <div className="flex-1 flex flex-col p-3 gap-3 bg-[hsl(var(--background))]">
              {!masterSwitchEnabled && (
                <div className="rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-[11px] text-orange-600 dark:text-orange-400">
                  {t('debug_panel.master_switch_off_hint', '调试总开关已关闭：所有插件已暂停运行（不会后台监听/刷日志）。需要调试时请先开启总开关。')}
                </div>
              )}
              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <div className="relative flex-1">
                  <input
                    value={searchQuery}
                    onChange={ev => setSearchQuery(ev.target.value)}
                    placeholder={t('debug_panel.search_placeholder', '搜索插件或描述...')}
                    className="w-full rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.3)] text-[hsl(var(--foreground))] text-sm px-3 py-2 pr-9 placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary)/0.4)] focus:border-[hsl(var(--primary)/0.4)] transition-shadow"
                  />
                  {searchQuery ? (
                    <button
                      type="button"
                      aria-label={t('debug_panel.search_clear', '清空搜索')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] px-2 py-1"
                      onClick={() => setSearchQuery('')}
                    >
                      ✕
                    </button>
                  ) : (
                    <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-[hsl(var(--muted-foreground)/0.7)]">
                      {t('debug_panel.search_hint', '可按名称或描述搜索')}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] text-[hsl(var(--foreground)/0.8)]">
                    {t('debug_panel.total_plugins', { count: visibleCount })}
                  </span>
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] text-[hsl(var(--foreground)/0.8)]">
                    {t('debug_panel.favorites_badge', { count: favoriteCount })}
                  </span>
                </div>
              </div>
              <div className="text-[11px] text-[hsl(var(--muted-foreground))] leading-snug">
                {t('debug_panel.favorite_hint')}
              </div>
              <div className="flex-1 flex flex-col gap-4 overflow-auto pr-1">
                {groupedPlugins.map(({ group, items }) => (
                  <div key={group.id} className="space-y-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-0.5">
                        <div className="text-sm font-semibold text-[hsl(var(--foreground))] tracking-tight">
                          {t(group.labelKey)}
                        </div>
                        <p className="text-[11px] text-[hsl(var(--muted-foreground))] leading-snug">
                          {t(group.descriptionKey)}
                        </p>
                      </div>
                      <span className="text-[11px] px-2.5 py-1 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] text-[hsl(var(--foreground)/0.8)]">
                        {t('debug_panel.group_count', { count: items.length })}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                      {items.map(plugin => (
                        <div
                          key={`home-card-${plugin.id}`}
                          onClick={() => {
                            activatePlugin(plugin.id);
                            setActivePluginId(plugin.id);
                          }}
                          className="group relative rounded-xl border border-transparent ring-1 ring-border/40 p-3.5 bg-card hover:bg-card/80 flex flex-col gap-3 shadow-sm hover:shadow-md transition-all duration-200 cursor-pointer"
                        >
                          <button
                            type="button"
                            aria-label={
                              favoriteIds.has(plugin.id)
                                ? t('debug_panel.favorite_remove', '取消收藏')
                                : t('debug_panel.favorite_add', '收藏')
                            }
                            onClick={ev => {
                              ev.stopPropagation();
                              toggleFavorite(plugin.id);
                            }}
                            className={`absolute right-2.5 top-2.5 text-[13px] transition-colors ${
                              favoriteIds.has(plugin.id)
                                ? 'text-warning drop-shadow-sm'
                                : 'text-[hsl(var(--muted-foreground)/0.5)] hover:text-[hsl(var(--muted-foreground))]'
                            }`}
                          >
                            {favoriteIds.has(plugin.id) ? '★' : '☆'}
                          </button>
                          <div className="relative space-y-1.5 pr-6">
                            <div className="flex items-start justify-between gap-2">
                              <h3 className="text-[13px] font-medium text-[hsl(var(--foreground))] leading-tight">
                                {plugin.label}
                              </h3>
                              {activatedIds.has(plugin.id) && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-success/10 text-success border border-success/30 font-medium">
                                  {t('debug_panel.activated_badge', '已激活')}
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-[hsl(var(--muted-foreground))] leading-relaxed line-clamp-3">
                              {plugin.description}
                            </p>
                          </div>
                          
                          <div className="relative flex gap-2 mt-auto pt-1">
                            <NotionButton
                              onClick={ev => {
                                ev.stopPropagation();
                                toggleFavorite(plugin.id);
                              }}
                              variant={favoriteIds.has(plugin.id) ? 'warning' : 'ghost'}
                              size="sm"
                              className="text-[10px] h-7 min-w-[64px]"
                            >
                              {favoriteIds.has(plugin.id)
                                ? t('debug_panel.favorite_short', '已收藏')
                                : t('debug_panel.favorite_action', '收藏')}
                            </NotionButton>
                            <NotionButton
                              onClick={ev => {
                                ev.stopPropagation();
                                activatePlugin(plugin.id);
                                setActivePluginId(plugin.id);
                              }}
                              variant="primary"
                              size="sm"
                              className="flex-1 text-[10px] h-7"
                            >
                              {t('debug_panel.open_plugin', '打开')}
                            </NotionButton>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                {groupedPlugins.length === 0 && (
                  <div className="flex items-center justify-center text-sm text-[hsl(var(--muted-foreground))] border border-[hsl(var(--border))] rounded-xl bg-[hsl(var(--muted)/0.2)] py-8">
                    {t('debug_panel.no_search_result', '未找到匹配的插件')}
                  </div>
                )}
              </div>
            </div>
          ) : (
            PLUGINS.map(plugin => {
              const PluginComponent = plugin.Component;
              const isActive = activePluginId === plugin.id;
              const isActivated = activatedIds.has(plugin.id);
              // 性能保护：总开关关闭时，不渲染任何插件（包括“已激活”与当前打开的插件），
              // 以确保不会后台监听/刷日志影响输入性能。
              const shouldRender = masterSwitchEnabled && (isActive || isActivated);
              if (!shouldRender) return null;
              const show = isActive;
              return (
                <div key={plugin.id} className={`flex-1 ${show ? 'flex' : 'hidden'} flex-col overflow-auto`}>
                  <PluginComponent
                    visible={visible && show}
                    isActive={show}
                    isActivated={isActivated}
                    onClose={onClose}
                    currentStreamId={currentStreamId}
                  />
                </div>
              );
            })
          )}
        </div>
        <div
          className="dbg-resize absolute right-1.5 bottom-1.5 w-3 h-3 cursor-nwse-resize border-r-2 border-b-2 border-[hsl(var(--border))] hover:border-[hsl(var(--primary)/0.6)] transition-colors duration-200 rounded-br"
          onMouseDown={ev => {
            ev.preventDefault();
            ev.stopPropagation();
            setResizing(true);
            sizeStart.current = { sw: size.w, sh: size.h, sx: ev.clientX, sy: ev.clientY };
          }}
          title="拖动以调整大小"
        />
      </div>
    </div>
  );

  return createPortal(panel, portalEl);
};

export default DebugPanelHost;
