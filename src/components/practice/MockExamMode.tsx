/**
 * 模拟考试模式组件
 * 
 * 功能：
 * - 模拟考试设置面板（题型配比、难度、时长）
 * - 考试进度条
 * - 交卷确认
 * - 成绩单展示
 */

import React, { useState, useCallback, useMemo, useRef } from 'react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { Progress } from '@/components/ui/shad/Progress';
import { Badge } from '@/components/ui/shad/Badge';
import { Input } from '@/components/ui/shad/Input';
import { Label } from '@/components/ui/shad/Label';
import { Switch } from '@/components/ui/shad/Switch';
import { Slider } from '@/components/ui/shad/Slider';
import { NotionAlertDialog } from '@/components/ui/NotionDialog';
import {
  FileText,
  Clock,
  Target,
  Award,
  AlertCircle,
  CheckCircle,
  XCircle,
  Trophy,
  BarChart3,
  Loader2,
  Play,
  Settings2,
} from 'lucide-react';
import { useQuestionBankStore, MockExamConfig, MockExamSession, MockExamScoreCard } from '@/stores/questionBankStore';
import { useTranslation } from 'react-i18next';
import { useCountdown } from '@/hooks/useCountdown';
import { showGlobalNotification } from '@/components/UnifiedNotification';

const formatTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

interface MockExamModeProps {
  examId: string;
  onStart?: (session: MockExamSession) => void;
  onSubmit?: (scoreCard: MockExamScoreCard) => void;
  className?: string;
}

const QUESTION_TYPE_KEYS = [
  'single_choice', 'multiple_choice', 'fill_blank', 'short_answer', 'calculation',
];

const DIFFICULTY_KEYS = [
  { key: 'easy', color: 'text-emerald-600' },
  { key: 'medium', color: 'text-amber-600' },
  { key: 'hard', color: 'text-orange-600' },
  { key: 'very_hard', color: 'text-rose-600' },
];

