import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const threadCanvasPath = path.join(__dirname, "ThreadCanvas.tsx");

test("thread canvas uses a document-style single column with an anchored composer", () => {
  const source = readFileSync(threadCanvasPath, "utf8");

  assert.match(source, /const composerSecondaryControlClassName = "rounded-full border-transparent px-2\.5 text-xs font-normal text-muted-foreground";/u);
  assert.match(source, /import \{ Textarea \} from "@\/components\/ui\/textarea";/u);
  assert.match(source, /ArrowUp/u);
  assert.match(source, /max-w-\[44rem\]/u);
  assert.match(source, /data-slot="thread-empty-state"/u);
  assert.match(source, /data-slot="thread-composer"/u);
  assert.match(source, /aria-label="线程输入"/u);
  assert.match(source, /placeholder="请输入问题"/u);
  assert.match(source, /aria-label="发送消息"/u);
  assert.match(source, /border-composer-border/u);
  assert.match(source, /min-h-\[var\(--composer-min-height\)\]/u);
  assert.match(source, /size="icon"/u);
  assert.match(source, /rounded-full md:h-\[var\(--button-icon-size\)\] md:w-\[var\(--button-icon-size\)\]/u);
  assert.match(source, /Button variant="ghost" size="sm" className=\{composerSecondaryControlClassName\}/u);
  assert.match(source, /开始一个新任务/u);
  assert.doesNotMatch(source, /macOS 工作台|Windows 工作台|桌面工作台/u);
  assert.doesNotMatch(source, /platformLabel/u);
  assert.doesNotMatch(source, /最近变更/u);
  assert.doesNotMatch(source, /完成范围/u);
  assert.doesNotMatch(source, /下一步建议/u);
  assert.doesNotMatch(source, /PaperPlaneTilt/u);
  assert.doesNotMatch(source, /发送<\/Button>/u);
  assert.doesNotMatch(source, /Button variant="ghost" className="text-muted-foreground"/u);
  assert.doesNotMatch(source, /border-t border-border\/60 px-4 py-3/u);
  assert.doesNotMatch(source, /rounded-\[26px\]/u);
  assert.doesNotMatch(source, /rounded-\[24px\]/u);
});

test("thread composer tightens vertical spacing instead of keeping the taller drafting pad", () => {
  const source = readFileSync(threadCanvasPath, "utf8");

  assert.match(source, /className="min-h-\[var\(--composer-min-height\)\] resize-none border-0 bg-transparent px-4 pb-1\.5 pt-3 shadow-none focus-visible:bg-transparent focus-visible:ring-0 md:px-5"/u);
  assert.match(source, /className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2\.5 pt-1 md:px-4"/u);
  assert.doesNotMatch(source, /placeholder="描述你要收敛的布局细节，例如：把设置页改成更窄的偏好设置列，并保持底部输入器安静。"/u);
});

test("thread canvas composer footer shares the same workspace surface token as the right content pane", () => {
  const source = readFileSync(threadCanvasPath, "utf8");

  assert.match(source, /border-t border-\[color:var\(--composer-divider\)\] bg-\[color:var\(--shell-panel-strong\)\] px-4 pb-3 pt-2\.5/u);
  assert.doesNotMatch(source, /border-t border-border\/60 bg-\[color:var\(--shell-panel-strong\)\] px-4 pb-3 pt-2\.5/u);
  assert.doesNotMatch(source, /border-t border-border\/60 bg-background\/96 px-4 pb-3 pt-2\.5/u);
});

test("thread composer keeps the send icon on the quiet E9E9E9 tone until the user types", () => {
  const source = readFileSync(threadCanvasPath, "utf8");

  assert.match(source, /import \{ useState \} from "react";/u);
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

  assert.match(source, /<h2 className="text-balance text-xl font-medium text-foreground">开始一个新任务<\/h2>/u);
  assert.match(source, /text-pretty text-sm leading-6 text-muted-foreground/u);
  assert.doesNotMatch(source, /<h2 className="text-xl font-semibold text-foreground">开始一个新任务<\/h2>/u);
});
