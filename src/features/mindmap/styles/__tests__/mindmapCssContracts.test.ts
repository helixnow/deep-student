import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readCss = (relPath: string) => readFileSync(resolve(process.cwd(), relPath), 'utf8');

const MODULE_FILES = [
  'src/features/mindmap/styles/modules/mm-tokens.css',
  'src/features/mindmap/styles/modules/mm-toolbar.css',
  'src/features/mindmap/styles/modules/mm-canvas.css',
  'src/features/mindmap/styles/modules/mm-nodes-edges.css',
  'src/features/mindmap/styles/modules/mm-overlays.css',
  'src/features/mindmap/styles/modules/mm-outline.css',
  'src/features/mindmap/styles/modules/mm-mobile.css',
] as const;

const SATELLITE_FILES = [
  'src/features/mindmap/styles/ghost-proposal.css',
  'src/features/mindmap/styles/mn5-excerpt.css',
  'src/features/mindmap/styles/node-edge-enhancements.css',
  'src/features/mindmap/styles/canvas-enhancements.css',
  'src/features/mindmap/styles/canvas-interactions.css',
  'src/features/mindmap/styles/outline-enhancements.css',
  'src/features/mindmap/components/mindmap/edges/associationEdge.css',
  'src/features/mindmap/components/mindmap/nodes/nodes.css',
] as const;

const ALL_MINDMAP_CSS = [
  'src/features/mindmap/styles/mindmap.css',
  ...MODULE_FILES,
  ...SATELLITE_FILES,
] as const;

