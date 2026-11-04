import React, { useRef } from 'react';
import { renderInkBoard } from '../../../src/features/ink/boardRenderer';
import type { Camera } from '../../../src/features/ink/camera';
import type { InkBoardObject, InkBoardSurface } from '../../../src/features/ink/types';
import {
  BOARD_RENDER_DPR,
  BOARD_VIEWPORT,
  boardCamera,
  boardChunks,
  boardObjects,
  boardSurface,
  gridBoardCamera,
  gridBoardSurface,
  linedBoardCamera,
  linedBoardSurface,
  negativeBoardCamera,
  panZoomBoardCamera,
  signedBoardCamera,
} from './boardRendererFixtures';

type RenderTarget = 'main' | 'blank';

export function InkBoardRendererHarness() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const blankCanvasRef = useRef<HTMLCanvasElement>(null);

  const render = (
    target: RenderTarget,
    surface: InkBoardSurface,
    objects: InkBoardObject[],
    camera: Camera,
  ) => {
    const canvas = (target === 'blank' ? blankCanvasRef : canvasRef).current;
    if (!canvas) return;
    const result = renderInkBoard(canvas, surface, objects, camera, { dpr: BOARD_RENDER_DPR });
    canvas.dataset.boardRenderStats = JSON.stringify({
      camera,
      result,
      surfaceBounds: surface.bounds,
      objectCount: objects.length,
      chunkCount: boardChunks.length,
    });
  };

  return (
    <div>
      <canvas
        data-testid="board-canvas"
        ref={canvasRef}
        style={{ width: BOARD_VIEWPORT.width, height: BOARD_VIEWPORT.height, display: 'block' }}
      />
      <canvas
        data-testid="board-blank-canvas"
        ref={blankCanvasRef}
        style={{ width: BOARD_VIEWPORT.width, height: BOARD_VIEWPORT.height, display: 'block' }}
      />
      <button data-testid="board-render-main" onClick={() => render('main', boardSurface, boardObjects, boardCamera)}>
        Render main board
      </button>
      <button
        data-testid="board-render-negative"
        onClick={() => render('main', boardSurface, boardObjects, negativeBoardCamera)}
      >
        Render negative world
      </button>
      <button
        data-testid="board-render-pan-zoom"
        onClick={() => render('main', boardSurface, boardObjects, panZoomBoardCamera)}
      >
        Render pan zoom
      </button>
      <button data-testid="board-render-zorder" onClick={() => render('main', boardSurface, boardObjects, boardCamera)}>
        Render z-order chunks
      </button>
      <button
        data-testid="board-render-grid"
        onClick={() => render('main', gridBoardSurface, boardObjects, gridBoardCamera)}
      >
        Render grid origin
      </button>
      <button
        data-testid="board-render-lined"
        onClick={() => render('main', linedBoardSurface, boardObjects, linedBoardCamera)}
      >
        Render lined ruling
      </button>
      <button
        data-testid="board-render-signed"
        onClick={() => render('main', boardSurface, boardObjects, signedBoardCamera)}
      >
        Render signed crop
      </button>
      <button
        data-testid="board-render-signed-blank"
        onClick={() => render('blank', boardSurface, [], signedBoardCamera)}
      >
        Render signed crop blank
      </button>
    </div>
  );
}
