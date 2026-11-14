import { AbsoluteFill } from 'remotion';
import { CameraView, clampCam, project, smoothCam, type CamKey } from '../../lib/camera';
import { clamp, ease, motion, PACE, prog } from '../../lib/time';
import { S } from '../../strings';
import { dark } from '../../theme';
import { Pupil, pathAt } from '../../ui/brand';
import { AgendaWidget, BriefingWidget, DesktopShortcuts } from '../../ui/desk';
import type { MemoryCard } from '@app/features/flashcards/memoryCurve';
import { exitButtonCenter, FcNav, FcSession, FcStats, FcToday, rateButtonCenter, revealButtonCenter, statsTabCenter, type FcMemoryData, type FcStatsData, type Rating, type SessionState } from '../../ui/flashcards';
import { TODO_ITEMS } from '../../ui/todo';
import { Dock, dockIconCenter, type DockBadge, GENIE_S, IND_S, MenuBar, menuClock, trafficCenter, Wallpaper, WB, WbWindow, winLife } from '../../ui/workbench';
import { wallDrift } from '../day/beats';
import { ANKI_CARDS } from '../practice/beats';

/** 04 练习（工作台部分）与 05 记住的节拍表，单位为脚本秒。 */
export const WK = {
  night0: 16.36, // 夜色以窗口为圆心收拢
  night1: 16.64,
  chrome: 16.54, // 菜单栏 / Dock 入场
  open0: 16.7, // 闪卡窗口弹开（「复习这批」走 API 启动：图标此前不在 Dock 上，按产品回退为窗口中心弹入）
  open1: 17.0,
  cards: [
    { at: 16.98, show: 17.24, rate: 17.55, rating: 3 as Rating },
    { at: 17.64, show: 17.88, rate: 18.14, rating: 4 as Rating },
    { at: 18.26, show: 18.7, rate: 19.18, rating: 1 as Rating },
  ],
  next: 19.3, // ξ 那张评「重来」后，下一张卡入场（不再交互）
  exit: 19.62, // 点「← 退出」回到今日页（会话页没有标签栏）
  stats: 19.92, // 点「统计」标签：记忆曲线面板在统计页最顶部
  minimize: 22.5, // 点黄灯：闪卡窗口 genie 吸入 Dock
  out0: 22.5,
  out1: 23.0,
} as const;

/** batch 复习顺序 = 卡片块顺序。 */
const REVIEW = ANKI_CARDS.slice(0, WK.cards.length + 1);
const N_BATCH = ANKI_CARDS.length;
/** 新卡首评预览：产品调度器（fsrs-rs，FSRS-6 默认参数）+ Anki 学习步 1m、10m：「困难」取两步均值 5.5m 显示为 6m，「简单」直接毕业 8 天。 */
const INTERVALS: [string, string, string, string] = ['1m', '6m', '10m', '8d'];
const RATING_LABEL: Record<Rating, string> = { 1: S.fc.again, 2: S.fc.hard, 3: S.fc.good, 4: S.fc.easy };

/** 窗口按级联 0 号槽落位（桌面 48, 48，下移菜单栏），闪卡默认尺寸 960×680（system/register.tsx）。 */
const WIN = { x: 48, y: WB.menubar + 48, w: 960, h: 680 } as const;
const CONTENT = { x: WIN.x + 1, y: WIN.y + 1 + WB.titlebar };
const STAGE = { x: CONTENT.x + 17.5, y: CONTENT.y + 125.5, w: 923, h: 437.5 };

const pressAt = (t: number, at: number, w = 0.1) => Math.max(0, 1 - Math.abs(t - at) / w);

// 片中时刻 → 应用里的毫秒时间（周五 21:30 前后，与菜单栏时钟一致）
const DAY_MS = 86_400_000;
const realMs = (t: number) => Date.UTC(2026, 9, 2, 13, 30) + (t - WK.night0) * PACE * 1000;
/** 新卡首评：[到期间隔 ms, 状态, 首评后稳定性 S = FSRS-6 的 w0..w3 天]（main 的 fsrs_scheduler.rs 测试同值） */
const FIRST: Record<Rating, [number, number, number]> = { 1: [60e3, 1, 0.212], 2: [330e3, 1, 1.2931], 3: [600e3, 1, 2.3065], 4: [8 * DAY_MS, 2, 8.2956] };
/**
 * 记忆曲线面板：「最近复习的 5 张卡」= 本次三张（最近评的在前）+ 昨晚复习过的两张错题本老卡；
 * 全部已学 389 张（386 张老卡平均可提取率 0.931）；近 30 天真实保留率 1066 / 1162。
 */
