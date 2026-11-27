## 参与贡献指南

感谢你愿意为 Deep Student 贡献！

### 提交与仓库边界规范
- 使用小范围、可回滚的提交；提交信息说明「动机与影响」
- PR 标题遵循约定式提交：`feat|fix|docs|chore|refactor|test: ...`
- **公开仓库纯净原则**：本仓库仅存放产品源码本体与面向用户/贡献者的必要文档（CI 通过 `npm run check:public-surface` 执行根目录与文档目录白名单门禁），请勿在提交中包含个人笔记、过程草稿或运行日志。

### 开发环境
- **Node.js**: Node.js 24+（与 CI 一致）
- **包管理器**: npm（本项目统一使用 `npm ci --legacy-peer-deps`，请勿混用 pnpm/yarn）

### 安装与本地开发

```bash
# 安装依赖
npm ci --legacy-peer-deps

# 启动纯前端开发服务器（端口 1422）
npm run dev

# 启动 Electron 桌面端开发环境（前端 + Cordis Host）
npm run dev:electron

# 启动 WebUI 开发服务端
npm run web

# 类型检查、代码风格与契约 / 边界门禁
npm run typecheck
npm run typecheck:host
npm run lint
npm run lint:css
npm run check:i18n
npm run check:plugins
npm run check:arch
npm run contracts:check
npm run check:public-surface

# 运行测试
npm test
npm run test:host
```

### 代码风格与架构约束
- TypeScript / React / CSS：请通过 `npm run lint`、`npm run lint:css`、`npm run check:frontend-layers` 与 `npm run check:i18n` 检查
- Host 与插件边界：请通过 `npm run check:plugins`、`npm run check:arch` 与 `npm run contracts:check` 检查
- 详细规范参见 [`docs/CODE_STYLE.md`](../docs/CODE_STYLE.md)、[`docs/frontend/README.md`](../docs/frontend/README.md) 与 [`host/kernel/API.md`](../host/kernel/API.md)

### CI/CD
PR 提交时会自动运行 `.github/workflows/ci.yml`、`.github/workflows/host-checks.yml`、`.github/workflows/node-ci.yml` 与 `.github/workflows/cla.yml`（含公开仓库表面白名单检查、前端类型与构建门禁、Vitest 分片测试、Host/Electron 契约与迁移门禁、示例插件测试及 CLA 签署检查）。提交 PR 前请确保本地相关检查通过。

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
4. `common` 与 `sidebar` 在 `src/i18n.ts` 中同步导入供首屏使用；其余命名空间通过 `import.meta.glob('./locales/**/*.json')` 按需异步加载（移动端与演示构建通过 `src/locales/bundles/{zh-CN,en-US}.ts` 的 `import.meta.glob` 自动聚合，无需手动登记）。新增 namespace 时，只需同时添加 `src/locales/zh-CN/<ns>.json` 与 `src/locales/en-US/<ns>.json`，并在 `src/i18n.ts` 的 `ALL_NS` 数组中注册该命名空间名称，然后运行 `npm run check:i18n` 验证

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