export const MockExamMode: React.FC<MockExamModeProps> = ({
  examId,
  onStart,
  onSubmit,
  className,
}) => {
  const { t } = useTranslation('practice');
  
  // Store
  const {
    mockExamSession,
    mockExamScoreCard,
    setMockExamSession,
    generateMockExam,
    submitMockExam,
    isLoadingPractice,
  } = useQuestionBankStore();
  
  // 配置状态
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [totalCount, setTotalCount] = useState(30);
  const [shuffle, setShuffle] = useState(true);
  const [includeMistakes, setIncludeMistakes] = useState(true);
  const [typeDistribution, setTypeDistribution] = useState<Record<string, number>>({});
  const [difficultyDistribution, setDifficultyDistribution] = useState<Record<string, number>>({});
  
  // UI 状态
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [showScoreCard, setShowScoreCard] = useState(false);
  
  // 考试计时器 — 基于绝对时间戳
  const [targetEndTime, setTargetEndTime] = useState<number | null>(null);
  const autoSubmitTriggeredRef = useRef(false);
  
  const handleAutoSubmit = useCallback(() => {
    if (autoSubmitTriggeredRef.current) return;
    autoSubmitTriggeredRef.current = true;
    if (mockExamSession) {
      submitMockExam(mockExamSession).then((scoreCard) => {
        setShowScoreCard(true);
        onSubmit?.(scoreCard);
      }).catch((err) => {
        console.error('Auto-submit failed:', err);
      });
    }
  }, [mockExamSession, submitMockExam, onSubmit]);
  
  const { remaining: examRemainingSeconds } = useCountdown(
    targetEndTime,
    handleAutoSubmit,
  );
  
  const getExamTimeColor = () => {
    if (!targetEndTime) return 'text-sky-600';
    const totalSeconds = durationMinutes * 60;
    const ratio = examRemainingSeconds / totalSeconds;
    if (ratio > 0.5) return 'text-emerald-600';
    if (ratio > 0.25) return 'text-amber-600';
    return 'text-rose-600';
  };
  
  // 计算总配置题数
  const configuredCount = useMemo(() => {
    const typeCount = Object.values(typeDistribution).reduce((a, b) => a + b, 0);
    const diffCount = Object.values(difficultyDistribution).reduce((a, b) => a + b, 0);
    return Math.max(typeCount, diffCount, totalCount);
  }, [typeDistribution, difficultyDistribution, totalCount]);
  
  // 更新题型配比
  const handleTypeChange = useCallback((key: string, value: number) => {
    setTypeDistribution((prev) => ({
      ...prev,
      [key]: value,
    }));
  }, []);
  
  // 更新难度配比
  const handleDifficultyChange = useCallback((key: string, value: number) => {
    setDifficultyDistribution((prev) => ({
      ...prev,
      [key]: value,
    }));
  }, []);
  
  // 开始考试
  const handleStart = useCallback(async () => {
    const config: MockExamConfig = {
      duration_minutes: durationMinutes,
      type_distribution: typeDistribution,
      difficulty_distribution: difficultyDistribution,
      total_count: totalCount,
      shuffle,
      include_mistakes: includeMistakes,
    };
    
    try {
      const session = await generateMockExam(examId, config);
      setTargetEndTime(Date.now() + durationMinutes * 60 * 1000);
      autoSubmitTriggeredRef.current = false;
      onStart?.(session);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showGlobalNotification('error', msg, t('mockExam.startError', '生成考试失败'));
    }
  }, [examId, durationMinutes, totalCount, shuffle, includeMistakes, typeDistribution, difficultyDistribution, generateMockExam, onStart]);
  
  // 交卷（手动）
  const handleSubmit = useCallback(async () => {
    if (!mockExamSession) return;
    
    setShowConfirmDialog(false);
    setTargetEndTime(null);
    autoSubmitTriggeredRef.current = true;
    
    try {
      const scoreCard = await submitMockExam(mockExamSession);
      setShowScoreCard(true);
      onSubmit?.(scoreCard);
    } catch (err: unknown) {
      autoSubmitTriggeredRef.current = false;
      const msg = err instanceof Error ? err.message : String(err);
      showGlobalNotification('error', msg, t('mockExam.submitError', '交卷失败'));
    }
  }, [mockExamSession, submitMockExam, onSubmit]);
  
  // 成绩单界面
  if (showScoreCard && mockExamScoreCard) {
    const score = mockExamScoreCard;
    
    return (
      <Card className={cn('bg-transparent border-transparent shadow-none', className)}>
        <CardHeader className="text-center pb-4">
          <div className="flex justify-center mb-4">
            <div className="p-4 rounded-full bg-gradient-to-br from-amber-400 to-orange-500">
              <Trophy className="w-12 h-12 text-white" />
            </div>
          </div>
          <CardTitle className="text-2xl">{t('mockExam.scoreCard', '成绩单')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* 总分展示 */}
          <div className="text-center py-4">
            <div className="text-6xl font-bold text-sky-600">
              {Math.round(score.correct_rate)}
              <span className="text-2xl text-muted-foreground">%</span>
            </div>
            <div className="mt-2 text-muted-foreground">{score.comment}</div>
          </div>
          
          {/* 统计数据 */}
          <div className="grid grid-cols-4 gap-3">
            <div className="text-center p-3 rounded-lg bg-muted/50">
              <div className="text-2xl font-bold">{score.total_count}</div>
              <div className="text-xs text-muted-foreground">{t('mockExam.total', '总题数')}</div>
            </div>
            <div className="text-center p-3 rounded-lg bg-emerald-500/10">
              <div className="text-2xl font-bold text-emerald-600">{score.correct_count}</div>
              <div className="text-xs text-emerald-600">{t('mockExam.correct', '正确')}</div>
            </div>
            <div className="text-center p-3 rounded-lg bg-rose-500/10">
              <div className="text-2xl font-bold text-rose-600">{score.wrong_count}</div>
              <div className="text-xs text-rose-600">{t('mockExam.wrong', '错误')}</div>
            </div>
            <div className="text-center p-3 rounded-lg bg-slate-500/10">
              <div className="text-2xl font-bold text-slate-600">{score.unanswered_count}</div>
              <div className="text-xs text-slate-600">{t('mockExam.unanswered', '未答')}</div>
            </div>
          </div>
          
          {/* 用时 */}
          <div className="flex items-center justify-center gap-2 p-3 rounded-lg bg-sky-500/10">
            <Clock className="w-5 h-5 text-sky-600" />
            <span className="text-sky-600 font-medium">
              {t('mockExam.timeSpent', '用时')}：
              {Math.floor(score.time_spent_seconds / 60)} {t('mockExam.minutes', '分')} 
              {score.time_spent_seconds % 60} {t('mockExam.seconds', '秒')}
            </span>
          </div>
          
          {/* 题型统计 */}
          {Object.keys(score.type_stats).length > 0 && (
            <div className="space-y-2">
              <div className="text-sm font-medium text-muted-foreground flex items-center gap-1">
                <BarChart3 className="w-4 h-4" />
                {t('mockExam.typeStats', '题型统计')}
              </div>
              <div className="space-y-2">
                {Object.entries(score.type_stats).map(([type, stat]) => (
                  <div key={type} className="flex items-center gap-3">
                    <span className="text-sm w-20">{type}</span>
                    <Progress value={stat.rate} className="flex-1 h-2" />
                    <span className="text-sm w-16 text-right">
                      {stat.correct}/{stat.total}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {/* 操作按钮 */}
          <div className="flex gap-3">
            <NotionButton
              variant="outline"
              onClick={() => {
                setShowScoreCard(false);
                setMockExamSession(null);
                setTargetEndTime(null);
              }}
              className="flex-1"
            >
              {t('mockExam.back', '返回')}
            </NotionButton>
            <NotionButton
              onClick={() => {
                setShowScoreCard(false);
                setMockExamSession(null);
                setTargetEndTime(null);
                autoSubmitTriggeredRef.current = false;
                handleStart();
              }}
              className="flex-1"
            >
              {t('mockExam.newExam', '再考一次')}
            </NotionButton>
          </div>
        </CardContent>
      </Card>
    );
  }
  
  // 配置界面
  if (!mockExamSession) {
    return (
      <Card className={cn('bg-transparent border-transparent shadow-none', className)}>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-lg">
            <FileText className="w-5 h-5 text-sky-500" />
            {t('mockExam.title', '模拟考试')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* 基本配置 */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t('mockExam.duration', '考试时长（分钟）')}</Label>
              <Input
                type="number"
                min={10}
                max={180}
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(Number(e.target.value))}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('mockExam.totalCount', '题目数量')}</Label>
              <Input
                type="number"
                min={5}
                max={100}
                value={totalCount}
                onChange={(e) => setTotalCount(Number(e.target.value))}
              />
            </div>
          </div>
          
          {/* 开关选项 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>{t('mockExam.shuffle', '打乱题目顺序')}</Label>
              <Switch checked={shuffle} onCheckedChange={setShuffle} />
            </div>
            <div className="flex items-center justify-between">
              <Label>{t('mockExam.includeMistakes', '包含错题')}</Label>
              <Switch checked={includeMistakes} onCheckedChange={setIncludeMistakes} />
            </div>
          </div>
          
          {/* 题型配比 */}
          <div className="space-y-3">
            <Label className="flex items-center gap-1">
              <Settings2 className="w-4 h-4" />
              {t('mockExam.typeDistribution', '题型配比')}
              <span className="text-muted-foreground text-xs">{t('mockExam.optional', '（选填）')}</span>
            </Label>
            <div className="space-y-2">
              {QUESTION_TYPE_KEYS.map((key) => (
                <div key={key} className="flex items-center gap-3">
                  <span className="text-sm w-20">{t(`questionType.${key}`)}</span>
                  <Slider
                    value={[typeDistribution[key] || 0]}
                    onValueChange={(v) => handleTypeChange(key, v[0])}
                    max={20}
                    step={1}
                    className="flex-1"
                  />
                  <span className="text-sm w-8 text-right">{typeDistribution[key] || 0}</span>
                </div>
              ))}
            </div>
          </div>
          
          {/* 难度配比 */}
          <div className="space-y-3">
            <Label className="flex items-center gap-1">
              <Target className="w-4 h-4" />
              {t('mockExam.difficultyDistribution', '难度配比')}
              <span className="text-muted-foreground text-xs">{t('mockExam.optional', '（选填）')}</span>
            </Label>
            <div className="space-y-2">
              {DIFFICULTY_KEYS.map(({ key, color }) => (
                <div key={key} className="flex items-center gap-3">
                  <span className={cn('text-sm w-20', color)}>{t(`difficultyLevel.${key}`)}</span>
                  <Slider
                    value={[difficultyDistribution[key] || 0]}
                    onValueChange={(v) => handleDifficultyChange(key, v[0])}
                    max={20}
                    step={1}
                    className="flex-1"
                  />
                  <span className="text-sm w-8 text-right">{difficultyDistribution[key] || 0}</span>
                </div>
              ))}
            </div>
          </div>
          
          <NotionButton
            onClick={handleStart}
            disabled={isLoadingPractice}
            className="w-full h-12 text-lg"
          >
            {isLoadingPractice ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                {t('mockExam.generating', '生成中...')}
              </>
            ) : (
              <>
                <Play className="w-5 h-5 mr-2" />
                {t('mockExam.start', '开始考试')}
              </>
            )}
          </NotionButton>
        </CardContent>
      </Card>
    );
  }
  
  // 考试中 - 进度显示（实际答题由 QuestionBankEditor 处理）
  const progress = mockExamSession.question_ids.length > 0
    ? (Object.keys(mockExamSession.answers).length / mockExamSession.question_ids.length) * 100
    : 0;
  
  return (
    <>
      <Card className={cn('bg-transparent border-transparent shadow-none', className)}>
        <CardContent className="pt-6 space-y-4">
          {/* 倒计时显示 */}
          <div className="flex flex-col items-center justify-center py-3">
            <div className={cn(
              'text-4xl font-mono font-bold tabular-nums transition-colors',
              getExamTimeColor(),
            )}>
              {formatTime(examRemainingSeconds)}
            </div>
            <span className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {t('mockExam.remaining', '剩余时间')}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="gap-1">
                <FileText className="w-3 h-3" />
                {t('mockExam.inProgress', '考试中')}
              </Badge>
              <span className="text-sm text-muted-foreground">
                {Object.keys(mockExamSession.answers).length} / {mockExamSession.question_ids.length} {t('mockExam.questions', '题')}
              </span>
            </div>
            <NotionButton
              variant="default"
              size="sm"
              onClick={() => setShowConfirmDialog(true)}
            >
              {t('mockExam.submit', '交卷')}
            </NotionButton>
          </div>
          <Progress value={progress} className="h-2" />
          
          {/* 时间不足警告 */}
          {examRemainingSeconds > 0 && examRemainingSeconds < 60 && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-rose-500/10 text-rose-600">
              <AlertCircle className="w-5 h-5" />
              <span className="text-sm font-medium">{t('mockExam.timeWarning', '考试时间不足 1 分钟！')}</span>
            </div>
          )}
        </CardContent>
      </Card>
      
      {/* 交卷确认对话框 */}
      <NotionAlertDialog
        open={showConfirmDialog}
        onOpenChange={setShowConfirmDialog}
        title={t('mockExam.confirmTitle', '确认交卷')}
        description={
          Object.keys(mockExamSession.answers).length < mockExamSession.question_ids.length
            ? t('mockExam.confirmWarning', '您还有 {{count}} 道题未作答，确定要交卷吗？', {
                count: mockExamSession.question_ids.length - Object.keys(mockExamSession.answers).length,
              })
            : t('mockExam.confirmMessage', '确定要提交考试吗？')
        }
        confirmText={t('mockExam.confirmSubmit', '确认交卷')}
        cancelText={t('mockExam.cancel', '取消')}
        confirmVariant="primary"
        onConfirm={handleSubmit}
      />
    </>
  );
};

export default MockExamMode;
