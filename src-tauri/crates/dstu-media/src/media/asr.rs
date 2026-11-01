//! 逐段 ASR：每段编码为 WAV，走语音输入同一套受管 ASR 配置与模型槽位
//! （`voice_input_asr_model_config_id`，任何 OpenAI 兼容供应商），AIMD 自适应并发。
//!
//! - 连续成功（达到当前并发数次）并发 +1；429 并发减半并按 Retry-After 冷却；
//! - 400 类请求错误不重试（该段记失败）；401/403/404 终止整个任务（鉴权 / 模型不可用）；
//! - 5xx / 网络错误指数退避重试；
//! - `/audio/transcriptions` 形态下仅当模型支持（whisper 系）时请求 `response_format=verbose_json`，
//!   用句级时间戳收紧段边界，服务端拒绝该参数时自动降级为段级时间戳；
//!   百炼 `qwen3-asr-flash` 走 `/chat/completions` + `input_audio`，只有段级时间戳；
//! - 每次调用记入 llm_usage（`CallerType::MediaTranscription`）。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use reqwest::multipart::{Form, Part};
use reqwest::Client;
use serde::Deserialize;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use super::wav::{encode_wav_mono_16k, PcmSpool};
use super::MediaError;
use crate::llm_usage::CallerType;
use crate::voice_input::{
    clean_asr_text, parse_chat_transcript, post_asr_chat_input_audio, post_asr_form,
    record_asr_usage, AsrEndpoint, AsrHttpError, AsrProtocol,
};

/// 段音频前后余量（毫秒）
pub const CLIP_PAD_MS: i64 = 100;
/// 单次 ASR 请求超时
pub const ASR_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

const AIMD_INITIAL: usize = 2;
const AIMD_MIN: usize = 1;
const AIMD_MAX: usize = 8;
/// 429 未带 Retry-After 时的默认冷却
const DEFAULT_RATE_LIMIT_COOLDOWN: Duration = Duration::from_secs(5);
/// 普通错误最多尝试次数
const MAX_ATTEMPTS: u32 = 3;
/// 429 最多重排次数
const MAX_RATE_LIMIT_ATTEMPTS: u32 = 8;
/// 连续多少段最终失败后终止整个任务（避免网络断开时把整课刷成失败）
const MAX_CONSECUTIVE_SEGMENT_FAILURES: usize = 5;

/// 只有 whisper 系模型确定支持 `verbose_json`（句级时间戳）
pub fn model_supports_verbose_json(model: &str) -> bool {
    model.to_ascii_lowercase().contains("whisper")
}

/// 一段的识别结果
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AsrClipResult {
    pub text: String,
    /// 语音实际起止（相对片段起点，毫秒；仅 verbose_json 时有）
    pub speech_bounds_ms: Option<(i64, i64)>,
}

#[async_trait]
pub trait AsrBackend: Send + Sync {
    async fn transcribe(&self, wav: Vec<u8>) -> Result<AsrClipResult, AsrHttpError>;
    /// 显示用模型名
    fn model_label(&self) -> String;
}

