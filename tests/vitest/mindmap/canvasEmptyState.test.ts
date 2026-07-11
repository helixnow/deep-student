import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mind map canvas empty-state contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/features/mindmap/components/mindmap/MindMapCanvas.tsx'),
    'utf-8',
  );

  it('does not treat a root without children as an empty canvas', () => {
    expect(source).not.toContain('canvas.emptyTitle');
    expect(source).not.toContain('canvas.emptyHintBefore');
    expect(source).not.toContain('document.root.children.length === 0');
  });
});
