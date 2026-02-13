import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { AnkiCard } from '../../types';
import { useVirtualizer } from '@tanstack/react-virtual';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import {
  Search, Filter, Download, Tags, Edit, Trash2, 
  Copy, CheckSquare, Square, MoreVertical, X, ChevronDown
} from 'lucide-react';
import { unifiedAlert, unifiedConfirm, unifiedPrompt } from '@/utils/unifiedDialogs';
import BatchEditDialog from './BatchEditDialog';
import FilterBuilder from './FilterBuilder';
import { generateId } from '../../utils/common';
import { ankiApiAdapter, notificationAdapter } from '../../services/ankiApiAdapter';
import './BatchOperationToolbar.css';
import { fileManager } from '../../utils/fileManager';

interface BatchOperationToolbarProps {
  cards: AnkiCard[];
  onCardsUpdate: (cards: AnkiCard[]) => void;
  onSelectionChange?: (selectedIds: Set<string>) => void;
}

interface Filter {
  id: string;
  type: 'tag' | 'content' | 'date' | 'has_image' | 'no_tags' | 'created_today';
  field?: string;
  operator?: string;
  value?: any;
}

export const BatchOperationToolbar: React.FC<BatchOperationToolbarProps> = ({
  cards,
  onCardsUpdate,
  onSelectionChange
}) => {
  const { t } = useTranslation('anki');
  
  // 状态管理
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<Filter[]>([]);
  const [showFilterBuilder, setShowFilterBuilder] = useState(false);
  const [showBatchEdit, setShowBatchEdit] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number>(-1);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  
  // 虚拟列表容器
  const listContainerRef = useRef<HTMLDivElement>(null);
  
  // 过滤后的卡片
  const filteredCards = useMemo(() => {
    let result = cards;
    
    // 应用搜索
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(card => {
        return (
          card.front.toLowerCase().includes(query) ||
          card.back.toLowerCase().includes(query) ||
          card.tags.some(tag => tag.toLowerCase().includes(query))
        );
      });
    }
    
    // 应用过滤器
    activeFilters.forEach(filter => {
      result = applyFilter(result, filter);
    });
    
    return result;
  }, [cards, searchQuery, activeFilters]);
  
  // 虚拟列表设置
  const virtualizer = useVirtualizer({
    count: filteredCards.length,
    getScrollElement: () => listContainerRef.current,
    estimateSize: () => 80,
    overscan: 10
  });
  
  // 选择操作
  const handleSelect = useCallback((cardId: string, index: number, event: React.MouseEvent) => {
    const newSelection = new Set(selectedIds);
    
    if (event.shiftKey && lastSelectedIndex !== -1) {
      // Shift选择：选择范围
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      
      for (let i = start; i <= end; i++) {
        if (i < filteredCards.length) {
          newSelection.add(filteredCards[i].id || filteredCards[i].front);
        }
      }
    } else if (event.ctrlKey || event.metaKey) {
      // Ctrl/Cmd选择：切换单个
      if (newSelection.has(cardId)) {
        newSelection.delete(cardId);
      } else {
        newSelection.add(cardId);
      }
    } else {
      // 普通点击：单选
      newSelection.clear();
      newSelection.add(cardId);
    }
    
    setSelectedIds(newSelection);
    setLastSelectedIndex(index);
    onSelectionChange?.(newSelection);
  }, [selectedIds, lastSelectedIndex, filteredCards, onSelectionChange]);
  
  // 全选/取消全选
  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === filteredCards.length && filteredCards.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredCards.map(c => c.id || c.front)));
    }
  }, [selectedIds, filteredCards]);
  
  // 添加快速过滤器
  const addQuickFilter = (filterType: string) => {
    const newFilter: Filter = {
      id: generateId(),
      type: filterType as any,
      value: true
    };
    setActiveFilters([...activeFilters, newFilter]);
  };
  
  // 批量操作处理器
  const handleBatchAddTags = async () => {
    const tags = unifiedPrompt(t('enter_tags_comma_separated'));
    if (!tags) return;
    
    setIsProcessing(true);
    try {
      const tagList = tags.split(',').map(t => t.trim()).filter(t => t);
      const updatedCards = cards.map(card => {
        if (selectedIds.has(card.id || card.front)) {
          return {
            ...card,
            tags: [...new Set([...card.tags, ...tagList])]
          };
        }
        return card;
      });
      
      await saveToBackend(updatedCards);
      onCardsUpdate(updatedCards);
      showNotification(t('batch_tags_added', { count: selectedIds.size }));
    } catch (error) {
      showNotification(t('batch_operation_failed', { error: error.message }), 'error');
    } finally {
      setIsProcessing(false);
    }
  };
  
  const handleBatchDelete = async () => {
    const confirmed = await Promise.resolve(unifiedConfirm(t('confirm_batch_delete', { count: selectedIds.size })));
    if (!confirmed) {
      return;
    }
    
    setIsProcessing(true);
    try {
      const remainingCards = cards.filter(c => !selectedIds.has(c.id || c.front));
      await deleteFromBackend(Array.from(selectedIds));
      onCardsUpdate(remainingCards);
      setSelectedIds(new Set());
      showNotification(t('batch_deleted', { count: selectedIds.size }));
    } catch (error) {
      showNotification(t('batch_delete_failed', { error: error.message }), 'error');
    } finally {
      setIsProcessing(false);
    }
  };
  
  const handleBatchExport = async (format: string = 'apkg') => {
    setIsProcessing(true);
    try {
      const selectedCards = cards.filter(c => selectedIds.has(c.id || c.front));
      
      const resultPath = await ankiApiAdapter.batchExportCards({
        cards: selectedCards,
        format,
        options: {
          deckName: t('batch_export_deck_name'),
          includeTags: true,
          includeMedia: true
        }
      });

      // iPadOS 优先使用分享面板；桌面端使用保存对话框
      if (format === 'apkg') {
        try {
          const fileName = resultPath.split(/[/\\]/).pop() || 'anki_export.apkg';
          const saveResult = await fileManager.saveFromSource({
            sourcePath: resultPath,
            title: t('save_apkg_file'),
            defaultFileName: fileName,
            filters: [{ name: 'APKG', extensions: ['apkg'] }],
          });
          if (saveResult.canceled) {
            showNotification(t('operation_cancelled'));
          } else {
            showNotification(t('batch_exported', { count: selectedCards.length, format }));
          }
        } catch (e) {
          console.error('保存 APKG 失败:', e);
          showNotification(t('batch_export_failed', { error: String(e) }), 'error');
        }
      } else {
        showNotification(t('batch_exported', { count: selectedCards.length, format }));
      }
    } catch (error) {
      showNotification(t('batch_export_failed', { error: error.message }), 'error');
    } finally {
      setIsProcessing(false);
    }
  };
  
  const handleBatchDuplicate = async () => {
    setIsProcessing(true);
    try {
      const selectedCards = cards.filter(c => selectedIds.has(c.id || c.front));
      const duplicates = selectedCards.map(card => ({
        ...card,
        id: generateId(),
        created_at: new Date().toISOString()
      }));
      
      await saveToBackend([...cards, ...duplicates]);
      onCardsUpdate([...cards, ...duplicates]);
      showNotification(t('batch_duplicated', { count: duplicates.length }));
    } catch (error) {
      showNotification(t('batch_duplicate_failed', { error: error.message }), 'error');
    } finally {
      setIsProcessing(false);
    }
  };
  
  // 快捷键支持
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        toggleSelectAll();
      }
      
      if (e.key === 'Delete' && selectedIds.size > 0) {
        e.preventDefault();
        handleBatchDelete();
      }
      
      if ((e.ctrlKey || e.metaKey) && e.key === 'd' && selectedIds.size > 0) {
        e.preventDefault();
        handleBatchDuplicate();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds, toggleSelectAll]);
  
  return (
    <>
      <div className="batch-operation-toolbar">
        {/* 搜索和筛选区 */}
        <div className="toolbar-section search-filter">
          <div className="search-box">
            <Search size={18} />
            <input
              type="text"
              placeholder={t('search_cards_placeholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="search-input"
            />
            {searchQuery && (
              <button 
                className="clear-search"
                onClick={() => setSearchQuery('')}
              >
                <X size={14} />
              </button>
            )}
          </div>
          
          <button 
            className="filter-button"
            onClick={() => setShowFilterBuilder(true)}
          >
            <Filter size={18} />
            {t('filter')}
            {activeFilters.length > 0 && (
              <span className="filter-count">{activeFilters.length}</span>
            )}
          </button>
        </div>
        
        {/* 快速筛选 */}
        <div className="toolbar-section quick-filters">
          <button 
            className="filter-chip"
            onClick={() => addQuickFilter('has_image')}
          >
            {t('has_image')}
          </button>
          <button 
            className="filter-chip"
            onClick={() => addQuickFilter('no_tags')}
          >
            {t('no_tags')}
          </button>
          <button 
            className="filter-chip"
            onClick={() => addQuickFilter('created_today')}
          >
            {t('created_today')}
          </button>
        </div>
        
        {/* 选择信息 */}
        <div className="toolbar-section selection-info">
          <span className="selection-count">
            {selectedIds.size} / {filteredCards.length} {t('selected')}
          </span>
          <button 
            className="select-all-btn"
            onClick={toggleSelectAll}
          >
            {selectedIds.size === filteredCards.length && filteredCards.length > 0 ? (
              <>
                <Square size={16} />
                {t('deselect_all')}
              </>
            ) : (
              <>
                <CheckSquare size={16} />
                {t('select_all')}
              </>
            )}
          </button>
        </div>
        
        {/* 批量操作按钮 */}
        <div className="toolbar-section batch-actions">
          <button
            className="action-btn"
            onClick={() => setShowBatchEdit(true)}
            disabled={selectedIds.size === 0 || isProcessing}
          >
            <Edit size={18} />
            {t('edit')}
          </button>
          
          <button
            className="action-btn"
            onClick={handleBatchAddTags}
            disabled={selectedIds.size === 0 || isProcessing}
          >
            <Tags size={18} />
            {t('tags')}
          </button>
          
          <button
            className="action-btn"
            onClick={() => handleBatchExport()}
            disabled={selectedIds.size === 0 || isProcessing}
          >
            <Download size={18} />
            {t('export')}
          </button>
          
          <button
            className="action-btn"
            onClick={handleBatchDuplicate}
            disabled={selectedIds.size === 0 || isProcessing}
          >
            <Copy size={18} />
            {t('duplicate')}
          </button>
          
          <button
            className="action-btn danger"
            onClick={handleBatchDelete}
            disabled={selectedIds.size === 0 || isProcessing}
          >
            <Trash2 size={18} />
            {t('delete')}
          </button>
          
          <div className="dropdown-container">
            <button 
              className="action-btn more"
              onClick={() => setShowMoreMenu(!showMoreMenu)}
            >
              <MoreVertical size={18} />
            </button>
            
            {showMoreMenu && (
              <div className="dropdown-menu">
                <button onClick={() => handleBatchExport('csv')}>
                  {t('export_as_csv')}
                </button>
                <button onClick={() => handleBatchExport('json')}>
                  {t('export_as_json')}
                </button>
                <button onClick={() => handleBatchExport('markdown')}>
                  {t('export_as_markdown')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      
      {/* 卡片列表（虚拟滚动） */}
      <div 
        ref={listContainerRef}
        className="batch-cards-list"
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative'
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const card = filteredCards[virtualItem.index];
            const cardId = card.id || card.front;
            const isSelected = selectedIds.has(cardId);
            
            return (
              <div
                key={virtualItem.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualItem.size}px`,
                  transform: `translateY(${virtualItem.start}px)`
                }}
              >
                <BatchCardItem
                  card={card}
                  isSelected={isSelected}
                  onSelect={(e) => handleSelect(cardId, virtualItem.index, e)}
                />
              </div>
            );
          })}
        </div>
      </div>
      
      {/* 对话框 */}
      {showFilterBuilder && (
          <FilterBuilder
            filters={activeFilters}
            onApply={(newFilters: Filter[]) => {
              setActiveFilters(() => newFilters);
              setShowFilterBuilder(false);
            }}
            onClose={() => setShowFilterBuilder(false)}
          />
      )}
      
      {showBatchEdit && (
        <BatchEditDialog
          cards={cards.filter(c => selectedIds.has(c.id || c.front))}
          onSave={async (changes) => {
            const updatedCards = applyBatchChanges(cards, selectedIds, changes);
            await saveToBackend(updatedCards);
            onCardsUpdate(updatedCards);
            setShowBatchEdit(false);
            showNotification(t('batch_updated', { count: selectedIds.size }));
          }}
          onClose={() => setShowBatchEdit(false)}
        />
      )}
    </>
  );
};

// 卡片项组件
interface BatchCardItemProps {
  card: AnkiCard;
  isSelected: boolean;
  onSelect: (event: React.MouseEvent) => void;
}

const BatchCardItem: React.FC<BatchCardItemProps> = React.memo(({
  card,
  isSelected,
  onSelect
}) => {
  const { t } = useTranslation('anki');
  
  return (
    <div 
      className={`batch-card-item ${isSelected ? 'selected' : ''}`}
      onClick={onSelect}
    >
      <div className="card-checkbox">
        {isSelected ? <CheckSquare size={20} /> : <Square size={20} />}
      </div>
      
      <div className="card-content">
        <div className="card-front">{card.front}</div>
        <div className="card-back">{card.back}</div>
        
        {card.tags.length > 0 && (
          <div className="card-tags">
            {card.tags.map((tag, index) => (
              <span key={index} className="tag">{tag}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

// 辅助函数
function applyFilter(cards: AnkiCard[], filter: Filter): AnkiCard[] {
  switch (filter.type) {
    case 'tag':
      return cards.filter(card => {
        if (filter.operator === 'contains') {
          return card.tags.some(tag => tag.includes(filter.value));
        } else if (filter.operator === 'not_contains') {
          return !card.tags.some(tag => tag.includes(filter.value));
        } else if (filter.operator === 'equals') {
          return card.tags.includes(filter.value);
        }
        return true;
      });
      
    case 'content':
      const searchValue = filter.value?.toLowerCase() || '';
      return cards.filter(card => {
        const content = (card.front + ' ' + card.back).toLowerCase();
        if (filter.operator === 'contains') {
          return content.includes(searchValue);
        } else if (filter.operator === 'not_contains') {
          return !content.includes(searchValue);
        }
        return true;
      });
      
    case 'has_image':
      return cards.filter(card => card.images && card.images.length > 0);
      
    case 'no_tags':
      return cards.filter(card => !card.tags || card.tags.length === 0);
      
    case 'created_today':
      const today = new Date().toDateString();
      return cards.filter(card => {
        const created = (card as any).created_at || (card as any).createdAt;
        if (!created) return false;
        return new Date(created).toDateString() === today;
      });
      
    default:
      return cards;
  }
}

function applyBatchChanges(
  cards: AnkiCard[],
  selectedIds: Set<string>,
  changes: any
): AnkiCard[] {
  return cards.map(card => {
    const cardId = card.id || card.front;
    if (!selectedIds.has(cardId)) return card;
    
    let updatedCard = { ...card };
    
    // 应用正面修改
    if (changes.front?.enabled) {
      switch (changes.front.mode) {
        case 'replace':
          updatedCard.front = changes.front.value;
          break;
        case 'append':
          updatedCard.front = updatedCard.front + changes.front.value;
          break;
        case 'prepend':
          updatedCard.front = changes.front.value + updatedCard.front;
          break;
        case 'regex':
          if (changes.front.pattern) {
            try {
              updatedCard.front = updatedCard.front.replace(
                new RegExp(changes.front.pattern, 'g'),
                changes.front.value
              );
            } catch (e) {
              // 忽略正则错误
            }
          }
          break;
      }
    }
    
    // 应用背面修改
    if (changes.back?.enabled) {
      switch (changes.back.mode) {
        case 'replace':
          updatedCard.back = changes.back.value;
          break;
        case 'append':
          updatedCard.back = updatedCard.back + changes.back.value;
          break;
        case 'prepend':
          updatedCard.back = changes.back.value + updatedCard.back;
          break;
        case 'regex':
          if (changes.back.pattern) {
            try {
              updatedCard.back = updatedCard.back.replace(
                new RegExp(changes.back.pattern, 'g'),
                changes.back.value
              );
            } catch (e) {
              // 忽略正则错误
            }
          }
          break;
      }
    }
    
    // 应用标签修改
    if (changes.tags?.enabled) {
      switch (changes.tags.mode) {
        case 'add':
          updatedCard.tags = [...new Set([...updatedCard.tags, ...changes.tags.value])];
          break;
        case 'remove':
          updatedCard.tags = updatedCard.tags.filter(t => !changes.tags.value.includes(t));
          break;
        case 'replace':
          updatedCard.tags = changes.tags.value;
          break;
      }
    }
    
    return updatedCard;
  });
}

// 后端交互函数
async function saveToBackend(cards: AnkiCard[]): Promise<void> {
  try {
    await ankiApiAdapter.saveAnkiCards({ cards });
  } catch (error) {
    console.error('Failed to save cards:', error);
    throw error;
  }
}

async function deleteFromBackend(cardIds: string[]): Promise<void> {
  try {
    await ankiApiAdapter.deleteAnkiCards({ cardIds });
  } catch (error) {
    console.error('Failed to delete cards:', error);
    throw error;
  }
}

function showNotification(message: string, type: 'success' | 'error' = 'success') {
  notificationAdapter.show(message, type);
}

export default BatchOperationToolbar;