#[derive(Debug, Deserialize)]
struct VerboseSegment {
    start: Option<f64>,
    end: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct TranscriptionBody {
    text: Option<String>,
    #[serde(default)]
    segments: Option<Vec<VerboseSegment>>,
}

/// 解析 ASR 响应体（json / verbose_json）
pub fn parse_transcription_body(body: &str) -> Result<AsrClipResult, String> {
    let parsed: TranscriptionBody =
        serde_json::from_str(body).map_err(|e| format!("Invalid ASR response: {}", e))?;
    let text = clean_asr_text(&parsed.text.unwrap_or_default());
    let speech_bounds_ms = parsed.segments.as_ref().and_then(|segs| {
        let start = segs
            .iter()
            .filter_map(|s| s.start)
            .fold(f64::INFINITY, f64::min);
        let end = segs
            .iter()
            .filter_map(|s| s.end)
            .fold(f64::NEG_INFINITY, f64::max);
        (start.is_finite() && end.is_finite() && end >= start).then(|| {
            (
                (start * 1000.0).round() as i64,
                (end * 1000.0).round() as i64,
            )
        })
    });
    Ok(AsrClipResult {
        text,
        speech_bounds_ms,
    })
}

/// 走 voice_input 共用 HTTP 内核的 ASR 后端
pub struct HttpAsrBackend {
    client: Client,
    endpoint: AsrEndpoint,
    language: Option<String>,
    verbose_enabled: AtomicBool,
}

impl HttpAsrBackend {
    pub(crate) fn new(endpoint: AsrEndpoint, language: Option<String>) -> Result<Self, MediaError> {
        let client = Client::builder()
            .timeout(ASR_REQUEST_TIMEOUT)
            .build()
            .map_err(|e| MediaError::AsrFatal {
                code: "network-failed".into(),
                message: format!("创建 ASR HTTP 客户端失败: {}", e),
            })?;
        let verbose = endpoint.protocol == AsrProtocol::Transcriptions
            && model_supports_verbose_json(&endpoint.model);
        Ok(Self {
            client,
            endpoint,
            language,
            verbose_enabled: AtomicBool::new(verbose),
        })
    }

    fn build_form(&self, wav: Vec<u8>, verbose: bool) -> Result<Form, AsrHttpError> {
        let part = Part::bytes(wav)
            .file_name("segment.wav")
            .mime_str("audio/wav")
            .map_err(|e| AsrHttpError::Transport {
                timeout: false,
                message: e.to_string(),
            })?;
        let mut form = Form::new()
            .text("model", self.endpoint.model.clone())
            .part("file", part);
        if verbose {
            form = form.text("response_format", "verbose_json");
        }
        if let Some(lang) = self.language.as_deref().filter(|l| !l.trim().is_empty()) {
            form = form.text("language", lang.trim().to_string());
        }
        Ok(form)
    }
}

impl HttpAsrBackend {
    async fn transcribe_multipart(&self, wav: Vec<u8>) -> Result<AsrClipResult, AsrHttpError> {
        let mut verbose = self.verbose_enabled.load(Ordering::Relaxed);
        let mut result;
        loop {
            let form = self.build_form(wav.clone(), verbose)?;
            result = post_asr_form(&self.client, &self.endpoint, form).await;
            // 服务端不认 verbose_json → 本任务后续一律降级为段级时间戳
            if verbose
                && matches!(&result, Err(AsrHttpError::Status { status, body, .. })
                    if *status == 400 && body.to_ascii_lowercase().contains("response_format"))
            {
                self.verbose_enabled.store(false, Ordering::Relaxed);
                verbose = false;
                continue;
            }
            break;
        }
        result.and_then(|body| parse_transcription_body(&body).map_err(malformed_response))
    }

    async fn transcribe_chat(&self, wav: Vec<u8>) -> Result<AsrClipResult, AsrHttpError> {
        let body = post_asr_chat_input_audio(
            &self.client,
            &self.endpoint,
            &wav,
            "audio/wav",
            self.language.as_deref(),
        )
        .await?;
        let (text, _language) = parse_chat_transcript(&body).map_err(malformed_response)?;
        Ok(AsrClipResult {
            text,
            speech_bounds_ms: None,
        })
    }
}

/// 2xx 但响应体解析不了：当作可重试的服务端异常
fn malformed_response(message: String) -> AsrHttpError {
    AsrHttpError::Status {
        status: 502,
        retry_after: None,
        body: message,
    }
}

#[async_trait]
impl AsrBackend for HttpAsrBackend {
    async fn transcribe(&self, wav: Vec<u8>) -> Result<AsrClipResult, AsrHttpError> {
        let started = Instant::now();
        let parsed = match self.endpoint.protocol {
            AsrProtocol::Transcriptions => self.transcribe_multipart(wav).await,
            AsrProtocol::ChatInputAudio => self.transcribe_chat(wav).await,
        };
        let latency = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        record_asr_usage(
            CallerType::MediaTranscription,
            &self.endpoint.provider_id,
            &self.endpoint.model,
            self.endpoint.config_id.as_deref(),
            latency,
            parsed.is_ok(),
            parsed.as_ref().err().map(|e| e.to_string()),
        );
        parsed
    }

