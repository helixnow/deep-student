import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { CircleNotch, NotePencil } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { cn } from '@/lib/utils';
import { resolveAiExplanationWrite, toExplanationText } from './aiExplanation';

/** 二段式确认的自动复位时间（与题目行删除确认一致） */
const ARM_RESET_MS = 3000;

export interface AiExplanationWriteButtonProps {
  questionId: string;
  /** 题目当前的解析 */
  explanation?: string | null;
  /** 待写入的 AI 解析文本 */
  aiText?: string | null;
  /** 写入成功后回调（宿主据此刷新题目） */
  onWritten?: () => void | Promise<void>;
  className?: string;
}

/**
 * 把 AI 解析写进题目的「解析」字段（#467）。
 * 原解析为空时一键写入；已有解析时先变成「替换现有解析？」，再点一次才覆盖。
 * 走 qbank_update_question（record_history），覆盖前的解析可在历史里找回。
 */
export const AiExplanationWriteButton: React.FC<AiExplanationWriteButtonProps> = ({
  questionId,
  explanation,
  aiText,
  onWritten,
  className,
}) => {
  const { t } = useTranslation('practice');
  const [armed, setArmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const action = resolveAiExplanationWrite(explanation, aiText);

  const clearArmTimer = useCallback(() => {
    if (armTimerRef.current) {
      clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
    }
  }, []);

  // 换题或 AI 文本变化时撤销待确认状态
  useEffect(() => {
    setArmed(false);
    clearArmTimer();
  }, [questionId, aiText, clearArmTimer]);

  useEffect(() => clearArmTimer, [clearArmTimer]);

  const handleClick = useCallback(async () => {
    if (saving || action === 'none') return;
    if (action === 'replace' && !armed) {
      setArmed(true);
      clearArmTimer();
      armTimerRef.current = setTimeout(() => setArmed(false), ARM_RESET_MS);
      return;
    }
    clearArmTimer();
    setArmed(false);
    setSaving(true);
    try {
      await invoke('qbank_update_question', {
        request: {
          question_id: questionId,
          params: { explanation: toExplanationText(aiText) },
          record_history: true,
        },
      });
      showGlobalNotification('success', t('editor.explanationSaved'));
      await onWritten?.();
    } catch (err: unknown) {
      debugLog.error('[AiExplanationWriteButton] write explanation failed:', err);
      showGlobalNotification('error', t('editor.explanationSaveFailed'));
    } finally {
      setSaving(false);
    }
  }, [action, aiText, armed, clearArmTimer, onWritten, questionId, saving, t]);

  if (action === 'none') return null;

  return (
    <DsButton
      variant={armed ? 'danger' : 'ghost'}
      size="sm"
      disabled={saving}
      onClick={() => void handleClick()}
      className={cn(
        '!h-auto !px-1.5 !py-0.5 text-xs',
        !armed && 'text-info hover:bg-info/10',
        className,
      )}
    >
      {saving ? <CircleNotch size={12} className="animate-spin" /> : <NotePencil size={12} />}
      {armed ? t('editor.replaceExplanationConfirm') : t('editor.writeToExplanation')}
    </DsButton>
  );
};
