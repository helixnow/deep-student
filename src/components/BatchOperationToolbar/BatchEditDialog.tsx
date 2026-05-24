import React, { useState, useEffect } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { AnkiCard } from '../../types';
import { useTranslation } from 'react-i18next';
import { X, CaretLeft, CaretRight } from '@phosphor-icons/react';
import './BatchEditDialog.css';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/shad/Select';
import { Switch } from '@/components/ui/shad/Switch';

interface BatchEditDialogProps {
  cards: AnkiCard[];
  onSave: (changes: BatchChanges) => void;
  onClose: () => void;
}

export interface BatchChanges {
  front?: {
    enabled: boolean;
    mode: 'replace' | 'append' | 'prepend' | 'regex';
    value: string;
    pattern?: string;
  };
  back?: {
    enabled: boolean;
    mode: 'replace' | 'append' | 'prepend' | 'regex';
    value: string;
    pattern?: string;
  };
  tags?: {
    enabled: boolean;
    mode: 'add' | 'remove' | 'replace';
    value: string[];
  };
}

const BatchEditDialog: React.FC<BatchEditDialogProps> = ({ cards, onSave, onClose }) => {
  const { t } = useTranslation('anki');
  
  const [changes, setChanges] = useState<BatchChanges>({
    front: { enabled: false, mode: 'replace', value: '' },
    back: { enabled: false, mode: 'replace', value: '' },
    tags: { enabled: false, mode: 'add', value: [] }
  });
  
  const [previewIndex, setPreviewIndex] = useState(0);
  const [tagInput, setTagInput] = useState('');
  
  // 生成预览
  const generatePreview = () => {
    if (cards.length === 0) return null;
    
    const card = cards[previewIndex];
    const preview: Partial<AnkiCard> = { ...card };
    
    // 应用前面修改预览
    if (changes.front?.enabled) {
      switch (changes.front.mode) {
        case 'replace':
          preview.front = changes.front.value;
          break;
        case 'append':
          preview.front = card.front + changes.front.value;
          break;
        case 'prepend':
          preview.front = changes.front.value + card.front;
          break;
        case 'regex':
          if (changes.front.pattern) {
            try {
              preview.front = card.front.replace(
                new RegExp(changes.front.pattern, 'g'),
                changes.front.value
              );
            } catch (e) {
              preview.front = card.front + ` [${t('regex_error')}]`;
            }
          }
          break;
      }
    }
    
    // 应用背面修改预览
    if (changes.back?.enabled) {
      switch (changes.back.mode) {
        case 'replace':
          preview.back = changes.back.value;
          break;
        case 'append':
          preview.back = card.back + changes.back.value;
          break;
        case 'prepend':
          preview.back = changes.back.value + card.back;
          break;
        case 'regex':
          if (changes.back.pattern) {
            try {
              preview.back = card.back.replace(
                new RegExp(changes.back.pattern, 'g'),
                changes.back.value
              );
            } catch (e) {
              preview.back = card.back + ` [${t('regex_error')}]`;
            }
          }
          break;
      }
    }
    
    // 应用标签修改预览
    if (changes.tags?.enabled) {
      switch (changes.tags.mode) {
        case 'add':
          preview.tags = [...new Set([...card.tags, ...changes.tags.value])];
          break;
        case 'remove':
          preview.tags = card.tags.filter(t => !changes.tags.value.includes(t));
          break;
        case 'replace':
          preview.tags = changes.tags.value;
          break;
      }
    }
    
    return preview;
  };
  
  const preview = generatePreview();
  
  const handleAddTag = () => {
    if (tagInput.trim()) {
      setChanges({
        ...changes,
        tags: {
          ...changes.tags!,
          value: [...changes.tags!.value, tagInput.trim()]
        }
      });
      setTagInput('');
    }
  };
  
  const handleRemoveTag = (index: number) => {
    setChanges({
      ...changes,
      tags: {
        ...changes.tags!,
        value: changes.tags!.value.filter((_, i) => i !== index)
      }
    });
  };
  
  const hasChanges = changes.front?.enabled || changes.back?.enabled || changes.tags?.enabled;
  
  // 快捷键支持
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);
  
  return (
    <div className="batch-edit-dialog-overlay" onClick={onClose}>
      <div className="batch-edit-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>{t('batch_edit_title', { count: cards.length })}</h3>
          <NotionButton variant="ghost" size="icon" iconOnly className="close-btn" onClick={onClose} aria-label="close">
            <X size={20} />
          </NotionButton>
        </div>
        
        <div className="dialog-body">
          {/* 编辑区域 */}
          <div className="edit-sections">
            {/* 正面编辑 */}
            <div className="edit-section">
              <label className="section-header">
                <Switch
                  checked={changes.front!.enabled}
                  onCheckedChange={(checked) => setChanges({
                    ...changes,
                    front: { ...changes.front!, enabled: checked }
                  })}
/>
                <span>{t('edit_front_content')}</span>
              </label>
              
              {changes.front!.enabled && (
                <div className="section-content">
                  <Select
                    value={changes.front!.mode}
                    onValueChange={(value) => setChanges({
                      ...changes,
                      front: { ...changes.front!, mode: value as any }
                    })}
                  >
                    <SelectTrigger className="mode-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="replace">{t('replace_all')}</SelectItem>
                      <SelectItem value="append">{t('append_to_end')}</SelectItem>
                      <SelectItem value="prepend">{t('prepend_to_start')}</SelectItem>
                      <SelectItem value="regex">{t('regex_replace')}</SelectItem>
                    </SelectContent>
                  </Select>
                  
                  {changes.front!.mode === 'regex' && (
                    <Input
                      type="text"
                      placeholder={t('regex_pattern_placeholder')}
                      value={changes.front!.pattern || ''}
                      onChange={(e) => setChanges({
                        ...changes,
                        front: { ...changes.front!, pattern: e.target.value }
                      })}
                      className="pattern-input"
/>
                  )}
                  
                  <Textarea
                    placeholder={changes.front!.mode === 'regex' ? t('replace_with') : t('content')}
                    value={changes.front!.value}
                    onChange={(e) => setChanges({
                      ...changes,
                      front: { ...changes.front!, value: e.target.value }
                    })}
                    rows={3}
                    className="content-textarea"
/>
                </div>
              )}
            </div>
            
            {/* 背面编辑 */}
            <div className="edit-section">
              <label className="section-header">
                <Switch
                  checked={changes.back!.enabled}
                  onCheckedChange={(checked) => setChanges({
                    ...changes,
                    back: { ...changes.back!, enabled: checked }
                  })}
/>
                <span>{t('edit_back_content')}</span>
              </label>
              
              {changes.back!.enabled && (
                <div className="section-content">
                  <Select
                    value={changes.back!.mode}
                    onValueChange={(value) => setChanges({
                      ...changes,
                      back: { ...changes.back!, mode: value as any }
                    })}
                  >
                    <SelectTrigger className="mode-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="replace">{t('replace_all')}</SelectItem>
                      <SelectItem value="append">{t('append_to_end')}</SelectItem>
                      <SelectItem value="prepend">{t('prepend_to_start')}</SelectItem>
                      <SelectItem value="regex">{t('regex_replace')}</SelectItem>
                    </SelectContent>
                  </Select>
                  
                  {changes.back!.mode === 'regex' && (
                    <Input
                      type="text"
                      placeholder={t('regex_pattern_placeholder')}
                      value={changes.back!.pattern || ''}
                      onChange={(e) => setChanges({
                        ...changes,
                        back: { ...changes.back!, pattern: e.target.value }
                      })}
                      className="pattern-input"
/>
                  )}
                  
                  <Textarea
                    placeholder={changes.back!.mode === 'regex' ? t('replace_with') : t('content')}
                    value={changes.back!.value}
                    onChange={(e) => setChanges({
                      ...changes,
                      back: { ...changes.back!, value: e.target.value }
                    })}
                    rows={3}
                    className="content-textarea"
/>
                </div>
              )}
            </div>
            
            {/* 标签编辑 */}
            <div className="edit-section">
              <label className="section-header">
                <Switch
                  checked={changes.tags!.enabled}
                  onCheckedChange={(checked) => setChanges({
                    ...changes,
                    tags: { ...changes.tags!, enabled: checked }
                  })}
/>
                <span>{t('edit_tags')}</span>
              </label>
              
              {changes.tags!.enabled && (
                <div className="section-content">
                  <Select
                    value={changes.tags!.mode}
                    onValueChange={(value) => setChanges({
                      ...changes,
                      tags: { ...changes.tags!, mode: value as any }
                    })}
                  >
                    <SelectTrigger className="mode-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="add">{t('add_tags')}</SelectItem>
                      <SelectItem value="remove">{t('remove_tags')}</SelectItem>
                      <SelectItem value="replace">{t('replace_all_tags')}</SelectItem>
                    </SelectContent>
                  </Select>
                  
                  <div className="tag-input-container">
                    <Input
                      type="text"
                      placeholder={t('enter_tag_press_enter')}
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddTag();
                        }
                      }}
                      className="tag-input"
