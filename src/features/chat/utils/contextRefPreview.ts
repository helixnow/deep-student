import type { ContextRef } from '../context/types';

export interface ContextRefPreviewDetail {
  resourceId: string;
  hash: string;
  typeId: string;
  path?: string;
}

export function buildContextRefPreviewDetail(
  ref: ContextRef,
  pathMap?: Record<string, string>
): ContextRefPreviewDetail {
  return {
    resourceId: ref.resourceId,
    hash: ref.hash,
    typeId: ref.typeId,
    path: pathMap?.[ref.resourceId],
  };
}

export function dispatchContextRefPreview(
  ref: ContextRef,
  pathMap?: Record<string, string>
): void {
  document.dispatchEvent(new CustomEvent('context-ref:preview', {
    detail: buildContextRefPreviewDetail(ref, pathMap),
    bubbles: true,
  }));
}
