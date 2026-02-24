//! Stage 4: Figure Extractor — 配图裁切、质量校验与精确关联
//!
//! 从页面图片中按 VLM 提供的 bbox 坐标裁切配图，
//! 存储到 VFS Blob 并创建 QuestionImage 关联记录。
//!
//! 页面图片按 blob_hash 从 VFS 按需读取，避免长期持有大量内存。

use image::GenericImageView;
use tracing::{debug, info, warn};

use crate::cross_page_merger::MergedQuestion;
use crate::models::AppError;
use crate::page_rasterizer::{self, PageSlice};
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{QuestionImage, VfsBlobRepo, VfsFileRepo};
use crate::vlm_grounding_service::VlmGroundingService;

const MIN_FIGURE_SIZE: u32 = 30;

/// 题目及其精确关联的配图列表
#[derive(Debug, Clone)]
pub struct QuestionWithFigures {
    pub merged: MergedQuestion,
    pub images: Vec<QuestionImage>,
}

/// 为合并后的题目列表批量裁切配图并关联到各题
///
/// 页面图片按需通过 `blob_hash` 从 VFS 读取，不要求 PageSlice 持有 image_bytes。
pub fn extract_figures(
    merged_questions: Vec<MergedQuestion>,
    pages: &[PageSlice],
    vfs_db: &VfsDatabase,
) -> Vec<QuestionWithFigures> {
    let mut results = Vec::with_capacity(merged_questions.len());
    let mut total_extracted = 0usize;
    let mut total_skipped = 0usize;

    // 缓存已加载的页面图片，避免同一页面反复读磁盘
    let mut page_image_cache: std::collections::HashMap<usize, Vec<u8>> =
        std::collections::HashMap::new();

    for mq in merged_questions {
        let mut images: Vec<QuestionImage> = Vec::new();

        for (page_idx, figure) in &mq.figures_with_page {
            let page = match pages.get(*page_idx) {
                Some(p) => p,
                None => {
                    warn!(
                        "[FigureExtractor] 页面索引 {} 超出范围，跳过配图 '{}'",
                        page_idx, figure.fig_label
                    );
                    total_skipped += 1;
                    continue;
                }
            };

            let page_bytes = match page_image_cache.get(page_idx) {
                Some(bytes) => bytes.clone(),
                None => {
                    match page_rasterizer::load_page_image_bytes(vfs_db, &page.blob_hash) {
                        Ok(bytes) => {
                            page_image_cache.insert(*page_idx, bytes.clone());
                            bytes
                        }
                        Err(e) => {
                            warn!(
                                "[FigureExtractor] 加载页面 {} 图片失败: {}",
                                page_idx + 1,
                                e
                            );
                            total_skipped += 1;
                            continue;
                        }
                    }
                }
            };

            let cropped_bytes =
                match VlmGroundingService::crop_figure_from_page(&page_bytes, &figure.bbox) {
                    Ok(b) => b,
                    Err(e) => {
                        debug!(
                            "[FigureExtractor] 裁切失败 (页面{}, '{}'): {}",
                            page_idx + 1,
                            figure.fig_label,
                            e
                        );
                        total_skipped += 1;
                        continue;
                    }
                };

            if let Ok(img) = image::load_from_memory(&cropped_bytes) {
                let (w, h) = img.dimensions();
                if w < MIN_FIGURE_SIZE || h < MIN_FIGURE_SIZE {
                    debug!(
                        "[FigureExtractor] 配图太小 ({}x{})，跳过: '{}'",
                        w, h, figure.fig_label
                    );
                    total_skipped += 1;
                    continue;
                }
            }

            match store_figure(vfs_db, &cropped_bytes, &figure.fig_label, *page_idx) {
                Ok(qi) => {
                    images.push(qi);
                    total_extracted += 1;
                }
                Err(e) => {
                    warn!(
                        "[FigureExtractor] 存储配图失败 (页面{}, '{}'): {}",
                        page_idx + 1,
                        figure.fig_label,
                        e
                    );
                    total_skipped += 1;
                }
            }
        }

        results.push(QuestionWithFigures {
            merged: mq,
            images,
        });
    }

    info!(
        "[FigureExtractor] 完成: 提取 {} 张配图, 跳过 {} 张",
        total_extracted, total_skipped
    );

    results
}

fn store_figure(
    vfs_db: &VfsDatabase,
    image_bytes: &[u8],
    fig_label: &str,
    page_idx: usize,
) -> Result<QuestionImage, AppError> {
    let blob = VfsBlobRepo::store_blob(vfs_db, image_bytes, Some("image/png"), Some("png"))
        .map_err(|e| AppError::database(format!("配图 Blob 存储失败: {}", e)))?;

    let file_name = format!("fig_p{}_{}.png", page_idx, sanitize_label(fig_label));

    let vfs_file = VfsFileRepo::create_file(
        vfs_db,
        &blob.hash,
        &file_name,
        image_bytes.len() as i64,
        "image",
        Some("image/png"),
        Some(&blob.hash),
        None,
    )
    .map_err(|e| AppError::database(format!("创建配图 VFS 文件失败: {}", e)))?;

    Ok(QuestionImage {
        id: vfs_file.id,
        name: file_name,
        mime: "image/png".to_string(),
        hash: blob.hash,
    })
}

fn sanitize_label(label: &str) -> String {
    label
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_')
        .take(20)
        .collect::<String>()
}
