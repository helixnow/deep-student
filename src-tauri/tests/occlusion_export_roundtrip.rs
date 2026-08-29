//! # 遮挡卡 fixture 级端到端测试（0824 Wave2-E 第 2 轮 · 遮挡测试 r2-05）
//!
//! **执行约定：本文件第 1–7 轮只落盘不执行；预期第 8 轮运行
//! `cargo test --test occlusion_export_roundtrip`。**
//!
//! 覆盖链路：生成字段（`build_card_fields`）→ 入库形状（`extra_fields` 携带
//! `_occlusion` + tag）→ APKG/AnkiConnect 转换（IO cloze 语法、`_` 前缀协议
//! 字段过滤、媒体文件名解析）。
//!
//! 只使用 `deep_student_lib::anki_image_occlusion` 已 pub 的 API：
//! `validate_spec` / `build_card_fields` / `parse_occlusion_field` /
//! `OCCLUSION_FIELD` / `OCCLUSION_TAG` / `OcclusionSpec` / `OcclusionBox` /
//! `OcclusionConfig`。
//!
//! 另测本轮并发合入的 `format_anki_io_cloze`（矩阵 3 直接调用生产函数；
//! 测试内另保留一份公式镜像做交叉校验，见「镜像 helper 说明」）。
//!
//! ## 镜像 helper 说明（与生产实现的同步义务）
//!
//! 1. `format_anki_io_cloze_mirror` —— **应与生产函数
//!    `anki_image_occlusion::format_anki_io_cloze` 逐字节一致**（0–1 归一化
//!    小数，对齐 Anki 官方 `to-cloze.ts`：夹取 [0,1]、最多 4 位小数去尾零、
//!    前导点风格 `.125`、多盒无分隔拼接；**禁止 ×100 百分数**——百分数会让
//!    Anki 遮罩放大 100 倍）。矩阵 3 同时调用两者并断言相等：镜像在这里的
//!    价值是把公式写死在测试侧，生产侧任何静默改动都会转红。
//! 2. `is_internal_protocol_field_mirror` —— 镜像 r1-05 §5.3 议定的导出过滤
//!    谓词（`_` 前缀字段不得进导出产物）。apkg/ankiconnect 转换函数非 pub 且
//!    本文件不改其可见性，故在测试内复述谓词 + 模拟 note fields 锁协议语义；
//!    导出侧落地统一谓词后应与之等价。
//! 3. `media_file_name_from_image_ref_mirror` —— 镜像「`image_ref` → 包内媒体
//!    文件名」的最小解析约定（取最后一段 `/` 或 `\` 路径分量），语义对齐生产
//!    侧私有 helper `image_ref_basename`。导出侧 `collect_media_entries`
//!    接通后应与之兼容。
//!
//! ## 0824 Wave2-E 第 7 轮追加（r7-01，只加法）
//!
//! **执行约定不变：本文件仍第 8 轮才跑**（`cargo test --test
//! occlusion_export_roundtrip`），本轮只落盘不执行。既有矩阵 1–7 与三个镜像
//! helper 一字未动，追加覆盖矩阵 8–11：
//!
//! - 矩阵 8：入库 images 接线 —— 直接测已 pub 的生产函数
//!   `occlusion_image_ref_from_fields`（`streaming_anki_service` 入库点用它
//!   从 `_occlusion.imageRef` 填充 `AnkiCard.images`），含 camelCase 契约、
//!   snake_case 旧数据容忍、旧卡（无 `_occlusion`）不填充；
//! - 矩阵 9：`vlm://pending-image` 占位端到端不入 images ——
//!   `parse_occlusion_boxes_from_vlm`（产出占位引用）→ draft marker →
//!   `extract_occlusion_draft_fields` → `occlusion_image_ref_from_fields`
//!   必须为 `None`（r2 契约 §2.1 / r6-01 补丁回归锁），且 `vlm://` 整个
//!   scheme 均被过滤、真实 `vfs://` 引用不受影响；
//! - 矩阵 10：IO 坐标 0–1 白盒 —— 绕过校验直构 `ValidatedOcclusionSpec`，
//!   锁 `format_anki_io_cloze` 的夹取 [0,1]、4 位小数舍入、去尾零、整数
//!   0/1 无前导点（深度防御分支仅能直构触达，见矩阵 10 注释）；
//! - 矩阵 11：draft marker 全链路 —— 生成（marker）→ 模型可见内容剥离
//!   （`strip_occlusion_draft_markers`）→ 入库字段
//!   （`extract_occlusion_draft_fields`）→ 坐标回读不漂移 → images 接线 →
//!   导出 `_` 前缀过滤，一条链走完「生成/入库/导出」三段。

