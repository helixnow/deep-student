//! 轻量能量 + 过零率 VAD（自研，零依赖）
//!
//! 流式：`VadAnalyzer::push` 吃 16 kHz 单声道 i16，按 30 ms 帧累积能量（dBFS）
//! 与过零率；全部帧到齐后 `plan_segments` 输出语音段（毫秒）。
//!
//! 判决：局部噪声底（约 20 s 窗口内能量 10 分位）+ 自适应门限；
//! 能量略高于噪声底且过零率高的帧按清音（擦音）计入语音。
//!
//! 段合并参数（设计契约 §1.2）：间隔 < 0.4 s 合并、单段 ≤ 15 s、< 0.5 s 并入前段。

use super::resample::TARGET_RATE;

pub const FRAME_MS: u32 = 30;
pub const FRAME_SAMPLES: usize = (TARGET_RATE as usize * FRAME_MS as usize) / 1000;

/// 段合并参数
#[derive(Debug, Clone, Copy)]
pub struct VadParams {
    /// 间隔小于该值的相邻段合并
    pub merge_gap_ms: i64,
    /// 单段最长
    pub max_segment_ms: i64,
    /// 短于该值的段并入前段
    pub min_segment_ms: i64,
    /// 孤立短于该值的语音（咔哒声等）丢弃
    pub min_blip_ms: i64,
    /// 段前后保留的余量
    pub pad_before_ms: i64,
    pub pad_after_ms: i64,
}

impl Default for VadParams {
    fn default() -> Self {
        Self {
            merge_gap_ms: 400,
            max_segment_ms: 15_000,
            min_segment_ms: 500,
            min_blip_ms: 120,
            pad_before_ms: 100,
            pad_after_ms: 150,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameFeature {
    /// 帧能量（dBFS，静音约 -100）
    pub energy_db: f32,
    /// 过零率（0..1）
    pub zcr: f32,
}

/// 流式帧特征提取
#[derive(Default)]
pub struct VadAnalyzer {
    frames: Vec<FrameFeature>,
    pending: Vec<i16>,
    total_samples: u64,
}

impl VadAnalyzer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, samples: &[i16]) {
        self.total_samples += samples.len() as u64;
        let mut input = samples;
        if !self.pending.is_empty() {
            let need = FRAME_SAMPLES - self.pending.len();
            let take = need.min(input.len());
            self.pending.extend_from_slice(&input[..take]);
            input = &input[take..];
            if self.pending.len() == FRAME_SAMPLES {
                let frame = std::mem::take(&mut self.pending);
                self.frames.push(frame_feature(&frame));
            }
        }
        let mut chunks = input.chunks_exact(FRAME_SAMPLES);
        for frame in &mut chunks {
            self.frames.push(frame_feature(frame));
        }
        self.pending.extend_from_slice(chunks.remainder());
    }

    /// 结束：尾部不足一帧按实际样本计算
    pub fn finish(mut self) -> VadFrames {
        if !self.pending.is_empty() {
            let frame = std::mem::take(&mut self.pending);
            self.frames.push(frame_feature(&frame));
        }
        VadFrames {
            frames: self.frames,
            total_ms: (self.total_samples * 1000 / TARGET_RATE as u64) as i64,
        }
    }
}

pub struct VadFrames {
    pub frames: Vec<FrameFeature>,
    pub total_ms: i64,
}

fn frame_feature(frame: &[i16]) -> FrameFeature {
    if frame.is_empty() {
        return FrameFeature {
            energy_db: -100.0,
            zcr: 0.0,
        };
    }
    let mut sum = 0f64;
    let mut crossings = 0u32;
    let mut prev = frame[0];
    for &s in frame {
        let v = s as f64 / 32768.0;
        sum += v * v;
        if (s >= 0) != (prev >= 0) {
            crossings += 1;
        }
        prev = s;
    }
    let mean = sum / frame.len() as f64;
    FrameFeature {
        energy_db: (10.0 * (mean + 1e-10).log10()) as f32,
        zcr: crossings as f32 / frame.len() as f32,
    }
}

fn percentile(values: &mut [f32], p: f32) -> f32 {
    if values.is_empty() {
        return -100.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = ((values.len() - 1) as f32 * p).round() as usize;
    values[idx.min(values.len() - 1)]
}

/// 绝对能量下限：低于该值永远视为静音
const ABS_FLOOR_DB: f32 = -55.0;
/// 局部噪声窗口（帧数，约 20 s）
const NOISE_WINDOW_FRAMES: usize = 20_000 / FRAME_MS as usize;
/// 噪声底估计的块大小（帧，约 2 s）
const NOISE_BLOCK_FRAMES: usize = 2_000 / FRAME_MS as usize;

/// 逐帧语音判决
pub fn classify_frames(frames: &[FrameFeature]) -> Vec<bool> {
    if frames.is_empty() {
        return Vec::new();
    }
    let mut all: Vec<f32> = frames.iter().map(|f| f.energy_db).collect();
    let global_p90 = percentile(&mut all, 0.9);

    // 每块一个局部噪声底：以块为中心约 20 s 窗口的 10 分位
    let n_blocks = frames.len().div_ceil(NOISE_BLOCK_FRAMES);
    let half_window_blocks = (NOISE_WINDOW_FRAMES / NOISE_BLOCK_FRAMES / 2).max(1);
    let mut block_noise = Vec::with_capacity(n_blocks);
    let mut scratch = Vec::new();
    for b in 0..n_blocks {
        let lo = b.saturating_sub(half_window_blocks) * NOISE_BLOCK_FRAMES;
        let hi = ((b + half_window_blocks + 1) * NOISE_BLOCK_FRAMES).min(frames.len());
        scratch.clear();
        scratch.extend(frames[lo..hi].iter().map(|f| f.energy_db));
        block_noise.push(percentile(&mut scratch, 0.1));
    }

    frames
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let noise = block_noise[i / NOISE_BLOCK_FRAMES];
            let dynamic = (global_p90 - noise).max(0.0);
            if dynamic < 6.0 {
                // 动态范围很小：要么整段都是语音（持续讲话），要么整段静音
                return f.energy_db > ABS_FLOOR_DB + 10.0;
            }
            let thr = (noise + (0.3 * dynamic).max(6.0)).max(ABS_FLOOR_DB);
            if f.energy_db > thr {
                return true;
            }
            // 清音（擦音 s/sh/f）：能量弱但过零率高
            f.energy_db > (noise + 4.0).max(ABS_FLOOR_DB) && f.zcr > 0.3
        })
        .collect()
}

