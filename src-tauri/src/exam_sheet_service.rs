use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use crate::file_manager::FileManager;
use crate::llm_manager::LLMManager;
use crate::models::{
    AppError, Difficulty, ExamCardBBox, ExamCardPreview, ExamSheetCardUpdate,
    ExamSheetPreviewPage, ExamSheetPreviewResult, ExamSheetSessionDetail,
    ExamSheetSessionMetadata, ExamSheetSessionSummary, ImportSource, QuestionBankStats,
    QuestionType, SourceType, UpdateExamSheetCardsRequest,
};
use image::GenericImageView;

/// 带时间戳的日志宏
macro_rules! log_with_time {
    ($level:tt, $($arg:tt)*) => {{
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let _millis = now.as_millis() % 1000;
        // 转换 u128 到 i64，截断到秒
        let seconds = (now.as_millis() / 1000) as i64;
        let time_str = chrono::NaiveDateTime::from_timestamp_millis(seconds * 1000)
            .map(|dt| dt.format("%H:%M:%S").to_string())
            .unwrap_or_else(|| "??:??:??".to_string());
        println!("{} [{}] [exam-sheet] {}", time_str, stringify!($level), format_args!($($arg)*));
    }};
}

macro_rules! log_info {
    ($($arg:tt)*) => (log_with_time!(INFO, $($arg)*));
}
macro_rules! log_warn {
    ($($arg:tt)*) => (log_with_time!(WARN,  $($arg)*));
}

// ★ VFS 统一存储（2025-12-07）
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::VfsExamRepo;
use crate::vfs::types::VfsCreateExamSheetParams;

pub struct ExamSheetService {
    file_manager: Arc<FileManager>,
    llm_manager: Arc<LLMManager>,
    vfs_db: Arc<VfsDatabase>, // ★ VFS 数据库
}

pub struct ExamSheetUpdateOutcome {
    pub detail: ExamSheetSessionDetail,
    pub updated_mistake_ids: Vec<String>,
}

#[derive(Debug)]
struct CardChange {
    card_id: String,
    page_index: usize,
    old_ocr_text: String,
    new_ocr_text: Option<String>,
    old_tags: Vec<String>,
    new_tags: Option<Vec<String>>,
    new_question_label: Option<String>,
    new_bbox: Option<ExamCardBBox>,
    new_resolved_bbox: Option<ExamCardBBox>,
}

impl ExamSheetService {
    fn trim_owned(input: &str) -> Option<String> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    pub fn new(
        database: Arc<crate::database::Database>,
        file_manager: Arc<FileManager>,
        vfs_db: Arc<VfsDatabase>,
    ) -> Self {
        // database 仅用于创建 LLMManager，不再存储
        let llm_manager = Arc::new(LLMManager::new(database, file_manager.clone()));
        Self {
            file_manager,
            llm_manager,
            vfs_db,
        }
    }

    /// ★ 将 ExamSheetSessionDetail 保存到 VFS（统一存储入口）
    fn save_to_vfs(&self, detail: &ExamSheetSessionDetail) -> Result<(), AppError> {
        let params = VfsCreateExamSheetParams {
            exam_name: detail.summary.exam_name.clone(),
            temp_id: detail.summary.temp_id.clone(),
            status: detail.summary.status.clone(),
            metadata_json: serde_json::to_value(&detail.summary.metadata).unwrap_or_default(),
            preview_json: serde_json::to_value(&detail.preview).unwrap_or_default(),
            folder_id: None, // upsert 时不修改文件夹
        };

        VfsExamRepo::upsert_exam_sheet(&self.vfs_db, params, Some(&detail.summary.id))
            .map_err(|e| AppError::database(format!("VFS 保存整卷失败: {}", e)))?;

        Ok(())
    }

    /// ★ 从 VFS 获取整卷会话详情
    fn get_from_vfs(&self, session_id: &str) -> Result<Option<ExamSheetSessionDetail>, AppError> {
        let exam = VfsExamRepo::get_exam_sheet(&self.vfs_db, session_id)
            .map_err(|e| AppError::database(format!("VFS 查询整卷失败: {}", e)))?;

        match exam {
            Some(exam) => {
                let metadata: Option<ExamSheetSessionMetadata> =
                    serde_json::from_value(exam.metadata_json.clone()).ok();
                let preview: ExamSheetPreviewResult =
                    serde_json::from_value(exam.preview_json.clone()).unwrap_or_else(|_| {
                        ExamSheetPreviewResult {
                            temp_id: exam.temp_id.clone(),
                            exam_name: exam.exam_name.clone(),
                            pages: vec![],
                            raw_model_response: None,
                            instructions: None,
                            session_id: Some(exam.id.clone()),
                        }
                    });

                let created_ts = &exam.created_at;
                let updated_ts = &exam.updated_at;
                let summary = ExamSheetSessionSummary {
                    id: exam.id,
                    exam_name: exam.exam_name,
                    temp_id: exam.temp_id,
                    created_at: chrono::DateTime::parse_from_rfc3339(created_ts)
                        .map(|dt| dt.with_timezone(&chrono::Utc))
                        .unwrap_or_else(|e| {
                            log::warn!("[ExamSheetService] Failed to parse timestamp '{}': {}, using epoch fallback", created_ts, e);
                            chrono::DateTime::<chrono::Utc>::from(std::time::UNIX_EPOCH)
                        }),
                    updated_at: chrono::DateTime::parse_from_rfc3339(updated_ts)
                        .map(|dt| dt.with_timezone(&chrono::Utc))
                        .unwrap_or_else(|e| {
                            log::warn!("[ExamSheetService] Failed to parse timestamp '{}': {}, using epoch fallback", updated_ts, e);
                            chrono::DateTime::<chrono::Utc>::from(std::time::UNIX_EPOCH)
                        }),
                    status: exam.status,
                    metadata,
                    linked_mistake_ids: exam.linked_mistake_ids,
                };

                Ok(Some(ExamSheetSessionDetail { summary, preview }))
            }
            None => Ok(None),
        }
    }


    /// ★ 从 VFS 读取整卷历史列表（2025-12-07 迁移）
    pub async fn list_exam_sheet_sessions(
        &self,
        limit: usize,
    ) -> Result<Vec<ExamSheetSessionSummary>, AppError> {
        let vfs_exams = VfsExamRepo::list_exam_sheets(
            &self.vfs_db,
            None, // search
            limit as u32,
            0, // offset
        )
        .map_err(|e| AppError::database(format!("查询整卷历史失败: {}", e)))?;

        // 转换 VfsExamSheet -> ExamSheetSessionSummary
        let summaries = vfs_exams
            .into_iter()
            .map(|exam| {
                let metadata: Option<ExamSheetSessionMetadata> =
                    serde_json::from_value(exam.metadata_json.clone()).ok();
                let created_ts = &exam.created_at;
                let updated_ts = &exam.updated_at;
                ExamSheetSessionSummary {
                    id: exam.id,
                    exam_name: exam.exam_name,
                    temp_id: exam.temp_id,
                    created_at: chrono::DateTime::parse_from_rfc3339(created_ts)
                        .map(|dt| dt.with_timezone(&chrono::Utc))
                        .unwrap_or_else(|e| {
                            log::warn!("[ExamSheetService] Failed to parse timestamp '{}': {}, using epoch fallback", created_ts, e);
                            chrono::DateTime::<chrono::Utc>::from(std::time::UNIX_EPOCH)
                        }),
                    updated_at: chrono::DateTime::parse_from_rfc3339(updated_ts)
                        .map(|dt| dt.with_timezone(&chrono::Utc))
                        .unwrap_or_else(|e| {
                            log::warn!("[ExamSheetService] Failed to parse timestamp '{}': {}, using epoch fallback", updated_ts, e);
                            chrono::DateTime::<chrono::Utc>::from(std::time::UNIX_EPOCH)
                        }),
                    status: exam.status,
                    metadata,
                    linked_mistake_ids: exam.linked_mistake_ids,
                }
            })
            .collect();

        Ok(summaries)
    }

