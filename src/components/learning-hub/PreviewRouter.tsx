/**
 * PreviewRouter - 统一预览路由器
 *
 * 根据 previewType 路由到不同的预览组件
 * 用于学习资源管理器中统一的资源预览
 *
 * 路由表：
 * | previewType | 组件 | 说明 |
 * |-------------|------|------|
 * | markdown | MarkdownPreview | 笔记、文本内容 |
 * | pdf | PDFPreview | 教材、PDF 文档 |
 * | image | ImagePreview | 图片附件 |
 * | exam | ExamPreview | 题目集识别结果 |
 * | mindmap | MindMapEmbed | 知识导图（嵌入式只读预览）|
 * | audio | AudioPreview | 音频文件（MP3/WAV/OGG 等）|
 * | video | VideoPreview | 视频文件（MP4/WEBM/MOV 等）|
 * | docx | DocxPreview | Word 文档（通过 FileContentView）|
 * | xlsx | XlsxPreview | Excel 表格（通过 FileContentView）|
 * | pptx | PptxPreview | PPT 演示（通过 FileContentView）|
 * | text | TextPreview | 纯文本（通过 FileContentView）|
 * | none | UnsupportedState | 不支持预览 |
 *
 * ★ 2026-01 清理：移除 'card' 类型（错题系统废弃）
 * ★ 2026-01 添加：docx/xlsx/pptx/text 类型支持
 * ★ 2026-01-30 添加：mindmap 类型支持（知识导图预览）
 * ★ 2026-01-30 添加：audio/video 类型支持（音视频预览）
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';
import { FileQuestion } from 'lucide-react';

// 预览组件导入
import { MarkdownPreview } from '../notes/preview/MarkdownPreview';
import { PDFPreview } from '../notes/preview/PDFPreview';
import { ImagePreview } from '../notes/preview/ImagePreview';
import { ExamPreview } from '../notes/preview/ExamPreview';
import { AudioPreview } from '../notes/preview/AudioPreview';
import { VideoPreview } from '../notes/preview/VideoPreview';
import { MindMapEmbed } from '../mindmap/components/mindmap/MindMapEmbed';

// 类型导入
import type { PreviewType } from '../notes/types/reference';
import type {
  ExamPreviewData,
  ExamCardPreviewData,
} from '../notes/preview/types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 预览数据联合类型
 * ★ 2026-01 清理：移除 mistakeData（错题系统废弃）
 * ★ 2026-01 添加：audioUrl/videoUrl（音视频预览）
 */
export interface PreviewRouterData {
  /** Markdown 内容 */
  markdown?: string;
  /** PDF 文件路径 */
  pdfPath?: string;
  /** PDF 文件名 */
  pdfFileName?: string;
  /** 图片 URL */
  imageUrl?: string;
  /** 图片标题 */
  imageTitle?: string;
  /** 题目集会话 ID */
  examSessionId?: string;
  /** 题目集数据（可选预加载） */
  examData?: ExamPreviewData;
  /** 文本内容（用于 text 类型） */
  textContent?: string;
  /** 知识导图 ID（用于 mindmap 类型） */
  mindmapId?: string;
  /** 音频 URL */
  audioUrl?: string;
  /** 音频标题 */
  audioTitle?: string;
  /** 音频 MIME 类型 */
  audioMimeType?: string;
  /** 视频 URL */
  videoUrl?: string;
  /** 视频标题 */
  videoTitle?: string;
  /** 视频 MIME 类型 */
  videoMimeType?: string;
  /** 视频封面图片 URL */
  videoPosterUrl?: string;
}

/**
 * PreviewRouter Props
 * ★ 2026-01 清理：移除 onViewMistakeDetail（错题系统废弃）
 */
export interface PreviewRouterProps {
  /** 预览类型 */
  previewType: PreviewType;
  /** 预览数据 */
  data: PreviewRouterData;
  /** 是否加载中 */
  loading?: boolean;
  /** 错误信息 */
  error?: string | null;
  /** 自定义样式类 */
  className?: string;
  /** 题目集题目卡片点击回调 */
  onExamCardClick?: (card: ExamCardPreviewData) => void;
  /** 题目集查看详情回调 */
  onViewExamDetail?: (sessionId: string) => void;
}

// ============================================================================
// 不支持预览状态组件
// ============================================================================

/**
 * 不支持预览状态
 */
const UnsupportedState: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation(['notes']);

  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center gap-4 p-6 text-center',
        className
      )}
    >
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
        <FileQuestion className="h-8 w-8 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-foreground">
          {t('notes:previewPanel.unsupported.title')}
        </h3>
        <p className="max-w-xs text-xs text-muted-foreground">
          {t('notes:previewPanel.unsupported.description')}
        </p>
      </div>
    </div>
  );
};

