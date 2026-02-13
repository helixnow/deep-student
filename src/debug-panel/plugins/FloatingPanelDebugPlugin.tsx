/**
 * 外部面板定位调试插件
 * 用于诊断 UnifiedSmartInputBar 中外部面板（RAG、MCP、对话控制等）的定位问题
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Copy, RefreshCw, ChevronDown, ChevronRight, Eye, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Button } from '../../components/ui/shad/Button';
import { ScrollArea } from '../../components/ui/shad/ScrollArea';

interface CSSRuleInfo {
  selector: string;
  source: string; // 样式表来源
  properties: Record<string, string>;
  specificity: string;
}

interface PositionInfo {
  element: string;
  selector: string;
  rect: DOMRect | null;
  computedStyles: {
    position: string;
    top: string;
    bottom: string;
    left: string;
    right: string;
    height: string;
    width: string;
    transform: string;
    zIndex: string;
    overflow: string;
    display: string;
  } | null;
  inlineStyles: Record<string, string>;
  className: string;
  isPositioned: boolean;
  matchedCSSRules: CSSRuleInfo[]; // 新增：匹配的 CSS 规则
}

interface PanelSnapshot {
  timestamp: number;
  trigger: string;
  preferPanelAbove: boolean;
  spaceAbove: number;
  spaceBelow: number;
  inputContainerRect: DOMRect | null;
  viewportHeight: number;
  viewportWidth: number;
  positioningChain: PositionInfo[];
  panelElements: PositionInfo[];
  issues: string[];
}

interface LogEntry {
  timestamp: number;
  type: 'info' | 'warn' | 'error' | 'snapshot';
  message: string;
  data?: any;
}

// 全局状态，供 UnifiedSmartInputBar 推送数据
declare global {
  interface Window {
    __FLOATING_PANEL_DEBUG__?: {
      pushSnapshot: (snapshot: Partial<PanelSnapshot>) => void;
      log: (type: LogEntry['type'], message: string, data?: any) => void;
      enabled: boolean;
    };
  }
}

const FloatingPanelDebugPlugin: React.FC = () => {
  const [snapshots, setSnapshots] = useState<PanelSnapshot[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [expandedSnapshots, setExpandedSnapshots] = useState<Set<number>>(new Set());
  const [autoCapture, setAutoCapture] = useState(true);
  const observerRef = useRef<MutationObserver | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  // 计算选择器优先级（简化版）- 放在最前面，因为被其他函数使用
  const calculateSpecificity = (selector: string): string => {
    let ids = 0, classes = 0, elements = 0;
    ids = (selector.match(/#[\w-]+/g) || []).length;
    classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) || []).length;
    elements = (selector.match(/^[a-zA-Z]+|\s+[a-zA-Z]+/g) || []).length;
    return `(${ids},${classes},${elements})`;
  };

  // 获取元素选择器
  const getSelector = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && parts.length < 5) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        selector += `#${current.id}`;
      } else if (current.className && typeof current.className === 'string') {
        const classes = current.className.split(' ').filter(c => c && !c.startsWith('__')).slice(0, 2);
        if (classes.length > 0) selector += `.${classes.join('.')}`;
      }
      parts.unshift(selector);
      current = current.parentElement;
    }
    return parts.join(' > ');
  };

  // 获取影响元素定位的所有 CSS 规则
  const getMatchedCSSRules = useCallback((element: Element): CSSRuleInfo[] => {
    const rules: CSSRuleInfo[] = [];
    const positioningProps = ['position', 'top', 'bottom', 'left', 'right', 'transform', 'z-index', 'display', 'height', 'width', 'overflow', 'margin', 'padding'];
    
    try {
      for (let i = 0; i < document.styleSheets.length; i++) {
        const sheet = document.styleSheets[i];
        let source = 'unknown';
        try {
          source = sheet.href ? new URL(sheet.href).pathname.split('/').pop() || sheet.href : 
                   (sheet.ownerNode as HTMLElement)?.id || 
                   `<style> in ${(sheet.ownerNode as HTMLElement)?.parentElement?.tagName || 'document'}`;
        } catch { source = 'inline'; }
        
        try {
          const cssRules = sheet.cssRules || sheet.rules;
          if (!cssRules) continue;
          
          for (let j = 0; j < cssRules.length; j++) {
            const rule = cssRules[j];
            if (rule instanceof CSSStyleRule) {
              try {
                if (element.matches(rule.selectorText)) {
                  const properties: Record<string, string> = {};
                  let hasPositioningProp = false;
                  
                  for (const prop of positioningProps) {
                    const value = rule.style.getPropertyValue(prop);
                    if (value) {
                      properties[prop] = value;
                      hasPositioningProp = true;
                    }
                  }
                  
                  if (hasPositioningProp) {
                    rules.push({
                      selector: rule.selectorText,
                      source,
                      properties,
                      specificity: calculateSpecificity(rule.selectorText),
                    });
                  }
                }
              } catch { /* 跨域样式表可能无法访问 */ }
            }
          }
        } catch { /* 跨域样式表 */ }
      }
    } catch (e) {
      console.warn('Failed to get matched CSS rules:', e);
    }
    
    return rules;
  }, []);

  // 获取元素的完整定位信息
  const getPositionInfo = useCallback((element: Element | null, label: string): PositionInfo | null => {
    if (!element) return null;
    
    const rect = element.getBoundingClientRect();
    const computed = window.getComputedStyle(element);
    const htmlElement = element as HTMLElement;
    
    const inlineStyles: Record<string, string> = {};
    if (htmlElement.style) {
      for (let i = 0; i < htmlElement.style.length; i++) {
        const prop = htmlElement.style[i];
        inlineStyles[prop] = htmlElement.style.getPropertyValue(prop);
      }
    }

    const position = computed.position;
    const isPositioned = position !== 'static';
    const matchedCSSRules = getMatchedCSSRules(element);

    return {
      element: label,
      selector: getSelector(element),
      rect,
      computedStyles: {
        position,
        top: computed.top,
        bottom: computed.bottom,
        left: computed.left,
        right: computed.right,
        height: computed.height,
        width: computed.width,
        transform: computed.transform,
        zIndex: computed.zIndex,
        overflow: computed.overflow,
        display: computed.display,
      },
      inlineStyles,
      className: element.className || '',
      isPositioned,
      matchedCSSRules,
    };
  }, [getMatchedCSSRules]);

  // 查找定位参照物链
  const getPositioningChain = useCallback((element: Element | null): PositionInfo[] => {
    const chain: PositionInfo[] = [];
    let current: Element | null = element;
    let depth = 0;
    
    while (current && depth < 10) {
      const info = getPositionInfo(current, `Level ${depth}`);
      if (info) {
        chain.push(info);
        // 如果找到了 positioned 元素，记录它
        if (info.isPositioned) {
          info.element = `Level ${depth} (定位参照物)`;
        }
      }
      current = current.parentElement;
      depth++;
    }
    
    return chain;
  }, [getPositionInfo]);

  // 捕获完整快照
  const captureSnapshot = useCallback((trigger: string, extraData?: Partial<PanelSnapshot>) => {
    if (!enabled) return;

    const issues: string[] = [];
    
    // 查找输入框容器
    const inputContainer = document.querySelector('[class*="floating-panel-occlusion-host"]');
    const glassContainer = document.querySelector('[class*="landing-input-container"], .unified-input-docked');
    
    // 查找外部面板
    const panelSelectors = [
      '[data-panel-motion]',
      '.glass-panel',
      '[class*="bottom-full"]',
      '[class*="top-full"]',
    ];
    
    const panelElements: PositionInfo[] = [];
    panelSelectors.forEach(selector => {
      document.querySelectorAll(selector).forEach((el, idx) => {
        const info = getPositionInfo(el, `Panel: ${selector} [${idx}]`);
        if (info) {
          panelElements.push(info);
        }
      });
    });

    // 获取定位链
    let positioningChain: PositionInfo[] = [];
    const activePanelContainer = document.querySelector('[data-panel-motion="open"]')?.parentElement;
    if (activePanelContainer) {
      positioningChain = getPositioningChain(activePanelContainer);
    } else if (inputContainer) {
      positioningChain = getPositioningChain(inputContainer);
    }

    // 检测问题
    const inputContainerInfo = inputContainer ? getPositionInfo(inputContainer, 'InputContainer') : null;
    if (inputContainerInfo) {
      if (!inputContainerInfo.isPositioned) {
        issues.push('⚠️ 输入框容器不是 positioned 元素，子元素的 absolute 定位可能不会相对于它');
      }
      if (inputContainerInfo.computedStyles?.position === 'static') {
        issues.push('❌ 输入框容器 position: static，外部面板会相对于更上层元素定位');
      }
    } else {
      issues.push('❌ 未找到输入框容器 (.floating-panel-occlusion-host)');
    }

    // 检查面板定位
    panelElements.forEach(panel => {
      if (panel.computedStyles?.position === 'absolute') {
        const bottom = panel.computedStyles.bottom;
        if (bottom && bottom !== 'auto' && bottom.includes('100%')) {
          // 检查是否相对于正确的元素定位
          const containerHeight = inputContainerInfo?.rect?.height || 0;
          const panelBottom = panel.rect?.bottom || 0;
          const inputTop = inputContainerInfo?.rect?.top || 0;
          
          if (panelBottom < inputTop - containerHeight - 50) {
            issues.push(`⚠️ 面板 "${panel.element}" 定位可能不正确，底边位置远离输入框`);
          }
        }
      }
    });

    // 检查 page-container
    const pageContainer = document.querySelector('.page-container');
    if (pageContainer) {
      const pageContainerStyles = window.getComputedStyle(pageContainer);
      if (pageContainerStyles.position === 'static') {
        issues.push('⚠️ .page-container 是 static 定位');
      } else {
        issues.push(`✓ .page-container 是 ${pageContainerStyles.position} 定位`);
      }
    }

    const snapshot: PanelSnapshot = {
      timestamp: Date.now(),
      trigger,
      preferPanelAbove: extraData?.preferPanelAbove ?? false,
      spaceAbove: extraData?.spaceAbove ?? 0,
      spaceBelow: extraData?.spaceBelow ?? 0,
      inputContainerRect: inputContainerInfo?.rect || null,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      positioningChain,
      panelElements,
      issues,
    };

    setSnapshots(prev => [snapshot, ...prev].slice(0, 20));
    setLogs(prev => [{
      timestamp: Date.now(),
      type: 'snapshot' as const,
      message: `快照: ${trigger}`,
      data: { issues: issues.length, panels: panelElements.length }
    }, ...prev].slice(0, 100));
  }, [enabled, getPositionInfo, getPositioningChain]);

  // 添加日志
  const addLog = useCallback((type: LogEntry['type'], message: string, data?: any) => {
    if (!enabled) return;
    setLogs(prev => [{
      timestamp: Date.now(),
      type,
      message,
      data
    }, ...prev].slice(0, 100));
  }, [enabled]);

  // 设置全局接口
  useEffect(() => {
    window.__FLOATING_PANEL_DEBUG__ = {
      pushSnapshot: (data) => captureSnapshot('Component Push', data),
      log: addLog,
      enabled,
    };
    
    return () => {
      delete window.__FLOATING_PANEL_DEBUG__;
    };
  }, [enabled, captureSnapshot, addLog]);

  // 监听 DOM 变化和窗口调整
  useEffect(() => {
    if (!enabled || !autoCapture) return;

    // MutationObserver 监听面板打开/关闭
    observerRef.current = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-panel-motion') {
          const target = mutation.target as HTMLElement;
          const motionState = target.getAttribute('data-panel-motion');
          captureSnapshot(`面板状态变化: ${motionState}`);
        }
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(node => {
            if (node instanceof HTMLElement && node.hasAttribute('data-panel-motion')) {
              captureSnapshot('面板节点添加');
            }
          });
        }
      }
    });

    observerRef.current.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-panel-motion', 'class'],
      childList: true,
      subtree: true,
    });

    // ResizeObserver 监听尺寸变化
    resizeObserverRef.current = new ResizeObserver(() => {
      captureSnapshot('窗口/容器尺寸变化');
    });

    const inputContainer = document.querySelector('[class*="floating-panel-occlusion-host"]');
    if (inputContainer) {
      resizeObserverRef.current.observe(inputContainer);
    }

    // 窗口 resize 监听
    const handleResize = () => captureSnapshot('window resize');
    window.addEventListener('resize', handleResize);

    return () => {
      observerRef.current?.disconnect();
      resizeObserverRef.current?.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [enabled, autoCapture, captureSnapshot]);

  // 复制到剪贴板
  const copyToClipboard = (data: any, label: string) => {
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      addLog('info', `已复制: ${label}`);
    });
  };

  // 格式化时间戳
  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
  };

  // 渲染位置信息
  const renderPositionInfo = (info: PositionInfo, idx: number) => (
    <div key={idx} className="border border-border/50 rounded p-2 mb-2 text-xs bg-card/50">
      <div className="font-medium text-foreground flex items-center gap-2">
        {info.isPositioned ? (
          <CheckCircle2 size={12} className="text-success" />
        ) : (
          <AlertCircle size={12} className="text-muted-foreground" />
        )}
        {info.element}
      </div>
      <div className="text-muted-foreground text-[10px] truncate" title={info.selector}>
        {info.selector}
      </div>
      <div className="grid grid-cols-2 gap-1 mt-1">
        <div className={info.isPositioned ? 'text-success' : 'text-muted-foreground'}>
          position: <span className="font-mono">{info.computedStyles?.position}</span>
        </div>
        <div>zIndex: <span className="font-mono">{info.computedStyles?.zIndex}</span></div>
        <div>top: <span className="font-mono">{info.computedStyles?.top}</span></div>
        <div>bottom: <span className="font-mono">{info.computedStyles?.bottom}</span></div>
        <div>left: <span className="font-mono">{info.computedStyles?.left}</span></div>
        <div>right: <span className="font-mono">{info.computedStyles?.right}</span></div>
        <div>height: <span className="font-mono">{info.computedStyles?.height}</span></div>
        <div>width: <span className="font-mono">{info.computedStyles?.width}</span></div>
      </div>
      {info.computedStyles?.transform !== 'none' && (
        <div className="mt-1">
          transform: <span className="font-mono text-[10px]">{info.computedStyles?.transform}</span>
        </div>
      )}
      {Object.keys(info.inlineStyles).length > 0 && (
        <div className="mt-1 pt-1 border-t border-border/30">
          <div className="text-[10px] text-muted-foreground">Inline Styles:</div>
          {Object.entries(info.inlineStyles).map(([k, v]) => (
            <div key={k} className="font-mono text-[10px]">{k}: {v}</div>
          ))}
        </div>
      )}
      {info.className && (
        <div className="mt-1 pt-1 border-t border-border/30">
          <div className="text-[10px] text-muted-foreground truncate" title={info.className}>
            className: {info.className.slice(0, 100)}{info.className.length > 100 ? '...' : ''}
          </div>
        </div>
      )}
      {info.rect && (
        <div className="mt-1 pt-1 border-t border-border/30 grid grid-cols-2 gap-1 text-[10px]">
          <div>rect.top: {info.rect.top.toFixed(1)}</div>
          <div>rect.bottom: {info.rect.bottom.toFixed(1)}</div>
          <div>rect.left: {info.rect.left.toFixed(1)}</div>
          <div>rect.right: {info.rect.right.toFixed(1)}</div>
          <div>rect.height: {info.rect.height.toFixed(1)}</div>
          <div>rect.width: {info.rect.width.toFixed(1)}</div>
        </div>
      )}
      {/* 🔥 新增：显示匹配的 CSS 规则 */}
      {info.matchedCSSRules && info.matchedCSSRules.length > 0 && (
        <div className="mt-1 pt-1 border-t border-border/30">
          <div className="text-[10px] text-warning font-medium mb-1">📋 影响定位的 CSS 规则 ({info.matchedCSSRules.length}):</div>
          <div className="space-y-1 max-h-[150px] overflow-auto">
            {info.matchedCSSRules.map((rule, ruleIdx) => (
              <div key={ruleIdx} className="bg-muted/50 rounded p-1 text-[9px]">
                <div className="flex justify-between items-start">
                  <span className="font-mono text-primary truncate flex-1" title={rule.selector}>
                    {rule.selector.length > 50 ? rule.selector.slice(0, 50) + '...' : rule.selector}
                  </span>
                  <span className="text-muted-foreground ml-1 flex-shrink-0">{rule.specificity}</span>
                </div>
                <div className="text-muted-foreground">📁 {rule.source}</div>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {Object.entries(rule.properties).map(([prop, val]) => (
                    <span 
                      key={prop} 
                      className={`font-mono px-1 rounded ${prop === 'position' ? 'bg-destructive/20 text-destructive' : 'bg-muted'}`}
                    >
                      {prop}: {val}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  // 渲染快照
  const renderSnapshot = (snapshot: PanelSnapshot, idx: number) => {
    const isExpanded = expandedSnapshots.has(idx);
    
    return (
      <div key={idx} className="border border-border rounded mb-2 overflow-hidden">
        <div
          className="flex items-center justify-between p-2 bg-muted/30 cursor-pointer hover:bg-muted/50"
          onClick={() => {
            const newSet = new Set(expandedSnapshots);
            if (isExpanded) {
              newSet.delete(idx);
            } else {
              newSet.add(idx);
            }
            setExpandedSnapshots(newSet);
          }}
        >
          <div className="flex items-center gap-2">
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="text-xs font-medium">{snapshot.trigger}</span>
            <span className="text-[10px] text-muted-foreground">{formatTime(snapshot.timestamp)}</span>
          </div>
          <div className="flex items-center gap-2">
            {snapshot.issues.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/20 text-warning">
                {snapshot.issues.length} 问题
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={(e) => {
                e.stopPropagation();
                copyToClipboard(snapshot, '快照');
              }}
            >
              <Copy size={12} />
            </Button>
          </div>
        </div>
        
        {isExpanded && (
          <div className="p-2 text-xs space-y-3">
            {/* 基本信息 */}
            <div className="grid grid-cols-2 gap-2 bg-card/50 p-2 rounded">
              <div>preferPanelAbove: <span className={snapshot.preferPanelAbove ? 'text-warning font-medium' : ''}>{String(snapshot.preferPanelAbove)}</span></div>
              <div>spaceAbove: {snapshot.spaceAbove.toFixed(0)}px</div>
              <div>spaceBelow: {snapshot.spaceBelow.toFixed(0)}px</div>
              <div>viewport: {snapshot.viewportWidth}x{snapshot.viewportHeight}</div>
            </div>

            {/* 问题列表 */}
            {snapshot.issues.length > 0 && (
              <div className="bg-warning/10 border border-warning/30 rounded p-2">
                <div className="font-medium mb-1 flex items-center gap-1">
                  <AlertCircle size={12} className="text-warning" />
                  检测到的问题
                </div>
                {snapshot.issues.map((issue, i) => (
                  <div key={i} className="text-[11px]">{issue}</div>
                ))}
              </div>
            )}

            {/* 定位链 */}
            <div>
              <div className="font-medium mb-1 flex items-center gap-1">
                <Eye size={12} />
                定位参照物链 (从面板向上)
              </div>
              {snapshot.positioningChain.map((info, i) => renderPositionInfo(info, i))}
            </div>

            {/* 面板元素 */}
            <div>
              <div className="font-medium mb-1">面板元素</div>
              {snapshot.panelElements.map((info, i) => renderPositionInfo(info, i))}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Button
            variant={enabled ? 'default' : 'outline'}
            size="sm"
            onClick={() => setEnabled(!enabled)}
          >
            {enabled ? '已启用' : '已禁用'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => captureSnapshot('手动捕获')}
            disabled={!enabled}
          >
            <RefreshCw size={14} className="mr-1" />
            捕获快照
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={autoCapture}
              onChange={(e) => setAutoCapture(e.target.checked)}
            />
            自动捕获
          </label>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSnapshots([]);
              setLogs([]);
            }}
          >
            清空
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => copyToClipboard({ snapshots, logs }, '全部数据')}
          >
            <Copy size={14} className="mr-1" />
            复制全部
          </Button>
        </div>
      </div>

      {/* 内容区 */}
      <ScrollArea className="flex-1">
        <div className="p-2">
          {/* 快照列表 */}
          <div className="mb-4">
            <div className="text-sm font-medium mb-2">快照 ({snapshots.length})</div>
            {snapshots.length === 0 ? (
              <div className="text-xs text-muted-foreground p-4 text-center border border-dashed rounded">
                {enabled ? '等待捕获快照...' : '请先启用调试'}
              </div>
            ) : (
              snapshots.map((s, i) => renderSnapshot(s, i))
            )}
          </div>

          {/* 日志列表 */}
          <div>
            <div className="text-sm font-medium mb-2">日志 ({logs.length})</div>
            <div className="space-y-1 max-h-[200px] overflow-auto">
              {logs.map((log, i) => (
                <div
                  key={i}
                  className={`text-[10px] p-1 rounded font-mono ${
                    log.type === 'error' ? 'bg-destructive/10 text-destructive' :
                    log.type === 'warn' ? 'bg-warning/10 text-warning' :
                    log.type === 'snapshot' ? 'bg-primary/10 text-primary' :
                    'text-muted-foreground'
                  }`}
                >
                  <span className="opacity-60">{formatTime(log.timestamp)}</span>
                  {' '}[{log.type}] {log.message}
                  {log.data && <span className="opacity-60"> {JSON.stringify(log.data)}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
};

export default FloatingPanelDebugPlugin;