    /// ★ 从 VFS 获取整卷会话详情（2025-12-07 迁移）
    pub async fn get_exam_sheet_session_detail(
        &self,
        session_id: &str,
    ) -> Result<ExamSheetSessionDetail, AppError> {
        let mut detail = self
            .get_from_vfs(session_id)?
            .ok_or_else(|| AppError::not_found("未找到指定的整卷会话"))?;

        self.enrich_session_detail(&mut detail).await?;

        Ok(detail)
    }

    pub async fn update_exam_sheet_cards(
        &self,
        request: UpdateExamSheetCardsRequest,
    ) -> Result<ExamSheetUpdateOutcome, AppError> {
        let UpdateExamSheetCardsRequest {
            session_id,
            cards,
            exam_name,
            create_cards,
            delete_card_ids,
        } = request;

        let cards_requested = cards.as_ref().map(|list| !list.is_empty()).unwrap_or(false)
            || create_cards
                .as_ref()
                .map(|list| !list.is_empty())
                .unwrap_or(false)
            || delete_card_ids
                .as_ref()
                .map(|list| !list.is_empty())
                .unwrap_or(false);

        let rename_requested = exam_name.is_some();

        if !cards_requested && !rename_requested {
            return Err(AppError::validation("没有需要更新的内容"));
        }

        // ★ 从 VFS 获取整卷会话
        let mut detail = self
            .get_from_vfs(&session_id)?
            .ok_or_else(|| AppError::not_found("未找到指定的整卷会话"))?;

        self.enrich_session_detail(&mut detail).await?;

        let mut pending_updates = cards.unwrap_or_default();
        let create_cards = create_cards.unwrap_or_default();
        let delete_card_ids = delete_card_ids.unwrap_or_default();

        let mut card_changes: Vec<CardChange> = Vec::new();
        let mut any_card_modified = false;

        if !delete_card_ids.is_empty() {
            let delete_set: HashSet<String> = delete_card_ids.iter().cloned().collect();

            // 先校验删除目标是否存在关联错题
            for page in detail.preview.pages.iter() {
                for card in page.cards.iter() {
                    if delete_set.contains(&card.card_id) {
                        if let Some(linked) = &card.linked_mistake_ids {
                            if !linked.is_empty() {
                                return Err(AppError::validation(format!(
                                    "题目 {} 已关联错题，请先解除关联后再删除。",
                                    card.question_label
                                )));
                            }
                        }
                    }
                }
            }

            let mut crop_paths_to_remove: Vec<String> = Vec::new();
            detail.preview.pages.iter_mut().for_each(|page| {
                page.cards.retain(|card| {
                    if delete_set.contains(&card.card_id) {
                        if !card.cropped_image_path.trim().is_empty() {
                            crop_paths_to_remove.push(card.cropped_image_path.clone());
                        }
                        any_card_modified = true;
                        false
                    } else {
                        true
                    }
                });
            });

            for rel in crop_paths_to_remove {
                let abs = self.file_manager.resolve_image_path(&rel);
                if let Err(err) = tokio::fs::remove_file(&abs).await {
                    log_info!(
                        "⚠️ [exam-sheet] 删除裁剪图片失败 {}: {}",
                        abs.display(),
                        err
                    );
                }
            }

            // 删除后移除任何针对已删除卡片的更新
            if !pending_updates.is_empty() {
                pending_updates.retain(|update| !delete_set.contains(&update.card_id));
            }
        }

        if !create_cards.is_empty() {
            let archive_root_rel = format!("images/exam_sheet_archive/{}", detail.summary.id);
            let archive_abs = self.file_manager.resolve_image_path(&archive_root_rel);
            if let Err(err) = tokio::fs::create_dir_all(&archive_abs).await {
                log_info!(
                    "⚠️ [exam-sheet] 创建 archive 目录失败 {}: {}",
                    archive_abs.display(),
                    err
                );
            }

            for create in create_cards.into_iter() {
                let page = detail
                    .preview
                    .pages
                    .get_mut(create.page_index)
                    .ok_or_else(|| {
                        AppError::validation(format!(
                            "新增题目失败：未找到第 {} 页",
                            create.page_index + 1
                        ))
                    })?;

                let page_abs = self
                    .file_manager
                    .resolve_image_path(&page.original_image_path);

                let (img_w, img_h) = tokio::task::spawn_blocking({
                    let path = page_abs.clone();
                    move || {
                        image::image_dimensions(&path).map_err(|e| {
                            AppError::file_system(format!("读取试卷图片尺寸失败: {}", e))
                        })
                    }
                })
                .await
                .map_err(|e| AppError::file_system(format!("读取试卷图片尺寸失败: {:?}", e)))??;

                let bbox_candidate = if let Some(resolved) = create.resolved_bbox.clone() {
                    resolved_bbox_to_pixels(&resolved, img_w, img_h)
                } else if let Some(normalized) = create.bbox.clone() {
                    clamp_bbox(&normalized, img_w, img_h)
                } else {
                    return Err(AppError::validation("新增题目缺少分割框信息"));
                };

                if bbox_candidate.width < 4 || bbox_candidate.height < 4 {
                    return Err(AppError::validation("新增题目的分割框过小"));
                }

                let normalized_bbox = ExamCardBBox {
                    x: (bbox_candidate.x as f32 / img_w.max(1) as f32).clamp(0.0, 1.0),
                    y: (bbox_candidate.y as f32 / img_h.max(1) as f32).clamp(0.0, 1.0),
                    width: (bbox_candidate.width as f32 / img_w.max(1) as f32).clamp(0.0, 1.0),
                    height: (bbox_candidate.height as f32 / img_h.max(1) as f32).clamp(0.0, 1.0),
                };
                let resolved_bbox = ExamCardBBox {
                    x: bbox_candidate.x as f32,
                    y: bbox_candidate.y as f32,
                    width: bbox_candidate.width as f32,
                    height: bbox_candidate.height as f32,
                };

                let mut label = create
                    .question_label
                    .clone()
                    .and_then(|v| Self::trim_owned(&v))
                    .unwrap_or_else(|| format!("Q{}", page.cards.len() + 1));
                if label.trim().is_empty() {
                    label = format!("Q{}", page.cards.len() + 1);
                }

                let slug = sanitize_label(&label);
                let new_card_id = format!("{}-{}", detail.summary.temp_id, uuid::Uuid::new_v4());
                let timestamp_prefix = chrono::Utc::now().format("exam_%Y%m%d%H%M%S");
                let crop_filename = format!(
                    "{}_p{}_{}_{}.png",
                    timestamp_prefix,
                    create.page_index,
                    slug,
                    &new_card_id
                        .chars()
                        .filter(|c| c.is_ascii_alphanumeric())
                        .take(8)
                        .collect::<String>()
                );
                let crop_rel = format!("{}/{}", archive_root_rel, crop_filename);
                let crop_abs = self.file_manager.resolve_image_path(&crop_rel);
                if let Some(parent) = crop_abs.parent() {
                    if let Err(err) = tokio::fs::create_dir_all(parent).await {
                        log_info!(
                            "⚠️ [exam-sheet] 创建裁剪目录失败 {}: {}",
                            parent.display(),
                            err
                        );
                    }
                }

                let bbox_clone = bbox_candidate.clone();
                tokio::task::spawn_blocking(move || -> Result<(), AppError> {
                    let img = image::open(&page_abs)
                        .map_err(|e| AppError::file_system(format!("加载试卷图片失败: {}", e)))?;
                    let rgba = img.to_rgba8();
                    let crop = image::imageops::crop_imm(
                        &rgba,
                        bbox_clone.x,
                        bbox_clone.y,
                        bbox_clone.width,
                        bbox_clone.height,
                    );
                    let cropped = crop.to_image();
                    if cropped.width() == 0 || cropped.height() == 0 {
                        return Err(AppError::validation("新增题目的分割框无效"));
                    }
                    cropped
                        .save(&crop_abs)
                        .map_err(|e| AppError::file_system(format!("保存裁剪题目失败: {}", e)))?;
                    Ok(())
                })
                .await
                .map_err(|e| AppError::file_system(format!("保存裁剪题目失败: {:?}", e)))??;

                let mut tags: Vec<String> = create
                    .tags
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|tag| Self::trim_owned(&tag))
                    .collect();
                tags.sort();
                tags.dedup();

                let new_card = ExamCardPreview {
                    card_id: new_card_id.clone(),
                    page_index: create.page_index,
                    question_label: label.clone(),
                    bbox: normalized_bbox.clone(),
                    resolved_bbox: Some(resolved_bbox.clone()),
                    cropped_image_path: crop_rel,
                    ocr_text: create.ocr_text.unwrap_or_default(),
                    tags: tags.clone(),
                    extra_metadata: None,
                    linked_mistake_ids: None,
                    ..Default::default()
                };

                page.cards.push(new_card);
                page.cards.sort_by(|a, b| {
                    let ay = a
                        .resolved_bbox
                        .as_ref()
                        .map(|bbox| bbox.y)
                        .unwrap_or_default();
                    let by = b
                        .resolved_bbox
                        .as_ref()
                        .map(|bbox| bbox.y)
                        .unwrap_or_default();
                    ay.partial_cmp(&by).unwrap_or(std::cmp::Ordering::Equal)
                });

                any_card_modified = true;
            }
        }

