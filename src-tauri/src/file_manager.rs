use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use tokio::fs as async_fs;
// use tokio::io::AsyncWriteExt; // Removed unused import
use crate::models::AppError;
use base64::{engine::general_purpose, Engine as _};
use image::{imageops::FilterType, DynamicImage, GenericImageView, ImageOutputFormat};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tracing::{debug, error, info, warn};
use urlencoding::decode as url_decode;
use uuid::Uuid;

type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageStatistics {
    pub total_files: u64,
    pub total_size_bytes: u64,
    pub file_types: HashMap<String, u32>, // extension -> count
    pub oldest_file: Option<u64>,         // timestamp
    pub newest_file: Option<u64>,         // timestamp
}

pub struct FileManager {
    app_data_dir: PathBuf,
    images_dir: PathBuf,
}

impl FileManager {
    /// 创建新的文件管理器
    pub fn new(app_data_dir: PathBuf) -> Result<Self> {
        let images_dir = app_data_dir.join("images");

        // init file manager

        Ok(FileManager {
            app_data_dir,
            images_dir,
        })
    }

    /// 按视觉质量策略调整 base64 图片（真正的图片压缩）
    ///
    /// ## 质量策略
    /// - `low`: 最大 768px，JPEG 质量 60%，适用于概览/缩略图
    /// - `medium`: 最大 1024px，JPEG 质量 75%，适用于一般理解
    /// - `high`: 不压缩，保持原样，适用于 OCR/细节识别
    /// - `auto`: 根据图片大小自动选择（>2MP 用 medium，>4MP 用 low）
    ///
    /// ## 行业标准参考（2025-2026）
    /// - OpenAI: 缩放至 2048x2048 内，短边 768px，High detail 按 512px 瓦片
    /// - Claude: 推荐 ≤1.15MP（1568x1568），长边 >1568px 自动缩放
    /// - Gemini: Token 效率比 GPT-4o 高 3.5x
    pub fn adjust_image_quality_base64(&self, base64_data: &str, vision_quality: &str) -> String {
        // high 质量不压缩
        if vision_quality == "high" {
            return base64_data.to_string();
        }

        // 解码 base64 数据
        let decoded = match general_purpose::STANDARD.decode(base64_data) {
            Ok(d) => d,
            Err(e) => {
                error!("⚠️ [图片压缩] Base64 解码失败: {}", e);
                return base64_data.to_string();
            }
        };

        // 加载图片
        let img = match image::load_from_memory(&decoded) {
            Ok(i) => i,
            Err(e) => {
                error!("⚠️ [图片压缩] 图片加载失败: {}", e);
                return base64_data.to_string();
            }
        };

        let (width, height) = img.dimensions();
        let megapixels = (width as f64 * height as f64) / 1_000_000.0;

        // 根据 vision_quality 确定参数
        let (max_dimension, jpeg_quality, quality_name) = match vision_quality {
            "low" => (768u32, 60u8, "low"),
            "medium" => (1024u32, 75u8, "medium"),
            "auto" => {
                // 自动模式：根据图片大小选择
                if megapixels > 4.0 {
                    (768u32, 60u8, "auto->low")
                } else if megapixels > 2.0 {
                    (1024u32, 75u8, "auto->medium")
                } else {
                    // 小图片不需要压缩
                    return base64_data.to_string();
                }
            }
            _ => {
                // 未知策略，默认不压缩
                return base64_data.to_string();
            }
        };

        // 检查是否需要缩放
        let needs_resize = width > max_dimension || height > max_dimension;

        // 如果图片已经很小且不需要缩放，检查是否需要重编码
        if !needs_resize && decoded.len() < 500_000 {
            // 小于 500KB 且尺寸合适，不压缩
            return base64_data.to_string();
        }

        // 执行缩放（如果需要）
        // 🔧 性能优化：使用 Triangle 滤波器替代 Lanczos3
        // - Lanczos3: 最高质量，但速度慢（每张图约 100-200ms）
        // - Triangle: 质量良好，速度快 3-5 倍（每张图约 20-50ms）
        // 对于 LLM 多模态理解，Triangle 质量完全足够
        let processed_img: DynamicImage = if needs_resize {
            // 计算缩放后的尺寸，保持宽高比
            let scale = max_dimension as f64 / width.max(height) as f64;
            let new_width = (width as f64 * scale) as u32;
            let new_height = (height as f64 * scale) as u32;

            img.resize(new_width, new_height, FilterType::Triangle)
        } else {
            img
        };

        let (new_width, new_height) = processed_img.dimensions();

        // 编码为 JPEG
        let mut buffer = Cursor::new(Vec::new());
        if let Err(e) = processed_img.write_to(&mut buffer, ImageOutputFormat::Jpeg(jpeg_quality)) {
            error!("⚠️ [图片压缩] JPEG 编码失败: {}", e);
            return base64_data.to_string();
        }

        let compressed_data = buffer.into_inner();
        let compressed_base64 = general_purpose::STANDARD.encode(&compressed_data);

        let original_size = decoded.len();
        let compressed_size = compressed_data.len();
        let compression_ratio = (1.0 - compressed_size as f64 / original_size as f64) * 100.0;

        debug!(
            "🗜️ [图片压缩] quality={}, {}x{} -> {}x{}, {} KB -> {} KB ({:.1}% 压缩)",
            quality_name,
            width,
            height,
            new_width,
            new_height,
            original_size / 1024,
            compressed_size / 1024,
            compression_ratio
        );

        compressed_base64
    }

