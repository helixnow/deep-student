/**
 * Golden path ③: create a note in the notes app, edit title and body, let it save, reopen it (same run and
 * after a relaunch on the same data root) and get the same content back.
 */
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../support/app.ts';
import { collectHealth, describeFailures } from '../support/diagnostics.ts';
import { passFirstRun, waitForBridge } from '../support/onboarding.ts';

const TITLE = '冒烟笔记标题';
const BODY = 'SMOKE-NOTE-BODY 第一段内容';
const TYPED_TITLE = '冒烟直接输入的标题';
const FOCUS_LOG = '__smokeFocusLog';

interface NoteRow { id: string; title: string; content_md: string }

const focused = (page: Page) => page.locator('[data-wb-window][data-focused="true"]');

/** Start a fresh `focusin` timeline (ms since this call, element tag.class[aria-label]). */
async function recordFocus(page: Page): Promise<void> {
  await page.evaluate((key) => {
    type El = { tagName?: string; className?: unknown; getAttribute?(name: string): string | null };
    const g = globalThis as unknown as Record<string, unknown> & {
      document: { addEventListener(type: string, listener: (event: { target: El | null }) => void): void };
    };
    const log: string[] = [];
    const start = performance.now();
    g[key] = log;
    g.document.addEventListener('focusin', ({ target }) => {
      const label = target?.getAttribute?.('aria-label');
      log.push(`${Math.round(performance.now() - start)}ms ${target?.tagName}.${String(target?.className ?? '').split(' ')[0]}${label ? `[${label}]` : ''}`);
    });
  }, FOCUS_LOG);
}
const focusTimeline = (page: Page) => page.evaluate((key) => ((globalThis as unknown as Record<string, string[]>)[key] ?? []).join(' → '), FOCUS_LOG);
const activeElement = (page: Page) => page.evaluate(() => {
  const el = (globalThis as unknown as { document: { activeElement: { tagName: string; className: string } | null } }).document.activeElement;
  return el ? `${el.tagName}.${String(el.className).split(' ')[0]}` : 'none';
});

async function openNotesApp(page: Page): Promise<void> {
  await page.getByTestId('wb-dock-apps-button').click();
  await page.getByTestId('wb-apps-item-notes').click();
  await expect(focused(page).getByText(/个文件/)).toBeVisible();
}

test.describe.serial('③ notes / VFS', () => {
  let app: LaunchedApp;
  let root = '';
  let noteId = '';

  test.afterAll(async () => {
    await app?.close();
  });

  test('a new note is edited and saved from the notes app', async () => {
    app = await launchApp({ label: 'notes' });
    root = app.root;
    const { page } = app;
    await waitForBridge(page);
    await app.call('plugin:host|status', {}, 90_000);
    await passFirstRun(page);
    await openNotesApp(page);

    await app.mark('note-edit');
    await recordFocus(page);
    await focused(page).getByRole('button', { name: /新建笔记|New note/ }).first().click();
    const title = focused(page).getByRole('textbox', { name: /笔记标题|Note title/ });
    await expect(title).toBeVisible();
    // A new note should focus its title (NotesEditorHeader autoFocusTitle), but the body editor ends up with
    // focus, so typing right away lands in the body (#23, pinned by the last test). Record where focus goes,
    // then type the title like a user who clicks it.
    await expect(focused(page).locator('.ProseMirror').first()).toBeVisible();
    await page.waitForTimeout(1_000);
    test.info().annotations.push({ type: 'new-note-focus-after-1s', description: await activeElement(page) });
    test.info().annotations.push({ type: 'new-note-focus-timeline', description: await focusTimeline(page) });
    await title.click();
    await title.fill(TITLE);
    await focused(page).locator('.ProseMirror').first().click();
    await page.keyboard.type(BODY);

    await expect.poll(async () => {
      const notes = await app.call<NoteRow[]>('notes_list', {});
      return notes.find((n) => n.title === TITLE)?.id ?? '';
    }, { message: 'note with the edited title never reached notes_list' }).not.toBe('');
    noteId = (await app.call<NoteRow[]>('notes_list', {})).find((n) => n.title === TITLE)!.id;
    await expect.poll(async () => (await app.call<NoteRow>('notes_get', { id: noteId })).content_md, {
      message: 'edited body was not saved',
    }).toContain(BODY);
    await expect(focused(page).getByText(/已保存|Saved/).first()).toBeVisible();
    expect(describeFailures(collectHealth(app, ['note-edit']))).toBe('');
  });

  test('closing and reopening the note shows the saved body', async () => {
    const { page } = app;
    await app.mark('note-reopen');
    await focused(page).getByRole('button', { name: new RegExp(`关闭 ${TITLE}|Close ${TITLE}`) }).click();
    await expect(focused(page).locator('.ProseMirror')).toHaveCount(0);
    await focused(page).getByText(TITLE).first().click();
    await expect(focused(page).locator('.ProseMirror').first()).toHaveText(BODY);
    await expect(focused(page).getByRole('textbox', { name: /笔记标题|Note title/ })).toHaveValue(TITLE);
    expect(describeFailures(collectHealth(app, ['note-reopen']))).toBe('');
  });

  test('after a relaunch on the same data the note opens with the same content', async () => {
    await app.close();
    app = await launchApp({ root });
    const { page } = app;
    await waitForBridge(page);
    await app.call('plugin:host|status', {}, 90_000);
    const stored = await app.call<NoteRow>('notes_get', { id: noteId });
    expect(stored.title).toBe(TITLE);
    expect(stored.content_md.trim()).toBe(BODY);

    await app.mark('note-relaunch');
    // The empty-desktop tour returns on every launch until "不再显示"; dismiss it like a user would.
    const skip = page.getByTestId('wb-empty-tour-skip');
    if (await skip.isVisible({ timeout: 5_000 }).catch(() => false)) await skip.click();
    await openNotesApp(page);
    await focused(page).getByText(TITLE).first().click();
    await expect(focused(page).locator('.ProseMirror').first()).toHaveText(BODY);
    expect(describeFailures(collectHealth(app, ['note-relaunch']))).toBe('');
  });

  test('a new note keeps keyboard focus in its title, so typing right away names it', async () => {
    const { page } = app;
    await app.mark('note-title-focus');
    const openTitle = focused(page).getByRole('textbox', { name: /笔记标题|Note title/ }).filter({ visible: true });
    await expect(openTitle).toHaveValue(TITLE);
    // With notes in the library the empty-state button is gone; the explorer's 新建 menu creates the note.
    await focused(page).getByRole('button', { name: '新建', exact: true }).click();
    await recordFocus(page);
    await focused(page).getByRole('menuitem', { name: '新建笔记', exact: true }).click();
    const title = focused(page).getByRole('textbox', { name: /笔记标题|Note title/ }).filter({ visible: true });
    await expect(title).not.toHaveValue(TITLE);
    await expect(focused(page).locator('.ProseMirror').filter({ visible: true })).toBeVisible();
    await page.waitForTimeout(1_000);
    test.info().annotations.push({ type: 'title-focus-timeline', description: await focusTimeline(page) });
    await expect(title).toBeFocused();
    await page.keyboard.type(TYPED_TITLE);
    await expect(title).toHaveValue(TYPED_TITLE);
    expect(describeFailures(collectHealth(app, ['note-title-focus']))).toBe('');
  });
});
