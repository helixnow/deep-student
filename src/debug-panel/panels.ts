/**
 * Official Analysis Panel entries (development builds only: DebugPanelHost imports this module behind
 * `import.meta.env.DEV`, so production bundles contain none of `./plugins`). Order is the panel order of the host.
 */
import { debugPanelContributions, type DebugPanel } from '@/ui-plugins/official/debug/api';
import DeepSeekOcrDebugPlugin from './plugins/DeepSeekOcrDebugPlugin';
import WebSearchDebugPlugin from './plugins/WebSearchDebugPlugin';
import UnifiedDragDropDebugPlugin from './plugins/UnifiedDragDropDebugPlugin';
import AnkiGenerationDebugPlugin from './plugins/AnkiGenerationDebugPlugin';
import McpDebugPlugin from './plugins/McpDebugPlugin';
import ImageAttachmentInspectorPlugin from './plugins/ImageAttachmentInspectorPlugin';
import ImagePreviewDebugPlugin from './plugins/ImagePreviewDebugPlugin';
import LayoutDebugPlugin from './plugins/LayoutDebugPlugin';
import FloatingPanelDebugPlugin from './plugins/FloatingPanelDebugPlugin';
import NotesTypographyDebugPlugin from './plugins/NotesTypographyDebugPlugin';
import NotesOutlineDebugPlugin from './plugins/NotesOutlineDebugPlugin';
import CrepeEditorDebugPlugin from './plugins/CrepeEditorDebugPlugin';
import CrepeDragDropDebugPlugin from './plugins/CrepeDragDropDebugPlugin';
import CrepeImageUploadDebugPlugin from './plugins/CrepeImageUploadDebugPlugin';
import EssayGradingTooltipDebugPlugin from './plugins/EssayGradingTooltipDebugPlugin';
import SessionLoadFlowDebugPlugin from './plugins/SessionLoadFlowDebugPlugin';
import SessionSwitchPerfDebugPlugin from './plugins/SessionSwitchPerfDebugPlugin';
import ChatV2ImagePreviewDebugPlugin from './plugins/ChatV2ImagePreviewDebugPlugin';
import MultiVariantDebugPlugin from './plugins/MultiVariantDebugPlugin';
import MultiAgentDebugPlugin from './plugins/MultiAgentDebugPlugin';
import SubagentTestPlugin from './plugins/SubagentTestPlugin';
import SubagentMessageFlowDebugPlugin from './plugins/SubagentMessageFlowDebugPlugin';
import ThinkingBlockDebugPlugin from './plugins/ThinkingBlockDebugPlugin';
import MarkdownStreamingProfilerPlugin from './plugins/MarkdownStreamingProfilerPlugin';
import DstuDebugPlugin from './plugins/DstuDebugPlugin';
import AttachmentInjectionDebugPlugin from './plugins/AttachmentInjectionDebugPlugin';
import AttachmentOcrRequestAuditPlugin from './plugins/AttachmentOcrRequestAuditPlugin';
import MediaProcessingDebugPlugin from './plugins/MediaProcessingDebugPlugin';
import PdfMultimodalDebugPlugin from './plugins/PdfMultimodalDebugPlugin';
import FinderDragDropDebugPlugin from './plugins/FinderDragDropDebugPlugin';
import SelectionBoxDebugPlugin from './plugins/SelectionBoxDebugPlugin';
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
import QuestionImportDebugPlugin from './plugins/QuestionImportDebugPlugin';
import ChatAnkiIntegrationTestPlugin from './plugins/ChatAnkiIntegrationTestPlugin';

