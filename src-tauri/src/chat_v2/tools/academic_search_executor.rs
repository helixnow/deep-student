//! 学术论文搜索工具执行器
//!
//! 提供 arXiv 和 OpenAlex 两个学术搜索引擎。
//!
//! ## 工具
//! - `builtin-arxiv_search` — 搜索 arXiv 预印本论文
//!   - 主路径：直接调用 arXiv Atom API（5s 快速超时）
//!   - 回退：arXiv API 不可用时自动切换到 OpenAlex（arXiv 源过滤）
//! - `builtin-scholar_search` — 搜索学术论文（调用 OpenAlex API）
//!   - 覆盖 2.4 亿+ 篇论文（含 Crossref、PubMed、arXiv 等来源）
//!   - 国内可直接访问，无需代理
//!
//! ## 设计说明
//! - arXiv Atom API：`https://export.arxiv.org/api/query`（国内可能受限）
//! - OpenAlex REST API：`https://api.openalex.org/works`（国内可直连，免费）

use std::collections::BTreeMap;
use std::time::Instant;

use async_trait::async_trait;
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use serde_json::{json, Value};
use std::time::Duration;

use super::builtin_retrieval_executor::BUILTIN_NAMESPACE;
use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};

// ============================================================================
// 常量
// ============================================================================

/// arXiv API 端点（HTTPS 避免重定向）
const ARXIV_API_URL: &str = "https://export.arxiv.org/api/query";

/// OpenAlex API 端点（国内可直连）
const OPENALEX_API_URL: &str = "https://api.openalex.org/works";

/// arXiv 在 OpenAlex 中的 Source ID（用于回退搜索时过滤）
const OPENALEX_ARXIV_SOURCE_ID: &str = "S4306400194";

/// arXiv 直连快速超时（国内可能不可用，快速失败后回退 OpenAlex）
const ARXIV_FAST_TIMEOUT_SECS: u64 = 8;

/// OpenAlex 请求超时
const OPENALEX_TIMEOUT_SECS: u64 = 30;

/// 默认最大结果数
const DEFAULT_MAX_RESULTS: u64 = 10;

/// arXiv 最大结果数上限
const ARXIV_MAX_RESULTS_LIMIT: u64 = 50;

/// OpenAlex 最大结果数上限（per_page 最大 200，但搜索场景 50 足够）
const OPENALEX_MAX_RESULTS_LIMIT: u64 = 50;

/// OpenAlex 返回的字段（select 参数，减少带宽）
const OPENALEX_SELECT_FIELDS: &str = "id,title,authorships,abstract_inverted_index,publication_year,cited_by_count,doi,open_access,primary_location,type,ids";

/// User-Agent（OpenAlex 要求包含 mailto 以进入 polite pool）
const UA: &str = "DeepStudent/1.0 (Academic Search; mailto:support@deepstudent.app)";

// ============================================================================
// 学术搜索执行器
// ============================================================================

/// 学术论文搜索工具执行器
pub struct AcademicSearchExecutor {
    /// arXiv 直连客户端（短超时，快速失败）
    arxiv_client: reqwest::Client,
    /// OpenAlex 客户端（正常超时）
    openalex_client: reqwest::Client,
}

impl AcademicSearchExecutor {
    pub fn new() -> Self {
        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static(UA));

