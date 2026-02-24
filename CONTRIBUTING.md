## 参与贡献指南

感谢你愿意为 Deep Student 贡献！

### 提交规范
- 使用小范围、可回滚的提交；提交信息说明"动机与影响"
- PR 标题遵循约定式提交：`feat|fix|docs|chore|refactor|test: ...`

### 开发环境
- **Node.js**: v20+
- **Rust**: Stable（建议通过 `rustup` 安装）
- **包管理器**: npm（本项目统一使用 npm，请勿混用 pnpm/yarn）

### 安装与开发

```bash
# 安装前端依赖
npm ci

# 启动前端开发服务器（端口 1422）
npm run dev

# 启动 Tauri 桌面应用（同时启动前端和后端）
npm run dev:tauri

# 构建前端
npm run build

# Lint 检查
npm run lint
```

### 代码风格
- TypeScript/React：请通过 `npm run lint` 检查（ESLint）
- Rust：`cargo fmt` 格式化，`cargo clippy` 静态分析
- 详细规范参见 [CODE_STYLE.md](./CODE_STYLE.md)

### 项目规范
- **请务必阅读 [`AGENTS.md`](./AGENTS.md)**，其中包含重要的开发规范
- 特别注意：拖拽上传功能必须使用统一组件（`UnifiedDragDropZone` 或 `useTauriDragAndDrop`）

### CI/CD

本项目配置了 GitHub Actions CI 流水线，PR 提交时会自动运行：
- **CLA 签署检查**（`.github/workflows/cla.yml`）— 首次贡献需签署 CLA
- TypeScript 类型检查（`tsc --noEmit`）
- Rust 编译检查（`cargo check`）
- 供应链安全审计（`cargo audit`）

请确保 PR 提交前本地通过 `npm run build` 和相关测试。

### PR 指南
- 描述变更与测试方式；关联 Issue（如有）
- 附上截图或日志以便 Review
- 确保 CI 检查通过

### 国际化 (i18n)

本项目采用 **中文优先 (zh-CN First)** 的国际化策略：

- **主语言**：`zh-CN`（简体中文）为开发主语言，所有新功能的 UI 文案**必须先添加中文词条**
- **回退语言**：`en-US`（英文）为回退语言（`fallbackLng: 'en-US'`）
- **框架**：使用 [i18next](https://www.i18next.com/) + [react-i18next](https://react.i18next.com/)
- **词条文件**：位于 `src/locales/{zh-CN,en-US}/` 目录，按功能模块分 namespace（如 `chatV2.json`, `settings.json`）

**贡献 i18n 的规则：**

1. 新增 UI 文案时，同时在 `zh-CN` 和 `en-US` 对应的 namespace JSON 中添加词条
2. 若英文翻译不确定，可先填入中文占位，在 PR 中标注 `i18n: needs translation`
3. 禁止在组件中硬编码用户可见的文案字符串，一律通过 `t('namespace:key')` 引用
4. 新增 namespace 时需同步更新 `src/i18n.ts` 的 imports 和 `resources` 配置

### 知识产权与授权 (Intellectual Property & Licensing)

本项目采用 **AGPL-3.0-or-later** 许可证开源。为了确保项目能够持续发展并在未来可能的商业化路径中保持灵活性（例如提供双重许可、发布企业版等），我们要求每位贡献者签署 **[贡献者许可协议 (CLA)](./CLA.md)**。

#### 签署流程

提交 Pull Request 后，**CLA Assistant** 机器人会自动检查您是否已签署 CLA：
- 如果尚未签署，机器人会在 PR 中发布评论，引导您阅读并签署
- 您只需在 PR 评论中回复 `I have read the CLA Document and I hereby sign the CLA` 即可完成签署
- 签署记录将永久保存，后续 PR 无需重复签署

#### CLA 核心条款摘要

完整条款请参阅 **[CLA.md](./CLA.md)**，以下为核心要点：

1.  **版权归属**：您保留您所提交贡献的版权（Copyright），本协议不构成版权转让。
2.  **版权许可授予**：您仅向**项目维护者**授予一份永久的、不可撤销的、全球性的、免费的、非独占的版权许可，包括复制、修改、分发及**再授权 (Sublicense)** 的权利。这确保了项目未来（如商业化）的灵活性，而普通用户获取代码仍受 AGPL-3.0 约束。
3.  **专利许可授予**：您向**项目维护者及软件接收方**授予一份永久的、不可撤销的、全球性的、免费的、非独占的专利许可，适用于因您的贡献而必然被侵犯的专利权利要求。如果您对任何实体提起专利侵权诉讼（主张您的贡献构成侵权），则您授予该实体的专利许可自诉讼提起之日起终止。
4.  **合法性声明**：您保证您拥有提交该贡献的合法权利，且该贡献不侵犯第三方的知识产权。如果您的贡献包含第三方代码，需在 PR 中明确说明其来源和许可证。
5.  **第三方依赖**：引入的第三方依赖必须与 AGPL-3.0 兼容（MIT、Apache-2.0、BSD 等均兼容；GPL-2.0-only 不兼容）。

### 沟通
- 通过 Issue 描述问题与复现步骤
