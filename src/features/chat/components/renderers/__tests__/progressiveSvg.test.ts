import { describe, expect, it } from 'vitest';

import {
  buildSvgFrame,
  ensureSvgNamespace,
  readSvgIntrinsicSize,
  repairPartialSvg,
  sanitizeSvgMarkup,
} from '../progressiveSvg';

const FULL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <style>.bar { fill: #4a90d9; }</style>
  <g class="bars">
    <rect class="bar" x="10" y="20" width="30" height="80"/>
    <rect class="bar" x="50" y="40" width="30" height="60"/>
  </g>
  <text x="10" y="15">Sales &amp; growth</text>
</svg>`;

describe('repairPartialSvg', () => {
  it('returns null until the root <svg> start tag is complete', () => {
    expect(repairPartialSvg('')).toBeNull();
    expect(repairPartialSvg('<sv')).toBeNull();
    expect(repairPartialSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0')).toBeNull();
  });

  it('closes the root once its start tag is complete', () => {
    const out = repairPartialSvg('<svg viewBox="0 0 10 10">');
    expect(out).toEqual({ markup: '<svg viewBox="0 0 10 10"></svg>', complete: false, stableLength: 25 });
  });

  it('drops a half-written trailing tag and auto-closes open elements in order', () => {
    const source = '<svg viewBox="0 0 10 10"><g><rect x="1" y="1"/><path d="M0 0 L1';
    const out = repairPartialSvg(source)!;
    expect(out.markup).toBe('<svg viewBox="0 0 10 10"><g><rect x="1" y="1"/></g></svg>');
    expect(out.complete).toBe(false);
  });

  it('respects quoted ">" inside attribute values', () => {
    const out = repairPartialSvg('<svg viewBox="0 0 1 1"><g data-x="a>b"><circle r="1"/>')!;
    expect(out.markup).toBe('<svg viewBox="0 0 1 1"><g data-x="a>b"><circle r="1"/></g></svg>');
  });

  it('keeps partial text inside <text> but strips a half-written entity', () => {
    const out = repairPartialSvg('<svg viewBox="0 0 1 1"><text>Sales &am')!;
    expect(out.markup).toBe('<svg viewBox="0 0 1 1"><text>Sales </text></svg>');
  });

  it('holds back an unterminated <style> instead of rendering half a stylesheet', () => {
    const out = repairPartialSvg('<svg viewBox="0 0 1 1"><style>.a{fill:red}.b{fi')!;
    expect(out.markup).toBe('<svg viewBox="0 0 1 1"></svg>');
  });

  it('skips "<" inside a completed <style> block', () => {
    const source = '<svg viewBox="0 0 1 1"><style>/* a < b */ .x{}</style><rect/>';
    const out = repairPartialSvg(source)!;
    expect(out.markup).toBe(`${source}</svg>`);
  });

  it('ignores unterminated comments and leading XML prologue', () => {
    const out = repairPartialSvg('<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"><rect/><!-- note')!;
    expect(out.markup).toBe('<svg viewBox="0 0 1 1"><rect/></svg>');
  });

  it('reports complete and trims trailing content after the root closes', () => {
    const out = repairPartialSvg(`${FULL}\n\ntrailing prose`)!;
    expect(out.complete).toBe(true);
    expect(out.markup).toBe(FULL);
  });

  it('treats a self-closing root as complete', () => {
    expect(repairPartialSvg('<svg viewBox="0 0 1 1"/>')).toMatchObject({ complete: true });
  });

  it('only advances stableLength when another tag completes', () => {
    const a = repairPartialSvg('<svg viewBox="0 0 1 1"><rect x="1')!;
    const b = repairPartialSvg('<svg viewBox="0 0 1 1"><rect x="10" y')!;
    const c = repairPartialSvg('<svg viewBox="0 0 1 1"><rect x="10" y="2"/>')!;
    expect(a.stableLength).toBe(b.stableLength);
    expect(c.stableLength).toBeGreaterThan(b.stableLength);
  });

  it('produces renderable output for every prefix of a real document', () => {
    let lastStable = -1;
    for (let i = 0; i <= FULL.length; i += 1) {
      const out = repairPartialSvg(FULL.slice(0, i));
      if (!out) continue;
      expect(out.stableLength).toBeGreaterThanOrEqual(lastStable);
      lastStable = out.stableLength;
      const doc = new DOMParser().parseFromString(out.markup, 'image/svg+xml');
      expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    }
  });
});

describe('sanitizeSvgMarkup / buildSvgFrame', () => {
  it('strips scripts, event handlers and foreignObject', () => {
    const out = sanitizeSvgMarkup(
      '<svg viewBox="0 0 1 1" onload="alert(1)"><script>alert(2)</script><foreignObject><div>x</div></foreignObject><rect/></svg>',
    );
    expect(out).not.toMatch(/onload|<script|foreignObject/i);
    expect(out).toContain('<rect');
  });

  it('builds a sanitized frame from a streaming prefix', () => {
    const frame = buildSvgFrame('<svg viewBox="0 0 10 10"><circle r="2" onclick="x()"/><rect wid');
    expect(frame?.markup).toMatch(/^<svg[^>]*viewBox="0 0 10 10"/);
    expect(frame?.markup).toContain('<circle r="2"');
    expect(frame?.markup).not.toContain('onclick');
    expect(frame?.complete).toBe(false);
  });

  it('returns null when no svg root exists yet', () => {
    expect(buildSvgFrame('<?xml version="1.0"?>')).toBeNull();
  });
});

describe('readSvgIntrinsicSize', () => {
  it('prefers viewBox, then numeric width/height', () => {
    expect(readSvgIntrinsicSize('<svg viewBox="0,0,640,480" width="100%">')).toEqual({ width: 640, height: 480, source: 'viewBox' });
    expect(readSvgIntrinsicSize("<svg width='300px' height='150'>")).toEqual({ width: 300, height: 150, source: 'attributes' });
    expect(readSvgIntrinsicSize('<svg width="100%" height="100%">')).toBeNull();
    expect(readSvgIntrinsicSize('<svg viewBox="0 0 10')).toBeNull();
  });
});

describe('ensureSvgNamespace', () => {
  it('adds xmlns only when missing', () => {
    expect(ensureSvgNamespace('<svg viewBox="0 0 1 1"></svg>')).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>');
    expect(ensureSvgNamespace(FULL)).toBe(FULL);
  });
});
