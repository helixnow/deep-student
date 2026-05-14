import { useEffect, useState, useCallback, useRef } from 'react';
import { ArrowsOut, Copy, Check } from '@phosphor-icons/react';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { Switch } from '@/components/ui/shad/Switch';

interface CSSRuleInfo {
  selector: string;
  property: string;
  value: string;
  source: string;
  specificity: string;
}

interface ElementMeasurement {
  selector: string;
  found: boolean;
  rect?: DOMRect;
  computedStyle?: {
    position: string;
    top: string;
    left: string;
    right: string;
    bottom: string;
    width: string;
    height: string;
    marginTop: string;
    paddingTop: string;
    zIndex: string;
  };
  cssRules?: CSSRuleInfo[];
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
}

interface LayoutAnalysis {
  timestamp: number;
  viewport: {
    width: number;
    height: number;
  };
  elements: ElementMeasurement[];
  overlaps: Array<{
    element1: string;
    element2: string;
    overlapHeight: number;
  }>;
  gaps: Array<{
    between: string;
    gapHeight: number;
  }>;
}

const SELECTORS_TO_MONITOR = [
  '.app-container',
  '.app-body',
  '.app-content',
  '.content-header',
  '.content-body',
  '.page-container',
  'main.app-content > .content-body > .page-container',
];

