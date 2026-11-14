// Port of dstu-browser/src/browser/window/macos_surface_clip.rs signature logic.
// The CALayer/CoreGraphics mask application itself is native macOS code (F2 shell).

export interface LogicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MaskSignature =
  | { kind: 'clear' }
  | { kind: 'shaped'; bounds: LogicalRect; visualOcclusions: LogicalRect[] };

/** An empty mask stays correct across host resizes; shaped masks depend on bounds. */
export function maskSignatureFromBoundsAndOcclusions(
  bounds: LogicalRect, visualOcclusions: readonly LogicalRect[],
): MaskSignature {
  if (visualOcclusions.length === 0) return { kind: 'clear' };
  return {
    kind: 'shaped',
    bounds: { ...bounds },
    visualOcclusions: visualOcclusions.map(rect => ({ ...rect })),
  };
}

export function maskSignaturesEqual(left: MaskSignature, right: MaskSignature): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'clear' || right.kind === 'clear') return true;
  if (left.bounds.x !== right.bounds.x || left.bounds.y !== right.bounds.y
    || left.bounds.width !== right.bounds.width || left.bounds.height !== right.bounds.height) return false;
  if (left.visualOcclusions.length !== right.visualOcclusions.length) return false;
  return left.visualOcclusions.every((rect, index) => {
    const other = right.visualOcclusions[index]!;
    return rect.x === other.x && rect.y === other.y && rect.width === other.width && rect.height === other.height;
  });
}

export function logicalRectContains(rect: LogicalRect, point: { x: number; y: number }): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width
    && point.y >= rect.y && point.y < rect.y + rect.height;
}
