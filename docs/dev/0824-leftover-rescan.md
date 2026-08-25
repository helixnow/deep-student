# 0824 open PR leftover 重扫

扫描快照：2026-08-25 11:18 UTC
固定基线：`origin/cursor/0824-cde6` @
`30fc858baa54685a9fa62959d50a2b0fc6100da3`
隔离分支：`cursor/0824-leftover-rescan-cde6`

## 结论

本轮有新 INCLUDE，来源是 Step 19 后仍 open 的三个发布隔离头：

- #318：升级路径 i18n 与 `dstu-auto-sync` hydration；
- #319：`notes.props` 迁移、metadata 原子 CAS 与属性搜索分页；
- #320：Chat/GenUI 升级边界。

此外，`cursor/0824-fix-integration-cde6` 的 `ef6aeaab` 是明确、小且安全的
遗漏测试。本隔离枝已将它移植为 `199b3377`，定向 Vitest 为 2 files /
10 tests 全绿。

不要整支 merge #318/#319/#320。#318/#320 的 merge-base 仍是
`427c775f`，会带回旧集成树；#319 虽已合入 `30fc858b`，其
`coordinator.rs` 仍需在回收时加法式保留 Step 19 的
`apply_vfs_init_missing_tables`。

## 方法与证据

1. 用 `gh pr list --state open --limit 500` 固定 open PR 清单，并 fetch
   `refs/pull/158..320/head` 及 `cursor/0824-fix-integration-cde6`。
2. 对每个可能含产品或测试的头执行
   `git log origin/cursor/0824-cde6..HEAD` 和
   `git cherry origin/cursor/0824-cde6 HEAD`。`git cherry` 使用稳定
   patch-id 判定内容等价；对非等价提交再核对变更文件与当前树实现。
