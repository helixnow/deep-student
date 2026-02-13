/**
 * ExportPanel - 导出功能面板
 *
 * 提供卡片导出功能，包括：
 * - 导出为 APKG 文件
 * - 通过 AnkiConnect 导入到 Anki
 * - 导出级别选择（文档/任务/选中）
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Z_INDEX } from '@/config/zIndex';
import { Upload, Settings } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import type { ExportLevel } from '../types';

export interface ExportPanelProps {
  /** 是否有文档 ID */
  hasDocument: boolean;
  /** 总卡片数 */
  totalCards: number;
  /** 可导出的卡片数（排除错误卡片） */
  exportableCount: number;
  /** 🔧 P1-48: 当前任务的卡片数 */
  taskCardCount?: number;
  /** 🔧 P1-48: 当前任务可导出的卡片数 */
  taskExportableCount?: number;
  /** 🔧 P1-48: 选中的卡片数 */
  selectedCardCount?: number;
  /** 🔧 P1-48: 选中的可导出卡片数 */
  selectedExportableCount?: number;
  /** 是否正在导出 */
  isExporting: boolean;
  /** 是否启用了 AnkiConnect */
  isAnkiConnectEnabled: boolean;
  /** AnkiConnect 是否可用 */
  isAnkiConnectAvailable: boolean | null;
  /** AnkiConnect 连接错误 */
  ankiConnectionError?: string | null;
  /** 牌组名称是否有效 */
  hasDeckName: boolean;
  /** 笔记类型是否有效 */
  hasNoteType: boolean;
  /** 导出为 APKG */
  onExportApkg: (level: ExportLevel) => void;
  /** 导出到 Anki */
  onExportToAnki: (level: ExportLevel) => void;
  /** 重新检测 AnkiConnect */
  onRecheckAnki: () => void;
  /** 打开 AnkiConnect 设置 */
  onOpenAnkiSettings: () => void;
}

/**
 * 导出功能面板组件
 */
