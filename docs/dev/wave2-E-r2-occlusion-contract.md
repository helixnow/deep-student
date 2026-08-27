# 0824 Wave2-E 第 2 轮 · 遮挡契约裁决(书面契约)

- 角色:Wave2-E 第 2 轮「遮挡契约裁决」(静态裁决,未编译/未测试/未改产品代码/未 commit)
- 输入:r1-05(导出泄漏与闭环缺口)、r1-08(SOTA 与 Anki 官方 IO 语法)、r1-03(流式入库断链)、
  `anki_image_occlusion.rs` 模块头、`apkg_exporter_service.rs` model 创建路径实勘、
  `anki_connect_service.rs` createModel 路径实勘
- 本文是第 2 轮实现的唯一契约。实现偏离本文任何一条,以本文为准。

---

## 0. 裁决

**本轮为真闭环,不是「遮挡草稿预览」降级。** 遮挡卡从入库到导出必须产出
**Anki 端可复习的 note**(标准 Cloze 主路径),并同轮落地官方 Image Occlusion
语法转换纯函数与 APKG 侧 IO 五字段模型创建能力。降级方案(只写文档/只做预览)不成立,
理由:三条闭环前置能力经静态核查全部存在——

1. `build_card_fields`(`anki_image_occlusion.rs:429-472`)已产出候选 Cloze `Text`
   (含 `<img>` 拼接分支)与 `_occlusion` spec,缺的只是消费接线;
2. APKG 导出器已有**自定义 model 创建路径**(见 §4,判定:**能建 IO notetype**);
3. 媒体打包(`collect_media_entries:1112-1168`、`prepare_note_media:881-1076`)
   均以 `card.images` 为唯一数据源,入库补上 `images` 后两条导出路径的媒体逻辑照用,零新机制。

未发现任何不可克服的静态反证。

### 裁决细节修正(唯一一处,附静态证据)

