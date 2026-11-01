//! GStreamer cannot load a WebKit custom URI scheme. Serve the same pinned
//! playback session over loopback HTTP, joining bounded CDN reads into a stream.

use std::convert::Infallible;
use std::io;

use hyper::{Body, Request, Response, StatusCode};
use tauri::AppHandle;

use super::{
    attempt_cache_key, handle, parse_content_range, parse_stream_path, parse_stream_query,
};

const BASE: &str = "/deepstudent-bili-stream/v1/";
static PORT: tokio::sync::Mutex<Option<u16>> = tokio::sync::Mutex::const_new(None);
static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);

pub(super) async fn stream_url(
    app: &AppHandle,
    file_id: &str,
    qn: u32,
    epoch: u32,
    attempt: u32,
) -> Result<String, String> {
    let session = super::playback_session(app, &attempt_cache_key(file_id, qn, epoch, attempt))
        .map_err(|error| error.to_string())?;
    let port = start(app).await?;
    Ok(format!(
        "http://127.0.0.1:{port}{BASE}{file_id}?qn={qn}&e={epoch}&a={attempt}&s={}",
        session.token
    ))
}

async fn start(app: &AppHandle) -> Result<u16, String> {
    let mut port = PORT.lock().await;
    if let Some(port) = *port {
        return Ok(port);
    }
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .map_err(|_| "无法启动本地视频服务")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "无法配置本地视频服务")?;
    let number = listener
        .local_addr()
        .map_err(|_| "无法读取本地视频端口")?
        .port();
    let app = app.clone();
    let make = hyper::service::make_service_fn(move |_| {
        let app = app.clone();
        async move {
            Ok::<_, Infallible>(hyper::service::service_fn(move |request| {
                let app = app.clone();
                async move { Ok::<_, Infallible>(serve(&app, request, number).await) }
            }))
        }
    });
    let server = hyper::Server::from_tcp(listener)
        .map_err(|_| "无法启动本地视频服务")?
        .serve(make);
    tauri::async_runtime::spawn(async move {
        if server.await.is_err() {
            *PORT.lock().await = None;
            log::warn!("[media::bilibili_stream] loopback server stopped");
        }
    });
    *port = Some(number);
    Ok(number)
}

fn allowed_origin(origin: &str) -> bool {
    matches!(
        origin,
        "tauri://localhost" | "http://127.0.0.1:1422" | "http://localhost:1422"
    )
}

fn local_request(request: &Request<Body>, port: u16) -> bool {
    request
        .headers()
        .get("host")
        .and_then(|value| value.to_str().ok())
        == Some(format!("127.0.0.1:{port}").as_str())
        && request
            .headers()
            .get("origin")
            .is_none_or(|value| value.to_str().is_ok_and(allowed_origin))
}

fn error(status: StatusCode) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("cache-control", "no-store")
        .body(Body::empty())
        .unwrap()
}

fn internal_request(
    method: &str,
    uri: &str,
    origin: &str,
    range: Option<&str>,
) -> tauri::http::Request<Vec<u8>> {
    let mut builder = tauri::http::Request::builder()
        .method(method)
        .uri(uri)
        .header("origin", origin);
    if let Some(range) = range {
        builder = builder.header("range", range);
    }
    builder.body(Vec::new()).unwrap()
}

fn range_bounds(value: Option<&str>, total: u64) -> Option<(u64, u64)> {
    let last = total.checked_sub(1)?;
    let Some(value) = value else {
        return Some((0, last));
    };
    let (first, end) = value.trim().strip_prefix("bytes=")?.split_once('-')?;
    if first.is_empty() {
        let suffix = end.parse::<u64>().ok()?.min(total);
        return (suffix > 0).then_some((total - suffix, last));
    }
    let first = first.parse::<u64>().ok()?;
    let end = if end.is_empty() {
        last
    } else {
        end.parse::<u64>().ok()?.min(last)
    };
    (first <= end).then_some((first, end))
}

