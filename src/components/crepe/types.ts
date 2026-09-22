/**
 * Crepe 编辑器类型定义
 * 提供与笔记模块集成所需的接口
 */

import type { Crepe } from '@milkdown/crepe';
import type { AgentHighlightMeta } from './plugins/agentHighlight';
import type { CrepePluginsOptions } from './plugins';
import type { CrepeFormattingState } from './formattingState';
import type { BlockTransferService } from './blockTransfer/service';
import type { CrepeCommandId, CrepeCommandRequest } from './commandRegistry';

export interface CrepeDocumentCapabilities {
  noteId: string;
  /** Confirmed by the backend for this document, not inferred from its content. */
  writable: boolean;
  capabilities: readonly string[];
}
export interface CrepeUploadState { pending: number; running: number; failed: number; reviewLeases: number }

export interface CrepeBlockActionsHost {
  /** Live complete Markdown authority, never just the visible window. */
  getFullMarkdown(): string;
  isDocumentWindowed(): boolean;
  /** Must reject on failed persistence; called before publishing a copied link. */
  flushPendingSave(): Promise<void>;
  transferService: BlockTransferService;
  /** User-triggered format opt-in; returns the backend-confirmed current-page grant. */
  requestLayoutCapability?: () => Promise<CrepeDocumentCapabilities | null>;
}

export type CrepeSelectionSnapshot = {
  from: number;
  to: number;
};

export type CrepeAgentInsertResult = {
  from: number;
  to: number;
  cursor: number;
};

export type CrepeFullDocumentReplaceOptions = {
  /** Full-document OCC precondition. The write must be rejected if it no longer matches. */
  expectedMarkdown: string;
  /** Notes hosts carry the original editor identity/revision through to the window composer. */
  baseline?: FullDocumentSnapshot;
};

/** A live complete draft, including unsaved edits and the unloaded suffix. */
export interface FullDocumentSnapshot {
  readonly noteId: string;
  readonly revision: number;
  readonly markdown: string;
}

/** NotesCrepeEditor supplies this after the owning view extends the base editor API. */
export interface FullDocumentApi extends CrepeEditorApi {
  getFullDocument: () => FullDocumentSnapshot;
  /** Returns the actual canonical draft and its revision after confirmed persistence. */
  replaceFullDocument: (markdown: string, baseline: FullDocumentSnapshot) => Promise<FullDocumentSnapshot>;
}

export type { AgentHighlightMeta };

/**
 * Crepe 编辑器对外暴露的 API
 */
export interface CrepeEditorApi {
  /** Storage OCC token installed with this editor's current baseline. */
  getStorageUpdatedAt?: () => string | undefined;
  /** Backend-confirmed grant for the current note; null closes layout writes. */
  setDocumentCapabilities?: (capabilities: CrepeDocumentCapabilities | null) => void;
  /** Plain export of the loaded document. Windowed hosts must materialize first. */
  getPlainMarkdown?: () => string;
  /** Blocks user input/new uploads without cancelling in-flight uploads. Release in finally. */
  acquireReviewLease?: () => () => void;
  getUploadState?: () => CrepeUploadState;
  subscribeCommandState?: (listener: () => void) => () => void;
  executeCommand?: (command: CrepeCommandId, request?: CrepeCommandRequest) => Promise<boolean>;
  canExecuteCommand?: (command: CrepeCommandId, request?: CrepeCommandRequest) => boolean;
  /** Device picker routed through the same mapped upload lifecycle as paste/drop. */
  insertImageFromDevice?: () => void;
  /** Bind after NotesCrepeEditor has attached the complete-document/save lifecycle. */
  configureBlockActions?: (host: CrepeBlockActionsHost | null) => void;
  /** Root IDs only. Host materializes a windowed note before calling this. */
  focusBlock?: (blockId: string) => boolean;
  /** Format metadata for an upgraded but empty note; does not generate IDs on open. */
  setBlockIdentityMode?: (enabled: boolean) => void;
  /** 获取当前 Markdown 内容 */
  getMarkdown: () => string;
  