        let mut card_lookup: HashMap<String, (usize, usize)> = HashMap::new();
        for (page_idx, page) in detail.preview.pages.iter().enumerate() {
            for (card_idx, card) in page.cards.iter().enumerate() {
                card_lookup.insert(card.card_id.clone(), (page_idx, card_idx));
            }
        }

        let update_map: HashMap<String, ExamSheetCardUpdate> = pending_updates
            .into_iter()
            .map(|update| (update.card_id.clone(), update))
            .collect();

        let mut page_dims_cache: HashMap<usize, (u32, u32)> = HashMap::new();

        let mut aggregated_tags: BTreeSet<String> = BTreeSet::new();

        for tag in detail
            .preview
            .pages
            .iter()
            .flat_map(|page| page.cards.iter())
            .flat_map(|card| card.tags.iter())
        {
            aggregated_tags.insert(tag.clone());
        }

        for (card_id, update) in &update_map {
            let Some((page_index, card_index)) = card_lookup.get(card_id).copied() else {
                return Err(AppError::not_found(format!("未找到题目卡片: {}", card_id)));
            };

            let page = detail
                .preview
                .pages
                .get_mut(page_index)
                .ok_or_else(|| AppError::not_found("题目所在页不存在"))?;
            let card = page
                .cards
                .get_mut(card_index)
                .ok_or_else(|| AppError::not_found("题目不存在"))?;

            let mut change = CardChange {
                card_id: card.card_id.clone(),
                page_index,
                old_ocr_text: card.ocr_text.clone(),
                new_ocr_text: None,
                old_tags: card.tags.clone(),
                new_tags: None,
                new_question_label: None,
                new_bbox: None,
                new_resolved_bbox: None,
            };

            if let Some(ref label) = update.question_label {
                if let Some(trimmed) = Self::trim_owned(label) {
                    if trimmed != card.question_label {
                        card.question_label = trimmed.clone();
                        change.new_question_label = Some(trimmed);
                        any_card_modified = true;
                    }
                }
            }

            if let Some(ref tags) = update.tags {
                let sanitized: Vec<String> =
                    tags.iter().filter_map(|t| Self::trim_owned(t)).collect();
                if sanitized != card.tags {
                    card.tags = sanitized.clone();
                    change.new_tags = Some(sanitized);
                    any_card_modified = true;
                }
            }

            if let Some(ref new_text) = update.ocr_text {
                if let Some(trimmed) = Self::trim_owned(new_text) {
                    if trimmed != card.ocr_text {
                        card.ocr_text = trimmed.clone();
                        change.new_ocr_text = Some(trimmed);
                        any_card_modified = true;
                    }
                }
            }

            let mut bbox_modified = false;
            if update.bbox.is_some() || update.resolved_bbox.is_some() {
                let dims = if let Some(dims) = page_dims_cache.get(&page_index).copied() {
                    dims
                } else {
                    let original_abs = self
                        .file_manager
                        .resolve_image_path(&page.original_image_path);
                    let dims = tokio::task::spawn_blocking({
                        let path = original_abs.clone();
                        move || {
                            image::image_dimensions(&path).map_err(|e| {
                                AppError::file_system(format!("读取试卷图片尺寸失败: {}", e))
                            })
                        }
                    })
                    .await
                    .map_err(|e| {
                        AppError::file_system(format!("读取试卷图片尺寸失败: {:?}", e))
                    })??;
                    page_dims_cache.insert(page_index, dims);
                    dims
                };

                let (img_width, img_height) = dims;
                if img_width > 0 && img_height > 0 {
                    let new_pixels = if let Some(resolved) = update.resolved_bbox.as_ref() {
                        Some(resolved_bbox_to_pixels(resolved, img_width, img_height))
                    } else if let Some(normalized) = update.bbox.as_ref() {
                        Some(normalized_bbox_to_pixels(normalized, img_width, img_height))
                    } else {
                        None
                    };

                    if let Some(pixels) = new_pixels {
                        if pixels.width > 0 && pixels.height > 0 {
                            let normalized = ExamCardBBox {
                                x: (pixels.x as f32 / img_width.max(1) as f32).clamp(0.0, 1.0),
                                y: (pixels.y as f32 / img_height.max(1) as f32).clamp(0.0, 1.0),
                                width: (pixels.width as f32 / img_width.max(1) as f32)
                                    .clamp(0.0, 1.0),
                                height: (pixels.height as f32 / img_height.max(1) as f32)
                                    .clamp(0.0, 1.0),
                            };
                            let resolved_bbox = ExamCardBBox {
                                x: pixels.x as f32,
                                y: pixels.y as f32,
                                width: pixels.width as f32,
                                height: pixels.height as f32,
                            };

                            let existing_resolved =
                                card.resolved_bbox.clone().unwrap_or_else(|| ExamCardBBox {
                                    x: 0.0,
                                    y: 0.0,
                                    width: 0.0,
                                    height: 0.0,
                                });

                            if !approx_eq_bbox(&normalized, &card.bbox)
                                || !approx_eq_bbox(&resolved_bbox, &existing_resolved)
                            {
                                let original_abs = self
                                    .file_manager
                                    .resolve_image_path(&page.original_image_path);
                                let crop_abs = self
                                    .file_manager
                                    .resolve_image_path(&card.cropped_image_path);

                                tokio::task::spawn_blocking(move || -> Result<(), AppError> {
                                    let img = image::open(&original_abs).map_err(|e| {
                                        AppError::file_system(format!("加载试卷图片失败: {}", e))
                                    })?;
                                    let rgba = img.to_rgba8();
                                    let crop = image::imageops::crop_imm(
                                        &rgba,
                                        pixels.x,
                                        pixels.y,
                                        pixels.width,
                                        pixels.height,
                                    );
                                    let cropped = crop.to_image();
                                    if cropped.width() == 0 || cropped.height() == 0 {
                                        return Err(AppError::validation(
                                            "调整后的分割框无效 (0 宽或高)",
                                        ));
                                    }
                                    cropped.save(&crop_abs).map_err(|e| {
                                        AppError::file_system(format!("保存裁剪题目失败: {}", e))
                                    })?;
                                    Ok(())
                                })
                                .await
                                .map_err(|e| {
                                    AppError::file_system(format!("裁剪题目失败: {:?}", e))
                                })??;

                                card.bbox = normalized.clone();
                                card.resolved_bbox = Some(resolved_bbox.clone());
                                change.new_bbox = Some(normalized);
                                change.new_resolved_bbox = Some(resolved_bbox);
                                bbox_modified = true;
                                any_card_modified = true;
                            }
                        }
                    }
                }
            }

            let has_change = change.new_question_label.is_some()
                || change.new_ocr_text.is_some()
                || change.new_tags.is_some()
                || change.new_bbox.is_some()
                || change.new_resolved_bbox.is_some()
                || bbox_modified;

            if has_change {
                card_changes.push(change);
            }
        }