use std::collections::HashMap;

use deep_student_lib::anki_image_occlusion::{
    build_card_fields, build_occlusion_draft_marker_from_spec, extract_occlusion_draft_fields,
    format_anki_io_cloze, occlusion_image_ref_from_fields, parse_occlusion_boxes_from_vlm,
    parse_occlusion_field, strip_occlusion_draft_markers, validate_spec, OcclusionBox,
    OcclusionConfig, OcclusionSpec, ValidatedOcclusionSpec, OCCLUSION_BOXES_CLOSE,
    OCCLUSION_BOXES_OPEN, OCCLUSION_DRAFT_PREFIX, OCCLUSION_FIELD, OCCLUSION_TAG,
};

// ============================================================================
// fixture 构造
// ============================================================================

/// 坐标全部选二进制可精确表示的分数（0.25 / 0.5 / 0.125…），
/// 使「JSON 序列化 → 回读」的 f32 比较可以用严格相等，不引入容差噪声。
fn fixture_box(x: f32, y: f32, w: f32, h: f32, label: &str, cloze: u32) -> OcclusionBox {
    OcclusionBox {
        x,
        y,
        w,
        h,
        label: label.to_string(),
        cloze_index: Some(cloze),
    }
}

/// 心脏解剖图 fixture：两盒、互不重叠、全部在 [0,1] 内。
fn heart_spec() -> OcclusionSpec {
    OcclusionSpec {
        image_ref: "vfs://images/heart-diagram.png".to_string(),
        boxes: vec![
            fixture_box(0.125, 0.25, 0.25, 0.25, "左心房", 1),
            fixture_box(0.5, 0.5, 0.25, 0.125, "右心室", 2),
        ],
    }
}

// ============================================================================
// 镜像 helper（合入生产符号后须同步/删除，见文件头注释）
// ============================================================================

/// 【镜像】Anki 23.10+ 原生 IO note type 的 Occlusion 字段 cloze 公式。
///
/// **应与生产函数 `anki_image_occlusion::format_anki_io_cloze` 逐字节一致**：
/// - 语法：`{{cN::image-occlusion:rect:left=L:top=T:width=W:height=H}}`；
/// - 坐标为 **0–1 归一化小数**（对齐 Anki 官方 `to-cloze.ts` 示例
///   `top=.1:left=.23:width=.4:height=.5`）：夹取 [0,1]、最多 4 位小数、
///   去尾零、前导点风格（`0.125` → `.125`）；**禁止 ×100 百分数**；
/// - `N` 取盒的 1-based cloze 序号；多盒按 Anki 编辑器惯例无分隔符拼接。
fn format_anki_io_cloze_mirror(boxes: &[OcclusionBox]) -> String {
    let coord = |v: f32| {
        let norm = f64::from(v).clamp(0.0, 1.0);
        let s = format!("{norm:.4}");
        let s = s.trim_end_matches('0').trim_end_matches('.');
        match s.strip_prefix("0.") {
            Some(frac) => format!(".{frac}"),
            None => s.to_string(),
        }
    };
    boxes
        .iter()
        .map(|b| {
            format!(
                "{{{{c{}::image-occlusion:rect:left={}:top={}:width={}:height={}}}}}",
                b.cloze_index.unwrap_or(1),
                coord(b.x),
                coord(b.y),
                coord(b.w),
                coord(b.h)
            )
        })
        .collect::<Vec<_>>()
        .concat()
}

/// 【镜像】导出过滤谓词（r1-05 §5.3）：`_` 前缀 = 机器协议字段，不得导出。
///
/// 应与 apkg/ankiconnect 侧统一落地的 `is_internal_protocol_field` 等价。
fn is_internal_protocol_field_mirror(key: &str) -> bool {
    key.starts_with('_')
}