  /** 设置 Markdown 内容（会替换当前内容） */
  setMarkdown: (markdown: string) => boolean;

  /** Parse/serialize without mutation; rejects schema content loss before returning canonical Markdown. */
  normalizeMarkdown?: (markdown: string) => string;

  /** Live complete draft (not disk content), including edits in the loaded line window. */
  getFullMarkdown?: () => string;

  /** Notes host contract; base Crepe editors do not own a note or its save lifecycle. */
  getFullDocument?: FullDocumentApi['getFullDocument'];
  replaceFullDocument?: FullDocumentApi['replaceFullDocument'];

  /** Whether getMarkdown() currently represents only a visible prefix of the document. */
  isDocumentWindowed?: () => boolean;

  /**
   * Replace and persist the complete document under an OCC precondition. Workbench note
   * hosts provide this so ACR never treats a loaded prefix as the entire note.
   */
  replaceFullMarkdown?: (
    markdown: string,
    options: CrepeFullDocumentReplaceOptions,
  ) => Promise<boolean>;

  captureSelection?: () => CrepeSelectionSnapshot | null;

  restoreSelection?: (snapshot: CrepeSelectionSnapshot | null) => void;

  /** 编辑器 DOM 当前是否真实持有焦点；selection 快照本身不代表用户仍在编辑。 */
  hasFocus?: () => boolean;

  /**
   * 等待当前编辑内容持久化。Workbench ACR 会在返回 completed 前调用；
   * 基础 Crepe 可不实现，由承载笔记保存队列的上层注入。
   */
  flushPendingSave?: () => Promise<void>;
  
  /** 聚焦编辑器 */
  focus: () => void;
  
  /** 获取只读状态 */
  isReadonly: () => boolean;
  
  /** 设置只读状态 */
  setReadonly: (readonly: boolean) => void;
  
  /**
   * 滚动到指定标题。
   * @param matchesHeading 可选的精确匹配谓词（接收文档中标题的原始文本）；
   * 提供时优先于内置的 lowercase/trim 相等比较，供调用方注入
   * 全半角/中文标点等更强的规范化规则。未命中时仍回退内置模糊匹配。
   */
  scrollToHeading: (
    text: string,
    level: number,
    normalizedText?: string,
    matchesHeading?: (docHeadingText: string) => boolean,
    /**
     * C6：同级同文本标题的文档序号（0 起）。省略时取第一个精确匹配，
     * 避免旧行为在遍历中被后续同名标题覆盖、最终落到最后一个。
     */
    occurrence?: number
  ) => void;
  
  /** 获取底层 Crepe 实例（高级用法） */
  getCrepe: () => Crepe | null;
  
  /** 销毁编辑器 */
  destroy: () => Promise<void>;
  
  /**
   * 在光标位置插入文本
   * @param text 要插入的文本
   */
  insertAtCursor: (text: string) => void;

  /**
   * ACR agent 在指定文档位置插入文本（不抢焦点、不进用户 undo）— R1-12
   * @returns 实际插入区间；编辑器未就绪或写入失败返回 null
   */
  agentInsert: (text: string, pos: number) => CrepeAgentInsertResult | null;

  /**
   * 在块边界插入并解析 Markdown，保留列表、标题、公式等文档结构。
   * 失败时返回 null，调用方可降级为纯文本插入。
   */
  agentInsertMarkdown?: (markdown: string, pos: number) => CrepeAgentInsertResult | null;

  /**
   * ACR agent 透传 agentHighlight 插件 meta（caret / fadeRun / clearAll 等）
   */
  agentSignal: (meta: AgentHighlightMeta) => void;

  /**
   * ACR 4.0：破坏类直改（note_replace/note_set）后的变更区域演出。
   * 依据新旧 markdown 的首个差异定位段落：滚动到该处并做一次 agent-flash
   * 渐隐高亮；无法定位时退化为整个内容区一次轻微 opacity 脉冲。
   * 返回是否执行了演出（两文一致或编辑器未就绪时 false）。
   */
  agentFlashChange?: (previousMarkdown: string, nextMarkdown: string) => boolean;

