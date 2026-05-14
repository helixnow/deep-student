import { copyTextToClipboard } from '@/utils/clipboardUtils';

/**
 * SessionSwitchPerfDebugPlugin - 会话切换性能监控插件
 * 
 * 监控会话新建/加载各阶段耗时，定位性能瓶颈。
 * 支持时间线可视化和瓶颈自动检测。
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Button } from '../../components/ui/shad/Button';
import { Badge } from '../../components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/shad/Card';
import { Separator } from '../../components/ui/shad/Separator';
import { 
  Timer, 
  Trash, 
  Copy, 
  Warning, 
  CheckCircle, 
  Clock,
  Lightning,
  Database,
  ArrowClockwise,
  ArrowRight,
  TrendUp,
  ChartBar,
} from '@phosphor-icons/react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { 
  sessionSwitchPerf, 
  type PerfTrace, 
  type PerfStage,
  type PerfSummary,
} from '../../features/chat/debug/sessionSwitchPerf';

// =============================================================================
// 常量
// =============================================================================

const BOTTLENECK_THRESHOLD_MS = 100; // 超过 100ms 视为瓶颈
const WARNING_THRESHOLD_MS = 50;     // 超过 50ms 视为警告

// =============================================================================
// 辅助组件
// =============================================================================

const StageBar: React.FC<{
  stage: PerfStage;
  delta: number;
  totalMs: number;
  label: string;
}> = ({ stage, delta, totalMs, label }) => {
  const percentage = totalMs > 0 ? (delta / totalMs) * 100 : 0;
  const isBottleneck = delta > BOTTLENECK_THRESHOLD_MS;
  const isWarning = delta > WARNING_THRESHOLD_MS && !isBottleneck;

  const bgColor = isBottleneck 
    ? 'bg-red-500 dark:bg-red-600' 
    : isWarning 
      ? 'bg-yellow-500 dark:bg-yellow-600' 
      : 'bg-green-500 dark:bg-green-600';

  return (
    <div className="flex items-center gap-2 text-xs">
      <div className="w-28 truncate text-muted-foreground" title={label}>
        {label}
      </div>
      <div className="flex-1 h-4 bg-muted rounded overflow-hidden">
        <div 
          className={`h-full ${bgColor} transition-all duration-300`}
          style={{ width: `${Math.max(percentage, 2)}%` }}
        />
      </div>
      <div className={`w-16 text-right font-mono ${isBottleneck ? 'text-red-500 font-bold' : ''}`}>
        {delta.toFixed(1)}ms
      </div>
      {isBottleneck && (
        <Warning size={12} className="text-red-500 flex-shrink-0" />
      )}
    </div>
  );
};

const TraceCard: React.FC<{
  trace: PerfTrace;
  isExpanded: boolean;
  onToggle: () => void;
}> = ({ trace, isExpanded, onToggle }) => {
  const stageOrder = sessionSwitchPerf.getStageOrder();
  const isRunning = trace.status === 'running';
  const isAborted = trace.status === 'aborted';

  const statusBadge = useMemo(() => {
    if (isRunning) {
      return <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">进行中</Badge>;
    }
    if (isAborted) {
      return <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">中断</Badge>;
    }
    if (trace.fromCache) {
      return <Badge className="bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">缓存</Badge>;
    }
    return <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">完成</Badge>;
  }, [isRunning, isAborted, trace.fromCache]);

  const totalStr = trace.totalMs !== null ? `${trace.totalMs.toFixed(1)}ms` : '...';
  const hasBottleneck = trace.marks.some(m => m.delta > BOTTLENECK_THRESHOLD_MS);

  return (
    <Card className={`${hasBottleneck ? 'border-red-300 dark:border-red-700' : ''}`}>
      <CardHeader 
        className="py-2 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={onToggle}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {isRunning ? (
              <ArrowClockwise size={16} className="text-blue-500 animate-spin" />
            ) : hasBottleneck ? (
              <Warning size={16} className="text-red-500" />
            ) : (
              <CheckCircle size={16} className="text-green-500" />
            )}
            <CardTitle className="text-sm font-mono truncate max-w-[180px]" title={trace.sessionId}>
              {trace.sessionId.slice(0, 20)}...
            </CardTitle>
            {statusBadge}
          </div>
          <div className="flex items-center gap-2">
            <span className={`font-mono text-sm ${hasBottleneck ? 'text-red-500 font-bold' : ''}`}>
              {totalStr}
            </span>
            <ArrowRight className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
          </div>
        </div>
      </CardHeader>
      
      {isExpanded && (
        <CardContent className="py-2 space-y-2">
          {/* 时间线可视化 */}
          <div className="space-y-1">
            {trace.marks.slice(1).map((mark, idx) => (
              <StageBar
                key={`${mark.stage}_${idx}`}
                stage={mark.stage}
                delta={mark.delta}
                totalMs={trace.totalMs || 1000}
                label={sessionSwitchPerf.getStageLabel(mark.stage)}
              />
            ))}
          </div>
          
          {/* 数据量信息 */}
          {(trace.messageCount !== null || trace.blockCount !== null) && (
            <>
              <Separator className="my-2" />
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <Database size={12} />
                {trace.messageCount !== null && (
                  <span>{trace.messageCount} 条消息</span>
                )}
                {trace.blockCount !== null && (
                  <span>{trace.blockCount} 个块</span>
                )}
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
};

const SummaryCard: React.FC<{ summary: PerfSummary }> = ({ summary }) => {
  const stageOrder = sessionSwitchPerf.getStageOrder();
  
  // 找出最慢的阶段
  const slowestStage = stageOrder
    .filter(s => s !== 'click_switch')
    .reduce((max, stage) => 
      summary.avgByStage[stage] > summary.avgByStage[max] ? stage : max
    , 'store_get_or_create' as PerfStage);

  return (
    <Card>
      <CardHeader className="py-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <ChartBar size={16} />
          性能统计 ({summary.sampleCount} 次采样)
        </CardTitle>
      </CardHeader>
      <CardContent className="py-2 space-y-3">
        {/* 总耗时统计 */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-muted/50 rounded p-2">
            <div className="text-muted-foreground">平均总耗时</div>
            <div className="font-mono text-lg font-bold">
              {summary.avgTotal.toFixed(1)}ms
            </div>
          </div>
          <div className="bg-muted/50 rounded p-2">
            <div className="text-muted-foreground">最大总耗时</div>
            <div className="font-mono text-lg font-bold text-red-500">
              {summary.maxTotal.toFixed(1)}ms
            </div>
          </div>
        </div>

        {/* 缓存命中率 */}
        <div className="flex items-center gap-2 text-xs">
          <Lightning size={12} className="text-purple-500" />
          <span>缓存命中率:</span>
          <span className="font-mono font-bold">
            {(summary.cacheHitRate * 100).toFixed(0)}%
          </span>
        </div>

        {/* 瓶颈阶段 */}
        <div className="text-xs">
          <div className="text-muted-foreground mb-1">最慢阶段:</div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono">
              {sessionSwitchPerf.getStageLabel(slowestStage)}
            </Badge>
            <span className="font-mono text-red-500 font-bold">
              avg {summary.avgByStage[slowestStage].toFixed(1)}ms
            </span>
          </div>
        </div>

        {/* 各阶段平均耗时 */}
        <Separator />
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground mb-1">各阶段平均耗时:</div>
          {stageOrder.filter(s => s !== 'click_switch').map(stage => (
            <div key={stage} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground truncate">
                {sessionSwitchPerf.getStageLabel(stage)}
              </span>
              <span className={`font-mono ${summary.avgByStage[stage] > BOTTLENECK_THRESHOLD_MS ? 'text-red-500 font-bold' : ''}`}>
                {summary.avgByStage[stage].toFixed(1)}ms
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};

// =============================================================================
// 主组件
// =============================================================================

const SessionSwitchPerfDebugPlugin: React.FC<DebugPanelPluginProps> = ({
  visible,
  isActive,
  isActivated,
}) => {
  const [traces, setTraces] = useState<PerfTrace[]>([]);
  const [currentTrace, setCurrentTrace] = useState<PerfTrace | null>(null);
  const [expandedTraceId, setExpandedTraceId] = useState<string | null>(null);
  const [showStats, setShowStats] = useState(true);
  const [enabled, setEnabled] = useState(sessionSwitchPerf.isEnabled());

  // 监听追踪更新
  useEffect(() => {
    if (!isActive) return;

    const handleUpdate = (trace: PerfTrace) => {
      setCurrentTrace(sessionSwitchPerf.getCurrentTrace());
      setTraces(sessionSwitchPerf.getTraces());
      
      // 自动展开最新的追踪
      if (trace.status === 'running' || trace.status === 'completed') {
        setExpandedTraceId(trace.id);
      }
    };

    // 初始加载
    setCurrentTrace(sessionSwitchPerf.getCurrentTrace());
    setTraces(sessionSwitchPerf.getTraces());

    const unsubscribe = sessionSwitchPerf.addListener(handleUpdate);
    return unsubscribe;
  }, [isActive]);

  const handleClear = useCallback(() => {
    sessionSwitchPerf.clear();
    setTraces([]);
    setCurrentTrace(null);
    setExpandedTraceId(null);
  }, []);

  const handleToggleEnabled = useCallback(() => {
    const next = !enabled;
    sessionSwitchPerf.setEnabled(next);
    setEnabled(next);
  }, [enabled]);

  const handleCopyReport = useCallback(() => {
    const summary = sessionSwitchPerf.getSummary();
    const report = {
      generatedAt: new Date().toISOString(),
      enabled,
      summary,
      recentTraces: traces.slice(-10),
    };
    copyTextToClipboard(JSON.stringify(report, null, 2));
    console.log('📋 性能报告已复制到剪贴板');
  }, [traces, enabled]);

  const summary = useMemo(() => sessionSwitchPerf.getSummary(), [traces]);

  // 合并当前追踪和历史追踪
  const allTraces = useMemo(() => {
    const list = [...traces];
    if (currentTrace && !list.some(t => t.id === currentTrace.id)) {
      list.push(currentTrace);
    }
    return list.reverse(); // 最新的在前
  }, [traces, currentTrace]);

  if (!visible || !isActive) return null;

  return (
    <div className="flex flex-col h-full p-4 space-y-4 overflow-hidden">
      {/* 工具栏 */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <Timer size={20} className="text-primary" />
          <h3 className="text-lg font-semibold">会话切换性能监控</h3>
          <Badge variant={enabled ? 'default' : 'secondary'}>
            {enabled ? '监控中' : '已停止'}
          </Badge>
          <Badge variant="outline">{allTraces.length} 条记录</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button 
            size="sm" 
            variant={enabled ? 'outline' : 'default'}
            onClick={handleToggleEnabled}
          >
            {enabled ? '停止监控' : '开始监控'}
          </Button>
          <Button 
            size="sm" 
            variant="outline" 
            onClick={() => setShowStats(!showStats)}
          >
            <TrendUp size={16} className="mr-1" />
            {showStats ? '隐藏统计' : '显示统计'}
          </Button>
          <Button size="sm" variant="outline" onClick={handleCopyReport}>
            <Copy size={16} className="mr-1" />
            复制报告
          </Button>
          <Button size="sm" variant="destructive" onClick={handleClear}>
            <Trash size={16} className="mr-1" />
            清空
          </Button>
        </div>
      </div>

      <Separator />

      {/* 使用说明 */}
      <Card className="flex-shrink-0">
        <CardHeader className="py-2">
          <CardTitle className="text-sm">使用说明</CardTitle>
        </CardHeader>
        <CardContent className="py-2 text-xs text-muted-foreground">
          <ol className="list-decimal list-inside space-y-1">
            <li>确保"监控中"状态已开启</li>
            <li>从侧边栏点击切换到另一个会话</li>
            <li>观察各阶段耗时，红色表示瓶颈（&gt;100ms）</li>
            <li>点击"复制报告"导出完整数据</li>
          </ol>
          <div className="mt-2 flex items-center gap-4">
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-green-500" />
              <span>&lt;50ms</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-yellow-500" />
              <span>50-100ms</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-red-500" />
              <span>&gt;100ms 瓶颈</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 统计摘要 */}
      {showStats && summary && (
        <div className="flex-shrink-0">
          <SummaryCard summary={summary} />
        </div>
      )}

      {/* 追踪列表 */}
      <div className="flex-1 overflow-auto space-y-2">
        {allTraces.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            <Clock size={48} className="mx-auto mb-2 opacity-50" />
            <p>暂无追踪记录</p>
            <p className="text-xs">切换会话后将自动记录</p>
          </div>
        ) : (
          allTraces.map(trace => (
            <TraceCard
              key={trace.id}
              trace={trace}
              isExpanded={expandedTraceId === trace.id}
              onToggle={() => setExpandedTraceId(
                expandedTraceId === trace.id ? null : trace.id
              )}
            />
          ))
        )}
      </div>
    </div>
  );
};

export default SessionSwitchPerfDebugPlugin;