        // 新名称处理
        let sanitized_exam_name = exam_name.and_then(|name| Self::trim_owned(&name));

        if let Some(ref name) = sanitized_exam_name {
            if detail.summary.exam_name.as_ref() != Some(name) {
                detail.summary.exam_name = Some(name.clone());
                detail.preview.exam_name = Some(name.clone());
                any_card_modified = true;
            }
        } else if detail.summary.exam_name.is_some() {
            detail.summary.exam_name = None;
            detail.preview.exam_name = None;
            any_card_modified = true;
        }

        if !any_card_modified {
            // 即使仅调整名称也会标记为修改；若完全无变更则返回现有数据
            return Ok(ExamSheetUpdateOutcome {
                detail,
                updated_mistake_ids: Vec::new(),
            });
        }

        aggregated_tags.clear();
        for tag in detail
            .preview
            .pages
            .iter()
            .flat_map(|page| page.cards.iter())
            .flat_map(|card| card.tags.iter())
        {
            aggregated_tags.insert(tag.clone());
        }

        let mut metadata = detail.summary.metadata.clone().unwrap_or_default();
        metadata.tags = if aggregated_tags.is_empty() {
            None
        } else {
            Some(aggregated_tags.iter().cloned().collect())
        };
        metadata.page_count = Some(detail.preview.pages.len());
        metadata.card_count = Some(detail.preview.pages.iter().map(|p| p.cards.len()).sum());
        detail.summary.metadata = Some(metadata);
        detail.summary.updated_at = chrono::Utc::now();

        self.save_to_vfs(&ExamSheetSessionDetail {
            summary: detail.summary.clone(),
            preview: detail.preview.clone(),
        })
        .map_err(|e| AppError::database(format!("更新整卷会话失败: {}", e)))?;

        self.enrich_session_detail(&mut detail).await?;

        Ok(ExamSheetUpdateOutcome {
            detail,
            updated_mistake_ids: Vec::new(),
        })
    }

    async fn enrich_session_detail(
        &self,
        detail: &mut ExamSheetSessionDetail,
    ) -> Result<(), AppError> {
        let session_id = detail.summary.id.clone();

        if detail.preview.session_id.is_none() {
            detail.preview.session_id = Some(session_id.clone());
            if let Err(err) = self.save_to_vfs(&ExamSheetSessionDetail {
                summary: detail.summary.clone(),
                preview: detail.preview.clone(),
            }) {
                log_warn!("⚠️ 回写缺失 session_id 失败: {}", err);
            }
        }

        detail.summary.linked_mistake_ids = None;

        // 若历史记录仍引用临时目录，尝试在读取详情时自动归档到 archive 目录，避免刷新后资源丢失
        // ★ 两阶段页面使用 blob_hash 存储图片，original_image_path 为空，无需归档
        let archive_prefix = format!("images/exam_sheet_archive/{session_id}");
        let needs_archive = detail
            .preview
            .pages
            .iter()
            .any(|p| {
                // 有 blob_hash 的页面不需要归档（两阶段流水线）
                p.blob_hash.is_none()
                    && !p.original_image_path.is_empty()
                    && !p.original_image_path.starts_with(&archive_prefix)
            })
            || detail.preview.pages.iter().any(|p| {
                p.cards
                    .iter()
                    .any(|c| !c.cropped_image_path.is_empty() && !c.cropped_image_path.starts_with(&archive_prefix))
            });

        if needs_archive {
            if let Err(e) = self
                .archive_preview_assets(&mut detail.preview, &session_id)
                .await
            {
                log_info!(
                    "⚠️ [exam-sheet] enrich时归档资源失败: {}，将继续使用原路径显示",
                    e
                );
            } else {
                // 归档成功后回写VFS，确保后续展示稳定
                if let Err(err) = self.save_to_vfs(&ExamSheetSessionDetail {
                    summary: detail.summary.clone(),
                    preview: detail.preview.clone(),
                }) {
                    log_warn!("⚠️ enrich时回写归档后的会话失败: {}", err);
                }
            }
        }

        for page in detail.preview.pages.iter_mut() {
            // ★ 两阶段页面已在 build_page_skeleton 中设置了 width/height，直接使用
            let (img_width, img_height) = if let (Some(w), Some(h)) = (page.width, page.height) {
                if w > 0 && h > 0 {
                    (w, h)
                } else {
                    (0u32, 0u32)
                }
            } else if !page.original_image_path.is_empty() {
                // 旧版页面：从文件系统读取尺寸
                let original_abs = self
                    .file_manager
                    .resolve_image_path(&page.original_image_path);
                let dims_result = tokio::task::spawn_blocking({
                    let path = original_abs.clone();
                    move || image::image_dimensions(&path)
                })
                .await
                .map_err(|e| AppError::file_system(format!("读取试卷图片尺寸失败: {:?}", e)))?;

                match dims_result {
                    Ok((w, h)) => (w, h),
                    Err(err) => {
                        log_info!(
                            "⚠️ [exam-sheet] 读取页面尺寸失败 {}: {}",
                            original_abs.display(),
                            err
                        );
                        (0, 0)
                    }
                }
            } else {
                (0, 0)
            };

            for card in page.cards.iter_mut() {
                if card.resolved_bbox.is_none() && img_width > 0 && img_height > 0 {
                    let resolved = clamp_bbox(&card.bbox, img_width, img_height);
                    card.resolved_bbox = Some(ExamCardBBox {
                        x: resolved.x as f32,
                        y: resolved.y as f32,
                        width: resolved.width as f32,
                        height: resolved.height as f32,
                    });
                }

                card.linked_mistake_ids = None;
            }
        }

        Ok(())
    }
}

