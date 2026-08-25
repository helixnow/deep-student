# 0824 第八轮预演：F × G（step 5）

## 范围

- 基线：`origin/cursor/0824-cde6` @ `4f05d2272217e91a899ed6261356eea1acafc438`
  （已含 D）。
- F：`575fee7f475a83de5c0edd3dd378015495fb22ad`。
- G：`4ab24435bb998f7d24fed9e80e39746a4f44edb3`。
- 热区参考：
  `origin/cursor/0824-rehearse-step3-fg-cde6` @
  `f0efdfeadffe868f83835cf9f7b056d008ec7705`，以及
  `origin/cursor/0824-rehearse-subapp-mobile-cde6` @
  `67ea40f724de74995b69e35b4c70b9b1eeda9914`。
- 预演分支：`cursor/0824-rehearse-step5-fg-cde6`。
- F 合并提交：`8f995c0e0719fd5817060008e9f1c727638b19af`。
- G 合并提交：`e259e571646a5d6114ecb61c5088ba44c7448e0a`。

本轮只提交并推送预演分支，未改动 `main` 或
`cursor/0824-cde6`。

## 合并顺序与冲突取舍

1. 从最新 0824 建立预演分支，先完整 merge F，再 merge G。
2. F 的子应用、workbench、Finder host store、InputBar、题库和 Anki
   能力作为主体；G 的窄屏、coarse pointer、Android 返回键与可见性守卫按 F
   的新组件边界重放。
3. 复用 step3 FG 与 subapp-mobile 的逐文件热点结论，不把 G 基于旧结构的整文件
   覆盖到 F 上。
4. G 已删除的 legacy notes 组件、reference selector 与对应孤立测试继续删除；
   modify/delete 冲突不复活旧实现。

关键热点保持如下：

- Finder 工具栏保留 F 的 `ResizeObserver` compact 模式；触屏按钮维持紧凑视觉，
  通过伪元素把命中区扩展到至少 44px。
- PDF 保留 F 的统一目录、缩略图、书签与批注侧栏；移动端四个 tab 在 coarse pointer
  下均为至少 44px，并保留隐藏 keep-alive 实例的返回键可见性守卫。
- essay grading 保留 F 的建议应用/撤销状态机，并接入保存笔记与生成卡片能力。
- Finder 使用按宿主隔离的 store 与 active-host 导航；保留
  `useFinderStoreFor`，同时为 F 调用方提供等价的 `useHostFinderStore` 兼容导出。
- qbank tools 恢复已验证的描述和 schema 契约；制卡入口继续使用当前
  `cardAgent.startGeneration` 管线。

## 合并后修复

- `5e01740d`：恢复 FG 响应式编译契约。
- `67b931d8`：对齐聊天画布的 Finder host store API。
- `7a9d8a67`：恢复已验证的 qbank/Finder 合同，并移除断言旧 Finder 语义的重复测试。
- `087148fe`：补回 F 调用方所需的 Finder host store 兼容导出。

所有冲突均已解决，工作树和索引中没有未合并项。

## 门禁

在 `087148fe` 上执行：

- `npm run build`：通过；prebuild 的版本生成、许可证检查和 TypeScript typecheck
  均通过，Vite 生产构建成功，仅报告既存大 chunk 警告。
- `rustup run stable cargo check --manifest-path src-tauri/Cargo.toml`：通过；
  0 error、28 个既存 warning。
- FG 热点契约：
  `phase4QbankToolsContract.test.ts`、`qbankToolsContract.test.ts`、
  `finder-host-buckets.test.ts` 全部通过（3 files / 35 tests）。

门禁结束后工作区无生成物或未提交改动。