    fn model_label(&self) -> String {
        self.endpoint.model.clone()
    }
}

/// 不需要 ASR 的路径（字幕导入后的索引）使用的占位后端
pub struct UnavailableBackend;

#[async_trait]
impl AsrBackend for UnavailableBackend {
    async fn transcribe(&self, _wav: Vec<u8>) -> Result<AsrClipResult, AsrHttpError> {
        Err(AsrHttpError::Status {
            status: 401,
            retry_after: None,
            body: "ASR backend unavailable".into(),
        })
    }

    fn model_label(&self) -> String {
        "unavailable".into()
    }
}

/// AIMD 并发控制器
#[derive(Debug, Clone)]
pub struct Aimd {
    limit: usize,
    min: usize,
    max: usize,
    streak: usize,
    cooldown_until: Option<Instant>,
}

impl Default for Aimd {
    fn default() -> Self {
        Self::new(AIMD_INITIAL, AIMD_MIN, AIMD_MAX)
    }
}

impl Aimd {
    pub fn new(initial: usize, min: usize, max: usize) -> Self {
        let min = min.max(1);
        let max = max.max(min);
        Self {
            limit: initial.clamp(min, max),
            min,
            max,
            streak: 0,
            cooldown_until: None,
        }
    }

    pub fn limit(&self) -> usize {
        self.limit
    }

    /// 加性增：连续成功次数达到当前并发数时 +1
    pub fn on_success(&mut self) {
        self.streak += 1;
        if self.streak >= self.limit {
            self.limit = (self.limit + 1).min(self.max);
            self.streak = 0;
        }
    }

    /// 乘性减：429 并发减半，冷却 Retry-After（缺省 5 s）
    pub fn on_rate_limited(&mut self, now: Instant, retry_after: Option<Duration>) {
        self.limit = (self.limit / 2).max(self.min);
        self.streak = 0;
        let until = now + retry_after.unwrap_or(DEFAULT_RATE_LIMIT_COOLDOWN);
        self.cooldown_until = Some(match self.cooldown_until {
            Some(existing) if existing > until => existing,
            _ => until,
        });
    }

    /// 其它失败：只打断连续成功
    pub fn on_failure(&mut self) {
        self.streak = 0;
    }