const MEMORY: FcMemoryData = (() => {
  const nowMs = realMs(WK.stats + 0.02);
  const card = (id: string, front: string, rating: Rating, state: number, stability: number, lastReviewMs: number, dueMs: number, reps: number, lapses: number): MemoryCard => ({
    cardStateId: id, ankiCardId: id, front, text: null, extraFields: {}, state, stability, difficulty: 5, lastReviewMs, dueMs, reps, lapses, lastRating: rating,
  });
  const fresh = WK.cards
    .map((c, i) => {
      const [ms, state, s] = FIRST[c.rating];
      return card(`st_v_${i}`, REVIEW[i].front, c.rating, state, s, realMs(c.rate), realMs(c.rate) + ms, 1, 0);
    })
    .reverse();
  const old = [
    card('st_old_lhopital', '洛必达法则使用前要先确认什么？', 3, 2, 24.23, nowMs - 0.93 * DAY_MS, nowMs + 23 * DAY_MS, 5, 1),
    card('st_old_taylor', 'eˣ 在 x = 0 处的三阶麦克劳林展开是什么？', 3, 2, 47.79, nowMs - 0.95 * DAY_MS, nowMs + 47 * DAY_MS, 4, 0),
  ];
  return { nowMs, cards: [...fresh, ...old], memorizedCount: 389, averageRetrievability: (386 * 0.931 + 3) / 389, trueRetention: { windowDays: 30, reviews: 1162, passed: 1066 }, desiredRetention: 0.9 };
})();
export const REVIEW_MEMORY = MEMORY;
export const REVIEW_MEMORY_FRESH = MEMORY.cards.slice(0, WK.cards.length);

// 复习时镜头推近到卡面 + 评分行：上沿切在批次提示条与工具行之间（y≈207），评分键下缘落在屏幕 y≈870，
// 给左下角字幕留位；x 被 clampCam 钳在桌面左缘。退出 / 点统计时拉开看见窗口左上（窗口顶落在「05 记住」章节标签下方），
// 再推近记忆曲线面板：1.8 倍下面板 922 宽整幅入画，三数字 + 曲线 + 本次三张卡的行都在字幕之上，两张老卡的行垫在字幕底下
const REVIEW_CAM: CamKey[] = [
  [WK.night0, { x: 960, y: 540, zoom: 1 }],
  [WK.open1, { x: 940, y: 532, zoom: 1.02 }, ease.linear],
  [WK.cards[0].at + 0.3, { x: 600, y: 555, zoom: 1.55 }, motion.camMove],
  [WK.cards[1].rate, { x: 600, y: 549, zoom: 1.58 }, ease.linear],
  [WK.cards[2].show - 0.14, { x: 600, y: 542, zoom: 1.61 }, motion.camMove],
  [WK.cards[2].rate + 0.06, { x: 600, y: 540, zoom: 1.62 }, ease.linear],
  [WK.exit - 0.06, { x: 640, y: 415, zoom: 1.3 }, motion.camMove],
  [WK.stats + 0.04, { x: 640, y: 415, zoom: 1.3 }, ease.linear],
  [WK.stats + 0.5, { x: 533, y: 520, zoom: 1.8 }, motion.camMove],
  [WK.minimize - 0.32, { x: 533, y: 523, zoom: 1.82 }, ease.linear],
  [WK.minimize - 0.06, { x: 960, y: 540, zoom: 1.0 }, motion.camMove],
  [WK.out1 - 0.06, { x: 960, y: 540, zoom: 1.0 }, ease.linear],
];

const ratedAt = (t: number) => WK.cards.filter((c) => t >= c.rate + 0.02).length;
const dueAt = (t: number) => N_BATCH - ratedAt(t);

/** 交接给「第二天」时的桌面状态：两边在 WK.out1 这一帧完全一致。 */
export const nightMenubar = (t: number) => ({
  app: t >= WK.open0 && t < WK.minimize ? S.apps.flashcards : S.desk.appName,
  clock: menuClock(2, 21, 30),
  due: dueAt(t),
});

export const nightDock = (t: number): { running: string[]; badges: Record<string, DockBadge>; indicator: Record<string, number> } => ({
  running: t >= WK.open0 ? ['chat', 'flashcards'] : ['chat'],
  badges: { flashcards: { kind: 'count', value: dueAt(t) } },
  indicator: { flashcards: (t - WK.open0) / IND_S },
});

/** 有可见窗口时桌面小组件淡到 0.55（280ms ease-out）。 */
export const nightDim = (t: number) => prog(t, WK.open0, WK.open0 + 0.14, ease.wbOut) * (1 - prog(t, WK.minimize + GENIE_S, WK.minimize + GENIE_S + 0.14, ease.wbOut));

