// Rust: src/chat_v2/tools/chatanki_executor.rs 的 VlmFull 遮挡接线。
// 坐标协议 / marker 编解码归 L16 `anki@1`；本模块只做「真实坐标优先，网格兜底」。
import {
  buildOcclusionDraftMarker, buildOcclusionDraftMarkerFromSpec, defaultOcclusionConfig,
  parseOcclusionBoxesFromVlm, stripOcclusionBoxesBlocks,
} from '../../anki/api.ts';
import type { VfsContextRefData } from '../api.ts';
import { rustTrim } from '../../../platform/util/text.ts';

/**
 * 优先使用 VLM 输出并通过校验的归一化坐标；解析/校验失败才把 IMAGE_DESC 转为
 * 可编辑网格草稿。坐标协议块始终从正文剥离，避免垃圾卡。
 */
export function appendVlmFullOcclusionDraft(
  visualMd: string, refData: VfsContextRefData,
): string {
  const groundedSpec = parseOcclusionBoxesFromVlm(visualMd);
  const cleanVisualMd = stripOcclusionBoxesBlocks(visualMd);
  const imageRef = refData.refs.find((ref) => ref.type === 'image')?.sourceId;
  if (imageRef === undefined || rustTrim(imageRef).length === 0) return cleanVisualMd;

  const cfg = defaultOcclusionConfig();
  let marker: string | null = null;
  if (groundedSpec !== null) {
    groundedSpec.imageRef = imageRef;
    marker = buildOcclusionDraftMarkerFromSpec(groundedSpec, cfg);
  }
  if (marker === null) marker = buildOcclusionDraftMarker(imageRef, cleanVisualMd, cfg);
  if (marker === null) return cleanVisualMd;
  return `${cleanVisualMd}\n\n${marker}`;
}
