import React, { useState, useEffect } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { X, CreditCard, Eye, Edit2, Save } from 'lucide-react';
import { AnkiCard, CustomAnkiTemplate } from '../types';
import { TemplateRenderService } from '../services/templateRenderService';
import { IframePreview } from './SharedPreview';
import './AnkiCardPreviewModal.css';
import UnifiedModal from './UnifiedModal';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { cn } from '../utils/cn';
import { unifiedAlert, unifiedConfirm } from '@/utils/unifiedDialogs';

interface AnkiCardPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  card: AnkiCard | null;
  template?: CustomAnkiTemplate | null;
  onSave?: (updatedCard: AnkiCard) => void;
}

const AnkiCardPreviewModal: React.FC<AnkiCardPreviewModalProps> = ({
  isOpen,
  onClose,
  card,
  template,
  onSave
}) => {
  const { t } = useTranslation();
  const { isSmallScreen } = useBreakpoint();
  const [showFront, setShowFront] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [editedCard, setEditedCard] = useState<AnkiCard | null>(null);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [lastCardId, setLastCardId] = useState<string | null>(null);

  useEffect(() => {
    if (card) {
      const cardId = card.id || `${card.front}-${card.back}`;
      // 只有在卡片真正改变时才重置编辑状态
      if (cardId !== lastCardId) {
        const cardCopy = { ...card, _updateKey: Date.now() };
        setEditedCard(cardCopy);
        setJsonText(JSON.stringify(card, null, 2)); // JSON不包含_updateKey
        setJsonError(null);
        setLastCardId(cardId);
        setIsEditing(false);
      } else if (!isEditing) {
        // 如果是同一张卡片但不在编辑模式，更新显示内容
        const cardCopy = { ...card, _updateKey: Date.now() };
        setEditedCard(cardCopy);
        setJsonText(JSON.stringify(card, null, 2)); // JSON不包含_updateKey
        setJsonError(null);
      }
    }
  }, [card, lastCardId, isEditing]);



  useEffect(() => {
    // 重置到正面当卡片改变时
    setShowFront(true);
    setIsEditing(false);
  }, [card]);


  const handleSave = () => {
    if (!editedCard || !onSave) return;
    
    // 验证卡片数据的基本结构
    if (!editedCard.front || !editedCard.back) {
      unifiedAlert(t('anki:error_missing_required_fields'));
      return;
    }
    
    // 清理临时字段并创建保存用的卡片数据
    const cleanCard = { ...editedCard };
    delete (cleanCard as any)._updateKey; // 移除临时更新标识
    
    // 确保tags是数组
    if (!Array.isArray(cleanCard.tags)) {
      cleanCard.tags = [];
    }
    
    // 确保images是数组
    if (!Array.isArray(cleanCard.images)) {
      cleanCard.images = [];
    }
    
    onSave(cleanCard);
    setIsEditing(false);
  };

  if (!isOpen || !card || !editedCard) return null;

  // 派生渲染内容，而不是将其存储在state中
  const renderedContent = (() => {
    if (!editedCard) return { front: '', back: '' };
    if (template) {
      const rendered = TemplateRenderService.renderCard(editedCard, template);
      const backWithFront = rendered.back.includes('{{FrontSide}}')
        ? rendered.back.replace('{{FrontSide}}', `${rendered.front}<hr id="answer">`)
        : rendered.back;
      return { front: rendered.front, back: backWithFront };
    } else {
      return { front: editedCard.front || '', back: editedCard.back || '' };
    }
  })();

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <UnifiedModal
      isOpen={isOpen}
      onClose={onClose}
      contentClassName={cn("anki-preview-modal", isSmallScreen && "mobile-preview-modal")}
    >
        {/* 头部 */}
        <div className={cn("preview-modal-header", isSmallScreen && "px-4 py-3")}>
          <div className="header-left">
            <CreditCard size={isSmallScreen ? 18 : 20} />
            <h3 className={cn(isSmallScreen && "text-base")}>{t('anki:anki_card_preview')}</h3>
          </div>
          <div className="header-right">
            <NotionButton variant="ghost" size="icon" iconOnly className="close-button" onClick={onClose} aria-label="close">
              <X size={isSmallScreen ? 18 : 20} />
            </NotionButton>
          </div>
        </div>

        {/* 侧边切换 */}
        <div className={cn("preview-side-toggle", isSmallScreen && "px-4 py-2")}>
          <NotionButton variant="ghost" size="sm" className={cn("side-button", showFront && "active", isSmallScreen && "text-sm")} onClick={() => setShowFront(true)}>
            <Eye size={14} />
            {t('anki:card_front')}
          </NotionButton>
          <NotionButton variant="ghost" size="sm" className={cn("side-button", !showFront && "active", isSmallScreen && "text-sm")} onClick={() => setShowFront(false)}>
            <Eye size={14} />
            {t('anki:card_back')}
          </NotionButton>
        </div>

        {/* 卡片内容 */}
        <div className={cn("preview-content-wrapper", isSmallScreen && "px-4")}>
          <div className={cn("preview-label", isSmallScreen && "text-xs")}>{showFront ? t('anki:preview_front') : t('anki:preview_back')}</div>
          <div className={cn("preview-content-split", isSmallScreen && "mobile-content")}>
            
            <div className="preview-card-section full-view">
              <div className="preview-card-container">
                <IframePreview
                  key={`${(editedCard as any)._updateKey}-${showFront}`}
                  htmlContent={showFront ? renderedContent.front : renderedContent.back}
                  cssContent={template?.css_style || ''}
                />
              </div>
            </div>
          </div>
        </div>

        {/* 卡片信息 */}
        <div className={cn("preview-card-info", isSmallScreen && "px-4")}>
          <div className="info-row">
            <span className={cn("info-label", isSmallScreen && "text-xs")}>{t('anki:tags')}:</span>
            <div className="tags-list">
              {editedCard.tags.map((tag, index) => (
                <span key={index} className={cn("tag-badge tag-green", isSmallScreen && "text-xs")}>
                  {tag}
                </span>
              ))}
            </div>
          </div>

          {template && (
            <div className="info-row">
              <span className={cn("info-label", isSmallScreen && "text-xs")}>{t('anki:template_label')}:</span>
              <span className={cn("template-name", isSmallScreen && "text-sm")}>{template.name}</span>
            </div>
          )}

          {card.fields && Object.keys(card.fields).length > 0 && (
            <details className="extra-fields-details">
              <summary className={cn(isSmallScreen && "text-sm")}>{t('anki:extra_fields')} ({Object.keys(card.fields).length})</summary>
              <div className="extra-fields-content">
                {Object.entries(card.fields).map(([key, value]) => (
                  <div key={key} className="field-item">
                    <span className={cn("field-key", isSmallScreen && "text-xs")}>{key}:</span>
                    <span className={cn("field-value", isSmallScreen && "text-xs")}>{value}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>

        {/* 底部提示 */}
        <div className={cn("preview-modal-footer", isSmallScreen && "px-4 pb-safe")}>
          <p className={cn("preview-hint", isSmallScreen && "text-xs")}>
            {t('anki:preview_hint')}
          </p>
        </div>
    </UnifiedModal>
  );
};

export default AnkiCardPreviewModal;
