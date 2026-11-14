# U3-ui-settings：前端插件化 F1

按 `docs/plugins/FRONTEND-F1.md` §3 中 `U3-ui-settings` 一行的范围实施。

允许改动的路径（只写这里）：
- `src/features/settings/components/Settings.tsx`
- `src/ui-kernel/contracts/settings.ts`
- `src/ui-plugins/official/settings/`
- `docs/dev/electron-migration/audits/U3-ui-settings.md`（你的实施报告：原条件 → 新元数据对照表、取证与改造提交、验证结果）

## 硬性要求
- 先完整阅读 `docs/plugins/FRONTEND-F1.md`（规格，以它为准）与 `docs/plugins/FRONTEND.md`、`src/ui-kernel/` 现有实现。
- 这是**行为完全等价的重构**：用户可见的一切（文案、图标、顺序、布局、样式、交互、懒加载时机、移动端、深浅色、演示壳）不变；不增删功能、不"顺手改进"。
- **先取证后改造**：第一个提交只做 golden 取证（改造前清单），第二步起才改造；不得为通过测试修改 golden。
- 只改你允许的路径（下表）；不碰 `host/`、`electron/`、契约、`src/plugin-runtime/`、`src/plugins/translation/`。
- 每个可验证单元小步提交。前端类型检查前先 `npm run version:generate`。
- 完成协议见规格 §5；报告必须贴原始退出码与 Errors 行（`Tests N passed` 但 `Errors 1` 不算通过）。
- 遇到无法等价迁移的点：停在原实现、写进报告，交 C1 协调者/架构师裁定，不要硬改。