预裁第 3 条把 IO 语法坐标写成「百分数」。**修正为 0–1 归一化小数**:本仓 r1-08 §1.1
已引 Anki 官方源码([to-cloze.ts](https://github.com/ankitects/anki/blob/57e67f84/ts/routes/image-occlusion/shapes/to-cloze.ts)、
[imageocclusion.rs](https://github.com/ankitects/anki/blob/57e67f84/rslib/src/image_occlusion/imageocclusion.rs))
锁定官方 on-disk 语法为 `{{c1::image-occlusion:rect:left=.1:top=.2:width=.4:height=.5}}`,
坐标是图片尺寸的 0–1 归一化分数,不是 0–100 百分数。写百分数会导致 Anki 端遮罩全部放大
100 倍越出画布,属可静态证伪的坐标系错误。此修正不改变裁决方向(仍是真闭环 + IO 语法落地),
只修正序列化数值域。

---

## 1. 本轮承诺(五条,全部必达)

| # | 承诺 | 落点 |
| --- | --- | --- |
| 1 | 入库消费 `OcclusionCardFields.text`(**仅当卡片 text 为空时填入**,不覆盖模型已写 text)+ `_occlusion.imageRef` 放入 `AnkiCard.images`(**仅当 images 为空时**) | `streaming_anki_service.rs` occlusion merge 分支(:2008-2019)与 `AnkiCard` 构造(:2076-2078) |
| 2 | 导出可复习**标准 Cloze**:`<img src="媒体名">` + `{{cN::label}}`,Anki 任意 Cloze 模型即可复习 | 导出入口规范化层(APKG 两入口 + AnkiConnect 入口,r1-05 §5.3 第 1 步) |
| 3 | 新增纯函数 `format_anki_io_cloze(spec)`:0–1 坐标 → Anki 官方 IO rect 语法(归一化小数,见 §0 修正);APKG 侧创建 IO 五字段模型(Occlusion/Image/Header/Back Extra/Comments)并写入 | `anki_image_occlusion.rs`(纯函数)+ `apkg_exporter_service.rs`(model 创建,§4) |
| 4 | 导出前统一过滤 `_` 前缀内部字段;转换器消费 `_occlusion` 后**必须移除**,禁止泄漏 | `is_internal_protocol_field` 谓词 + 三道闸(§6) |
| 5 | 旧卡无 `_occlusion`:走原普通导出,零行为变化(泄漏修复除外,精确边界见 §7) | 规范化层命中判定 = `parse_occlusion_field` 是否返回 Some |

---

## 2. 字段契约矩阵(入库 / APKG / AnkiConnect)

### 2.1 入库(遮挡卡,`parse_and_save_card` occlusion 分支扩展)

| 字段 | 现状(r1-03 §3) | 本轮契约 |
| --- | --- | --- |
| `text` | `OcclusionCardFields.text` 被丢弃,卡片 text 只取模型输出(:2076) | 把 `fields.text`(纯 cloze 串,无 `<img>`,因 `extract_occlusion_draft_fields` 传 `image_file_name=None`)以 **or_insert 语义**写入 `cleaned_extra_fields["text"]`:模型已写 text 则一字不动(lossless / 不改写模型产出原则);为空才填 |
| `images` | 硬编码 `Vec::new()`(:2078) | `images` 为空时填 `[_occlusion.imageRef]`;`imageRef == "vlm://pending-image"` 占位引用**不入** images(视为无图,导出侧降级为纯 cloze 文本卡);images 非空(未来路径)不动 |
| `extra_fields["_occlusion"]` | spec JSON | **库内保留不变**——它是前端只读预览(`ImageOcclusionOverlay`)与再编辑的数据源;移除只发生在导出克隆层(§6) |
| `extra_fields["_qa_flags"]` / `_original_generation` | 照写 | 入库行为不变(`_original_generation` 是 critic 修正对数据源,库内必须保留) |
| `tags` | 追加 `image-occlusion` | 不变 |
| `<img>` 拼接 | 无 | **入库不拼**。`<img src>` 的媒体文件名只有导出时才确定(APKG 包内名 / AnkiConnect storeMediaFile 名),拼接统一延后到导出转换器(r1-05 §5.1 #9 的 B 方案) |

同步义务:测试 `vlm_occlusion_draft_is_merged_into_extra_fields_without_rewriting_card`
(streaming_anki_service.rs:5095-5133)**扩展断言而非删除**:遮挡卡 text 含 cloze、images 非空、
模型已写 text 时不被覆盖。

### 2.2 APKG 导出(遮挡卡,导出入口规范化层内完成)

两种形态,**默认 = 标准 Cloze 形态(可复习主路径)**;IO 形态为本轮同步落地的可选形态
(导出入口参数选择,默认关,前端接线属后续轮):

| 项 | Cloze 形态(默认,主路径) | IO 形态(可选,本轮落地能力) |
| --- | --- | --- |
| model | 既有 Cloze model(`create_cloze_model`,Text/Extra)或含 Text 字段的模板 model | **新建 IO 五字段模型**:字段序 `Occlusion / Image / Header / Back Extra / Comments`,`model_type=1`(Cloze kind,对齐 Anki `OriginalStockKind::ImageOcclusion` 的 kind 语义),经 §4 路径写入 `models_json` |
| 主字段 | `Text` = `<img src="包内媒体名"><br>{{cN::label}} …`(即 `build_card_fields(validated, Some(包内名), extra)` 的产物) | `Occlusion` = `format_anki_io_cloze(spec)` 产物(每盒一段官方 rect cloze) |
| 辅字段 | `Extra` = 补充说明(若有) | `Image` = `<img src="包内媒体名">`;`Header` = 卡片 front(可空);`Back Extra` = `{{cN::label}}` 标签清单的**纯文本形式** + 原 Extra(保证旧客户端揭底后有人类可读答案);`Comments` = 空 |
| 生卡 | 既有 `cloze_card_ords` 按 cloze 序号生成多卡——Hide-One 语义免费获得 | 同左(`Occlusion` 字段的 cN 驱动 ords) |
| 媒体 | `imageRef` 在规范化层解析为本地路径(VFS id 经资源服务;本地路径校验存在;解析失败降级为无图纯 cloze,不阻断导出)→ 路径已在 `card.images` → `collect_media_entries` 既有逻辑打包,`<img src>` 与包内文件名对齐 | 同左 |
| `_` 字段 | 全部过滤(§6) | 同左 |
| overlay | Anki 端无遮罩(标准 cloze「看图回忆标签」语义);应用内遮罩由前端 `_occlusion` 预览承担 | **真遮罩 overlay 依赖 notetype 与客户端**:模板需内置 IO 渲染脚本,仅 Anki 23.10+ 生效;旧客户端退化为普通 cloze 翻面(Occlusion 字段 rect 语法可见,不优雅但可复习,答案可读性由 Back Extra 兜底)。此依赖必须写进导出报告/用户可见文案 |

### 2.3 AnkiConnect 导出(遮挡卡)

| 项 | 契约 |
| --- | --- |
| 主路径 | **标准 Cloze**:目标 Cloze model 的 `Text` = `<img src="媒体名">` + `{{cN::label}}`,`Extra` = 补充说明;媒体经 `prepare_note_media` 既有 picture/storeMediaFile 逻辑(前提 `card.images` 已在入库填充) |
| 原生 IO notetype | **本轮不写入、不创建**。理由(静态):① `create_model_from_template`(anki_connect_service.rs:689-722)的 `createModel` 非幂等,与 Anki 23.10+ 自带的原生 "Image Occlusion" 模型存在命名/管理权冲突;② 原生 IO 的 `Occlusion/Image` 字段由 Anki 编辑器托管,外部灌值的兼容矩阵未经实机验证,违反本轮禁测约束。列为第 3 轮(实机验证轮)工作 |
| `_` 字段 | `build_fields_with_model_names` 的 lower/normalized 映射构建时**剔除全部 `_` 前缀键**——同时根治 r1-05 §2.2 的 `_occlusion` → `Occlusion` normalize 碰撞泄漏(灌错语法进原生 IO 字段) |

---

## 3. `format_anki_io_cloze` 纯函数契约

- 落点:`anki_image_occlusion.rs`(保持模块「纯函数、无 I/O、无 LLM」性质)。
- 签名:`pub fn format_anki_io_cloze(spec: &ValidatedOcclusionSpec) -> String`
  ——只接受校验后类型,越界/退化盒在类型系统上已被排除。
- 输出:每盒一段,按盒序拼接:

  ```text
  {{c{clozeIndex}::image-occlusion:rect:left={x}:top={y}:width={w}:height={h}}}
  ```

  - 坐标为 **0–1 归一化小数**(§0 修正;与 `_occlusion` spec 同域,零换算损失),
    格式化最多 4 位小数、去尾零(对齐 Anki to-cloze.ts 的输出习惯);
  - `clozeIndex` 直接映射 cloze 序号(`ValidatedOcclusionSpec` 保证 ≥1 且已补齐);
    同序号多盒输出多段同 `cN`(Anki 语义:同卡分组),与现校验器「允许重复序号」一致;
  - 仅 `rect`。不输出 `ellipse/polygon/text`、不输出 `oi=1`(Hide All)、
    不输出 `angle/fill/scale`——见 §5 边界;
  - label **不进** IO 语法(官方 rect 语法不携带 label;答案可读性由 Back Extra 承担);
  - 纯确定性,单测锁定:精确串、4 位小数截断、同序号分组、贴边坐标(x+w=1)。

---

## 4. APKG 能否建 IO notetype:**是**(静态判定,证据)

自定义 model 创建路径已存在且安全:

1. `create_template_model(template_id, name, fields, front, back, css, model_type)`
   (`apkg_exporter_service.rs:607-`)接受**任意字段名列表**与 `model_type=1`(Cloze kind),
   即可构造五字段 `Occlusion/Image/Header/Back Extra/Comments` 模型;
2. 单模板路径:`initialize_anki_database_with_template`(:738-954)经 `template_config`
   元组注入自定义模型,`model_value` 转成 `serde_json::Value` 后已有注入自定义键的先例
   (:893-897 的 `DEEP_STUDENT_*` 键)——IO 模型如需 `originalStockKind` 等扩展键,同机制注入;
3. 多模板路径:`export_multi_template_apkg`(:1600-1680)按组向 `models_json` 写入任意
   model JSON(:1659/:1668),遮挡卡可作为独立分组挂独立 `model_id`(base_model_id 递增序列);
4. 模板内容完全由调用方给定(qfmt/afmt/css 原样进 model),IO 渲染脚本
   (`{{cloze:Occlusion}}` 隐藏容器 + `{{Image}}` + mask 脚本)可直接写入。

安全边界(实现约束):IO 模型分组的字段表**固定五字段**,不追加 extra_fields 超集键
(绕开 :1614-1624 的 extra_keys 追加逻辑,或在规范化层已把 `_` 键清空后自然为空);
model_id 沿用 base_model_id 递增序列,不与既有 Basic(1425279151691)/Cloze(1425279151692)冲突。

---

## 5. IO vs Cloze:本轮边界

| 能力 | 本轮 | 后续轮 |
| --- | --- | --- |
| 标准 Cloze 导出(`<img>` + `{{cN::label}}`,APKG + AnkiConnect) | ✅ 主路径,必达 | — |
| `format_anki_io_cloze`(rect,归一化小数) | ✅ 纯函数 + 单测 | — |
| APKG IO 五字段模型创建 + Occlusion 字段写入 | ✅ 能力落地(可选形态,默认关) | 第 3 轮实机验证后转默认候选 |
| IO overlay 真遮罩渲染 | 契约声明依赖 notetype(Anki 23.10+),不做兼容 shim | 实机验证 |
| AnkiConnect 写入原生 IO notetype | ❌ 不做(§2.3 理由) | 第 3 轮 |
| ellipse / polygon / text 形状、`oi=1`(Hide All)、angle/fill/scale | ❌ 不做(现 spec 仅轴对齐矩形,Hide-One 与 clozeIndex 现语义最贴合,r1-08 §5 结论 4) | 二期 |
| 遮挡框编辑器、VLM 真实视觉 grounding | ❌ 不做(独立缺口,r1-08 §5 结论 3) | 独立轮 |

---

## 6. 内部字段过滤契约(三道闸,消费先于移除)

统一谓词(APKG / AnkiConnect 共用):

```rust
fn is_internal_protocol_field(name: &str) -> bool {
    name.starts_with('_') || is_reserved_import_metadata_field(name)
}
```

三个导出入口(`export_cards_to_apkg_with_full_template_report`、`export_multi_template_apkg`、
`add_notes_to_anki_detailed`)在拿到 `Vec<AnkiCard>` 后立即对**克隆数据**执行,顺序强制:

1. **闸 1(入口规范化,唯一权威层)**:先跑遮挡转换器——`parse_occlusion_field` 命中则
   生成 Cloze Text(含 `<img>`)/ IO 字段、解析 imageRef 补媒体;**消费完成后**
   `extra_fields.retain(|k,_| !is_internal_protocol_field(k))`,`_occlusion`、`_qa_flags`、
   `_original_generation` 全部移除。先消费后移除是硬顺序,颠倒即丢数据;
2. **闸 2(model 字段表)**:extra_keys 追加处(:1309-1322、:1612-1624)过滤谓词从
   `is_reserved_import_metadata_field` 换成 `is_internal_protocol_field`;
3. **闸 3(取值兜底)**:`resolve_card_field_value`(:376-462)与
   `build_fields_with_model_names`(anki_connect_service.rs:188-266)对 `_` 前缀键直接跳过。

**验收红线:导出产物(APKG note 字段值 / AnkiConnect note fields)中出现任何 `_` 前缀键即违约。**

规范化只作用于导出流水线内克隆,**禁止写回卡片库**(`_original_generation` 是
`anki_critic.rs:168,771` 的修正对数据源,`_occlusion` 是前端预览数据源,库内必须原样保留)。

---

## 7. 旧卡兼容(无 `_occlusion`)

- 命中判定:`parse_occlusion_field(&card.extra_fields)` 返回 `None` → 遮挡转换器整体跳过。
- 零行为变化的精确边界:model 选择、Text/Front/Back 取值、cloze ords、媒体收集、
  模板分组、Basic 兜底路径全部与现状逐字节一致。
- **唯一允许的输出差异**:`_qa_flags`/`_original_generation` 等 `_` 前缀键不再作为
  model 字段与 note 值泄漏进 APKG(r1-05 §2.3 矩阵中的「泄漏」格全部翻绿)。
  这是承诺 4 对全卡种的统一泄漏修复,属安全修复而非行为回归;既有 13 个 `Anki*`
  保留字段的过滤行为不变。
- AnkiConnect 侧旧卡:标准模型本就不泄漏 `_` 键(r1-05 §2.2),闸 3 对其是纯防御,零输出差异。

---

## 8. 禁止事项

1. **不破只读预览**:前端 `ImageOcclusionOverlay` 的数据源 `extra_fields["_occlusion"]`
   在卡片库内不得移除、不得改 schema(camelCase 契约、0–1 归一化、≤12 盒、label ≤48 字符);
   移除只发生在导出克隆层。
2. **不放宽 lossless-only**:`parse_and_save_card` 的截断拒收(`repair.truncated_string`
   → Err,r1-03 §7)与相关测试不得松动;入库 text/images 填充只用 or_insert / 空时填语义,
   **任何情况下不覆盖模型已产出字段**。
3. **不回退 `enableQaPass`**:qa_pass 默认 true、门控语义(:2047-2051,校验照跑、
   关闭仅移除留痕)不动;`_qa_flags` 的入库写入不动(导出过滤与入库落盘是两层)。
4. 不改 `_occlusion` spec 协议与 `validate_spec` 拒绝语义(越界/重叠/空盒结构化拒绝,
   绝不静默修剪)。
5. AnkiConnect 不自动 `createModel` 名为 "Image Occlusion" 的模型,不向 Anki 原生 IO
   notetype 灌值(本轮)。
6. 导出规范化不写回卡片库(§6 末条)。
7. 禁改区照旧:coordinator.rs、tool_loop、缓存链、移动 chrome、workbench 壳不触碰。

---

## 9. 静态验收清单(实现轮对照)

- [ ] `format_anki_io_cloze` 单测:精确串、小数格式、同序号分组、贴边坐标。
- [ ] 入库测试扩展(:5095-5133):遮挡卡 text 含 cloze 且 images 非空;模型已写 text 不被覆盖;
      `vlm://pending-image` 不入 images。
- [ ] APKG 导出测试:遮挡卡 Cloze 形态 Text 含 `<img src="包内名">` + `{{cN::}}`,媒体清单含图;
      IO 形态五字段齐全、Occlusion 为官方 rect 语法;两形态产物中 `_` 前缀键计数为 0。
- [ ] AnkiConnect 构造测试:normalized 映射无 `_` 键(Occlusion 碰撞用例翻绿)。
- [ ] 旧卡回归:无 `_occlusion` 卡的导出产物除 `_` 键消失外逐字段一致。