    /// 获取自适应的应用数据目录（带可写性检测）
    /// 如果原目录不可写，会自动回退到临时目录
    pub fn get_writable_app_data_dir(&self) -> PathBuf {
        fn ensure_writable(dir: &Path) -> bool {
            if let Err(err) = std::fs::create_dir_all(dir) {
                error!(
                    "⚠️ [文件系统] 创建目录失败 {}: {}",
                    dir.to_string_lossy(),
                    err
                );
                return false;
            }
            let probe = dir.join(".write_test");
            let result = std::fs::File::create(&probe).and_then(|mut f| f.write_all(b"ok"));
            match result {
                Ok(_) => {
                    let _ = std::fs::remove_file(&probe);
                    true
                }
                Err(err) => {
                    error!(
                        "⚠️ [文件系统] 目录不可写 {}: {}",
                        dir.to_string_lossy(),
                        err
                    );
                    let _ = std::fs::remove_file(&probe);
                    false
                }
            }
        }

        let primary = self.app_data_dir.clone();
        if ensure_writable(&primary) {
            return primary;
        }

        if let Some(data_dir) = dirs::data_dir() {
            let candidate = data_dir.join("DeepStudent");
            if ensure_writable(&candidate) {
                return candidate;
            }
        }

        // fallback to temp dir
        let temp_app_data = std::env::temp_dir().join("deep_student_data");
        if !ensure_writable(&temp_app_data) {
            warn!(
                "⚠️ [文件系统] 无法获取稳定的持久目录，临时使用 {}",
                temp_app_data.to_string_lossy()
            );
        }
        temp_app_data
    }

    /// 获取数据库路径
    pub fn get_database_path(&self) -> PathBuf {
        // 使用自适应的应用数据目录
        let writable_dir = self.get_writable_app_data_dir();
        writable_dir.join("mistakes.db")
    }

    /// 获取 images 根目录的绝对路径
    pub fn images_directory(&self) -> PathBuf {
        self.images_dir.clone()
    }

    /// 将 `images/` 相对路径转换为绝对路径
    /// 如果传入的已经是绝对路径，则直接返回（支持临时文件路径等场景）
    pub fn resolve_image_path(&self, relative_path: &str) -> PathBuf {
        // 检测是否已经是绝对路径（Unix: 以 / 开头且长度 > 1，Windows: 包含盘符如 C:\）
        let path = std::path::Path::new(relative_path);
        if path.is_absolute() {
            return path.to_path_buf();
        }

        let trimmed = relative_path
            .strip_prefix("images/")
            .unwrap_or(relative_path)
            .trim_start_matches('/')
            .replace("..", "");
        self.images_dir.join(trimmed)
    }

    /// 保存base64编码的图片文件
    pub async fn save_image_from_base64(
        &self,
        base64_data: &str,
        filename: &str,
    ) -> Result<String> {
        // save image

        // 确保图片目录存在
        async_fs::create_dir_all(&self.images_dir)
            .await
            .map_err(|e| AppError::file_system(format!("创建图片目录失败: {}", e)))?;

        // 解析base64数据
        let data_url_prefix = "data:image/";
        let base64_start = if base64_data.starts_with(data_url_prefix) {
            base64_data
                .find("base64,")
                .ok_or_else(|| AppError::validation("无效的base64数据格式"))?
                + 7 // "base64,".len()
        } else {
            0
        };

        let base64_content = &base64_data[base64_start..];
        let image_bytes = general_purpose::STANDARD
            .decode(base64_content)
            .map_err(|e| AppError::validation(format!("base64解码失败: {}", e)))?;

        // 保存文件
        let file_path = self.images_dir.join(filename);
        // 确保父目录存在（允许嵌套子目录，如 images/textbook_thumbs）
        if let Some(parent) = file_path.parent() {
            async_fs::create_dir_all(parent)
                .await
                .map_err(|e| AppError::file_system(format!("创建图片父目录失败: {}", e)))?;
        }
        async_fs::write(&file_path, image_bytes)
            .await
            .map_err(|e| AppError::file_system(format!("保存图片文件失败: {}", e)))?;

        // 返回相对路径
        Ok(format!("images/{}", filename))
    }

    /// 读取图片文件为base64（用于统一AI接口）
    pub fn read_file_as_base64(&self, relative_path: &str) -> Result<String> {
        // 兼容多种路径：app相对路径(images/..)、file://、tauri://localhost、asset://localhost、绝对路径
        let mut raw = relative_path.to_string();
        if raw.starts_with("tauri://localhost/") {
            raw = raw.replacen("tauri://localhost/", "/", 1);
        } else if raw.starts_with("tauri://") {
            raw = raw.replacen("tauri://", "/", 1);
        }
        if raw.starts_with("asset://localhost/") {
            raw = raw.replacen("asset://localhost/", "/", 1);
        } else if raw.starts_with("asset://") {
            raw = raw.replacen("asset://", "/", 1);
        }
        if raw.starts_with("file:///") {
            raw = raw.replacen("file:///", "/", 1);
        } else if raw.starts_with("file://") {
            raw = raw.replacen("file://", "/", 1);
        }

        let decoded = url_decode(&raw)
            .unwrap_or_else(|_| raw.clone().into())
            .into_owned();
        let mut pstr = decoded;

        // 某些来源会移除前导/，尝试还原典型绝对路径
        if !pstr.starts_with('/')
            && (pstr.starts_with("Users/")
                || pstr.starts_with("home/")
                || pstr.starts_with("Volumes/")
                || pstr.starts_with("private/")
                || pstr.starts_with("var/"))
        {
            pstr = format!("/{}", pstr);
        }

        let looks_windows_drive = pstr.len() > 2
            && pstr.as_bytes()[1] == b':'
            && (pstr.as_bytes()[2] == b'/' || pstr.as_bytes()[2] == b'\\');
        let is_absolute = std::path::Path::new(&pstr).is_absolute() || looks_windows_drive;

        // 绝对路径或相对路径都强制限制在 app_data_dir 子树
        let requested = if is_absolute {
            std::path::PathBuf::from(&pstr)
        } else {
            self.app_data_dir.join(&pstr)
        };
        let base = std::fs::canonicalize(&self.app_data_dir)
            .map_err(|e| AppError::file_system(format!("解析app_data_dir失败: {}", e)))?;
        // canonicalize in blocking without async/await (this function is not async)
        let can = std::fs::canonicalize(&requested).unwrap_or(requested.clone());
        if !can.starts_with(&base) {
            return Err(AppError::validation("拒绝访问：超出应用数据目录"));
        }

        if !can.exists() {
            return Err(AppError::not_found(format!(
                "图片文件不存在: {}",
                can.display()
            )));
        }

        let image_bytes = std::fs::read(&can)
            .map_err(|e| AppError::file_system(format!("读取图片文件失败: {}", e)))?;

        let base64_content = general_purpose::STANDARD.encode(&image_bytes);
        Ok(base64_content)
    }