  /** 文档可插入末尾位置（doc.content.size） */
  getDocEndPos: () => number;

  /**
   * 按标题文本定位插入点（标题节点之后）；未找到返回 null
   */
  resolveHeadingPos: (heading: string) => number | null;
  
  /**
   * 用前后标记包裹选中文本，如果没有选中则插入标记并将光标置于中间
   * @param before 前置标记
   * @param after 后置标记
   */
  wrapSelection: (before: string, after: string) => void;
  
  /**
   * 在当前行开头切换/插入前缀（用于标题、列表等块级格式）
   * @param prefix 前缀文本（如 "# ", "- " 等）
   */
  toggleLinePrefix: (prefix: string) => void;
  
  /**
   * 在当前位置插入新行并添加前缀
   * @param prefix 前缀文本
   */
  insertNewLineWithPrefix: (prefix: string) => void;
  
  // ===== Milkdown 命令 API（使用原生命令系统，正确渲染格式）=====
  
  /** 切换粗体 */
  toggleBold: () => void;
  
  /** 切换斜体 */
  toggleItalic: () => void;
  
  /** 切换删除线 */
  toggleStrikethrough: () => void;
  
  /** 切换行内代码 */
  toggleInlineCode: () => void;
  
  /** 设置标题级别 (1-6) */
  setHeading: (level: number) => void;
  
  /** 切换无序列表 */
  toggleBulletList: () => void;
  
  /** 切换有序列表 */
  toggleOrderedList: () => void;
  
  /** 切换任务列表 */
  toggleTaskList: () => void;
  
  /** 切换引用块 */
  toggleBlockquote: () => void;
  
  /** 插入分隔线 */
  insertHr: () => void;
  
  /** 插入代码块 */
  insertCodeBlock: () => void;
  
  /** 插入链接 */
  insertLink: (href?: string, text?: string) => void;
  
  /** 插入图片 */
  insertImage: (src?: string, alt?: string) => void;
  
  /** 插入表格 */
  insertTable: () => void;

  /**
   * 📱 在当前选区所属顶层块打开块操作菜单（Turn into / 复制 / 删除等）。
   * 触屏无 hover 块句柄，由移动端工具条的「块操作」入口调用；可选以兼容旧实现。
   */
  openBlockMenuAtSelection?: () => void;
}

/**
 * Crepe 编辑器组件属性
 */
export interface CrepeEditorProps {
  /** 初始 Markdown 内容 */
  defaultValue?: string;
  
  /** 内容变化回调 */
  onChange?: (markdown: string) => void;

  /**
   * 文档事务产生的同步通知（Markdown 序列化仍防抖）。
   * 宿主可据此在 onChange 的 250ms 合并窗口之前立即标记“有未保存修改”。
   */
  onDocumentChange?: () => void;

  /** Selection and stored marks, including formatting changes without document edits. */
  onFormattingChange?: (state: CrepeFormattingState) => void;
  
  /** 编辑器就绪回调，返回 API 对象 */
  onReady?: (api: CrepeEditorApi) => void;
  
  /** 编辑器销毁回调 */
  onDestroy?: () => void;
  
  /** 编辑器获得焦点回调 */
  onFocus?: () => void;
  
  /** 编辑器失去焦点回调 */
  onBlur?: () => void;
  
  /** 是否只读 */
  readonly?: boolean;
  
  /** 占位符文本 */
  placeholder?: string;
  
  /** 自定义类名 */
  className?: string;
  
  /** 笔记 ID（用于图片资产管理） */
  noteId?: string;

  /**
   * 扩展插件配置（传给 applyCrepePlugins）。
   * 宿主可覆盖 wikilink.resolve / getNotes、mention.searchNotes 等。
   */
  plugins?: CrepePluginsOptions;
}

/**
 * 图片上传配置
 */
export interface ImageUploadConfig {
  /** 上传处理函数 */
  onUpload: (file: File) => Promise<string>;
  
  /** 代理 URL（可选，用于跨域图片） */
  proxyDomURL?: (url: string) => Promise<string> | string;
}
