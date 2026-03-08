/**
 * Chat V2 - 网络搜索面板
 *
 * 选择要启用的搜索引擎
 */

import React, { useMemo, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type StoreApi } from 'zustand';
import { Globe, X, Check } from 'lucide-react';
import { useMobileLayoutSafe } from '@/components/layout/MobileLayoutContext';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { useDialogControl } from '@/contexts/DialogControlContext';
import type { ChatStore } from '../../core/types';

// ============================================================================
// 类型
// ============================================================================

interface SearchPanelProps {
  store: StoreApi<ChatStore>;
  onClose: () => void;
}

// ============================================================================
// 组件
// ============================================================================

export const SearchPanel: React.FC<SearchPanelProps> = ({ store, onClose }) => {
  const { t } = useTranslation(['analysis', 'common']);
  const mobileLayout = useMobileLayoutSafe();
  const isMobile = mobileLayout?.isMobile ?? false;

  // 从 DialogControlContext 获取搜索引擎数据
  const {
    availableSearchEngines,
    selectedSearchEngines,
    setSelectedSearchEngines,
    ready,
  } = useDialogControl();

  // 从 Store 获取状态
  const sessionStatus = useStore(store, (s) => s.sessionStatus);
  // 🚀 P0-2 性能优化：仅订阅实际使用的字段，避免其他 chatParams 字段变化时重渲染
  const storeSelectedSearchEngines = useStore(store, (s) => s.chatParams.selectedSearchEngines);
  const isStreaming = sessionStatus === 'streaming';

  // 🔧 修复闪动：使用 ref 追踪是否已完成初始同步，避免循环更新
  const hasSyncedFromStoreRef = useRef(false);
  const isUserActionRef = useRef(false);

  // 从 Store 恢复选择状态（仅在组件挂载时执行一次）
  useEffect(() => {
    if (hasSyncedFromStoreRef.current || !ready) return;
    
    const savedEngines = storeSelectedSearchEngines;
    if (savedEngines && savedEngines.length > 0) {
      // 只恢复仍然存在的引擎
      const validEngines = savedEngines.filter((id: string) =>
        availableSearchEngines.some((e) => e.id === id)
      );
      if (validEngines.length > 0 && validEngines.join(',') !== selectedSearchEngines.join(',')) {
        setSelectedSearchEngines(validEngines);
      }
    }
    hasSyncedFromStoreRef.current = true;
  }, [ready, availableSearchEngines, storeSelectedSearchEngines, selectedSearchEngines, setSelectedSearchEngines]);

  // 同步选择到 Store 和持久化设置（仅在用户操作后执行）
  useEffect(() => {
    // 跳过初始同步阶段
    if (!hasSyncedFromStoreRef.current) return;
    // 只有用户操作才同步到 Store
    if (!isUserActionRef.current) {
      isUserActionRef.current = true; // 标记后续更新为用户操作
      return;
    }
    
    const currentStoreEngines = store.getState().chatParams.selectedSearchEngines || [];
    if (selectedSearchEngines.join(',') !== currentStoreEngines.join(',')) {
      store.getState().setChatParams({ selectedSearchEngines: selectedSearchEngines });
      
      // 持久化到设置
      import('@/utils/tauriApi').then(({ TauriAPI }) => {
        TauriAPI.saveSetting('session.selected_search_engines', selectedSearchEngines.join(','))
          .catch((err) => console.warn('[SearchPanel] Failed to save search engine selection:', err));
      });
    }
  }, [selectedSearchEngines, store]);

  // 选中的引擎集合
  const selectedEngineSet = useMemo(
    () => new Set(selectedSearchEngines),
    [selectedSearchEngines]
  );

  // 切换引擎选择
  const handleToggleEngine = useCallback(
    (engineId: string) => {
      if (!ready || isStreaming) return;
      if (selectedEngineSet.has(engineId)) {
        setSelectedSearchEngines(selectedSearchEngines.filter((id) => id !== engineId));
      } else {
        setSelectedSearchEngines([...selectedSearchEngines, engineId]);
      }
    },
    [ready, isStreaming, selectedEngineSet, selectedSearchEngines, setSelectedSearchEngines]
  );

  // 全选/取消全选
  const handleToggleAll = useCallback(() => {
    if (!ready || isStreaming) return;
    if (selectedSearchEngines.length === availableSearchEngines.length) {
      setSelectedSearchEngines([]);
    } else {
      setSelectedSearchEngines(availableSearchEngines.map((e) => e.id));
    }
  }, [ready, isStreaming, selectedSearchEngines.length, availableSearchEngines, setSelectedSearchEngines]);

  const allSelected =
    availableSearchEngines.length > 0 &&
    selectedSearchEngines.length === availableSearchEngines.length;

  return (
    <div className="space-y-3">
      {/* 面板头部 - 移动端隐藏 */}
      {!isMobile && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Globe size={16} />
            <span>{t('analysis:input_bar.search_engine.title')}</span>
            {selectedSearchEngines.length > 0 && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                {selectedSearchEngines.length}
              </span>
            )}
          </div>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={onClose} aria-label={t('common:actions.cancel')}>
            <X size={16} />
          </NotionButton>
        </div>
      )}

      {/* 说明文字 */}
      <div className="text-xs text-muted-foreground">
        {t('common:messages.select_search_engines')}
      </div>

      {/* 搜索引擎列表 */}
      <div className="space-y-2">
        {!ready ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            {t('common:loading_config')}
          </div>
        ) : availableSearchEngines.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            {t('common:messages.no_search_engines_config')}
          </div>
        ) : (
          availableSearchEngines.map((engine) => {
            const isSelected = selectedEngineSet.has(engine.id);
            return (
              <NotionButton
                key={engine.id}
                variant="ghost"
                size="sm"
                onClick={() => handleToggleEngine(engine.id)}
                disabled={!ready || isStreaming}
                className={cn(
                  'w-full !justify-start gap-3 !rounded-lg border !p-3 text-left',
                  isSelected
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-primary/50 hover:bg-accent/30',
                  isStreaming && 'pointer-events-none opacity-60'
                )}
              >
                {/* 选中指示器 */}
                <div
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors',
                    isSelected
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-muted-foreground/30'
                  )}
                >
                  {isSelected && <Check size={12} />}
                </div>

                {/* 引擎信息 */}
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-sm">{engine.label}</span>
                </div>
              </NotionButton>
            );
          })
        )}
      </div>

      {/* 底部操作 */}
      {availableSearchEngines.length > 0 && (
        <div className="flex items-center justify-between">
          <NotionButton variant="ghost" size="sm" onClick={handleToggleAll} disabled={!ready || isStreaming} className="text-muted-foreground hover:underline">
            {allSelected ? t('common:deselect_all') : t('common:select_all')}
          </NotionButton>
        </div>
      )}

      {/* 提示 */}
      <div className="text-[11px] text-muted-foreground">
        {t('analysis:input_bar.search_engine.hint')}
      </div>
    </div>
  );
};

export default SearchPanel;
