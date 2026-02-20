import { copyTextToClipboard } from '@/utils/clipboardUtils';

/**
 * PageLifecycleDebugPlugin - 页面生命周期监控插件
 * 
 * 监控侧边栏各页面的挂载/卸载/显示/隐藏状态，
 * 用于诊断保活机制是否生效和页面重新加载问题。
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Button } from '../../components/ui/shad/Button';
import { Badge } from '../../components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/shad/Card';
import { Separator } from '../../components/ui/shad/Separator';
import { CustomScrollArea } from '../../components/custom-scroll-area';
import { 
  Trash2, 
  Copy, 
  CheckCircle2, 
  AlertTriangle,
  Eye,
  EyeOff,
  RefreshCw,
  FileText,
  Filter,
  Download,
} from 'lucide-react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { 
  pageLifecycleTracker, 
  type PageLifecycleLog, 
  type PageLifecycleEvent 
} from '../services/pageLifecycleTracker';

// =============================================================================
// 常量
// =============================================================================

const EVENT_LABELS: Record<PageLifecycleEvent, string> = {
  mount: '挂载',
  unmount: '卸载',
  show: '显示',
  hide: '隐藏',
  data_load: '加载数据',
  data_ready: '数据就绪',
  reset: '状态重置',
  effect_run: 'Effect执行',
  view_switch: '视图切换',
  render_start: '渲染开始',
  render_end: '渲染完成',
  sidebar_click: '侧边栏点击',
  custom: '自定义',
  view_evict: '视图驱逐',
};

const EVENT_COLORS: Record<PageLifecycleEvent, string> = {
  mount: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  unmount: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  show: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  hide: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
  data_load: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  data_ready: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
  reset: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  effect_run: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200',
  view_switch: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  view_evict: 'bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-200',
  render_start: 'bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-200',
  render_end: 'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200',
  sidebar_click: 'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-200',
  custom: 'bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200',
};

// =============================================================================
// 辅助组件
// =============================================================================

const PageStateCard: React.FC<{
  pageId: string;
  state: {
    mounted: boolean;
    visible: boolean;
    mountCount: number;
    lastMountTime?: number;
    lastShowTime?: number;
  };
}> = ({ pageId, state }) => {
  const hasProblem = state.mountCount > 1;
  
  return (
    <div className={`p-2 rounded border ${hasProblem ? 'border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20' : 'border-border'}`}>
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm truncate flex-1" title={pageId}>
          {pageId}
        </span>
        <div className="flex items-center gap-1 ml-2">
          {state.mounted ? (
            state.visible ? (
              <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                <Eye className="w-3 h-3 mr-1" />可见
              </Badge>
            ) : (
              <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                <EyeOff className="w-3 h-3 mr-1" />保活
              </Badge>
            )
          ) : (
            <Badge className="bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200">
              未挂载
            </Badge>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
        <span className={hasProblem ? 'text-yellow-600 dark:text-yellow-400 font-medium' : ''}>
          挂载次数: {state.mountCount}
        </span>
        {hasProblem && (
          <AlertTriangle className="w-3 h-3 text-yellow-500" />
        )}
      </div>
    </div>
  );
};

const LogItem: React.FC<{
  log: PageLifecycleLog;
}> = ({ log }) => {
  const time = new Date(log.timestamp).toISOString().slice(11, 23);
  
  return (
    <div className="flex items-start gap-2 py-1.5 px-2 hover:bg-muted/50 rounded text-xs">
      <span className="text-muted-foreground font-mono w-20 flex-shrink-0">
        {time}
      </span>
      <span className="font-medium w-28 flex-shrink-0 truncate" title={log.pageName}>
        {log.pageName}
      </span>
      <Badge className={`${EVENT_COLORS[log.event]} text-xs px-1.5 py-0`}>
        {EVENT_LABELS[log.event]}
      </Badge>
      {log.duration && (
        <span className="text-muted-foreground">
          {log.duration}ms
        </span>
      )}
      {log.detail && (
        <span className="text-muted-foreground truncate flex-1" title={log.detail}>
          {log.detail}
        </span>
      )}
    </div>
  );
};

// =============================================================================
// 主组件
// =============================================================================

const PageLifecycleDebugPlugin: React.FC<DebugPanelPluginProps> = ({ isActive }) => {
  const [logs, setLogs] = useState<PageLifecycleLog[]>([]);
  const [pageStates, setPageStates] = useState<Map<string, any>>(new Map());
  const [filterEvent, setFilterEvent] = useState<PageLifecycleEvent | 'all'>('all');
  const [filterPage, setFilterPage] = useState<string>('all');
  const [copied, setCopied] = useState(false);

  // 订阅日志更新
  useEffect(() => {
    if (!isActive) return;
    
    const updateData = () => {
      setLogs(pageLifecycleTracker.getLogs());
      setPageStates(pageLifecycleTracker.getPageStates());
    };
    
    updateData();
    const unsubscribe = pageLifecycleTracker.subscribe(updateData);
    return unsubscribe;
  }, [isActive]);

  // 过滤日志
  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      if (filterEvent !== 'all' && log.event !== filterEvent) return false;
      if (filterPage !== 'all' && log.pageId !== filterPage) return false;
      return true;
    });
  }, [logs, filterEvent, filterPage]);

  // 获取所有页面列表
  const pageList = useMemo(() => {
    const pages = new Set<string>();
    logs.forEach(log => pages.add(log.pageId));
    return Array.from(pages).sort();
  }, [logs]);

  // 清空日志
  const handleClear = useCallback(() => {
    pageLifecycleTracker.clear();
  }, []);

  // 复制报告
  const handleCopyReport = useCallback(async () => {
    const report = pageLifecycleTracker.generateReport();
    try {
      await copyTextToClipboard(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('复制失败:', e);
    }
  }, []);

  // 导出完整日志
  const handleExportLogs = useCallback(async () => {
    const data = {
      generatedAt: new Date().toISOString(),
      pageStates: Object.fromEntries(pageLifecycleTracker.getPageStates()),
      logs: pageLifecycleTracker.getLogs(),
    };
    const json = JSON.stringify(data, null, 2);
    try {
      await copyTextToClipboard(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('导出失败:', e);
    }
  }, []);

  if (!isActive) return null;

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏 */}
      <div className="flex items-center justify-between p-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleClear}
            className="h-7 text-xs"
          >
            <Trash2 className="w-3 h-3 mr-1" />
            清空
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyReport}
            className="h-7 text-xs"
          >
            {copied ? (
              <CheckCircle2 className="w-3 h-3 mr-1 text-green-500" />
            ) : (
              <Copy className="w-3 h-3 mr-1" />
            )}
            复制报告
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportLogs}
            className="h-7 text-xs"
          >
            <Download className="w-3 h-3 mr-1" />
            导出JSON
          </Button>
        </div>
        <Badge variant="outline" className="text-xs">
          {logs.length} 条日志
        </Badge>
      </div>

      <CustomScrollArea className="flex-1">
        <div className="p-3 space-y-4">
          {/* 页面状态概览 */}
          <Card>
            <CardHeader className="py-2 px-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <FileText className="w-4 h-4" />
                页面状态概览
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3">
              {pageStates.size === 0 ? (
                <div className="text-xs text-muted-foreground text-center py-4">
                  暂无页面状态数据，请切换页面触发监听
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2">
                  {Array.from(pageStates.entries()).map(([pageId, state]) => (
                    <PageStateCard key={pageId} pageId={pageId} state={state} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* 过滤器 */}
          <div className="flex items-center gap-2 text-xs">
            <Filter className="w-3 h-3 text-muted-foreground" />
            <select
              value={filterEvent}
              onChange={(e) => setFilterEvent(e.target.value as PageLifecycleEvent | 'all')}
              className="h-7 px-2 rounded border border-input bg-background text-xs"
            >
              <option value="all">全部事件</option>
              {Object.entries(EVENT_LABELS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            <select
              value={filterPage}
              onChange={(e) => setFilterPage(e.target.value)}
              className="h-7 px-2 rounded border border-input bg-background text-xs"
            >
              <option value="all">全部页面</option>
              {pageList.map(page => (
                <option key={page} value={page}>{page}</option>
              ))}
            </select>
          </div>

          <Separator />

          {/* 日志列表 */}
          <div className="space-y-0.5">
            {filteredLogs.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center py-8">
                暂无日志，请切换侧边栏页面以触发监听
              </div>
            ) : (
              filteredLogs.slice(-100).reverse().map(log => (
                <LogItem key={log.id} log={log} />
              ))
            )}
          </div>
        </div>
      </CustomScrollArea>

      {/* 底部提示 */}
      <div className="p-2 border-t border-border text-xs text-muted-foreground">
        💡 提示：挂载次数 &gt; 1 表示保活机制可能未生效，频繁的「加载数据」事件表示存在重复加载问题
      </div>
    </div>
  );
};

export default PageLifecycleDebugPlugin;