export const OFFICIAL_DEBUG_PANELS: readonly DebugPanel[] = [
  // ★ 图谱模块已废弃 - irec-auto-note 和 graph-sidebar-debug 插件已移除
  {
    id: 'session-load-flow',
    labelKey: 'debug_panel.plugin_session_load_flow',
    descriptionKey: 'debug_panel.plugin_session_load_flow_desc',
    component: SessionLoadFlowDebugPlugin,
    labelDefault: '会话加载流程',
    descriptionDefault: '追踪从分析库点击会话到聊天历史显示的完整数据流，诊断会话加载问题。',
    groupId: 'infra-quality',
  },
  {
    id: 'session-switch-perf',
    labelKey: 'debug_panel.plugin_session_load_perf',
    descriptionKey: 'debug_panel.plugin_session_load_perf_desc',
    component: SessionSwitchPerfDebugPlugin,
    labelDefault: '会话加载性能监控',
    descriptionDefault: '监控会话新建/加载各阶段耗时，定位性能瓶颈，优化加载效率。支持时间线可视化和瓶颈自动检测。',
    groupId: 'infra-quality',
  },
  {
    id: 'multi-variant-debug',
    labelKey: 'debug_panel.plugin_multi_variant',
    descriptionKey: 'debug_panel.plugin_multi_variant_desc',
    component: MultiVariantDebugPlugin,
    labelDefault: '多变体并行调试',
    descriptionDefault: '追踪 @模型 选择到后端并行执行的完整数据流，诊断多变体模式触发问题。',
    groupId: 'chat-timeline',
  },
  {
    id: 'multi-agent-debug',
    labelKey: 'debug_panel.plugin_multi_agent',
    descriptionKey: 'debug_panel.plugin_multi_agent_desc',
    component: MultiAgentDebugPlugin,
    labelDefault: '多 Agent 调试',
    descriptionDefault: '监控多 Agent 工作区状态、Agent 列表和消息流，支持预设 Prompt 一键启动调试，可复制完整运行日志。',
    groupId: 'chat-timeline',
  },
  {
    id: 'subagent-test',
    labelKey: 'debug_panel.plugin_subagent_test',
    descriptionKey: 'debug_panel.plugin_subagent_test_desc',
    component: SubagentTestPlugin,
    labelDefault: '子代理自动测试',
    descriptionDefault: '一键启动子代理自动测试，实时记录 UI 渲染情况、用户交互和生命周期事件，生成测试报告。',
    groupId: 'chat-timeline',
  },
  {
    id: 'subagent-message-flow-debug',
    labelKey: 'debug_panel.plugin_subagent_message_flow',
    descriptionKey: 'debug_panel.plugin_subagent_message_flow_desc',
    component: SubagentMessageFlowDebugPlugin,
    labelDefault: '子代理消息流调试',
    descriptionDefault: '诊断子代理嵌入视图中助手消息不显示的问题，全链路打点追踪 Adapter 创建、storeApi 状态、stream_start 事件处理。',
    groupId: 'chat-timeline',
  },
  {
    id: 'workspace-orchestration-test',
    labelKey: 'debug_panel.plugin_workspace_orchestration_test',
    descriptionKey: 'debug_panel.plugin_workspace_orchestration_test_desc',
    component: WorkspaceOrchestrationTestPlugin,
    labelDefault: '多 Agent 编排自动测试',
    descriptionDefault: '场景化自动测试多 Agent / 子代理工作区：真实 sendMessage 触发编排，捕获 workspace 事件、tool_call、Store 快照与持久化一致性，生成可下载报告。',
    groupId: 'chat-timeline',
  },
  {
    id: 'thinking-block-debug',
    labelKey: 'debug_panel.plugin_thinking_block',
    descriptionKey: 'debug_panel.plugin_thinking_block_desc',
    component: ThinkingBlockDebugPlugin,
    labelDefault: 'Thinking 块调试',
    descriptionDefault: '监听 thinking 块流式生成和数据库保存流程，诊断刷新后 thinking 丢失问题。',
    groupId: 'chat-timeline',
  },
  {
    id: 'markdown-streaming-profiler',
    labelKey: 'debug_panel.plugin_markdown_streaming_profiler',
    descriptionKey: 'debug_panel.plugin_markdown_streaming_profiler_desc',
    component: MarkdownStreamingProfilerPlugin,
    labelDefault: 'Markdown 流式 Profiler',
    descriptionDefault: '观察 Markdown smoothing 的 target/display 事件、lag 与 preset，调试 LLM 输出观感。',
    groupId: 'chat-timeline',
  },
  {
    id: 'attachment-injection-debug',
    labelKey: 'debug_panel.plugin_attachment_injection',
    descriptionKey: 'debug_panel.plugin_attachment_injection_desc',
    component: AttachmentInjectionDebugPlugin,
    labelDefault: '附件注入调试',
    descriptionDefault: '追踪附件上传到消息发送的完整数据流，包括 VFS 上传、资源创建、引用解析、内容格式化等关键阶段。',
    groupId: 'chat-timeline',
  },
  {
    id: 'attachment-ocr-request-audit',
    labelKey: 'debug_panel.plugin_attachment_ocr_request_audit',
    descriptionKey: 'debug_panel.plugin_attachment_ocr_request_audit_desc',
    component: AttachmentOcrRequestAuditPlugin,
    labelDefault: '附件/OCR 请求体审计',
    descriptionDefault: '监听 PDF/图片上传、OCR 流水线、注入模式选择，以及前端构造和后端接收的请求体摘要，校验多模态/文本模型是否收到预期内容。',
    groupId: 'chat-timeline',
  },
  {
    id: 'pdf-multimodal-debug',
    labelKey: 'debug_panel.plugin_pdf_multimodal',
    descriptionKey: 'debug_panel.plugin_pdf_multimodal_desc',
    component: PdfMultimodalDebugPlugin,
    labelDefault: 'PDF 多模态调试',
    descriptionDefault: '专门调试 PDF 图片模式注入问题，追踪 isMultimodal、includeImage、multimodalBlocks 等关键状态。',
    groupId: 'chat-timeline',
  },
  {
    id: 'media-processing-debug',
    labelKey: 'debug_panel.plugin_media_processing',
    descriptionKey: 'debug_panel.plugin_media_processing_desc',
    component: MediaProcessingDebugPlugin,
    labelDefault: '媒体预处理调试',
    descriptionDefault: '追踪 PDF/图片附件预处理的完整生命周期，包括文本提取、页面渲染、图片压缩、OCR 处理、向量索引等阶段。实时监控后端事件和 Store 状态。',
    groupId: 'chat-timeline',
  },
  {
    id: 'edit-retry-debug',
    labelKey: 'debug_panel.plugin_edit_retry',
    descriptionKey: 'debug_panel.plugin_edit_retry_desc',
    component: EditRetryDebugPlugin,
    labelDefault: '编辑/重试调试',
    descriptionDefault: '追踪编辑重发和重试的完整流程，诊断编辑无响应、重试未清空后续消息等问题。',
    groupId: 'chat-timeline',
  },
  // ★ exam-sheet-lifecycle 插件已废弃（ExamSheetWorkbench 组件已移除，2026-02 清理）
  {
    id: 'deepseek-ocr-debug',
    labelKey: 'debug_panel.plugin_deepseek_ocr',
    descriptionKey: 'debug_panel.plugin_deepseek_ocr_desc',
    component: DeepSeekOcrDebugPlugin,
    labelDefault: 'DeepSeek-OCR 调试',
    descriptionDefault: '细粒度监控 DeepSeek-OCR 识别全流程：请求构建、模型响应、Grounding 解析、坐标转换、最终结果。支持按阶段和日志级别过滤，可复制完整日志。',
    groupId: 'input-pipeline',
  },
  {
    id: 'web-search-debug',
    labelKey: 'debug_panel.plugin_web_search',
    descriptionKey: 'debug_panel.plugin_web_search_desc',
    component: WebSearchDebugPlugin,
    labelDefault: '外部搜索调试',
    descriptionDefault: '监听外部搜索开启、调用、上下文注入和来源信息，捕获搜索流程全链路日志。',
    groupId: 'input-pipeline',
  },
  {
    id: 'unified-drag-drop',
    labelKey: 'debug_panel.plugin_unified_drag_drop',
    descriptionKey: 'debug_panel.plugin_unified_drag_drop_desc',
    component: UnifiedDragDropDebugPlugin,
    labelDefault: '统一拖拽调试',
    descriptionDefault: '全面监控所有拖拽上传区域的细粒度日志，包括拖拽事件、文件验证、转换处理、回调执行等全流程。',
    groupId: 'input-pipeline',
  },
  {
    id: 'finder-drag-drop',
    labelKey: 'debug_panel.plugin_finder_drag_drop',
    descriptionKey: 'debug_panel.plugin_finder_drag_drop_desc',
    component: FinderDragDropDebugPlugin,
    labelDefault: 'Finder 拖放调试',
    descriptionDefault: '监听 Learning Hub 文件管理器的 dnd-kit 拖放事件，调试文件移动到文件夹功能。',
    groupId: 'input-pipeline',
  },
  {
    id: 'selection-box-debug',
    labelKey: 'debug_panel.plugin_selection_box',
    descriptionKey: 'debug_panel.plugin_selection_box_desc',
    component: SelectionBoxDebugPlugin,
    labelDefault: '框选调试',
    descriptionDefault: '监听 Learning Hub 框选功能，记录光标位置与框选框端点的偏移量，用于调试框选位置问题。',
    groupId: 'input-pipeline',
  },
  {
    id: 'anki-generation-debug',
    labelKey: 'debug_panel.plugin_anki_generation',
    descriptionKey: 'debug_panel.plugin_anki_generation_desc',
    component: AnkiGenerationDebugPlugin,
    labelDefault: 'Anki 制卡日志',
    descriptionDefault: '集中查看制卡流程的关键埋点、事件、异常与导出状态，支持关键字过滤与级别筛选。',
    groupId: 'cards-template',
  },
  {
    id: 'chatanki-workflow-debug',
    labelKey: 'debug_panel.plugin_chatanki_workflow',
    descriptionKey: 'debug_panel.plugin_chatanki_workflow_desc',
    component: ChatAnkiWorkflowDebugPlugin,
    labelDefault: 'ChatAnki 全链路调试',
    descriptionDefault: '监控 chatanki_run/wait/status 工具调用、后端 anki_generation_event 事件、block 状态变化，支持一键复制/下载日志。',
    groupId: 'cards-template',
  },
  {
    id: 'chatanki-integration-test',
    labelKey: 'debug_panel.plugin_chatanki_integration_test',
    descriptionKey: 'debug_panel.plugin_chatanki_integration_test_desc',
    component: ChatAnkiIntegrationTestPlugin,
    labelDefault: 'ChatAnki 集成自动测试',
    descriptionDefault: '3 组 9 场景全自动 DOM 模拟测试：制卡核心流 / 用户操作（编辑/删除/保存）/ 数据一致性（onEnd 覆盖/提前 success/进度回退），生成可下载报告。',
    groupId: 'cards-template',
  },
  {
    id: 'template-designer-workflow-debug',
    labelKey: 'debug_panel.plugin_template_designer_workflow',
    descriptionKey: 'debug_panel.plugin_template_designer_workflow_desc',
    component: TemplateDesignerWorkflowDebugPlugin,
    labelDefault: '模板设计师全链路调试',
    descriptionDefault: '监控 template_list/get/validate/create/update/fork/preview/delete 工具调用、mcp_tool 块状态变化和模板渲染结果，支持一键复制/下载日志。',
    groupId: 'cards-template',
  },
  {
    id: 'mcp-debug',
    labelKey: 'debug_panel.plugin_mcp_debug',
    descriptionKey: 'debug_panel.plugin_mcp_debug_desc',
    component: McpDebugPlugin,
    labelDefault: 'MCP 调试',
    descriptionDefault: '全面监控 MCP 配置、连接状态、Stdio 消息收发、工具调用等全链路日志，支持多服务器和智能节流。',
    groupId: 'infra-quality',
  },
  {
    id: 'image-attachment-inspector',
    labelKey: 'debug_panel.plugin_image_inspector',
    descriptionKey: 'debug_panel.plugin_image_inspector_desc',
    component: ImageAttachmentInspectorPlugin,
    labelDefault: '图片附件检查器',
    descriptionDefault: '检查每条用户消息的图片来源（image_base64、content、textbook_pages、_meta等），检测重复和扩散问题。',
    groupId: 'input-pipeline',
  },
  {
    id: 'image-preview-debug',
    labelKey: 'debug_panel.plugin_image_preview',
    descriptionKey: 'debug_panel.plugin_image_preview_desc',
    component: ImagePreviewDebugPlugin,
    labelDefault: '图片预览调试',
    descriptionDefault: '追踪错题导学图片预览的完整生命周期：缩略图点击 → 预览器打开 → 图片加载，自动诊断问题根因。',
    groupId: 'input-pipeline',
  },
  {
    id: 'chatv2-image-preview-debug',
    labelKey: 'debug_panel.plugin_chatv2_image_preview',
    descriptionKey: 'debug_panel.plugin_chatv2_image_preview_desc',
    component: ChatV2ImagePreviewDebugPlugin,
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
    component: PageLifecycleDebugPlugin,
    labelDefault: '页面生命周期监控',
    descriptionDefault: '监控侧边栏各页面的挂载/卸载/显示/隐藏状态，诊断保活机制是否生效和页面重复加载问题。支持一键复制诊断报告。',
    groupId: 'infra-quality',
  },
  {
    id: 'layout-debug',
    labelKey: 'debug_panel.plugin_layout_debug',
    descriptionKey: 'debug_panel.plugin_layout_debug_desc',
    component: LayoutDebugPlugin,
    labelDefault: '布局调试器',
    descriptionDefault: '实时监测页面关键元素（content-header、content-body、page-container）的尺寸、定位、重叠和间隙，精确定位布局问题根因。',
    groupId: 'infra-quality',
  },
  {
    id: 'floating-panel-debug',
    labelKey: 'debug_panel.plugin_floating_panel_debug',
    descriptionKey: 'debug_panel.plugin_floating_panel_debug_desc',
    component: FloatingPanelDebugPlugin,
    labelDefault: '外部面板定位调试',
    descriptionDefault: '诊断输入栏外部面板（RAG、MCP、对话控制等）的定位问题：监听面板状态、捕获定位链、检测CSS冲突、计算可用空间，精确定位面板位置异常根因。',
    groupId: 'infra-quality',
  },
  {
    id: 'notes-typography-debug',
    labelKey: 'debug_panel.plugin_notes_typography',
    descriptionKey: 'debug_panel.plugin_notes_typography_desc',
    component: NotesTypographyDebugPlugin,
    labelDefault: '笔记排版样式调试',
    descriptionDefault: '监控笔记模块排版样式（字号/行距/字体）的完整生命周期：editor事件、syncTypography调用、applyStyle执行、状态快照、问题检测等，支持一键复制日志。',
    groupId: 'notes-editor',
  },
  {
    id: 'notes-outline-debug',
    labelKey: 'debug_panel.plugin_notes_outline_debug',
    descriptionKey: 'debug_panel.plugin_notes_outline_debug_desc',
    component: NotesOutlineDebugPlugin,
    labelDefault: '笔记大纲滚动调试',
    descriptionDefault: '监听大纲点击→事件派发→Crepe滚动→DOM状态的完整链路，自动捕获日志、状态快照与诊断结果，支持一键复制。',
    groupId: 'notes-editor',
  },
  {
    id: 'crepe-editor-debug',
    labelKey: 'debug_panel.plugin_crepe_editor_debug',
    descriptionKey: 'debug_panel.plugin_crepe_editor_debug_desc',
    component: CrepeEditorDebugPlugin,
    labelDefault: 'Crepe编辑器生命周期调试',
    descriptionDefault: '全面监控 Crepe 编辑器的完整生命周期：初始化、依赖加载、DOM状态、编辑器事件、错误捕获等。实时显示 data-ready、contentEditable、pointer-events 等关键属性，并提供自动诊断和一键复制。',
    groupId: 'notes-editor',
  },
  {
    id: 'crepe-drag-drop-debug',
    labelKey: 'debug_panel.plugin_crepe_drag_drop_debug',
    descriptionKey: 'debug_panel.plugin_crepe_drag_drop_debug_desc',
    component: CrepeDragDropDebugPlugin,
    labelDefault: 'Crepe拖放调试',
    descriptionDefault: '全面监控 Crepe 编辑器拖放功能的完整生命周期：dragstart/dragover/drop 事件、BlockService 状态、dataTransfer 数据、事件传播等。实时诊断拖放问题，支持一键复制日志。',
    groupId: 'notes-editor',
  },
  {
    id: 'crepe-image-upload-debug',
    labelKey: 'debug_panel.plugin_crepe_image_upload_debug',
    descriptionKey: 'debug_panel.plugin_crepe_image_upload_debug_desc',
    component: CrepeImageUploadDebugPlugin,
    labelDefault: 'Crepe图片上传调试',
    descriptionDefault: '全面监控 Crepe 编辑器图片上传的完整生命周期：点击检测、选择器匹配、Tauri环境检测、文件对话框、文件读取、节点更新等。实时诊断图片上传失败问题，支持一键复制诊断报告。',
    groupId: 'notes-editor',
  },
  {
    id: 'essay-grading-tooltip-debug',
    labelKey: 'debug_panel.plugin_essay_grading_tooltip',
    descriptionKey: 'debug_panel.plugin_essay_grading_tooltip_desc',
    component: EssayGradingTooltipDebugPlugin,
    labelDefault: '作文批改 Tooltip 调试',
    descriptionDefault: '全面监控作文批改模块 Tooltip 的完整生命周期：DOM 挂载/卸载、尺寸位置、计算样式、溢出检测等。实时捕获快照，自动诊断样式问题，支持一键复制诊断报告。',
    groupId: 'exam-workflow',
  },
  {
    id: 'dstu-debug',
    labelKey: 'debug_panel.plugin_dstu_debug',
    descriptionKey: 'debug_panel.plugin_dstu_debug_desc',
    component: DstuDebugPlugin,
    labelDefault: 'DSTU API 调试',
    descriptionDefault: '监听所有 DSTU API 调用（createEmpty、create、update 等），实时显示请求参数、响应结果和错误信息，支持过滤、复制和导出。',
    groupId: 'infra-quality',
  },
  {
    id: 'mindmap-blur-hover-debug',
    labelKey: 'debug_panel.plugin_mindmap_blur_hover',
    descriptionKey: 'debug_panel.plugin_mindmap_blur_hover_desc',
    component: MindMapBlurHoverDebugPlugin,
    labelDefault: '思维导图悬浮模糊监听',
    descriptionDefault: '监听思维导图节点 hover 时的样式与坐标状态，采集可复制日志（viewport transform、边透明度、节点小数坐标等）用于复现与定位文字模糊根因。',
    groupId: 'infra-quality',
  },
  {
    id: 'attachment-pipeline-test',
    labelKey: 'debug_panel.plugin_attachment_pipeline_test',
    descriptionKey: 'debug_panel.plugin_attachment_pipeline_test_desc',
    component: AttachmentPipelineTestPlugin,
    labelDefault: '附件流水线自动化测试',
    descriptionDefault: '自动测试所有 附件类型×注入模式×模型类型 排列组合（24用例），通过 DOM 模拟真实上传流程，捕获前后端管线日志，验证注入模式规范化和多模态检测。',
    groupId: 'chat-timeline',
  },
  {
    id: 'chat-interaction-test',
    labelKey: 'debug_panel.plugin_chat_interaction_test',
    descriptionKey: 'debug_panel.plugin_chat_interaction_test_desc',
    component: ChatInteractionTestPlugin,
    labelDefault: '聊天交互自动化测试',
    descriptionDefault: '通过 DOM 模拟用户点击，自动测试 发送→流式中断→重试→换模型重试→编辑重发→重新发送→多变体 全链路（7步），验证请求体变化和 model icon 完整性。',
    groupId: 'chat-timeline',
  },
  {
    id: 'citation-test',
    labelKey: 'debug_panel.plugin_citation_test',
    descriptionKey: 'debug_panel.plugin_citation_test_desc',
    component: CitationTestPlugin,
    labelDefault: '引用生成与解引用测试',
    descriptionDefault: '自动测试引用解析全格式覆盖（中/英文类型名/图片后缀/边界）、Source Adapter 数据桥接（citations/toolOutput/混合块）、DOM 渲染验证和持久化往返完整性，共 5 步。',
    groupId: 'chat-timeline',
  },
  {
    id: 'multi-variant-test',
    labelKey: 'debug_panel.plugin_multi_variant_test',
    descriptionKey: 'debug_panel.plugin_multi_variant_test_desc',
    component: MultiVariantTestPlugin,
    labelDefault: '多变体自动化测试',
    descriptionDefault: '3 变体并行的 18 步全自动边缘测试：发送/取消/重试/切换/删除/持久化/DOM/Icon，通过 DOM 模拟真实用户操作。',
    groupId: 'chat-timeline',
  },
  {
    id: 'tool-call-lifecycle-debug',
    labelKey: 'debug_panel.plugin_tool_call_lifecycle',
    descriptionKey: 'debug_panel.plugin_tool_call_lifecycle_desc',
    component: ToolCallLifecycleDebugPlugin,
    labelDefault: '工具调用生命周期',
    descriptionDefault: '监控工具调用前后端完整链路：preparing→start→chunk→end/error，检测顺序异常和超时，可复制完整时序日志。',
    groupId: 'chat-timeline',
  },
  {
    id: 'exam-sheet-processing-debug',
    labelKey: 'debug_panel.plugin_exam_sheet_processing',
    descriptionKey: 'debug_panel.plugin_exam_sheet_processing_desc',
    component: ExamSheetProcessingDebugPlugin,
    labelDefault: '题目集识别生命周期',
    descriptionDefault: '监控两阶段题目集识别全链路：invoke→SessionCreated→OCR逐页→OCR完成→解析逐页→Completed/Failed，检测事件丢失和卡住，可复制完整时序日志。',
    groupId: 'exam-workflow',
  },
  {
    id: 'question-import-debug',
    labelKey: 'debug_panel.plugin_question_import',
    descriptionKey: 'debug_panel.plugin_question_import_desc',
    component: QuestionImportDebugPlugin,
    labelDefault: '题目导入流程调试',
    descriptionDefault: '监控流式题目导入全链路：预处理→页面渲染→VLM/OCR→配图提取→LLM结构化→分块解析→完成/失败，追踪各阶段耗时和进度百分比，检测卡住和异常，可复制/下载完整时序日志。',
    groupId: 'exam-workflow',
  },
];

for (const panel of OFFICIAL_DEBUG_PANELS) debugPanelContributions.announce(panel);