/// 【镜像】`image_ref` → APKG/AnkiConnect 包内媒体文件名的最小解析约定：
/// 取最后一段 `/` 或 `\` 路径分量并去首尾空白；空引用/以分隔符结尾
/// （无文件名部分）返回 None。
///
/// 语义对齐生产侧私有 helper `anki_image_occlusion::image_ref_basename`；
/// 导出侧媒体收集（`collect_media_entries` 一类）对 `_occlusion.imageRef`
/// 的解析应与之兼容。
fn media_file_name_from_image_ref_mirror(image_ref: &str) -> Option<String> {
    let name = image_ref.rsplit(['/', '\\']).next().unwrap_or("").trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

// ============================================================================
// 覆盖矩阵 1：build_card_fields 产出 text cloze + _occlusion + tag
// ============================================================================

#[test]
fn test_build_card_fields_produces_text_cloze_occlusion_field_and_tag() {
    let validated =
        validate_spec(&heart_spec(), &OcclusionConfig::default()).expect("fixture 应通过校验");
    let fields = build_card_fields(&validated, Some("heart-diagram.png"), Some("心脏解剖图"));

    // Text：<img> + 每盒一个 {{cN::label}} cloze
    assert_eq!(
        fields.text,
        "<img src=\"heart-diagram.png\"><br>{{c1::左心房}} {{c2::右心室}}"
    );

    // extra_fields：_occlusion 协议字段（JSON）+ Extra 提示字段
    let occlusion_json = fields
        .extra_fields
        .get(OCCLUSION_FIELD)
        .expect("入库形状必须携带 _occlusion 协议字段");
    assert!(
        occlusion_json.contains("\"imageRef\""),
        "_occlusion 序列化契约为 camelCase：{occlusion_json}"
    );
    assert_eq!(
        fields.extra_fields.get("Extra").map(String::as_str),
        Some("心脏解剖图")
    );

    // tag：image-occlusion（转换侧按此识别遮挡卡）
    assert_eq!(fields.tags, vec![OCCLUSION_TAG.to_string()]);
    assert_eq!(OCCLUSION_FIELD, "_occlusion");
    assert_eq!(OCCLUSION_TAG, "image-occlusion");
}

// ============================================================================
// 覆盖矩阵 2：parse 回读 spec 坐标不变
// ============================================================================

#[test]
fn test_parse_occlusion_field_roundtrip_preserves_coordinates() {
    let source = heart_spec();
    let validated =
        validate_spec(&source, &OcclusionConfig::default()).expect("fixture 应通过校验");
    let fields = build_card_fields(&validated, Some("heart-diagram.png"), None);

    let parsed = parse_occlusion_field(&fields.extra_fields)
        .expect("_occlusion 字段应可回读为 OcclusionSpec");

    assert_eq!(parsed.image_ref, source.image_ref);
    assert_eq!(parsed.boxes.len(), source.boxes.len());
    for (i, (got, want)) in parsed.boxes.iter().zip(source.boxes.iter()).enumerate() {
        // 坐标为二进制可精确表示的分数，roundtrip 必须严格逐位相等
        assert_eq!(got.x, want.x, "盒 #{i} x 坐标 roundtrip 漂移");
        assert_eq!(got.y, want.y, "盒 #{i} y 坐标 roundtrip 漂移");
        assert_eq!(got.w, want.w, "盒 #{i} w 坐标 roundtrip 漂移");
        assert_eq!(got.h, want.h, "盒 #{i} h 坐标 roundtrip 漂移");
        assert_eq!(got.cloze_index, want.cloze_index, "盒 #{i} cloze 序号漂移");
        assert_eq!(got.label, want.label, "盒 #{i} 标签漂移");
    }
}

// ============================================================================
// 覆盖矩阵 3：IO cloze 语法含 image-occlusion:rect 且坐标为 0–1 归一化小数
// ============================================================================

// 直接测生产函数 `format_anki_io_cloze`（本轮已合入 pub 符号），并用测试内
// 公式镜像交叉校验（生产侧静默改公式会转红，见文件头「同步义务」）。
#[test]
fn test_io_cloze_syntax_contains_image_occlusion_rect_with_normalized_coords() {
    let validated =
        validate_spec(&heart_spec(), &OcclusionConfig::default()).expect("fixture 应通过校验");

    let rendered = format_anki_io_cloze(&validated);

    // 语法骨架：cloze 包裹 + image-occlusion:rect 标记，每盒一段
    assert!(
        rendered.contains("image-occlusion:rect"),
        "IO cloze 必须含 image-occlusion:rect：{rendered}"
    );
    assert!(rendered.starts_with("{{c1::") && rendered.ends_with("}}"));
    assert!(rendered.contains("{{c2::image-occlusion:rect:"));

    // 坐标为 0–1 归一化小数（0.125 → .125、0.25 → .25，官方 to-cloze.ts
    // 前导点风格），不是 ×100 百分数
    assert_eq!(
        rendered,
        "{{c1::image-occlusion:rect:left=.125:top=.25:width=.25:height=.25}}\
         {{c2::image-occlusion:rect:left=.5:top=.5:width=.25:height=.125}}"
    );

    // 交叉校验：生产函数与测试侧公式镜像逐字节一致
    assert_eq!(
        rendered,
        format_anki_io_cloze_mirror(&validated.boxes),
        "生产 format_anki_io_cloze 与测试镜像公式失同步"
    );

    // 归一化值域自证：全部落在 [0,1]（排除 ×100 百分数残留）
    for b in &validated.boxes {
        for (name, v) in [("left", b.x), ("top", b.y), ("width", b.w), ("height", b.h)] {
            assert!((0.0..=1.0).contains(&v), "{name} 归一化坐标越界：{v}");
        }
    }
    assert!(
        !rendered.contains("left=12.5") && !rendered.contains("top=25"),
        "坐标疑似仍是 ×100 百分数（会让 Anki 遮罩放大 100 倍）：{rendered}"
    );
}

// ============================================================================
// 覆盖矩阵 4：导出 fields 不含 _occlusion/_qa_flags/_original_generation
// ============================================================================

// 注：apkg/anki_connect 的转换函数非 pub，本测试不改其可见性，改为在测试内
// 复述「`_` 前缀不得导出」谓词（is_internal_protocol_field_mirror）并对一份
// 模拟 note fields 做过滤断言。导出侧落地统一谓词后本测试即为协议回归锁。
#[test]
fn test_export_fields_filter_excludes_underscore_protocol_fields() {
    let validated =
        validate_spec(&heart_spec(), &OcclusionConfig::default()).expect("fixture 应通过校验");
    let card_fields = build_card_fields(&validated, Some("heart-diagram.png"), Some("提示"));

    // 模拟入库后的完整 note fields：生成字段 + 其他机器协议字段
    let mut note_fields: HashMap<String, String> = card_fields.extra_fields.clone();
    note_fields.insert("Text".to_string(), card_fields.text.clone());
    note_fields.insert(
        "_qa_flags".to_string(),
        r#"{"qaPass":true,"codes":[]}"#.to_string(),
    );
    note_fields.insert(
        "_original_generation".to_string(),
        r#"{"front":"原始生成快照"}"#.to_string(),
    );
    assert!(
        note_fields.contains_key(OCCLUSION_FIELD),
        "前置条件：入库形状确实携带 _occlusion"
    );

    // 导出过滤（镜像谓词）
    let exported: HashMap<&String, &String> = note_fields
        .iter()
        .filter(|(k, _)| !is_internal_protocol_field_mirror(k))
        .collect();

    // 三个协议字段一个都不许出现
    for protocol_key in [OCCLUSION_FIELD, "_qa_flags", "_original_generation"] {
        assert!(
            !exported.keys().any(|k| k.as_str() == protocol_key),
            "导出产物泄漏协议字段 {protocol_key}"
        );
    }
    // 泛化断言：导出产物中不得存在任何 _ 前缀键
    assert!(
        exported.keys().all(|k| !k.starts_with('_')),
        "导出产物存在 _ 前缀键：{:?}",
        exported.keys().collect::<Vec<_>>()
    );
    // 用户内容字段必须保留（过滤不能误伤）
    assert!(exported.keys().any(|k| k.as_str() == "Text"));
    assert!(exported.keys().any(|k| k.as_str() == "Extra"));
}

// ============================================================================
// 覆盖矩阵 5：旧卡无 _occlusion 不误走转换
// ============================================================================

#[test]
fn test_legacy_card_without_occlusion_field_skips_conversion() {
    // 旧普通卡：有用户字段、有其他协议字段，但没有 _occlusion
    let mut legacy_fields: HashMap<String, String> = HashMap::new();
    legacy_fields.insert(
        "Text".to_string(),
        "{{c1::线粒体}}是细胞的能量工厂".to_string(),
    );
    legacy_fields.insert("Extra".to_string(), "生物学基础".to_string());
    legacy_fields.insert(
        "_qa_flags".to_string(),
        r#"{"qaPass":true,"codes":[]}"#.to_string(),
    );

    // 转换路由谓词 = parse_occlusion_field 是否为 Some；旧卡必须是 None
    assert!(
        parse_occlusion_field(&legacy_fields).is_none(),
        "无 _occlusion 的旧卡不得被判定为遮挡卡"
    );

    // _occlusion 存在但 JSON 不合法：同样不得进转换（返回 None，不 panic）
    let mut corrupted_fields = legacy_fields.clone();
    corrupted_fields.insert(OCCLUSION_FIELD.to_string(), "{not-json".to_string());
    assert!(
        parse_occlusion_field(&corrupted_fields).is_none(),
        "坏 JSON 的 _occlusion 必须被拒，不得半解析进转换"
    );

    // 完全空 fields：同样 None
    assert!(parse_occlusion_field(&HashMap::new()).is_none());
}

// ============================================================================
// 覆盖矩阵 6：image_ref 能映射为媒体文件名
// ============================================================================

#[test]
fn test_image_ref_maps_to_media_file_name() {
    // 四种调用方语境的 image_ref 形态（vfs 引用 / 本地路径 / Windows 路径 / 裸文件名）
    for (image_ref, want) in [
        ("vfs://images/heart-diagram.png", "heart-diagram.png"),
        ("/data/media/cell structure.png", "cell structure.png"),
        (r"C:\media\neuron.png", "neuron.png"),
        ("plain-name.png", "plain-name.png"),
    ] {
        assert_eq!(
            media_file_name_from_image_ref_mirror(image_ref).as_deref(),
            Some(want),
            "image_ref={image_ref}"
        );
    }

    // 解析出的媒体文件名可直接喂给 build_card_fields → Text 内出现 <img src>
    let validated =
        validate_spec(&heart_spec(), &OcclusionConfig::default()).expect("fixture 应通过校验");
    let media_name = media_file_name_from_image_ref_mirror(&validated.image_ref)
        .expect("fixture image_ref 应能解析出媒体文件名");
    assert_eq!(media_name, "heart-diagram.png");
    let fields = build_card_fields(&validated, Some(&media_name), None);
    assert!(
        fields
            .text
            .starts_with("<img src=\"heart-diagram.png\"><br>"),
        "媒体文件名应嵌入 Text 的 <img>：{}",
        fields.text
    );

    // 无文件名可解析的引用返回 None（导出侧据此走「无媒体」降级而非 panic）
    assert!(media_file_name_from_image_ref_mirror("").is_none());
    assert!(media_file_name_from_image_ref_mirror("   ").is_none());
    assert!(media_file_name_from_image_ref_mirror("vfs://images/").is_none());
}

// ============================================================================
// 覆盖矩阵 7：空 image_ref / 非法 spec 不 panic
// ============================================================================

#[test]
fn test_empty_image_ref_and_invalid_spec_do_not_panic() {
    let cfg = OcclusionConfig::default();

    // 空 image_ref：结构化拒绝（empty_image_ref），不 panic
    let empty_ref = OcclusionSpec {
        image_ref: "   ".to_string(),
        boxes: vec![fixture_box(0.125, 0.25, 0.25, 0.25, "盒", 1)],
    };
    let issues = validate_spec(&empty_ref, &cfg).expect_err("空 image_ref 必须被拒");
    assert!(
        issues.iter().any(|i| i.code == "empty_image_ref"),
        "违规码应含 empty_image_ref：{issues:?}"
    );

    // 空盒列表：结构化拒绝（empty_boxes）
    let empty_boxes = OcclusionSpec {
        image_ref: "vfs://images/x.png".to_string(),
        boxes: vec![],
    };
    let issues = validate_spec(&empty_boxes, &cfg).expect_err("空盒列表必须被拒");
    assert!(issues.iter().any(|i| i.code == "empty_boxes"));

    // NaN / 越界 / 零 cloze 序号混合的非法 spec：全部结构化拒绝，不 panic
    let mut zero_cloze = fixture_box(0.5, 0.5, 0.25, 0.25, "零序号", 1);
    zero_cloze.cloze_index = Some(0);
    let invalid = OcclusionSpec {
        image_ref: "vfs://images/x.png".to_string(),
        boxes: vec![
            fixture_box(f32::NAN, 0.25, 0.25, 0.25, "NaN 盒", 1),
            fixture_box(0.875, 0.25, 0.5, 0.25, "越界盒", 2),
            zero_cloze,
        ],
    };
    let issues = validate_spec(&invalid, &cfg).expect_err("非法 spec 必须被拒");
    let codes: Vec<&str> = issues.iter().map(|i| i.code.as_str()).collect();
    assert!(codes.contains(&"box_not_finite"), "codes={codes:?}");
    assert!(codes.contains(&"box_out_of_bounds"), "codes={codes:?}");
    assert!(codes.contains(&"cloze_index_zero"), "codes={codes:?}");

    // 非法 spec 被拒后不存在 ValidatedOcclusionSpec，转换链天然短路；
    // 镜像的媒体解析对空引用同样只返回 None（已在矩阵 6 锁定）。
    assert!(media_file_name_from_image_ref_mirror("").is_none());
}

// ============================================================================
// 覆盖矩阵 8（r7 追加）：入库 images 接线 —— occlusion_image_ref_from_fields
// ============================================================================

// 生产接线（streaming_anki_service.rs 入库点）：`card.images` 为空时才用
// `occlusion_image_ref_from_fields(&extra_fields)` 从 `_occlusion.imageRef`
// 填充；本测试直接锁该 pub 函数的三种入库形状语义。
#[test]
fn test_ingest_images_wiring_populates_from_occlusion_image_ref() {
    // 1) 生成字段 roundtrip（camelCase 契约）：build_card_fields 产出的
    //    _occlusion 能解析出完整 vfs:// 引用，喂给 images
    let validated =
        validate_spec(&heart_spec(), &OcclusionConfig::default()).expect("fixture 应通过校验");
    let fields = build_card_fields(&validated, Some("heart-diagram.png"), None);

    let mut images: Vec<String> = Vec::new();
    // 复刻生产入库点的「images 为空才填充」guard
    if images.is_empty() {
        if let Some(image_ref) = occlusion_image_ref_from_fields(&fields.extra_fields) {
            images.push(image_ref);
        }
    }
    assert_eq!(
        images,
        vec!["vfs://images/heart-diagram.png".to_string()],
        "入库形状：images 应由 _occlusion.imageRef 填充完整引用"
    );

    // 2) snake_case 旧数据容忍：image_ref 键仍可填充 images；
    //    但 parse_occlusion_field 走 serde camelCase 契约（缺 imageRef 即
    //    None）——旧 snake_case 数据只影响 images 填充，不进遮挡转换
    let mut snake_fields: HashMap<String, String> = HashMap::new();
    snake_fields.insert(
        OCCLUSION_FIELD.to_string(),
        r#"{"image_ref":"legacy-diagram.png","boxes":[]}"#.to_string(),
    );
    assert_eq!(
        occlusion_image_ref_from_fields(&snake_fields).as_deref(),
        Some("legacy-diagram.png"),
        "snake_case 旧数据应被容忍（images 仍可填充）"
    );
    assert!(
        parse_occlusion_field(&snake_fields).is_none(),
        "snake_case 缺 camelCase imageRef，不得进遮挡转换"
    );

    // 3) 旧卡（无 _occlusion）：不填充 images，也不 panic
    let mut legacy_fields: HashMap<String, String> = HashMap::new();
    legacy_fields.insert("Text".to_string(), "{{c1::线粒体}}".to_string());
    assert!(
        occlusion_image_ref_from_fields(&legacy_fields).is_none(),
        "旧卡无 _occlusion，images 不得被填充"
    );
    // 引用为空/纯空白：同样 None（与矩阵 6 镜像解析的降级语义一致）
    let mut blank_ref: HashMap<String, String> = HashMap::new();
    blank_ref.insert(
        OCCLUSION_FIELD.to_string(),
        r#"{"imageRef":"   ","boxes":[]}"#.to_string(),
    );
    assert!(occlusion_image_ref_from_fields(&blank_ref).is_none());
}

// ============================================================================
// 覆盖矩阵 9（r7 追加）：vlm://pending 占位端到端不入 images
// ============================================================================

// r2 契约 §2.1 / r6-01 补丁：未被生产接线替换的 `vlm://pending-image` 不是
// 可解析媒体，不得进 `card.images`；但占位只影响 images，不阻断草稿入库
// （_occlusion 与 tag 照常携带）。本测试走完整 VLM 端到端链路做回归锁。
#[test]
fn test_vlm_pending_placeholder_image_ref_stays_out_of_images_end_to_end() {
    // 1) VLM 坐标块 → spec：parse_occlusion_boxes_from_vlm 不负责选图，
    //    产出的 image_ref 必须是占位字面值 vlm://pending-image
    let vlm_text = format!(
        "图中标注了两个心腔。\n{}\n```json\n[\n  \
         {{\"x\":0.125,\"y\":0.25,\"w\":0.25,\"h\":0.25,\"label\":\"左心房\",\"clozeIndex\":1}},\n  \
         {{\"x\":0.5,\"y\":0.5,\"w\":0.25,\"h\":0.125,\"label\":\"右心室\",\"clozeIndex\":2}}\n]\n```\n{}\n后续讲解。",
        OCCLUSION_BOXES_OPEN, OCCLUSION_BOXES_CLOSE
    );
    let pending_spec = parse_occlusion_boxes_from_vlm(&vlm_text).expect("合法坐标块应解析出 spec");
    assert_eq!(
        pending_spec.image_ref, "vlm://pending-image",
        "VLM 解析产出的必须是占位引用"
    );

    // 2) 模拟「生产接线未替换占位」的暴露面（模型直出/旧数据/未来未接线
    //    路径）：占位 spec 直接走 marker → 入库字段
    let marker = build_occlusion_draft_marker_from_spec(&pending_spec, &OcclusionConfig::default())
        .expect("占位引用非空，marker 应能构造");
    let fields = extract_occlusion_draft_fields(&marker).expect("marker 应能还原入库字段");

    // 入库形状照常：_occlusion 携带占位引用、tag 在位、cloze 正文在位
    let occlusion_json = fields
        .extra_fields
        .get(OCCLUSION_FIELD)
        .expect("占位草稿仍应携带 _occlusion（占位只影响 images，不阻断入库）");
    assert!(occlusion_json.contains("vlm://pending-image"));
    assert_eq!(fields.tags, vec![OCCLUSION_TAG.to_string()]);
    assert!(fields.text.contains("{{c1::左心房}}"));
    // （占位 text 的 <img src="pending-image"> 残留是 r6-01 记录的遗留项，
    //  归属后续轮次裁决，此处不锁 text 的 <img> 形态。）

    // 3) 核心断言：占位引用不入 images —— 入库点解析必须返回 None
    let mut images: Vec<String> = Vec::new();
    if images.is_empty() {
        if let Some(image_ref) = occlusion_image_ref_from_fields(&fields.extra_fields) {
            images.push(image_ref);
        }
    }
    assert!(
        images.is_empty(),
        "vlm://pending-image 占位不得进 card.images：{images:?}"
    );

    // 4) 过滤是 scheme 级的：任意 vlm:// 引用、含前后空白的占位均被拒；
    //    真实 vfs:// 引用不受影响
    for pending_json in [
        r#"{"imageRef":"vlm://pending-image","boxes":[]}"#,
        r#"{"imageRef":"  vlm://pending-image  ","boxes":[]}"#,
        r#"{"imageRef":"vlm://other-placeholder","boxes":[]}"#,
    ] {
        let mut f: HashMap<String, String> = HashMap::new();
        f.insert(OCCLUSION_FIELD.to_string(), pending_json.to_string());
        assert!(
            occlusion_image_ref_from_fields(&f).is_none(),
            "vlm:// scheme 必须整体被过滤：{pending_json}"
        );
    }
    let mut real: HashMap<String, String> = HashMap::new();
    real.insert(
        OCCLUSION_FIELD.to_string(),
        r#"{"imageRef":"vfs://images/heart-diagram.png","boxes":[]}"#.to_string(),
    );
    assert_eq!(
        occlusion_image_ref_from_fields(&real).as_deref(),
        Some("vfs://images/heart-diagram.png"),
        "真实 vfs:// 引用不得被占位过滤误伤"
    );
}

// ============================================================================
// 覆盖矩阵 10（r7 追加）：IO 坐标 clamp/舍入白盒（0–1 值域深度防御）
// ============================================================================

// format_anki_io_cloze 的 clamp [0,1] 是深度防御：validate_spec 会拒掉越界
// spec，正常链路触达不了该分支，只能绕过校验直构 ValidatedOcclusionSpec
// （字段 pub）做白盒。矩阵 3 锁「合法输入的归一化输出」，本矩阵补锁
// 「非法输入也绝不产出 [0,1] 之外的坐标（更不会是 ×100 百分数）」。
#[test]
fn test_io_cloze_coords_clamped_and_rounded_to_unit_interval() {
    let spec = ValidatedOcclusionSpec {
        image_ref: "vfs://images/x.png".to_string(),
        boxes: vec![
            // 全越界盒：负值夹到 0，超 1 夹到 1；整数 0/1 无前导点、无小数尾
            OcclusionBox {
                x: -0.25,
                y: 1.5,
                w: 2.5,
                h: -1.0,
                label: "越界盒".to_string(),
                cloze_index: Some(1),
            },
            // 舍入盒：1/3 → .3333（4 位截断），0.6666667 → .6667（进位），
            // 0.1234567 → .1235（进位），0.25 → .25（去尾零）
            OcclusionBox {
                x: 1.0_f32 / 3.0,
                y: 0.666_666_7,
                w: 0.123_456_7,
                h: 0.25,
                label: "舍入盒".to_string(),
                cloze_index: Some(2),
            },
        ],
    };

    let rendered = format_anki_io_cloze(&spec);
    assert_eq!(
        rendered,
        "{{c1::image-occlusion:rect:left=0:top=1:width=1:height=0}}\
         {{c2::image-occlusion:rect:left=.3333:top=.6667:width=.1235:height=.25}}"
    );

    // 与测试侧公式镜像交叉校验（clamp/舍入分支同样不许失同步）
    assert_eq!(
        rendered,
        format_anki_io_cloze_mirror(&spec.boxes),
        "clamp/舍入分支：生产函数与测试镜像公式失同步"
    );

    // 值域自证：输出串里所有坐标 token 均无 ×100 痕迹
    assert!(
        !rendered.contains("=150") && !rendered.contains("=250") && !rendered.contains("=-"),
        "越界输入疑似泄漏出 [0,1] 之外的坐标：{rendered}"
    );
}

// ============================================================================
// 覆盖矩阵 11（r7 追加）：draft marker 全链路（生成 → 入库 → 导出过滤）
// ============================================================================

#[test]
fn test_occlusion_draft_marker_pipeline_end_to_end_to_export_filter() {
    // 1) 生成：真实引用的 spec → 内部草稿 marker（行协议前缀 + JSON + `]`）
    let marker = build_occlusion_draft_marker_from_spec(&heart_spec(), &OcclusionConfig::default())
        .expect("合法 spec 应能构造 marker");
    assert!(marker.starts_with(OCCLUSION_DRAFT_PREFIX) && marker.ends_with(']'));

    // 2) marker 混入分段内容后：模型可见内容剥离 marker，正文行保留
    let segment = format!("正文第一行\n{marker}\n正文第二行");
    let model_visible = strip_occlusion_draft_markers(&segment);
    assert!(
        !model_visible.contains(OCCLUSION_DRAFT_PREFIX),
        "marker 不得成为模型可见内容"
    );
    assert!(model_visible.contains("正文第一行") && model_visible.contains("正文第二行"));

    // 3) 入库：同一分段还原出生成字段（<img> + cloze + _occlusion + tag）
    let fields = extract_occlusion_draft_fields(&segment).expect("含 marker 的分段应还原字段");
    assert!(
        fields
            .text
            .starts_with("<img src=\"heart-diagram.png\"><br>"),
        "Text 应以 image_ref basename 的 <img> 开头：{}",
        fields.text
    );
    assert!(fields.text.contains("{{c1::左心房}}") && fields.text.contains("{{c2::右心室}}"));
    assert_eq!(fields.tags, vec![OCCLUSION_TAG.to_string()]);

    // 4) 回读：坐标严格逐位不漂移（fixture 全部二进制可精确表示）
    let parsed = parse_occlusion_field(&fields.extra_fields).expect("_occlusion 应可回读为 spec");
    let source = heart_spec();
    assert_eq!(parsed.image_ref, source.image_ref);
    assert_eq!(parsed.boxes, source.boxes, "全链路坐标/标签/序号漂移");

    // 5) images 接线：入库点应解析出完整 vfs:// 引用
    assert_eq!(
        occlusion_image_ref_from_fields(&fields.extra_fields).as_deref(),
        Some("vfs://images/heart-diagram.png")
    );

    // 6) 导出过滤：_occlusion 等 _ 前缀协议字段不出导出产物，用户字段保留
    let mut note_fields: HashMap<String, String> = fields.extra_fields.clone();
    note_fields.insert("Text".to_string(), fields.text.clone());
    let exported: Vec<&String> = note_fields
        .keys()
        .filter(|k| !is_internal_protocol_field_mirror(k))
        .collect();
    assert!(
        exported.iter().all(|k| !k.starts_with('_')),
        "导出产物存在 _ 前缀键：{exported:?}"
    );
    assert!(
        !exported.iter().any(|k| k.as_str() == OCCLUSION_FIELD),
        "导出产物泄漏 _occlusion"
    );
    assert!(exported.iter().any(|k| k.as_str() == "Text"));
}
