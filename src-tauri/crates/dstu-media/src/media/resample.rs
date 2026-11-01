//! 流式重采样到 16 kHz（按媒体时间轴全局网格对齐）
//!
//! 输出第 `n` 个采样点的时间恒为 `n / 16000` 秒；它在输入轴上的位置用整数
//! 有理数 `n * M / L`（`M = in_rate / g`，`L = out_rate / g`，`g = gcd`）从**绝对
//! 下标**直接算出，而不是逐点累加浮点步长——数小时的长课也不会产生累计漂移。
//!
//! 插值核是 Hann 窗 sinc 低通（截止频率取输出奈奎斯特的 92%），按相位预计算
//! 成表（相位数 = `L`），每行归一化为单位直流增益。

/// 目标采样率
pub const TARGET_RATE: u32 = 16_000;

/// 每侧零交叉数（决定核长度）
const ZERO_CROSSINGS: f64 = 8.0;
/// 截止频率占输出奈奎斯特的比例
const CUTOFF_RATIO: f64 = 0.92;
/// 相位表最大行数（极端采样率下退化为最近相位，避免表过大）
const MAX_PHASES: u64 = 4096;

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    a
}

/// 流式重采样器：`push` 绝对时间轴上连续的输入采样（单声道 f32），
/// 得到 16 kHz i16 输出。
pub struct Resampler {
    in_rate: u32,
    /// p = n * m / l
    m: u64,
    l: u64,
    /// 相位表量化：phase_idx = (rem * table_phases) / l
    table_phases: u64,
    half_taps: usize,
    table: Vec<f32>,
    /// 缓冲区首元素的绝对输入下标
    buf_start: u64,
    buf: Vec<f32>,
    /// 下一个输出采样的绝对下标
    next_out: u64,
    /// 已推入的输入采样总数（绝对）
    total_in: u64,
}

