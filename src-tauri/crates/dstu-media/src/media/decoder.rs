//! symphonia 流式解码 → 单声道 16 kHz i16
//!
//! - 逐包解码，不整文件进内存；输出经 [`Resampler`] 落在全局 16 kHz 网格上。
//! - 坏包（`DecodeError` / 包内 IO 错误）跳过，并按该包时长补静音，保持时间轴。
//! - 包时间戳向前跳跃（容器空洞）> 200 ms 时补静音对齐；从不回退时间轴。
//! - 容器 / 编码不受支持时给出明确提示（"请转为 MP4/M4A"）。
//!
//! 仅视频轨的文件、Opus / AC-3 / WMA 等无纯 Rust 解码器的编码返回 `MediaError`。

use std::fs::File;
use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{CodecType, Decoder, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, FormatReader, Track};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::TimeBase;

use super::resample::{Resampler, TARGET_RATE};
use super::MediaError;

/// 时间戳空洞超过该值（毫秒）才补静音（AAC/MP3 编码器延迟约 20–50 ms，不算空洞）
const GAP_TOLERANCE_MS: u64 = 200;
/// 开头连续解码失败超过该数且从未成功 → 判定文件损坏
const MAX_LEADING_DECODE_FAILURES: u64 = 64;
/// 单次补静音上限（防止损坏的时间戳把输出撑爆）：10 分钟
const MAX_GAP_FILL_SECONDS: u64 = 600;

pub const CONVERT_HINT: &str = "请先转为 MP4(AAC)/M4A/MP3/WAV 后重试";

/// 解码统计
#[derive(Debug, Clone, Default)]
pub struct DecodeReport {
    /// 输出 16 kHz 采样总数
    pub samples: u64,
    pub duration_ms: i64,
    pub source_rate: u32,
    pub source_channels: usize,
    pub codec: String,
    /// 坏包数（已补静音）
    pub corrupt_packets: u64,
    /// 补静音总时长（毫秒）
    pub filled_silence_ms: u64,
}

/// 快速探测结果（不解码）
#[derive(Debug, Clone)]
pub struct ProbeInfo {
    pub duration_ms: Option<i64>,
    pub codec: String,
    pub sample_rate: Option<u32>,
}

fn codec_label(codec: CodecType) -> String {
    use symphonia::core::codecs::*;
    if let Some(desc) = symphonia::default::get_codecs().get_codec(codec) {
        return desc.short_name.to_string();
    }
    let name = match codec {
        CODEC_TYPE_OPUS => "Opus",
        CODEC_TYPE_EAC3 => "E-AC-3",
        CODEC_TYPE_AC4 => "AC-4",
        CODEC_TYPE_DCA => "DTS",
        CODEC_TYPE_WMA => "WMA",
        CODEC_TYPE_SPEEX => "Speex",
        CODEC_TYPE_MUSEPACK => "Musepack",
        CODEC_TYPE_WAVPACK => "WavPack",
        CODEC_TYPE_MONKEYS_AUDIO => "APE",
        CODEC_TYPE_TTA => "TTA",
        CODEC_TYPE_ATRAC1 | CODEC_TYPE_ATRAC3 | CODEC_TYPE_ATRAC3PLUS | CODEC_TYPE_ATRAC9 => {
            "ATRAC"
        }
        _ => "未知编码",
    };
    name.to_string()
}

fn open_format(path: &Path, ext_hint: Option<&str>) -> Result<Box<dyn FormatReader>, MediaError> {
    let file = File::open(path)
        .map_err(|e| MediaError::Io(format!("无法打开媒体文件 {}: {}", path.display(), e)))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = ext_hint
        .map(|e| e.trim_start_matches('.').to_ascii_lowercase())
        .filter(|e| !e.is_empty())
    {
        hint.with_extension(&ext);
    }
    let format_opts = FormatOptions {
        enable_gapless: false,
        ..Default::default()
    };
    symphonia::default::get_probe()
        .format(&hint, mss, &format_opts, &MetadataOptions::default())
        .map(|probed| probed.format)
        .map_err(|e| match e {
            SymError::IoError(io) => MediaError::Io(format!("读取媒体文件失败: {}", io)),
            _ => {
                MediaError::Unsupported(format!("不支持的媒体容器格式（{}）。{}", e, CONVERT_HINT))
            }
        })
}

/// 选第一条可解码的音轨；没有可解码音轨时给出具体原因
fn select_audio_track(format: &dyn FormatReader) -> Result<Track, MediaError> {
    let codecs = symphonia::default::get_codecs();
    let tracks = format.tracks();
    if let Some(track) = tracks.iter().find(|t| {
        t.codec_params.codec != CODEC_TYPE_NULL && codecs.get_codec(t.codec_params.codec).is_some()
    }) {
        return Ok(track.clone());
    }
    // 有音轨但编码不支持
    if let Some(track) = tracks
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL || t.codec_params.sample_rate.is_some())
    {
        return Err(MediaError::Unsupported(format!(
            "音轨编码 {} 暂不支持转写。{}",
            codec_label(track.codec_params.codec),
            CONVERT_HINT
        )));
    }
    Err(MediaError::NoAudioTrack(
        "媒体文件中没有可识别的音轨（可能是无声视频，或音轨编码不受支持）".to_string(),
    ))
}