    /// 读取图片文件为base64（带MIME类型）
    pub async fn get_image_as_base64(&self, relative_path: &str) -> Result<String> {
        // 兼容多种路径：app相对路径(images/..)、file://、tauri://localhost、asset://localhost、绝对路径
        let mut raw = relative_path.to_string();
        if raw.starts_with("tauri://localhost/") {
            raw = raw.replacen("tauri://localhost/", "/", 1);
        } else if raw.starts_with("tauri://") {
            raw = raw.replacen("tauri://", "/", 1);
        }
        if raw.starts_with("asset://localhost/") {
            raw = raw.replacen("asset://localhost/", "/", 1);
        } else if raw.starts_with("asset://") {
            raw = raw.replacen("asset://", "/", 1);
        }
        if raw.starts_with("file:///") {
            raw = raw.replacen("file:///", "/", 1);
        } else if raw.starts_with("file://") {
            raw = raw.replacen("file://", "/", 1);
        }

        let decoded = url_decode(&raw)
            .unwrap_or_else(|_| raw.clone().into())
            .into_owned();
        let mut pstr = decoded;
        if !pstr.starts_with('/')
            && (pstr.starts_with("Users/")
                || pstr.starts_with("home/")
                || pstr.starts_with("Volumes/")
                || pstr.starts_with("private/")
                || pstr.starts_with("var/"))
        {
            pstr = format!("/{}", pstr);
        }
        let looks_windows_drive = pstr.len() > 2
            && pstr.as_bytes()[1] == b':'
            && (pstr.as_bytes()[2] == b'/' || pstr.as_bytes()[2] == b'\\');
        let is_absolute = std::path::Path::new(&pstr).is_absolute() || looks_windows_drive;

        let requested = if is_absolute {
            std::path::PathBuf::from(&pstr)
        } else {
            self.app_data_dir.join(&pstr)
        };
        let base = std::fs::canonicalize(&self.app_data_dir)
            .map_err(|e| AppError::file_system(format!("解析app_data_dir失败: {}", e)))?;
        let req_clone = requested.clone();
        let can = match tokio::task::spawn_blocking(move || std::fs::canonicalize(&req_clone)).await
        {
            Ok(Ok(path)) => path,
            _ => requested.clone(),
        };
        if !can.starts_with(&base) {
            return Err(AppError::validation("拒绝访问：超出应用数据目录"));
        }

        if !async_fs::try_exists(&can)
            .await
            .map_err(|e| AppError::file_system(format!("检查文件存在性失败: {}", e)))?
        {
            return Err(AppError::not_found(format!(
                "图片文件不存在: {}",
                can.display()
            )));
        }

        let image_bytes = async_fs::read(&can)
            .await
            .map_err(|e| AppError::file_system(format!("读取图片文件失败: {}", e)))?;

        let base64_content = general_purpose::STANDARD.encode(&image_bytes);

        // 根据文件扩展名确定MIME类型
        let mime_type = Self::infer_mime_from_path(&can);

        Ok(format!("data:{};base64,{}", mime_type, base64_content))
    }

    /// 删除图片文件
    pub async fn delete_image(&self, relative_path: &str) -> Result<()> {
        // delete image

        let file_path = self.app_data_dir.join(relative_path);
        if async_fs::try_exists(&file_path)
            .await
            .map_err(|e| AppError::file_system(format!("检查文件存在性失败: {}", e)))?
        {
            async_fs::remove_file(&file_path)
                .await
                .map_err(|e| AppError::file_system(format!("删除图片文件失败: {}", e)))?;
        }

        Ok(())
    }

