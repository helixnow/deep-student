/**
 * UI 半：设置里的“学习目标”分区（每日目标存在插件存储里）+ 命令面板的“记录一个番茄钟”命令 + 学习资源库里资源的
 * 右键菜单行“学完了，记一个番茄钟”。命令经 plugin:host|call 交给 Host 半累计，再用返回值（或拒绝值）组成命令面板的通知；
 * 菜单行没有通知可用，累计结果放进插件 store，下次打开菜单时标签带上今天已学的分钟数。
 *
 * 设置分区要带 `navigation` 才会出现在设置侧栏（src/ui-plugins/official/settings/navigation.ts 的 settingsNavigation）；
 * 社区分区由设置外壳包在错误边界里渲染，组件收到 `SettingsSectionRenderProps`（值类型 `SettingsSection` 也随 SDK 导出）。
 *
 * 当天的累计放在插件 store（`TodayStore`）里：设置分区订阅它，命令与资源菜单行写入它，所以一处记录后已经挂载的分区
 * 直接重渲染，不用重新挂载或轮询。Host 半提交后推送事件，处理函数也写这个 store（SDK §5）。
 *
 * 只从 `react` 与 `@deepstudent/ui` 导入（四个共享模块之一）；构建见 examples/README.md。
 */
import React, { useEffect, useState } from 'react';
import {
  createPluginStore, definePlugin, SegmentedControl, usePluginStorage, usePluginStore, useT, withPluginScope,
  type PluginStore, type ScopedResourceMenuContribution, type SettingsSectionRenderProps,
} from '@deepstudent/ui';
import { localDate, TODAY_EVENT, type StudyDay } from './day';

export const PLUGIN_ID = 'example.study-goal';
/** 分区 id 同时是设置页的 tab 值与 keyed 槽位的 key，用 `<插件 id>/<名字>` 避免与官方分区冲突。 */
export const SECTION_ID = `${PLUGIN_ID}/goal`;
export const LOG_COMMAND_ID = `${PLUGIN_ID}.log`;
/** `resource.contextMenu` 是列表槽位，行 id 也用 `<插件 id>/<名字>`，与官方行区分。 */
export const MENU_ROW_ID = `${PLUGIN_ID}/log-resource`;
export const GOAL_KEY = 'dailyGoal';
export const GOAL_CHOICES = [30, 60, 90, 120] as const;
export const DEFAULT_GOAL = 60;
/** 一个番茄钟。 */
export const LOG_MINUTES = 25;

export const messages = {
  'zh-CN': {
    title: '学习目标',
    description: '每日学习时长目标',
    goal_label: '每日目标',
    minutes: '{{count}} 分钟',
    loading: '加载中…',
    progress: '今天已学 {{minutes}} / {{goal}} 分钟',
    reached: '今天已学 {{minutes}} 分钟，目标完成',
    log: '记录一个番茄钟（25 分钟）',
    failed: '记录失败：{{reason}}',
    menu_log: '学完了，记一个番茄钟',
    menu_log_today: '学完了，记一个番茄钟（今天已学 {{minutes}} 分钟）',
  },
  'en-US': {
    title: 'Study goal',
    description: 'Daily study time goal',
    goal_label: 'Daily goal',
    minutes_one: '{{count}} minute',
    minutes_other: '{{count}} minutes',
    loading: 'Loading…',
    progress: '{{minutes}} / {{goal}} minutes today',
    reached: '{{minutes}} minutes today, goal reached',
    log: 'Log a pomodoro (25 minutes)',
    failed: 'Failed to log: {{reason}}',
    menu_log: 'Studied it: log a pomodoro',
    menu_log_today: 'Studied it: log a pomodoro ({{minutes}} min today)',
  },
};

function reasonOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
}

function TargetIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" />
      <circle cx="8" cy="8" r="3" />
    </svg>
  );
}

export function progressKey(day: StudyDay, goal: number): 'reached' | 'progress' {
  return day.minutes >= goal ? 'reached' : 'progress';
}

/** 设置分区、命令与资源菜单行共用的当天累计：谁记了一笔就写这里，已挂载的分区随 store 重渲染，不用重挂。 */
export interface TodayStore {
  day: StudyDay | null;
}

export function GoalSection({ loadDay, today }: { loadDay: () => Promise<StudyDay>; today: PluginStore<TodayStore> }) {
  const t = useT();
  const [goal, setGoal] = usePluginStorage(GOAL_KEY, DEFAULT_GOAL);
  const day = usePluginStore(today, (state) => state.day);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // 只补第一次：之后的值来自命令、菜单行或 Host 半推来的事件。
    if (day) return;
    let live = true;
    loadDay().then(
      (value) => { if (live) today.setState({ day: value }); },
      (e: unknown) => { if (live) setError(reasonOf(e)); },
    );
    return () => { live = false; };
  }, [day, loadDay, today]);
  return (
    <section>
      <h3>{t('goal_label')}</h3>
      <SegmentedControl
        ariaLabel={t('goal_label')}
        value={String(goal)}
        onValueChange={(value) => setGoal(Number(value))}
        options={GOAL_CHOICES.map((minutes) => ({ value: String(minutes), label: t('minutes', { count: minutes }) }))}
      />
      {error ? <p role="alert">{error}</p>
        : day ? <p role="status">{t(progressKey(day, goal), { minutes: day.minutes, goal })}</p>
        : <p>{t('loading')}</p>}
    </section>
  );
}

