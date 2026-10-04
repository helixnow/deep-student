import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface InlineSmilesProps {
  smiles: string;
}

function isDarkTheme(): boolean {
  const root = document.documentElement;
  return root.classList.contains('dark') || root.getAttribute('data-theme') === 'dark';
}

/**
 * 正文内联分子结构。
 *
 * SmilesDrawer 仅在实际遇到 `\\smiles{...}` 时加载；绘制结果直接写入 React
 * 管理的 SVG 元素，不接受任意 SVG/HTML 字符串，也不会引入远程资源。
 */
export const InlineSmiles: React.FC<InlineSmilesProps> = ({ smiles }) => {
  const { t } = useTranslation('chatV2');
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const svg = svgRef.current;
    if (!svg) return undefined;

    svg.replaceChildren();
    setError(null);

    void import('smiles-drawer')
      .then(({ default: SmilesDrawer }) => {
        if (cancelled || !svgRef.current) return;

        const drawer = new SmilesDrawer.SvgDrawer({
          bondLength: 18,
          padding: 5,
          compactDrawing: true,
          terminalCarbons: false,
        });

        SmilesDrawer.parse(
          smiles,
          (tree) => {
            if (cancelled || !svgRef.current) return;
            try {
              drawer.draw(tree, svgRef.current, isDarkTheme() ? 'dark' : 'light');
            } catch (drawError) {
              if (!cancelled) setError(drawError instanceof Error ? drawError.message : t('renderer.smiles.drawFailed'));
            }
          },
          (parseError) => {
            if (!cancelled) setError(parseError instanceof Error ? parseError.message : t('renderer.smiles.invalid'));
          },
        );
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : t('renderer.smiles.loadFailed'));
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
    <span className="inline-smiles" title={structureLabel}>
      <svg ref={svgRef} role="img" aria-label={structureLabel} />
    </span>
  );
};