/**
 * ★ 2026-01 新增：文档类型提示状态
 * 用于 docx/xlsx/pptx/text 等需要完整面板查看的文档类型
 */
const DocumentHintState: React.FC<{ 
  className?: string;
  docType: 'docx' | 'xlsx' | 'pptx' | 'text';
}> = ({ className, docType }) => {
  const { t } = useTranslation(['notes', 'learningHub']);
  
  const typeLabelKeys: Record<string, string> = {
    docx: 'learningHub:docPreview.docTypeDocx',
    xlsx: 'learningHub:docPreview.docTypeXlsx',
    pptx: 'learningHub:docPreview.docTypePptx',
    text: 'learningHub:docPreview.docTypeText',
  };
  
  const typeLabel = t(typeLabelKeys[docType] || 'learningHub:docPreview.docTypeText');

  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center gap-4 p-6 text-center',
        className
      )}
    >
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
        <FileQuestion className="h-8 w-8 text-primary" />
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">
          {typeLabel}
        </h3>
        <p className="max-w-xs text-xs text-muted-foreground">
          {t('learningHub:docPreview.documentHint')}
        </p>
      </div>
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

/**
 * PreviewRouter 主组件
 *
 * 根据 previewType 路由到对应的预览组件
 * ★ 2026-01 清理：移除 'card' 分支（错题系统废弃）
 * ★ 2026-01 添加：docx/xlsx/pptx/text 分支（显示提示信息）
 */
export const PreviewRouter: React.FC<PreviewRouterProps> = ({
  previewType,
  data,
  loading = false,
  error = null,
  className,
  onExamCardClick,
  onViewExamDetail,
}) => {
  // 提取文档类型的文本预览渲染逻辑（docx/xlsx/pptx/text 共用）
  const renderTextPreview = (docType: 'text' | 'docx' | 'xlsx' | 'pptx') => {
    return data.textContent ? (
      <div className={cn('h-full overflow-auto', className)}>
        <pre className="whitespace-pre-wrap text-sm p-4 m-0 min-h-full">{data.textContent}</pre>
      </div>
    ) : (
      <DocumentHintState className={className} docType={docType} />
    );
  };

  switch (previewType) {
    case 'markdown':
      return (
        <MarkdownPreview
          content={data.markdown || ''}
          loading={loading}
          error={error}
          className={className}
        />
      );

    case 'pdf':
      return (
        <PDFPreview
          filePath={data.pdfPath || ''}
          fileName={data.pdfFileName}
          loading={loading}
          error={error}
          className={className}
        />
      );

    case 'image':
      return (
        <ImagePreview
          imageUrl={data.imageUrl || ''}
          title={data.imageTitle}
          loading={loading}
          error={error}
          className={className}
        />
      );

    case 'exam':
      return data.examSessionId ? (
        <ExamPreview
          sessionId={data.examSessionId}
          examData={data.examData}
          onCardClick={onExamCardClick}
          onViewDetail={onViewExamDetail}
          loading={loading}
          error={error}
          className={className}
        />
      ) : (
        <UnsupportedState className={className} />
      );

    // ★ 2026-01 改进：文档类型通过 UnifiedAppPanel -> FileContentView 处理
    // PreviewRouter 仅用于内联预览，这些类型应该打开完整的应用面板
    // ★ 文档类型：textContent 为纯文本提取，使用 <pre> 渲染（非 Markdown）
    case 'docx':
      return renderTextPreview('docx');
    case 'xlsx':
      return renderTextPreview('xlsx');
    case 'pptx':
      return renderTextPreview('pptx');
    case 'text':
      return renderTextPreview('text');

    // ★ 2026-01-30: 添加知识导图预览支持
    case 'mindmap':
      return data.mindmapId ? (
        <MindMapEmbed
          mindmapId={data.mindmapId}
          className={className}
          showOpenButton={true}
        />
      ) : (
        <UnsupportedState className={className} />
      );

    // ★ 2026-01-30: 添加音频预览支持
    case 'audio':
      return (
        <AudioPreview
          audioUrl={data.audioUrl || ''}
          title={data.audioTitle}
          mimeType={data.audioMimeType}
          loading={loading}
          error={error}
          className={className}
        />
      );

    // ★ 2026-01-30: 添加视频预览支持
    case 'video':
      return (
        <VideoPreview
          videoUrl={data.videoUrl || ''}
          title={data.videoTitle}
          mimeType={data.videoMimeType}
          posterUrl={data.videoPosterUrl}
          loading={loading}
          error={error}
          className={className}
        />
      );

    case 'none':
    default:
      return <UnsupportedState className={className} />;
  }
};

export default PreviewRouter;
