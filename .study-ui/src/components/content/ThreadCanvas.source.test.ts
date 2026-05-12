import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const threadCanvasPath = path.join(__dirname, "ThreadCanvas.tsx");
const oldThreadContentPaddingPattern = new RegExp(["px-4 pb-6 pt-3", "md:px-8"].join(" "), "u");
const oldThreadComposerPaddingPattern = new RegExp(["px-4 pb-3 pt-2.5", "md:px-8"].join(" "), "u");

test("thread canvas uses a document-style single column with an anchored composer", () => {
  const source = readFileSync(threadCanvasPath, "utf8");

  assert.match(source, /const composerSecondaryControlClassName = "rounded-full border-transparent px-2\.5 text-xs font-normal text-muted-foreground";/u);
  assert.match(source, /import \{ Textarea \} from "@\/components\/ui\/textarea";/u);
  assert.match(source, /ArrowUp/u);
  assert.match(source, /Plus/u);
  assert.match(source, /data-slot="thread-content-shell"/u);
  assert.match(source, /data-slot="thread-content-column"/u);
  assert.match(source, /data-slot="thread-empty-state"/u);
  assert.match(source, /data-slot="thread-empty-workspace"/u);
  assert.match(source, /data-slot="thread-empty-primary-action"/u);
  assert.match(source, /data-slot="thread-composer-shell"/u);
  assert.match(source, /data-slot="thread-composer-column"/u);
  assert.match(source, /data-slot="thread-phone-composer"/u);
  assert.match(source, /data-slot="thread-composer"/u);
  assert.match(source, /maxWidth: "var\(--workspace-max-width\)"/u);
  assert.match(source, /maxWidth: "var\(--composer-max-width\)"/u);
  assert.match(source, /aria-label="线程输入"/u);
  assert.match(source, /placeholder="询问 DeepStudent"/u);
  assert.match(source, /placeholder="请输入问题"/u);
  assert.match(source, /aria-label="发送消息"/u);
  assert.match(source, /border-composer-border/u);
  assert.match(source, /min-h-\[var\(--composer-min-height\)\]/u);
  assert.match(source, /size="icon"/u);
  assert.match(source, /shrink-0 rounded-full lg:h-\[var\(--button-icon-size\)\] lg:w-\[var\(--button-icon-size\)\]/u);
  assert.doesNotMatch(source, /md:h-\[var\(--button-icon-size\)\]/u);
  assert.match(source, /Button variant="ghost" size="sm" className=\{composerSecondaryControlClassName\}/u);
  assert.match(source, /在「分组名」里学点什么？/u);
  assert.match(source, /当前工作区：<code className="font-medium text-foreground">study-ui<\/code>/u);
  assert.doesNotMatch(source, /把需求直接发到底部输入区。/u);
  assert.doesNotMatch(source, /首屏保持安静，只保留当前工作区、主动作和足够的留白。/u);
  assert.doesNotMatch(source, /开启新的学习任务/u);
  assert.doesNotMatch(source, /查看建议起点/u);
  assert.doesNotMatch(source, /MagicWand/u);
  assert.doesNotMatch(source, /Sparkle/u);
  assert.doesNotMatch(source, /升级|用户\+/u);
  assert.doesNotMatch(source, /max-w-\\?\[44rem\\?\]/u);
  assert.doesNotMatch(source, /macOS 工作台|Windows 工作台|桌面工作台/u);
  assert.doesNotMatch(source, /platformLabel/u);
  assert.doesNotMatch(source, /最近变更/u);
  assert.doesNotMatch(source, /完成范围/u);
  assert.doesNotMatch(source, /下一步建议/u);
  assert.doesNotMatch(source, /PaperPlaneTilt/u);
  assert.doesNotMatch(source, /Microphone/u);
  assert.doesNotMatch(source, /aria-label="语音输入"/u);
  assert.doesNotMatch(source, /发送<\/Button>/u);
  assert.doesNotMatch(source, /Button variant="ghost" className="text-muted-foreground"/u);
  assert.doesNotMatch(source, /border-t border-border\/60 px-4 py-3/u);
  assert.doesNotMatch(source, /rounded-\[26px\]/u);
  assert.doesNotMatch(source, /rounded-\[24px\]/u);
  assert.doesNotMatch(source, /mobilePromptCards/u);
  assert.doesNotMatch(source, /data-slot="thread-mobile-prompt-strip"/u);
  assert.doesNotMatch(source, /拆解任务|整理资料|生成计划|复盘重点/u);
});

