import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';

export type RichCodeRendererKind =
  | 'vega-lite'
  | 'dot'
  | 'abc'
  | 'wavedrom'
  | 'molecule-2d'
  | 'molecule-3d'
  | 'geojson';

interface RichCodeRendererProps {
  kind: RichCodeRendererKind;
  source: string;
}

const sanitizeSvg = (svg: string) => DOMPurify.sanitize(svg, {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ['style'],
  FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'embed', 'object'],
  FORBID_ATTR: ['xlink:href'],
});

function rejectRemoteValue(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectRemoteValue);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'url' && typeof child === 'string') {
      throw new Error('该渲染器只接受内嵌数据，不允许远程 URL。');
    }
    rejectRemoteValue(child);
  }
}

function geoJsonSvg(source: string): string {
  const input = JSON.parse(source) as any;
  const geometries: Array<{ type: string; coordinates: any }> = [];
  const add = (item: any) => {
    if (!item) return;
    if (item.type === 'FeatureCollection') item.features?.forEach(add);
    else if (item.type === 'Feature') add(item.geometry);
    else if (item.type === 'GeometryCollection') item.geometries?.forEach(add);
    else if (item.type && item.coordinates) geometries.push(item);
  };
  add(input);
  if (!geometries.length) throw new Error('GeoJSON 中没有可显示的几何对象。');

  const points: Array<[number, number]> = [];
  const collect = (coords: any) => {
    if (typeof coords?.[0] === 'number' && typeof coords?.[1] === 'number') points.push(coords);
    else if (Array.isArray(coords)) coords.forEach(collect);
  };
  geometries.forEach((geometry) => collect(geometry.coordinates));
  if (!points.length) throw new Error('GeoJSON 坐标无效。');
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const width = 520; const height = 300; const padding = 18;
  const xScale = (x: number) => padding + ((x - minX) / (maxX - minX || 1)) * (width - padding * 2);
  const yScale = (y: number) => height - padding - ((y - minY) / (maxY - minY || 1)) * (height - padding * 2);
  const path = (coords: Array<[number, number]>, close = false) => coords
    .map(([x, y], index) => `${index ? 'L' : 'M'}${xScale(x).toFixed(2)} ${yScale(y).toFixed(2)}`)
    .join(' ') + (close ? ' Z' : '');
  const elements: string[] = [];
  const draw = (geometry: any) => {
    const { type, coordinates } = geometry;
    if (type === 'Point') elements.push(`<circle cx="${xScale(coordinates[0])}" cy="${yScale(coordinates[1])}" r="4" />`);
    else if (type === 'MultiPoint') coordinates.forEach((point: [number, number]) => draw({ type: 'Point', coordinates: point }));
    else if (type === 'LineString') elements.push(`<path d="${path(coordinates)}" />`);
    else if (type === 'MultiLineString') coordinates.forEach((line: Array<[number, number]>) => draw({ type: 'LineString', coordinates: line }));
    else if (type === 'Polygon') coordinates.forEach((ring: Array<[number, number]>) => elements.push(`<path class="geojson-area" d="${path(ring, true)}" />`));
    else if (type === 'MultiPolygon') coordinates.forEach((polygon: Array<Array<[number, number]>>) => draw({ type: 'Polygon', coordinates: polygon }));
  };
  geometries.forEach(draw);
  return `<svg class="geojson-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="GeoJSON map"><rect width="100%" height="100%" rx="8" /><g>${elements.join('')}</g></svg>`;
}

/**
 * 所有模型驱动的块级可视化在用户主动点击“运行”后才懒加载：无外链、无脚本执行。
 */
export function RichCodeRenderer({ kind, source }: RichCodeRendererProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    host.replaceChildren();
    setError(null);

    const render = async () => {
      try {
        if (kind === 'vega-lite') {
          const spec = JSON.parse(source);
          rejectRemoteValue(spec);
          const embedModule = await import('vega-embed');
          if (disposed) return;
          const embed: any = (embedModule as any).default ?? embedModule;
          const result = await embed(host, spec, { actions: false, renderer: 'svg', defaultStyle: false });
          cleanup = () => result.finalize?.();
        } else if (kind === 'dot') {
          if (/\b(?:image|href|URL)\s*=/i.test(source)) throw new Error('DOT 图不允许引用外部资源。');
          const { instance } = await import('@viz-js/viz');
          const viz = await instance();
          if (disposed) return;
          host.replaceChildren(viz.renderSVGElement(source));
        } else if (kind === 'abc') {
          const abcModule: any = await import('abcjs');
          if (disposed) return;
          const abcjs = abcModule.default ?? abcModule;
          abcjs.renderAbc(host, source, { responsive: 'resize', add_classes: false });
        } else if (kind === 'wavedrom') {
          const waveJson = JSON.parse(source);
          const waveModule: any = await import('wavedrom');
          if (disposed) return;
          const wave = waveModule.default ?? waveModule;
          wave.renderWaveElement(0, waveJson, host, wave.waveSkin);
        } else if (kind === 'molecule-2d') {
          const firstRecord = source.split(/^\s*\$\$\$\$\s*$/m)[0];
          const ocl: any = await import('openchemlib');
          if (disposed) return;
          const molecule = ocl.Molecule.fromMolfile(firstRecord);
          host.innerHTML = sanitizeSvg(molecule.toSVG(460, 280));
        } else if (kind === 'molecule-3d') {
          const module: any = await import('3dmol');
          if (disposed) return;
          const mol3d = module.default ?? module;
          const viewer = mol3d.createViewer(host, { backgroundColor: 'white' });
          viewer.addModel(source, 'pdb');
          viewer.setStyle({}, { stick: {}, cartoon: { opacity: 0.82 } });
          viewer.zoomTo();
          viewer.render();
          cleanup = () => viewer.clear?.();
        } else {
          host.innerHTML = sanitizeSvg(geoJsonSvg(source));
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : '渲染失败。');
      }
    };
    void render();
    return () => { disposed = true; cleanup?.(); };
  }, [kind, source]);

  return (
    <div className={`rich-code-renderer rich-code-renderer--${kind}`} data-no-screen-swipe>
      {error ? <div className="rich-code-renderer-error">{error}</div> : <div ref={hostRef} className="rich-code-renderer-host" />}
    </div>
  );
}
