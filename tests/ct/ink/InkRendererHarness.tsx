import React, { useMemo, useRef } from 'react';
import { renderInkPage } from '../../../src/features/ink/renderer';
import type { InkObject, InkPage, InkPageRef, InkRect } from '../../../src/features/ink/types';

const pageRef: InkPageRef = {
  page_id: 'fixture-page',
  width: 120,
  height: 160,
  background: { kind: 'blank', ruling: 'blank' },
  page_blob_hash: 'fixture-page-hash',
};

const objects: InkObject[] = [
  {
    id: 'fixture-pen', author: 'user', created_at: 1,
    content: {
      kind: 'stroke',
      samples: [{ x: 15, y: 20, pressure: 0.5 }, { x: 105, y: 20, pressure: 0.5 }],
      style: { tool: 'pen', color: '#000000', width: 8, pressure_enabled: false },
    },
  },
  {
    id: 'fixture-highlighter', author: 'user', created_at: 2,
    content: {
      kind: 'stroke',
      samples: [{ x: 15, y: 45, pressure: 0.5 }, { x: 105, y: 45, pressure: 0.5 }],
      style: { tool: 'highlighter', color: '#ffff0080', width: 12, pressure_enabled: false },
    },
  },
  {
    id: 'fixture-bottom-region', author: 'ai', created_at: 3,
    content: { kind: 'region_highlight', rect: { x: 20, y: 140, width: 30, height: 15 }, color: '#0000ffff', width: 2 },
  },
  {
    id: 'fixture-rect', author: 'user', created_at: 4,
    content: { kind: 'rect', rect: { x: 60, y: 70, width: 20, height: 20 }, color: '#00ff00', width: 3 },
  },
  {
    id: 'fixture-ellipse', author: 'user', created_at: 5,
    content: { kind: 'ellipse', rect: { x: 85, y: 70, width: 20, height: 20 }, color: '#00ff00', width: 3 },
  },
  {
    id: 'fixture-arrow', author: 'ai', created_at: 6,
    content: { kind: 'arrow', from: { x: 20, y: 100 }, to: { x: 50, y: 100 }, color: '#0000ff', width: 3 },
  },
  {
    id: 'fixture-pressure', author: 'user', created_at: 7,
    content: {
      kind: 'stroke', samples: [{ x: 10, y: 125, pressure: 0.2 }, { x: 40, y: 125, pressure: 0.8 }],
      style: { tool: 'pen', color: '#000000', width: 8, pressure_enabled: true },
    },
  },
  {
    id: 'fixture-pressure-dot', author: 'user', created_at: 8,
    content: {
      kind: 'stroke', samples: [{ x: 12, y: 105, pressure: 0.5 }],
      style: { tool: 'pen', color: '#000000', width: 8, pressure_enabled: true },
    },
  },
  {
    id: 'fixture-single-pass-highlighter', author: 'user', created_at: 9,
    content: {
      kind: 'stroke', samples: [{ x: 60, y: 116, pressure: 0.5 }, { x: 100, y: 116, pressure: 0.5 }],
      style: { tool: 'highlighter', color: '#ff00ff80', width: 12, pressure_enabled: false },
    },
  },
  {
    id: 'fixture-overlapping-highlighter', author: 'user', created_at: 9,
    content: {
      kind: 'stroke', samples: [{ x: 60, y: 130, pressure: 0.5 }, { x: 100, y: 130, pressure: 0.5 }, { x: 60, y: 130, pressure: 0.5 }],
      style: { tool: 'highlighter', color: '#ff00ff80', width: 12, pressure_enabled: false },
    },
  },
];

const page: InkPage = { schema_version: 1, page_id: pageRef.page_id, objects };

export function InkRendererHarness() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const background = useMemo(() => {
    const fixture = document.createElement('canvas');
    fixture.width = pageRef.width;
    fixture.height = pageRef.height;
    const context = fixture.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    context.fillStyle = '#eeeeee';
    context.fillRect(0, 0, fixture.width, fixture.height);
    context.fillStyle = '#ff0000';
    context.fillRect(0, 70, 10, 10);
    return fixture;
  }, []);

  const render = (crop?: InkRect, scale?: number, max_pixels?: number) => {
    if (canvasRef.current) renderInkPage(canvasRef.current, pageRef, page, { background, crop, scale, max_pixels });
  };

  const renderText = () => {
    if (!canvasRef.current) return;
    const textPage: InkPage = {
      ...page,
      objects: [{
        id: 'plain-text', author: 'ai', created_at: 4,
        content: { kind: 'text', rect: { x: 60, y: 80, width: 50, height: 30 }, text: '<b>x</b> wraps as text', font_size: 10, color: '#000000' },
      }],
    };
    renderInkPage(canvasRef.current, pageRef, textPage, { background });
  };

  return (
    <div>
      <canvas data-testid="ink-render-canvas" ref={canvasRef} />
      <button data-testid="ink-render-full" onClick={() => render()}>Render full page</button>
      <button data-testid="ink-render-crop" onClick={() => render({ x: 50, y: 10, width: 60, height: 60 })}>Render crop</button>
      <button data-testid="ink-render-scaled" onClick={() => render(undefined, 2, 10_000)}>Render scaled</button>
      <button data-testid="ink-render-text" onClick={renderText}>Render plain text</button>
      <button data-testid="ink-render-literal" onClick={() => {
        if (!canvasRef.current) return;
        renderInkPage(canvasRef.current, pageRef, { ...page, objects: [] }, { background });
        const context = canvasRef.current.getContext('2d');
        if (!context) throw new Error('Canvas 2D context is unavailable');
        context.save();
        context.beginPath();
        context.rect(60, 80, 50, 30);
        context.clip();
        context.fillStyle = '#000000';
        context.font = '10px system-ui, sans-serif';
        context.textBaseline = 'top';
        const referenceLines = ['<b>x</b>', 'wraps as', 'text'];
        for (let index = 0; index < referenceLines.length; index += 1) {
          context.fillText(referenceLines[index], 60, 80 + index * 12, 50);
        }
        context.restore();
      }}>Render literal canvas text</button>
    </div>
  );
}