test("thread canvas uses one quiet responsive landing across phone tablet and desktop", () => {
  const source = readFileSync(threadCanvasPath, "utf8");
  const emptyStart = source.indexOf('data-slot="thread-empty-state"');
  const phoneComposerStart = source.indexOf('data-slot="thread-phone-composer"');

  assert.notEqual(emptyStart, -1);
  assert.notEqual(phoneComposerStart, -1);
  assert.ok(emptyStart < phoneComposerStart);
  assert.doesNotMatch(source, /data-slot="thread-mobile-empty-state"/u);

  const emptyBlock = source.slice(emptyStart, phoneComposerStart);
  assert.match(emptyBlock, /className="flex min-h-full w-full flex-col items-center justify-center px-2 pb-16 pt-10 text-center sm:pb-20 md:pt-16"/u);
  assert.match(emptyBlock, /max-w-\[24rem\]/u);
  assert.match(emptyBlock, /data-slot="thread-empty-workspace"/u);
  assert.match(emptyBlock, /当前工作区：<code/u);
  assert.match(emptyBlock, /study-ui/u);
  assert.match(emptyBlock, /data-slot="thread-empty-primary-action"/u);
  assert.match(emptyBlock, /在「分组名」里学点什么？/u);
  assert.doesNotMatch(emptyBlock, /把需求直接发到底部输入区。/u);
  assert.doesNotMatch(emptyBlock, /查看建议起点|开启新的学习任务|Sparkle|MagicWand/u);
});

