/**
 * PomodoroWindowSettings — 番茄钟 OS 窗口的设置面板内容
 *
 * 与 legacy `PomodoroSettingsContent`（Todo 页原生控件表单）分流：
 * 窗口版全部走设计系统控件——Slider（时长/音量）、Switch（开关）、
 * SegmentedControl（音色），视觉对齐 OS 设置应用。
 *
 * 样式类在 PomodoroAppWindow.css（wb-sys-pomo-set-* 前缀）。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Slider } from '@/components/ui/shad/Slider';
import { Switch } from '@/components/ui/shad/Switch';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import { NOISE_TYPES, type NoiseType } from '@/features/pomodoro/noiseEngine';
import { setAndroidBackgroundCompletion } from '@/features/pomodoro';
import { isAndroidMobileShell } from '@/utils/platform';

// ============================================================================
// 行件
// ============================================================================

/** 滑杆行：行首标签 + 当前值，行尾单位在值文本内；滑杆占整行 */
const SliderRow: React.FC<{
  label: string;
  display: string;
  unit?: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}> = ({ label, unit, value, min, max, onChange }) => {
  const { t } = useTranslation('todo');
  const clampVal = (raw: number) => Math.max(min, Math.min(max, Math.round(raw)));
  return (
    <div className="wb-sys-pomo-set-row">
      <div className="wb-sys-pomo-set-rowhead">
        <span className="wb-sys-pomo-set-label">{label}</span>
        <div className="wb-sys-pomo-set-value inline-flex items-center gap-1.5">
          <button
            type="button"
            aria-label={`${label} -1`}
            onClick={() => onChange(clampVal(value - 1))}
            disabled={value <= min}
            className="inline-flex h-6 w-6 items-center justify-center rounded border border-border/60 bg-background/60 text-xs text-foreground hover:bg-muted disabled:opacity-40"
          >
            -
          </button>
          <input
            type="number"
            min={min}
            max={max}
            value={value}
            aria-label={t('pomodoro.settings.numberInputAria', {
              label,
              defaultValue: `${label}`,
            })}
            onChange={(e) => {
              const parsed = Number(e.target.value);
              if (!Number.isNaN(parsed)) {
                onChange(clampVal(parsed));
              }
            }}
            className="h-6 w-14 rounded border border-border/60 bg-background/70 px-1.5 text-right font-mono text-xs tabular-nums text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {unit ? <span>{unit}</span> : null}
          <button
            type="button"
            aria-label={`${label} +1`}
            onClick={() => onChange(clampVal(value + 1))}
            disabled={value >= max}
            className="inline-flex h-6 w-6 items-center justify-center rounded border border-border/60 bg-background/60 text-xs text-foreground hover:bg-muted disabled:opacity-40"
          >
            +
          </button>
        </div>
      </div>
      <Slider
        className="py-1.5"
        value={[value]}
        min={min}
        max={max}
        step={1}
        onValueChange={(v) => onChange(v[0] ?? min)}
        aria-label={label}
      />
    </div>
  );
};

/** 开关行：标签 + 设计系统 Switch */
const ToggleRow: React.FC<{
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}> = ({ label, checked, onChange }) => (
  <div className="wb-sys-pomo-set-toggle">
    <span className="wb-sys-pomo-set-label">{label}</span>
    <Switch size="sm" checked={checked} onCheckedChange={onChange} aria-label={label} />
  </div>
);

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="wb-sys-pomo-set-section">{children}</div>
);

// ============================================================================
// 面板主体
// ============================================================================

