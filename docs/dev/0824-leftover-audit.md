# 0824 leftover 审计（第九轮）

日期：2026-08-25

## 结论

- 对比目标：`origin/cursor/0824-cde6` @
  `6e1aec786cf4d0a2437c6d97bd35152fb0159986`。该基线已含 A、H、B、D 和
  F；F 通过 `0a0a1197168a728702ef3d59e2e4c548d00c8feb` 合入。
- 复查来源：`origin/cursor/0824-leftovers-safe-cde6` @
  `bfb52a9ea16d1e666c6ee7cb24edadcf1fba56c1`。原 24 个 INCLUDE 中，23 个
  patch-id 在新基线中仍不存在；`10f1ad162fa5d14885753915fe635e75ef788d7b`
  虽然 patch-id 不同，但唯一生产语义（qbank 批量删除在 headless/无人值守
  下禁用）已由 F 带入的
  `f32d820a356e542537e8839dac984dedeb742157` 覆盖，故改列
  `ALREADY_IN_0824_PLUS_F`。
- 分支仍为 `cursor/0824-leftovers-safe-cde6`。合并最新 0824 时，qbank
  源码与契约测试取 F 版本，令旧重放
  `4e0bb0e1387b829d67d2c04f312e79f401fdcf86` 对最终树零净影响。相对
  `6e1aec786cf4d0a2437c6d97bd35152fb0159986`：
  - H cache 链路文件零触碰；
  - A 的 vitest 四分片、`--logHeapUsage` 和 job 级 4096 MiB 配置保留；
  - B 的 cloud/sync 代码与 CI 修复保留；
  - D 的 flashcard-preview 仅展示语义保留：没有恢复
    `save-to-library` handler、文案或 locale key。
- 原 39 个 clean 候选处置总计：**INCLUDE 23 /
  ALREADY_IN_0824_PLUS_F 7 / DROP 9**。此外保留 safe 分支上的 1 个独立编译
  修复 `bfb52a9ea16d1e666c6ee7cb24edadcf1fba56c1`。下表逐 SHA 记录，无未分类项。

## 完整 SHA 处置表（39 个）

### INCLUDE（23 个）

