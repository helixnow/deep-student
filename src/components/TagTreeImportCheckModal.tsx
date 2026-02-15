import React from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import './TagTreeImportCheckModal.css';
import UnifiedModal from './UnifiedModal';
import { ValidationResult } from '../utils/TagTreeValidator';
import { AlertTriangle, XCircle } from 'lucide-react';

interface Props {
  open: boolean;
  result: ValidationResult | null;
  onConfirm: () => void;
  onCancel: () => void;
}

const TagTreeImportCheckModal: React.FC<Props> = ({ open, result, onConfirm, onCancel }) => {
  const { t } = useTranslation('common');

  if (!open || !result) return null;

  const { totalTags, maxDepth, hardErrors, warnings } = result;
  const canImport = hardErrors.length === 0;

  return (
    <UnifiedModal isOpen={open} onClose={onCancel} contentClassName="tag-tree-modal">
        <h3>{t('tag_tree.import_check_title')}</h3>

        <div className="summary">
          <p>{t('tag_tree.total_tags')}：<strong>{totalTags}</strong></p>
          <p>{t('tag_tree.max_depth')}：<strong>{maxDepth}</strong></p>
        </div>
        {/* 规则说明 */}
        <div className="rules">
          <h4>{t('tag_tree.hard_rules')}</h4>
          <ul className="hard-rule-list">
            <li>{t('tag_tree.hard_rule_1')}</li>
            <li>{t('tag_tree.hard_rule_2')}</li>
            <li>{t('tag_tree.hard_rule_3')}</li>
          </ul>
          <p className="rule-status">
            {t('status.current')}：{hardErrors.length === 0 ? `✅ ${t('tag_tree.status_passed')}` : `❌ ${t('tag_tree.status_failed', { count: hardErrors.length })}`}
          </p>

          <h4>{t('tag_tree.soft_rules')}</h4>
          <ul className="soft-rule-list">
            <li>{t('tag_tree.soft_rule_1')}</li>
            <li>{t('tag_tree.soft_rule_2')}</li>
          </ul>
          <p className="rule-status">
            {t('status.current')}：{warnings.length === 0 ? `✅ ${t('tag_tree.status_passed')}` : `⚠️ ${t('tag_tree.status_warning', { count: warnings.length })}`}
          </p>
        </div>

        {warnings.length > 0 && (
          <>
            <h4><AlertTriangle size={16} style={{marginRight:4}} />{t('status.warning')}</h4>
            <ul className="warning-list">
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </>
        )}

        {hardErrors.length > 0 && (
          <>
            <h4><XCircle size={16} style={{marginRight:4}} />{t('tag_tree.errors_title')}</h4>
            <ul className="error-list">
              {hardErrors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          </>
        )}

        <div className="actions">
          <NotionButton variant="default" size="sm" onClick={onCancel}>{t('actions.cancel')}</NotionButton>
          <NotionButton
            variant="primary" size="sm"
            className="confirm-btn"
            onClick={onConfirm}
            disabled={!canImport}
            title={canImport ? '' : t('tag_tree.import_blocked_hint')}
          >
            {t('actions.import')}
          </NotionButton>
        </div>
    </UnifiedModal>
  );
};

export default TagTreeImportCheckModal;
