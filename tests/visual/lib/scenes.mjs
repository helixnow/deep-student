/**
 * Scenes of the demo shell (src/demo): the two whole-shell demos and the single-app demos of
 * src/demo/app/registry.ts. The DOM layer snapshots every scene but those in DOM_EXCLUDED (desktop|mobile);
 * `visual: true` marks the 12 scenes of the screenshot matrix (12 × desktop|mobile × light|dark); the IPC
 * layer boots every scene and replays `steps`.
 */
import { setStep, settle, waitForQuiet } from './page.mjs';

const APPS = [
  'chat', 'research-memory', 'learning-hub', 'reading-translation', 'paper-search', 'media', 'notes', 'mindmap',
  'essay', 'productivity', 'question-bank', 'anki', 'flashcards', 'models', 'skills-mcp', 'data-sync',
];

const VISUAL = new Set([
  'shell-chat', 'shell-desktop', 'chat', 'learning-hub', 'notes', 'mindmap', 'question-bank', 'anki', 'flashcards',
  'models', 'skills-mcp', 'essay',
]);

/**
 * Kept out of the DOM layer because its snapshot is not reproducible: the reading-translation desktop view
 * renders the PDF row before the first visible page (page 42 of the virtualised list) in some runs only,
 * 2 of 3 `--update` runs on 1d1fdb78.
 */
const DOM_EXCLUDED = new Set(['reading-translation']);

const button = (page, label) => page.locator(`[role="button"][aria-label="${label}"], button[aria-label="${label}"]`).first();

/** Interaction scripts for the IPC layer; each step's calls are recorded under its name. */
const STEPS = {
  'shell-chat': [
    {
      // Opening a scripted session plays its first answer; wait for the stream to finish.
      name: 'open-session',
      run: async (page) => {
        await page.getByLabel('数据并行训练 · 双语阅读', { exact: true }).first().click();
        await waitForQuiet(page, { quietMs: 2500, timeoutMs: 60_000 });
      },
    },
    {
      name: 'send-message',
      run: async (page) => {
        await page.getByLabel('请输入问题...', { exact: true }).first().fill('用一句话解释数据并行');
        await button(page, '发送消息').click();
        await waitForQuiet(page, { quietMs: 2500, timeoutMs: 60_000 });
      },
    },
    // Header controls only become visible on hover; the click handler is what is under test.
    {
      name: 'command-palette',
      run: async (page) => {
        await button(page, '命令面板').dispatchEvent('click');
        const dialog = page.locator('[role="dialog"][aria-label="命令面板"]');
        await dialog.waitFor();
        await dialog.locator('input').first().press('Escape');
        await dialog.waitFor({ state: 'hidden' });
      },
    },
    { name: 'new-session', run: (page) => button(page, '新建会话').dispatchEvent('click') },
  ],
};

/**
 * IPC layer only (`openScene(…, { clock: true })`): page-clock moves that put app timers on a fixed side of the
 * boot window. The page clock otherwise follows the wall clock, so whether a timer landed inside the window
 * depended on how soon the page went quiet and how long the main thread took (REGRESSION.md §3.3).
 * - `startupTimers`: once the scene has settled, run the page clock this far, then settle again. Every timer
 *   armed during boot with at most this delay fires inside the boot step. 5000 ms covers the silent update
 *   check (src/hooks/useAppUpdater.ts, 5 s after start), which used to land just after the window.
 * - `replyJump`: when the reply that boot plays has ended its first block, fast-forward the page clock this far
 *   once. The streaming-block save (STREAMING_BLOCK_SAVE_THROTTLE_MS, 5 s after a block's first chunk,
 *   cancelled when the stream completes) then always fires: the opening anki-cards reply is scripted to
 *   about 5.06 s, so without the jump only main-thread time decided whether the stream outlived the throttle.
 * The moves also shift every later step on the page clock, and with it where periodic timers land (the 30 s
 * todo reminder poll falls mid-typing in shell-chat's open-session); goldens are recorded with the moves.
 */
const BOOT_CLOCK = {
  'shell-chat': { replyJump: 5000, startupTimers: 5000 },
  'shell-desktop': { startupTimers: 5000 },
};

export const SCENES = [
  { id: 'shell-chat', entry: 'demo.html', ready: 'quiet' },
  { id: 'shell-desktop', entry: 'demo.html?desktop=1', ready: 'quiet' },
  ...APPS.map((app) => ({ id: app, entry: `demo-app.html?app=${app}`, ready: 'demo-ready' })),
].map((scene) => ({ ...scene, visual: VISUAL.has(scene.id), steps: STEPS[scene.id] ?? [], bootClock: BOOT_CLOCK[scene.id] ?? null }));

export const VISUAL_SCENES = SCENES.filter((scene) => scene.visual);
export const DOM_SCENES = SCENES.filter((scene) => !DOM_EXCLUDED.has(scene.id));

export function sceneUrl(base, scene, theme = 'light') {
  const [file, query = ''] = scene.entry.split('?');
  const params = new URLSearchParams(query);
  if (theme === 'dark') params.set('theme', 'dark');
  const q = params.toString();
  return `${base}/${file}${q ? `?${q}` : ''}`;
}

/** True once boot's chat reply has emitted the `end` of a block (the trace rows keep emitted block phases). */
export function replyBlockEnded() {
  return (window.__DS_TRACE__ ?? []).some((row) => row.phase === 'end' && row.call.startsWith('emit:chat_v2_event_'));
}

/**
 * Load a scene and wait until it is settled. Returns false if the readiness signal never came.
 * `clock: true` applies the scene's `bootClock` moves (IPC layer); the DOM and screenshot layers never do.
 */
export async function openScene(page, base, scene, theme = 'light', { clock = false } = {}) {
  const moves = clock ? scene.bootClock : null;
  await page.goto(sceneUrl(base, scene, theme), { waitUntil: 'load', timeout: 60_000 });
  let ready = true;
  // Before the quiet wait starts: a jump during it would read as 5 s without DOM mutations.
  if (moves?.replyJump) {
    ready = await page.waitForFunction(replyBlockEnded, null, { timeout: 60_000, polling: 20 }).then(() => true, () => false);
    if (ready) await page.clock.fastForward(moves.replyJump);
  }
  if (scene.ready === 'demo-ready') {
    ready = ready && await page.waitForFunction(() => window.__DEMO_READY__ === true, null, { timeout: 30_000, polling: 100 }).then(() => true, () => false);
  } else {
    // Whole-shell demos have no flag: the scripted first answer streams in, then the DOM goes quiet.
    ready = ready && await page.waitForFunction(() => document.body.innerText.length > 200, null, { timeout: 30_000, polling: 100 }).then(() => true, () => false);
    ready = ready && await waitForQuiet(page, { quietMs: 2500, timeoutMs: 60_000 });
  }
  await settle(page);
  if (moves?.startupTimers) {
    await page.clock.runFor(moves.startupTimers);
    await settle(page);
  }
  return ready;
}

export async function runSteps(page, scene) {
  for (const step of scene.steps) {
    await setStep(page, step.name);
    await step.run(page);
    await settle(page);
  }
}
