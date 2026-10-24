import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChatCircleText, CopySimple, FileText, Play } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import type { Question } from '@/api/questionBankApi';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { dispatchOpenMediaRef } from '@/features/learning-hub/apps/views/media/mediaRefEvents';
import { findFirstMediaRef } from '@/features/learning-hub/apps/views/media/mediaRefTime';

/** 每道题的追问都是独立话题：新开对话再填入，不混进正在聊的别的会话 */
function prefillNewChat(content: string): void {
  dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, { content, autoSend: false, newSession: true });
}

/** 题目出处 {"resourceIds":[…]} → 首个资料 id */
export function questionSourceResourceId(sourceRef: string | null | undefined): string | null {
  if (!sourceRef) return null;
  try {
    const parsed = JSON.parse(sourceRef) as { resourceIds?: unknown };
    const first = Array.isArray(parsed.resourceIds) ? parsed.resourceIds.find((id) => typeof id === 'string' && id) : null;
    return typeof first === 'string' ? first : null;
  } catch {
    return null;
  }
}

/**
 * 稳定的单题引用：`[题目集:exam_id#question_id:显示名]`。
 *
 * 旧格式 `[题目集:exam_id:名称]` 保持兼容；`#` 定位后缀只新增、不改变旧引用。
 */
export function buildQuestionCitation(examId: string, question: Question): string {
  const label = (question.questionLabel || '').replace(/[:[\]#\n]/g, ' ').trim();
  const head = `[题目集:${examId}#${question.id}`;
  return label ? `${head}:${label}]` : `${head}]`;
}

function questionBlock(
  question: Question,
  labels: {
    stem: string;
    options: string;
    answer: string;
    explanation: string;
    materials: string;
    structured: string;
    images: string;
    citation: string;
  },
  examId?: string,
): string {
  const lines: string[] = [];
  // issue 491：共享材料是解题必要条件，追问不能只复制子题题干
  const materials = question.materials ?? [];
  if (materials.length > 0) {
    lines.push(labels.materials);
    for (const material of materials) {
      if (material.content?.trim()) lines.push(material.content.trim());
      for (const image of material.images ?? []) {
        lines.push(`${labels.images}${image.name || image.id}`);
      }
    }
  }
  lines.push(`${labels.stem}${question.content.trim()}`);
  if (question.options?.length) {
    lines.push(labels.options, ...question.options.map((option) => `${option.key}. ${option.content}`));
  }
  if (question.structured_data) {
    lines.push(labels.structured, JSON.stringify(question.structured_data));
  }
  if (question.images?.length) {
    lines.push(labels.images, ...question.images.map((image) => image.name || image.id));
  }
  if (question.answer?.trim()) lines.push(`${labels.answer}${question.answer.trim()}`);
  if (question.explanation?.trim()) lines.push(`${labels.explanation}${question.explanation.trim()}`);
  if (examId) lines.push(labels.citation, buildQuestionCitation(examId, question));
  return lines.join('\n');
}

/**
 * 做题结果后的追问栏：错题 → 在对话里讲解 / 生成同类题 / 回到出处。
 * 讲解与同类题都是新开对话填入输入框（不自动发送），学习者可补充后再发。
 */
export const QuestionFollowUpBar: React.FC<{
  question: Question;
  examId: string;
  userAnswer?: string;
  isCorrect?: boolean | null;
}> = ({ question, examId, userAnswer, isCorrect }) => {
  const { t } = useTranslation('exam_sheet');
  const labels = {
    stem: t('followUp.stem', { defaultValue: '题目：' }),
    options: t('followUp.options', { defaultValue: '选项：' }),
    answer: t('followUp.answer', { defaultValue: '正确答案：' }),
    explanation: t('followUp.explanation', { defaultValue: '解析：' }),
    materials: t('followUp.materials', { defaultValue: '共享材料：' }),
    structured: t('followUp.structured', { defaultValue: '结构化数据：' }),
    images: t('followUp.images', { defaultValue: '图片：' }),
    citation: t('followUp.citation', { defaultValue: '题目引用：' }),
  };
  const sourceId = questionSourceResourceId(question.sourceRef);
  // 音视频出的题：解析末尾的 [媒体@…] 比资料 id 更准，出处直接跳到依据所在时刻
  const mediaSource = React.useMemo(
    () => findFirstMediaRef([question.explanation, question.content]),
    [question.explanation, question.content],
  );

  const askAi = () => {
    const mine = userAnswer?.trim() ? `\n${t('followUp.mine', { defaultValue: '我的答案：' })}${userAnswer.trim()}` : '';
    const intro = isCorrect === false
      ? t('followUp.askWrong', { defaultValue: '这道题我做错了，请指出我的错误思路，讲清考点，再给我一道巩固练习。' })
      : t('followUp.ask', { defaultValue: '请帮我讲解这道题的考点与解题思路。' });
    prefillNewChat(`${intro}\n\n${questionBlock(question, labels, examId)}${mine}`);
  };

  const similar = () => {
    const intro = t('followUp.similarPrompt', {
      defaultValue: '请基于下面这道题，生成 2 道考查同一知识点、难度相近的同类题，并加入题目集（id: {{examId}}）。',
      examId,
    });
    prefillNewChat(`${intro}\n\n${questionBlock(question, labels, examId)}`);
  };

  const openSource = () => {
    if (!sourceId) return;
    void import('@/features/notes/noteOrigin').then(({ navigateToNoteOrigin }) =>
      navigateToNoteOrigin({ kind: 'resource', resourceId: sourceId }));
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-foreground/[0.06]">
      <DsButton variant="ghost" size="sm" onClick={askAi} className="[@media(pointer:coarse)]:min-h-11">
        <ChatCircleText size={15} aria-hidden="true" />{t('followUp.askAction', { defaultValue: '问 AI 讲解' })}
      </DsButton>
      <DsButton variant="ghost" size="sm" onClick={similar} className="[@media(pointer:coarse)]:min-h-11">
        <CopySimple size={15} aria-hidden="true" />{t('followUp.similarAction', { defaultValue: '生成同类题' })}
      </DsButton>
      {mediaSource ? (
        <DsButton
          variant="ghost"
          size="sm"
          onClick={() => dispatchOpenMediaRef(mediaSource.resourceId, mediaSource.seconds)}
          title={t('followUp.mediaSourceTitle', { time: mediaSource.label, defaultValue: '回到课程 {{time}}，重看这道题依据的片段' })}
          className="tabular-nums [@media(pointer:coarse)]:min-h-11"
        >
          <Play size={14} weight="fill" aria-hidden="true" />
          {t('followUp.mediaSourceAction', { time: mediaSource.label, defaultValue: '回看 {{time}}' })}
        </DsButton>
      ) : sourceId ? (
        <DsButton variant="ghost" size="sm" onClick={openSource} className="[@media(pointer:coarse)]:min-h-11">
          <FileText size={15} aria-hidden="true" />{t('followUp.sourceAction', { defaultValue: '出处' })}
        </DsButton>
      ) : null}
    </div>
  );
};
