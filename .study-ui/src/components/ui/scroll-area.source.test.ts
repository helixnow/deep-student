import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readSource(): Promise<string> {
  return readFile(new URL("./scroll-area.tsx", import.meta.url), "utf8");
}

test("ScrollArea imports OverlayScrollbarsComponent from overlayscrollbars-react", async () => {
  const source = await readSource();
  assert.match(source, /from "overlayscrollbars-react"/u);
  assert.match(source, /OverlayScrollbarsComponent/u);
});

test("ScrollArea imports platform + theme utilities from relative paths so the file is portable across builds", async () => {
  const source = await readSource();
  assert.match(source, /from "\.\.\/\.\.\/lib\/scroll-platform"/u);
  assert.match(source, /from "\.\.\/\.\.\/lib\/scroll-theme"/u);
  assert.match(source, /detectScrollPlatform/u);
  assert.match(source, /useScrollbarTheme/u);
});

test("ScrollArea uses React.forwardRef and exposes displayName", async () => {
  const source = await readSource();
  assert.match(source, /React\.forwardRef/u);
  assert.match(source, /ScrollArea\.displayName\s*=\s*"ScrollArea"/u);
});

test("ScrollArea root renders data-slot, data-orientation, data-native-scrollbars", async () => {
  const source = await readSource();
  assert.match(source, /data-slot=\{dataSlot\}/u);
  assert.match(source, /data-orientation=\{orientation\}/u);
  assert.match(source, /data-native-scrollbars="true"/u);
  assert.match(source, /data-native-scrollbars="false"/u);
});

test("ScrollArea native fallback branch uses the scroll-area--native class token", async () => {
  const source = await readSource();
  assert.match(source, /"scroll-area--native"/u);
  assert.match(source, /SCROLL_AREA_NATIVE_CLASS/u);
});

test("ScrollArea OverlayScrollbars component is deferred (React 18 strict-mode safe)", async () => {
  const source = await readSource();
  assert.match(source, /<OverlayScrollbarsComponent[\s\S]+?defer/u);
});

test("ScrollArea JSDoc migration checklist mentions every editor/portal class we must not wrap", async () => {
  const source = await readSource();
  assert.match(source, /Migration checklist/u);
  assert.match(source, /CodeMirror/u);
  assert.match(source, /ProseMirror/u);
  assert.match(source, /Crepe/u);
  assert.match(source, /Radix Dialog/u);
  assert.match(source, /@media print/u);
});

test("ScrollArea public API surfaces the 6 props locked in CONTEXT.md without leaking OverlayScrollbars types", async () => {
  const source = await readSource();
  assert.match(source, /viewportClassName\?:/u);
  assert.match(source, /viewportRef\?:/u);
  assert.match(source, /viewportProps\?:/u);
  assert.match(source, /orientation\?:/u);
  assert.match(source, /scrollHideDelay\?:/u);
  assert.match(source, /trackOffset\?:/u);
  assert.match(source, /nativeScrollbars\?:/u);
  // Implementation-level OverlayScrollbars options must NOT leak into the public interface.
  assert.doesNotMatch(source, /ScrollAreaProps[\s\S]+?options\?:/u);
});
