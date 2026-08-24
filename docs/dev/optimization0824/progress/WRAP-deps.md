# WRAP：依赖与许可证一致性收尾（SA-WRAP-DEPS）

> 分支：`cursor/optimization0824-5575`
> 日期：2026-08-24
> 审计基线：`d8d7e6fe1168`

## 结论

- `@hello-pangea/dnd`、`@anthropic-ai/claude-code`、`react-grab` 均已从
  `package.json`、`package-lock.json` 和实际安装树移除。
- 最终生产依赖复扫未发现新的未使用直接依赖，本轮不做额外删除。
- `react-is` 保留：`recharts@3.8.1` 将其声明为 peer dependency，且
  `recharts/es6/util/ReactUtils.js` / `lib/util/ReactUtils.js` 在运行时直接导入它。
  仓库启用 `legacy-peer-deps=true`，因此根项目必须显式提供该 peer。
- 第三方许可证通知重新生成后仍为 1847 个组件，生成物与当前提交内容一致、无 diff。

## 核验记录

### 已移除依赖

对三个目标包分别扫描 `package.json` 和 `package-lock.json`，均为零匹配；安装完成后
执行 `npm ls @hello-pangea/dnd @anthropic-ai/claude-code react-grab --all`，三个包
均未出现在依赖树中。代码与脚本中的 import/require 字面量同样为零匹配。

仓库文档保留的包名仅用于历史迁移记录，不构成依赖引用。

### 零引用生产依赖复扫

在干净的 `npm ci` 安装上使用最新版 `depcheck` 扫描全仓直接依赖：

```text
unused dependencies: []
```

扫描同时识别到 `react-is` 的 6 个 Recharts 消费入口。另报出的两个未使用
devDependency 候选不属于本轮生产依赖范围，且分别受 TypeScript 类型配置和
Stylelint 配置链消费，因此未做机械删除。

结论：当前所有直接生产依赖均有源码、构建配置或 peer 运行时契约依据；没有满足
“确定安全删除”条件的新候选。

### `react-is` peer 契约

- 根依赖：`react-is@19.2.8`
- 消费方：`recharts@3.8.1`
- Recharts peer 范围：
  `^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0`
- `npm ls` 显示 Recharts 使用根项目的 `react-is@19.2.8`（deduped）
- `.npmrc`：`legacy-peer-deps=true`

因此 `react-is` 虽无项目源码直接 import，仍是必要生产依赖，不能按零引用项删除。

## 许可证

`npm run licenses:generate` 使用锁定的 Node/Rust 依赖图成功生成：

```text
Wrote legal/THIRD_PARTY_NOTICES.txt (1847 components).
[license-compliance] OK
```

生成前需用 Rust stable（本次为 1.98.0）执行 `cargo fetch --locked`；仓库默认
Rust 1.83.0 无法解析锁文件中依赖使用的 edition 2024。提交后在最终合并分支执行
`RUSTUP_TOOLCHAIN=stable npm run licenses:generate && npm run licenses:check`，
生成物保持无 diff，许可证合规门禁通过。