    /// 冷却中则返回冷却结束时刻
    pub fn cooling_until(&self, now: Instant) -> Option<Instant> {
        self.cooldown_until.filter(|until| *until > now)
    }
}

/// 失败分类
#[derive(Debug, Clone, PartialEq)]
pub enum AsrFailureClass {
    /// 429：减并发、冷却后重试
    RateLimited(Option<Duration>),
    /// 5xx / 网络：退避重试
    Retryable,
    /// 400 类：该段失败、不重试
    SegmentFatal,
    /// 401/403/404：整任务终止
    JobFatal(&'static str),
}

pub fn classify_failure(err: &AsrHttpError) -> AsrFailureClass {
    match err {
        AsrHttpError::Transport { .. } => AsrFailureClass::Retryable,
        AsrHttpError::Status {
            status,
            retry_after,
            ..
        } => match *status {
            429 => AsrFailureClass::RateLimited(*retry_after),
            401 | 403 => AsrFailureClass::JobFatal("auth-failed"),
            404 => AsrFailureClass::JobFatal("model-unavailable"),
            408 | 500..=599 => AsrFailureClass::Retryable,
            _ => AsrFailureClass::SegmentFatal,
        },
    }
}

/// 一个待转写段
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AsrJob {
    pub idx: i64,
    pub start_ms: i64,
    pub end_ms: i64,
}

/// 结果回调（落库 / 进度）
pub trait AsrSink: Send {
    /// 段完成；`bounds` 为绝对时间（毫秒）的语音起止
    fn on_done(
        &mut self,
        job: &AsrJob,
        text: &str,
        bounds: Option<(i64, i64)>,
    ) -> Result<(), MediaError>;
    fn on_failed(&mut self, job: &AsrJob, message: &str) -> Result<(), MediaError>;
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AsrRunSummary {
    pub done: usize,
    pub failed: usize,
    pub peak_concurrency: usize,
}

struct Queued {
    job: AsrJob,
    attempts: u32,
    rate_limited_attempts: u32,
    not_before: Option<Instant>,
}

type JobOutcome = (Queued, Result<AsrClipResult, AsrHttpError>);

/// 按 AIMD 并发跑完全部段；取消时立即中止在途请求（已完成段已经落库）
pub async fn run_asr_jobs(
    backend: Arc<dyn AsrBackend>,
    spool: Arc<PcmSpool>,
    jobs: Vec<AsrJob>,
    cancel: CancellationToken,
    sink: &mut dyn AsrSink,
) -> Result<AsrRunSummary, MediaError> {
    run_asr_jobs_with(backend, spool, jobs, cancel, sink, Aimd::default()).await
}

pub(crate) async fn run_asr_jobs_with(
    backend: Arc<dyn AsrBackend>,
    spool: Arc<PcmSpool>,
    jobs: Vec<AsrJob>,
    cancel: CancellationToken,
    sink: &mut dyn AsrSink,
    mut aimd: Aimd,
) -> Result<AsrRunSummary, MediaError> {
    let total_ms = spool.duration_ms();
    let mut queue: VecDeque<Queued> = jobs
        .into_iter()
        .map(|job| Queued {
            job,
            attempts: 0,
            rate_limited_attempts: 0,
            not_before: None,
        })
        .collect();
    let mut inflight: JoinSet<JobOutcome> = JoinSet::new();
    let mut summary = AsrRunSummary::default();
    let mut consecutive_failures = 0usize;

    loop {
        if cancel.is_cancelled() {
            inflight.abort_all();
            return Err(MediaError::Cancelled);
        }
        let now = Instant::now();

        // 发射：未冷却且未达并发上限时，取第一个到期的段
        if aimd.cooling_until(now).is_none() {
            while inflight.len() < aimd.limit() {
                let Some(pos) = queue
                    .iter()
                    .position(|q| q.not_before.map(|t| t <= now).unwrap_or(true))
                else {
                    break;
                };
                let queued = queue.remove(pos).expect("position is valid");
                let clip_start = (queued.job.start_ms - CLIP_PAD_MS).max(0);
                let clip_end =
                    (queued.job.end_ms + CLIP_PAD_MS).min(total_ms.max(queued.job.end_ms));
                let pcm = spool.read_ms(clip_start, clip_end)?;
                let wav = encode_wav_mono_16k(&pcm);
                let backend = Arc::clone(&backend);
                inflight.spawn(async move {
                    let result = backend.transcribe(wav).await;
                    (queued, result)
                });
                summary.peak_concurrency = summary.peak_concurrency.max(inflight.len());
            }
        }

        if inflight.is_empty() && queue.is_empty() {
            break;
        }

        // 下次需要醒来的时刻：冷却中 → 冷却结束；否则最早的退避到期（队列非空时）
        let wake = match aimd.cooling_until(now) {
            Some(until) if !queue.is_empty() => Some(until),
            Some(_) => None,
            None => queue.iter().filter_map(|q| q.not_before).min(),
        };
        let sleep_until = wake.unwrap_or_else(|| now + Duration::from_secs(3600));

        tokio::select! {
            _ = cancel.cancelled() => {
                inflight.abort_all();
                return Err(MediaError::Cancelled);
            }
            joined = inflight.join_next(), if !inflight.is_empty() => {
                let Some(joined) = joined else { continue };
                let (mut queued, result) = match joined {
                    Ok(v) => v,
                    Err(e) if e.is_cancelled() => continue,
                    Err(e) => return Err(MediaError::Io(format!("ASR task panicked: {}", e))),
                };
                match result {
                    Ok(clip) => {
                        aimd.on_success();
                        consecutive_failures = 0;
                        let clip_start = (queued.job.start_ms - CLIP_PAD_MS).max(0);
                        let bounds = clip
                            .speech_bounds_ms
                            .map(|(s, e)| (clip_start + s, clip_start + e));
                        sink.on_done(&queued.job, &clip.text, bounds)?;
                        summary.done += 1;
                    }
                    Err(err) => match classify_failure(&err) {
                        AsrFailureClass::RateLimited(retry_after) => {
                            aimd.on_rate_limited(Instant::now(), retry_after);
                            queued.rate_limited_attempts += 1;
                            if queued.rate_limited_attempts > MAX_RATE_LIMIT_ATTEMPTS {
                                sink.on_failed(&queued.job, &err.to_string())?;
                                summary.failed += 1;
                                consecutive_failures += 1;
                            } else {
                                queued.not_before = aimd.cooling_until(Instant::now());
                                queue.push_front(queued);
                            }
                        }
                        AsrFailureClass::Retryable => {
                            aimd.on_failure();
                            queued.attempts += 1;
                            if queued.attempts >= MAX_ATTEMPTS {
                                sink.on_failed(&queued.job, &err.to_string())?;
                                summary.failed += 1;
                                consecutive_failures += 1;
                            } else {
                                let backoff = Duration::from_millis(1000 * (1 << queued.attempts.min(5)));
                                queued.not_before = Some(Instant::now() + backoff);
                                queue.push_back(queued);
                            }
                        }
                        AsrFailureClass::SegmentFatal => {
                            aimd.on_failure();
                            sink.on_failed(&queued.job, &err.to_string())?;
                            summary.failed += 1;
                            consecutive_failures += 1;
                        }
                        AsrFailureClass::JobFatal(code) => {
                            inflight.abort_all();
                            return Err(MediaError::AsrFatal {
                                code: code.to_string(),
                                message: match code {
                                    "auth-failed" => format!("ASR 鉴权失败，请检查语音识别 API Key（{}）", err),
                                    _ => format!("ASR 模型不可用（{}）：{}", backend.model_label(), err),
                                },
                            });
                        }
                    },
                }
                if consecutive_failures >= MAX_CONSECUTIVE_SEGMENT_FAILURES {
                    inflight.abort_all();
                    return Err(MediaError::AsrFatal {
                        code: "transcription-failed".into(),
                        message: format!(
                            "连续 {} 段转写失败，已暂停（已完成的段已保存，剩余 {} 段可稍后继续）",
                            consecutive_failures,
                            queue.len() + inflight.len()
                        ),
                    });
                }
            }
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(sleep_until)), if wake.is_some() => {}
        }
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::wav::PcmSpoolWriter;
    use std::sync::Mutex;

    fn spool(secs: u64) -> Arc<PcmSpool> {
        let mut w = PcmSpoolWriter::new_in(None).unwrap();
        w.write(&vec![100i16; (secs * 16_000) as usize]).unwrap();
        Arc::new(w.finish().unwrap())
    }

    fn jobs(n: i64) -> Vec<AsrJob> {
        (0..n)
            .map(|i| AsrJob {
                idx: i,
                start_ms: i * 1000,
                end_ms: i * 1000 + 800,
            })
            .collect()
    }

    #[derive(Default)]
    struct RecordingSink {
        done: Vec<(i64, String, Option<(i64, i64)>)>,
        failed: Vec<i64>,
    }

    impl AsrSink for RecordingSink {
        fn on_done(
            &mut self,
            job: &AsrJob,
            text: &str,
            bounds: Option<(i64, i64)>,
        ) -> Result<(), MediaError> {
            self.done.push((job.idx, text.to_string(), bounds));
            Ok(())
        }
        fn on_failed(&mut self, job: &AsrJob, _message: &str) -> Result<(), MediaError> {
            self.failed.push(job.idx);
            Ok(())
        }
    }

    /// 脚本化后端：按调用序号返回预设结果，记录并发峰值
    struct ScriptedBackend {
        script: Mutex<VecDeque<Result<AsrClipResult, AsrHttpError>>>,
        default: Result<AsrClipResult, AsrHttpError>,
        inflight: std::sync::atomic::AtomicUsize,
        peak: std::sync::atomic::AtomicUsize,
        calls: std::sync::atomic::AtomicUsize,
        delay: Duration,
    }

    impl ScriptedBackend {
        fn new(
            script: Vec<Result<AsrClipResult, AsrHttpError>>,
            default: Result<AsrClipResult, AsrHttpError>,
        ) -> Self {
            Self {
                script: Mutex::new(script.into()),
                default,
                inflight: Default::default(),
                peak: Default::default(),
                calls: Default::default(),
                delay: Duration::from_millis(5),
            }
        }
    }

    #[async_trait]
    impl AsrBackend for ScriptedBackend {
        async fn transcribe(&self, wav: Vec<u8>) -> Result<AsrClipResult, AsrHttpError> {
            assert_eq!(&wav[0..4], b"RIFF");
            self.calls.fetch_add(1, Ordering::SeqCst);
            let now = self.inflight.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(self.delay).await;
            self.inflight.fetch_sub(1, Ordering::SeqCst);
            let next = self.script.lock().unwrap().pop_front();
            next.unwrap_or_else(|| self.default.clone())
        }
        fn model_label(&self) -> String {
            "scripted".into()
        }
    }

    fn ok(text: &str) -> Result<AsrClipResult, AsrHttpError> {
        Ok(AsrClipResult {
            text: text.into(),
            speech_bounds_ms: None,
        })
    }

    fn status(code: u16, retry_after: Option<Duration>) -> Result<AsrClipResult, AsrHttpError> {
        Err(AsrHttpError::Status {
            status: code,
            retry_after,
            body: String::new(),
        })
    }

    fn endpoint(base_url: &str, api_key: &str, model: &str) -> AsrEndpoint {
        AsrEndpoint::new("siliconflow", "SiliconFlow", base_url, api_key, model, None).unwrap()
    }

    #[test]
    fn aimd_additive_increase_multiplicative_decrease() {
        let mut a = Aimd::new(2, 1, 4);
        a.on_success();
        assert_eq!(a.limit(), 2);
        a.on_success();
        assert_eq!(a.limit(), 3);
        for _ in 0..3 {
            a.on_success();
        }
        assert_eq!(a.limit(), 4);
        for _ in 0..10 {
            a.on_success();
        }
        assert_eq!(a.limit(), 4, "capped at max");
        let now = Instant::now();
        a.on_rate_limited(now, Some(Duration::from_secs(2)));
        assert_eq!(a.limit(), 2);
        assert!(a.cooling_until(now).is_some());
        assert!(a.cooling_until(now + Duration::from_secs(3)).is_none());
        a.on_rate_limited(now, None);
        a.on_rate_limited(now, None);
        assert_eq!(a.limit(), 1, "floored at min");
        // 失败打断连续成功
        a.on_success();
        a.on_failure();
        a.on_success();
        assert_eq!(a.limit(), 2);
    }

    #[test]
    fn failure_classification() {
        let s = |code| AsrHttpError::Status {
            status: code,
            retry_after: None,
            body: String::new(),
        };
        assert_eq!(
            classify_failure(&s(429)),
            AsrFailureClass::RateLimited(None)
        );
        assert_eq!(classify_failure(&s(400)), AsrFailureClass::SegmentFatal);
        assert_eq!(
            classify_failure(&s(401)),
            AsrFailureClass::JobFatal("auth-failed")
        );
        assert_eq!(
            classify_failure(&s(403)),
            AsrFailureClass::JobFatal("auth-failed")
        );
        assert_eq!(classify_failure(&s(503)), AsrFailureClass::Retryable);
        assert_eq!(
            classify_failure(&AsrHttpError::Transport {
                timeout: true,
                message: String::new()
            }),
            AsrFailureClass::Retryable
        );
    }

    #[test]
    fn verbose_json_bounds_parsed() {
        let r = parse_transcription_body(
            r#"{"text":" hi ","segments":[{"start":0.32,"end":1.5},{"start":1.6,"end":2.25}]}"#,
        )
        .unwrap();
        assert_eq!(r.text, "hi");
        assert_eq!(r.speech_bounds_ms, Some((320, 2250)));
        let r = parse_transcription_body(r#"{"text":"plain"}"#).unwrap();
        assert_eq!(r.speech_bounds_ms, None);
        assert!(parse_transcription_body("not json").is_err());
        let r =
            parse_transcription_body(r#"{"text":"language Chinese<asr_text>讲到这里"}"#).unwrap();
        assert_eq!(r.text, "讲到这里");
        assert!(model_supports_verbose_json("FunAudioLLM/whisper-large-v3"));
        assert!(!model_supports_verbose_json("Qwen/Qwen3-ASR-1.7B"));
    }

    #[tokio::test(start_paused = true)]
    async fn runner_completes_and_grows_concurrency() {
        let backend = Arc::new(ScriptedBackend::new(vec![], ok("x")));
        let mut sink = RecordingSink::default();
        let summary = run_asr_jobs_with(
            backend.clone(),
            spool(30),
            jobs(24),
            CancellationToken::new(),
            &mut sink,
            Aimd::new(1, 1, 6),
        )
        .await
        .unwrap();
        assert_eq!(summary.done, 24);
        assert_eq!(sink.done.len(), 24);
        assert!(summary.peak_concurrency > 1, "{:?}", summary);
        assert!(backend.peak.load(Ordering::SeqCst) <= 6);
    }

    #[tokio::test(start_paused = true)]
    async fn runner_backs_off_on_429_and_skips_400() {
        let backend = Arc::new(ScriptedBackend::new(
            vec![
                status(429, Some(Duration::from_secs(1))),
                status(400, None),
                status(503, None),
            ],
            ok("y"),
        ));
        let mut sink = RecordingSink::default();
        let summary = run_asr_jobs_with(
            backend.clone(),
            spool(10),
            jobs(6),
            CancellationToken::new(),
            &mut sink,
            Aimd::new(1, 1, 4),
        )
        .await
        .unwrap();
        // 400 的段失败不重试；429/503 的段重试成功
        assert_eq!(summary.failed, 1);
        assert_eq!(summary.done, 5);
        assert_eq!(backend.calls.load(Ordering::SeqCst), 8);
    }

    #[tokio::test(start_paused = true)]
    async fn runner_aborts_on_auth_failure() {
        let backend = Arc::new(ScriptedBackend::new(vec![ok("a")], {
            Err(AsrHttpError::Status {
                status: 401,
                retry_after: None,
                body: "unauthorized".into(),
            })
        }));
        let mut sink = RecordingSink::default();
        let err = run_asr_jobs_with(
            backend,
            spool(10),
            jobs(5),
            CancellationToken::new(),
            &mut sink,
            Aimd::new(1, 1, 1),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "auth-failed");
        assert_eq!(sink.done.len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn runner_stops_after_consecutive_failures() {
        let backend = Arc::new(ScriptedBackend::new(vec![], status(400, None)));
        let mut sink = RecordingSink::default();
        let err = run_asr_jobs_with(
            backend,
            spool(20),
            jobs(12),
            CancellationToken::new(),
            &mut sink,
            Aimd::new(1, 1, 1),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "transcription-failed");
        assert_eq!(sink.failed.len(), MAX_CONSECUTIVE_SEGMENT_FAILURES);
    }

    #[tokio::test(start_paused = true)]
    async fn runner_cancellation_keeps_completed_segments() {
        let mut backend = ScriptedBackend::new(vec![], ok("z"));
        backend.delay = Duration::from_secs(1);
        let backend = Arc::new(backend);
        let cancel = CancellationToken::new();
        let c2 = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(2500)).await;
            c2.cancel();
        });
        let mut sink = RecordingSink::default();
        let err = run_asr_jobs_with(
            backend,
            spool(20),
            jobs(10),
            cancel,
            &mut sink,
            Aimd::new(1, 1, 1),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, MediaError::Cancelled));
        assert_eq!(sink.done.len(), 2);
    }

    #[tokio::test]
    async fn http_backend_posts_wav_and_records_bounds() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/v1/audio/transcriptions")
            .match_header("authorization", "Bearer sk-media")
            .match_body(mockito::Matcher::Regex("verbose_json".into()))
            .match_body(mockito::Matcher::Regex("whisper-1".into()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"text":"段落","segments":[{"start":0.2,"end":0.7}]}"#)
            .create_async()
            .await;
        let backend = HttpAsrBackend::new(
            endpoint(&format!("{}/v1", server.url()), "sk-media", "whisper-1"),
            None,
        )
        .unwrap();
        let r = backend
            .transcribe(encode_wav_mono_16k(&[0i16; 1600]))
            .await
            .unwrap();
        assert_eq!(r.text, "段落");
        assert_eq!(r.speech_bounds_ms, Some((200, 700)));
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn http_backend_sends_qwen_flash_segments_as_input_audio() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/compatible-mode/v1/chat/completions")
            .match_header("authorization", "Bearer sk-qwen")
            .match_body(mockito::Matcher::Regex(
                r#""data":"data:audio/wav;base64,UklGR"#.into(),
            ))
            .with_status(200)
            .with_body(r#"{"choices":[{"message":{"content":"这一段"}}]}"#)
            .create_async()
            .await;
        let backend = HttpAsrBackend::new(
            endpoint(
                &format!("{}/compatible-mode/v1", server.url()),
                "sk-qwen",
                "qwen3-asr-flash",
            ),
            None,
        )
        .unwrap();
        let r = backend
            .transcribe(encode_wav_mono_16k(&[0i16; 1600]))
            .await
            .unwrap();
        assert_eq!(r.text, "这一段");
        assert_eq!(r.speech_bounds_ms, None);
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn http_backend_downgrades_when_verbose_json_rejected() {
        let mut server = mockito::Server::new_async().await;
        let rejected = server
            .mock("POST", "/v1/audio/transcriptions")
            .match_body(mockito::Matcher::Regex("verbose_json".into()))
            .with_status(400)
            .with_body(r#"{"error":"unsupported response_format"}"#)
            .expect(1)
            .create_async()
            .await;
        let plain = server
            .mock("POST", "/v1/audio/transcriptions")
            .with_status(200)
            .with_body(r#"{"text":"ok"}"#)
            .expect(2)
            .create_async()
            .await;
        let backend = HttpAsrBackend::new(
            endpoint(&format!("{}/v1", server.url()), "sk", "whisper-large"),
            None,
        )
        .unwrap();
        let wav = encode_wav_mono_16k(&[0i16; 160]);
        assert_eq!(backend.transcribe(wav.clone()).await.unwrap().text, "ok");
        assert_eq!(backend.transcribe(wav).await.unwrap().text, "ok");
        rejected.assert_async().await;
        plain.assert_async().await;
    }

    #[tokio::test]
    async fn http_backend_surfaces_retry_after() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("POST", "/v1/audio/transcriptions")
            .with_status(429)
            .with_header("retry-after", "7")
            .with_body("slow down")
            .create_async()
            .await;
        let backend = HttpAsrBackend::new(
            endpoint(&format!("{}/v1", server.url()), "sk", "Qwen/Qwen3-ASR-1.7B"),
            None,
        )
        .unwrap();
        let err = backend
            .transcribe(encode_wav_mono_16k(&[0i16; 160]))
            .await
            .unwrap_err();
        assert_eq!(
            classify_failure(&err),
            AsrFailureClass::RateLimited(Some(Duration::from_secs(7)))
        );
    }
}