| 原 clean SHA | safe SHA | 处置 | 主题 |
|---|---|---|---|
| `b8cec84206f807d6a0b6dced1591da95144ccf98` | `eb5279b469986de67a3a4638bdb3729eeb8d642c` | INCLUDE | matchMedia 测试设置 |
| `a10da59d948963b50b92a0c2f43cad867a598385` | `814d0a28f90354d092754e15bdd1a23231f570ca` | INCLUDE | note-edit 禁止 regex 转发 HITL |
| `6047ef94e5637d678fbbd090307c66d0d9050029` | `1bff7e7ded9419ce3c58a55bac40f114a62fae8a` | INCLUDE | Rust noteEdit 256 KiB 上限 |
| `ef74bf726fbe762f0a6cc86b6781a381fc656d01` | `ec3fea5dab4818f697b9715ff075b9089c135973` | INCLUDE | Rust noteEdit 字段白名单 |
| `703cf00a4257a38dbf8c03c5108fff3dbec28f8c` | `eae6f682d692202a6da16d765df881261cb2070e` | INCLUDE | TS/Rust researchSessionId 清洗 |
| `be793515b03cba6f6d5f83ff5adbe195e700724a` | `ed71df1bcb5fdb432dd977ad35f7dbbb03f11a6e` | INCLUDE | 拒绝超 256 KiB 完整 intent |
| `ba64fda19d765f2d011fc1be2d101f82d2f2d3c3` | `99740c0b115fc394ff83320c714dbeb015316d7b` | INCLUDE | stream-cap 错误分类 |
| `3422f2120729f40bbffe74f6fda72808a1fa8b48` | `50f065aaea8d721b355c94580d62b437f9146daf` | INCLUDE | Rust/lint/vitest 修复 |
| `74444f6b1f5043b453315cb780a43ada18d7618b` | `fa6fb8cdf0966c1663c5e14fc3828abe6dc996a4` | INCLUDE | sessionId 契约与 sanitizer |
| `d71366980f19c1b7aeebd3e927aab93c5511f7bf` | `2fb56ffb96b79f156b61e0d9659cf8775ffa68b0` | INCLUDE | HPIAS session 隔离与 host action |
| `e780db9eac27e7ce3f77f5e3485ff4624cc9461c` | `ead3276c1f0b3afc4724f89e00ab30c4276147c2` | INCLUDE | research store 忽略外部 session |
| `a6b23b3f5f2ef24d311053d2eb94cc887060b02e` | `54c9ea27889f74f4c1d40cbed248e377e9464e1f` | INCLUDE | 无控制字符字面量的 regex 构造 |
| `a0dd7b9d84d012582f73d6bff6d5fdcd563c8141` | `16e4b3d4ed7904e96d1705c6dc6263578ec7249d` | INCLUDE | 并发 HPIAS session slices |
| `24dbfb426fdcaf5e585f3f9d983eb7b8b6c968bc` | `e85c105153dcd4d65a6d41b61e95e1d99fa3a76f` | INCLUDE | Frontend build 堆上限 |
| `3d8abb3ee7422caff1bb122c513f2781b80edbc2` | `2ded044a421376a13357a0e8993fb6018dc76d7f` | INCLUDE | 单一 HPIAS listener 与 style/srcdoc 清洗 |
| `b868c0ed0cbc6c0426d6a56d67b01565f2774d86` | `db410150b1f34d8267b9b656fb2003e24bb85b69` | INCLUDE | Style Lab reset 保留其他 slices |
| `404646913b0c12d98c256e2e4094929462b1e570` | `d4ba7592f53c8b397e789c207f8dd303a3f5c6d3` | INCLUDE | 隐藏未注册 action + build 6 GiB |
| `039ca5372d5caaad19e05d7c7b5ff7bae0097ad1` | `da087f5aceeb1cb505b369efd92a035ab165f698` | INCLUDE | 跳过空 ActionBar toolbar |
| `9bdf8169d9cbe80aa6e7ebf4349e5ee58554b377` | `5924ce3edd6d056863ec5c10d9832f381d898ad7` | INCLUDE | undo stack 隔离与 skip-link |
| `a39cb125bebe2f2dd0ddff6174dc9c9222ea8029` | `f8a18574778994a8b64067406fdadf93eb10e60a` | INCLUDE | URL 清洗与 briefing defaultValue |
| `92bcb5a523771b6c261a13c807a854a7cacc24ed` | `7632e922583d66dff9cb009797e27c3c24c564c4` | INCLUDE | 隔离外部 session_started |
| `ab485aa14ed489d4550d81eea1335129b3106613` | `7529230d346ec514f0307a4959866f6d0ce84077` | INCLUDE | Rust ingress block allowlist |
| `da42b4980cbab0c4a647d01e5a5e5d0dee8f44f5` | `413b251454925ef1a06451da177a41cc7530a40b` | INCLUDE | Tauri e2e 拒绝未知 block type |

`814d0a28`、`fa6fb8cd`、`2fb56ffb` 因 D 修改了同一技能说明而重新生成
patch；冲突决议只加入各自的 noteEdit/HPIAS 语义，同时保留 D 的
flashcard 仅展示规则。其余 20 项与第六轮 patch-id 等价。

safe 分支另有下列非 clean 候选的必要集成修复：

| safe SHA | 处置 | 主题 |
|---|---|---|
| `bfb52a9ea16d1e666c6ee7cb24edadcf1fba56c1` | INCLUDE | 把 executor mapping 测试移到可编译的 lib target |

### ALREADY_IN_0824_PLUS_F（7 个，不重放）

