import type { JSX, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Barbell,
  ChartLineUp,
  Notebook,
  SunHorizon,
  Target,
  Timer,
  TreeStructure,
} from '@phosphor-icons/react';
import type { AutomationCreateInput } from '@/features/settings/components/automationSettingsApi';

export interface AutomationTemplate {
  id: string;
  icon: ReactNode;
  /** i18n key（模板名称，onSelect 时同时填入 draft.name） */
  nameKey: string;
  /** i18n key（卡片一行描述） */
  descriptionKey: string;
  /** i18n key（任务 prompt，onSelect 时按当前语言解析后填入 draft.prompt） */
  promptKey: string;
  /** prompt / name 留空，由 picker 在 onSelect 时用 t() 组装 */
  draft: Partial<AutomationCreateInput>;
}

const iconProps = { size: 18, weight: 'duotone', 'aria-hidden': true } as const;

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: 'dailyMistakes',
    icon: <Notebook {...iconProps} />,
    nameKey: 'todo:automation.templates.dailyMistakes.name',
    descriptionKey: 'todo:automation.templates.dailyMistakes.description',
    promptKey: 'todo:automation.templates.dailyMistakes.prompt',
    draft: {
      schedule: { kind: 'daily', time: '21:00' },
      actionType: 'agent_turn',
      sessionMode: 'isolated',
      catchUpPolicy: 'run_once',
    },
  },
  {
    id: 'weeklyReport',
    icon: <ChartLineUp {...iconProps} />,
    nameKey: 'todo:automation.templates.weeklyReport.name',
    descriptionKey: 'todo:automation.templates.weeklyReport.description',
    promptKey: 'todo:automation.templates.weeklyReport.prompt',
    draft: {
      schedule: { kind: 'weekly', time: '20:00', weekday: 0 },
      actionType: 'agent_turn',
      sessionMode: 'named',
      catchUpPolicy: 'run_once',
    },
  },
  {
    id: 'morningReview',
    icon: <SunHorizon {...iconProps} />,
    nameKey: 'todo:automation.templates.morningReview.name',
    descriptionKey: 'todo:automation.templates.morningReview.description',
    promptKey: 'todo:automation.templates.morningReview.prompt',
    draft: {
      schedule: { kind: 'weekdays', time: '07:30' },
      actionType: 'notify',
      catchUpPolicy: 'skip',
    },
  },
  {
    id: 'examSprint',
    icon: <Target {...iconProps} />,
    nameKey: 'todo:automation.templates.examSprint.name',
    descriptionKey: 'todo:automation.templates.examSprint.description',
    promptKey: 'todo:automation.templates.examSprint.prompt',
    draft: {
      // once 模板：date 留空由用户在创建面板中选择
      schedule: { kind: 'once', time: '07:00' },
      actionType: 'agent_turn',
      sessionMode: 'isolated',
      catchUpPolicy: 'run_once',
    },
  },
  {
    id: 'monthlyMap',
    icon: <TreeStructure {...iconProps} />,
    nameKey: 'todo:automation.templates.monthlyMap.name',
    descriptionKey: 'todo:automation.templates.monthlyMap.description',
    promptKey: 'todo:automation.templates.monthlyMap.prompt',
    draft: {
      schedule: { kind: 'monthly', time: '09:00', dayOfMonth: 1 },
      actionType: 'agent_turn',
      sessionMode: 'named',
      catchUpPolicy: 'run_once',
    },
  },
  {
    id: 'pomodoroBreak',
    icon: <Timer {...iconProps} />,
    nameKey: 'todo:automation.templates.pomodoroBreak.name',
    descriptionKey: 'todo:automation.templates.pomodoroBreak.description',
    promptKey: 'todo:automation.templates.pomodoroBreak.prompt',
    draft: {
      schedule: { kind: 'interval', time: '', intervalMinutes: 120 },
      actionType: 'notify',
      catchUpPolicy: 'skip',
    },
  },
  {
    id: 'midweekDrill',
    icon: <Barbell {...iconProps} />,
    nameKey: 'todo:automation.templates.midweekDrill.name',
    descriptionKey: 'todo:automation.templates.midweekDrill.description',
    promptKey: 'todo:automation.templates.midweekDrill.prompt',
    draft: {
      schedule: { kind: 'weekly', time: '18:00', weekday: 3 },
      actionType: 'agent_turn',
      sessionMode: 'isolated',
      catchUpPolicy: 'run_once',
    },
  },
];

export function AutomationTemplatePicker({ onSelect, disabled }: {
  onSelect: (draft: Partial<AutomationCreateInput>) => void;
  disabled?: boolean;
}): JSX.Element {
  const { t } = useTranslation();

  return (
    <div
      role="group"
      aria-label={t('todo:automation.templates.title')}
      className="grid grid-cols-2 gap-2 sm:grid-cols-3"
    >
      {AUTOMATION_TEMPLATES.map((template) => (
        <button
          key={template.id}
          type="button"
          disabled={disabled}
          onClick={() => onSelect({
            ...template.draft,
            name: t(template.nameKey),
            prompt: t(template.promptKey),
          })}
          className="group flex min-w-0 flex-col items-start gap-1 rounded-[var(--radius-shell-row)] border border-[color:var(--border-soft)] bg-transparent px-3 py-2.5 text-left transition-[border-color,transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:border-[color:hsl(var(--primary)/0.45)] hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
        >
          <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground">
            <span className="shrink-0 text-[color:hsl(var(--primary))]">{template.icon}</span>
            <span className="truncate">{t(template.nameKey)}</span>
          </span>
          <span className="line-clamp-1 w-full text-xs text-muted-foreground">
            {t(template.descriptionKey)}
          </span>
        </button>
      ))}
    </div>
  );
}
