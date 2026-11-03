# 最终审阅、真实模型与 Android 验收实施计划

> 用户于 2026-11-03 通过 ExitPlanMode 批准。执行：子 agent 探索／测试编写／修改，主 agent 审查并亲自运行验收。下方为批准时原始任务文本，当前完成状态和追加缺陷闭环见 [closure-progress](closure-progress.md) 与 [closure-results](verification/closure-results.md)，不以原复选框判定当前未实施。

## Context

平台无关实现已完成。本轮新增授权：修复测试失败、最终审阅、本地提交、真实模型验收、先安卓虚拟机再按官方流程构建 ARM64 测试 APK。沿用 feat/handwriting-annotation-chat 和集中记录，不重做旧任务。

**Goal:** 交付有源码 SHA、校验和与明确验证边界的本地提交及测试 APK。
**Architecture:** 使用现有真实 Tauri Chat／Ink／VFS 路径；仅增加必要测试保护，不以 mock 替代真实模型或 Android。
**Tech Stack:** React／Tauri／Rust／既有 Android SDK、NDK、Gradle、pdfium。
**Spec:** design.md、implementation-plan.md；本轮批准方案见本文件和 closure-progress.md。

## Global Constraints

- 当前视觉模型，不更换供应商；最多20次实际模型请求，包含续轮、失败及重试；先验证发送前硬限额。
- 只使用自建夹具，无个人资料外发，不记录密钥、完整配置或网络请求体。
- 本地提交，不推送、PR、合并或发布。主 agent 独占验收与 commit，子 agent 不再派生。
- 保留旧现场，不清理工作区、不改ignore、不force-add。日志、APK、密钥、生成目录不入Git。
- 所有记录保存在本目录；原有功能不缩减。实质修复先见RED再GREEN。

## Task 1 — 最终审阅与已知门禁

- [ ] 实际git inventory、完整diff和untracked审阅；主agent核对高风险调用链。
- [ ] 重跑phase5_tool_execution_e2e，依据ACR4.0将过时ai断言改为agent，完整重跑并检查后续失败。
- [ ] 迁移静态门禁先失败，再用既有check-migrations --update加入三项新迁移，核对旧SQL/hash不变。
- [ ] 回归domainEvents、迁移脚本测试、Rust迁移；记录准确退出码。

Files: src-tauri/tests/phase5_tool_execution_e2e.rs、src-tauri/migrations/migration-lock.json、必要的定向回归测试。

## Task 2 — 真实模型

- [ ] 复用真实Tauri主WebView、uiAutomationBridge／ds-test与chat_v2_send_message。
- [ ] 网络发送前锁定当前视觉模型／供应商和20次实际请求，禁用背景模型任务；无现成机制则局部开发保护，先loopback证明21次拒绝且不泄露正文／凭据。
- [ ] 无批注负对照、真实编辑器笔迹／圈画、问AI附件与ink_get→ink_render；不在提示词／工具摘要泄露答案。
- [ ] 按额度覆盖识别复测、只读revision、历史快照、AI形状批注／回显／可信撤销／导出。每项逐次记录，未覆盖不假称通过。
- [ ] 仅输出配置ID/模型/能力及测试会话、artifact/hash、回答和usage；恢复临时设置。

主要路径: src/dev/uiAutomationBridge.ts、scripts/dev/ds-test.mjs、dstu-llm/src/llm_manager/model2_pipeline.rs、ink_bridge.rs、ink_executor.rs。

## Task 3 — Android模拟器

- [ ] 验证工具链/KVM；保留既有AVD及应用数据、不卸载绕过证书冲突。
- [ ] 官方受控原生文件初始化，同features构建x86_64诊断包；补齐并验证x86_64 pdfium，不能静默缺PDF。
- [ ] API36优先、条件允许API24；实际WebView启动、书写／多页／橡皮／undo／touch／保存重开／后台及进程重启／图片PDF／问AI附件／PNG/PDF导出。
- [ ] 发现缺陷测试→主agentRED→修复→主agentGREEN。截图与限定logcat记录，不等于真机压感／手掌误触／性能验收。

## Task 4 — 冻结回归与本地提交

- [ ] 完整前端四片、Ink浏览器CT、type/lint/ratchet/layers/i18n/license/build。
- [ ] 稳定Rust库、Agent/app/ACL/Phase5、迁移门禁、fmt/clippy correctness。
- [ ] 主agent审阅显式staged文件、敏感信息及完整性，Conventional Commit本地提交，不推送。更新集中验收，保留旧失败历史。

## Task 5 — 官方流程ARM64测试APK

- [ ] 模拟器通过后，源码先提交；Rust1.98.1/NDK29.0.13846066/SDK36，披露本机JDK21与CI17差别。
- [ ] 复用reusable-build-android.yml的受控Manifest/Kotlin/FileProvider/图标/Bilibili/pdfium同步、prepare-android-gradle.mjs与release profile。
- [ ] npx tauri android build --target aarch64 --apk --ci --features mobile-slim -- --locked --no-default-features。
- [ ] 独立测试keystore、zipalign -P16、apksigner verify；ABI/versionCode/权限/native库/16KiB/体积护栏。
- [ ] build-android下APK和SHA256/build-info，区别x86_64诊断包与ARM64交付包，不入Git，不声称测试证书可覆盖正式版。

## Verification

主agent实际运行；新回归先RED后GREEN。原始日志存verification；可提交Markdown记录命令、退出码、数量、模型次数与结果、模拟器与APK身份。不叠加重叠测试数，不把skipped/ignored或构建成功算为运行验收。
