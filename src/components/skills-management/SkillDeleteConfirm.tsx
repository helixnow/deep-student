/**
 * Skills Management - 删除确认对话框
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/shad/AlertDialog';
import { Trash2, AlertTriangle } from 'lucide-react';
import type { SkillDefinition } from '@/chat-v2/skills/types';
import { getLocalizedSkillDescription, getLocalizedSkillName } from '@/chat-v2/skills/utils';

// ============================================================================
// 类型定义
// ============================================================================

export interface SkillDeleteConfirmProps {
  /** 要删除的技能 */
  skill: SkillDefinition | null;
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onOpenChange: (open: boolean) => void;
  /** 确认删除回调 */
  onConfirm: () => Promise<void>;
}

// ============================================================================
// 组件
// ============================================================================

export const SkillDeleteConfirm: React.FC<SkillDeleteConfirmProps> = ({
  skill,
  open,
  onOpenChange,
  onConfirm,
}) => {
  const { t } = useTranslation(['skills', 'common']);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleConfirm = useCallback(async () => {
    setIsDeleting(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (error) {
      console.error('[SkillDeleteConfirm] 删除失败:', error);
    } finally {
      setIsDeleting(false);
    }
  }, [onConfirm, onOpenChange]);

  if (!skill) return null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <AlertDialogTitle className="text-lg">
              {t('skills:management.delete', '删除技能')}
            </AlertDialogTitle>
          </div>
          <AlertDialogDescription className="text-muted-foreground">
            {t(
              'skills:management.delete_confirm',
              '确定要删除技能「{{name}}」吗？此操作不可恢复。',
              { name: getLocalizedSkillName(skill.id, skill.name, t) }
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="mt-4 p-3 rounded-lg bg-muted/50 border border-border/50">
          <div className="flex items-center gap-2 text-sm">
            <Trash2 size={14} className="text-muted-foreground" />
            <span className="font-medium">{getLocalizedSkillName(skill.id, skill.name, t)}</span>
            <span className="text-xs text-muted-foreground">({skill.id})</span>
          </div>
          {skill.description && (
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
              {getLocalizedSkillDescription(skill.id, skill.description, t)}
            </p>
          )}
        </div>

        <AlertDialogFooter className="mt-4">
          <AlertDialogCancel disabled={isDeleting}>
            {t('common:actions.cancel', '取消')}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting
              ? t('common:actions.deleting', '删除中...')
              : t('common:actions.delete', '删除')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default SkillDeleteConfirm;