fn ensure_images_prefix(path: &str) -> String {
    if path.starts_with("images/") {
        path.to_string()
    } else {
        format!("images/{}", path.trim_start_matches('/'))
    }
}

fn normalized_bbox_to_pixels(bbox: &ExamCardBBox, img_w: u32, img_h: u32) -> BBoxPixels {
    let width_f = img_w.max(1) as f32;
    let height_f = img_h.max(1) as f32;
    let mut x = (bbox.x * width_f).round() as i64;
    let mut y = (bbox.y * height_f).round() as i64;
    let mut width = (bbox.width * width_f).round() as i64;
    let mut height = (bbox.height * height_f).round() as i64;

    if width <= 0 {
        width = 1;
    }
    if height <= 0 {
        height = 1;
    }
    if x < 0 {
        x = 0;
    }
    if y < 0 {
        y = 0;
    }
    if x as u32 >= img_w {
        x = img_w.saturating_sub(1) as i64;
    }
    if y as u32 >= img_h {
        y = img_h.saturating_sub(1) as i64;
    }
    if x as u32 + width as u32 > img_w {
        width = (img_w.saturating_sub(x as u32)) as i64;
    }
    if y as u32 + height as u32 > img_h {
        height = (img_h.saturating_sub(y as u32)) as i64;
    }

    BBoxPixels {
        x: x.max(0) as u32,
        y: y.max(0) as u32,
        width: width.max(1) as u32,
        height: height.max(1) as u32,
    }
}

fn resolved_bbox_to_pixels(bbox: &ExamCardBBox, img_w: u32, img_h: u32) -> BBoxPixels {
    let mut x = bbox.x.round() as i64;
    let mut y = bbox.y.round() as i64;
    let mut width = bbox.width.round() as i64;
    let mut height = bbox.height.round() as i64;

    if width <= 0 {
        width = 1;
    }
    if height <= 0 {
        height = 1;
    }
    if x < 0 {
        x = 0;
    }
    if y < 0 {
        y = 0;
    }
    if x as u32 >= img_w {
        x = img_w.saturating_sub(1) as i64;
    }
    if y as u32 >= img_h {
        y = img_h.saturating_sub(1) as i64;
    }
    if x as u32 + width as u32 > img_w {
        width = (img_w.saturating_sub(x as u32)) as i64;
    }
    if y as u32 + height as u32 > img_h {
        height = (img_h.saturating_sub(y as u32)) as i64;
    }

    BBoxPixels {
        x: x.max(0) as u32,
        y: y.max(0) as u32,
        width: width.max(1) as u32,
        height: height.max(1) as u32,
    }
}

fn approx_eq(a: f32, b: f32) -> bool {
    (a - b).abs() <= 1e-3
}

fn approx_eq_bbox(a: &ExamCardBBox, b: &ExamCardBBox) -> bool {
    approx_eq(a.x, b.x)
        && approx_eq(a.y, b.y)
        && approx_eq(a.width, b.width)
        && approx_eq(a.height, b.height)
}

