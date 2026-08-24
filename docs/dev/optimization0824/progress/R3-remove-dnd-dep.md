# R3 移除 @hello-pangea/dnd 依赖（SA-R3-01 / WI-8）

> 分支：`cursor/optimization0824-5575`
> 日期：2026-08-24
> 子代理：SA-R3-01
> 模型：`claude-fable-5-thinking-xhigh`

## 0. TL;DR

R2（`R2-dnd-migration.md`）已把 `src/` 内全部 `@hello-pangea/dnd` 使用点迁移到 `@dnd-kit`，本轮完成收尾：确认 `src/` 零 import 后 `npm uninstall @hello-pangea/dnd`，lockfile 净删 3 个组件（`@hello-pangea/dnd@18.0.1` + 独占传递依赖 `css-box-model@1.2.1`、`raf-schd@4.0.3`），THIRD_PARTY_NOTICES 重新生成（1862 → 1859 组件、795 → 792 份法律文本），`licenses:check` 与 `typecheck` 均通过。

## 1. 前置确认

```text
rg "@hello-pangea/dnd" src   # 仅 src/hooks/useTouchFriendlyDndSensors.ts 一条
                             # 历史语义注释（“沿用迁移前的长按语义”），无任何 import
```

R2 迁移已覆盖全部 2 个真实使用场景（设置页供应商排序、Chat V2 会话拖入分组），无残留代码引用，可安全删除依赖。

## 2. 执行与结果

```text
npm uninstall @hello-pangea/dnd   # exit 0
npm run licenses:generate         # Wrote public/legal/THIRD_PARTY_NOTICES.txt (1859 components)
npm run licenses:check            # [license-compliance] OK
npm run typecheck                 # exit 0
```

### 2.1 lockfile 实际删除项

| 组件 | 说明 |
| --- | --- |
| `@hello-pangea/dnd@18.0.1` | 本体（Apache-2.0） |
| `css-box-model@1.2.1` | 独占传递依赖 |
| `raf-schd@4.0.3` | 独占传递依赖 |

删除后 `package-lock.json` 对上述包及 `memoize-one`/`use-memo-one` 的提及归零（后两者在 v18 lockfile 中本就无独立条目）。

**与 R2 报告 §4 预估的差异**：`redux@5.0.1` / `react-redux@9.3.0` 并非 hello-pangea 独占——`recharts → @reduxjs/toolkit` 依赖同版本并 dedupe 共享，故保留在 lockfile 中，属预期行为而非残留。

### 2.2 NOTICES 变更

- 组件数 1862 → 1859（-3，与 lockfile 删除项一一对应）。
- 法律文本 795 → 792；移除了 `@hello-pangea/dnd` 的 Apache-2.0 notice 条目。
- diff 行数较大（±800 行）系 notice 编号（N532 起）整体前移所致，实质变更仅上述 3 项。

## 3. 影响

- 运行时 bundle：R2 迁移后该库已不进入任何 chunk，本轮无额外体积变化；收益为依赖卫生——安装体积、lockfile、审计面与 NOTICES 各少 3 个组件。
- `@dnd-kit/*` 四个包（core/modifiers/sortable/utilities）继续作为唯一 DnD 依赖。

## 4. 后续（不在本批范围）

- `docs/THIRD_PARTY_LICENSES.md` 中仍有 `@hello-pangea/dnd` 的 Apache-2.0 行内提及（R2 §5 已标注），本轮按任务范围（仅 package.json/lock/NOTICES/报告）未动，可在下次触碰该文档时顺带清理。
- `src/hooks/useTouchFriendlyDndSensors.ts` 的历史语义注释保留（解释 250ms 长按参数来源，非引用）。

## 5. 变更清单（本次提交仅含以下文件）

- `package.json`：删除 `@hello-pangea/dnd` 依赖。
- `package-lock.json`：净删 3 个组件条目。
- `public/legal/THIRD_PARTY_NOTICES.txt`：重新生成。
- `docs/dev/optimization0824/progress/R3-remove-dnd-dep.md`：本报告。