const world = (p: { x: number; y: number }) => ({ x: CONTENT.x + p.x, y: CONTENT.y + p.y });
const MIN_BTN = { x: WIN.x + trafficCenter(1).x, y: WIN.y + trafficCenter(1).y };

const REVIEW_PUPIL: Array<[number, number, number]> = (() => {
  const pts: Array<[number, number, number]> = [];
  const at = (time: number, p: { x: number; y: number }) => pts.push([time, p.x, p.y]);
  const reveal = world(revealButtonCenter());
  at(WK.cards[0].at + 0.06, { x: STAGE.x + STAGE.w * 0.62, y: STAGE.y + STAGE.h * 0.5 });
  WK.cards.forEach((c, i) => {
    if (i === 2) at(c.at + 0.18, { x: STAGE.x + STAGE.w * 0.52, y: STAGE.y + STAGE.h * 0.46 });
    at(c.show - 0.05, reveal);
    at(c.show + 0.06, reveal);
    const rb = world(rateButtonCenter(c.rating));
    at(c.rate - 0.05, rb);
    at(c.rate + 0.08, rb);
  });
  // 评完三张：退出会话 → 统计标签（记忆曲线）→ 黄灯
  const exit = world(exitButtonCenter());
  const tab = world(statsTabCenter());
  at(WK.exit - 0.24, { x: exit.x + 140, y: exit.y + 160 });
  at(WK.exit - 0.04, exit);
  at(WK.exit + 0.06, exit);
  at(WK.stats - 0.05, tab);
  at(WK.stats + 0.08, tab);
  at(WK.stats + 0.4, { x: tab.x + 120, y: tab.y + 260 });
  pts.push([WK.minimize - 0.4, MIN_BTN.x + 160, MIN_BTN.y + 150]);
  pts.push([WK.minimize - 0.05, MIN_BTN.x, MIN_BTN.y]);
  pts.push([WK.minimize + 0.3, MIN_BTN.x + 50, MIN_BTN.y + 60]);
  return pts;
})();
const REVIEW_CLICKS = [...WK.cards.flatMap((c) => [c.show, c.rate]), WK.exit, WK.stats, WK.minimize];

const inStage = (p: { x: number; y: number }) => p.x >= STAGE.x && p.x <= STAGE.x + STAGE.w && p.y >= STAGE.y && p.y <= STAGE.y + STAGE.h;

/** 当前复习会话状态（随时间推进的评分、计数、翻面、换卡）。 */
const sessionAt = (t: number): SessionState => {
  const cs = [...WK.cards, { at: WK.next, show: Infinity, rate: Infinity, rating: 3 as Rating }];
  let idx = 0;
  for (let i = 1; i < cs.length; i++) if (t >= cs[i].at) idx = i;
  const c = cs[idx];
  const rated = cs.filter((x) => t >= x.rate + 0.02);
  const learnAdds = rated.filter((x) => x.rating !== 4).length;
  const last = rated[rated.length - 1];
  // 「点击翻面」只在指针停在卡面上时出现（opacity 160ms）；指针入场前不算
  const hover = (k: number) => (k >= WK.cards[0].at + 0.06 && inStage(pathAt(k, REVIEW_PUPIL)) ? 1 : 0);
  return {
    card: REVIEW[idx],
    back: t >= c.show,
    flipK: prog(t, c.show, c.show + 0.15),
    enter: idx === 0 ? 1 : prog(t, c.at, c.at + 0.13),
    rateMode: prog(t, c.show, c.show + 0.1, ease.outExpo),
    intervals: INTERVALS,
    revealHover: t >= c.show - 0.1 && t < c.show + 0.02 ? 1 : 0,
    revealPress: pressAt(t, c.show, 0.08),
    hoverRating: t >= c.rate - 0.12 && t < c.rate + 0.02 ? c.rating : null,
    pressRating: t >= c.rate && t < c.rate + 0.12 ? c.rating : null,
    pressK: prog(t, c.rate, c.rate + 0.12),
    progress: rated.length / (N_BATCH + learnAdds),
    rated: rated.length,
    newCount: N_BATCH - rated.length,
    learnCount: learnAdds,
    timer: `0:${String(Math.max(0, Math.floor((t - c.at) * PACE))).padStart(2, '0')}`,
    nudge: last ? { text: S.fc.undoNudge(RATING_LABEL[last.rating]), k: prog(t, last.rate + 0.02, last.rate + 0.11) } : null,
    cardHover: (hover(t) + hover(t - 0.04) + hover(t - 0.08)) / 3,
    exitHover: prog(t, WK.exit - 0.08, WK.exit - 0.03) * (t < WK.exit + 0.02 ? 1 : 0),
  };
};