describe('mindmap CSS modular architecture & visual contracts', () => {
  it('mindmap.css is a thin entrypoint importing all 7 modular sheets', () => {
    const entry = readCss('src/features/mindmap/styles/mindmap.css');
    for (const mod of [
      'mm-tokens.css',
      'mm-toolbar.css',
      'mm-canvas.css',
      'mm-nodes-edges.css',
      'mm-overlays.css',
      'mm-outline.css',
      'mm-mobile.css',
    ]) {
      expect(entry).toContain(`@import './modules/${mod}';`);
    }
  });

  it('keeps .mm-toolbar in document flow on desktop so it never occludes banners or association hints', () => {
    const toolbarCss = readCss('src/features/mindmap/styles/modules/mm-toolbar.css');
    expect(toolbarCss).toMatch(/\.mm-toolbar\s*\{[\s\S]*?position:\s*relative;/);
    expect(toolbarCss).not.toMatch(/\.mm-toolbar\s*\{[\s\S]*?position:\s*absolute;/);
    expect(toolbarCss).not.toContain('top: 10px');
  });

  it('uses var(--wb-glass-blur, none) instead of hardcoded backdrop-filter blur()', () => {
    for (const file of ALL_MINDMAP_CSS) {
      const css = readCss(file);
      expect(css, file).not.toMatch(/backdrop-filter:\s*blur\(/i);
    }
  });

  it('anchors shadows on --shadow-base with zero --foreground fallbacks and zero hardcoded chrome hex/rgba colors', () => {
    for (const file of ALL_MINDMAP_CSS) {
      const css = readCss(file);
      expect(css, file).not.toContain('var(--shadow-base, var(--foreground))');
      expect(css, file).not.toMatch(/rgba\(\s*15\s*,\s*23\s*,\s*42/i);
      expect(css, file).not.toMatch(/rgba\(\s*30\s*,\s*58\s*,\s*52/i);
      expect(css, file).not.toMatch(/#2A6F5E|#1E3A34|#5EA893|#D2E8E2|#9E3B30|#E5857B|#FFFFFF\b/i);
    }
  });

  it('keeps total !important declarations across all mindmap CSS <= 8', () => {
    let totalImportant = 0;
    for (const file of ALL_MINDMAP_CSS) {
      const cssWithoutComments = readCss(file).replace(/\/\*[\s\S]*?\*\//g, '');
      const matches = cssWithoutComments.match(/!important/g);
      totalImportant += matches ? matches.length : 0;
    }
    expect(totalImportant).toBeLessThanOrEqual(8);
  });

  it('unifies edit-mode anti-squeeze in mm-nodes-edges.css and FSRS mastery micro-dots in nodes.css without duplicate conflicts', () => {
    const nodesEdgesCss = readCss('src/features/mindmap/styles/modules/mm-nodes-edges.css');
    const nodesCss = readCss('src/features/mindmap/components/mindmap/nodes/nodes.css');

    // Edit-mode width/height/z-index unlock lives exclusively in mm-nodes-edges.css
    // without inflating short nodes (min-width: 60px + --mm-edit-min-width) or shrinking wrapped nodes
    expect(nodesEdgesCss).toContain(":has([data-node-editing='true'])");
    expect(nodesEdgesCss).toContain('width: max-content !important');
    expect(nodesEdgesCss).toContain('height: auto !important');
    expect(nodesEdgesCss).toContain('z-index: 40 !important');
    expect(nodesEdgesCss).toContain('max-width: 600px');
    expect(nodesEdgesCss).toContain('--mm-edit-min-width');
    expect(nodesEdgesCss).toContain('max-width: max(300px, var(--mm-edit-min-width, 300px))');
    expect(nodesEdgesCss).not.toContain('min-width: 140px');
    expect(nodesEdgesCss).not.toContain('max-width: 320px');
    expect(nodesCss).not.toContain(":has([data-node-editing='true'])");

    // FSRS mastery dot lives exclusively in nodes.css using --mm-mastery-* semantic tokens
    expect(nodesEdgesCss).not.toContain('[data-mastery-status]');
    expect(nodesEdgesCss).not.toContain('.mm-mastery-dot');
    expect(nodesCss).toContain(".mm-mastery-dot[data-mastery-status='due']");
    expect(nodesCss).toContain('var(--mm-mastery-due');
    expect(nodesCss).toContain(".mm-mastery-dot[data-mastery-status='struggling']");
    expect(nodesCss).toContain('var(--mm-mastery-struggling');
    expect(nodesCss).toContain(".mm-mastery-dot[data-mastery-status='learning']");
    expect(nodesCss).toContain('var(--mm-mastery-learning');
    expect(nodesCss).toContain(".mm-mastery-dot[data-mastery-status='mastered']");
    expect(nodesCss).toContain('var(--mm-mastery-mastered');
    expect(nodesCss).toContain('.dark .mm-mastery-dot');
  });

  it('routes direct tree edge hover through --mm-hover-* CSS variables with zero dead inline-overridden rules', () => {
    const nodesEdgesCss = readCss('src/features/mindmap/styles/modules/mm-nodes-edges.css');
    const enhancementsCss = readCss('src/features/mindmap/styles/node-edge-enhancements.css');

    expect(nodesEdgesCss).toMatch(
      /\.mindmap-container\s+\.react-flow__edge:hover\s*\{[\s\S]*?--mm-hover-stroke:/,
    );
    expect(nodesEdgesCss).toContain('--mm-hover-stroke-width: 2.25px');
    expect(nodesEdgesCss).toContain('--mm-hover-opacity: 1');
    expect(enhancementsCss).not.toContain('.react-flow__edge:hover .tree-edge');
  });

  it('hides minimap under @container mm-root (max-width: 760px)', () => {
    const toolbarCss = readCss('src/features/mindmap/styles/modules/mm-toolbar.css');
    expect(toolbarCss).toMatch(/@container\s+mm-root\s*\(max-width:\s*760px\)/);
    expect(toolbarCss).toContain('.react-flow__minimap');
    expect(toolbarCss).not.toContain('.mm-shortcut-hint-pill');
  });

  it('includes coarse pointer 44px touch targets and prefers-reduced-motion in excerpt, ghost, and association CSS', () => {
    for (const file of [
      'src/features/mindmap/styles/mn5-excerpt.css',
      'src/features/mindmap/styles/ghost-proposal.css',
      'src/features/mindmap/components/mindmap/edges/associationEdge.css',
    ]) {
      const css = readCss(file);
      expect(css, file).toContain('@media (pointer: coarse)');
      expect(css, file).toContain('@media (prefers-reduced-motion: reduce)');
    }
  });
});
