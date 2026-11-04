import type { InkBoardChunk, InkBoardObject, InkBoardSurface, InkRect } from '../../../src/features/ink/types';

/**
 * Frozen board render inputs for the render-bridge CT.
 *
 * The paged fixtures cannot be reused: their highlighter sits at world y=90,
 * outside the signed crop y=[-80, 80]. These objects stay inside the crop so
 * the staged PNG proves crop-origin translation, not just world drawing.
 */
export const renderBridgeBoardSurface: InkBoardSurface = {
  kind: 'board',
  page_id: 'render-bridge-board',
  ruling: 'blank',
  bounds: { x: -10_000_000, y: -10_000_000, width: 20_000_000, height: 20_000_000 },
};

export const renderBridgeBoardCrop: InkRect = { x: -100, y: -80, width: 200, height: 160 };
export const renderBridgeBoardLongEdge = 200;
export const renderBridgeBoardOutput = { width: 200, height: 160 };

const negativeOriginStroke: InkBoardObject = {
  id: 'board-negative-origin-stroke',
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

const aiRegion: InkBoardObject = {
  id: 'board-ai-red-region',
  author: 'ai',
  created_at: 2,
  z_index: 2,
  content: {
    kind: 'region_highlight',
    rect: { x: 40, y: 30, width: 20, height: 20 },
    color: '#ff0000ff',
    width: 2,
  },
};

const highlighter: InkBoardObject = {
  id: 'board-green-highlighter',
  author: 'user',
  created_at: 3,
  z_index: 3,
  content: {
    kind: 'stroke',
    samples: [
      { x: 40, y: 70, pressure: 0.5 },
      { x: 60, y: 70, pressure: 0.5 },
    ],
    style: { tool: 'highlighter', color: '#00ff0080', width: 12, pressure_enabled: false },
  },
};

export const renderBridgeBoardChunks: InkBoardChunk[] = [
  { schema_version: 2, chunk_id: 'board-chunk-negative-origin', objects: [negativeOriginStroke] },
  { schema_version: 2, chunk_id: 'board-chunk-ai-and-highlighter', objects: [aiRegion, highlighter] },
];

/** Same crop and surface with no chunks; used only as the blank control. */
export const renderBridgeBlankBoardChunks: InkBoardChunk[] = [];

/** Crop-relative device pixels for a 200x160 PNG at one world unit per pixel. */
export const renderBridgeBoardPixelProbes = {
  background: { x: 10, y: 10 },
  negativeOriginStroke: { x: 65, y: 45 },
  aiRect: { x: 150, y: 120 },
  highlighter: { x: 150, y: 150 },
};