3. #314 因适配落地而 patch-id 不同，另用 `git range-diff
   ef991061^! 0105a7eb^!` 核对；差异只在同一 migration fixture 同时容纳
   Step 19 的 llm_usage 迁移，Anki 产品语义已吸收。

关键头的 `git cherry` 结果：

| 头 | tip | merge-base | `+` | `-` | 判定 |
|---|---|---|---:|---:|---|
| #177 | `89808fd8` | — | 0 | 14 | ALREADY，内容等价 |
| #318 | `a6e2621b` | `427c775f` | 6 | 0 | INCLUDE：5 产品/测试 + 1 docs |
| #319 | `13d45b0a` | `30fc858b` | 4 | 0 | INCLUDE：3 产品/测试 + 1 docs |
| #320 | `8e6d8e8f` | `427c775f` | 2 | 0 | INCLUDE：2 产品/测试 |
| fix-integration | `ef6aeaab` | `e88340c6` | 1 | 0 | INCLUDE，已移植 |

## INCLUDE 清单

### #318 — i18n / auto-sync

建议按最终文件状态适配或 squash 到 `30fc858b`，不要整支 merge。

| 源 SHA | stable patch-id | 理由 |
|---|---|---|
| `401578486ec64b469e62ba8f234df9054e3a0b16` | `a1d480d250b44ea37057853c88ae13b029242427` | 把升级后无效的 i18n 路径改到现有双语 key，并增加 release key 契约 |
| `b62463823ea137fc397c917890dfc298f4a722e9` | `1e5b8e1a019064c9ff39f1dff40f1ae21a49d736` | 丢弃畸形 `dstu-auto-sync` JSON，且对 current-version 脏字段消毒后再 hydration |
| `3db6bfecd0bac9efb1370a219c036da3b1e1b4f8` | `e8dba55f81ec22c0a57209b105d6d5573862132b` | 修正 sidebar key 到现有 `navigation` 分组 |
| `ff151fa40f623f327f773ae8a0b16b0bd7ff1098` | `e5c9c007761bac930a0698c1777d73f7d517defc` | 将 note tag 失败提示收敛到最终存在的 `notifications` key |

`af6078a8d9030b35ac992b44b7289f92f2e7a773`
（patch-id `c4892a66…`）只是 `40157848` 到 `ff151fa4` 之间的中间 key，
最终状态已被 `ff151fa4` 覆盖；逐提交 cherry-pick 时可按原顺序经过它，
最终回收清单不把它视为独立产品价值。`a6e2621b` 仅为该枝说明文档。

### #319 — VFS `notes.props`

| 源 SHA | stable patch-id | 理由 |
|---|---|---|
| `b3ce56cd24a860ae21d1fe9b4785fabada6dc3c8` | `a5d694309a66445588b45826f606df60f3337bb7` | 收敛 `V20260824__note_props` 重跑/registry gap；统一 NULL/`{}`；metadata 一次 CAS；明确 props 行级 LWW；下推 Unicode `key:value` 属性过滤 |
| `028a2a62976a3e9599ed74245c0e9b58c04aa8f7` | `09989af3ea3a1dfe0017afc1b5467457c7403453` | v0.9.44 fixture 按 migration version 排序重放，避免依赖 embed 原始顺序 |
| `4759bd0c32e8313474ce146f306e5e8f05c2abda` | `1f42a1173dac5c548f533ea0ddf9b4d8322792c0` | 部分 metadata 更新不再回写未提供列；folder/type/props 在 limit/offset 前过滤，避免漏掉后页匹配笔记 |

`13d45b0a` 仅为说明文档；分支内合并提交也不是回收单元。

### #320 — Chat / Generative UI

| 源 SHA | stable patch-id | 理由 |
|---|---|---|
| `6c9a231ffe3f482717e158d75961a14ddcd79931` | `80e05f3640aee182d1d8ef92c87556d9e9acb9dd` | scoped HPIAS 对缺失/畸形 `session_id` fail-closed；v1→v1.1 intent 深拷贝且保留扩展字段；`guardedListen` 精确 allowlist；补 active InputBar 与 i18n 契约 |
| `8e6d8e8f994bc28db386c1f854f9342645f4ce93` | `2b171d27643850ca1b03cbe50aaff9d1edbdd590` | 将 HPIAS allowlist 契约从源码字符串检查改为真实行为检查 |

### 独立遗漏测试

| 源 SHA | 本枝 SHA | stable patch-id | 理由 |
|---|---|---|---|
| `ef6aeaab5c39ed5aaa7cda38fd004dcf8d00df91` | `199b3377` | `61087d949b15ef32b3f18a200051d214bc634348` | 钉住划词/笔记/作文共用 CardForge、`ChatV2AnkiAdapter` 不复活，以及 PDF 四个移动 tab 的 44px coarse-pointer 触控目标 |

验证：

```text
✓ cardGenerationSurfaces.source.test.ts  6 tests
✓ pdfMobilePanelTabs.source.test.ts       4 tests
Test Files 2 passed; Tests 10 passed
```

## ALREADY / DROP

### Open PR #158–#268

逐头重算后的结论与 `188500e0` 那轮审计一致；基线后来只增加了吸收项，
没有旧头从 ALREADY/DROP 反向变成 INCLUDE。

- **ALREADY**：#159–#169（#170 除外）、#171–#197、#199、
  #201–#202、#204–#208、#210–#212、#215–#268（#218 除外）。
  其中 #160 的剩余覆盖已由 `f38d0041` / `41587d48` 适配吸收；
  #177 当前 tip `89808fd8` 为 0 `+` / 14 `-`。
- **DROP**：#158 的 `utf8_stream` 删除会破坏当前调用；#170 的
  mythos-5；#198 的 200MB 语义；#200 的旧 token stripping；#203/#209
  的旧树断言；#218 的退役 hunyuan 契约。
- **#213**：parser 已在官方树，剩余按既定结论 DROP，不重放整枝。
- **#214**：安全 GenUI/HPIAS 能力已由主题合流和后续适配吸收；旧 CI/
  历史提交 DROP，整枝不 merge。

### 主题仓与 0824 隔离/预演枝

- E/C/H/A/B/D/F/G 的产品内容均已合。open 的 #270（C）产品提交全部
  patch 等价；#271（E）只剩 docs；#275（B）唯一代码差异
  `f41e5fc7` 已被官方更严格的 FTP 550 fail-closed 实现取代。
- #269 就是固定基线。
- #279–#302 是旧 leftovers、主题合流预演或差异文档；来源产品已在官方树，
  不构成独立 INCLUDE。
- #303 的 #160 测试/样式已由 `f38d0041` / `41587d48` 吸收；#304 的
  加法测试已由 `08b81e29` 吸收；#305–#308 为验证/审计文档。
- #309 的 GenUI skill i18n 已以 `414abdc7` 吸收；#310–#312 只剩验证
  文档，其测试提交已 patch 等价。
- #313：`9176740b` / `0a6344e1` 已分别适配落为 `e24b828d` /
  `67a7fdf8`。
- #314：`ef991061` 已适配落为 `0105a7eb`；不是同 patch-id，但
  `range-diff` 证明产品语义已覆盖。
- #315：restore 三个代码提交已等价落为 `1df0ec6a` / `6cfabf67` /
  `d7fb7677`，并有 `1119f9be` 收尾。
- #316 `3d3516c3`、#317 `c4a3382c` 已分别等价落为 `5f324e1f`、
  `920dd665`。

因此，除上列 #318/#319/#320 与已落到本隔离枝的 `ef6aeaab` 测试外，
本次 open PR / 主题枝重扫没有其他产品或测试 INCLUDE。