        let arxiv_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(ARXIV_FAST_TIMEOUT_SECS))
            .default_headers(headers.clone())
            .build()
            .expect("Failed to create arXiv HTTP client");

        let openalex_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(OPENALEX_TIMEOUT_SECS))
            .default_headers(headers)
            .build()
            .expect("Failed to create OpenAlex HTTP client");

        Self {
            arxiv_client,
            openalex_client,
        }
    }

    /// 从工具名称中去除 builtin- 前缀
    fn strip_namespace(tool_name: &str) -> &str {
        tool_name
            .strip_prefix(BUILTIN_NAMESPACE)
            .unwrap_or(tool_name)
    }

    // ========================================================================
    // arXiv 搜索
    // ========================================================================

    /// 执行 arXiv 搜索（主路径：arXiv API，回退：OpenAlex）
    async fn execute_arxiv_search(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        if ctx.is_cancelled() {
            return Err("arXiv search cancelled".to_string());
        }

        let query = call
            .arguments
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or("Missing required parameter 'query'")?;

        let max_results = call
            .arguments
            .get("max_results")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_MAX_RESULTS)
            .min(ARXIV_MAX_RESULTS_LIMIT);

        let date_from = call.arguments.get("date_from").and_then(|v| v.as_str());
        let date_to = call.arguments.get("date_to").and_then(|v| v.as_str());

        let categories: Vec<String> = call
            .arguments
            .get("categories")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let sort_by = call
            .arguments
            .get("sort_by")
            .and_then(|v| v.as_str())
            .unwrap_or("relevance");

        log::debug!(
            "[AcademicSearch] arXiv search: query='{}', max={}, categories={:?}, sort={}",
            query,
            max_results,
            categories,
            sort_by
        );

        // 主路径：尝试直连 arXiv API（快速超时）
        match self
            .try_arxiv_direct(
                query,
                max_results,
                date_from,
                date_to,
                &categories,
                sort_by,
                ctx,
            )
            .await
        {
            Ok(papers) => {
                log::info!(
                    "[AcademicSearch] arXiv direct API: {} results for '{}'",
                    papers.len(),
                    query
                );
                return Ok(json!({
                    "source": "arxiv",
                    "total_results": papers.len(),
                    "papers": papers,
                }));
            }
            Err(e) => {
                log::warn!(
                    "[AcademicSearch] arXiv direct API failed ({}), falling back to OpenAlex",
                    e
                );
            }
        }

        // 回退：通过 OpenAlex 搜索 arXiv 论文
        if ctx.is_cancelled() {
            return Err("arXiv search cancelled".to_string());
        }

        log::info!("[AcademicSearch] Using OpenAlex fallback for arXiv search");

        // 构建 OpenAlex 查询（带 arXiv 源过滤）
        let year_from = date_from.and_then(|d| d.split('-').next().map(|s| s.to_string()));
        let year_to = date_to.and_then(|d| d.split('-').next().map(|s| s.to_string()));

        let mut filters = vec![format!(
            "primary_location.source.id:{}",
            OPENALEX_ARXIV_SOURCE_ID
        )];

        if let Some(ref yf) = year_from {
            if let Some(ref yt) = year_to {
                filters.push(format!("publication_year:{}-{}", yf, yt));
            } else {
                filters.push(format!("from_publication_date:{}-01-01", yf));
            }
        } else if let Some(ref yt) = year_to {
            filters.push(format!("to_publication_date:{}-12-31", yt));
        }

        let result = self
            .execute_openalex_search(query, max_results, &filters, sort_by, ctx)
            .await?;

        let papers = result
            .get("papers")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        Ok(json!({
            "source": "openalex_arxiv_fallback",
            "total_results": papers.len(),
            "papers": papers,
            "note": "arXiv API 不可达，已通过 OpenAlex 搜索 arXiv 论文（分类过滤不可用）",
        }))
    }

    /// 尝试直连 arXiv API（快速超时）
    async fn try_arxiv_direct(
        &self,
        query: &str,
        max_results: u64,
        date_from: Option<&str>,
        date_to: Option<&str>,
        categories: &[String],
        sort_by: &str,
        ctx: &ExecutionContext,
    ) -> Result<Vec<Value>, String> {
        let mut query_parts = Vec::new();

        if !query.trim().is_empty() {
            query_parts.push(format!("({})", query));
        }

        if !categories.is_empty() {
            let cat_filter = categories
                .iter()
                .map(|c| format!("cat:{}", c))
                .collect::<Vec<_>>()
                .join("+OR+");
            query_parts.push(format!("({})", cat_filter));
        }

        if date_from.is_some() || date_to.is_some() {
            let start = date_from
                .map(|d| d.replace('-', ""))
                .unwrap_or_else(|| "199107010000".to_string());
            let end = date_to
                .map(|d| format!("{}2359", d.replace('-', "")))
                .unwrap_or_else(|| chrono::Utc::now().format("%Y%m%d2359").to_string());

            let start_formatted = if start.len() == 8 {
                format!("{}0000", start)
            } else {
                start
            };

            query_parts.push(format!("submittedDate:[{}+TO+{}]", start_formatted, end));
        }

        if query_parts.is_empty() {
            return Err("No search criteria".to_string());
        }

        let final_query = query_parts.join("+AND+");
        let sort_param = match sort_by {
            "date" => "submittedDate",
            _ => "relevance",
        };

        let encoded_query = final_query.replace(' ', "+");
        let url = format!(
            "{}?search_query={}&max_results={}&sortBy={}&sortOrder=descending",
            ARXIV_API_URL, encoded_query, max_results, sort_param
        );

        log::debug!("[AcademicSearch] arXiv direct URL: {}", url);

        let response = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                result = self.arxiv_client.get(&url).send() => {
                    result.map_err(|e| format!("arXiv request failed: {}", e))?
                }
                _ = cancel_token.cancelled() => {
                    return Err("cancelled".to_string());
                }
            }
        } else {
            self.arxiv_client
                .get(&url)
                .send()
                .await
                .map_err(|e| format!("arXiv request failed: {}", e))?
        };

        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }

        let xml_text = response
            .text()
            .await
            .map_err(|e| format!("read body failed: {}", e))?;

        Self::parse_arxiv_atom(&xml_text)
    }

    /// 解析 arXiv Atom XML 响应
    fn parse_arxiv_atom(xml: &str) -> Result<Vec<Value>, String> {
        let mut reader = Reader::from_str(xml);
        reader.config_mut().trim_text(true);

        let mut papers = Vec::new();
        let mut buf = Vec::new();

        // 状态机
        let mut in_entry = false;
        let mut current_tag = String::new();
        let mut paper_id = String::new();
        let mut title = String::new();
        let mut summary = String::new();
        let mut published = String::new();
        let mut authors: Vec<String> = Vec::new();
        let mut categories: Vec<String> = Vec::new();
        let mut pdf_url = String::new();
        let mut in_author = false;
        let mut in_author_name = false;

        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(ref e)) => {
                    let tag_name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                    // 去掉命名空间前缀
                    let local = tag_name.split(':').last().unwrap_or(&tag_name);

                    match local {
                        "entry" => {
                            in_entry = true;
                            paper_id.clear();
                            title.clear();
                            summary.clear();
                            published.clear();
                            authors.clear();
                            categories.clear();
                            pdf_url.clear();
                        }
                        "author" if in_entry => {
                            in_author = true;
                        }
                        "name" if in_author => {
                            in_author_name = true;
                        }
                        "id" | "title" | "summary" | "published" if in_entry => {
                            current_tag = local.to_string();
                        }
                        "link" if in_entry => {
                            // 检查 title="pdf" 属性
                            let mut is_pdf = false;
                            let mut href = String::new();
                            for attr in e.attributes().flatten() {
                                let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                                let val = String::from_utf8_lossy(&attr.value).to_string();
                                if key == "title" && val == "pdf" {
                                    is_pdf = true;
                                }
                                if key == "href" {
                                    href = val;
                                }
                            }
                            if is_pdf && !href.is_empty() {
                                pdf_url = href;
                            }
                        }
                        "category" if in_entry => {
                            // 提取 term 属性
                            for attr in e.attributes().flatten() {
                                let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                                if key == "term" {
                                    let val = String::from_utf8_lossy(&attr.value).to_string();
                                    if !categories.contains(&val) {
                                        categories.push(val);
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
                Ok(Event::Empty(ref e)) => {
                    let tag_name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                    let local = tag_name.split(':').last().unwrap_or(&tag_name);

                    if local == "link" && in_entry {
                        let mut is_pdf = false;
                        let mut href = String::new();
                        for attr in e.attributes().flatten() {
                            let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                            let val = String::from_utf8_lossy(&attr.value).to_string();
                            if key == "title" && val == "pdf" {
                                is_pdf = true;
                            }
                            if key == "href" {
                                href = val;
                            }
                        }
                        if is_pdf && !href.is_empty() {
                            pdf_url = href;
                        }
                    }

                    if local == "category" && in_entry {
                        for attr in e.attributes().flatten() {
                            let key = String::from_utf8_lossy(attr.key.as_ref()).to_string();
                            if key == "term" {
                                let val = String::from_utf8_lossy(&attr.value).to_string();
                                if !categories.contains(&val) {
                                    categories.push(val);
                                }
                            }
                        }
                    }
                }
                Ok(Event::Text(ref e)) => {
                    if in_entry {
                        let text = e.unescape().unwrap_or_default().to_string();
                        if in_author_name {
                            authors.push(text.trim().to_string());
                        } else {
                            match current_tag.as_str() {
                                "id" => paper_id = text.trim().to_string(),
                                "title" => {
                                    // arXiv 标题可能跨行
                                    if title.is_empty() {
                                        title = text.trim().replace('\n', " ");
                                    } else {
                                        title.push(' ');
                                        title.push_str(text.trim());
                                    }
                                }
                                "summary" => {
                                    summary = text.trim().replace('\n', " ");
                                }
                                "published" => {
                                    published = text.trim().to_string();
                                }
                                _ => {}
                            }
                        }
                    }
                }
                Ok(Event::End(ref e)) => {
                    let tag_name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                    let local = tag_name.split(':').last().unwrap_or(&tag_name);

                    match local {
                        "entry" => {
                            if in_entry && !paper_id.is_empty() {
                                // 从 ID URL 提取短 ID
                                let short_id = paper_id
                                    .split("/abs/")
                                    .last()
                                    .unwrap_or(&paper_id)
                                    .to_string();
                                // 去掉版本号
                                let short_id_no_ver = if let Some(pos) = short_id.rfind('v') {
                                    if short_id[pos + 1..].chars().all(|c| c.is_ascii_digit()) {
                                        &short_id[..pos]
                                    } else {
                                        &short_id
                                    }
                                } else {
                                    &short_id
                                };

                                let pdf = if pdf_url.is_empty() {
                                    format!("https://arxiv.org/pdf/{}", short_id_no_ver)
                                } else {
                                    pdf_url.clone()
                                };

                                papers.push(json!({
                                    "id": short_id_no_ver,
                                    "title": title,
                                    "authors": authors,
                                    "abstract": summary,
                                    "categories": categories,
                                    "published": published,
                                    "pdfUrl": pdf,
                                    "arxivUrl": format!("https://arxiv.org/abs/{}", short_id_no_ver),
                                }));
                            }
                            in_entry = false;
                            current_tag.clear();
                        }
                        "author" => {
                            in_author = false;
                        }
                        "name" if in_author => {
                            in_author_name = false;
                        }
                        _ => {
                            if current_tag == local {
                                current_tag.clear();
                            }
                        }
                    }
                }
                Ok(Event::Eof) => break,
                Err(e) => {
                    return Err(format!("Failed to parse arXiv XML: {}", e));
                }
                _ => {}
            }
            buf.clear();
        }

        Ok(papers)
    }

    // ========================================================================
    // OpenAlex 搜索（scholar_search 主引擎 + arxiv_search 回退引擎）
    // ========================================================================

    /// 执行学术论文搜索（基于 OpenAlex，国内可直连）
    async fn execute_scholar_search(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        if ctx.is_cancelled() {
            return Err("Scholar search cancelled".to_string());
        }

        let query = call
            .arguments
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or("Missing required parameter 'query'")?;

        let max_results = call
            .arguments
            .get("max_results")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_MAX_RESULTS)
            .min(OPENALEX_MAX_RESULTS_LIMIT);

        let year_from_val = call.arguments.get("year_from").and_then(|v| {
            v.as_str()
                .map(|s| s.to_string())
                .or_else(|| v.as_u64().map(|n| n.to_string()))
        });

        let year_to_val = call.arguments.get("year_to").and_then(|v| {
            v.as_str()
                .map(|s| s.to_string())
                .or_else(|| v.as_u64().map(|n| n.to_string()))
        });

        let open_access_only = call
            .arguments
            .get("open_access_only")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let min_citation_count = call
            .arguments
            .get("min_citation_count")
            .and_then(|v| v.as_u64());

        let sort_by = call
            .arguments
            .get("sort_by")
            .and_then(|v| v.as_str())
            .unwrap_or("relevance");

        log::debug!(
            "[AcademicSearch] Scholar search (OpenAlex): query='{}', max={}, year={:?}-{:?}",
            query,
            max_results,
            year_from_val,
            year_to_val
        );

        // 构建过滤条件
        // 注意：OpenAlex 只支持 > < 运算符，不支持 >= <=
        // 使用 from_publication_date / to_publication_date 语法糖（含两端）
        let mut filters = Vec::new();

        if let Some(ref yf) = year_from_val {
            if let Some(ref yt) = year_to_val {
                filters.push(format!("publication_year:{}-{}", yf, yt));
            } else {
                filters.push(format!("from_publication_date:{}-01-01", yf));
            }
        } else if let Some(ref yt) = year_to_val {
            filters.push(format!("to_publication_date:{}-12-31", yt));
        }

        if open_access_only {
            filters.push("open_access.is_oa:true".to_string());
        }

        if let Some(min_cite) = min_citation_count {
            // OpenAlex 只支持 > 不支持 >=，对整数字段用 >N-1 等价 >=N
            if min_cite > 0 {
                filters.push(format!("cited_by_count:>{}", min_cite - 1));
            }
        }

        self.execute_openalex_search(query, max_results, &filters, sort_by, ctx)
            .await
    }

    /// 通用 OpenAlex 搜索（被 scholar_search 和 arxiv_search 回退共用）
    async fn execute_openalex_search(
        &self,
        query: &str,
        max_results: u64,
        filters: &[String],
        sort_by: &str,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        if ctx.is_cancelled() {
            return Err("OpenAlex search cancelled".to_string());
        }

        // 构建请求参数
        let mut params: Vec<(&str, String)> = vec![
            ("search", query.to_string()),
            ("per-page", max_results.to_string()),
            ("select", OPENALEX_SELECT_FIELDS.to_string()),
            ("mailto", "support@deepstudent.app".to_string()),
        ];

        if !filters.is_empty() {
            params.push(("filter", filters.join(",")));
        }

        // 排序：OpenAlex 支持 cited_by_count:desc, publication_date:desc 等
        match sort_by {
            "date" => params.push(("sort", "publication_date:desc".to_string())),
            "citations" => params.push(("sort", "cited_by_count:desc".to_string())),
            // "relevance" 是默认排序，不需要额外参数
            _ => {}
        }

        let url = reqwest::Url::parse_with_params(OPENALEX_API_URL, &params)
            .map_err(|e| format!("Failed to build OpenAlex URL: {}", e))?;

        log::debug!("[AcademicSearch] OpenAlex URL: {}", url);

        // 发送请求
        let response = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                result = self.openalex_client.get(url.as_str()).send() => {
                    result.map_err(|e| format!("OpenAlex API request failed: {}", e))?
                }
                _ = cancel_token.cancelled() => {
                    return Err("OpenAlex search cancelled".to_string());
                }
            }
        } else {
            self.openalex_client
                .get(url.as_str())
                .send()
                .await
                .map_err(|e| format!("OpenAlex API request failed: {}", e))?
        };

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(format!(
                "OpenAlex API returned HTTP {}: {}",
                status.as_u16(),
                body.chars().take(500).collect::<String>()
            ));
        }

        let body: Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse OpenAlex response: {}", e))?;

        // 提取论文列表
        let raw_papers = body
            .get("results")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let total = body
            .get("meta")
            .and_then(|m| m.get("count"))
            .and_then(|v| v.as_u64())
            .unwrap_or(raw_papers.len() as u64);

        // 转换为统一格式
        let papers: Vec<Value> = raw_papers
            .iter()
            .map(|p| Self::convert_openalex_work(p))
            .collect();

        log::info!(
            "[AcademicSearch] OpenAlex search: {} results (total {}) for '{}'",
            papers.len(),
            total,
            query
        );

        Ok(json!({
            "source": "openalex",
            "total_results": total,
            "returned_results": papers.len(),
            "papers": papers,
        }))
    }

    /// 将 OpenAlex Work 对象转换为统一格式
    fn convert_openalex_work(work: &Value) -> Value {
        // 作者列表
        let authors: Vec<String> = work
            .get("authorships")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|a| {
                        a.get("author")
                            .and_then(|au| au.get("display_name"))
                            .and_then(|n| n.as_str())
                            .map(|s| s.to_string())
                    })
                    .collect()
            })
            .unwrap_or_default();

        // 从倒排索引重建摘要
        let abstract_text = work
            .get("abstract_inverted_index")
            .and_then(|v| v.as_object())
            .map(|idx| Self::reconstruct_abstract(idx))
            .unwrap_or_default();

        // DOI
        let doi = work.get("doi").and_then(|v| v.as_str()).unwrap_or("");

        // 开放获取 PDF
        let pdf_url = work
            .get("open_access")
            .and_then(|oa| oa.get("oa_url"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        // 发表来源
        let venue = work
            .get("primary_location")
            .and_then(|loc| loc.get("source"))
            .and_then(|src| src.get("display_name"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        // 外部 ID
        let ids = work.get("ids");
        let openalex_id = ids
            .and_then(|i| i.get("openalex"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        json!({
            "id": openalex_id,
            "title": work.get("title").and_then(|v| v.as_str()).unwrap_or(""),
            "authors": authors,
            "abstract": abstract_text,
            "year": work.get("publication_year").and_then(|v| v.as_u64()),
            "venue": venue,
            "citationCount": work.get("cited_by_count").and_then(|v| v.as_u64()).unwrap_or(0),
            "pdfUrl": pdf_url,
            "doi": doi,
            "type": work.get("type").and_then(|v| v.as_str()).unwrap_or(""),
        })
    }

    /// 从 OpenAlex 的倒排索引重建摘要文本
    ///
    /// OpenAlex 用 `{"word": [pos1, pos2, ...]}` 格式存储摘要，
    /// 需要按 position 重建原文。
    fn reconstruct_abstract(inverted_index: &serde_json::Map<String, Value>) -> String {
        // 收集 (position, word) 对
        let mut words: BTreeMap<u64, &str> = BTreeMap::new();

        for (word, positions) in inverted_index {
            if let Some(arr) = positions.as_array() {
                for pos in arr {
                    if let Some(p) = pos.as_u64() {
                        words.insert(p, word.as_str());
                    }
                }
            }
        }

        // 按顺序拼接
        words.values().copied().collect::<Vec<&str>>().join(" ")
    }
}

impl Default for AcademicSearchExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for AcademicSearchExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let stripped = Self::strip_namespace(tool_name);
        matches!(stripped, "arxiv_search" | "scholar_search")
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        let tool_name = Self::strip_namespace(&call.name);

        log::debug!(
            "[AcademicSearch] Executing: {} (full: {})",
            tool_name,
            call.name
        );

        // 发射工具调用开始事件
        ctx.emitter.emit_tool_call_start(
            &ctx.message_id,
            &ctx.block_id,
            &call.name,
            call.arguments.clone(),
            Some(&call.id),
            None,
        );

        let result = match tool_name {
            "arxiv_search" => self.execute_arxiv_search(call, ctx).await,
            "scholar_search" => self.execute_scholar_search(call, ctx).await,
            _ => Err(format!("Unknown academic search tool: {}", tool_name)),
        };

        let duration = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                ctx.emitter.emit_end(
                    event_types::TOOL_CALL,
                    &ctx.block_id,
                    Some(json!({
                        "result": output,
                        "durationMs": duration,
                    })),
                    None,
                );

                let result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration,
                );

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[AcademicSearch] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
            Err(e) => {
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &e, None);

                log::warn!(
                    "[AcademicSearch] Tool {} failed: {} ({}ms)",
                    call.name,
                    e,
                    duration
                );

                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    e,
                    duration,
                );

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[AcademicSearch] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        ToolSensitivity::Low
    }

    fn name(&self) -> &'static str {
        "AcademicSearchExecutor"
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_can_handle() {
        let executor = AcademicSearchExecutor::new();

        assert!(executor.can_handle("builtin-arxiv_search"));
        assert!(executor.can_handle("builtin-scholar_search"));
        assert!(!executor.can_handle("builtin-web_search"));
        assert!(!executor.can_handle("builtin-web_fetch"));
        assert!(!executor.can_handle("some_other_tool"));
    }

    #[test]
    fn test_sensitivity() {
        let executor = AcademicSearchExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-arxiv_search"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-scholar_search"),
            ToolSensitivity::Low
        );
    }

    #[test]
    fn test_parse_arxiv_atom_basic() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <title>Test Paper Title</title>
    <summary>This is a test abstract.</summary>
    <published>2024-01-15T00:00:00Z</published>
    <author><name>John Doe</name></author>
    <author><name>Jane Smith</name></author>
    <category term="cs.AI"/>
    <category term="cs.LG"/>
    <link title="pdf" href="http://arxiv.org/pdf/2401.12345v1" rel="related" type="application/pdf"/>
  </entry>
