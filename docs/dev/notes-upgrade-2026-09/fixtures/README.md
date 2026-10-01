# F01–F08 合成 Markdown 样本

全部内容为人工合成，无用户笔记、真实附件、个人路径或访问凭据。`example.invalid`、`note_fixture*`、`file_fixture*`、`nv_f07_*` 都是假目标。不要把不存在的资产显示成“已验证可打开”。

这些是后续 WP 共用的输入和判定契约，**所有 F 用例的应用验收状态均为未运行**。基线中 39 个通过测试是仓库既有测试，未消费这组新样本。F07 将多个完整版本合并在一个 Markdown 档案中；F08 是可展开长文种子，避免把重复行伪装成性能实测。

| ID | 文件 | 覆盖重点 | 目标断言（待执行） |
|---|---|---|---|
| F01 | [basic.md](F01-basic.md) | 中文、英文、emoji、标题、行内格式、空行／换行 | 字面文本与链接语义保留；打开不写回；末段不消失；元数据标题独立于 H1 |
| F02 | [nested-lists.md](F02-nested-lists.md) | 任务／有序／嵌套列表，多段列表项，引用 | 层级、序号语义、勾选状态和续段保留；转换／拖动后重开一致 |
| F03 | [table-math-code.md](F03-table-math-code.md) | GFM 表格、行内／块公式、围栏长度、Mermaid | 公式和代码不参与 wiki 链接提取；表格完整；窗口边界不切断原子块 |
| F04 | [callout-toggle-titles.md](F04-callout-toggle-titles.md) | callout、toggle、嵌套和纯文本标题 | 首轮富文本标题转显示文本有明确预览；纯文本手打标点不被二次吞掉；折叠正文保留 |
| F05 | [links-assets-unknown.md](F05-links-assets-unknown.md) | wiki/note/pdfref、图片、未知 directive/HTML/YAML | 旧协议不被重新解释；原文保留；未知语法不静默删除；缺资产明确报缺失 |
| F06 | [stable-blocks.md](F06-stable-blocks.md) | 拟议稳定 ID、相同文本、重复 heading | 保存／重开／移动保持 ID，复制新 ID；代码内标记不注册；按版本恢复身份 |
| F07 | [document-history.md](F07-document-history.md) | 完整 v1/v2/v3、标题与属性、历史资产、恢复 | 恢复为 v4；历史引用保持 v1；v1 资产不因 v2 删除图片被回收；冲突不覆盖 |
| F08 | [long-window-seed.md](F08-long-window-seed.md) | 长文窗口、未加载后缀、重复章节 | 展开后前缀编辑保存仍含末尾 sentinel；快照／导出／AI 读取全文 |

## 操作与比较规则

F01–F05 是 legacy 输入，不含已实现格式升级的假设。F06 是拟议新格式，当前应用可能不支持其标记；不得直接导入真实文库作为迁移。F07 是版本档案，分别提取 `markdown` 围栏中的全文与相邻 metadata 作为测试输入，不把整个档案当成一篇用户笔记。

每个用例应记录基线 SHA、入口、输入格式、动作、保存回执版本、重新读取结果以及原文差异。只在确认字段／语义允许规范化时归一化，不统一 `.trim()` 去掉末尾或空正文的差异。打开不编辑应无写入；编辑后必须从持久层重读，再检查往返。

具体身份操作使用 F06：将 `b_f06_second` 移到 `b_f06_first` 前，两个相同正文块都保留各自 ID；复制 first 得到新 ID；first 中拆段时首段沿用原 ID；删除 second 后实时引用失败、旧版本仍成功；撤销／重做与重新打开后结果一致。未知／重复标记导入另以 F06 原文复制一个块生成输入，预期“明确处理冲突”，不要把这个负例写成已支持。

F04 的富文本来源标题预期显示文本：`**重点** 与 [来源](https://example.invalid/source)` → `重点 与 来源`。作为纯文本输入粘贴同一串字符时保留字面符号。无损导入与纯文本输入是两个不同动作，断言不能混用。

## F07 固定测试状态

按档案中的三份完整快照建立 `note_fixture07`：v1 含旧图，v2 去图并修改正文、标题和属性，v3 正文同 v2 但改标题／属性。历史版本 ID 在真正测试中由后端产生，档案里的别名映射到返回 ID，不能要求生产接受固定 ID。

1. 固定 v1 的历史块引用。删除当前图片后运行孤儿扫描预览，旧图应被历史保留；本次样本没有真实图文件，后续测试需在隔离数据目录创建合成实体。
2. 以 v3 为 expectedVersionId 恢复 v1，返回 v4，parent=v3、restoredFrom=v1；完整比较 title/content/tags/props/format/assetRefs，收藏与目录维持当前状态。
3. 用 stale v2 再请求恢复，应冲突，v4 不变，无额外半写版本。
4. 读取 v1 历史引用仍为旧结论；读取当前引用为 v4；给不存在版本返回 unavailable，不回退当前。
5. 将正文置为空字符串保存，空白页是合法版本；再恢复 v1。no-op 只在所有文档字段均相同时成立。
6. 模拟版本插入失败应整事务回滚；模拟当前 resources 的旧资源正常回收后历史仍可读。执行者需提供数据库前后证据，本文件不代替执行报告。

## F08 展开方法

用 F08 文件从 `## Window unit` 开始的内容作为单元，复制 40 次；每份替换 `UNIT-NNN` 为零填充序号；最后追加 `F08-FINAL-SENTINEL-DO-NOT-DROP`。以下是后续测试的内存构造方法，不是已执行测试：

```js
const source = /* read F08-long-window-seed.md as UTF-8 */;
const unit = source.slice(source.indexOf('## Window unit'));
const full = Array.from({ length: 40 }, (_, i) =>
  unit.replaceAll('UNIT-NNN', `UNIT-${String(i + 1).padStart(3, '0')}`)
).join('\n\n') + '\n\nF08-FINAL-SENTINEL-DO-NOT-DROP\n';
```

先断言展开后行数大于默认窗口启用阈值 900（600 初始 + 300 扩展），再用应用正常路径打开。记录实际字节数和行数，不把样本称为 1MB 压测。只修改前 600 行内一段并保存，然后验证末尾 sentinel、最后一段代码／公式以及隐藏图片引用仍存在。额外以初始窗口 100 检查表格、代码、公式、列表续段跨界，窗口算法和新块注释绑定必须一起验证。

## 结果记录模板

```text
Fixture / HEAD / format / entry:
Action / expectedVersionId:
Observed output / persisted version:
Pass, fail, or not run:
Evidence (test name / log / screenshot / query):
Known limitation:
```

历史、同步、附件和 UI 测试应在隔离合成数据目录进行；不要在用户真实笔记上执行删除或恢复演练。
