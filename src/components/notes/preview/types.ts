/**
 * PreviewPanel 类型定义
 *
 * 根据文档18《统一学习资源管理器架构设计》和文档19 Prompt 8 定义
 */

import type { ReferenceNode, PreviewType } from '../types/reference';

/**
 * 预览面板 Props
 */
export interface PreviewPanelProps {
  /** 当前选中的节点 ID */
  nodeId: string | null;
  /** 节点类型 */
  nodeType: 'note' | 'reference' | 'folder' | null;
  /** 引用节点数据（当 nodeType='reference' 时提供） */
  referenceNode?: ReferenceNode;
  /** 自定义样式类 */
  className?: string;
}

/**
 * 预览状态
 */
export type PreviewStatus = 'idle' | 'loading' | 'success' | 'error';

/**
 * 预览内容数据
 */
export interface PreviewContent {
  /** 预览类型 */
  type: PreviewType;
  /** Markdown 内容（type='markdown' 时） */
  markdown?: string;
  /** PDF 路径（type='pdf' 时） */
  pdfPath?: string;
  /** PDF Base64 内容（type='pdf' 时，可选） */
  pdfBase64?: string;
  /** 文件大小（字节，供预览判断使用） */
  fileSize?: number;
  /** 图片 URL（type='image' 时） */
  imageUrl?: string;
}

/**
 * 基础预览组件 Props
 */
export interface BasePreviewProps {
  /** 是否正在加载 */
  loading?: boolean;
  /** 错误信息 */
  error?: string | null;
  /** 自定义样式类 */
  className?: string;
}

/**
 * Markdown 预览 Props
 */
export interface MarkdownPreviewProps extends BasePreviewProps {
  /** Markdown 内容 */
  content: string;
}

/**
 * PDF 预览 Props
 */
export interface PDFPreviewProps extends BasePreviewProps {
  /** PDF 文件路径 */
  filePath: string;
  /** PDF 文件名 */
  fileName?: string;
  /** PDF Base64 内容（可选） */
  base64Content?: string;
  /** 文件大小（字节，可选） */
  fileSize?: number;
}

/**
 * 图片预览 Props
 */
export interface ImagePreviewProps extends BasePreviewProps {
  /** 图片 URL */
  imageUrl: string;
  /** 图片标题 */
  title?: string;
}

/**
 * 音频预览 Props
 */
export interface AudioPreviewProps extends BasePreviewProps {
  /** 音频 URL */
  audioUrl: string;
  /** 音频标题 */
  title?: string;
  /** MIME 类型 */
  mimeType?: string;
}

/**
 * 视频预览 Props
 */
export interface VideoPreviewProps extends BasePreviewProps {
  /** 视频 URL */
  videoUrl: string;
  /** 视频标题 */
  title?: string;
  /** MIME 类型 */
  mimeType?: string;
  /** 封面图片 URL */
  posterUrl?: string;
}

// ============================================================================
// Exam Preview 类型（题目集预览）
// ============================================================================

/**
 * 题目集题目卡片数据
 */
export interface ExamCardPreviewData {
  /** 卡片 ID */
  cardId: string;
  /** 所在页码（0-indexed） */
  pageIndex: number;
  /** 题号标签 */
  questionLabel: string;
  /** 裁切图片路径 */
  croppedImagePath?: string;
  /** OCR 识别文本 */
  ocrText: string;
  /** 标签 */
  tags: string[];
  /** 关联的错题 ID 列表 */
  linkedMistakeIds?: string[];
}

/**
 * 题目集页面数据
 */
export interface ExamPagePreviewData {
  /** 页码（0-indexed） */
  pageIndex: number;
  /** 原始图片路径 */
  originalImagePath: string;
  /** 该页包含的题目卡片 */
  cards: ExamCardPreviewData[];
}

/**
 * 题目集预览数据
 */
export interface ExamPreviewData {
  /** 会话 ID */
  sessionId: string;
  /** 试卷名称 */
  examName?: string;
  /** 页面列表 */
  pages: ExamPagePreviewData[];
  /** 创建时间 */
  createdAt?: string;
}

/**
 * 题目集预览 Props
 */
export interface ExamPreviewProps extends BasePreviewProps {
  /** 会话 ID（用于获取题目集数据） */
  sessionId: string;
  /** 预加载的题目集数据（可选，用于避免重复请求） */
  examData?: ExamPreviewData;
  /** 点击题目卡片回调 */
  onCardClick?: (card: ExamCardPreviewData) => void;
  /** 查看详情回调 */
  onViewDetail?: (sessionId: string) => void;
}
