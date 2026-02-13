import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, Pause, Play, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { debugLog } from '../debugMasterSwitch';

interface BlurSample {
  id: string;
  at: string;
  nodeId: string;
  nodeClass: string;
  nodeRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  nodeStyle: {
    opacity: string;
    transform: string;
    filter: string;
    willChange: string;
    transition: string;
    textRendering: string;
  };
  viewportTransform: string;
  dimmedEdgeCount: number;
  totalEdgeCount: number;
  devicePixelRatio: number;
  riskHints: string[];
}

const MAX_SAMPLES = 200;

function hasFraction(n: number): boolean {
  return Math.abs(n - Math.round(n)) > 0.001;
}

export default function MindMapBlurHoverDebugPlugin({ isActive }: DebugPanelPluginProps) {
  const { t } = useTranslation('common');
  const [enabled, setEnabled] = useState(true);
  const [samples, setSamples] = useState<BlurSample[]>([]);
  const [currentNode, setCurrentNode] = useState<string | null>(null);

  const collectSample = useCallback((nodeEl: Element) => {
    if (!enabled) return;

    const nodeRect = nodeEl.getBoundingClientRect();
    const nodeStyle = window.getComputedStyle(nodeEl);
    const viewportEl = nodeEl.closest('.mindmap-container')?.querySelector('.react-flow__viewport');
    const viewportStyle = viewportEl ? window.getComputedStyle(viewportEl) : null;
    const edgeEls = document.querySelectorAll('.mindmap-container .react-flow__edge-path');

    let dimmedEdgeCount = 0;
    edgeEls.forEach(path => {
      const style = window.getComputedStyle(path);
      const opacity = Number.parseFloat(style.opacity || '1');
      if (opacity < 0.95) dimmedEdgeCount += 1;
    });

    const riskHints: string[] = [];
    if (hasFraction(nodeRect.x) || hasFraction(nodeRect.y) || hasFraction(nodeRect.width) || hasFraction(nodeRect.height)) {
      riskHints.push('fractional-node-rect');
    }
    if (viewportStyle?.transform && viewportStyle.transform !== 'none') {
      riskHints.push('viewport-transform-active');
    }
    if (nodeStyle.transform !== 'none') {
      riskHints.push('node-transform-active');
    }
    if (nodeStyle.filter !== 'none') {
      riskHints.push('node-filter-active');
    }
    if (dimmedEdgeCount > 0) {
      riskHints.push('edge-opacity-dimming-active');
    }

    const sample: BlurSample = {
      id: `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      at: new Date().toISOString(),
      nodeId: nodeEl.getAttribute('data-id') || 'unknown',
      nodeClass: nodeEl.className,
      nodeRect: {
        x: Number(nodeRect.x.toFixed(3)),
        y: Number(nodeRect.y.toFixed(3)),
        width: Number(nodeRect.width.toFixed(3)),
        height: Number(nodeRect.height.toFixed(3)),
      },
      nodeStyle: {
        opacity: nodeStyle.opacity,
        transform: nodeStyle.transform,
        filter: nodeStyle.filter,
        willChange: nodeStyle.willChange,
        transition: nodeStyle.transition,
        textRendering: nodeStyle.textRendering,
      },
      viewportTransform: viewportStyle?.transform || 'none',
      dimmedEdgeCount,
      totalEdgeCount: edgeEls.length,
      devicePixelRatio: window.devicePixelRatio,
      riskHints,
    };

    setSamples(prev => [...prev, sample].slice(-MAX_SAMPLES));
    debugLog.log('[MindMapBlurHoverDebug]', sample);
  }, [enabled]);

  useEffect(() => {
    if (!isActive || !enabled) return;

    const handleOver = (event: Event) => {
      const target = event.target as HTMLElement | null;
      const nodeEl = target?.closest('.mindmap-container .react-flow__node');
      if (!nodeEl) return;

      const nodeId = nodeEl.getAttribute('data-id') || null;
      setCurrentNode(nodeId);
      collectSample(nodeEl);
    };

    const handleOut = (event: Event) => {
      const target = event.target as HTMLElement | null;
      const nodeEl = target?.closest('.mindmap-container .react-flow__node');
      if (!nodeEl) return;
      setCurrentNode(null);
    };

    document.addEventListener('mouseover', handleOver, true);
    document.addEventListener('mouseout', handleOut, true);

    return () => {
      document.removeEventListener('mouseover', handleOver, true);
      document.removeEventListener('mouseout', handleOut, true);
    };
  }, [collectSample, enabled, isActive]);

  const copyLogs = useCallback(async () => {
    if (samples.length === 0) return;
    const payload = {
      generatedAt: new Date().toISOString(),
      type: 'mindmap-hover-blur-debug',
      sampleCount: samples.length,
      samples,
    };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
  }, [samples]);

  const summary = useMemo(() => {
    const withFraction = samples.filter(s => s.riskHints.includes('fractional-node-rect')).length;
    const withViewportTransform = samples.filter(s => s.riskHints.includes('viewport-transform-active')).length;
    const withEdgeDimming = samples.filter(s => s.riskHints.includes('edge-opacity-dimming-active')).length;
    return { withFraction, withViewportTransform, withEdgeDimming };
  }, [samples]);

  return (
    <div className="p-4 h-full overflow-auto text-[var(--mm-text)]">
      <div className="mb-3 text-sm text-[var(--mm-text-secondary)]">
        {t('debug_panel.mindmap_blur_monitor.description')}
      </div>

      <div className="flex items-center gap-2 mb-3">
        <NotionButton
          variant={enabled ? 'warning' : 'success'}
          onClick={() => setEnabled(prev => !prev)}
          className="h-8 px-3"
        >
          {enabled ? <Pause className="w-4 h-4 mr-1" /> : <Play className="w-4 h-4 mr-1" />}
          {enabled
            ? t('debug_panel.mindmap_blur_monitor.pause')
            : t('debug_panel.mindmap_blur_monitor.resume')}
        </NotionButton>
        <NotionButton variant="ghost" onClick={() => setSamples([])} className="h-8 px-3">
          <Trash2 className="w-4 h-4 mr-1" />
          {t('debug_panel.mindmap_blur_monitor.clear')}
        </NotionButton>
        <NotionButton variant="primary" onClick={() => void copyLogs()} className="h-8 px-3" disabled={samples.length === 0}>
          <Copy className="w-4 h-4 mr-1" />
          {t('debug_panel.mindmap_blur_monitor.copy')}
        </NotionButton>
      </div>

      <div className="rounded-md border border-[var(--mm-border)] bg-[var(--mm-bg-elevated)] p-3 mb-3 text-xs space-y-1">
        <div>{t('debug_panel.mindmap_blur_monitor.current_node', { id: currentNode || '-' })}</div>
        <div>{t('debug_panel.mindmap_blur_monitor.total_samples', { count: samples.length })}</div>
        <div>{t('debug_panel.mindmap_blur_monitor.fractional_samples', { count: summary.withFraction })}</div>
        <div>{t('debug_panel.mindmap_blur_monitor.viewport_transform_samples', { count: summary.withViewportTransform })}</div>
        <div>{t('debug_panel.mindmap_blur_monitor.edge_dimming_samples', { count: summary.withEdgeDimming })}</div>
      </div>

      <div className="space-y-2">
        {samples.slice().reverse().map(sample => (
          <div key={sample.id} className="rounded-md border border-[var(--mm-border)] bg-[var(--mm-bg-elevated)] p-2 text-xs">
            <div className="font-medium">{sample.at} · {sample.nodeId}</div>
            <div>rect=({sample.nodeRect.x}, {sample.nodeRect.y}, {sample.nodeRect.width}, {sample.nodeRect.height})</div>
            <div>viewportTransform={sample.viewportTransform}</div>
            <div>edges={sample.dimmedEdgeCount}/{sample.totalEdgeCount}</div>
            <div>risk={sample.riskHints.length > 0 ? sample.riskHints.join(', ') : 'none'}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

