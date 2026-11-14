/**
 * Image Occlusion review & preview renderer (`hide-one` / `hide-all`).
 *
 * Wraps the shared `OcclusionCardStage` rendered by `AnkiTemplateCardFace` so
 * review sessions, library previews, and standalone component tests share one
 * exact Mineral occlusion stage and 1-click `ds-anchor://v1/...` source reveal.
 */
import React from 'react';
import {
  OcclusionCardStage,
  type OcclusionCardStageProps,
  type OcclusionStudyMode,
} from '@/components/anki/AnkiTemplateCardFace';

export type { OcclusionStudyMode };
export type ImageOcclusionCardViewProps = OcclusionCardStageProps;

export const ImageOcclusionCardView: React.FC<ImageOcclusionCardViewProps> = (props) => (
  <OcclusionCardStage {...props} />
);

export default ImageOcclusionCardView;
