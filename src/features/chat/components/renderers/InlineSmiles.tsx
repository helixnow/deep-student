import React, { useEffect, useRef, useState } from 'react';

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
              if (!cancelled) setError(drawError instanceof Error ? drawError.message : '结构式绘制失败');
            }
          },
          (parseError) => {
            if (!cancelled) setError(parseError instanceof Error ? parseError.message : '无效的 SMILES');
          },
        );
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : '结构式渲染器加载失败');
      });

    return () => {
      cancelled = true;
    };
  }, [smiles]);

  if (error) {
    return (
      <code className="inline-smiles inline-smiles-error" title={error}>
        {'\\smiles{'}{smiles}{'}'}
      </code>
    );
  }

  return (
    <span className="inline-smiles" title={`分子结构：${smiles}`}>
      <svg ref={svgRef} role="img" aria-label={`分子结构：${smiles}`} />
    </span>
  );
};