test("thread canvas uses a phone-only pill composer while preserving the existing tablet desktop composer", () => {
  const source = readFileSync(threadCanvasPath, "utf8");
  const phoneComposerStart = source.indexOf('data-slot="thread-phone-composer"');
  const desktopComposerStart = source.indexOf('data-slot="thread-composer"');

  assert.notEqual(phoneComposerStart, -1);
  assert.notEqual(desktopComposerStart, -1);
  assert.ok(phoneComposerStart < desktopComposerStart);

  const phoneComposerBlock = source.slice(phoneComposerStart, desktopComposerStart);
  assert.match(phoneComposerBlock, /className="flex min-h-14 items-center gap-1 rounded-full border border-composer-border bg-card px-2/u);
  assert.match(phoneComposerBlock, /sm:hidden/u);
  assert.match(phoneComposerBlock, /aria-label="添加附件"/u);
  assert.doesNotMatch(phoneComposerBlock, /aria-label="语音输入"/u);
  assert.doesNotMatch(phoneComposerBlock, /Microphone/u);
  assert.match(phoneComposerBlock, /placeholder="询问 DeepStudent"/u);
  assert.match(phoneComposerBlock, /rows=\{1\}/u);
  assert.match(phoneComposerBlock, /className="h-11 w-11 rounded-full"/u);
  assert.match(phoneComposerBlock, /className=\{cn\(\s*"h-11 w-11 shrink-0 rounded-full"/u);

  const desktopComposerBlock = source.slice(desktopComposerStart);
  assert.match(desktopComposerBlock, /className="hidden overflow-hidden rounded-3xl border border-composer-border/u);
  assert.match(desktopComposerBlock, /sm:block/u);
  assert.match(desktopComposerBlock, /placeholder="请输入问题"/u);
  assert.match(desktopComposerBlock, /data-slot="thread-composer-secondary-actions"/u);
});

test("thread composer tightens vertical spacing instead of keeping the taller drafting pad", () => {
  const source = readFileSync(threadCanvasPath, "utf8");

  assert.match(source, /className="min-h-\[var\(--composer-min-height\)\] resize-none border-0 bg-transparent px-4 pb-1\.5 pt-3 shadow-none focus-visible:bg-transparent focus-visible:ring-0 md:px-5"/u);
  assert.match(source, /className="flex items-center gap-2 px-3 pb-2\.5 pt-1 md:px-4"/u);
  assert.match(source, /data-slot="thread-composer-secondary-actions"/u);
  assert.match(source, /className="flex min-w-0 flex-1 flex-wrap items-center gap-2"/u);
  assert.doesNotMatch(source, /placeholder="描述你要收敛的布局细节，例如：把设置页改成更窄的偏好设置列，并保持底部输入器安静。"/u);
});

test("thread canvas composer footer shares the same workspace surface token as the right content pane", () => {
  const source = readFileSync(threadCanvasPath, "utf8");

  assert.match(source, /bg-transparent sm:border-t sm:border-\[color:var\(--composer-divider\)\] sm:bg-\[color:var\(--shell-panel-strong\)\]/u);
  assert.match(source, /paddingBottom: "var\(--composer-bottom-offset\)"/u);
  assert.doesNotMatch(source, /border-t border-border\/60 bg-\[color:var\(--shell-panel-strong\)\] px-4 pb-3 pt-2\.5/u);
  assert.doesNotMatch(source, /border-t border-border\/60 bg-background\/96 px-4 pb-3 pt-2\.5/u);
});

test("thread canvas consumes shared layout and safe-area tokens instead of desktop padding constants", () => {
  const source = readFileSync(threadCanvasPath, "utf8");

  assert.match(source, /paddingTop: "var\(--page-gutter-block\)"/u);
  assert.match(source, /paddingBottom: "var\(--page-gutter-block\)"/u);
  assert.match(source, /paddingLeft: "calc\(var\(--page-gutter-inline\) \+ var\(--layout-safe-area-left\)\)"/u);
  assert.match(source, /paddingRight: "calc\(var\(--page-gutter-inline\) \+ var\(--layout-safe-area-right\)\)"/u);
  assert.match(source, /paddingBottom: "var\(--composer-bottom-offset\)"/u);
  assert.doesNotMatch(source, oldThreadContentPaddingPattern);
  assert.doesNotMatch(source, oldThreadComposerPaddingPattern);
});

test("thread composer keeps the send icon on the quiet E9E9E9 tone until the user types", () => {
  const source = readFileSync(threadCanvasPath, "utf8");

  assert.match(source, /import \{ type CSSProperties, useState \} from "react";/u);
  assert.match(source, /import \{ cn \} from "@\/lib\/utils";/u);
  assert.match(source, /const \[draftMessage, setDraftMessage\] = useState\(""\);/u);
  assert.match(source, /const isComposerEmpty = draftMessage\.trim\(\)\.length === 0;/u);
  assert.match(source, /value=\{draftMessage\}/u);
  assert.match(source, /onChange=\{\(event\) => setDraftMessage\(event\.target\.value\)\}/u);
  assert.match(source, /isComposerEmpty && ".*text-\[color:var\(--interactive-selected\)\].*"/u);
});

test("thread composer also pulls the send button background into a gray quiet state when empty", () => {
  const source = readFileSync(threadCanvasPath, "utf8");

  assert.match(source, /isComposerEmpty && "border-transparent bg-muted-foreground hover:bg-muted-foreground\/90 active:bg-muted-foreground\/85 text-\[color:var\(--interactive-selected\)\]"/u);
});

test("thread composer lifts with a subtle shadow when any control inside it receives focus", () => {
  const source = readFileSync(threadCanvasPath, "utf8");

  assert.match(source, /transition-shadow duration-150 ease-out motion-reduce:transition-none focus-within:\[box-shadow:var\(--shadow-composer-focus\)\]/u);
});

test("thread canvas hero title stays aligned with the lighter app typography scale", () => {
  const source = readFileSync(threadCanvasPath, "utf8");

  assert.match(source, /<h2[\s\S]*data-slot="thread-empty-primary-action"[\s\S]*className="text-balance text-2xl font-semibold tracking-\[-0\.04em\] text-foreground sm:text-xl sm:font-medium sm:tracking-normal"[\s\S]*在「分组名」里学点什么？[\s\S]*<\/h2>/u);
  assert.doesNotMatch(source, /text-pretty text-base leading-7 text-muted-foreground sm:text-sm sm:leading-6/u);
  assert.doesNotMatch(source, /<h2 className="text-xl font-semibold text-foreground">今天想学点什么？<\/h2>/u);
});