    pub fn infer_mime_from_path(path: &Path) -> &'static str {
        let lower = path.to_string_lossy().to_lowercase();
        if lower.ends_with(".png") {
            "image/png"
        } else if lower.ends_with(".gif") {
            "image/gif"
        } else if lower.ends_with(".webp") {
            "image/webp"
        } else if lower.ends_with(".bmp") {
            "image/bmp"
        } else if lower.ends_with(".heic") {
            "image/heic"
        } else if lower.ends_with(".heif") {
            "image/heif"
        } else {
            "image/jpeg"
        }
    }

    /// 删除多个图片文件
    pub fn delete_images(&self, relative_paths: &[String]) -> Result<()> {
        // delete multiple images
        for path in relative_paths {
            let file_path = self.app_data_dir.join(path);
            if file_path.exists() {
                fs::remove_file(&file_path)
                    .map_err(|e| AppError::file_system(format!("删除图片文件失败: {}", e)))?;
            }
        }
        Ok(())
    }

    /// 清理孤立的图片文件
    pub async fn cleanup_orphaned_images(
        &self,
        database: &crate::database::Database,
    ) -> Result<Vec<String>> {
        // cleanup orphan images

        if !async_fs::try_exists(&self.images_dir)
            .await
            .map_err(|e| AppError::file_system(format!("检查图片目录存在性失败: {}", e)))?
        {
            warn!("图片目录不存在，跳过清理");
            return Ok(vec![]);
        }

        let mut cleaned_files = Vec::new();

        // 1. 收集所有物理图片文件
        let mut all_physical_files = std::collections::HashSet::new();
        let mut entries = async_fs::read_dir(&self.images_dir)
            .await
            .map_err(|e| AppError::file_system(format!("读取图片目录失败: {}", e)))?;

        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| AppError::file_system(format!("读取目录条目失败: {}", e)))?
        {
            let path = entry.path();
            if path.is_file() {
                if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
                    // 构建相对路径（相对于app_data_dir）
                    let relative_path = format!("images/{}", filename);
                    all_physical_files.insert(relative_path);
                }
            }
        }

        info!("发现 {} 个物理图片文件", all_physical_files.len());

        // 2. 从数据库获取所有被引用的图片路径
        let referenced_images = self.get_referenced_images(database)?;
        info!("数据库中引用了 {} 个图片文件", referenced_images.len());

        // 3. 找出孤立的图片文件
        for physical_file in &all_physical_files {
            if !referenced_images.contains(physical_file) {
                info!("发现孤立图片文件: {}", physical_file);

                // 删除孤立文件
                let full_path = self.app_data_dir.join(physical_file);
                match async_fs::remove_file(&full_path).await {
                    Ok(()) => {
                        cleaned_files.push(physical_file.clone());
                        info!("已删除孤立图片: {}", physical_file);
                    }
                    Err(e) => {
                        error!("删除孤立图片失败: {} - {}", physical_file, e);
                    }
                }
            }
        }

        // 4. 清理空的子目录
        self.cleanup_empty_directories().await?;

        info!("清理完成，删除了 {} 个孤立图片文件", cleaned_files.len());
        Ok(cleaned_files)
    }

    /// 从数据库获取所有被引用的图片路径
    fn get_referenced_images(
        &self,
        database: &crate::database::Database,
    ) -> Result<std::collections::HashSet<String>> {
        use rusqlite::params;

        let conn = database
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let mut referenced_images = std::collections::HashSet::new();

        // 查询所有错题的图片路径
        let mut stmt = conn
            .prepare("SELECT question_images, analysis_images FROM mistakes")
            .map_err(|e| AppError::database(format!("准备查询语句失败: {}", e)))?;

        let rows = stmt
            .query_map(params![], |row| {
                let question_images: String = row.get(0)?;
                let analysis_images: String = row.get(1)?;
                Ok((question_images, analysis_images))
            })
            .map_err(|e| AppError::database(format!("执行查询失败: {}", e)))?;

        for row_result in rows {
            let (question_images_json, analysis_images_json) =
                row_result.map_err(|e| AppError::database(format!("读取行数据失败: {}", e)))?;

            // 解析JSON数组 - 改进错误处理以防止数据丢失
            match serde_json::from_str::<Vec<String>>(&question_images_json) {
                Ok(question_paths) => {
                    for path in question_paths {
                        referenced_images.insert(path);
                    }
                }
                Err(e) => {
                    warn!(
                        "解析question_images JSON失败: {} - 数据: {}",
                        e, question_images_json
                    );
                    // 不忽略错误，中止清理过程以防止数据丢失
                    return Err(AppError::validation(format!(
                        "解析错题图片路径JSON失败，中止孤立图片清理以防止数据丢失: {}",
                        e
                    )));
                }
            }

            match serde_json::from_str::<Vec<String>>(&analysis_images_json) {
                Ok(analysis_paths) => {
                    for path in analysis_paths {
                        referenced_images.insert(path);
                    }
                }
                Err(e) => {
                    warn!(
                        "解析analysis_images JSON失败: {} - 数据: {}",
                        e, analysis_images_json
                    );
                    // 不忽略错误，中止清理过程以防止数据丢失
                    return Err(AppError::validation(format!(
                        "解析分析图片路径JSON失败，中止孤立图片清理以防止数据丢失: {}",
                        e
                    )));
                }
            }
        }

        Ok(referenced_images)
    }

    /// 清理空的子目录
    async fn cleanup_empty_directories(&self) -> Result<()> {
        debug!("清理空目录");

        let mut entries = async_fs::read_dir(&self.images_dir)
            .await
            .map_err(|e| AppError::file_system(format!("读取图片目录失败: {}", e)))?;

        let mut directories_to_check = Vec::new();

        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| AppError::file_system(format!("读取目录条目失败: {}", e)))?
        {
            let path = entry.path();
            if path.is_dir() {
                directories_to_check.push(path);
            }
        }

        // 检查并删除空目录
        for dir_path in directories_to_check {
            match self.is_directory_empty(&dir_path).await {
                Ok(true) => {
                    if let Err(e) = async_fs::remove_dir(&dir_path).await {
                        error!("删除空目录失败: {:?} - {}", dir_path, e);
                    } else {
                        info!("已删除空目录: {:?}", dir_path);
                    }
                }
                Ok(false) => {
                    // 目录不为空，跳过
                }
                Err(e) => {
                    error!("检查目录是否为空失败: {:?} - {}", dir_path, e);
                }
            }
        }

        Ok(())
    }

    /// 检查目录是否为空
    async fn is_directory_empty(&self, dir_path: &Path) -> Result<bool> {
        let mut entries = async_fs::read_dir(dir_path)
            .await
            .map_err(|e| AppError::file_system(format!("读取目录失败: {}", e)))?;

        // 如果能读取到第一个条目，说明目录不为空
        match entries.next_entry().await {
            Ok(Some(_)) => Ok(false), // 有条目，不为空
            Ok(None) => Ok(true),     // 没有条目，为空
            Err(e) => Err(AppError::file_system(format!("检查目录内容失败: {}", e))),
        }
    }

    /// 获取图片文件统计信息
    pub async fn get_image_statistics(&self) -> Result<ImageStatistics> {
        let mut stats = ImageStatistics {
            total_files: 0,
            total_size_bytes: 0,
            file_types: std::collections::HashMap::new(),
            oldest_file: None,
            newest_file: None,
        };

        if !async_fs::try_exists(&self.images_dir)
            .await
            .map_err(|e| AppError::file_system(format!("检查图片目录存在性失败: {}", e)))?
        {
            return Ok(stats);
        }

        let mut entries = async_fs::read_dir(&self.images_dir)
            .await
            .map_err(|e| AppError::file_system(format!("读取图片目录失败: {}", e)))?;

        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| AppError::file_system(format!("读取目录条目失败: {}", e)))?
        {
            let path = entry.path();
            if path.is_file() {
                // 获取文件元数据
                let metadata = async_fs::metadata(&path)
                    .await
                    .map_err(|e| AppError::file_system(format!("获取文件元数据失败: {}", e)))?;

                stats.total_files += 1;
                stats.total_size_bytes += metadata.len();

                // 统计文件类型
                if let Some(extension) = path.extension().and_then(|ext| ext.to_str()) {
                    *stats
                        .file_types
                        .entry(extension.to_lowercase())
                        .or_insert(0) += 1;
                }

                // 获取修改时间
                if let Ok(modified) = metadata.modified() {
                    let modified_timestamp = modified
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();

                    if stats.oldest_file.is_none()
                        || modified_timestamp < stats.oldest_file.unwrap()
                    {
                        stats.oldest_file = Some(modified_timestamp);
                    }

                    if stats.newest_file.is_none()
                        || modified_timestamp > stats.newest_file.unwrap()
                    {
                        stats.newest_file = Some(modified_timestamp);
                    }
                }
            }
        }

        Ok(stats)
    }

    /// 验证图片格式 (基于路径的存根)
    pub fn validate_image_format_from_path_stub(&self, relative_path: &str) -> Result<bool> {
        debug!("验证图片格式 (存根): {}", relative_path);
        // 基于文件扩展名的轻量校验（避免引入重量依赖）
        let lower = relative_path.to_ascii_lowercase();
        let allowed = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"];
        Ok(allowed.iter().any(|ext| lower.ends_with(ext)))
    }

    // 第一个 extract_extension_from_base64 (占位符) 已被移除，保留下面的实际实现

    /// 保存图片文件（从字节数据）
    pub fn save_image_from_bytes(&self, image_data: &[u8], file_extension: &str) -> Result<String> {
        // 确保图片目录存在
        fs::create_dir_all(&self.images_dir)
            .map_err(|e| AppError::file_system(format!("创建图片目录失败: {}", e)))?;

        // 生成唯一文件名
        let file_id = Uuid::new_v4().to_string();
        let filename = format!("{}.{}", file_id, file_extension);
        let file_path = self.images_dir.join(&filename);

        // 写入文件
        let mut file = fs::File::create(&file_path)
            .map_err(|e| AppError::file_system(format!("创建图片文件失败: {}", e)))?;
        file.write_all(image_data)
            .map_err(|e| AppError::file_system(format!("写入图片文件失败: {}", e)))?;

        // 返回相对路径
        Ok(format!("images/{}", filename))
    }

    /// 获取图片文件的绝对路径
    pub fn get_image_absolute_path(&self, relative_path: &str) -> PathBuf {
        self.app_data_dir.join(relative_path)
    }

    /// 检查图片文件是否存在
    pub fn image_exists(&self, relative_path: &str) -> bool {
        let file_path = self.app_data_dir.join(relative_path);
        file_path.exists()
    }

    /// 获取图片文件大小
    pub fn get_image_size(&self, relative_path: &str) -> Result<u64> {
        let file_path = self.app_data_dir.join(relative_path);
        let metadata = fs::metadata(&file_path)
            .map_err(|e| AppError::file_system(format!("获取文件元数据失败: {}", e)))?;
        Ok(metadata.len())
    }

    /// 保存笔记资源（图片等）：返回(绝对路径, 相对路径)
    pub fn save_note_asset_from_base64(
        &self,
        subject: &str,
        note_id: &str,
        base64_data: &str,
        default_ext: &str,
    ) -> Result<(String, String)> {
        let writable_dir = self.get_writable_app_data_dir();
        let dir = writable_dir
            .join("notes_assets")
            .join(subject)
            .join(note_id);
        fs::create_dir_all(&dir)
            .map_err(|e| AppError::file_system(format!("创建资源目录失败: {}", e)))?;

        // 提取 MIME 和内容
        let (mime, data_b64) = if let Some(idx) = base64_data.find("base64,") {
            (&base64_data[5..idx], &base64_data[idx + 7..])
        } else {
            ("", base64_data)
        };
        let bytes = general_purpose::STANDARD
            .decode(data_b64)
            .map_err(|e| AppError::validation(format!("base64解码失败: {}", e)))?;
        let ext = if mime.contains("image/png") {
            "png"
        } else if mime.contains("image/webp") {
            "webp"
        } else if mime.contains("image/gif") {
            "gif"
        } else if mime.contains("image/bmp") {
            "bmp"
        } else if mime.contains("image/jpg") || mime.contains("image/jpeg") {
            "jpg"
        } else {
            default_ext
        };
        let file = format!("{}.{}", uuid::Uuid::new_v4(), ext);
        let abs = dir.join(&file);
        fs::write(&abs, &bytes)
            .map_err(|e| AppError::file_system(format!("写入资源失败: {}", e)))?;
        let abs_str = abs.to_string_lossy().to_string();
        let rel_str = abs
            .strip_prefix(&writable_dir)
            .unwrap_or(&abs)
            .to_string_lossy()
            .to_string();
        Ok((abs_str, rel_str))
    }

    /// 保存 PDF 文件（从 base64 数据），返回 (相对路径, 绝对路径)
    pub async fn save_pdf_from_base64(
        &self,
        base64_data: &str,
        file_name_hint: Option<&str>,
        temp_id: &str,
    ) -> Result<(String, String)> {
        let base_dir = self
            .get_writable_app_data_dir()
            .join("pdf_ocr_sessions")
            .join(temp_id);
        async_fs::create_dir_all(&base_dir)
            .await
            .map_err(|e| AppError::file_system(format!("创建PDF目录失败: {}", e)))?;

        let pdf_bytes = Self::decode_base64_payload(base64_data)?;
        let sanitized_name = Self::sanitize_pdf_file_name(file_name_hint);
        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
        let final_name = format!("{}_{}", timestamp, sanitized_name);
        let file_path = base_dir.join(&final_name);

        async_fs::write(&file_path, &pdf_bytes)
            .await
            .map_err(|e| AppError::file_system(format!("写入PDF文件失败: {}", e)))?;

        let writable_dir = self.get_writable_app_data_dir();
        let rel_path = file_path
            .strip_prefix(&writable_dir)
            .unwrap_or(&file_path)
            .to_string_lossy()
            .to_string();
        let abs_path = file_path.to_string_lossy().to_string();

        Ok((rel_path, abs_path))
    }

    fn decode_base64_payload(data: &str) -> Result<Vec<u8>> {
        let trimmed = data.trim();
        let payload = if let Some(idx) = trimmed.find("base64,") {
            &trimmed[idx + 7..]
        } else {
            trimmed
        };

        general_purpose::STANDARD
            .decode(payload)
            .map_err(|e| AppError::validation(format!("base64解码失败: {}", e)))
    }

    fn sanitize_pdf_file_name(hint: Option<&str>) -> String {
        let candidate = hint.unwrap_or("document.pdf").trim();
        let mut sanitized: String = candidate
            .chars()
            .map(|c| match c {
                'a'..='z' | 'A'..='Z' | '0'..='9' => c,
                '.' | '-' | '_' => c,
                _ => '_',
            })
            .collect();

        if sanitized.is_empty() {
            sanitized = "document".to_string();
        }

        // 移除连续的点或下划线开头/结尾
        sanitized = sanitized
            .trim_matches(|c| c == '.' || c == '_' || c == '-')
            .to_string();
        if sanitized.is_empty() {
            sanitized = "document".to_string();
        }

        if !sanitized.to_ascii_lowercase().ends_with(".pdf") {
            sanitized.push_str(".pdf");
        }

        sanitized
    }

    /// 列出笔记资源（返回相对路径）
    pub fn list_note_assets(&self, subject: &str, note_id: &str) -> Result<Vec<(String, String)>> {
        let writable_dir = self.get_writable_app_data_dir();
        let dir = writable_dir
            .join("notes_assets")
            .join(subject)
            .join(note_id);

        debug!("[list_note_assets] writable_dir: {:?}", writable_dir);
        debug!("[list_note_assets] dir: {:?}", dir);

        let mut out: Vec<(String, String)> = Vec::new();
        if dir.exists() {
            for entry in fs::read_dir(&dir)
                .map_err(|e| AppError::file_system(format!("读取资源目录失败: {}", e)))?
            {
                let entry =
                    entry.map_err(|e| AppError::file_system(format!("读取目录条目失败: {}", e)))?;
                let path = entry.path();
                if path.is_file() {
                    // 🔧 修复：使用 writable_dir 计算相对路径，与 delete_note_asset 保持一致
                    let rel = path
                        .strip_prefix(&writable_dir)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .to_string();
                    let abs = path.to_string_lossy().to_string();
                    out.push((abs, rel));
                }
            }
        }
        Ok(out)
    }

    /// 删除指定笔记资源（相对路径）
    pub fn delete_note_asset(&self, relative_path: &str) -> Result<bool> {
        if relative_path.trim().is_empty() {
            warn!("[delete_note_asset] 空路径，跳过");
            return Ok(false);
        }
        let rel_path = Path::new(relative_path);
        if rel_path.is_absolute() {
            return Err(AppError::validation("拒绝删除：仅允许相对路径"));
        }

        // 使用 get_writable_app_data_dir 保持与 list_note_assets 一致
        let writable_dir = self.get_writable_app_data_dir();
        let candidate = writable_dir.join(rel_path);

        debug!("[delete_note_asset] relative_path: {}", relative_path);
        debug!("[delete_note_asset] writable_dir: {:?}", writable_dir);
        debug!("[delete_note_asset] candidate: {:?}", candidate);
        debug!("[delete_note_asset] exists: {}", candidate.exists());

        if !candidate.exists() {
            warn!("[delete_note_asset] 文件不存在，返回 false");
            return Ok(false);
        }

        let base_dir =
            std::fs::canonicalize(&writable_dir).unwrap_or_else(|_| writable_dir.clone());
        let canonical_candidate = std::fs::canonicalize(&candidate)
            .map_err(|e| AppError::file_system(format!("解析资源路径失败: {}", e)))?;

        if !canonical_candidate.starts_with(&base_dir) {
            return Err(AppError::validation("拒绝删除：路径越界"));
        }
        if !canonical_candidate.is_file() {
            return Err(AppError::validation("拒绝删除：目标不是文件"));
        }

        fs::remove_file(&canonical_candidate)
            .map_err(|e| AppError::file_system(format!("删除资源失败: {}", e)))?;
        Ok(true)
    }

    /// 删除笔记资源目录（用于笔记删除时清理）
    pub fn delete_note_assets_dir(&self, subject: &str, note_id: &str) -> Result<()> {
        let dir = self
            .get_writable_app_data_dir()
            .join("notes_assets")
            .join(subject)
            .join(note_id);
        if dir.exists() {
            fs::remove_dir_all(&dir)
                .map_err(|e| AppError::file_system(format!("删除资源目录失败: {}", e)))?;
        }
        Ok(())
    }

    /// 验证图片格式 (基于Base64)
    pub fn validate_image_format_from_base64(&self, base64_data: &str) -> Result<String> {
        // 解析MIME类型
        let mime_type = self.extract_mime_type_from_base64(base64_data)?;

        // 支持的图片格式
        let supported_formats = vec![
            "image/jpeg",
            "image/jpg",
            "image/png",
            "image/gif",
            "image/webp",
            "image/bmp",
            "image/tiff",
            "image/heic",
            "image/heif",
        ];

        if !supported_formats.contains(&mime_type.as_str()) {
            return Err(AppError::validation(format!(
                "不支持的图片格式: {}，支持的格式: {}",
                mime_type,
                supported_formats.join(", ")
            )));
        }

        // 尝试解码base64以验证数据完整性
        let base64_start = if base64_data.starts_with("data:") {
            base64_data
                .find("base64,")
                .ok_or_else(|| AppError::validation("无效的base64数据格式"))?
                + 7
        } else {
            0
        };

        let base64_content = &base64_data[base64_start..];
        let image_bytes = general_purpose::STANDARD
            .decode(base64_content)
            .map_err(|e| AppError::validation(format!("base64解码失败，数据可能损坏: {}", e)))?;

        // 基本的文件大小检查
        if image_bytes.is_empty() {
            return Err(AppError::validation("图片数据为空"));
        }

        if image_bytes.len() > 50 * 1024 * 1024 {
            // 50MB限制
            return Err(AppError::validation("图片文件过大，超过50MB限制"));
        }

        debug!(
            "图片格式验证通过: {} ({} bytes)",
            mime_type,
            image_bytes.len()
        );
        Ok(mime_type)
    }

    /// 从base64数据中提取文件扩展名
    pub fn extract_extension_from_base64(&self, base64_data: &str) -> Result<String> {
        let mime_type = self.extract_mime_type_from_base64(base64_data)?;

        let extension = match mime_type.as_str() {
            "image/jpeg" | "image/jpg" => "jpg",
            "image/png" => "png",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "image/bmp" => "bmp",
            "image/tiff" => "tiff",
            "image/heic" => "heic",
            "image/heif" => "heif",
            _ => {
                return Err(AppError::validation(format!(
                    "无法确定文件扩展名，未知MIME类型: {}",
                    mime_type
                )))
            }
        };

        Ok(extension.to_string())
    }

    /// 从base64 Data URL中提取MIME类型
    fn extract_mime_type_from_base64(&self, base64_data: &str) -> Result<String> {
        if base64_data.starts_with("data:") {
            if let Some(semicolon_pos) = base64_data.find(';') {
                let mime_type = &base64_data[5..semicolon_pos]; // 跳过 "data:"
                if mime_type.starts_with("image/") {
                    return Ok(mime_type.to_string());
                }
            }
            return Err(AppError::validation("无效的Data URL格式"));
        } else {
            // 如果不是Data URL，尝试从文件头部识别
            self.detect_image_type_from_content(base64_data)
        }
    }

    /// 从文件内容检测图片类型
    fn detect_image_type_from_content(&self, base64_data: &str) -> Result<String> {
        let image_bytes = general_purpose::STANDARD
            .decode(base64_data)
            .map_err(|e| AppError::validation(format!("base64解码失败: {}", e)))?;

        if image_bytes.len() < 8 {
            return Err(AppError::validation("图片数据太短，无法识别格式"));
        }

        if image_bytes.len() >= 12 && &image_bytes[4..8] == b"ftyp" {
            let brand = &image_bytes[8..12];
            let mime_opt = match brand {
                b"heic" | b"heix" | b"hevc" | b"hevx" | b"heim" | b"heis" => Some("image/heic"),
                b"mif1" | b"msf1" => Some("image/heif"),
                _ => None,
            };
            if let Some(mime) = mime_opt {
                return Ok(mime.to_string());
            }
        }

        // 检查文件头部魔术字节
        match &image_bytes[0..8] {
            [0xFF, 0xD8, 0xFF, ..] => Ok("image/jpeg".to_string()),
            [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] => Ok("image/png".to_string()),
            [0x47, 0x49, 0x46, 0x38, 0x37, 0x61, ..] | [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ..] => {
                Ok("image/gif".to_string())
            }
            [0x52, 0x49, 0x46, 0x46, _, _, _, _] if &image_bytes[8..12] == b"WEBP" => {
                Ok("image/webp".to_string())
            }
            [0x42, 0x4D, ..] => Ok("image/bmp".to_string()),
            _ => Err(AppError::validation("无法识别图片格式")),
        }
    }

    /// 获取应用数据目录路径
    pub fn get_app_data_dir(&self) -> &Path {
        &self.app_data_dir
    }

    /// 计算应用程序的实际存储占用
    pub async fn calculate_storage_size(&self) -> Result<StorageInfo> {
        info!("开始计算存储空间占用...");

        let mut total_size = 0u64;
        let mut database_size = 0u64;
        let mut images_size = 0u64;
        let mut images_count = 0u32;
        let mut backups_size = 0u64;
        let mut cache_size = 0u64;

        // 1. 计算数据库文件大小
        let db_path = self.get_database_path();
        if db_path.exists() {
            database_size = fs::metadata(&db_path)
                .map_err(|e| AppError::file_system(format!("获取数据库文件大小失败: {}", e)))?
                .len();
            total_size += database_size;
            debug!("数据库文件大小: {} bytes", database_size);
        }

        // 计算数据库的WAL和SHM文件（如果存在）
        let wal_path = db_path.with_extension("db-wal");
        if wal_path.exists() {
            let wal_size = fs::metadata(&wal_path)
                .map_err(|e| AppError::file_system(format!("获取WAL文件大小失败: {}", e)))?
                .len();
            database_size += wal_size;
            total_size += wal_size;
        }

        let shm_path = db_path.with_extension("db-shm");
        if shm_path.exists() {
            let shm_size = fs::metadata(&shm_path)
                .map_err(|e| AppError::file_system(format!("获取SHM文件大小失败: {}", e)))?
                .len();
            database_size += shm_size;
            total_size += shm_size;
        }

        // 2. 计算图片目录大小
        if self.images_dir.exists() {
            let (size, count) = self.calculate_directory_size(&self.images_dir)?;
            images_size = size;
            images_count = count;
            total_size += images_size;
            debug!(
                "图片目录大小: {} bytes, 文件数: {}",
                images_size, images_count
            );
        }

        // 3. 计算备份目录大小
        let backup_dir = self.app_data_dir.join("backups");
        if backup_dir.exists() {
            let (size, _) = self.calculate_directory_size(&backup_dir)?;
            backups_size = size;
            total_size += backups_size;
            debug!("备份目录大小: {} bytes", backups_size);
        }

        // 4. 计算缓存目录大小（如果有）
        let cache_dir = self.app_data_dir.join("cache");
        if cache_dir.exists() {
            let (size, _) = self.calculate_directory_size(&cache_dir)?;
            cache_size = size;
            total_size += cache_size;
            debug!("缓存目录大小: {} bytes", cache_size);
        }

        // 5. 计算其他文件（配置文件等）
        let mut other_size = 0u64;
        let config_file = self.app_data_dir.join("config.json");
        if config_file.exists() {
            let size = fs::metadata(&config_file)
                .map_err(|e| AppError::file_system(format!("获取配置文件大小失败: {}", e)))?
                .len();
            other_size += size;
            total_size += size;
        }

        Ok(StorageInfo {
            total_size,
            database_size,
            images_size,
            images_count,
            backups_size,
            cache_size,
            other_size,
            formatted_total: self.format_bytes(total_size),
            formatted_database: self.format_bytes(database_size),
            formatted_images: self.format_bytes(images_size),
            formatted_backups: self.format_bytes(backups_size),
            formatted_cache: self.format_bytes(cache_size),
            formatted_other: self.format_bytes(other_size),
        })
    }

    /// 递归计算目录大小和文件数量
    fn calculate_directory_size(&self, dir: &Path) -> Result<(u64, u32)> {
        let mut total_size = 0u64;
        let mut file_count = 0u32;

        let entries =
            fs::read_dir(dir).map_err(|e| AppError::file_system(format!("读取目录失败: {}", e)))?;

        for entry in entries {
            let entry =
                entry.map_err(|e| AppError::file_system(format!("读取目录条目失败: {}", e)))?;
            let path = entry.path();
            let metadata = fs::metadata(&path)
                .map_err(|e| AppError::file_system(format!("获取文件元数据失败: {}", e)))?;

            if metadata.is_file() {
                total_size += metadata.len();
                file_count += 1;
            } else if metadata.is_dir() {
                let (sub_size, sub_count) = self.calculate_directory_size(&path)?;
                total_size += sub_size;
                file_count += sub_count;
            }
        }

        Ok((total_size, file_count))
    }

    /// 格式化字节大小为可读格式
    fn format_bytes(&self, bytes: u64) -> String {
        if bytes == 0 {
            return "0 B".to_string();
        }

        const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
        let k = 1024f64;
        let i = (bytes as f64).log(k).floor() as usize;
        let size = bytes as f64 / k.powi(i as i32);

        format!("{:.2} {}", size, UNITS[i.min(UNITS.len() - 1)])
    }
}

/// 存储信息结构体
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StorageInfo {
    pub total_size: u64,
    pub database_size: u64,
    pub images_size: u64,
    pub images_count: u32,
    pub backups_size: u64,
    pub cache_size: u64,
    pub other_size: u64,
    pub formatted_total: String,
    pub formatted_database: String,
    pub formatted_images: String,
    pub formatted_backups: String,
    pub formatted_cache: String,
    pub formatted_other: String,
}