async fn serve(app: &AppHandle, request: Request<Body>, port: u16) -> Response<Body> {
    if !local_request(&request, port) {
        return error(StatusCode::FORBIDDEN);
    }
    if !matches!(request.method().as_str(), "GET" | "HEAD" | "OPTIONS") {
        return error(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Some(path) = request.uri().path().strip_prefix(BASE) else {
        return error(StatusCode::NOT_FOUND);
    };
    let Some(file_id) = parse_stream_path(path).filter(|id| id == path) else {
        return error(StatusCode::NOT_FOUND);
    };
    let query = request.uri().query();
    let (qn, epoch) = parse_stream_query(query);
    let attempt = super::query_u32(query, "a").unwrap_or(0);
    let token = url::form_urlencoded::parse(query.unwrap_or("").as_bytes())
        .find(|(name, _)| name == "s")
        .map(|(_, value)| value.into_owned());
    let key = attempt_cache_key(&file_id, qn, epoch, attempt);
    let authorized = super::PLAY_SESSIONS
        .lock()
        .unwrap()
        .get(&key)
        .is_some_and(|session| {
            token.as_ref() == Some(&session.token)
                && session.attempt.valid()
                && session.last_used.elapsed() < super::PLAY_SOURCE_TTL
        });
    if !authorized {
        return error(StatusCode::FORBIDDEN);
    }
    let Ok(slot) = SLOTS.try_acquire() else {
        return error(StatusCode::TOO_MANY_REQUESTS);
    };
    let origin = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("tauri://localhost")
        .to_string();
    // Keep the loopback capability out of internal requests and diagnostics.
    let uri = format!("bilistream://localhost/{file_id}?qn={qn}&e={epoch}&a={attempt}");
    if request.method() == hyper::Method::OPTIONS {
        let result = handle(app, internal_request("OPTIONS", &uri, &origin, None)).await;
        return convert(result);
    }
    if request.method() == hyper::Method::HEAD {
        let result = handle(app, internal_request("HEAD", &uri, &origin, None)).await;
        return convert(result);
    }
    let range = request
        .headers()
        .get("range")
        .and_then(|value| value.to_str().ok());
    let mut total = super::cached_source(&key).and_then(|info| info.size);
    if total.is_none() {
        let head = handle(app, internal_request("HEAD", &uri, &origin, None)).await;
        if !head.status().is_success() {
            return convert(head);
        }
        total = head
            .headers()
            .get("content-length")
            .and_then(|value| value.to_str().ok()?.parse::<u64>().ok());
    }
    let Some(total) = total else {
        return error(StatusCode::BAD_GATEWAY);
    };
    let Some((first, end)) = range_bounds(range, total) else {
        return Response::builder()
            .status(416)
            .header("content-range", format!("bytes */{total}"))
            .header("access-control-allow-origin", &origin)
            .body(Body::empty())
            .unwrap();
    };
    let initial = handle(
        app,
        internal_request("GET", &uri, &origin, Some(&format!("bytes={first}-{end}"))),
    )
    .await;
    if !initial.status().is_success() {
        return convert(initial);
    }
    let initial_range = initial
        .headers()
        .get("content-range")
        .and_then(|value| value.to_str().ok())
        .and_then(parse_content_range);
    let Some((actual, last, actual_total)) = initial_range else {
        return error(StatusCode::BAD_GATEWAY);
    };
    if actual != first || actual_total != total {
        return error(StatusCode::BAD_GATEWAY);
    }
    let mut response = Response::builder()
        .status(if range.is_some() { 206 } else { 200 })
        .header("content-type", "video/mp4")
        .header("content-length", end - first + 1)
        .header("accept-ranges", "bytes")
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .header("access-control-allow-origin", &origin)
        .header(
            "access-control-expose-headers",
            "Content-Range, Content-Length, Accept-Ranges",
        )
        .header("vary", "Origin");
    if range.is_some() {
        response = response.header("content-range", format!("bytes {first}-{end}/{total}"));
    }
    let state = (
        app.clone(),
        uri,
        origin,
        last + 1,
        end,
        total,
        Some(initial.into_body()),
        slot,
    );
    let stream = futures_util::stream::try_unfold(
        state,
        |(app, uri, origin, next, end, total, first, slot)| async move {
            if let Some(bytes) = first {
                return Ok(Some((
                    bytes,
                    (app, uri, origin, next, end, total, None, slot),
                )));
            }
            if next > end {
                return Ok(None);
            }
            let result = handle(
                &app,
                internal_request("GET", &uri, &origin, Some(&format!("bytes={next}-{end}"))),
            )
            .await;
            let range = result
                .headers()
                .get("content-range")
                .and_then(|value| value.to_str().ok())
                .and_then(parse_content_range);
            match range {
                Some((start, last, size))
                    if result.status().is_success()
                        && start == next
                        && size == total
                        && last <= end =>
                {
                    Ok(Some((
                        result.into_body(),
                        (app, uri, origin, last + 1, end, total, None, slot),
                    )))
                }
                _ => Err(io::Error::other("Bilibili stream interrupted")),
            }
        },
    );
    response.body(Body::wrap_stream(stream)).unwrap()
}

fn convert(result: tauri::http::Response<Vec<u8>>) -> Response<Body> {
    let mut response = Response::builder().status(result.status().as_u16());
    for (name, value) in result.headers() {
        response = response.header(name.as_str(), value.as_bytes());
    }
    response.body(Body::from(result.into_body())).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_ranges_cover_the_requested_extent_instead_of_one_cdn_chunk() {
        assert_eq!(range_bounds(None, 10_000_000), Some((0, 9_999_999)));
        assert_eq!(
            range_bounds(Some("bytes=0-"), 10_000_000),
            Some((0, 9_999_999))
        );
        assert_eq!(
            range_bounds(Some("bytes=100-8000000"), 10_000_000),
            Some((100, 8_000_000))
        );
        assert_eq!(
            range_bounds(Some("bytes=-100"), 10_000_000),
            Some((9_999_900, 9_999_999))
        );
        assert_eq!(
            range_bounds(Some("bytes=0-1445"), 10_000_000),
            Some((0, 1445))
        );
        for value in ["bytes=10-1", "bytes=-0", "bytes=10000000-", "bytes=0-1,4-5"] {
            assert_eq!(range_bounds(Some(value), 10_000_000), None, "{value}");
        }
    }

    #[test]
    fn loopback_rejects_foreign_hosts_and_web_origins() {
        let request = |host, origin| {
            Request::builder()
                .header("host", host)
                .header("origin", origin)
                .body(Body::empty())
                .unwrap()
        };
        assert!(local_request(
            &request("127.0.0.1:42", "tauri://localhost"),
            42
        ));
        assert!(!local_request(
            &request("localhost:42", "tauri://localhost"),
            42
        ));
        assert!(!local_request(
            &request("127.0.0.1:43", "tauri://localhost"),
            42
        ));
        assert!(!local_request(
            &request("127.0.0.1:42", "https://evil.test"),
            42
        ));
    }
}