export function ExportPanel({
  hasDocument,
  totalCards,
  exportableCount,
  taskCardCount = 0,
  taskExportableCount = 0,
  selectedCardCount = 0,
  selectedExportableCount = 0,
  isExporting,
  isAnkiConnectEnabled,
  isAnkiConnectAvailable,
  ankiConnectionError,
  hasDeckName,
  hasNoteType,
  onExportApkg,
  onExportToAnki,
  onRecheckAnki,
  onOpenAnkiSettings,
}: ExportPanelProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(true);

  // 🔧 P1-48: 分级导出条件
  const baseCanExport = !isExporting && hasDeckName && hasNoteType;
  const canExportDocument = baseCanExport && exportableCount > 0;
  const canExportTask = baseCanExport && taskExportableCount > 0;
  const canExportSelection = baseCanExport && selectedExportableCount > 0;

  const canExport = exportableCount > 0 && !isExporting && hasDeckName && hasNoteType;
  const canExportToAnki = canExport && isAnkiConnectAvailable;
  const canExportTaskToAnki = canExportTask && isAnkiConnectAvailable;
  const canExportSelectionToAnki = canExportSelection && isAnkiConnectAvailable;

  return (
    <div
      style={{
        position: 'absolute',
        top: '20px',
        left: '20px',
        background: 'hsl(var(--card) / 0.95)',
        backdropFilter: 'blur(12px)',
        borderRadius: '12px',
        padding: isExpanded ? '14px' : '12px',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.1)',
        zIndex: Z_INDEX.popover,
        width: 'auto',
        transition: 'all 0.3s ease',
      }}
    >
      {/* 导出选项标题 */}
      <div className="export-actions">
        <h5
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: isExpanded ? '12px' : '0',
            fontSize: '16px',
            fontWeight: 600,
            margin: 0,
            cursor: 'pointer',
          }}
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <Upload size={18} />
          {t('export_options_title')}
          <span style={{ marginLeft: 'auto', fontSize: '14px' }}>
            {isExpanded ? '▼' : '▶'}
          </span>
        </h5>

        {/* 导出按钮 */}
        {isExpanded && (
          <div
            className="export-buttons"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              marginTop: '12px',
            }}
          >
            {/* 🔧 P1-48: 选中级导出（优先显示） */}
            {selectedCardCount > 0 && (
              <button
                className="btn btn-primary"
                style={{
                  padding: '8px 16px',
                  width: '100%',
                  fontSize: '14px',
                }}
                disabled={!canExportSelection}
                onClick={() => onExportApkg('selection')}
              >
                {t('export_selection')} ({selectedExportableCount}/{selectedCardCount}
                {t('cards_unit')})
              </button>
            )}

            {/* 🔧 P1-48: 任务级导出 */}
            {taskCardCount > 0 && (
              <button
                className="btn btn-info"
                style={{
                  padding: '8px 16px',
                  width: '100%',
                  fontSize: '14px',
                }}
                disabled={!canExportTask}
                onClick={() => onExportApkg('task')}
              >
                {t('export_task')} ({taskExportableCount}/{taskCardCount}
                {t('cards_unit')})
              </button>
            )}

            {/* 文档级导出 */}
            {hasDocument && (
              <button
                className="btn btn-success"
                style={{
                  padding: '8px 16px',
                  width: '100%',
                  fontSize: '14px',
                }}
                disabled={!canExportDocument}
                onClick={() => onExportApkg('document')}
              >
                {t('export_document')} ({exportableCount}/{totalCards}
                {t('cards_unit')})
              </button>
            )}

            {/* 仅有错误卡片提示 */}
            {totalCards > 0 && exportableCount === 0 && (
              <div className="text-xs text-amber-500">
                {t('export_only_error_cards_hint')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* AnkiConnect 导出选项 */}
      {isAnkiConnectEnabled && isExpanded && (
        <div
          className="anki-connect-actions"
          style={{
            marginTop: '12px',
            borderTop: '1px solid hsl(var(--border))',
            paddingTop: '12px',
          }}
        >
          <h5
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginBottom: '8px',
              fontSize: '16px',
              fontWeight: 600,
              margin: 0,
            }}
          >
            <Settings size={18} />
            {t('anki_connect_title')}
          </h5>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {/* AnkiConnect 不可用警告 */}
            {isAnkiConnectAvailable === false && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400 space-y-2">
                <div>
                  {ankiConnectionError
                    ? t('anki_connect_error_hint', { error: ankiConnectionError })
                    : t('anki_connect_offline_hint')}
                </div>
                <div className="flex flex-wrap gap-2">
                  <NotionButton size="sm" variant="ghost" onClick={onRecheckAnki}>
                    {t('anki_connect_retry_button')}
                  </NotionButton>
                  <NotionButton size="sm" variant="ghost" onClick={onOpenAnkiSettings}>
                    {t('anki_connect_open_settings_button')}
                  </NotionButton>
                </div>
              </div>
            )}

            {/* 🔧 P1-48: 选中级导出到 Anki */}
            {selectedCardCount > 0 && (
              <button
                className="btn btn-primary"
                style={{
                  padding: '8px 16px',
                  width: '100%',
                  fontSize: '14px',
                }}
                disabled={!canExportSelectionToAnki}
                onClick={() => onExportToAnki('selection')}
              >
                {t('actions.export_selection_to_anki')} ({selectedExportableCount}/
                {selectedCardCount}
                {t('cards_unit')})
              </button>
            )}

            {/* 🔧 P1-48: 任务级导出到 Anki */}
            {taskCardCount > 0 && (
              <button
                className="btn btn-info"
                style={{
                  padding: '8px 16px',
                  width: '100%',
                  fontSize: '14px',
                }}
                disabled={!canExportTaskToAnki}
                onClick={() => onExportToAnki('task')}
              >
                {t('actions.export_task_to_anki')} ({taskExportableCount}/
                {taskCardCount}
                {t('cards_unit')})
              </button>
            )}

            {/* 导出到 Anki 按钮 */}
            <button
              className="btn btn-success"
              style={{
                padding: '8px 16px',
                width: '100%',
                fontSize: '14px',
              }}
              disabled={!canExportToAnki}
              onClick={() => onExportToAnki('document')}
            >
              {t('actions.export_document_to_anki')} ({exportableCount}/
              {totalCards}
              {t('cards_unit')})
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default ExportPanel;
