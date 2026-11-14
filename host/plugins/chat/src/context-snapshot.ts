/** Rust resource_types.rs:241-379. Plain JSON values retain serde's empty-field omission. */
import type { ContextRef, ContextSnapshot } from '../api.ts';
import type { SendContextRef } from '../../../../contracts/ipc/generated/_shared.ts';

export function newContextRef(resourceId: string, hash: string, typeId: string): ContextRef {
  return { resourceId, hash, typeId };
}
export function newContextSnapshot(): ContextSnapshot { return {}; }
export function addUserContextRef(snapshot: ContextSnapshot, ref: ContextRef): void {
  (snapshot.userRefs ??= []).push(ref);
}
export function addRetrievalContextRef(snapshot: ContextSnapshot, ref: ContextRef): void {
  (snapshot.retrievalRefs ??= []).push(ref);
}
export function contextSnapshotHasRefs(snapshot: ContextSnapshot): boolean {
  return (snapshot.userRefs?.length ?? 0) > 0 || (snapshot.retrievalRefs?.length ?? 0) > 0;
}
export function contextSnapshotAllResourceIds(snapshot: ContextSnapshot): string[] {
  return [...(snapshot.userRefs ?? []), ...(snapshot.retrievalRefs ?? [])].map(ref => ref.resourceId);
}
export function sendRefToContextRef(ref: SendContextRef): ContextRef {
  const modes = ref.injectModes;
  const injectModes: ContextRef['injectModes'] = modes == null ? undefined : {
    ...(modes.image == null ? {} : { image: modes.image.map(mode => typeof mode === 'string' ? mode : 'image' in mode ? 'image' : 'ocr') }),
    ...(modes.pdf == null ? {} : { pdf: modes.pdf.map(mode => typeof mode === 'string' ? mode : 'image' in mode ? 'image' : 'text' in mode ? 'text' : 'ocr') }),
  };
  return { ...newContextRef(ref.resourceId, ref.hash, ref.typeId),
    ...(ref.displayName == null ? {} : { displayName: ref.displayName }),
    ...(injectModes === undefined ? {} : { injectModes }) };
}
export function contextRefToSendRef(ref: ContextRef, formattedBlocks: SendContextRef['formattedBlocks']): SendContextRef {
  return { ...newContextRef(ref.resourceId, ref.hash, ref.typeId), formattedBlocks,
    ...(ref.displayName == null ? {} : { displayName: ref.displayName }),
    ...(ref.injectModes == null ? {} : { injectModes: structuredClone(ref.injectModes) }) };
}