impl Resampler {
    pub fn new(in_rate: u32) -> Self {
        let in_rate = in_rate.max(1);
        let g = gcd(in_rate as u64, TARGET_RATE as u64);
        let m = in_rate as u64 / g;
        let l = TARGET_RATE as u64 / g;
        let table_phases = l.min(MAX_PHASES);

        // 截止频率（以输入采样率为单位的 cycles/sample）
        let ratio = (TARGET_RATE as f64 / in_rate as f64).min(1.0);
        let fc = 0.5 * ratio * CUTOFF_RATIO;
        let half_taps = (ZERO_CROSSINGS / (2.0 * fc)).ceil().max(2.0) as usize;
        let taps = half_taps * 2;

        let mut table = vec![0f32; table_phases as usize * taps];
        for phase in 0..table_phases as usize {
            let frac = phase as f64 / table_phases as f64;
            let row = &mut table[phase * taps..(phase + 1) * taps];
            let mut sum = 0.0f64;
            let mut tmp = vec![0f64; taps];
            for (j, slot) in tmp.iter_mut().enumerate() {
                // 第 j 个抽头对应输入下标 k = ip - half + 1 + j，距离 d = p - k
                let d = (half_taps as f64 - 1.0 - j as f64) + frac;
                let x = 2.0 * fc * d;
                let sinc = if x.abs() < 1e-12 {
                    1.0
                } else {
                    (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
                };
                let w_pos = d / half_taps as f64;
                let window = if w_pos.abs() >= 1.0 {
                    0.0
                } else {
                    0.5 * (1.0 + (std::f64::consts::PI * w_pos).cos())
                };
                *slot = sinc * window;
                sum += *slot;
            }
            for (dst, v) in row.iter_mut().zip(tmp) {
                *dst = if sum.abs() > 1e-12 {
                    (v / sum) as f32
                } else {
                    0.0
                };
            }
        }

        Self {
            in_rate,
            m,
            l,
            table_phases,
            half_taps,
            table,
            buf_start: 0,
            buf: Vec::with_capacity(8192),
            next_out: 0,
            total_in: 0,
        }
    }

    pub fn in_rate(&self) -> u32 {
        self.in_rate
    }

    /// 已推入的输入采样数（= 当前输入时间轴位置）
    pub fn input_position(&self) -> u64 {
        self.total_in
    }

    /// 已产出的输出采样数
    pub fn output_position(&self) -> u64 {
        self.next_out
    }

    /// 输入时间轴上补静音（坏包 / 时间戳空洞）
    pub fn push_silence(&mut self, frames: u64, out: &mut Vec<i16>) {
        const CHUNK: usize = 4096;
        let zeros = [0f32; CHUNK];
        let mut left = frames;
        while left > 0 {
            let n = (left as usize).min(CHUNK);
            self.push(&zeros[..n], out);
            left -= n as u64;
        }
    }

    /// 推入输入采样，产出所有可计算的输出采样
    pub fn push(&mut self, input: &[f32], out: &mut Vec<i16>) {
        self.buf.extend_from_slice(input);
        self.total_in += input.len() as u64;
        self.drain(out, false);
    }

    /// 输入结束：以零填充尾部，产出剩余输出（总输出数 = ceil(total_in * L / M)）
    pub fn finish(&mut self, out: &mut Vec<i16>) {
        self.drain(out, true);
    }

    fn sample_at(&self, abs: i64) -> f32 {
        if abs < self.buf_start as i64 {
            return 0.0;
        }
        let rel = (abs - self.buf_start as i64) as usize;
        self.buf.get(rel).copied().unwrap_or(0.0)
    }

    fn drain(&mut self, out: &mut Vec<i16>, flushing: bool) {
        let taps = self.half_taps * 2;
        let total_out_at_end = (self.total_in * self.l).div_ceil(self.m);
        loop {
            let num = self.next_out * self.m;
            let ip = num / self.l;
            let rem = num % self.l;
            if flushing {
                if self.next_out >= total_out_at_end {
                    break;
                }
            } else {
                // 需要的最右抽头 ip + half 必须已到达
                let need = ip + self.half_taps as u64;
                if need >= self.total_in {
                    break;
                }
            }
            let phase = ((rem * self.table_phases) / self.l) as usize;
            let row = &self.table[phase * taps..(phase + 1) * taps];
            let first = ip as i64 - self.half_taps as i64 + 1;
            let mut acc = 0f32;
            for (j, w) in row.iter().enumerate() {
                acc += self.sample_at(first + j as i64) * w;
            }
            let s = (acc * 32767.0).round().clamp(-32768.0, 32767.0) as i16;
            out.push(s);
            self.next_out += 1;
        }

        // 丢弃不再需要的输入：下一个输出的最左抽头之前的样本
        let next_ip = (self.next_out * self.m) / self.l;
        let keep_from = next_ip.saturating_sub(self.half_taps as u64);
        if keep_from > self.buf_start {
            let drop_n = ((keep_from - self.buf_start) as usize).min(self.buf.len());
            if drop_n > 0 {
                self.buf.drain(..drop_n);
                self.buf_start += drop_n as u64;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, freq: f64, secs: f64, amp: f32) -> Vec<f32> {
        let n = (rate as f64 * secs) as usize;
        (0..n)
            .map(|i| {
                amp * (2.0 * std::f64::consts::PI * freq * i as f64 / rate as f64).sin() as f32
            })
            .collect()
    }

    fn run(rate: u32, input: &[f32], chunk: usize) -> Vec<i16> {
        let mut r = Resampler::new(rate);
        let mut out = Vec::new();
        for c in input.chunks(chunk) {
            r.push(c, &mut out);
        }
        r.finish(&mut out);
        out
    }

    #[test]
    fn output_length_tracks_global_grid_without_drift() {
        // 44.1 kHz 非整数比；1 小时等效长度用小块推入，输出数必须精确等于网格长度
        for &rate in &[44_100u32, 48_000, 22_050, 8_000, 16_000, 11_025, 32_000] {
            let secs = 3.37;
            let n_in = (rate as f64 * secs) as u64;
            let input = vec![0.1f32; n_in as usize];
            let out = run(rate, &input, 777);
            let expected = (n_in * TARGET_RATE as u64).div_ceil(rate as u64);
            assert_eq!(out.len() as u64, expected, "rate {}", rate);
        }
    }

    #[test]
    fn chunking_does_not_change_output() {
        let input = sine(44_100, 440.0, 0.5, 0.5);
        let a = run(44_100, &input, 1);
        let b = run(44_100, &input, 4096);
        let c = run(44_100, &input, input.len());
        assert_eq!(a, b);
        assert_eq!(b, c);
    }

    #[test]
    fn impulse_lands_on_the_global_grid() {
        // 在 44.1 kHz 输入的第 t=2.5 s 放一个脉冲，输出峰值应位于 16 kHz 网格的 2.5 s 处
        let rate = 44_100u32;
        let mut input = vec![0f32; rate as usize * 4];
        let at = (rate as f64 * 2.5) as usize;
        input[at] = 1.0;
        let out = run(rate, &input, 1000);
        let (peak_idx, _) = out
            .iter()
            .enumerate()
            .max_by_key(|(_, v)| v.unsigned_abs())
            .unwrap();
        assert!(
            (peak_idx as i64 - 40_000).abs() <= 1,
            "peak at {}",
            peak_idx
        );
    }

    #[test]
    fn silence_fill_keeps_timeline() {
        let rate = 48_000u32;
        let mut r = Resampler::new(rate);
        let mut out = Vec::new();
        r.push(&vec![0.2f32; 48_000], &mut out);
        r.push_silence(96_000, &mut out);
        r.push(&vec![0.2f32; 48_000], &mut out);
        r.finish(&mut out);
        assert_eq!(out.len(), 64_000);
        // 中段静音
        assert!(out[24_000..40_000].iter().all(|v| v.abs() < 50));
        // 两端保持幅度
        assert!((out[8_000] as i32 - (0.2 * 32767.0) as i32).abs() < 200);
        assert!((out[56_000] as i32 - (0.2 * 32767.0) as i32).abs() < 200);
    }

    #[test]
    fn passband_preserved_and_alias_suppressed() {
        // 1 kHz 保留；7.9 kHz 以上（输入 12 kHz）在 48k→16k 后应被强烈衰减
        let pass = run(48_000, &sine(48_000, 1_000.0, 1.0, 0.5), 960);
        let rms_pass = (pass[2000..14000]
            .iter()
            .map(|v| (*v as f64).powi(2))
            .sum::<f64>()
            / 12000.0)
            .sqrt();
        let stop = run(48_000, &sine(48_000, 12_000.0, 1.0, 0.5), 960);
        let rms_stop = (stop[2000..14000]
            .iter()
            .map(|v| (*v as f64).powi(2))
            .sum::<f64>()
            / 12000.0)
            .sqrt();
        assert!(rms_pass > 10_000.0, "pass rms {}", rms_pass);
        assert!(rms_stop < rms_pass * 0.05, "stop rms {}", rms_stop);
    }
}
