import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const demoSectionsPath = path.join(__dirname, "settings-demo-sections.tsx");

test("demo sections use the same bordered material language as real pages", () => {
  const source = readFileSync(demoSectionsPath, "utf8");

  assert.match(source, /const surfaceBorderClassName = "border-border\/70";/u);
  assert.match(source, /const demoShellPreviewClassName = "overflow-hidden rounded-3xl border border-shell-rim\/70 bg-shell-panel\/92 shadow-sm shadow-black\/5";/u);
  assert.doesNotMatch(source, /rounded-\[(24px|26px|28px|32px)\]/u);
  assert.doesNotMatch(source, /backdrop-blur-xl/u);
  assert.doesNotMatch(source, /bg-secondary\/70/u);
  assert.doesNotMatch(source, /bg-card\/98/u);
});

test("state regression section uses settings-style containers and avoids demo-only hover overrides", () => {
  const source = readFileSync(demoSectionsPath, "utf8");
  const stateRegressionSectionSource =
    source.match(/export function StateRegressionSection[\s\S]*?\n\}\n\nexport function ButtonSection/u)?.[0] ?? "";

  assert.match(source, /const stateRegressionFrameClassName =\s+"overflow-hidden rounded-2xl border border-border\/70 bg-background\/94 shadow-sm shadow-black\/5"/u);
  assert.match(source, /const stateRegressionPanelClassName =\s+"rounded-xl border border-border\/70 bg-background\/92 p-4"/u);
  assert.match(source, /const stateRegressionTileClassName =\s+"rounded-xl border border-border\/60 bg-secondary\/78 px-4 py-3"/u);
  assert.match(stateRegressionSectionSource, /stateRegressionFrameClassName/u);
  assert.match(stateRegressionSectionSource, /stateRegressionPanelClassName/u);
  assert.doesNotMatch(stateRegressionSectionSource, /demoMaterialWellClassName/u);
  assert.doesNotMatch(stateRegressionSectionSource, /className="bg-primary\/90"/u);
  assert.doesNotMatch(stateRegressionSectionSource, /className="bg-interactive-hover text-foreground"/u);
});

test("typography section uses settings-style panels instead of demo material wells", () => {
  const source = readFileSync(demoSectionsPath, "utf8");
  const typographySectionSource =
    source.match(/export function TypographySection[\s\S]*?\n\}\n\nexport function SwitchSection/u)?.[0] ?? "";

  assert.match(typographySectionSource, /typographyFrameClassName/u);
  assert.match(typographySectionSource, /typographyPanelClassName/u);
  assert.match(typographySectionSource, /typographyTileClassName/u);
  assert.doesNotMatch(typographySectionSource, /demoMaterialWellClassName/u);
  assert.doesNotMatch(typographySectionSource, /demoMaterialPanelClassName/u);
});

test("feedback section uses settings-style panels and a quieter embedded toast preview", () => {
  const source = readFileSync(demoSectionsPath, "utf8");
  const feedbackSectionSource =
    source.match(/export function FeedbackPatternsSection[\s\S]*?\n\}\n$/u)?.[0] ?? "";

  assert.match(feedbackSectionSource, /feedbackFrameClassName/u);
  assert.match(feedbackSectionSource, /feedbackPanelClassName/u);
  assert.match(feedbackSectionSource, /feedbackTileClassName/u);
  assert.match(feedbackSectionSource, /feedbackToastClassName/u);
  assert.doesNotMatch(feedbackSectionSource, /demoToastClassName/u);
});

test("card list item section uses settings-style framing instead of a plain demo card", () => {
  const source = readFileSync(demoSectionsPath, "utf8");
  const cardListItemSectionSource =
    source.match(/export function CardListItemSection[\s\S]*?\n\}\n\nexport function FeedbackPatternsSection/u)?.[0] ?? "";

  assert.match(source, /const showcaseFrameClassName =\s+"overflow-hidden rounded-2xl border border-border\/70 bg-background\/94 shadow-sm shadow-black\/5"/u);
  assert.match(cardListItemSectionSource, /<ShowcaseSection/u);
  assert.match(cardListItemSectionSource, /showcasePanelClassName/u);
  assert.match(cardListItemSectionSource, /showcaseTileClassName/u);
});

test("dialog and sheet sections use shared showcase framing for preview content", () => {
  const source = readFileSync(demoSectionsPath, "utf8");
  const dialogSectionSource =
    source.match(/export function DialogSection[\s\S]*?\n\}\n\nexport function SheetSection/u)?.[0] ?? "";
  const sheetSectionSource =
    source.match(/export function SheetSection[\s\S]*?\n\}\n\nexport function TabsSection/u)?.[0] ?? "";

  assert.match(dialogSectionSource, /<ShowcaseSection/u);
  assert.match(dialogSectionSource, /showcasePanelClassName/u);
  assert.match(sheetSectionSource, /<ShowcaseSection/u);
  assert.match(sheetSectionSource, /showcasePanelClassName/u);
});

test("disabled demos explain why the controls are not interactive", () => {
  const source = readFileSync(demoSectionsPath, "utf8");

  assert.match(source, /当前示例工作区已冻结，所以按钮与输入框仅用于展示禁用态，不支持编辑或触发。/u);
  assert.match(source, /演示区固定沿用最近一次成功同步的启动配置，因此这里暂时锁定为开启。/u);
});
