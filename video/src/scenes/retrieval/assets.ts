import { useEffect, useState } from 'react';
import { continueRender, delayRender } from 'remotion';
import { PHOTO_SRC } from '../../ui/chat';
import { HITS } from './beats';
import { makeCardCanvas, makeHitCanvas, setPhotoImages, type CardTex, type CardType } from './textures';
import { VARIANTS } from './archive';

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

/** 渲染倍率（`--scale=2` 出 4K 时 devicePixelRatio = 2）：3D 画布与命中贴图跟着它走，否则 4K 版这几段是 1080p 放大。 */
export const renderDpr = () => Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);

export type ArchiveAssets = {
  cards: Record<CardType, CardTex[]>;
  hits: CardTex[];
  hitUrls: string[];
  /** 终幕平放的那一页教材：在屏幕上比命中纸片大，单独画一张高分贴图 */
  page: CardTex;
};

const FONTS = [
  '16px "PingFang SC"',
  '500 16px "PingFang SC"',
  '600 16px "PingFang SC"',
  '16px "Songti SC"',
  '16px "Kaiti SC"',
  'italic 16px "Times New Roman"',
  '10px "SF Mono"',
];

let STORE: ArchiveAssets | null = null;
let pending: Promise<ArchiveAssets> | null = null;

/** 纸片纹理必须在字体就绪后绘制（canvas 不会回头重排），全局只画一次。 */
const load = () =>
  (pending ??= Promise.all([...FONTS.map((f) => document.fonts.load(f, '中ξφ′Ag1')), Promise.all(PHOTO_SRC.map(loadImage)).then(setPhotoImages)])
    .catch(() => undefined)
    .then(() => {
      const cards = Object.fromEntries(
        (Object.keys(VARIANTS) as CardType[]).map((type) => [
          type,
          Array.from({ length: VARIANTS[type] }, (_, v) => makeCardCanvas(type, v * 11 + type.length * 3)),
        ]),
      ) as Record<CardType, CardTex[]>;
      const hits = HITS.map((h) => makeHitCanvas(h.kind, 640 * renderDpr()));
      const page = makeHitCanvas('textbook', 1280 * renderDpr());
      STORE = { cards, hits, hitUrls: hits.map((h) => h.canvas.toDataURL('image/png')), page };
      return STORE;
    }));

/**
 * 纹理就绪后再放行截图，并多等两帧：3D 画布要等拿到纹理才挂载（见 Archive3D / KnowledgeTerrain），
 * 挂载后 ThreeCanvas 自己的 delayRender 才登记上；放行得太早会截到一张空画布。
 */
const release = (handle: number | null) => {
  if (handle === null) return;
  requestAnimationFrame(() => requestAnimationFrame(() => continueRender(handle)));
};

export const useArchiveAssets = () => {
  const [assets, setAssets] = useState<ArchiveAssets | null>(STORE);
  const [handle] = useState(() => (STORE ? null : delayRender('archive textures')));
  useEffect(() => {
    if (STORE) {
      setAssets(STORE);
      release(handle);
      return;
    }
    load().then((s) => {
      setAssets(s);
      release(handle);
    });
  }, [handle]);
  return assets;
};