/// 从帧特征生成语音段（毫秒，升序、不重叠）
pub fn plan_segments(vad: &VadFrames, params: &VadParams) -> Vec<(i64, i64)> {
    let speech = classify_frames(&vad.frames);
    let frame_ms = FRAME_MS as i64;
    let total_ms = vad.total_ms.max(0);

    // 1. 连续语音帧 → 原始段
    let mut raw: Vec<(i64, i64)> = Vec::new();
    let mut start: Option<usize> = None;
    for (i, &s) in speech.iter().enumerate() {
        match (s, start) {
            (true, None) => start = Some(i),
            (false, Some(st)) => {
                raw.push((st as i64 * frame_ms, i as i64 * frame_ms));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(st) = start {
        raw.push((st as i64 * frame_ms, speech.len() as i64 * frame_ms));
    }

    // 2. 丢弃孤立短噪声（前后 merge_gap 内无其它语音）
    let raw: Vec<(i64, i64)> = raw
        .iter()
        .enumerate()
        .filter(|(i, (s, e))| {
            if e - s >= params.min_blip_ms {
                return true;
            }
            let near_prev = i
                .checked_sub(1)
                .and_then(|p| raw.get(p))
                .map(|(_, pe)| s - pe < params.merge_gap_ms)
                .unwrap_or(false);
            let near_next = raw
                .get(i + 1)
                .map(|(ns, _)| ns - e < params.merge_gap_ms)
                .unwrap_or(false);
            near_prev || near_next
        })
        .map(|(_, seg)| *seg)
        .collect();

    // 3. 加余量（夹在 [0, total]）
    let padded: Vec<(i64, i64)> = raw
        .iter()
        .map(|(s, e)| {
            (
                (s - params.pad_before_ms).max(0),
                (e + params.pad_after_ms).min(total_ms.max(*e)),
            )
        })
        .collect();

    // 4. 间隔 < merge_gap 合并（加余量后的重叠也一并合并）
    let mut merged: Vec<(i64, i64)> = Vec::new();
    for (s, e) in padded {
        if let Some(last) = merged.last_mut() {
            if s - last.1 < params.merge_gap_ms {
                last.1 = last.1.max(e);
                continue;
            }
        }
        merged.push((s, e));
    }

    // 5. 超长段在低能量处切分（每段 ≤ max）
    let mut split: Vec<(i64, i64)> = Vec::new();
    for (s, e) in merged {
        let mut cur = s;
        while e - cur > params.max_segment_ms {
            let cut = find_cut(&vad.frames, cur, params.max_segment_ms);
            split.push((cur, cut));
            cur = cut;
        }
        split.push((cur, e));
    }

    // 6. 过短段并入前段（若并入后超长，则尝试并入后段，否则保留）
    let mut out: Vec<(i64, i64)> = Vec::new();
    let mut i = 0;
    while i < split.len() {
        let (s, e) = split[i];
        if e - s < params.min_segment_ms {
            if let Some(last) = out.last_mut() {
                if e - last.0 <= params.max_segment_ms {
                    last.1 = e;
                    i += 1;
                    continue;
                }
            }
            if let Some(next) = split.get_mut(i + 1) {
                if next.1 - s <= params.max_segment_ms {
                    next.0 = s;
                    i += 1;
                    continue;
                }
            }
        }
        out.push((s, e));
        i += 1;
    }
    out
}

/// 在 [start + max/2, start + max] 内找能量最低的帧边界作为切点
fn find_cut(frames: &[FrameFeature], start_ms: i64, max_ms: i64) -> i64 {
    let frame_ms = FRAME_MS as i64;
    let lo = ((start_ms + max_ms / 2) / frame_ms) as usize;
    let hi = ((start_ms + max_ms) / frame_ms) as usize;
    let hi = hi.min(frames.len());
    if lo >= hi {
        return start_ms + max_ms;
    }
    // 偏好靠后的切点：能量相同取更晚者
    let mut best = hi - 1;
    let mut best_e = f32::INFINITY;
    for i in (lo..hi).rev() {
        if frames[i].energy_db < best_e - 0.5 {
            best_e = frames[i].energy_db;
            best = i;
        }
    }
    let cut = best as i64 * frame_ms;
    cut.clamp(start_ms + frame_ms, start_ms + max_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: usize = TARGET_RATE as usize;

    /// 合成音频：tone 段为"语音"（带谐波的 200 Hz 调制），其余为低噪声
    fn synth(layout: &[(f64, bool)]) -> Vec<i16> {
        let mut out = Vec::new();
        let mut seed = 12345u32;
        let mut t = 0usize;
        for &(secs, voiced) in layout {
            let n = (secs * SR as f64) as usize;
            for _ in 0..n {
                seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
                let noise = ((seed >> 16) as f64 / 65536.0 - 0.5) * 0.002;
                let x = t as f64 / SR as f64;
                let v = if voiced {
                    0.3 * (2.0 * std::f64::consts::PI * 200.0 * x).sin()
                        + 0.1 * (2.0 * std::f64::consts::PI * 600.0 * x).sin()
                } else {
                    0.0
                };
                out.push(((v + noise) * 32767.0) as i16);
                t += 1;
            }
        }
        out
    }

    fn analyze(samples: &[i16], chunk: usize) -> VadFrames {
        let mut a = VadAnalyzer::new();
        for c in samples.chunks(chunk) {
            a.push(c);
        }
        a.finish()
    }

    #[test]
    fn detects_speech_regions_with_padding() {
        let audio = synth(&[
            (1.0, false),
            (2.0, true),
            (2.0, false),
            (3.0, true),
            (1.0, false),
        ]);
        let vad = analyze(&audio, 1000);
        assert_eq!(vad.total_ms, 9000);
        let segs = plan_segments(&vad, &VadParams::default());
        assert_eq!(segs.len(), 2, "{:?}", segs);
        assert!((segs[0].0 - 900).abs() <= 60, "{:?}", segs);
        assert!((segs[0].1 - 3150).abs() <= 60, "{:?}", segs);
        assert!((segs[1].0 - 4900).abs() <= 60, "{:?}", segs);
        assert!((segs[1].1 - 8150).abs() <= 60, "{:?}", segs);
    }

    #[test]
    fn frame_features_independent_of_chunking() {
        let audio = synth(&[(0.5, true), (0.5, false)]);
        let a = analyze(&audio, 7);
        let b = analyze(&audio, 4800);
        assert_eq!(a.frames, b.frames);
    }

    #[test]
    fn short_gaps_merge() {
        // 间隔 0.3 s（加余量后 < 0.4 s）→ 合并
        let audio = synth(&[
            (1.0, false),
            (1.0, true),
            (0.3, false),
            (1.0, true),
            (1.0, false),
        ]);
        let segs = plan_segments(&analyze(&audio, 960), &VadParams::default());
        assert_eq!(segs.len(), 1, "{:?}", segs);
        // 间隔 1.2 s → 分开
        let audio = synth(&[
            (1.0, false),
            (1.0, true),
            (1.2, false),
            (1.0, true),
            (1.0, false),
        ]);
        let segs = plan_segments(&analyze(&audio, 960), &VadParams::default());
        assert_eq!(segs.len(), 2, "{:?}", segs);
    }

    #[test]
    fn long_speech_is_split_at_most_max() {
        // 40 s 连续语音，中途 20 s 处一个 150 ms 的微弱停顿
        let audio = synth(&[
            (0.5, false),
            (20.0, true),
            (0.15, false),
            (20.0, true),
            (0.5, false),
        ]);
        let params = VadParams::default();
        let segs = plan_segments(&analyze(&audio, 4096), &params);
        assert!(segs.len() >= 3, "{:?}", segs);
        for (s, e) in &segs {
            assert!(e - s <= params.max_segment_ms, "{:?}", segs);
            assert!(e > s);
        }
        for w in segs.windows(2) {
            assert!(w[0].1 <= w[1].0, "overlap {:?}", segs);
        }
        let covered: i64 = segs.iter().map(|(s, e)| e - s).sum();
        assert!(covered >= 40_000, "covered {}", covered);
    }

    #[test]
    fn short_segment_absorbed_into_previous() {
        // 0.2 s 的短语音（加余量后 0.45 s < 0.5 s）在 0.8 s 间隔后（加余量后 0.55 s，
        // 不触发间隔合并）→ 按"短段并入前段"规则合并
        let audio = synth(&[
            (1.0, false),
            (2.0, true),
            (0.8, false),
            (0.2, true),
            (2.0, false),
        ]);
        let segs = plan_segments(&analyze(&audio, 960), &VadParams::default());
        assert_eq!(segs.len(), 1, "{:?}", segs);
        assert!(segs[0].1 >= 4_100, "{:?}", segs);
    }

    #[test]
    fn isolated_click_is_dropped_and_silence_yields_nothing() {
        let audio = synth(&[(2.0, false), (0.06, true), (2.0, false)]);
        let segs = plan_segments(&analyze(&audio, 960), &VadParams::default());
        assert!(segs.is_empty(), "{:?}", segs);
        let silent = vec![0i16; SR * 3];
        let segs = plan_segments(&analyze(&silent, 960), &VadParams::default());
        assert!(segs.is_empty());
    }

    #[test]
    fn continuous_speech_without_dynamics_is_still_speech() {
        let audio = synth(&[(6.0, true)]);
        let segs = plan_segments(&analyze(&audio, 960), &VadParams::default());
        assert_eq!(segs.len(), 1, "{:?}", segs);
        assert!(segs[0].1 - segs[0].0 >= 5_900);
    }
}
