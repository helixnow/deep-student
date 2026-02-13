/**
 * 索引诊断面板
 * 
 * 用于调试索引问题，显示数据库真实状态。
 * 支持日志记录和复制。
 */

import React, { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bug,
  Copy,
  Trash2,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Play,
  RotateCcw,
} from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  getIndexDiagnostic,
  resetDisabledToPending,
  resetIndexedWithoutEmbeddings,
  diagnoseLanceSchema,
  type IndexDiagnosticInfo,
  type LanceTableDiagnostic,
} from '@/api/vfsRagApi';
import { batchIndexPendingLegacy as batchIndexPending } from '@/api/vfsUnifiedIndexApi';
import { showGlobalNotification } from '@/components/UnifiedNotification';

interface LogEntry {
  timestamp: string;
  type: 'info' | 'success' | 'error' | 'warning';
  message: string;
  data?: IndexDiagnosticInfo;
  lanceData?: LanceTableDiagnostic[];
}

interface IndexDiagnosticPanelProps {
  onRefresh?: () => void;
}

export const IndexDiagnosticPanel: React.FC<IndexDiagnosticPanelProps> = ({ onRefresh }) => {
  const { t } = useTranslation(['learningHub']);
  const [isExpanded, setIsExpanded] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showDetails, setShowDetails] = useState<number | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((type: LogEntry['type'], message: string, data?: IndexDiagnosticInfo, lanceData?: LanceTableDiagnostic[]) => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      type,
      message,
      data,
      lanceData,
    };
    setLogs(prev => [...prev, entry]);
    setTimeout(() => {
      if (logContainerRef.current) {
        logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
      }
    }, 100);
  }, []);

  const handleGetDiagnostic = useCallback(async (label: string = t('diagnostic.manualDiag')) => {
    setIsLoading(true);
    addLog('info', `[${label}] ${t('diagnostic.diagStarting')}`);
    
    try {
      const info = await getIndexDiagnostic();
      addLog('success', `[${label}] ${t('diagnostic.diagComplete')}`, info);
      
      const issues = info.consistencyChecks.filter(c => !c.passed);
      if (issues.length > 0) {
        addLog('warning', `[${label}] ${t('diagnostic.consistencyIssues', { count: issues.length, details: issues.map(i => i.details).join('; ') })}`);
      }
    } catch (error: unknown) {
      addLog('error', `[${label}] ${t('diagnostic.diagFailed', { error: String(error) })}`);
    } finally {
      setIsLoading(false);
    }
  }, [addLog, t]);

  const handleResetDisabled = useCallback(async () => {
    setIsLoading(true);
    addLog('info', t('diagnostic.resetStarting'));
    
    try {
      await handleGetDiagnostic(t('diagnostic.resetBefore'));
      
      const count = await resetDisabledToPending();
      addLog('success', t('diagnostic.resetCount', { count }));
      
      await handleGetDiagnostic(t('diagnostic.resetAfter'));
      
      showGlobalNotification('success', t('diagnostic.resetSuccess', { count }));
      onRefresh?.();
    } catch (error: unknown) {
      addLog('error', `${t('diagnostic.resetFailed')}: ${error}`);
      showGlobalNotification('error', t('diagnostic.resetFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [addLog, handleGetDiagnostic, onRefresh, t]);

  const handleResetIndexedWithoutEmb = useCallback(async () => {
    setIsLoading(true);
    addLog('info', t('diagnostic.resetNoEmbedStarting'));
    
    try {
      await handleGetDiagnostic(t('diagnostic.resetBefore'));
      
      const count = await resetIndexedWithoutEmbeddings();
      addLog('success', t('diagnostic.resetNoEmbedCount', { count }));
      
      await handleGetDiagnostic(t('diagnostic.resetAfter'));
      
      showGlobalNotification('success', t('diagnostic.resetSuccess', { count }));
      onRefresh?.();
    } catch (error: unknown) {
      addLog('error', `${t('diagnostic.resetFailed')}: ${error}`);
      showGlobalNotification('error', t('diagnostic.resetFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [addLog, handleGetDiagnostic, onRefresh, t]);

  const handleIndexWithDiagnostic = useCallback(async () => {
    setIsLoading(true);
    addLog('info', t('diagnostic.indexStarting'));
    
    try {
      await handleGetDiagnostic(t('diagnostic.indexBefore'));
      
      addLog('info', t('diagnostic.indexBatchStarting'));
      const result = await batchIndexPending(50);
      addLog('success', t('diagnostic.indexResult', { success: result.successCount, fail: result.failCount, total: result.total }));
      
      await handleGetDiagnostic(t('diagnostic.indexAfter'));
      
      showGlobalNotification('success', t('diagnostic.indexSuccess', { success: result.successCount }));
      onRefresh?.();
    } catch (error: unknown) {
      addLog('error', `${t('diagnostic.indexFailed')}: ${error}`);
      showGlobalNotification('error', t('diagnostic.indexFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [addLog, handleGetDiagnostic, onRefresh, t]);

  const handleDiagnoseLanceSchema = useCallback(async () => {
    setIsLoading(true);
    addLog('info', t('diagnostic.lanceStarting'));
    
    try {
      const diagnostics = await diagnoseLanceSchema('text');
      
      if (diagnostics.length === 0) {
        addLog('warning', t('diagnostic.lanceNoTables'));
      } else {
        const hasIssues = diagnostics.some(d => d.issueDescription);
        const totalRows = diagnostics.reduce((sum, d) => sum + d.rowCount, 0);
        const tablesWithMetadata = diagnostics.filter(d => d.hasMetadataColumn).length;
        const tablesWithPageIndex = diagnostics.filter(d => d.metadataWithPageIndex > 0).length;
        
        addLog(
          hasIssues ? 'warning' : 'success',
          t('diagnostic.lanceResult', { tables: diagnostics.length, rows: totalRows, metadata: tablesWithMetadata, total: diagnostics.length, pageIndex: tablesWithPageIndex }),
          undefined,
          diagnostics
        );
        
        for (const d of diagnostics) {
          if (d.issueDescription) {
            addLog('error', `[Lance] ${d.tableName}: ${d.issueDescription}`);
          }
        }
      }
    } catch (error: unknown) {
      addLog('error', `${t('diagnostic.lanceFailed')}: ${error}`);
      showGlobalNotification('error', t('diagnostic.lanceFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [addLog, t]);

  const handleCopyLogs = useCallback(() => {
    const logText = logs.map(log => {
      let text = `[${log.timestamp}] [${log.type.toUpperCase()}] ${log.message}`;
      if (log.data) {
        text += '\n' + JSON.stringify(log.data, null, 2);
      }
      if (log.lanceData) {
        text += '\n' + JSON.stringify(log.lanceData, null, 2);
      }
      return text;
    }).join('\n\n');
    
    navigator.clipboard.writeText(logText).then(() => {
      showGlobalNotification('success', t('diagnostic.logsCopied'));
    }).catch(() => {
      showGlobalNotification('error', t('diagnostic.copyFailed'));
    });
  }, [logs]);

  const handleClearLogs = useCallback(() => {
    setLogs([]);
    setShowDetails(null);
  }, []);

  const getLogIcon = (type: LogEntry['type']) => {
    switch (type) {
      case 'success': return <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />;
      case 'error': return <XCircle className="h-3.5 w-3.5 text-red-500" />;
      case 'warning': return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />;
      default: return <RefreshCw className="h-3.5 w-3.5 text-blue-500" />;
    }
  };

  const formatDiagnosticSummary = (data: IndexDiagnosticInfo) => {
    const { stateCounts, unitsStats, segmentsStats, consistencyChecks, allResources } = data;
    const issues = consistencyChecks.filter(c => !c.passed);
    
    return (
      <div className="mt-2 p-2 bg-muted/30 rounded text-xs font-mono">
        <div className="text-muted-foreground mb-2">
          {t('diagnostic.architecture')}: <span className="text-cyan-500">{data.architectureVersion || 'unknown'}</span>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 mb-2">
          <div>{t('diagnostic.totalResources')}: <span className="text-foreground">{data.totalResources}</span></div>
          <div>{t('diagnostic.totalUnits')}: <span className="text-foreground">{unitsStats?.totalCount ?? 0}</span></div>
          <div>{t('diagnostic.totalSegments')}: <span className="text-foreground">{segmentsStats?.totalCount ?? 0}</span></div>
          <div>{t('diagnostic.textModality')}: <span className="text-foreground">{segmentsStats?.textModalityCount ?? 0}</span></div>
        </div>
        {/* 状态统计 */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border/30 pt-2">
          <div>pending: <span className="text-amber-500">{stateCounts.pending}</span></div>
          <div>indexed: <span className="text-emerald-500">{stateCounts.indexed}</span></div>
          <div>disabled: <span className="text-gray-500">{stateCounts.disabled}</span></div>
          <div>failed: <span className="text-red-500">{stateCounts.failed}</span></div>
        </div>
        {unitsStats && unitsStats.totalCount > 0 && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border/30 pt-2 mt-2">
            <div className="col-span-2 text-muted-foreground">{t('diagnostic.unitStatus')}:</div>
            <div>text_indexed: <span className="text-emerald-500">{unitsStats.textIndexed}</span></div>
            <div>text_pending: <span className="text-amber-500">{unitsStats.textPending}</span></div>
            <div>text_disabled: <span className="text-gray-500">{unitsStats.textDisabled}</span></div>
            <div>text_failed: <span className="text-red-500">{unitsStats.textFailed}</span></div>
          </div>
        )}
        {issues.length > 0 && (
          <div className="mt-2 pt-2 border-t border-border/50">
            <div className="text-amber-500 font-medium mb-1">⚠️ {t('diagnostic.consistencyTitle')}:</div>
            {issues.map((issue, i) => (
              <div key={i} className="text-red-400 ml-2">• {issue.details}</div>
            ))}
          </div>
        )}
        
        {/* 所有资源详情表格 */}
        {allResources && allResources.length > 0 && (
          <div className="mt-3 pt-3 border-t border-border/50">
            <div className="text-cyan-400 font-medium mb-2">📋 {t('diagnostic.resourceDetails', { count: allResources.length })}:</div>
            <CustomScrollArea className="max-h-48">
              <table className="w-full text-[10px]">
                <thead className="sticky top-0 bg-black/80">
                  <tr className="text-gray-400 border-b border-gray-700">
                    <th className="text-left py-1 px-1">{t('diagnostic.tableHeader.nameId')}</th>
                    <th className="text-left py-1 px-1">{t('diagnostic.tableHeader.type')}</th>
                    <th className="text-left py-1 px-1">{t('diagnostic.tableHeader.dbState')}</th>
                    <th className="text-left py-1 px-1">{t('diagnostic.tableHeader.unitState')}</th>
                    <th className="text-right py-1 px-1">{t('diagnostic.tableHeader.units')}</th>
                    <th className="text-right py-1 px-1">{t('diagnostic.tableHeader.segs')}</th>
                    <th className="text-right py-1 px-1">{t('diagnostic.tableHeader.dims')}</th>
                    <th className="text-left py-1 px-1">{t('diagnostic.tableHeader.error')}</th>
                  </tr>
                </thead>
                <tbody>
                  {allResources.map((r) => (
                    <tr key={r.id} className="border-b border-gray-800 hover:bg-white/5">
                      <td className="py-1 px-1 truncate max-w-[120px]" title={r.id}>
                        {r.name || r.id.slice(0, 15)}
                      </td>
                      <td className="py-1 px-1 text-gray-400">{r.resourceType}</td>
                      <td className={cn('py-1 px-1',
                        r.indexState === 'indexed' && 'text-emerald-400',
                        r.indexState === 'pending' && 'text-amber-400',
                        r.indexState === 'failed' && 'text-red-400',
                        r.indexState === 'disabled' && 'text-gray-500',
                      )}>
                        {r.indexState || 'null'}
                      </td>
                      <td className={cn('py-1 px-1',
                        r.unitTextState === 'indexed' && 'text-emerald-400',
                        r.unitTextState === 'pending' && 'text-amber-400',
                        r.unitTextState === 'disabled' && 'text-gray-500',
                      )}>
                        {r.unitTextState || '-'}
                      </td>
                      <td className="py-1 px-1 text-right">{r.unitCount}</td>
                      <td className={cn('py-1 px-1 text-right',
                        r.segmentCount > 0 ? 'text-emerald-400' : 'text-gray-500'
                      )}>
                        {r.segmentCount}
                      </td>
                      <td className="py-1 px-1 text-right text-gray-400">
                        {r.textEmbeddingDim || '-'}
                      </td>
                      <td className="py-1 px-1 truncate max-w-[100px] text-red-400" title={r.indexError || ''}>
                        {r.indexError?.slice(0, 20) || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CustomScrollArea>
          </div>
        )}
      </div>
    );
  };

  const formatLanceDiagnosticSummary = (data: LanceTableDiagnostic[]) => {
    return (
      <div className="mt-2 p-2 bg-muted/30 rounded text-xs font-mono">
        <div className="text-cyan-400 font-medium mb-2">🔍 {t('diagnostic.lanceDiagTitle')}</div>
        {data.map((table, idx) => (
          <div key={idx} className="mb-3 p-2 border border-border/30 rounded">
            <div className="flex items-center gap-2 mb-1">
              <span className={table.schemaValid ? 'text-emerald-400' : 'text-red-400'}>
                {table.schemaValid ? '✓' : '✗'}
              </span>
              <span className="text-foreground font-medium">{table.tableName}</span>
              <span className="text-gray-500">({table.rowCount} {t('diagnostic.lanceRows')})</span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 ml-4 text-[10px]">
              <div>{t('diagnostic.lanceDims')}: <span className="text-foreground">{table.dimension}</span></div>
              <div>{t('diagnostic.lanceCols')}: <span className="text-foreground">{table.columns.length}</span></div>
              <div>
                {t('diagnostic.lanceMetadataCol')}: 
                <span className={table.hasMetadataColumn ? 'text-emerald-400' : 'text-red-400'}>
                  {table.hasMetadataColumn ? ' ✓' : ` ✗ ${t('diagnostic.lanceMetadataMissing')}`}
                </span>
              </div>
              <div>
                {t('diagnostic.lanceHasPageIndex')}: 
                <span className={table.metadataWithPageIndex > 0 ? 'text-emerald-400' : 'text-amber-400'}>
                  {' '}{table.metadataWithPageIndex}/{table.rowCount - table.metadataNullCount}
                </span>
              </div>
            </div>
            {table.issueDescription && (
              <div className="mt-1 ml-4 text-red-400 text-[10px]">
                ⚠️ {table.issueDescription}
              </div>
            )}
            {table.sampleMetadata.length > 0 && (
              <div className="mt-2 ml-4">
                <div className="text-gray-500 text-[10px] mb-1">{t('diagnostic.lanceSampleMetadata')}:</div>
                <div className="max-h-20 overflow-auto text-[9px] bg-black/50 p-1 rounded">
                  {table.sampleMetadata.slice(0, 3).map((m, i) => (
                    <div key={i} className="truncate text-gray-400">
                      {m ? m.slice(0, 100) : '<null>'}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="border-t border-border/50">
      {/* 标题栏 */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-4 py-2 text-sm hover:bg-accent/30 transition-colors"
      >
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <Bug className="h-4 w-4 text-amber-500" />
        <span className="text-muted-foreground">{t('diagnostic.title')}</span>
        {logs.length > 0 && (
          <span className="ml-auto text-xs text-muted-foreground">
            {t('diagnostic.logCount', { count: logs.length })}
          </span>
        )}
      </button>

      {/* 展开内容 */}
      {isExpanded && (
        <div className="px-4 pb-4 space-y-3">
          {/* 操作按钮 */}
          <div className="flex flex-wrap gap-2">
            <NotionButton
              size="sm"
              variant="ghost"
              onClick={() => handleGetDiagnostic()}
              disabled={isLoading}
              className="h-7 text-xs"
            >
              <RefreshCw className={cn('h-3.5 w-3.5 mr-1', isLoading && 'animate-spin')} />
              {t('diagnostic.getDiagnostic')}
            </NotionButton>
            <NotionButton
              size="sm"
              variant="ghost"
              onClick={handleIndexWithDiagnostic}
              disabled={isLoading}
              className="h-7 text-xs"
            >
              <Play className="h-3.5 w-3.5 mr-1" />
              {t('diagnostic.indexWithDiag')}
            </NotionButton>
            <NotionButton
              size="sm"
              variant="ghost"
              onClick={handleResetDisabled}
              disabled={isLoading}
              className="h-7 text-xs text-amber-600"
            >
              <RotateCcw className="h-3.5 w-3.5 mr-1" />
              {t('diagnostic.resetDisabled')}
            </NotionButton>
            <NotionButton
              size="sm"
              variant="ghost"
              onClick={handleResetIndexedWithoutEmb}
              disabled={isLoading}
              className="h-7 text-xs text-amber-600"
            >
              <RotateCcw className="h-3.5 w-3.5 mr-1" />
              {t('diagnostic.resetNoEmbed')}
            </NotionButton>
            <NotionButton
              size="sm"
              variant="ghost"
              onClick={handleDiagnoseLanceSchema}
              disabled={isLoading}
              className="h-7 text-xs text-cyan-600"
            >
              <Bug className="h-3.5 w-3.5 mr-1" />
              Lance Schema
            </NotionButton>
            <div className="flex-1" />
            <NotionButton
              size="sm"
              variant="ghost"
              onClick={handleCopyLogs}
              disabled={logs.length === 0}
              className="h-7 text-xs"
            >
              <Copy className="h-3.5 w-3.5 mr-1" />
              {t('diagnostic.copyLogs')}
            </NotionButton>
            <NotionButton
              size="sm"
              variant="ghost"
              onClick={handleClearLogs}
              disabled={logs.length === 0}
              className="h-7 text-xs text-muted-foreground"
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              {t('diagnostic.clearLogs')}
            </NotionButton>
          </div>

          {/* 日志区域 */}
          <CustomScrollArea
            viewportRef={logContainerRef}
            className="h-64 border rounded-md bg-black/90"
            viewportClassName="p-2 font-mono text-xs"
          >
            {logs.length === 0 ? (
              <div className="h-full flex items-center justify-center text-muted-foreground">
                {t('diagnostic.emptyHint')}
              </div>
            ) : (
              <div className="space-y-2">
                {logs.map((log, index) => (
                  <div key={index} className="group">
                    <div 
                      className={cn(
                        'flex items-start gap-2 cursor-pointer hover:bg-white/5 rounded px-1',
                        (log.data || log.lanceData) && 'cursor-pointer'
                      )}
                      onClick={() => (log.data || log.lanceData) && setShowDetails(showDetails === index ? null : index)}
                    >
                      {getLogIcon(log.type)}
                      <span className="text-gray-500 shrink-0">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                      <span className={cn(
                        'flex-1',
                        log.type === 'error' && 'text-red-400',
                        log.type === 'warning' && 'text-amber-400',
                        log.type === 'success' && 'text-emerald-400',
                        log.type === 'info' && 'text-blue-300',
                      )}>
                        {log.message}
                      </span>
                      {(log.data || log.lanceData) && (
                        <span className="text-gray-500 text-[10px]">
                          {showDetails === index ? '▼' : '▶'} {t('diagnostic.details')}
                        </span>
                      )}
                    </div>
                    {showDetails === index && log.data && formatDiagnosticSummary(log.data)}
                    {showDetails === index && log.lanceData && formatLanceDiagnosticSummary(log.lanceData)}
                  </div>
                ))}
              </div>
            )}
          </CustomScrollArea>

          {/* 使用说明 */}
          <div className="text-[10px] text-muted-foreground">
            <strong>{t('diagnostic.usageTitle')}:</strong> {t('diagnostic.usageDesc')}
          </div>
        </div>
      )}
    </div>
  );
};

export default IndexDiagnosticPanel;
