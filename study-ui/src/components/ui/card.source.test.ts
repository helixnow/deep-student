import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cardPath = path.join(__dirname, "card.tsx");

test("card surfaces stay nearly opaque with restrained blur", () => {
  const source = readFileSync(cardPath, "utf8");

  assert.match(source, /bg-card\/96/u);
  assert.doesNotMatch(source, /backdrop-blur/u);
});