export const PomodoroWindowSettings: React.FC = () => {
  const { t } = useTranslation('todo');
  const settings = usePomodoroStore((s) => s.settings);
  const updateSettings = usePomodoroStore((s) => s.updateSettings);

  const noiseAutoWithFocus = settings.noiseAutoWithFocus;

  const minutesUnit = t('pomodoro.settings.minutesUnit');
  const pomodorosUnit = t('pomodoro.settings.pomodorosUnit');
  const minutes = (v: number) => `${v} ${minutesUnit}`.trim();
  const pomodoros = (v: number) => `${v} ${pomodorosUnit}`.trim();

  return (
    <div className="wb-sys-pomo-set">
      {/* ---- 时长 ---- */}
      <SectionTitle>{t('pomodoro.settings.sections.duration')}</SectionTitle>
      <SliderRow
        label={t('pomodoro.settings.workDuration')}
        display={minutes(Math.round(settings.workDuration / 60))}
        unit={minutesUnit}
        value={Math.round(settings.workDuration / 60)}
        min={1}
        max={120}
        onChange={(v) => updateSettings({ workDuration: v * 60 })}
      />
      <SliderRow
        label={t('pomodoro.settings.shortBreak')}
        display={minutes(Math.round(settings.shortBreak / 60))}
        unit={minutesUnit}
        value={Math.round(settings.shortBreak / 60)}
        min={1}
        max={60}
        onChange={(v) => updateSettings({ shortBreak: v * 60 })}
      />
      <SliderRow
        label={t('pomodoro.settings.longBreak')}
        display={minutes(Math.round(settings.longBreak / 60))}
        unit={minutesUnit}
        value={Math.round(settings.longBreak / 60)}
        min={1}
        max={90}
        onChange={(v) => updateSettings({ longBreak: v * 60 })}
      />
      <SliderRow
        label={t('pomodoro.settings.longBreakInterval')}
        display={pomodoros(settings.longBreakInterval)}
        unit={pomodorosUnit}
        value={settings.longBreakInterval}
        min={1}
        max={12}
        onChange={(v) => updateSettings({ longBreakInterval: v })}
      />

      {/* ---- 自动化 ---- */}
      <SectionTitle>{t('pomodoro.settings.sections.automation')}</SectionTitle>
      <ToggleRow
        label={t('pomodoro.settings.autoStartBreaks')}
        checked={settings.autoStartBreaks}
        onChange={(v) => updateSettings({ autoStartBreaks: v })}
      />
      <ToggleRow
        label={t('pomodoro.settings.autoStartWork')}
        checked={settings.autoStartWork}
        onChange={(v) => updateSettings({ autoStartWork: v })}
      />

      {/* ---- 专注 ---- */}
      <SectionTitle>{t('pomodoro.settings.sections.focus')}</SectionTitle>
      <ToggleRow
        label={t('pomodoro.settings.strictMode')}
        checked={settings.strictMode}
        onChange={(v) => updateSettings({ strictMode: v })}
      />
      <ToggleRow
        label={t('pomodoro.settings.countUp')}
        checked={settings.countUp}
        onChange={(v) => updateSettings({ countUp: v })}
      />
      {isAndroidMobileShell() && (
        <ToggleRow
          label={t('pomodoro.settings.androidBackgroundCompletion')}
          checked={settings.androidBackgroundCompletion}
          onChange={setAndroidBackgroundCompletion}
        />
      )}
      <SliderRow
        label={t('pomodoro.settings.endReminderShort')}
        display={
          settings.endReminderSeconds === 0
            ? t('pomodoro.settings.valueOff')
            : minutes(Math.round(settings.endReminderSeconds / 60))
        }
        unit={minutesUnit}
        value={Math.round(settings.endReminderSeconds / 60)}
        min={0}
        max={10}
        onChange={(v) => updateSettings({ endReminderSeconds: v * 60 })}
      />
      <SliderRow
        label={t('pomodoro.settings.dailyGoalShort')}
        display={
          settings.dailyGoal === 0
            ? t('pomodoro.settings.valueUnset')
            : pomodoros(settings.dailyGoal)
        }
        unit={pomodorosUnit}
        value={settings.dailyGoal}
        min={0}
        max={99}
        onChange={(v) => updateSettings({ dailyGoal: v })}
      />

      {/* ---- 环境音 ----
          音色/音量改动经 updateSettings 落库，播放中的引擎同步由 store 统一处理 */}
      <SectionTitle>{t('pomodoro.settings.noiseType')}</SectionTitle>
      <SegmentedControl<NoiseType>
        ariaLabel={t('pomodoro.settings.noiseType')}
        size="compact"
        className="w-full"
        itemClassName="flex-1 justify-center [@media(pointer:coarse)]:!min-h-11"
        value={settings.noiseType}
        onValueChange={(type) => updateSettings({ noiseType: type })}
        options={NOISE_TYPES.map((type) => ({
          value: type,
          label: t(`pomodoro.noise.${type}`),
        }))}
      />
      <SliderRow
        label={t('pomodoro.settings.noiseVolume')}
        display={`${Math.round(settings.noiseVolume * 100)}%`}
        value={Math.round(settings.noiseVolume * 100)}
        min={0}
        max={100}
        onChange={(v) => updateSettings({ noiseVolume: v / 100 })}
      />
      <ToggleRow
        label={t('pomodoro.settings.noiseAutoWithFocus')}
        checked={noiseAutoWithFocus}
        onChange={(v) => updateSettings({ noiseAutoWithFocus: v })}
      />
    </div>
  );
};

export default PomodoroWindowSettings;