fn sanitize_label(label: &str) -> String {
    label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

fn clamp_bbox(bbox: &ExamCardBBox, width: u32, height: u32) -> BBoxPixels {
    let image_w = width.max(1) as f32;
    let image_h = height.max(1) as f32;

    let mut candidates: Vec<(BBoxPixels, f32)> = Vec::new();

    // 1. 优先尝试完全归一化坐标 (x, y, w, h 均在 0-1 范围内)
    if values_look_normalized(bbox) {
        let candidate = interpret_normalized_lengths(bbox, image_w, image_h);
        if let Some(c) = candidate {
            candidates.push((c, bbox_penalty(&c, image_w, image_h, 0.0)));
        }

        let candidate = interpret_normalized_bottom_right(bbox, image_w, image_h);
        if let Some(c) = candidate {
            candidates.push((c, bbox_penalty(&c, image_w, image_h, 1.0)));
        }
    }

    // 2. 兼容混合/像素坐标的宽高形式
    let candidate = interpret_mixed_lengths(bbox, image_w, image_h);
    if let Some(c) = candidate {
        candidates.push((c, bbox_penalty(&c, image_w, image_h, 5.0)));
    }

    // 3. 兼容混合/像素坐标的右下角形式 (x2,y2)
    let candidate = interpret_mixed_bottom_right(bbox, image_w, image_h);
    if let Some(c) = candidate {
        candidates.push((c, bbox_penalty(&c, image_w, image_h, 6.0)));
    }

    if let Some((best, _)) = candidates
        .into_iter()
        .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
    {
        return best;
    }

    // 兜底：退回到整体页面
    BBoxPixels {
        x: 0,
        y: 0,
        width,
        height,
    }
}

fn values_look_normalized(bbox: &ExamCardBBox) -> bool {
    fn is_norm(v: f32) -> bool {
        v.is_finite() && v >= -0.05 && v <= 1.05
    }
    is_norm(bbox.x) && is_norm(bbox.y) && is_norm(bbox.width) && is_norm(bbox.height)
}

fn interpret_normalized_lengths(
    bbox: &ExamCardBBox,
    image_w: f32,
    image_h: f32,
) -> Option<BBoxPixels> {
    let x = (bbox.x.clamp(0.0, 1.0) * image_w).max(0.0);
    let y = (bbox.y.clamp(0.0, 1.0) * image_h).max(0.0);
    let width = (bbox.width.clamp(0.0, 1.0) * image_w).max(1.0);
    let height = (bbox.height.clamp(0.0, 1.0) * image_h).max(1.0);
    clamp_candidate(x, y, width, height, image_w, image_h)
}

fn interpret_normalized_bottom_right(
    bbox: &ExamCardBBox,
    image_w: f32,
    image_h: f32,
) -> Option<BBoxPixels> {
    if bbox.width < bbox.x || bbox.height < bbox.y {
        return None;
    }
    let x = (bbox.x.clamp(0.0, 1.0) * image_w).max(0.0);
    let y = (bbox.y.clamp(0.0, 1.0) * image_h).max(0.0);
    let width = ((bbox.width - bbox.x).clamp(0.0, 1.0) * image_w).max(1.0);
    let height = ((bbox.height - bbox.y).clamp(0.0, 1.0) * image_h).max(1.0);
    clamp_candidate(x, y, width, height, image_w, image_h)
}

fn interpret_mixed_lengths(bbox: &ExamCardBBox, image_w: f32, image_h: f32) -> Option<BBoxPixels> {
    let x = to_pixel_coord(bbox.x, image_w);
    let y = to_pixel_coord(bbox.y, image_h);
    let width = to_pixel_length(bbox.width, image_w);
    let height = to_pixel_length(bbox.height, image_h);
    clamp_candidate(x, y, width, height, image_w, image_h)
}

fn interpret_mixed_bottom_right(
    bbox: &ExamCardBBox,
    image_w: f32,
    image_h: f32,
) -> Option<BBoxPixels> {
    if bbox.width <= bbox.x && bbox.height <= bbox.y {
        return None;
    }
    let x1 = to_pixel_coord(bbox.x, image_w);
    let y1 = to_pixel_coord(bbox.y, image_h);
    let x2 = to_pixel_coord(bbox.width, image_w);
    let y2 = to_pixel_coord(bbox.height, image_h);

    let width = (x2 - x1).abs();
    let height = (y2 - y1).abs();
    if width <= 0.5 || height <= 0.5 {
        return None;
    }

    let (x, width) = if x2 >= x1 { (x1, width) } else { (x2, width) };
    let (y, height) = if y2 >= y1 { (y1, height) } else { (y2, height) };

    clamp_candidate(x, y, width, height, image_w, image_h)
}

fn to_pixel_coord(value: f32, dimension: f32) -> f32 {
    if !value.is_finite() {
        0.0
    } else if (-0.05..=1.05).contains(&value) {
        (value.clamp(0.0, 1.0)) * dimension
    } else {
        value.clamp(-dimension, dimension * 2.0)
    }
}

fn to_pixel_length(value: f32, dimension: f32) -> f32 {
    if !value.is_finite() {
        0.0
    } else if value.abs() <= 1.05 {
        (value.abs()) * dimension
    } else {
        value.abs().min(dimension * 2.0)
    }
}

fn clamp_candidate(
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    image_w: f32,
    image_h: f32,
) -> Option<BBoxPixels> {
    if !x.is_finite() || !y.is_finite() || !width.is_finite() || !height.is_finite() {
        return None;
    }

    let mut x0 = x;
    let mut y0 = y;
    let mut w0 = width;
    let mut h0 = height;

    if w0 <= 0.5 || h0 <= 0.5 {
        return None;
    }

    if x0 < 0.0 {
        w0 += x0;
        x0 = 0.0;
    }
    if y0 < 0.0 {
        h0 += y0;
        y0 = 0.0;
    }

    if x0 >= image_w || y0 >= image_h {
        return None;
    }

    if x0 + w0 > image_w {
        w0 = image_w - x0;
    }
    if y0 + h0 > image_h {
        h0 = image_h - y0;
    }

    if w0 <= 0.5 || h0 <= 0.5 {
        return None;
    }

    let x_px = x0.floor().clamp(0.0, image_w - 1.0) as u32;
    let y_px = y0.floor().clamp(0.0, image_h - 1.0) as u32;
    let max_width = (image_w - x_px as f32).ceil().max(1.0);
    let max_height = (image_h - y_px as f32).ceil().max(1.0);
    let w_px = w0.ceil().clamp(1.0, max_width) as u32;
    let h_px = h0.ceil().clamp(1.0, max_height) as u32;

    Some(BBoxPixels {
        x: x_px,
        y: y_px,
        width: w_px.max(1),
        height: h_px.max(1),
    })
}

fn bbox_penalty(candidate: &BBoxPixels, image_w: f32, image_h: f32, base: f32) -> f32 {
    let area = candidate.width as f32 * candidate.height as f32;
    let image_area = (image_w * image_h).max(1.0);
    let area_ratio = (area / image_area).clamp(0.0, 1.0);

    let mut penalty = base;

    if area_ratio < 0.0005 {
        penalty += 1000.0 + (0.0005 - area_ratio) * 100_000.0;
    } else if area_ratio > 0.9 {
        penalty += 1000.0 + (area_ratio - 0.9) * 100_000.0;
    } else {
        let target = 0.12;
        penalty += (area_ratio - target).abs() * 10.0;
    }

    penalty
}

#[derive(Debug, Clone, Copy)]
struct BBoxPixels {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

impl ExamSheetService {
    async fn copy_asset_to_archive(
        &self,
        source_rel: &str,
        archive_root_rel: &str,
    ) -> Result<Option<String>, AppError> {
        let normalized_source = source_rel.trim();
        if normalized_source.is_empty() {
            return Ok(None);
        }

        if normalized_source.starts_with(archive_root_rel) {
            return Ok(Some(ensure_images_prefix(normalized_source)));
        }

        let source_abs = self.file_manager.resolve_image_path(normalized_source);
        if !tokio::fs::try_exists(&source_abs)
            .await
            .map_err(|e| AppError::file_system(format!("检查整卷资源存在性失败: {}", e)))?
        {
            log_info!(
                "⚠️ [exam-sheet] 原始图片不存在，跳过持久化: {}",
                source_abs.display()
            );
            return Ok(None);
        }

        let file_name = std::path::Path::new(normalized_source)
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("asset_{}", uuid::Uuid::new_v4()));

        let normalized_root = if archive_root_rel.starts_with("images/") {
            archive_root_rel.trim_end_matches('/').to_string()
        } else {
            format!(
                "images/{}",
                archive_root_rel
                    .trim_start_matches('/')
                    .trim_end_matches('/')
            )
        };

        let dest_dir_abs = self.file_manager.resolve_image_path(&normalized_root);
        tokio::fs::create_dir_all(&dest_dir_abs)
            .await
            .map_err(|e| AppError::file_system(format!("创建整卷归档目录失败: {}", e)))?;

        let dest_abs = dest_dir_abs.join(&file_name);
        tokio::fs::copy(&source_abs, &dest_abs)
            .await
            .map_err(|e| AppError::file_system(format!("复制整卷图片失败: {}", e)))?;

        let dest_rel = format!("{}/{}", normalized_root, file_name);
        Ok(Some(ensure_images_prefix(&dest_rel)))
    }

    async fn archive_preview_assets(
        &self,
        preview: &mut ExamSheetPreviewResult,
        session_id: &str,
    ) -> Result<(), AppError> {
        let archive_root = format!("images/exam_sheet_archive/{}", session_id);

        for page in preview.pages.iter_mut() {
            if let Some(new_rel) = self
                .copy_asset_to_archive(&page.original_image_path, &archive_root)
                .await?
            {
                page.original_image_path = new_rel;
            }

            for card in page.cards.iter_mut() {
                if let Some(new_rel) = self
                    .copy_asset_to_archive(&card.cropped_image_path, &archive_root)
                    .await?
                {
                    card.cropped_image_path = new_rel;
                }
            }
        }

        Ok(())
    }

    pub async fn import_from_json(
        &self,
        json_content: &str,
        qbank_name: Option<String>,
        _folder_id: Option<String>,
    ) -> Result<ExamSheetSessionDetail, AppError> {
        #[derive(serde::Deserialize)]
        struct ImportQuestion {
            content: String,
            #[serde(default)]
            question_type: Option<String>,
            #[serde(default)]
            options: Option<Vec<String>>,
            #[serde(default)]
            answer: Option<String>,
            #[serde(default)]
            explanation: Option<String>,
            #[serde(default)]
            difficulty: Option<String>,
            #[serde(default)]
            tags: Option<Vec<String>>,
        }

        #[derive(serde::Deserialize)]
        struct ImportData {
            #[serde(default)]
            name: Option<String>,
            questions: Vec<ImportQuestion>,
        }

        let data: ImportData = serde_json::from_str(json_content)
            .map_err(|e| AppError::validation(format!("JSON 解析失败: {}", e)))?;

        if data.questions.is_empty() {
            return Err(AppError::validation("题目列表为空"));
        }

        let exam_name = qbank_name
            .or(data.name)
            .unwrap_or_else(|| "导入的题目集".to_string());
        let session_id = format!("exam_{}", nanoid::nanoid!(10));
        let temp_id = format!("temp_{}", nanoid::nanoid!(10));
        let now = chrono::Utc::now();

        let mut cards: Vec<ExamCardPreview> = Vec::new();
        for (idx, q) in data.questions.iter().enumerate() {
            let question_type = q.question_type.as_ref().map(|t| match t.as_str() {
                "single_choice" => QuestionType::SingleChoice,
                "multiple_choice" => QuestionType::MultipleChoice,
                "fill_blank" => QuestionType::FillBlank,
                "short_answer" => QuestionType::ShortAnswer,
                "essay" => QuestionType::Essay,
                "calculation" => QuestionType::Calculation,
                "proof" => QuestionType::Proof,
                _ => QuestionType::Other,
            });

            let difficulty = q.difficulty.as_ref().map(|d| match d.as_str() {
                "easy" => Difficulty::Easy,
                "medium" => Difficulty::Medium,
                "hard" => Difficulty::Hard,
                "very_hard" => Difficulty::VeryHard,
                _ => Difficulty::Medium,
            });

            let mut ocr_text = q.content.clone();
            if let Some(opts) = &q.options {
                ocr_text.push('\n');
                for opt in opts {
                    ocr_text.push_str(&format!("{}\n", opt));
                }
            }

            cards.push(ExamCardPreview {
                card_id: format!("{}-{}", session_id, uuid::Uuid::new_v4()),
                page_index: 0,
                question_label: format!("{}", idx + 1),
                ocr_text,
                tags: q.tags.clone().unwrap_or_default(),
                question_type,
                answer: q.answer.clone(),
                explanation: q.explanation.clone(),
                difficulty,
                source_type: SourceType::ImportFile,
                ..Default::default()
            });
        }

        let page = ExamSheetPreviewPage {
            page_index: 0,
            blob_hash: None,
            width: None,
            height: None,
            original_image_path: String::new(),
            cards,
            raw_ocr_text: None,
            ocr_completed: false,
            parse_completed: false,
        };

        let preview = ExamSheetPreviewResult {
            temp_id: temp_id.clone(),
            exam_name: Some(exam_name.clone()),
            pages: vec![page],
            raw_model_response: None,
            instructions: None,
            session_id: Some(session_id.clone()),
        };

        let card_count = preview.pages.iter().map(|p| p.cards.len()).sum();
        let summary = ExamSheetSessionSummary {
            id: session_id,
            exam_name: Some(exam_name),
            temp_id,
            created_at: now,
            updated_at: now,
            status: "completed".to_string(),
            metadata: Some(ExamSheetSessionMetadata {
                instructions: None,
                tags: None,
                page_count: Some(1),
                card_count: Some(card_count),
                raw_model_response: None,
                source_type: SourceType::ImportFile,
                import_source: Some(ImportSource {
                    file_name: None,
                    file_type: Some("json".to_string()),
                    import_time: Some(now.to_rfc3339()),
                }),
                stats: Some(QuestionBankStats {
                    total_count: card_count as i32,
                    new_count: card_count as i32,
                    ..Default::default()
                }),
            }),
            linked_mistake_ids: None,
        };

        let detail = ExamSheetSessionDetail { summary, preview };
        self.save_to_vfs(&detail)?;
        Ok(detail)
    }

    /// TXT/Markdown 导入：统一走 LLM 解析（严禁启发式正则匹配）
    pub async fn import_from_txt(
        &self,
        txt_content: &str,
        qbank_name: Option<String>,
        folder_id: Option<String>,
    ) -> Result<ExamSheetSessionDetail, AppError> {
        if txt_content.trim().is_empty() {
            return Err(AppError::validation("文本内容为空"));
        }

        // 统一走 LLM 解析，不使用启发式正则匹配
        let parsed_questions = self.parse_document_with_llm(txt_content).await?;

        if parsed_questions.is_empty() {
            return Err(AppError::validation("未能从文本中解析出题目"));
        }

        let json_data = serde_json::json!({
            "name": qbank_name,
            "questions": parsed_questions
        });

        self.import_from_json(&json_data.to_string(), None, folder_id)
            .await
    }

    /// P2-3: 从 DOCX 文档导入题目集
    ///
    /// 两阶段架构：
    /// - DOCX：提取文本 → LLM 解析 → JSON → 导入
    /// - PDF/图片：应使用整卷识别功能（OCR），不在此处理
    pub async fn import_from_document(
        &self,
        base64_content: &str,
        format: &str,
        qbank_name: Option<String>,
        folder_id: Option<String>,
    ) -> Result<ExamSheetSessionDetail, AppError> {
        use base64::Engine;

        // PDF 和图片应走整卷识别流程
        if format == "pdf" {
            return Err(AppError::validation(
                "PDF 文件请使用「整卷识别」功能导入。整卷识别支持 OCR 识别扫描件和图片型 PDF。",
            ));
        }

        // 解码 base64 内容
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64_content)
            .map_err(|e| AppError::validation(format!("Base64 解码失败: {}", e)))?;

        // 提取文本内容（仅 DOCX）
        let text_content = match format {
            "docx" => self.extract_docx_text(&bytes)?,
            _ => {
                return Err(AppError::validation(format!(
                    "不支持的文档格式: {}。支持的格式：DOCX（文本文档）。PDF/图片请使用整卷识别。",
                    format
                )));
            }
        };

        if text_content.trim().is_empty() {
            return Err(AppError::validation("无法从文档中提取文本内容"));
        }

        // 使用 LLM 解析文档内容为题目（严禁启发式匹配）
        let parsed_questions = self.parse_document_with_llm(&text_content).await?;

        if parsed_questions.is_empty() {
            return Err(AppError::validation("未能从文档中解析出题目"));
        }

        // 转换为 JSON 格式并导入
        let json_data = serde_json::json!({
            "name": qbank_name,
            "questions": parsed_questions
        });

        self.import_from_json(&json_data.to_string(), None, folder_id)
            .await
    }

    /// 从 DOCX 文件提取纯文本
    ///
    /// ★ 2026-02 统一：使用 DocumentParser (docx-rs) 替代原 ZIP + regex 方案，
    /// 与 attachment_read / resource_read 等路径共享同一解析逻辑，
    /// 支持表格、超链接、标题等完整内容提取。
    fn extract_docx_text(&self, bytes: &[u8]) -> Result<String, AppError> {
        let parser = crate::document_parser::DocumentParser::new();
        let text = parser
            .extract_text_from_bytes("document.docx", bytes.to_vec())
            .map_err(|e| AppError::validation(format!("DOCX 解析失败: {}", e)))?;

        if text.trim().is_empty() {
            return Err(AppError::validation("DOCX 文件内容为空或无法解析"));
        }

        Ok(text)
    }

    /// 使用 LLM 解析文档/文本内容为题目（支持超长文档分块处理）
    async fn parse_document_with_llm(
        &self,
        text_content: &str,
    ) -> Result<Vec<serde_json::Value>, AppError> {
        // 估算 token 数（粗略：中文 1.5 字符/token，英文 4 字符/token，取平均 2 字符/token）
        let estimated_tokens = text_content.chars().count() / 2;
        let max_tokens_per_chunk = 6000; // 留足够空间给 prompt 和响应

        println!(
            "[QuestionParsing] 文档长度: {} 字符, 估计 {} tokens",
            text_content.len(),
            estimated_tokens
        );

        // 如果文档较短，直接处理
        if estimated_tokens <= max_tokens_per_chunk {
            return self.parse_single_chunk(text_content).await;
        }

        // 超长文档：分块处理
        println!("[QuestionParsing] 文档超长，启用分块处理...");
        let chunks = self.segment_document_for_questions(text_content, max_tokens_per_chunk);
        println!("[QuestionParsing] 分割为 {} 个块", chunks.len());

        let mut all_questions = Vec::new();

        for (i, chunk) in chunks.iter().enumerate() {
            println!(
                "[QuestionParsing] 处理块 {}/{} ({} 字符)",
                i + 1,
                chunks.len(),
                chunk.len()
            );

            match self.parse_single_chunk(chunk).await {
                Ok(questions) => {
                    println!(
                        "[QuestionParsing] 块 {} 解析出 {} 道题目",
                        i + 1,
                        questions.len()
                    );
                    all_questions.extend(questions);
                }
                Err(e) => {
                    // 单个块失败不中断整体流程，记录日志继续
                    println!("[QuestionParsing] ⚠️ 块 {} 解析失败: {}", i + 1, e);
                }
            }
        }

        if all_questions.is_empty() {
            return Err(AppError::validation("所有块解析均失败，未能提取到题目"));
        }

        println!(
            "[QuestionParsing] 总计解析出 {} 道题目",
            all_questions.len()
        );
        Ok(all_questions)
    }

    /// 分割文档为多个块（按段落边界，保留上下文）
    fn segment_document_for_questions(&self, content: &str, max_tokens: usize) -> Vec<String> {
        // 按双换行分割段落
        let paragraphs: Vec<&str> = content
            .split("\n\n")
            .filter(|p| !p.trim().is_empty())
            .collect();

        // 如果段落太少，按单换行分割
        let paragraphs: Vec<&str> = if paragraphs.len() < 3 {
            content
                .split('\n')
                .filter(|p| !p.trim().is_empty())
                .collect()
        } else {
            paragraphs
        };

        let mut chunks = Vec::new();
        let mut current_chunk = String::new();
        let mut current_tokens = 0;

        for para in paragraphs {
            let para_tokens = para.chars().count() / 2; // 粗略估计

            // 如果单个段落就超过限制，需要强制分割
            if para_tokens > max_tokens {
                // 先保存当前块
                if !current_chunk.is_empty() {
                    chunks.push(current_chunk.trim().to_string());
                    current_chunk.clear();
                    current_tokens = 0;
                }

                // 按字符强制分割长段落
                let char_limit = max_tokens * 2;
                let chars: Vec<char> = para.chars().collect();
                for chunk_chars in chars.chunks(char_limit) {
                    let sub_chunk: String = chunk_chars.iter().collect();
                    chunks.push(sub_chunk);
                }
                continue;
            }

            // 检查添加这个段落是否会超出限制
            if current_tokens + para_tokens > max_tokens && !current_chunk.is_empty() {
                // 保存当前块并开始新块
                chunks.push(current_chunk.trim().to_string());
                current_chunk = para.to_string();
                current_tokens = para_tokens;
            } else {
                // 添加到当前块
                if !current_chunk.is_empty() {
                    current_chunk.push_str("\n\n");
                }
                current_chunk.push_str(para);
                current_tokens += para_tokens;
            }
        }

        // 添加最后一个块
        if !current_chunk.is_empty() {
            chunks.push(current_chunk.trim().to_string());
        }

        chunks
    }

    /// 解析单个文本块
    async fn parse_single_chunk(
        &self,
        chunk_content: &str,
    ) -> Result<Vec<serde_json::Value>, AppError> {
        let prompt = format!(
            r#"请将以下文本内容解析为题目列表。

**文本内容**：
{}

**输出要求**：
请输出 JSON 数组格式的题目列表（只输出 JSON，不要其他任何内容）：

```json
[
  {{
    "content": "完整的题目内容（包括选项）",
    "question_type": "single_choice|multiple_choice|fill_blank|short_answer|essay|calculation|proof|other",
    "answer": "答案",
    "explanation": "解析（如有）",
    "difficulty": "easy|medium|hard|very_hard",
    "tags": ["知识点标签"]
  }}
]
```

**解析规则**：
1. 识别所有题目，包括选择题、填空题、简答题、计算题等
2. 选择题的选项应包含在 content 中
3. 根据题目特征自动判断 question_type
4. difficulty 默认为 "medium"
5. 如无法确定某字段可省略
6. tags 根据题目知识点自动生成"#,
            chunk_content
        );

        // 调用 LLM
        let response = self
            .llm_manager
            .call_llm_for_question_parsing(&prompt)
            .await
            .map_err(|e| AppError::validation(format!("LLM 解析失败: {}", e)))?;

        // 从响应中提取 JSON
        let json_str = if let Some(start) = response.find('[') {
            if let Some(end) = response.rfind(']') {
                &response[start..=end]
            } else {
                return Err(AppError::validation(
                    "LLM 响应格式错误：未找到有效 JSON 数组",
                ));
            }
        } else {
            return Err(AppError::validation("LLM 响应格式错误：未找到题目列表"));
        };

        let questions: Vec<serde_json::Value> = serde_json::from_str(json_str)
            .map_err(|e| AppError::validation(format!("解析 LLM 响应失败: {}", e)))?;

        Ok(questions)
    }
}