/** 复习完三张后的队列（与 FC=1 取证的 fsrs mock 一致）：386 张老卡 + 12 张新卡，新 9、学习中 2+2、复习中 384+1。 */
const AFTER: FcStatsData = { reviewsToday: 3, due: 9, newCount: 9, learning: 4, review: 385, relearning: 0, suspended: 0, total: 398, streak: 47 };

export const SceneReview = ({ t }: { t: number }) => {
  const tk = dark;
  const cam = clampCam(smoothCam(t, REVIEW_CAM));
  const night = prog(t, WK.night0, WK.night1, ease.inOutCubic);
  const chrome = springChrome(t);
  const dock = nightDock(t);
  const flash = winLife(t, WIN, { openAt: WK.open0, openFrom: null, minimizeAt: WK.minimize, minimizeTo: dockIconCenter('flashcards', dock.running) });
  const toToday = prog(t, WK.exit + 0.02, WK.exit + 0.1, ease.brand);
  const onStats = t >= WK.stats + 0.02;
  const session = sessionAt(t);
  const bar = nightMenubar(t);
  const dim = nightDim(t);

  const pw = pathAt(t, REVIEW_PUPIL);
  const pScreen = project(cam, pw.x, pw.y);
  // 指针从评分一路走到「统计」，推近面板时淡出；点黄灯前再回来
  const pOpacity = Math.max(
    prog(t, WK.cards[0].at + 0.04, WK.cards[0].at + 0.14) * (1 - prog(t, WK.stats + 0.2, WK.stats + 0.34)),
    prog(t, WK.minimize - 0.42, WK.minimize - 0.32) * (1 - prog(t, WK.minimize + 0.2, WK.minimize + 0.32)),
  );

  return (
    <AbsoluteFill>
      <CameraView cam={cam}>
        <div style={{ position: 'absolute', left: 0, top: 0, width: 1920, height: 1080 }}>
          <Wallpaper drift={wallDrift(t)} style={{ opacity: night }} />
          <div style={{ position: 'absolute', inset: 0, opacity: night }}>
            <DesktopShortcuts tk={tk} />
            <AgendaWidget tk={tk} dim={dim} day={2} items={TODO_ITEMS} />
            <BriefingWidget tk={tk} dim={dim} due={dock.badges.flashcards.kind === 'count' ? dock.badges.flashcards.value : 0} done={2} total={2} />
          </div>
          {flash.visible ? (
            <WbWindow tk={tk} rect={WIN} title={S.apps.flashcards} focused={t < WK.minimize} style={flash.style}>
              {toToday < 1 ? (
                <div style={{ position: 'absolute', inset: 0, opacity: 1 - toToday }}>
                  <FcSession s={session} />
                </div>
              ) : null}
              {toToday > 0 ? (
                <div style={{ position: 'absolute', inset: 0, opacity: toToday }}>
                  <FcNav active={onStats ? 'statistics' : 'today'} todayBadge={AFTER.due} />
                  {onStats ? (
                    <FcStats t={t} start={WK.stats + 0.02} d={AFTER} memory={MEMORY} />
                  ) : (
                    <FcToday
                      due={AFTER.due}
                      newCount={AFTER.newCount}
                      learning={AFTER.learning}
                      waiting={2}
                      progress={WK.cards.length / N_BATCH}
                      streak={AFTER.streak}
                      upNext={ANKI_CARDS.slice(WK.cards.length).map((c) => c.front)}
                      dateLabel="10月2日星期五"
                      k={toToday}
                    />
                  )}
                </div>
              ) : null}
            </WbWindow>
          ) : null}
          <div style={{ position: 'absolute', inset: 0, opacity: clamp(chrome * 1.4), transform: `translateY(${(1 - chrome) * -WB.menubar}px)` }}>
            <MenuBar tk={tk} app={bar.app} clock={bar.clock} due={bar.due} />
          </div>
          <div style={{ position: 'absolute', inset: 0, opacity: clamp(chrome * 1.4), transform: `translateY(${(1 - chrome) * 90}px)` }}>
            <Dock tk={tk} running={dock.running} badges={dock.badges} indicator={dock.indicator} />
          </div>
        </div>
      </CameraView>
      <Pupil x={pScreen.x} y={pScreen.y} t={t} opacity={pOpacity} clicks={REVIEW_CLICKS} />
    </AbsoluteFill>
  );
};

/** 菜单栏 / Dock 随夜色一起入场（工作台外壳就位，不属于产品动效）。 */
const springChrome = (t: number) => prog(t, WK.chrome, WK.chrome + 0.22, ease.wbOut);
