import assert from "node:assert/strict";
import test from "node:test";

import { aboutContent } from "./about-content.ts";

test("captures the requested DeepStudent about metadata", () => {
  assert.equal(aboutContent.name, "DeepStudent");
  assert.equal(aboutContent.release, "0.9.34 (13419)");
  assert.equal(aboutContent.primaryActionLabel, "检查更新");

  assert.deepEqual(aboutContent.developmentRows, [
    {
      label: "开发者",
      value: "DeepStudent Team",
    },
    {
      label: "版本",
      value: "0.9.34 (13419)e6d0421b",
    },
    {
      label: "更新渠道",
      value: "稳定版",
      description: "仅接收经过验证的稳定版更新",
    },
    {
      label: "自动检查更新",
      value: "每次启动时自动检查",
    },
  ]);
});

test("lists the requested licensing, platform, links, and partner acknowledgements", () => {
  assert.deepEqual(aboutContent.details, [
    {
      label: "许可证",
      value: "AGPL-3.0-or-later",
    },
    {
      label: "平台支持",
      value: "Windows / macOS / iPadOS / Android",
    },
  ]);

  assert.deepEqual(
    aboutContent.linkLabels,
    ["访问官网", "GitHub", "反馈 Issue", "查看隐私政策"],
  );

  assert.deepEqual(aboutContent.partner, {
    title: "技术合作伙伴致谢",
    name: "SiliconFlow",
    description:
      "提供多模态与推理模型服务，保障 DeepStudent 在国产算力生态中的高效稳定运行。",
  });
});


test("about content keeps helper types file-local", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./about-content.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /export type AboutRow/u);
  assert.doesNotMatch(source, /export type AboutPartner/u);
});