fn ts_to_frames(ts: u64, time_base: Option<TimeBase>, rate: u32) -> u64 {
    match time_base {
        Some(tb) if tb.denom > 0 => {
            ((ts as u128 * tb.numer as u128 * rate as u128) / tb.denom as u128) as u64
        }
        _ => ts,
    }
}

/// 快速探测时长（读取容器头，不解码）
pub fn probe(path: &Path, ext_hint: Option<&str>) -> Result<ProbeInfo, MediaError> {
    let format = open_format(path, ext_hint)?;
    let track = select_audio_track(format.as_ref())?;
    let params = &track.codec_params;
    let duration_ms = match (params.n_frames, params.time_base, params.sample_rate) {
        (Some(n), Some(tb), _) if tb.denom > 0 => {
            Some(((n as u128 * tb.numer as u128 * 1000) / tb.denom as u128) as i64)
        }
        (Some(n), None, Some(rate)) if rate > 0 => Some((n as u128 * 1000 / rate as u128) as i64),
        _ => None,
    };
    Ok(ProbeInfo {
        duration_ms,
        codec: codec_label(params.codec),
        sample_rate: params.sample_rate,
    })
}

/// 流式解码到 16 kHz 单声道。
///
/// - `is_cancelled`：每个包前检查，返回 true 时中止（`MediaError::Cancelled`）
/// - `on_progress(fraction)`：已知总时长时按时间轴回报 0..1
/// - `sink(pcm)`：接收输出块（顺序、连续）
pub fn decode_to_mono_16k(
    path: &Path,
    ext_hint: Option<&str>,
    is_cancelled: &dyn Fn() -> bool,
    on_progress: &mut dyn FnMut(f32),
    sink: &mut dyn FnMut(&[i16]) -> Result<(), MediaError>,
) -> Result<DecodeReport, MediaError> {
    let mut format = open_format(path, ext_hint)?;
    let track = select_audio_track(format.as_ref())?;
    let track_id = track.id;
    let params = track.codec_params.clone();
    let codec_name = codec_label(params.codec);
    let decoder_opts = DecoderOptions::default();
    let make_decoder = |params: &symphonia::core::codecs::CodecParameters| -> Result<Box<dyn Decoder>, MediaError> {
        symphonia::default::get_codecs()
            .make(params, &decoder_opts)
            .map_err(|e| {
                MediaError::Unsupported(format!(
                    "无法初始化 {} 解码器（{}）。{}",
                    codec_name, e, CONVERT_HINT
                ))
            })
    };
    let mut decoder = make_decoder(&params)?;

    let mut rate = params.sample_rate.unwrap_or(0);
    let time_base = params.time_base;
    let total_frames_hint = params.n_frames;
    let mut resampler: Option<Resampler> = if rate > 0 {
        Some(Resampler::new(rate))
    } else {
        None
    };
    // 采样率中途变化时，前一个重采样器已产出的输出样本数（网格偏移）
    let mut out_base: u64 = 0;
    // 当前输入时间轴位置（当前采样率下的帧数，自 out_base 起）
    let mut report = DecodeReport {
        codec: codec_name.clone(),
        source_rate: rate,
        source_channels: params.channels.map(|c| c.count()).unwrap_or(0),
        ..Default::default()
    };
    let mut out: Vec<i16> = Vec::with_capacity(16_384);
    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut mono: Vec<f32> = Vec::with_capacity(8_192);
    let mut decoded_any = false;
    let mut leading_failures = 0u64;
    let mut packets_seen = 0u64;
    // 已推入当前重采样器的输入帧位置（对应包时间戳的期望值）
    let mut expected_frames: u64 = 0;
    let mut ts_origin: Option<u64> = None;

    let mut flush_out = |out: &mut Vec<i16>, report: &mut DecodeReport| -> Result<(), MediaError> {
        if !out.is_empty() {
            report.samples += out.len() as u64;
            sink(out)?;
            out.clear();
        }
        Ok(())
    };

    loop {
        if is_cancelled() {
            return Err(MediaError::Cancelled);
        }
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => {
                // 链式流（如拼接的 OGG）：重建解码器继续
                decoder = make_decoder(&params)?;
                continue;
            }
            Err(SymError::IoError(e)) => {
                if decoded_any {
                    // 尾部截断：按已解码部分收尾
                    log::warn!(
                        "[media::decoder] read error near end, finishing early: {}",
                        e
                    );
                    break;
                }
                return Err(MediaError::Io(format!("读取媒体数据失败: {}", e)));
            }
            Err(SymError::DecodeError(msg)) => {
                // 容器层坏数据：无法得知时长，跳过
                report.corrupt_packets += 1;
                log::warn!("[media::decoder] demux error skipped: {}", msg);
                if !decoded_any {
                    leading_failures += 1;
                    if leading_failures > MAX_LEADING_DECODE_FAILURES {
                        return Err(MediaError::Decode(format!(
                            "媒体文件已损坏，无法解析（{}）",
                            msg
                        )));
                    }
                }
                continue;
            }
            Err(e) => {
                if decoded_any {
                    log::warn!("[media::decoder] demux stopped: {}", e);
                    break;
                }
                return Err(MediaError::Decode(format!("解析媒体失败: {}", e)));
            }
        };
        if packet.track_id() != track_id {
            continue;
        }
        packets_seen += 1;

        // 时间戳空洞：向前跳跃超过容差时补静音（以首包时间戳为原点）
        if let Some(r) = resampler.as_mut() {
            let origin = *ts_origin.get_or_insert(packet.ts());
            let pkt_frames = ts_to_frames(packet.ts().saturating_sub(origin), time_base, rate);
            let tolerance = rate as u64 * GAP_TOLERANCE_MS / 1000;
            if pkt_frames > expected_frames + tolerance {
                let gap = (pkt_frames - expected_frames).min(rate as u64 * MAX_GAP_FILL_SECONDS);
                r.push_silence(gap, &mut out);
                expected_frames += gap;
                report.filled_silence_ms += gap * 1000 / rate.max(1) as u64;
            }
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                let channels = spec.channels.count().max(1);
                if spec.rate != rate || resampler.is_none() {
                    // 首次得知采样率，或采样率中途变化：收尾旧重采样器，网格继续
                    if let Some(mut old) = resampler.take() {
                        old.finish(&mut out);
                        out_base += old.output_position();
                    }
                    rate = spec.rate;
                    report.source_rate = rate;
                    resampler = Some(Resampler::new(rate));
                    expected_frames = 0;
                    ts_origin = Some(packet.ts());
                }
                report.source_channels = channels;
                let frames = decoded.frames();
                if frames == 0 {
                    continue;
                }
                let needs_new = sample_buf
                    .as_ref()
                    .map(|b| b.capacity() < frames * channels)
                    .unwrap_or(true);
                if needs_new {
                    sample_buf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
                }
                let buf = sample_buf.as_mut().expect("sample buffer allocated");
                buf.copy_interleaved_ref(decoded);
                let samples = buf.samples();
                mono.clear();
                mono.extend(
                    samples
                        .chunks_exact(channels)
                        .map(|frame| frame.iter().sum::<f32>() / channels as f32),
                );
                if let Some(r) = resampler.as_mut() {
                    r.push(&mono, &mut out);
                }
                expected_frames += mono.len() as u64;
                decoded_any = true;
                leading_failures = 0;
            }
            Err(SymError::DecodeError(msg)) | Err(SymError::Unsupported(msg)) => {
                report.corrupt_packets += 1;
                if let Some(r) = resampler.as_mut() {
                    let dur = ts_to_frames(packet.dur(), time_base, rate);
                    r.push_silence(dur, &mut out);
                    expected_frames += dur;
                    report.filled_silence_ms += dur * 1000 / rate.max(1) as u64;
                }
                log::debug!("[media::decoder] corrupt packet skipped: {}", msg);
                if !decoded_any {
                    leading_failures += 1;
                    if leading_failures > MAX_LEADING_DECODE_FAILURES {
                        return Err(MediaError::Decode(format!(
                            "{} 音轨无法解码（{}）。{}",
                            codec_name, msg, CONVERT_HINT
                        )));
                    }
                }
            }
            Err(SymError::IoError(_)) => {
                // 包内数据截断：同坏包处理
                report.corrupt_packets += 1;
                if let Some(r) = resampler.as_mut() {
                    let dur = ts_to_frames(packet.dur(), time_base, rate);
                    r.push_silence(dur, &mut out);
                    expected_frames += dur;
                    report.filled_silence_ms += dur * 1000 / rate.max(1) as u64;
                }
            }
            Err(SymError::ResetRequired) => {
                decoder = make_decoder(&params)?;
            }
            Err(e) => {
                return Err(MediaError::Decode(format!("解码失败: {}", e)));
            }
        }

        if out.len() >= 16_000 {
            flush_out(&mut out, &mut report)?;
        }
        if packets_seen % 64 == 0 {
            if let Some(total) = total_frames_hint.filter(|t| *t > 0) {
                on_progress((expected_frames as f64 / total as f64).min(1.0) as f32);
            }
        }
    }

    if !decoded_any {
        return Err(MediaError::Decode(
            "没有解码出任何音频数据（文件可能为空或已损坏）".to_string(),
        ));
    }
    if let Some(mut r) = resampler.take() {
        r.finish(&mut out);
        out_base += r.output_position();
    }
    flush_out(&mut out, &mut report)?;
    debug_assert_eq!(out_base, report.samples);
    report.duration_ms = (report.samples * 1000 / TARGET_RATE as u64) as i64;
    on_progress(1.0);
    Ok(report)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    /// 生成 16-bit PCM WAV（立体声可选）
    pub(crate) fn write_wav(path: &Path, rate: u32, channels: u16, samples: &[i16]) {
        let mut f = File::create(path).unwrap();
        let data_len = (samples.len() * 2) as u32;
        let byte_rate = rate * channels as u32 * 2;
        f.write_all(b"RIFF").unwrap();
        f.write_all(&(36 + data_len).to_le_bytes()).unwrap();
        f.write_all(b"WAVEfmt ").unwrap();
        f.write_all(&16u32.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap();
        f.write_all(&channels.to_le_bytes()).unwrap();
        f.write_all(&rate.to_le_bytes()).unwrap();
        f.write_all(&byte_rate.to_le_bytes()).unwrap();
        f.write_all(&(channels * 2).to_le_bytes()).unwrap();
        f.write_all(&16u16.to_le_bytes()).unwrap();
        f.write_all(b"data").unwrap();
        f.write_all(&data_len.to_le_bytes()).unwrap();
        for s in samples {
            f.write_all(&s.to_le_bytes()).unwrap();
        }
    }

    pub(crate) fn tone(rate: u32, secs: f64, freq: f64, amp: f64) -> Vec<i16> {
        let n = (rate as f64 * secs) as usize;
        (0..n)
            .map(|i| {
                (amp * 32767.0 * (2.0 * std::f64::consts::PI * freq * i as f64 / rate as f64).sin())
                    as i16
            })
            .collect()
    }

    fn decode_all(path: &Path) -> (DecodeReport, Vec<i16>) {
        let mut pcm = Vec::new();
        let report = decode_to_mono_16k(path, Some("wav"), &|| false, &mut |_| {}, &mut |chunk| {
            pcm.extend_from_slice(chunk);
            Ok(())
        })
        .unwrap();
        (report, pcm)
    }

    #[test]
    fn decodes_stereo_44k_wav_to_mono_16k_on_grid() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.wav");
        // 立体声：左声道 440 Hz，右声道静音 → 单声道幅度减半
        let mono = tone(44_100, 2.5, 440.0, 0.6);
        let mut stereo = Vec::with_capacity(mono.len() * 2);
        for s in &mono {
            stereo.push(*s);
            stereo.push(0);
        }
        write_wav(&path, 44_100, 2, &stereo);
        let (report, pcm) = decode_all(&path);
        assert_eq!(report.source_rate, 44_100);
        assert_eq!(report.source_channels, 2);
        assert_eq!(pcm.len() as u64, report.samples);
        // 2.5 s → 恰好 40000 个 16 kHz 采样（网格长度 = ceil(n_in * 16000 / 44100)）
        assert_eq!(pcm.len(), 40_000);
        assert_eq!(report.duration_ms, 2_500);
        let peak = pcm[1000..39_000]
            .iter()
            .map(|v| v.unsigned_abs())
            .max()
            .unwrap();
        let expected = (0.3 * 32767.0) as u16;
        assert!(
            (peak as i32 - expected as i32).abs() < 600,
            "peak {} expected ~{}",
            peak,
            expected
        );
    }

    #[test]
    fn probe_reports_duration_without_decoding() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.wav");
        write_wav(&path, 8_000, 1, &tone(8_000, 3.0, 300.0, 0.5));
        let info = probe(&path, Some("wav")).unwrap();
        assert_eq!(info.duration_ms, Some(3_000));
        assert_eq!(info.sample_rate, Some(8_000));
    }

    #[test]
    fn garbage_is_reported_as_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.bin");
        std::fs::write(&path, vec![0x5au8; 4096]).unwrap();
        let err =
            decode_to_mono_16k(&path, None, &|| false, &mut |_| {}, &mut |_| Ok(())).unwrap_err();
        assert_eq!(err.code(), "media-unsupported", "{}", err);
        assert!(err.to_string().contains("MP4"));
    }

    #[test]
    fn cancellation_stops_decoding() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("d.wav");
        write_wav(&path, 16_000, 1, &tone(16_000, 5.0, 300.0, 0.5));
        let err = decode_to_mono_16k(&path, Some("wav"), &|| true, &mut |_| {}, &mut |_| Ok(()))
            .unwrap_err();
        assert!(matches!(err, MediaError::Cancelled));
    }
}
