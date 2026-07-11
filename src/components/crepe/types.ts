/**
 * Crepe 编辑器类型定义
 * 提供与笔记模块集成所需的接口
 */

import type { Crepe } from '@milkdown/crepe';
import type { AgentHighlightMeta } from './plugins/agentHighlight';

export type CrepeSelectionSnapshot = {
  from: number;
  to: number;
};

export type CrepeAgentInsertResult = {
  from: number;
  to: number;
  cursor: number;
};

export type { AgentHighlightMeta };

/**
 * Crepe 编辑器对外暴露的 API
 */
export interface CrepeEditorApi {
  /** 获取当前 Markdown 内容 */
  getMarkdown: () => string;
  
  /** 设置 Markdown 内容（会替换当前内容） */
  setMarkdown: (markdown: string) => void;

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
  
  /** 滚动到指定标题 */
  scrollToHeading: (text: string, level: number, normalizedText?: string) => void;
  
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
   * @returns 插入后的新光标位置；失败返回原 pos
   */
  agentInsert: (text: string, pos: number) => number;

  /**
   * 在块边界插入并解析 Markdown，保留列表、标题、公式等文档结构。
   * 失败时返回 null，调用方可降级为纯文本插入。
   */
  agentInsertMarkdown?: (markdown: string, pos: number) => CrepeAgentInsertResult | null;

  /**
   * ACR agent 透传 agentHighlight 插件 meta（caret / fadeRun / clearAll 等）
   */
  agentSignal: (meta: AgentHighlightMeta) => void;

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
}

/**
 * Crepe 编辑器组件属性
 */
export interface CrepeEditorProps {
  /** 初始 Markdown 内容 */
  defaultValue?: string;
  
  /** 内容变化回调 */
  onChange?: (markdown: string) => void;
  
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