export default definePlugin({
  meta: { id: 'example.study-goal', version: '1.0.0', host: true },
  apply(ctx) {
    const t = ctx.ui.i18n.addBundles(messages);
    const ns = ctx.ui.i18n.namespace;
    const storage = ctx.ui.storage;
    const host = ctx.ui.host.exampleStudyGoal!;
    const loadToday = () => host.day!(localDate()) as Promise<StudyDay>;
    const logPomodoro = () => host.log!(localDate(), LOG_MINUTES) as Promise<StudyDay>;
    /** 当天累计：设置分区订阅它，命令与菜单行写入它（菜单标签也读它）。 */
    const today = createPluginStore<TodayStore>(ctx, { day: null });
    const loggedToday = () => {
      const { day } = today.getState();
      return day?.date === localDate() ? day.minutes : undefined;
    };
    // Host 半提交后发 `example/study-goal:today`。UI 半按裸名字订阅，内核按本插件 id 补前缀、只放行本插件命名空间，
    // 并在卸载时自动退订。事件是通知不是请求：跨过本地午夜才到的旧载荷不动今天显示，写库仍以命令/菜单行的返回值与 Host 为准。
    ctx.effect(() => ctx.ui.host.on<StudyDay>(TODAY_EVENT, (payload) => {
      if (payload.date === localDate() && Number.isInteger(payload.minutes)) today.setState({ day: payload });
    }));

    // 设置外壳不经 <SlotOutlet> 渲染分区，用 withPluginScope 让 useT / usePluginStorage 找到本插件。
    const Section = withPluginScope<SettingsSectionRenderProps>(ctx, () => <GoalSection loadDay={loadToday} today={today} />);
    ctx.ui.contribute('settings.sections', {
      id: SECTION_ID,
      key: SECTION_ID,
      order: 900,
      value: {
        id: SECTION_ID,
        group: PLUGIN_ID,
        order: 900,
        titleKey: `${ns}:title`,
        component: Section,
        navigation: {
          order: 900,
          legacyGroup: 4,
          icon: TargetIcon,
          mobileDescriptionKey: `${ns}:description`,
          mobileAccent: 'var(--settings-nav-accent-teal)',
        },
      },
    });

    ctx.ui.commands.register({
      id: LOG_COMMAND_ID,
      name: `${ns}:log`,
      category: 'learning',
      keywords: ['pomodoro', 'study goal'],
      // 返回 { success, message } 时命令面板弹出对应通知（src/command-palette/registry/commandRegistry.ts）。
      execute: async () => {
        const goal = storage.get(GOAL_KEY, DEFAULT_GOAL);
        try {
          const day = await logPomodoro();
          today.setState({ day });
          return { success: true, message: t(progressKey(day, goal), { minutes: day.minutes, goal }) };
        } catch (error) {
          return { success: false, message: t('failed', { reason: reasonOf(error) }) };
        }
      },
    });

    // 学习资源库（scope 'resource'）里资源上的菜单行；`scopes` 让内核保证它只在这个界面出现。
    // `ScopedResourceMenuContribution<'resource'>` 会把 context 推成 never，所以用缺省泛型，在 visible 里按 scope 收窄。
    // 文案由菜单用它自己的 t 解析，键要写成 `<命名空间>:<键>`。
    const logRow: ScopedResourceMenuContribution = {
      id: MENU_ROW_ID,
      order: 900,
      scopes: ['resource'],
      visible: (context) => context.scope === 'resource' && context.resourceItem !== null && !context.isFolder,
      icon: 'CheckCircle',
      labelKey: () => (loggedToday() === undefined ? `${ns}:menu_log` : `${ns}:menu_log_today`),
      labelParams: () => ({ minutes: loggedToday() }),
      run: (context) => {
        // 菜单不会替插件关闭，点击回调里的异常也没有错误边界接：先关菜单，Host 半的拒绝自己处理。
        context.closeMenu();
        logPomodoro().then(
          (day) => today.setState({ day }),
          (error: unknown) => ctx.ui.reportError(new Error(reasonOf(error)), { slot: 'resource.contextMenu', entryId: MENU_ROW_ID }),
        );
      },
    };
    ctx.ui.contribute('resource.contextMenu', { id: MENU_ROW_ID, order: 900, value: logRow });
  },
});
