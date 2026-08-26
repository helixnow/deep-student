# 0824 Wave2-C R5 — anki/qbank 移动 chrome 修复台账

- 执行：第 5 轮「chrome 修复-anki/qbank」（claude-fable-5-thinking-high）
- 基线：`cf8eb9e8`（docs: record Wave2-C R4 attachment and a11y landing）
- 依据台账：`docs/dev/wave2-C-r1/04-anki-qbank-chrome.md`
- 红线遵守：未触碰 FSRS / 出题 / 评分 / store 服务层；`save_to_library`、`ChatV2AnkiAdapter` 全程未涉及；未新增任何 `!min-h-11` / `!min-h-[44px]` 散点（全文件 diff 可核）。
- 验证：仅 esbuild 语法级 parse（两个改动 TSX 均 PARSE_OK）；按指令未执行测试。

## 关键事实更正（先于修复结论）

R1 台账「Checkbox 基元只有 h-4 w-4，无 coarse 热区」（04 台账 §机制基线、页 1 违规 1、机制化建议 2）**在扫描 HEAAD 当时即已过时**：

- `src/components/ui/shad/Checkbox.css:37-55` 已有基元级 coarse 热区——`@media (pointer: coarse)` 下对 `[data-radix-checkbox-root]` 用居中透明 `::after`（`max(100%, 44px)` 两维）撑出 ≥44×44 命中区，视觉锁 16×16，与 Switch.css 同款。
- 引入提交：`a38c75a6`（fix(ui): enlarge leftover Checkbox coarse hit，0824 G 波 "enlarge leftover" 系列），**是 R1 扫描 HEAD `29ca02d9` 的祖先**。台账只读了 `Checkbox.tsx:15` 的类名串，漏读了 `import './Checkbox.css'` 的伴生样式。
- 推论：台账页 1 违规 1（ankiCardsBlock:2972 裸 Checkbox 无热区，「本轮唯一硬违规」）在本基线上**已不成立**——该裸用点自动继承基元热区，且已带 `aria-label`（selectCard）。

## 逐文件处置

### 1. `src/components/ui/shad/Checkbox.tsx` — 注释固化机制，不重复叠加

- coarse 热区**已由 Checkbox.css 在基元层保证**（见上），属 coarseHit.ts 头注所述「伪元素逃生舱」的基元级下沉——16px 视觉盒撑成 44px 实体盒会破坏视觉，正是逃生舱的准许场景；机制上等价于任务指定的 coarseHit.ts 路线（`-inset-3.5` 档 = 16+14×2 = 44，与 CSS `max(100%,44px)` 同值），且 CSS 版本对两维同时保证、不受调用方 className 合并干扰。
- 故 **不在 tsx 再叠 tailwind 扩区类**（双 `::after` 定义会互相覆盖、徒增合并歧义），改为在组件定义处补机制注释：热区出处（Checkbox.css ::after）、Switch.css 先例、并明令调用点勿再手抄 `before:-inset-3.5` / `!min-h-11` 散点。此注释同时修复 R1 误读的根因（tsx 无任何线索指向伴生 CSS）。

### 2. `src/components/QuestionBankManageView.tsx` — 补 5 处 aria-label + 删 3 处手抄热区

**吸底批量条 <sm 可访问名（台账页 3 违规 1）**：5 个 `hidden sm:inline` 文案钮补显式 `aria-label`（与 title/可见文案同串，各断点语义一致）：

| 行（改后） | 按钮 | aria-label 串 |
|---|---|---|
| ~1110 | 批量难度 | `learningHub:exam.library.batchSetDifficulty` |
| ~1128 | 批量标签 | `learningHub:exam.library.batchEditTags` |
| ~1145 | 重置 | `practice:questionBank.reset` |
| ~1149 | 删除 | `common:delete` |
| ~1156 | 取消 | `common:cancel` |

同时在难度钮前加块级注释说明违规机理（`display:none` 文案不进可访问树、title 触屏不可达）。L1100「反选」钮文案常显，无需处理。

**手抄 coarse 热区删除（Checkbox 基元已覆盖）**：删 3 处 `relative [@media(pointer:coarse)]:before:content-[''] …before:-inset-3.5`：

- L686（<768 卡片列表行 Checkbox）——此处留一行注释指明基元出处，防回潮；
- L812（表格表头全选 Checkbox）；
- L843（表格行 Checkbox）。

删除后 3 处 Checkbox 均无 className（原 className 仅承载该 hack）。事件路径不变：`::after` 属于 Checkbox 按钮自身，冒泡仍经外层 `stopPropagation` span，行点击不会误触发 `onViewDetail`。副作用为正向：消除「基元 ::after + 手抄 ::before」双伪元素叠层。

### 3. `src/features/chat/plugins/blocks/ankiCardsBlock.tsx` — 零 diff（有据）

任务允许项为「仅 Checkbox 裸用受益或补 aria」。核验结果：

- L2836（全选）：裸用，已带 `aria-label` + `title`（selectAll）✅；
- L2972-2977（逐卡选择）：裸用，已带 `aria-label`（selectCard，含序号插值）✅，`className="mt-3 flex-shrink-0"` 纯布局、无热区散点。

两处均自动继承 Checkbox.css 基元热区（裸用即受益，正是机制化的目标形态），aria 完备，**无需改动**。全文件另有 16 处 `coarse:!min-h-11` 散点（台账页 1 违规 2）属「散点十处 !min-h-11」禁改项，未触碰。

## legacy 归因

| 项 | 归因 | 证据 |
|---|---|---|
| 吸底条 <sm 可访问名丢失（本轮修复） | **v0.9.44 既有债**。`git show v0.9.44:…QuestionBankManageView.tsx` L1119/1136/1142/1146/1157 同款 `hidden sm:inline` 无 aria-label | v0.9.44 blob 核验 |
| 手抄 `before:-inset-3.5` ×3（本轮删除） | **0824 引入**（`9f22be84` fix(mobile): enlarge banner close…），且引入时 Checkbox.css 基元热区（`a38c75a6`，同日更早）已存在——生效当天即冗余 | `git log -S` |
| Checkbox 基元「无热区」 | **误报**（R1 台账漏读伴生 CSS）；真实修复为 0824 G 波 `a38c75a6`，v0.9.44 无此块（缺热区本身是 v0.9.44 既有债，0824 已在基元层修掉） | ancestor 核验 |
| ankiCardsBlock:2972 裸 Checkbox「硬违规」 | 随上条一并**销案**：v0.9.44 既有债，已被 0824 基元修复覆盖，本轮零改动 | 同上 |

## 遗留（本轮范围外，供后续批次）

1. 同文件工具栏 CSV 导入/导出钮（QuestionBankManageView.tsx:513,519）同款 `hidden sm:inline` 无 aria-label——不在本轮指定的吸底条范围（:1143-1161 附近），未动。
2. 其他文件的手抄 Checkbox 热区同样已冗余，可循本轮模式删除：BackupTab.tsx:587,600、McpEditorSection.tsx:1732（均非 anki/qbank 域，未动）。
3. 台账页 3 违规 2（`!min-h-[44px]` vs `!min-h-11` 拼写分裂）与各文件散点债：属禁改项/机制化建议 4（eslint 归一），未动。
4. 建议回写 `docs/dev/wave2-C-r1/04-anki-qbank-chrome.md` 的机制基线 L13 与页 1 违规 1（本文件即为更正依据），避免后续轮次重复误报。
