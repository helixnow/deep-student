import React, { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { useTranslation } from 'react-i18next';

interface InlineSmilesProps {
  smiles: string;
}

const sanitizeSvg = (svg: string) =>
  DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
    FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'embed', 'object'],
    FORBID_ATTR: ['xlink:href'],
  });

const readIsDarkTheme = (): boolean =>
  typeof document !== 'undefined' &&
  (document.documentElement.classList.contains('dark') ||
    document.documentElement.getAttribute('data-theme') === 'dark' ||
    Boolean(document.body?.classList.contains('dark')));

/**
 * 正文内联分子结构。
 *
 * 复用已有的 OpenChemLib（与块级 molecule-2d 共用同一按需 chunk），仅在遇到 `\\smiles{...}` 时
 * 动态加载，并将生成的 SVG 经 DOMPurify 净化后写入受控容器，不引入远程资源。
 */
export const InlineSmiles: React.FC<InlineSmilesProps> = ({ smiles }) => {
  const { t } = useTranslation('chatV2');
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDark, setIsDark] = useState<boolean>(readIsDarkTheme);

  useEffect(() => {
    if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return;
    const sync = () => setIsDark(readIsDarkTheme());
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return undefined;

    host.replaceChildren();
    setError(null);

    const trimmed = smiles.trim();
    if (!trimmed) {
      setError(t('renderer.smiles.invalid'));
      return undefined;
    }

    void import('openchemlib')
      .then((ocl: any) => {
        if (cancelled || !hostRef.current) return;
        let molecule: any;
        try {
          molecule = ocl.Molecule.fromSmiles(trimmed);
        } catch (parseError) {
          if (!cancelled) {
            setError(parseError instanceof Error ? parseError.message : t('renderer.smiles.invalid'));
          }
          return;
        }
        if (!molecule || typeof molecule.getAllAtoms === 'function' && molecule.getAllAtoms() === 0) {
          if (!cancelled) setError(t('renderer.smiles.invalid'));
          return;
        }
        try {
          const rawSvg = molecule.toSVG(240, 120, undefined, {
            autoCrop: true,
            autoCropMargin: 8,
          });
          hostRef.current.innerHTML = sanitizeSvg(rawSvg);
        } catch (drawError) {
          if (!cancelled) {
            setError(drawError instanceof Error ? drawError.message : t('renderer.smiles.drawFailed'));
          }
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : t('renderer.smiles.loadFailed'));
        }
      });

    return () => {
      cancelled = true;
    };
    // t 仅用于错误兜底文案；不随语言切换重绘结构式
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smiles]);

  if (error) {
    return (
      <code className="inline-smiles inline-smiles-error" title={error}>
        {'\\smiles{'}{smiles}{'}'}
      </code>
    );
  }

  const structureLabel = t('renderer.smiles.structureLabel', { smiles });
  return (
    <span
      ref={hostRef}
      className="inline-smiles"
      role="img"
      aria-label={structureLabel}
      title={structureLabel}
      style={isDark ? { filter: 'invert(0.88) hue-rotate(180deg)' } : undefined}
    />
  );
};