export default function LayoutDebugPlugin() {
  const [analysis, setAnalysis] = useState<LayoutAnalysis | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [copied, setCopied] = useState(false);
  const intervalRef = useRef<number | null>(null);

  const measureElements = useCallback((): LayoutAnalysis => {
    const elements: ElementMeasurement[] = [];
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
    };

    // 获取所有样式表
    const getAllCSSRules = (element: Element, properties: string[]): CSSRuleInfo[] => {
      const rules: CSSRuleInfo[] = [];
      const sheets = Array.from(document.styleSheets);
      
      for (const sheet of sheets) {
        try {
          const cssRules = Array.from(sheet.cssRules || []);
          for (const rule of cssRules) {
            if (rule instanceof CSSStyleRule) {
              if (element.matches(rule.selectorText)) {
                for (const prop of properties) {
                  const value = rule.style.getPropertyValue(prop);
                  const priority = rule.style.getPropertyPriority(prop);
                  if (value) {
                    rules.push({
                      selector: rule.selectorText,
                      property: prop,
                      value: value + (priority ? ' !' + priority : ''),
                      source: sheet.href || 'inline',
                      specificity: rule.selectorText,
                    });
                  }
                }
              }
            }
          }
        } catch (e) {
          // 跨域样式表无法访问，跳过
        }
      }
      
      // 添加内联样式
      const inlineStyle = (element as HTMLElement).style;
      for (const prop of properties) {
        const value = inlineStyle.getPropertyValue(prop);
        const priority = inlineStyle.getPropertyPriority(prop);
        if (value) {
          rules.push({
            selector: 'inline style',
            property: prop,
            value: value + (priority ? ' !' + priority : ''),
            source: 'inline',
            specificity: 'inline (highest)',
          });
        }
      }
      
      return rules;
    };

    for (const selector of SELECTORS_TO_MONITOR) {
      const element = document.querySelector(selector);
      if (!element) {
        elements.push({ selector, found: false });
        continue;
      }

      const rect = element.getBoundingClientRect();
      const computed = window.getComputedStyle(element);
      
      // 获取关键CSS属性的所有规则
      const cssRules = getAllCSSRules(element, [
        'position',
        'top',
        'bottom',
        'left',
        'right',
        'margin-top',
        'padding-top',
        'z-index',
      ]);
      
      elements.push({
        selector,
        found: true,
        rect,
        computedStyle: {
          position: computed.position,
          top: computed.top,
          left: computed.left,
          right: computed.right,
          bottom: computed.bottom,
          width: computed.width,
          height: computed.height,
          marginTop: computed.marginTop,
          paddingTop: computed.paddingTop,
          zIndex: computed.zIndex,
        },
        cssRules,
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      });
    }

    // 分析重叠
    const overlaps: LayoutAnalysis['overlaps'] = [];
    const contentHeader = elements.find(e => e.selector === '.content-header' && e.found);
    const pageContainer = elements.find(e => e.selector === 'main.app-content > .content-body > .page-container' && e.found);
    
    if (contentHeader?.rect && pageContainer?.rect) {
      const headerBottom = contentHeader.rect.bottom;
      const containerTop = pageContainer.rect.top;
      
      if (containerTop < headerBottom) {
        overlaps.push({
          element1: '.content-header',
          element2: '.page-container',
          overlapHeight: headerBottom - containerTop,
        });
      }
    }

    // 分析间隙
    const gaps: LayoutAnalysis['gaps'] = [];
    const contentBody = elements.find(e => e.selector === '.content-body' && e.found);
    
    if (contentBody?.rect && pageContainer?.rect) {
      const bodyTop = contentBody.rect.top;
      const containerTop = pageContainer.rect.top;
      
      if (containerTop > bodyTop) {
        gaps.push({
          between: 'content-body top → page-container top',
          gapHeight: containerTop - bodyTop,
        });
      }

      const bodyBottom = contentBody.rect.bottom;
      const containerBottom = pageContainer.rect.bottom;
      
      if (containerBottom < bodyBottom) {
        gaps.push({
          between: 'page-container bottom → content-body bottom',
          gapHeight: bodyBottom - containerBottom,
        });
      }
    }

    return {
      timestamp: Date.now(),
      viewport,
      elements,
      overlaps,
      gaps,
    };
  }, []);

  const refresh = useCallback(() => {
    const result = measureElements();
    setAnalysis(result);
  }, [measureElements]);

  const copyToClipboard = useCallback(() => {
    if (!analysis) return;
    
    let text = '# 布局调试信息\n\n';
    text += `## 视口尺寸\n${analysis.viewport.width} × ${analysis.viewport.height}px\n\n`;
    
    // 问题汇总
    if (analysis.overlaps.length > 0 || analysis.gaps.length > 0) {
      text += '## ⚠️ 检测到的问题\n\n';
      
      if (analysis.overlaps.length > 0) {
        text += '### 元素重叠\n';
        analysis.overlaps.forEach(overlap => {
          text += `- ${overlap.element1} 与 ${overlap.element2} 重叠 ${overlap.overlapHeight.toFixed(1)}px\n`;
        });
        text += '\n';
      }
      
      if (analysis.gaps.length > 0) {
        text += '### 布局间隙\n';
        analysis.gaps.forEach(gap => {
          text += `- ${gap.between}: ${gap.gapHeight.toFixed(1)}px\n`;
        });
        text += '\n';
      }
    }
    
    // 元素详情
    text += '## 元素详情\n\n';
    analysis.elements.forEach(elem => {
      text += `### ${elem.selector}\n`;
      if (!elem.found) {
        text += '❌ 未找到\n\n';
        return;
      }
      
      if (elem.rect && elem.computedStyle) {
        text += `- **位置**: top=${elem.rect.top.toFixed(1)}px, bottom=${elem.rect.bottom.toFixed(1)}px, left=${elem.rect.left.toFixed(1)}px, right=${elem.rect.right.toFixed(1)}px\n`;
        text += `- **尺寸**: ${elem.rect.width.toFixed(1)} × ${elem.rect.height.toFixed(1)}px\n`;
        text += `- **CSS position**: ${elem.computedStyle.position}`;
        if (elem.computedStyle.position !== 'static') {
          text += ` (top: ${elem.computedStyle.top}, bottom: ${elem.computedStyle.bottom})`;
        }
        text += '\n';
        text += `- **Margin/Padding**: marginTop=${elem.computedStyle.marginTop}, paddingTop=${elem.computedStyle.paddingTop}\n`;
        text += `- **z-index**: ${elem.computedStyle.zIndex}\n`;
        
        if (typeof elem.scrollTop === 'number') {
          text += `- **滚动**: scrollTop=${elem.scrollTop}, scrollHeight=${elem.scrollHeight}, clientHeight=${elem.clientHeight}\n`;
        }
        
        // CSS规则
        if (elem.cssRules && elem.cssRules.length > 0) {
          text += `\n#### 影响此元素的CSS规则 (${elem.cssRules.length})\n`;
          elem.cssRules.forEach((rule, idx) => {
            text += `${idx + 1}. **${rule.selector}**\n`;
            text += `   - ${rule.property}: ${rule.value}\n`;
            text += `   - 来源: ${rule.source === 'inline' ? '内联样式' : rule.source}\n`;
          });
        }
      }
      text += '\n';
    });
    
    text += `---\n生成时间: ${new Date(analysis.timestamp).toLocaleString()}\n`;
    
    copyTextToClipboard(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [analysis]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = window.setInterval(refresh, 1000);
    } else {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
      }
    };
  }, [autoRefresh, refresh]);

  if (!analysis) {
    return (
      <div className="p-4 text-sm text-gray-500">
        Loading layout analysis...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4 text-xs font-mono">
      {/* Header */}
      <div className="flex items-center justify-between pb-2 border-b border-gray-300 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <ArrowsOut size={16} className="text-blue-600 dark:text-blue-400" />
          <h3 className="font-semibold text-sm">布局调试器</h3>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs">
            <Switch size="sm" checked={autoRefresh} onCheckedChange={setAutoRefresh} />
            自动刷新
          </label>
          <button
            onClick={refresh}
            className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            刷新
          </button>
          <button
            onClick={copyToClipboard}
            className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 flex items-center gap-1"
            title="复制所有布局信息"
          >
            {copied ? (
              <>
                <Check size={12} />
                已复制
              </>
            ) : (
              <>
                <Copy size={12} />
                复制
              </>
            )}
          </button>
        </div>
      </div>

      {/* Viewport Info */}
      <div className="p-2 bg-gray-100 dark:bg-gray-800 rounded">
        <div className="font-semibold mb-1">视口尺寸</div>
        <div>{analysis.viewport.width} × {analysis.viewport.height}px</div>
      </div>

      {/* Critical Issues */}
      {(analysis.overlaps.length > 0 || analysis.gaps.length > 0) && (
        <div className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-300 dark:border-red-700 rounded">
          <div className="font-semibold mb-2 text-red-700 dark:text-red-400">
            ⚠️ 检测到布局问题
          </div>
          
          {analysis.overlaps.length > 0 && (
            <div className="mb-2">
              <div className="font-semibold text-red-600 dark:text-red-400 mb-1">
                元素重叠:
              </div>
              {analysis.overlaps.map((overlap, idx) => (
                <div key={idx} className="ml-2 text-red-700 dark:text-red-300">
                  • {overlap.element1} 与 {overlap.element2} 重叠 {overlap.overlapHeight.toFixed(1)}px
                </div>
              ))}
            </div>
          )}

          {analysis.gaps.length > 0 && (
            <div>
              <div className="font-semibold text-orange-600 dark:text-orange-400 mb-1">
                间隙:
              </div>
              {analysis.gaps.map((gap, idx) => (
                <div key={idx} className="ml-2 text-orange-700 dark:text-orange-300">
                  • {gap.between}: {gap.gapHeight.toFixed(1)}px
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Element Details */}
      <div className="flex flex-col gap-2 max-h-[500px] overflow-y-auto">
        {analysis.elements.map((elem, idx) => (
          <div
            key={idx}
            className={`p-2 rounded border ${
              elem.found
                ? 'bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-700'
                : 'bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-700'
            }`}
          >
            <div className="font-semibold mb-1">
              {elem.selector}
              {!elem.found && <span className="ml-2 text-red-600">未找到</span>}
            </div>
            
            {elem.found && elem.rect && elem.computedStyle && (
              <div className="ml-2 space-y-1">
                <div>
                  <span className="text-gray-600 dark:text-gray-400">位置: </span>
                  top={elem.rect.top.toFixed(1)}px, 
                  bottom={elem.rect.bottom.toFixed(1)}px, 
                  left={elem.rect.left.toFixed(1)}px, 
                  right={elem.rect.right.toFixed(1)}px
                </div>
                <div>
                  <span className="text-gray-600 dark:text-gray-400">尺寸: </span>
                  {elem.rect.width.toFixed(1)} × {elem.rect.height.toFixed(1)}px
                </div>
                <div>
                  <span className="text-gray-600 dark:text-gray-400">CSS position: </span>
                  {elem.computedStyle.position}
                  {elem.computedStyle.position !== 'static' && (
                    <>
                      {' '}(top: {elem.computedStyle.top}, 
                      bottom: {elem.computedStyle.bottom})
                    </>
                  )}
                </div>
                <div>
                  <span className="text-gray-600 dark:text-gray-400">Margin/Padding: </span>
                  marginTop={elem.computedStyle.marginTop}, 
                  paddingTop={elem.computedStyle.paddingTop}
                </div>
                <div>
                  <span className="text-gray-600 dark:text-gray-400">z-index: </span>
                  {elem.computedStyle.zIndex}
                </div>
                {typeof elem.scrollTop === 'number' && (
                  <div>
                    <span className="text-gray-600 dark:text-gray-400">滚动: </span>
                    scrollTop={elem.scrollTop}, 
                    scrollHeight={elem.scrollHeight}, 
                    clientHeight={elem.clientHeight}
                  </div>
                )}
                
                {/* 显示所有影响此元素的CSS规则 */}
                {elem.cssRules && elem.cssRules.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer font-semibold text-blue-600 dark:text-blue-400">
                      📋 影响此元素的CSS规则 ({elem.cssRules.length})
                    </summary>
                    <div className="mt-1 ml-2 space-y-1 text-xs">
                      {elem.cssRules.map((rule, rIdx) => (
                        <div key={rIdx} className="p-1 bg-gray-50 dark:bg-gray-900 rounded border border-gray-200 dark:border-gray-700">
                          <div className="font-semibold text-purple-600 dark:text-purple-400">
                            {rule.selector}
                          </div>
                          <div className="text-gray-700 dark:text-gray-300">
                            {rule.property}: {rule.value}
                          </div>
                          <div className="text-gray-500 text-[10px]">
                            来源: {rule.source === 'inline' ? '内联样式' : (rule.source.includes('http') ? rule.source.split('/').pop() : rule.source)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Timestamp */}
      <div className="pt-2 border-t border-gray-300 dark:border-gray-700 text-gray-500 text-xs">
        最后更新: {new Date(analysis.timestamp).toLocaleTimeString()}
      </div>
    </div>
  );
}

