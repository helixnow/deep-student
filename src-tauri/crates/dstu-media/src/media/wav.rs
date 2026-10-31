//! 16 kHz 单声道 PCM 的临时落盘（spool）与 WAV 封装
//!
//! 解码一次写入临时文件（每秒 32 KB；1 小时约 115 MB 磁盘、常驻内存≈0），
//! ASR 阶段按段随机读取并封装为 WAV 上传。

use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Mutex;

use super::resample::TARGET_RATE;
use super::MediaError;

/// 把 16 kHz 单声道 i16 封装为 WAV 字节
pub fn encode_wav_mono_16k(samples: &[i16]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&TARGET_RATE.to_le_bytes());
    out.extend_from_slice(&(TARGET_RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// 写入阶段
pub struct PcmSpoolWriter {
    file: tempfile::NamedTempFile,
    writer: Option<BufWriter<File>>,
    samples: u64,
}

impl PcmSpoolWriter {
    pub fn new_in(dir: Option<&Path>) -> Result<Self, MediaError> {
        let file = match dir {
            Some(d) => {
                std::fs::create_dir_all(d)?;
                tempfile::Builder::new()
                    .prefix("media-pcm-")
                    .suffix(".raw")
                    .tempfile_in(d)?
            }
            None => tempfile::Builder::new()
                .prefix("media-pcm-")
                .suffix(".raw")
                .tempfile()?,
        };
        let writer = BufWriter::with_capacity(256 * 1024, file.reopen()?);
        Ok(Self {
            file,
            writer: Some(writer),
            samples: 0,
        })
    }

    pub fn write(&mut self, pcm: &[i16]) -> Result<(), MediaError> {
        let w = self
            .writer
            .as_mut()
            .ok_or_else(|| MediaError::Io("spool already finished".into()))?;
        let mut bytes = Vec::with_capacity(pcm.len() * 2);
        for s in pcm {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        w.write_all(&bytes)?;
        self.samples += pcm.len() as u64;
        Ok(())
    }

    pub fn finish(mut self) -> Result<PcmSpool, MediaError> {
        if let Some(mut w) = self.writer.take() {
            w.flush()?;
        }
        let reader = self.file.reopen()?;
        Ok(PcmSpool {
            _file: self.file,
            reader: Mutex::new(reader),
            samples: self.samples,
        })
    }
}

/// 只读阶段：按采样区间随机读取（多任务并发共享，内部串行化 seek+read）
pub struct PcmSpool {
    _file: tempfile::NamedTempFile,
    reader: Mutex<File>,
    samples: u64,
}

impl PcmSpool {
    pub fn samples(&self) -> u64 {
        self.samples
    }

    pub fn duration_ms(&self) -> i64 {
        (self.samples * 1000 / TARGET_RATE as u64) as i64
    }

    /// 读取 [start_ms, end_ms) 的采样（越界部分截断）
    pub fn read_ms(&self, start_ms: i64, end_ms: i64) -> Result<Vec<i16>, MediaError> {
        let rate = TARGET_RATE as i64;
        let start = (start_ms.max(0) * rate / 1000) as u64;
        let end = ((end_ms.max(0) * rate / 1000) as u64).min(self.samples);
        if end <= start {
            return Ok(Vec::new());
        }
        let mut bytes = vec![0u8; ((end - start) * 2) as usize];
        {
            let mut f = self
                .reader
                .lock()
                .map_err(|_| MediaError::Io("spool lock poisoned".into()))?;
            f.seek(SeekFrom::Start(start * 2))?;
            f.read_exact(&mut bytes)?;
        }
        Ok(bytes
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_is_valid() {
        let wav = encode_wav_mono_16k(&[1, -1, 300]);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 6);
        assert_eq!(wav.len(), 50);
    }

    #[test]
    fn spool_roundtrip_by_time_range() {
        let mut w = PcmSpoolWriter::new_in(None).unwrap();
        let pcm: Vec<i16> = (0..48_000).map(|i| (i % 30_000) as i16).collect();
        for c in pcm.chunks(1234) {
            w.write(c).unwrap();
        }
        let spool = w.finish().unwrap();
        assert_eq!(spool.samples(), 48_000);
        assert_eq!(spool.duration_ms(), 3_000);
        let mid = spool.read_ms(1_000, 1_500).unwrap();
        assert_eq!(mid.len(), 8_000);
        assert_eq!(mid[0], pcm[16_000]);
        let tail = spool.read_ms(2_900, 9_000).unwrap();
        assert_eq!(tail.len(), 1_600);
        assert!(spool.read_ms(5_000, 6_000).unwrap().is_empty());
    }
}
