//! Minimal typed DmView subset. Prost handles unknown protobuf fields and wire validation.
use std::io::Read;

use prost::Message;

use super::{BiliError, BiliResult, API_LIMIT};

#[derive(Clone, PartialEq, Message)]
struct DmViewRequest {
    #[prost(uint64, tag = "1")]
    aid: u64,
    #[prost(uint64, tag = "2")]
    cid: u64,
    #[prost(int32, tag = "3")]
    kind: i32,
    #[prost(string, tag = "4")]
    spmid: String,
}
#[derive(Clone, PartialEq, Message)]
struct DmViewReply {
    #[prost(message, optional, tag = "3")]
    subtitle: Option<Subtitle>,
}
#[derive(Clone, PartialEq, Message)]
struct Subtitle {
    #[prost(message, repeated, tag = "3")]
    tracks: Vec<Track>,
}
#[derive(Clone, PartialEq, Message)]
pub struct Track {
    #[prost(string, tag = "3")]
    pub lan: String,
    #[prost(string, tag = "4")]
    pub lan_doc: String,
    #[prost(string, tag = "5")]
    pub url: String,
    #[prost(int32, tag = "7")]
    pub ai_mark: i32,
    #[prost(int32, tag = "9")]
    pub ai_from: i32,
    #[prost(int32, tag = "10")]
    pub ai_type: i32,
}

pub fn request(aid: u64, cid: u64) -> Vec<u8> {
    let bytes = DmViewRequest {
        aid,
        cid,
        kind: 1,
        spmid: "main.ugc-video-detail.0.0".into(),
    }
    .encode_to_vec();
    let mut frame = vec![0];
    frame.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    frame.extend(bytes);
    frame
}

pub fn decode(
    bytes: &[u8],
    encoding: Option<&str>,
    status: Option<&str>,
) -> BiliResult<Vec<Track>> {
    let invalid = || BiliError::new("subtitle-protocol", "B 站字幕协议响应无效");
    if status.is_some_and(|s| s != "0") {
        return Err(BiliError::new("grpc-status", "B 站字幕接口返回 gRPC 错误"));
    }
    if bytes.len() > API_LIMIT || bytes.len() < 5 {
        return Err(invalid());
    }
    let mut cursor = 0;
    let mut message = None;
    let mut trailer_seen = false;
    while cursor < bytes.len() {
        let header = bytes.get(cursor..cursor + 5).ok_or_else(invalid)?;
        let length = u32::from_be_bytes(header[1..5].try_into().unwrap()) as usize;
        if length > API_LIMIT {
            return Err(invalid());
        }
        cursor += 5;
        let data = bytes
            .get(cursor..cursor.checked_add(length).ok_or_else(invalid)?)
            .ok_or_else(invalid)?;
        cursor += length;
        if header[0] == 0x80 {
            if trailer_seen {
                return Err(invalid());
            }
            trailer_seen = true;
            let trailers = std::str::from_utf8(data).map_err(|_| invalid())?;
            let statuses: Vec<_> = trailers
                .lines()
                .filter_map(|line| line.split_once(':'))
                .filter(|(key, _)| key.eq_ignore_ascii_case("grpc-status"))
                .map(|(_, value)| value.trim())
                .collect();
            if statuses.as_slice() != ["0"] {
                return Err(BiliError::new("grpc-status", "B 站字幕接口返回 gRPC 错误"));
            }
            continue;
        }
        if message.is_some() || trailer_seen {
            return Err(invalid());
        }
        let data = match header[0] {
            0 => data.to_vec(),
            1 if encoding == Some("gzip") => {
                let mut output = Vec::new();
                flate2::read::GzDecoder::new(data)
                    .take(API_LIMIT as u64 + 1)
                    .read_to_end(&mut output)
                    .map_err(|_| invalid())?;
                if output.len() > API_LIMIT {
                    return Err(BiliError::new(
                        "response-too-large",
                        "字幕解压后超过大小限制",
                    ));
                }
                output
            }
            _ => return Err(invalid()),
        };
        message = Some(DmViewReply::decode(data.as_slice()).map_err(|_| invalid())?);
    }
    let reply = message.ok_or_else(invalid)?;
    let subtitle = reply.subtitle.ok_or_else(|| {
        BiliError::new("subtitle-protocol", "字幕响应缺少状态，无法确认是否无字幕")
    })?;
    if subtitle
        .tracks
        .iter()
        .any(|t| t.lan.trim().is_empty() || t.url.trim().is_empty())
    {
        return Err(invalid());
    }
    Ok(subtitle.tracks)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn framed(body: &[u8], flag: u8) -> Vec<u8> {
        let mut b = vec![flag];
        b.extend((body.len() as u32).to_be_bytes());
        b.extend(body);
        b
    }
    #[test]
    fn rejects_truncation_missing_state_flags_and_bad_trailers() {
        for bytes in [
            vec![],
            vec![0; 4],
            vec![0, 0, 0, 0, 2, 0],
            framed(&[], 2),
            framed(&[], 0),
            framed(b"grpc-status: 7\r\n", 0x80),
        ] {
            assert!(decode(&bytes, None, None).is_err());
        }
        assert!(decode(&framed(&[0x1a, 0], 0), None, Some("7")).is_err());
        assert!(decode(&framed(&[0x1a, 0], 0), None, Some("0"))
            .unwrap()
            .is_empty());
    }
    #[test]
    fn parses_gzip_typed_tracks() {
        use std::io::Write;
        let reply = DmViewReply {
            subtitle: Some(Subtitle {
                tracks: vec![Track {
                    lan: "ai-zh".into(),
                    lan_doc: "AI".into(),
                    url: "https://aisubtitle.hdslb.com/a".into(),
                    ai_mark: 1,
                    ai_from: 0,
                    ai_type: 0,
                }],
            }),
        }
        .encode_to_vec();
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(&reply).unwrap();
        assert_eq!(
            decode(&framed(&gzip.finish().unwrap(), 1), Some("gzip"), None).unwrap()[0].lan,
            "ai-zh"
        );
    }
}
