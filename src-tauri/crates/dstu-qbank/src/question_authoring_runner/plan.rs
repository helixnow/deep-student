//! Deterministic, lossless range planning for sources that exceed a provider limit.
//!
//! Planning never trims or rewrites source evidence. It only proposes page ranges
//! whose union is exactly the original page set. Chapter boundaries are hints from
//! the native text layer; when a safe boundary cannot be proven, the plan is marked
//! as requiring an explicit user selection instead of being accepted automatically.

use super::{SourceBundle, SourceRange};
use crate::llm_manager::ApiConfig;
use crate::models::AppError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const SOURCE_RANGE_PLAN_SCHEMA_VERSION: u32 = 1;
pub const SOURCE_RANGE_PLAN_REQUIRED_CODE: &str = "SOURCE_RANGE_PLAN_REQUIRED";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceLimitReason {
    ContextWindow,
    ImageCount,
    RequestSize,
}

impl SourceLimitReason {
    pub fn code(self) -> &'static str {
        match self {
            Self::ContextWindow => "CONTEXT_LIMIT",
            Self::ImageCount => "PROVIDER_IMAGE_LIMIT",
            Self::RequestSize => "PROVIDER_REQUEST_SIZE_LIMIT",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Self::ContextWindow => "模型上下文窗口无法容纳完整来源",
            Self::ImageCount => "供应商单次请求图片数量受限",
            Self::RequestSize => "供应商单次请求体大小受限",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChapterBoundary {
    pub source_id: String,
    pub page: u32,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlannedRange {
    pub source_id: String,
    pub start_page: u32,
    pub end_page: u32,
    pub page_count: u32,
    pub starts_at_chapter: bool,
    pub ends_at_chapter: bool,
    pub chapter_labels: Vec<String>,
    /// True only when a deterministic boundary proves this range does not cut a
    /// chapter, shared material, or an answer relationship.
    pub dependency_safe: bool,
    pub estimated_input_tokens: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRangePlan {
    pub schema_version: u32,
    pub reason: SourceLimitReason,
    pub total_pages: u32,
    pub ranges: Vec<PlannedRange>,
    pub chapter_boundaries: Vec<ChapterBoundary>,
    /// True only when every range boundary is proven dependency-safe.
    pub automatic: bool,
    /// When true the caller/UI must let the user select ranges explicitly.
    pub requires_user_selection: bool,
    /// Initial 1-20 page requests are always attempted whole; a plan for such a
    /// source is only a manual fallback after the provider actually rejected it.
    pub one_request_policy: bool,
    pub warnings: Vec<String>,
}

impl SourceRangePlan {
    pub fn source_ranges(&self) -> Vec<SourceRange> {
        self.ranges
            .iter()
            .map(|range| SourceRange::pages(&range.source_id, range.start_page, range.end_page))
            .collect()
    }

    /// Verify that the plan is a partition of every original page: no page is
    /// skipped, duplicated, or invented.
    pub fn validate(&self, bundle: &SourceBundle) -> Result<(), AppError> {
        if self.schema_version != SOURCE_RANGE_PLAN_SCHEMA_VERSION {
            return Err(AppError::validation("范围计划版本不受支持"));
        }
        let mut expected = BTreeMap::<String, BTreeSet<u32>>::new();
        for page in &bundle.pages {
            expected
                .entry(page.source_id.clone())
                .or_default()
                .insert(page.page);
        }
        let mut seen = BTreeMap::<String, BTreeSet<u32>>::new();
        for range in &self.ranges {
            if range.start_page == 0 || range.end_page < range.start_page {
                return Err(AppError::validation("范围计划包含无效页码"));
            }
            let pages = seen.entry(range.source_id.clone()).or_default();
            for page in range.start_page..=range.end_page {
                if !pages.insert(page) {
                    return Err(AppError::validation(format!(
                        "范围计划重复声明 {} 第 {page} 页",
                        range.source_id
                    )));
                }
            }
        }
        if seen != expected {
            return Err(AppError::validation(
                "范围计划未精确覆盖全部原始页（存在跳过或缺失），不能自动接受",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct RangePlanOptions {
    pub max_pages_per_range: usize,
    pub max_estimated_tokens_per_range: Option<usize>,
}

impl Default for RangePlanOptions {
    fn default() -> Self {
        Self {
            max_pages_per_range: 20,
            max_estimated_tokens_per_range: None,
        }
    }
}

impl RangePlanOptions {
    /// Conservative planning budget used only after the provider rejected a whole
    /// request. The configured context window is diagnostic input; it is never
    /// sent as an API parameter and it never authorises clipping.
    pub fn after_provider_limit(config: &ApiConfig) -> Self {
        let budget = config.context_window.map(|window| {
            let window = window as usize;
            let output = config.max_output_tokens as usize;
            window
                .saturating_sub(output)
                .saturating_mul(4)
                .saturating_div(5)
        });
        Self {
            max_pages_per_range: 20,
            max_estimated_tokens_per_range: budget.filter(|budget| *budget > 0),
        }
    }
}

/// Detect an actual provider-side input limit from a failed request. Output
/// truncation (`finish_reason=length`) is deliberately not treated as an input
/// limit because splitting source ranges cannot justify silently changing the
/// semantic request.
pub fn detect_provider_limit(error: &AppError) -> Option<SourceLimitReason> {
    if crate::llm_manager::routing::llm_error_code(error)
        == Some(crate::llm_manager::routing::LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED)
    {
        return Some(SourceLimitReason::ContextWindow);
    }
    let details = error.details.as_ref();
    let status = details
        .and_then(|details| details.get("status"))
        .and_then(Value::as_u64);
    let body = details
        .and_then(|details| details.get("body"))
        .map(|body| match body {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default();
    let haystack = format!(
        "{} {} {}",
        error.message,
        body,
        details.map(Value::to_string).unwrap_or_default()
    )
    .to_ascii_lowercase();
    if crate::llm_manager::routing::provider_body_indicates_context_window(&haystack) {
        return Some(SourceLimitReason::ContextWindow);
    }
    if status.is_none() || matches!(status, Some(400 | 413 | 422)) {
        const IMAGE_LIMIT: &[&str] = &[
            "too many images",
            "maximum number of images",
            "max images",
            "image count",
            "images per request",
            "image limit",
            "图片数量",
            "图片过多",
            "图片超出",
        ];
        if IMAGE_LIMIT
            .iter()
            .any(|needle| haystack.contains(&needle.to_ascii_lowercase()))
        {
            return Some(SourceLimitReason::ImageCount);
        }
        const REQUEST_SIZE: &[&str] = &[
            "request too large",
            "payload too large",
            "request entity too large",
            "body too large",
            "content too large",
            "request size",
        ];
        if status == Some(413) || REQUEST_SIZE.iter().any(|needle| haystack.contains(needle)) {
            return Some(SourceLimitReason::RequestSize);
        }
    }
    None
}

/// Build a deterministic range plan. The returned plan always covers every page
/// exactly once. `automatic` is false whenever chapter/dependency/answer safety
/// cannot be proven from the native text layer.
pub fn plan_source_ranges(
    bundle: &SourceBundle,
    reason: SourceLimitReason,
    options: &RangePlanOptions,
) -> Result<SourceRangePlan, AppError> {
    if bundle.is_scoped() {
        return Err(AppError::validation(
            "范围计划必须基于完整原始来源生成，不能基于已裁剪范围再次规划",
        ));
    }
    if bundle.pages.is_empty() {
        return Err(AppError::validation(
            "来源没有可核验的分页边界，无法制定无页跳过范围计划；请整份提供或改用支持更长输入的模型",
        ));
    }
    if options.max_pages_per_range == 0 {
        return Err(AppError::validation("范围计划单批页数必须为正数"));
    }

    let mut warnings = Vec::new();
    let mut chapter_boundaries = Vec::new();
    let mut page_text: BTreeMap<(String, u32), String> = BTreeMap::new();
    let mut pages_by_source = BTreeMap::<String, Vec<u32>>::new();
    for page in &bundle.pages {
        if pages_by_source
            .entry(page.source_id.clone())
            .or_default()
            .contains(&page.page)
        {
            return Err(AppError::validation(format!(
                "来源 {} 第 {} 页重复，无法制定可核验范围计划",
                page.source_id, page.page
            )));
        }
        pages_by_source
            .entry(page.source_id.clone())
            .or_default()
            .push(page.page);
        page_text.insert(
            (page.source_id.clone(), page.page),
            page.text_hint.clone().unwrap_or_default(),
        );
    }
    for pages in pages_by_source.values_mut() {
        pages.sort_unstable();
    }

    let has_unpaged_source = bundle.sources.iter().any(|source| {
        source["page_count"].is_null()
            && source["source_id"]
                .as_str()
                .is_some_and(|id| !pages_by_source.contains_key(id))
    });
    if has_unpaged_source {
        warnings.push(
            "存在无分页正文来源，无法按页边界确定性拆分；只能整份提供或由用户明确选择".to_string(),
        );
    }

    let mut has_answer_section = false;
    let mut has_missing_native_text = false;
    for (source_id, pages) in &pages_by_source {
        for (index, page_no) in pages.iter().enumerate() {
            let text = page_text
                .get(&(source_id.clone(), *page_no))
                .cloned()
                .unwrap_or_default();
            if text.trim().is_empty() {
                has_missing_native_text = true;
            }
            if let Some(label) = detect_chapter_heading(&text) {
                if is_answer_section(&label) {
                    has_answer_section = true;
                }
                chapter_boundaries.push(ChapterBoundary {
                    source_id: source_id.clone(),
                    page: *page_no,
                    label,
                });
            }
            if index > 0
                && ends_with_forward_reference(
                    page_text
                        .get(&(source_id.clone(), pages[index - 1]))
                        .map(String::as_str)
                        .unwrap_or(""),
                )
                && starts_with_continuation(&text)
            {
                warnings.push(format!(
                    "{} 第 {}→{} 页存在跨页引用标记，章节边界未被证明安全",
                    source_id,
                    pages[index - 1],
                    page_no
                ));
            }
        }
    }
    if has_missing_native_text {
        warnings.push("部分页没有原生文字层，无法用正文确定章节边界；需用户核对页范围".to_string());
    }
    if has_answer_section {
        warnings.push(
            "检测到独立答案/解析区，无法证明每题与答案页的完整依赖；不能自动接受分批".to_string(),
        );
    }

    let max_pages = options.max_pages_per_range;
    let mut ranges = Vec::new();
    for (source_id, pages) in &pages_by_source {
        let segments = build_segments(source_id, pages, &page_text, &mut warnings);
        let mut chunks: Vec<Segment> = Vec::new();
        for segment in segments {
            if segment.len() as usize > max_pages
                || options
                    .max_estimated_tokens_per_range
                    .is_some_and(|budget| segment.estimated_tokens as usize > budget)
            {
                warnings.push(format!(
                    "{} 第 {}–{} 页的章节超过单批预算，只能在页边界强制切分；题组/材料/答案依赖未被证明安全",
                    source_id, segment.start, segment.end
                ));
                let mut chunk_start = segment.start;
                while chunk_start <= segment.end {
                    let mut chunk_end = chunk_start;
                    let mut chunk_tokens = 0u32;
                    while chunk_end <= segment.end
                        && (chunk_end - chunk_start) as usize <= max_pages - 1
                    {
                        let page_tokens = estimate_page_tokens(
                            page_text
                                .get(&(source_id.clone(), chunk_end))
                                .map(String::as_str)
                                .unwrap_or(""),
                        );
                        if chunk_end > chunk_start
                            && options
                                .max_estimated_tokens_per_range
                                .is_some_and(|budget| {
                                    chunk_tokens as usize + page_tokens as usize > budget
                                })
                        {
                            break;
                        }
                        chunk_tokens = chunk_tokens.saturating_add(page_tokens);
                        chunk_end += 1;
                    }
                    let end = chunk_end.saturating_sub(1);
                    if end < chunk_start {
                        break;
                    }
                    chunks.push(Segment {
                        source_id: source_id.clone(),
                        start: chunk_start,
                        end,
                        labels: segment.labels.clone(),
                        starts_safe: chunk_start == segment.start && segment.starts_safe,
                        ends_safe: end == segment.end && segment.ends_safe,
                        forced_split: true,
                        estimated_tokens: estimate_range_tokens(
                            source_id,
                            chunk_start,
                            end,
                            &page_text,
                        ),
                    });
                    if end >= segment.end {
                        break;
                    }
                    chunk_start = end + 1;
                }
            } else {
                chunks.push(segment);
            }
        }

        let mut current: Option<Segment> = None;
        for chunk in chunks {
            let fits = current.as_ref().is_some_and(|current| {
                (current.len() + chunk.len()) as usize <= max_pages
                    && options.max_estimated_tokens_per_range.is_none_or(|budget| {
                        (current.estimated_tokens as usize + chunk.estimated_tokens as usize)
                            <= budget
                    })
            });
            if fits {
                let current = current.as_mut().expect("checked above");
                current.end = chunk.end;
                current.labels.extend(chunk.labels);
                current.forced_split |= chunk.forced_split;
                current.estimated_tokens += chunk.estimated_tokens;
                current.ends_safe = chunk.ends_safe;
            } else {
                if let Some(current) = current.take() {
                    ranges.push(current);
                }
                current = Some(chunk);
            }
        }
        if let Some(current) = current {
            ranges.push(current);
        }
    }

    ranges.sort_by(|left, right| {
        left.source_id
            .cmp(&right.source_id)
            .then(left.start.cmp(&right.start))
    });
    let global_safe = !has_unpaged_source
        && !has_answer_section
        && !has_missing_native_text
        && ranges
            .iter()
            .all(|range| range.starts_safe && !range.forced_split);
    let planned = ranges
        .into_iter()
        .map(|range| PlannedRange {
            source_id: range.source_id.clone(),
            start_page: range.start,
            end_page: range.end,
            page_count: range.len(),
            starts_at_chapter: range.starts_safe,
            ends_at_chapter: range.ends_safe,
            chapter_labels: range.labels,
            dependency_safe: range.starts_safe && !range.forced_split && global_safe,
            estimated_input_tokens: range.estimated_tokens,
        })
        .collect::<Vec<_>>();

    let plan = SourceRangePlan {
        schema_version: SOURCE_RANGE_PLAN_SCHEMA_VERSION,
        reason,
        total_pages: bundle.pages.len() as u32,
        ranges: planned,
        chapter_boundaries,
        automatic: global_safe,
        requires_user_selection: !global_safe,
        one_request_policy: bundle.pages.len() <= 20,
        warnings,
    };
    plan.validate(bundle)?;
    Ok(plan)
}

pub fn plan_after_provider_limit(
    bundle: &SourceBundle,
    reason: SourceLimitReason,
    config: &ApiConfig,
) -> Result<SourceRangePlan, AppError> {
    plan_source_ranges(
        bundle,
        reason,
        &RangePlanOptions::after_provider_limit(config),
    )
}

/// Wrap the original provider failure with an explicit, user-selectable range
/// plan. The request itself is never retried with a silently reduced range.
pub fn range_plan_required_error(error: AppError, plan: SourceRangePlan) -> AppError {
    let mut details = error.details.clone().unwrap_or_else(|| json!({}));
    if let Some(object) = details.as_object_mut() {
        object.insert("code".into(), json!(SOURCE_RANGE_PLAN_REQUIRED_CODE));
        object.insert("reason".into(), json!(plan.reason.code()));
        object.insert(
            "reason_description".into(),
            json!(plan.reason.description()),
        );
        object.insert("source_route".into(), json!("provider_limit_range_plan"));
        object.insert("complete_document".into(), json!(false));
        object.insert("no_pages_skipped".into(), json!(true));
        object.insert(
            "requires_user_selection".into(),
            json!(plan.requires_user_selection),
        );
        object.insert(
            "plan".into(),
            serde_json::to_value(&plan).unwrap_or_default(),
        );
        object.insert("provider_error".into(), json!(error.message));
    }
    AppError::with_details(
        error.error_type,
        format!(
            "{}。完整来源未被自动拆分、未跳过任何页，也未创建正式题目；请选择完整证据范围后重试",
            plan.reason.description()
        ),
        details,
    )
}

#[derive(Debug, Clone)]
struct Segment {
    source_id: String,
    start: u32,
    end: u32,
    labels: Vec<String>,
    starts_safe: bool,
    ends_safe: bool,
    forced_split: bool,
    estimated_tokens: u32,
}

impl Segment {
    fn len(&self) -> u32 {
        self.end - self.start + 1
    }
}

fn build_segments(
    source_id: &str,
    pages: &[u32],
    page_text: &BTreeMap<(String, u32), String>,
    warnings: &mut Vec<String>,
) -> Vec<Segment> {
    let mut segments = Vec::new();
    let mut current: Option<Segment> = None;
    for (index, page) in pages.iter().enumerate() {
        let text = page_text
            .get(&(source_id.to_string(), *page))
            .map(String::as_str)
            .unwrap_or("");
        let label = detect_chapter_heading(text);
        let continuation = starts_with_continuation(text);
        let previous_forward = index > 0
            && ends_with_forward_reference(
                page_text
                    .get(&(source_id.to_string(), pages[index - 1]))
                    .map(String::as_str)
                    .unwrap_or(""),
            );
        let starts_safe = index == 0 || (label.is_some() && !continuation && !previous_forward);
        let begins_new_segment = index == 0 || (label.is_some() && !continuation);
        if begins_new_segment {
            if let Some(previous) = current.take() {
                segments.push(previous);
            }
            if index > 0 && !starts_safe {
                warnings.push(format!(
                    "{} 第 {} 页的章节边界存在续页/跨页引用，未被证明安全",
                    source_id, page
                ));
            }
            current = Some(Segment {
                source_id: source_id.to_string(),
                start: *page,
                end: *page,
                labels: label.into_iter().collect(),
                starts_safe,
                ends_safe: false,
                forced_split: false,
                estimated_tokens: estimate_page_tokens(text),
            });
        } else if let Some(current) = current.as_mut() {
            current.end = *page;
            current.estimated_tokens += estimate_page_tokens(text);
            if label.is_some() {
                current.labels.extend(label);
            }
        }
    }
    if let Some(last) = current {
        segments.push(last);
    }
    for index in 0..segments.len() {
        let ends_safe = segments.get(index + 1).is_none_or(|next| next.starts_safe);
        segments[index].ends_safe = ends_safe;
    }
    segments
}

fn estimate_range_tokens(
    source_id: &str,
    start: u32,
    end: u32,
    page_text: &BTreeMap<(String, u32), String>,
) -> u32 {
    (start..=end)
        .map(|page| {
            estimate_page_tokens(
                page_text
                    .get(&(source_id.to_string(), page))
                    .map(String::as_str)
                    .unwrap_or(""),
            )
        })
        .sum()
}

fn estimate_page_tokens(text: &str) -> u32 {
    // Deliberately generous: one rendered page is budgeted as an image plus its
    // native text. This is diagnostic planning only and never used to clip text.
    let text_tokens = (text.chars().count() / 3) as u32;
    text_tokens.saturating_add(1_600)
}

fn detect_chapter_heading(text: &str) -> Option<String> {
    let first = text.lines().find(|line| !line.trim().is_empty())?.trim();
    if first.is_empty() || first.chars().count() > 80 {
        return None;
    }
    let plain = first.trim_start_matches('#').trim();
    if first.starts_with('#') && !plain.is_empty() && plain.chars().count() <= 60 {
        return Some(plain.to_string());
    }
    let lower = plain.to_ascii_lowercase();
    let chinese_number = "一二三四五六七八九十百零〇";
    if plain.starts_with('第') {
        let head: String = plain.chars().take(16).collect();
        if ["章", "节", "单元", "部分", "篇"]
            .iter()
            .any(|marker| head.contains(marker))
        {
            return Some(plain.to_string());
        }
    }
    if plain
        .chars()
        .next()
        .is_some_and(|ch| chinese_number.contains(ch))
        && plain.contains('、')
        && [
            "选择", "填空", "判断", "阅读", "解答", "作文", "答案", "解析", "练习", "综合",
        ]
        .iter()
        .any(|word| plain.contains(word))
    {
        return Some(plain.to_string());
    }
    if lower.starts_with("chapter")
        || lower.starts_with("section")
        || lower.starts_with("part ")
        || lower.starts_with("unit ")
        || lower.starts_with("answer key")
        || lower.starts_with("solutions")
    {
        return Some(plain.to_string());
    }
    if ["参考答案", "答案", "解析", "试题解析"]
        .iter()
        .any(|heading| plain.starts_with(heading))
    {
        return Some(plain.to_string());
    }
    None
}

fn is_answer_section(label: &str) -> bool {
    let lower = label.to_ascii_lowercase();
    ["答案", "解析", "answer key", "answers", "solutions"]
        .iter()
        .any(|needle| lower.contains(needle))
}

fn starts_with_continuation(text: &str) -> bool {
    let first = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    [
        "（续）",
        "(续)",
        "续表",
        "接上页",
        "续上页",
        "continued",
        "续：",
    ]
    .iter()
    .any(|needle| first.contains(needle))
}

fn ends_with_forward_reference(text: &str) -> bool {
    let tail: String = text
        .chars()
        .rev()
        .take(240)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let tail = tail.to_ascii_lowercase();
    [
        "如下图",
        "见下图",
        "如下表",
        "见下表",
        "见下文",
        "阅读下面",
        "根据材料",
        "完成下题",
        "见下页",
        "见下一页",
        "see below",
        "shown below",
    ]
    .iter()
    .any(|needle| tail.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AppErrorType;
    use crate::question_authoring_runner::SourcePage;

    fn bundle(pages: &[(u32, &str)]) -> SourceBundle {
        SourceBundle {
            sources: vec![json!({"source_id":"s1","page_count":pages.len()})],
            pages: pages
                .iter()
                .map(|(page, text)| SourcePage {
                    source_id: "s1".into(),
                    page: *page,
                    blob_hash: "h".into(),
                    width: 1,
                    height: 1,
                    text_hint: (!text.is_empty()).then(|| text.to_string()),
                })
                .collect(),
            text: String::new(),
            format: "pdf".into(),
        }
    }

    fn chaptered(count: u32) -> SourceBundle {
        bundle(
            &(1..=count)
                .map(|page| {
                    let text = if (page - 1) % 10 == 0 {
                        format!("第{}章 综合练习\n第 {page} 页正文", (page - 1) / 10 + 1)
                    } else {
                        format!("第 {page} 页正文")
                    };
                    (page, Box::leak(text.into_boxed_str()) as &str)
                })
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn chapter_plan_is_a_complete_partition_and_can_be_automatic() {
        let bundle = chaptered(45);
        let plan = plan_source_ranges(
            &bundle,
            SourceLimitReason::ContextWindow,
            &RangePlanOptions::default(),
        )
        .unwrap();
        plan.validate(&bundle).unwrap();
        assert!(plan.automatic);
        assert!(!plan.requires_user_selection);
        assert_eq!(plan.ranges.iter().map(|r| r.page_count).sum::<u32>(), 45);
        assert!(plan.ranges.iter().all(|range| range.starts_at_chapter));
    }

    #[test]
    fn forced_page_split_is_not_auto_accepted() {
        let texts = (1..=45)
            .map(|page| {
                (
                    page,
                    Box::leak(format!("第 {page} 页正文").into_boxed_str()) as &str,
                )
            })
            .collect::<Vec<_>>();
        let bundle = bundle(&texts);
        let plan = plan_source_ranges(
            &bundle,
            SourceLimitReason::ContextWindow,
            &RangePlanOptions::default(),
        )
        .unwrap();
        plan.validate(&bundle).unwrap();
        assert!(!plan.automatic);
        assert!(plan.requires_user_selection);
        assert_eq!(plan.ranges.iter().map(|r| r.page_count).sum::<u32>(), 45);
    }

    #[test]
    fn answer_section_prevents_automatic_acceptance() {
        let mut texts = (1..=40)
            .map(|page| {
                (
                    page,
                    Box::leak(format!("第 {page} 页正文").into_boxed_str()) as &str,
                )
            })
            .collect::<Vec<_>>();
        texts[30].1 = "参考答案\n1. B";
        let plan = plan_source_ranges(
            &bundle(&texts),
            SourceLimitReason::ContextWindow,
            &RangePlanOptions::default(),
        )
        .unwrap();
        assert!(!plan.automatic);
        assert!(plan.requires_user_selection);
    }

    #[test]
    fn provider_limit_is_detected_from_stable_codes_and_bodies() {
        let context = AppError::with_details(
            AppErrorType::LLM,
            "HTTP 400",
            json!({"status":400,"body":"maximum context length exceeded"}),
        );
        assert_eq!(
            detect_provider_limit(&context),
            Some(SourceLimitReason::ContextWindow)
        );
        let images = AppError::with_details(
            AppErrorType::LLM,
            "HTTP 400",
            json!({"status":400,"body":"too many images in request"}),
        );
        assert_eq!(
            detect_provider_limit(&images),
            Some(SourceLimitReason::ImageCount)
        );
        let truncated = AppError::with_details(
            AppErrorType::LLM,
            "truncated",
            json!({"code":"INCOMPLETE_OUTPUT","finish_reason":"length"}),
        );
        assert_eq!(detect_provider_limit(&truncated), None);
    }
}
