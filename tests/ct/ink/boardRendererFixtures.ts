import { panCameraBy, zoomCameraAt, type Camera } from '../../../src/features/ink/camera';
import type { InkBoardBounds, InkBoardObject, InkBoardSurface } from '../../../src/features/ink/types';

export const BOARD_VIEWPORT = { width: 320, height: 240 };
/** Passed to the renderer to prove the board caps DPR at 2. */
export const BOARD_RENDER_DPR = 3;

/** A million-unit board whose logical bounds must never become canvas pixels. */
const BOARD_BOUNDS: InkBoardBounds = {
  x: -10_000_000,
  y: -10_000_000,
  width: 20_000_000,
  height: 20_000_000,
};

export const boardSurface: InkBoardSurface = {
  kind: 'board',
  page_id: 'board-renderer-fixture',
  ruling: 'blank',
  bounds: BOARD_BOUNDS,
};

export const gridBoardSurface: InkBoardSurface = {
  ...boardSurface,
  page_id: 'board-renderer-grid-fixture',
  ruling: 'grid',
};

export const linedBoardSurface: InkBoardSurface = {
  ...boardSurface,
  page_id: 'board-renderer-lined-fixture',
  ruling: 'lined',
};

export const boardCamera: Camera = { x: 0, y: 0, zoom: 1 };
export const negativeBoardCamera: Camera = { x: -50, y: -40, zoom: 1 };
export const gridBoardCamera: Camera = { x: -48, y: -24, zoom: 1 };
/** World spacing 24 maps to device spacing 24 at DPR 2 (24 * 0.5 * 2). */
export const linedBoardCamera: Camera = { x: 0, y: 0, zoom: 0.5 };
export const signedBoardCamera: Camera = { x: -160, y: -120, zoom: 0.5 };
/** Built only from the production camera helpers: pan first, then anchored zoom. */
export const panZoomBoardCamera: Camera = zoomCameraAt(
  panCameraBy({ x: 0, y: 0, zoom: 1 }, 40, 20),
  { x: 60, y: 60 },
  2,
);

/** Signed-world pen stroke that is only visible when the camera moves left/up. */
const negativeWorldStroke: InkBoardObject = {
  id: 'negative-world-stroke',
  author: 'user',
  created_at: 1,
  z_index: 1,
  content: {
    kind: 'stroke',
    samples: [
      { x: -45, y: -35, pressure: 0.5 },
      { x: -20, y: -35, pressure: 0.5 },
    ],
    style: { tool: 'pen', color: '#000000', width: 4, pressure_enabled: false },
  },
};

/** Outside every tested viewport; its chunk must be culled, not scaled into the canvas. */
const farOffscreenObject: InkBoardObject = {
  id: 'far-offscreen-rect',
  author: 'ai',
  created_at: 2,
  z_index: 99,
  content: {
    kind: 'rect',
    rect: { x: 1_000_000, y: 1_000_000, width: 100, height: 100 },
    color: '#ff0000ff',
    width: 4,
  },
};

/** World-origin dot drawn above the world-anchored grid ruling. */
const originDot: InkBoardObject = {
  id: 'grid-origin-dot',
  author: 'user',
  created_at: 3,
  z_index: 50,
  content: {
    kind: 'stroke',
    samples: [{ x: 0, y: 0, pressure: 0.5 }],
    style: { tool: 'pen', color: '#000000', width: 12, pressure_enabled: false },
  },
};

/** Probe point used to compare renderer pixels with worldToScreen under pan/zoom. */
const cameraProbePen: InkBoardObject = {
  id: 'camera-probe-pen',
  author: 'user',
  created_at: 4,
  z_index: 60,
  content: {
    kind: 'stroke',
    samples: [{ x: 20, y: 30, pressure: 0.5 }],
    style: { tool: 'pen', color: '#000000', width: 8, pressure_enabled: false },
  },
};

const arrowOverPen: InkBoardObject = {
  id: 'arrow-over-pen',
  author: 'ai',
  created_at: 5,
  z_index: 40,
  content: {
    kind: 'arrow',
    from: { x: 40, y: 110 },
    to: { x: 60, y: 110 },
    color: '#0000ffff',
    width: 4,
  },
};

const penOverHighlighter: InkBoardObject = {
  id: 'pen-over-highlighter',
  author: 'user',
  created_at: 6,
  z_index: 30,
  content: {
    kind: 'stroke',
    samples: [
      { x: 40, y: 90, pressure: 0.5 },
      { x: 60, y: 90, pressure: 0.5 },
    ],
    style: { tool: 'pen', color: '#000000', width: 4, pressure_enabled: false },
  },
};

const highlighter: InkBoardObject = {
  id: 'highlighter-under-pen',
  author: 'user',
  created_at: 7,
  z_index: 20,
  content: {
    kind: 'stroke',
    samples: [
      { x: 40, y: 90, pressure: 0.5 },
      { x: 60, y: 90, pressure: 0.5 },
    ],
    style: { tool: 'highlighter', color: '#00ff0080', width: 12, pressure_enabled: false },
  },
};

const aiRegion: InkBoardObject = {
  id: 'ai-region',
  author: 'ai',
  created_at: 8,
  z_index: 10,
  content: {
    kind: 'region_highlight',
    rect: { x: 40, y: 60, width: 20, height: 20 },
    color: '#ff0000ff',
    width: 2,
  },
};

const penAlone: InkBoardObject = {
  id: 'pen-alone',
  author: 'user',
  created_at: 9,
  z_index: 35,
  content: {
    kind: 'stroke',
    samples: [
      { x: 40, y: 110, pressure: 0.5 },
      { x: 60, y: 110, pressure: 0.5 },
    ],
    style: { tool: 'pen', color: '#000000', width: 4, pressure_enabled: false },
  },
};

/**
 * Chunks are flattened in this order, which conflicts with z_index on purpose:
 * the top-z chunk is first and the base-z chunk is last, so only the renderer's
 * z_index sort can produce the expected cross-chunk overlap.
 */
export const boardChunks: InkBoardObject[][] = [
  [farOffscreenObject, arrowOverPen, penOverHighlighter, originDot, cameraProbePen],
  [highlighter],
  [aiRegion, penAlone],
  [negativeWorldStroke],
];

export const boardObjects: InkBoardObject[] = boardChunks.flat();
