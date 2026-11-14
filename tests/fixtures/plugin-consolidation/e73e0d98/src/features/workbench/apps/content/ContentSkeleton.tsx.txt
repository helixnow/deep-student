/**
 * ContentSkeleton — 资源窗口的类型化加载骨架屏（O17）
 *
 * 覆盖在 UnifiedAppPanel / MindMapContentView 之上的加载态占位层，
 * 按资源类型渲染五种变体：
 * - pdf（textbook / exam）：工具条 + 纸面页卡 + 第二页 peek，暗示页流；
 * - text（note / translation / essay）：标题 + 段落行，对齐编辑器版心；
 * - image：模糊色斑占位 + 取景框剪影（骨架淡出即「模糊占位渐显」）；
 * - generic（file）：文档图标 + 名称/元数据行；
 * - mindmap：中心节点 + 放射分支画布示意。
 *
 * 生命周期由宿主（ContentAppWindow / MindmapAppWindow）经 useContentLoadPhase
 * 驱动：loading（呈现）→ fading（淡出）→ done（卸载）。
 * 动效纪律（§1.5）：仅 opacity 动画 + 静态 transform 定位；样式见 ContentSkeleton.css。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import './ContentSkeleton.css';

export type ContentSkeletonVariant = 'pdf' | 'text' | 'image' | 'generic' | 'mindmap';

/** 资源类型 → 骨架变体（未知类型回退 generic） */
export function skeletonVariantForType(type: string): ContentSkeletonVariant {
  switch (type) {
    case 'textbook':
    case 'exam':
      return 'pdf';
    case 'note':
    case 'translation':
    case 'essay':
      return 'text';
    case 'image':
      return 'image';
    case 'mindmap':
      return 'mindmap';
    default:
      return 'generic';
  }
}

export interface ContentSkeletonProps {
  variant: ContentSkeletonVariant;
  /** loading = 呈现；fading = 淡出中（done 时由宿主卸载本组件） */
  phase: 'loading' | 'fading';
  /** 屏幕阅读器播报文案；缺省「正在加载内容…」 */
  label?: string;
  className?: string;
}

/** 骨架基元；--wb-content-bone-i 驱动脉冲错峰 */
const Bone: React.FC<{ index: number; className?: string }> = ({ index, className }) => (
  <div
    className={cn('wb-content-skeleton__bone', className)}
    style={{ '--wb-content-bone-i': index } as React.CSSProperties}
  />
);

const PdfSkeleton: React.FC = () => (
  <>
    <div className="wb-content-skeleton__toolbar">
      <Bone index={0} className="wb-content-skeleton__chip" />
      <Bone index={1} className="wb-content-skeleton__chip" />
      <Bone index={2} className="wb-content-skeleton__chip--wide wb-content-skeleton__chip" />
      <Bone index={3} className="wb-content-skeleton__chip wb-content-skeleton__chip--end" />
    </div>
    <div className="wb-content-skeleton__pages">
      <div className="wb-content-skeleton__page">
        <Bone index={4} className="wb-content-skeleton__line wb-content-skeleton__line--w62" />
        <Bone index={5} className="wb-content-skeleton__line" />
        <Bone index={6} className="wb-content-skeleton__line wb-content-skeleton__line--w94" />
        <Bone index={7} className="wb-content-skeleton__line wb-content-skeleton__line--w88" />
        <Bone index={8} className="wb-content-skeleton__line wb-content-skeleton__line--w94" />
        <Bone index={9} className="wb-content-skeleton__line wb-content-skeleton__line--w75" />
        <Bone index={10} className="wb-content-skeleton__line wb-content-skeleton__line--w88" />
        <Bone index={11} className="wb-content-skeleton__line wb-content-skeleton__line--w40" />
      </div>
      <div className="wb-content-skeleton__page wb-content-skeleton__page--peek">
        <Bone index={12} className="wb-content-skeleton__line wb-content-skeleton__line--w75" />
        <Bone index={13} className="wb-content-skeleton__line wb-content-skeleton__line--w94" />
      </div>
    </div>
  </>
);

const TextSkeleton: React.FC = () => (
  <div className="wb-content-skeleton__doc">
    <Bone index={0} className="wb-content-skeleton__title" />
    <Bone index={1} className="wb-content-skeleton__line" />
    <Bone index={2} className="wb-content-skeleton__line wb-content-skeleton__line--w94" />
    <Bone index={3} className="wb-content-skeleton__line wb-content-skeleton__line--w88" />
    <Bone index={4} className="wb-content-skeleton__line wb-content-skeleton__line--w62" />
    <div className="wb-content-skeleton__gap" />
    <Bone index={5} className="wb-content-skeleton__line wb-content-skeleton__line--w94" />
    <Bone index={6} className="wb-content-skeleton__line" />
    <Bone index={7} className="wb-content-skeleton__line wb-content-skeleton__line--w75" />
    <Bone index={8} className="wb-content-skeleton__line wb-content-skeleton__line--w25" />
  </div>
);

const ImageSkeleton: React.FC = () => (
  <div className="wb-content-skeleton__image-stage">
    <div className="wb-content-skeleton__image-blob" />
    <Bone index={0} className="wb-content-skeleton__image-frame" />
  </div>
);

const GenericSkeleton: React.FC = () => (
  <div className="wb-content-skeleton__file">
    <Bone index={0} className="wb-content-skeleton__file-icon" />
    <Bone index={1} className="wb-content-skeleton__file-name" />
    <Bone index={2} className="wb-content-skeleton__file-meta" />
  </div>
);

const MindmapSkeleton: React.FC = () => (
  <div className="wb-content-skeleton__map">
    <Bone index={0} className="wb-content-skeleton__map-edge wb-content-skeleton__map-edge--e1" />
    <Bone index={1} className="wb-content-skeleton__map-edge wb-content-skeleton__map-edge--e2" />
    <Bone index={2} className="wb-content-skeleton__map-edge wb-content-skeleton__map-edge--e3" />
    <Bone index={3} className="wb-content-skeleton__map-edge wb-content-skeleton__map-edge--e4" />
    <Bone index={4} className="wb-content-skeleton__map-node wb-content-skeleton__map-node--root" />
    <Bone index={5} className="wb-content-skeleton__map-node wb-content-skeleton__map-node--n1" />
    <Bone index={6} className="wb-content-skeleton__map-node wb-content-skeleton__map-node--n2" />
    <Bone index={7} className="wb-content-skeleton__map-node wb-content-skeleton__map-node--n3" />
    <Bone index={8} className="wb-content-skeleton__map-node wb-content-skeleton__map-node--n4" />
  </div>
);

const VARIANT_BODY: Record<ContentSkeletonVariant, React.FC> = {
  pdf: PdfSkeleton,
  text: TextSkeleton,
  image: ImageSkeleton,
  generic: GenericSkeleton,
  mindmap: MindmapSkeleton,
};

export const ContentSkeleton: React.FC<ContentSkeletonProps> = ({
  variant,
  phase,
  label,
  className,
}) => {
  const { t } = useTranslation('workbench');
  const statusLabel = label ?? t('workbench:content.loading');
  const Body = VARIANT_BODY[variant];

  return (
    <div
      className={cn('wb-content-skeleton', className)}
      data-wb-content-skeleton
      data-variant={variant}
      data-phase={phase}
      role="status"
      aria-live="polite"
      aria-label={statusLabel}
    >
      <span className="sr-only">{statusLabel}</span>
      <div className="wb-content-skeleton__canvas" aria-hidden="true">
        <Body />
      </div>
    </div>
  );
};

export default ContentSkeleton;
