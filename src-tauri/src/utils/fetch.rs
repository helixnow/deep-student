use reqwest::blocking::Client;
use std::collections::HashMap;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::time::Duration;

static CACHE: LazyLock<Mutex<HashMap<String, (Vec<u8>, Option<String>)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn fetch_binary_with_cache(url: &str) -> Option<(Vec<u8>, Option<String>)> {
    if let Some((bytes, mime)) = CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(url)
        .cloned()
    {
        return Some((bytes, mime));
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;

    let response = client.get(url).send().ok()?;
    if !response.status().is_success() {
        return None;
    }

    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let bytes = response.bytes().ok()?.to_vec();
    CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(url.to_string(), (bytes.clone(), mime.clone()));

    Some((bytes, mime))
}