/>
                    
                    <div className="selected-tags">
                      {changes.tags!.value.map((tag, index) => (
                        <span key={index} className="tag">
                          {tag}
                          <NotionButton variant="ghost" size="icon" iconOnly onClick={() => handleRemoveTag(index)} className="tag-remove" aria-label="remove">
                            <X size={14} />
                          </NotionButton>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
          
          {/* 预览区域 */}
          {preview && (
            <div className="preview-section">
              <div className="preview-header">
                <h4>{t('preview_changes')}</h4>
                {cards.length > 1 && (
                  <div className="preview-nav">
                    <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setPreviewIndex(Math.max(0, previewIndex - 1))} disabled={previewIndex === 0} className="nav-btn" aria-label="prev">
                      <CaretLeft size={16} />
                    </NotionButton>
                    <span className="nav-info">{previewIndex + 1} / {cards.length}</span>
                    <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setPreviewIndex(Math.min(cards.length - 1, previewIndex + 1))} disabled={previewIndex === cards.length - 1} className="nav-btn" aria-label="next">
                      <CaretRight size={16} />
                    </NotionButton>
                  </div>
                )}
              </div>
              
              <div className="preview-content">
                <div className="preview-comparison">
                  <div className="preview-before">
                    <h5>{t('before')}</h5>
                    <div className="card-preview">
                      <div className="card-field">
                        <label>{t('front')}:</label>
                        <div className="field-content">{cards[previewIndex].front}</div>
                      </div>
                      <div className="card-field">
                        <label>{t('back')}:</label>
                        <div className="field-content">{cards[previewIndex].back}</div>
                      </div>
                      <div className="card-field">
                        <label>{t('tags')}:</label>
                        <div className="field-content">
                          {cards[previewIndex].tags.length > 0 
                            ? cards[previewIndex].tags.join(', ') 
                            : t('no_tags')}
                        </div>
                      </div>
                    </div>
                  </div>
                  
                  <div className="preview-arrow">→</div>
                  
                  <div className="preview-after">
                    <h5>{t('after')}</h5>
                    <div className="card-preview">
                      <div className="card-field">
                        <label>{t('front')}:</label>
                        <div className={`field-content ${changes.front?.enabled ? 'changed' : ''}`}>
                          {preview.front}
                        </div>
                      </div>
                      <div className="card-field">
                        <label>{t('back')}:</label>
                        <div className={`field-content ${changes.back?.enabled ? 'changed' : ''}`}>
                          {preview.back}
                        </div>
                      </div>
                      <div className="card-field">
                        <label>{t('tags')}:</label>
                        <div className={`field-content ${changes.tags?.enabled ? 'changed' : ''}`}>
                          {preview.tags && preview.tags.length > 0 
                            ? preview.tags.join(', ') 
                            : t('no_tags')}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        
        <div className="dialog-footer">
          <NotionButton variant="default" size="sm" className="btn-secondary" onClick={onClose}>
            {t('cancel')}
          </NotionButton>
          <NotionButton variant="primary" size="sm" className="btn-primary" onClick={() => onSave(changes)} disabled={!hasChanges}>
            {t('apply_to_cards', { count: cards.length })}
          </NotionButton>
        </div>
      </div>
    </div>
  );
};

export default BatchEditDialog;