| clean SHA | 0824+F 对应 SHA | 处置 | 说明 |
|---|---|---|---|
| `10f1ad162fa5d14885753915fe635e75ef788d7b` | `f32d820a356e542537e8839dac984dedeb742157` | ALREADY_IN_0824_PLUS_F | qbank headless 禁令；旧描述适配测试无需保留 |
| `638e13df77e914013ae52c89af4e7f9f4083b514` | `2a0be4e57d0f864b0101decfb32778ab0a63e5af` | ALREADY_IN_0824_PLUS_F | 卡库手动新建与 `.apkg` 导入入口 |
| `1de96c8d44b8c28dd4476acd0b6b2de1b28f5941` | `d813e9e4d3afe898be5fe190d7c7d72dc4abba50` | ALREADY_IN_0824_PLUS_F | pomodoro 宿主存在时隐藏悬浮药丸 |
| `67a5909dccc0aac0a79d0fe5a4a64209d47b670b` | `a9024fc22c3059cd3f14121517a2b213f03a6177` + `f538b5a96c0a2b44e0fe7c4901dde012a7e52749` | ALREADY_IN_0824_PLUS_F | 题库 streak/已答进度 |
| `7b852b437560846d19c38d79fc4712c3705de2eb` | `699bd963ee3484d1e47d0b9360c4f1ae78a8dfe3` | ALREADY_IN_0824_PLUS_F | 删除未渲染 PracticeModeSelector |
| `832edccf85236ee7e02e4db1705dc5c032e38b40` | `450b4443e71743955a890a33ac60cf857114cd25` + `575fee7f475a83de5c0edd3dd378015495fb22ad` | ALREADY_IN_0824_PLUS_F | workbench 壳层交互 |
| `69b96b1fe0efbddf35be244ab5802fce7deca1ab` | `15479c9e79622133f789d709f73625caa58d2114` | ALREADY_IN_0824_PLUS_F | 卡库新入口 i18n key |

### DROP（9 个，不重放）

| clean SHA | 处置 | 原因 |
|---|---|---|
| `e1fa9bcef8f1c7e05ad6685a664623cc14c09858` | DROP | 回退 A parser/CI 编排 |
| `817b9fd5e589ae252168de4f386f4b45135142ae` | DROP | 回退 A 的 5 个测试契约 |
| `e6d1ffdd2c9d5ca3b70bd5de0299c7ad39291462` | DROP | 坏 YAML，且回退 A scrollbar 契约 |
| `9127956c8d39a61a2f23d77f9ac7ca000c98b8e2` | DROP | 回退 A scrollbar/CI，附带失真 round74 断言 |
| `58e4af56c78cac3cfb5b657649694dab936de49c` | DROP | 把 A 的四分片改回八分片 |
| `2fe74ba65c0772c0e4493af800c3e31b33725371` | DROP | 回退 A 的 8 个契约/测试文件 |
| `6c833a7f5de3e3d8d5eb8c2d6cfcc7c93ee3681c` | DROP | 回退 A/D 的 CardAgent 与相关测试决议 |
| `d6e05976784993301a315683052888dac1e9ebf9` | DROP | 过时审计，错误声称 F 缺 6 项 |
| `5a0eab09dca8e4642bb3465d02aa42247582fed6` | DROP | 绑定旧 clean 基线的过时验证 |

## 门禁

| 门禁 | 结果 |
|---|---|
| `npm ci` | ✅ 1192 packages |
| `npm run version:generate && npm run typecheck` | ✅ 0 错误 |
| `npx vite build` | ✅ 1m06s；仅既有循环 chunk / chunk 体积警告 |
| `cargo +stable check --manifest-path src-tauri/Cargo.toml --lib --locked` | ✅ Rust 1.98；0 error，28 个既有 warning |
| 定向 vitest（Generative UI 全目录 + 4 个触及的 skill contract） | ✅ 128 files / 873 tests |

Rust 门禁使用与 CI 一致的 stable 1.98，并安装 Tauri Linux 系统依赖、
`protobuf-compiler` 与 gitignored 的 `libpdfium.so`。下载脚本改写的已跟踪
PDFium license 已恢复，环境产物未进入提交。