</feed>"#;

        let papers = AcademicSearchExecutor::parse_arxiv_atom(xml).unwrap();
        assert_eq!(papers.len(), 1);

        let paper = &papers[0];
        assert_eq!(paper["id"].as_str().unwrap(), "2401.12345");
        assert_eq!(paper["title"].as_str().unwrap(), "Test Paper Title");
        assert_eq!(
            paper["abstract"].as_str().unwrap(),
            "This is a test abstract."
        );
        assert_eq!(paper["authors"].as_array().unwrap().len(), 2);
        assert_eq!(paper["categories"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn test_parse_arxiv_atom_empty() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
</feed>"#;

        let papers = AcademicSearchExecutor::parse_arxiv_atom(xml).unwrap();
        assert!(papers.is_empty());
    }

    #[test]
    fn test_reconstruct_abstract() {
        let mut idx = serde_json::Map::new();
        idx.insert("Hello".to_string(), json!([0]));
        idx.insert("world".to_string(), json!([1]));
        idx.insert("this".to_string(), json!([2]));
        idx.insert("is".to_string(), json!([3]));
        idx.insert("a".to_string(), json!([4]));
        idx.insert("test".to_string(), json!([5]));

        let result = AcademicSearchExecutor::reconstruct_abstract(&idx);
        assert_eq!(result, "Hello world this is a test");
    }

    #[test]
    fn test_reconstruct_abstract_repeated_word() {
        let mut idx = serde_json::Map::new();
        idx.insert("the".to_string(), json!([0, 2]));
        idx.insert("cat".to_string(), json!([1]));
        idx.insert("dog".to_string(), json!([3]));

        let result = AcademicSearchExecutor::reconstruct_abstract(&idx);
        assert_eq!(result, "the cat the dog");
    }
}
