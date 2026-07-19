//! Materialize binary MCP tool content into session-scoped task files.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::chat_v2::runtime_roots::normalize_runtime_relative_path;
use crate::chat_v2::task_objects::{
    ManagedLocator, ObjectCapabilities, ObjectProvenance, ProviderObjectRef, TaskObjectHandle,
    TaskObjectKind,
};

const MCP_SUBDIR: &str = "mcp";
const MAX_BINARY_ITEMS: usize = 16;
const MAX_ITEM_BYTES: usize = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;
const MAX_ENCODED_ITEM_BYTES: usize = ((MAX_ITEM_BYTES + 2) / 3) * 4;
const MAX_COLLISION_ATTEMPTS: u32 = 100;
const MAX_NAME_CHARS: usize = 96;

#[derive(Debug, Clone)]
pub struct McpOutputProvenance {
    pub provider: String,
    pub server: String,
    pub tool: String,
}

impl McpOutputProvenance {
    pub fn from_usage(tool: &str, usage: Option<&Value>) -> Self {
        let provider = usage
            .and_then(|value| value.get("provider"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("mcp")
            .to_string();
        let server = usage
            .and_then(|value| value.get("server_id").or_else(|| value.get("serverId")))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("unknown-server")
            .to_string();
        Self {
            provider,
            server,
            tool: tool.to_string(),
        }
    }
}

#[derive(Debug)]
struct MaterializedFile {
    relative_path: String,
    display_name: String,
    original_name: String,
    size_bytes: u64,
    sha256: String,
    mime_type: String,
    source_uri: String,
}

#[derive(Default)]
struct MaterializationBudget {
    items: usize,
    total_bytes: usize,
}

pub async fn materialize_mcp_tool_output(
    output: Value,
    artifact_root: PathBuf,
    provenance: McpOutputProvenance,
) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        materialize_mcp_tool_output_at_root(output, &artifact_root, &provenance)
    })
    .await
    .map_err(|error| format!("MCP materialization task failed: {}", error))?
}

fn materialize_mcp_tool_output_at_root(
    mut output: Value,
    artifact_root: &Path,
    provenance: &McpOutputProvenance,
) -> Result<Value, String> {
    let mut budget = MaterializationBudget::default();
    match &mut output {
        Value::Array(content) => {
            materialize_content_array(content, artifact_root, provenance, &mut budget)?;
        }
        Value::Object(object) => {
            if let Some(Value::Array(content)) = object.get_mut("content") {
                materialize_content_array(content, artifact_root, provenance, &mut budget)?;
            }
        }
        _ => {}
    }
    Ok(output)
}

fn materialize_content_array(
    content: &mut [Value],
    artifact_root: &Path,
    provenance: &McpOutputProvenance,
    budget: &mut MaterializationBudget,
) -> Result<(), String> {
    for (index, item) in content.iter_mut().enumerate() {
        let Some(object) = item.as_object_mut() else {
            continue;
        };
        match object.get("type").and_then(Value::as_str) {
            Some("image") => materialize_image(object, index, artifact_root, provenance, budget)?,
            Some("resource") => {
                materialize_resource(object, index, artifact_root, provenance, budget)?
            }
            _ => {}
        }
    }
    Ok(())
}

fn materialize_image(
    object: &mut Map<String, Value>,
    index: usize,
    artifact_root: &Path,
    provenance: &McpOutputProvenance,
    budget: &mut MaterializationBudget,
) -> Result<(), String> {
    let Some(encoded) = object.get("data").and_then(Value::as_str) else {
        return Ok(());
    };
    let declared_mime = mime_from_map(object).ok_or("MCP image content is missing mimeType")?;
    let source_uri = format!(
        "mcp://{}/{}/image/{}",
        sanitize_segment(&provenance.server),
        sanitize_segment(&provenance.tool),
        index + 1
    );
    let bytes = decode_bounded_base64(encoded, budget)?;
    let effective_mime = validate_mime(&declared_mime, &bytes, true)?;
    let requested_name = format!(
        "image-{}.{}",
        index + 1,
        extension_for_mime(&effective_mime)
    );
    let file = write_materialized_file(
        artifact_root,
        &requested_name,
        &source_uri,
        &effective_mime,
        &bytes,
        provenance,
    )?;
    object.remove("data");
    object.insert("mimeType".to_string(), json!(effective_mime));
    object.remove("mime_type");
    object.insert(
        "artifact".to_string(),
        artifact_metadata(&file, provenance)?,
    );
    object.insert("source".to_string(), source_metadata(&file, provenance));
    Ok(())
}

fn materialize_resource(
    object: &mut Map<String, Value>,
    index: usize,
    artifact_root: &Path,
    provenance: &McpOutputProvenance,
    budget: &mut MaterializationBudget,
) -> Result<(), String> {
    let Some(resource) = object.get_mut("resource").and_then(Value::as_object_mut) else {
        return Ok(());
    };
    let Some(encoded) = resource.get("blob").and_then(Value::as_str) else {
        return Ok(());
    };
    let source_uri = resource
        .get("uri")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "mcp://{}/{}/resource/{}",
                sanitize_segment(&provenance.server),
                sanitize_segment(&provenance.tool),
                index + 1
            )
        });
    let declared_mime =
        mime_from_map(resource).unwrap_or_else(|| "application/octet-stream".into());
    let bytes = decode_bounded_base64(encoded, budget)?;
    let effective_mime = validate_mime(&declared_mime, &bytes, false)?;
    let requested_name = name_from_source_uri(&source_uri).unwrap_or_else(|| {
        format!(
            "resource-{}.{}",
            index + 1,
            extension_for_mime(&effective_mime)
        )
    });
    let file = write_materialized_file(
        artifact_root,
        &requested_name,
        &source_uri,
        &effective_mime,
        &bytes,
        provenance,
    )?;
    resource.remove("blob");
    resource.insert("mimeType".to_string(), json!(effective_mime));
    resource.remove("mime_type");
    resource.insert(
        "artifact".to_string(),
        artifact_metadata(&file, provenance)?,
    );
    resource.insert("source".to_string(), source_metadata(&file, provenance));
    Ok(())
}

fn decode_bounded_base64(
    encoded: &str,
    budget: &mut MaterializationBudget,
) -> Result<Vec<u8>, String> {
    if budget.items >= MAX_BINARY_ITEMS {
        return Err(format!(
            "MCP result exceeds the {} binary item limit",
            MAX_BINARY_ITEMS
        ));
    }
    if encoded.len() > MAX_ENCODED_ITEM_BYTES {
        return Err(format!(
            "MCP binary item exceeds the {} MiB decoded-size limit",
            MAX_ITEM_BYTES / (1024 * 1024)
        ));
    }
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| "MCP binary item contains invalid base64".to_string())?;
    if bytes.len() > MAX_ITEM_BYTES {
        return Err(format!(
            "MCP binary item exceeds the {} MiB decoded-size limit",
            MAX_ITEM_BYTES / (1024 * 1024)
        ));
    }
    let new_total = budget
        .total_bytes
        .checked_add(bytes.len())
        .ok_or("MCP binary result size overflow")?;
    if new_total > MAX_TOTAL_BYTES {
        return Err(format!(
            "MCP binary result exceeds the {} MiB aggregate limit",
            MAX_TOTAL_BYTES / (1024 * 1024)
        ));
    }
    budget.items += 1;
    budget.total_bytes = new_total;
    Ok(bytes)
}

fn mime_from_map(object: &Map<String, Value>) -> Option<String> {
    object
        .get("mimeType")
        .or_else(|| object.get("mime_type"))
        .and_then(Value::as_str)
        .map(normalize_mime)
        .filter(|value| !value.is_empty())
}

fn normalize_mime(raw: &str) -> String {
    raw.split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn validate_mime(declared: &str, bytes: &[u8], require_image: bool) -> Result<String, String> {
    let declared = normalize_mime(declared);
    if declared.is_empty() || declared.bytes().any(|byte| byte.is_ascii_control()) {
        return Err("MCP binary item has an invalid MIME type".to_string());
    }
    let detected = detect_magic_mime(bytes);
    if matches!(detected, Some("application/x-executable")) {
        return Err("MCP binary item has an executable signature and was quarantined".to_string());
    }
    if require_image && !declared.starts_with("image/") {
        return Err(format!(
            "MCP image declared non-image MIME type '{}'",
            declared
        ));
    }
    if (require_image || declared.starts_with("image/"))
        && detected
            .map(|mime| !mime.starts_with("image/"))
            .unwrap_or(true)
    {
        return Err("MCP image bytes do not have a supported image signature".to_string());
    }

    if let Some(detected) = detected {
        let compatible = declared == detected
            || declared == "application/octet-stream"
            || (detected == "application/zip" && is_zip_container_mime(&declared));
        if !compatible {
            return Err(format!(
                "MCP binary MIME mismatch: declared '{}', detected '{}'",
                declared, detected
            ));
        }
        if declared == "application/octet-stream" {
            return Ok(detected.to_string());
        }
    }
    Ok(declared)
}

fn detect_magic_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"%PDF-") {
        Some("application/pdf")
    } else if bytes.starts_with(b"MZ")
        || bytes.starts_with(b"\x7fELF")
        || bytes.starts_with(&[0xfe, 0xed, 0xfa, 0xce])
        || bytes.starts_with(&[0xfe, 0xed, 0xfa, 0xcf])
        || bytes.starts_with(&[0xcf, 0xfa, 0xed, 0xfe])
    {
        Some("application/x-executable")
    } else if bytes.starts_with(b"PK\x03\x04")
        || bytes.starts_with(b"PK\x05\x06")
        || bytes.starts_with(b"PK\x07\x08")
    {
        Some("application/zip")
    } else {
        None
    }
}

fn is_zip_container_mime(mime: &str) -> bool {
    matches!(
        mime,
        "application/zip"
            | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            | "application/epub+zip"
    )
}

fn extension_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "application/pdf" => "pdf",
        "application/zip" => "zip",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "pptx",
        "application/epub+zip" => "epub",
        _ => "bin",
    }
}

fn name_from_source_uri(uri: &str) -> Option<String> {
    let without_fragment = uri.split('#').next().unwrap_or(uri);
    let without_query = without_fragment
        .split('?')
        .next()
        .unwrap_or(without_fragment);
    without_query
        .rsplit('/')
        .next()
        .filter(|name| !name.trim().is_empty())
        .map(sanitize_file_name)
}

fn sanitize_segment(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .take(48)
        .collect();
    let trimmed = cleaned.trim_matches('_');
    if trimmed.is_empty() {
        "unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

fn sanitize_file_name(raw: &str) -> String {
    let leaf = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let cleaned: String = leaf
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .take(MAX_NAME_CHARS)
        .collect();
    let trimmed = cleaned.trim_matches(['.', '_']);
    if trimmed.is_empty() {
        "resource.bin".to_string()
    } else {
        trimmed.to_string()
    }
}

fn write_materialized_file(
    artifact_root: &Path,
    requested_name: &str,
    source_uri: &str,
    mime_type: &str,
    bytes: &[u8],
    provenance: &McpOutputProvenance,
) -> Result<MaterializedFile, String> {
    fs::create_dir_all(artifact_root)
        .map_err(|error| format!("Failed to create MCP artifact root: {}", error))?;
    let root = artifact_root
        .canonicalize()
        .map_err(|error| format!("Failed to canonicalize MCP artifact root: {}", error))?;
    let relative_dir = PathBuf::from(MCP_SUBDIR)
        .join(sanitize_segment(&provenance.server))
        .join(sanitize_segment(&provenance.tool));
    let directory = ensure_safe_directory(&root, &relative_dir)?;
    let sha256 = hex::encode(Sha256::digest(bytes));
    let requested = sanitize_file_name(requested_name);
    let requested_path = Path::new(&requested);
    let stem = requested_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("resource");
    // The source URI is untrusted. Always derive the extension from the
    // validated media type so a PDF cannot be persisted as an executable.
    let ext = extension_for_mime(mime_type);
    let base_name = format!("{}-{}.{}", stem, &sha256[..12], ext);

    for attempt in 0..=MAX_COLLISION_ATTEMPTS {
        let file_name = if attempt == 0 {
            base_name.clone()
        } else {
            format!("{}-{}-{}.{}", stem, &sha256[..12], attempt, ext)
        };
        let target = directory.join(&file_name);
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Failed to create MCP artifact: {}", error)),
        };
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Failed to write MCP artifact: {}", error))?;
        let relative = relative_dir.join(&file_name);
        let relative_string = relative.to_string_lossy().replace('\\', "/");
        normalize_runtime_relative_path(Some(&relative_string))?;
        return Ok(MaterializedFile {
            relative_path: relative_string,
            display_name: file_name,
            original_name: requested,
            size_bytes: bytes.len() as u64,
            sha256,
            mime_type: mime_type.to_string(),
            source_uri: source_uri.to_string(),
        });
    }
    Err("MCP artifact filename collision limit exceeded".to_string())
}

fn ensure_safe_directory(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(segment) = component else {
            return Err("MCP artifact directory contains an unsafe path component".to_string());
        };
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err("MCP artifact directory must not contain symlinks".to_string());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|error| {
                    format!("Failed to create MCP artifact directory: {}", error)
                })?;
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect MCP artifact directory: {}",
                    error
                ))
            }
        }
    }
    let canonical = current
        .canonicalize()
        .map_err(|error| format!("Failed to canonicalize MCP artifact directory: {}", error))?;
    if !canonical.starts_with(root) {
        return Err("MCP artifact directory escapes the session root".to_string());
    }
    Ok(canonical)
}

fn artifact_metadata(
    file: &MaterializedFile,
    provenance: &McpOutputProvenance,
) -> Result<Value, String> {
    let mut handle = TaskObjectHandle::new(
        format!("mcp-artifact:{}", file.sha256),
        TaskObjectKind::Artifact,
        file.display_name.clone(),
        ObjectProvenance {
            source: provenance.provider.clone(),
            source_uri: Some(file.source_uri.clone()),
            server: Some(provenance.server.clone()),
            tool: Some(provenance.tool.clone()),
            derived_from: Vec::new(),
            observed_at: chrono::Utc::now().to_rfc3339(),
        },
    );
    handle.media_type = Some(file.mime_type.clone());
    handle.size_bytes = Some(file.size_bytes);
    handle.sha256 = Some(file.sha256.clone());
    handle.locator = Some(ManagedLocator::new(
        "artifacts",
        file.relative_path.clone(),
    )?);
    handle.provider_ref = Some(ProviderObjectRef {
        provider: provenance.provider.clone(),
        external_id: file.source_uri.clone(),
        container_id: Some(provenance.server.clone()),
        thread_id: None,
        version: None,
        etag: None,
    });
    handle.capabilities = ObjectCapabilities {
        readable: true,
        materializable: true,
        writable: false,
        shareable: false,
        sendable: false,
        deletable: true,
    };
    handle.validate()?;
    Ok(json!({
        "kind": "artifact",
        "root_id": "artifacts",
        "relative_path": file.relative_path,
        "sha256": file.sha256,
        "mime_type": file.mime_type,
        "size_bytes": file.size_bytes,
        "source_uri": file.source_uri,
        "original_name": file.original_name,
        "provider": provenance.provider,
        "server": provenance.server,
        "tool": provenance.tool,
        "object_handle": handle,
    }))
}

fn source_metadata(file: &MaterializedFile, provenance: &McpOutputProvenance) -> Value {
    json!({
        "kind": "source",
        "uri": file.source_uri,
        "mime_type": file.mime_type,
        "provider": provenance.provider,
        "server": provenance.server,
        "tool": provenance.tool,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provenance() -> McpOutputProvenance {
        McpOutputProvenance {
            provider: "mcp".into(),
            server: "server/../../unsafe".into(),
            tool: "render:image".into(),
        }
    }

    fn png(seed: u8) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend([seed; 8]);
        bytes
    }

    #[test]
    fn preserves_text_and_materializes_image_with_object_handle() {
        let root = tempfile::tempdir().unwrap();
        let output = json!([
            {"type": "text", "text": "unchanged"},
            {"type": "image", "data": BASE64.encode(png(1)), "mimeType": "image/png"}
        ]);
        let result =
            materialize_mcp_tool_output_at_root(output, root.path(), &provenance()).unwrap();
        assert_eq!(result[0], json!({"type": "text", "text": "unchanged"}));
        assert!(result[1].get("data").is_none());
        let artifact = &result[1]["artifact"];
        assert_eq!(artifact["root_id"], "artifacts");
        assert_eq!(artifact["mime_type"], "image/png");
        assert_eq!(artifact["object_handle"]["locator"]["rootId"], "artifacts");
        let path = root
            .path()
            .join(artifact["relative_path"].as_str().unwrap());
        assert_eq!(fs::read(path).unwrap(), png(1));
    }

    #[test]
    fn resource_blob_preserves_uri_and_sanitizes_filename() {
        let root = tempfile::tempdir().unwrap();
        let uri = "https://example.test/../../report.pdf?token=secret";
        let output = json!([{"type":"resource","resource":{
            "uri": uri, "mimeType":"application/pdf", "blob":BASE64.encode(b"%PDF-1.7\nbody")
        }}]);
        let result =
            materialize_mcp_tool_output_at_root(output, root.path(), &provenance()).unwrap();
        let resource = &result[0]["resource"];
        assert!(resource.get("blob").is_none());
        assert_eq!(resource["artifact"]["source_uri"], uri);
        let relative = resource["artifact"]["relative_path"].as_str().unwrap();
        assert!(relative.starts_with("mcp/"));
        assert!(!relative.contains("../"));
    }

    #[test]
    fn secx_04_rejects_invalid_base64_mime_mismatch_and_disguised_executable() {
        let root = tempfile::tempdir().unwrap();
        let invalid = json!([{"type":"image","mimeType":"image/png","data":"%%%"}]);
        assert!(
            materialize_mcp_tool_output_at_root(invalid, root.path(), &provenance())
                .unwrap_err()
                .contains("invalid base64")
        );
        let mismatch =
            json!([{"type":"image","mimeType":"image/jpeg","data":BASE64.encode(png(2))}]);
        assert!(
            materialize_mcp_tool_output_at_root(mismatch, root.path(), &provenance())
                .unwrap_err()
                .contains("MIME mismatch")
        );
        let executable = json!([{"type":"resource","resource":{
            "uri":"mcp://server/photo.png", "mimeType":"image/png",
            "blob":BASE64.encode(b"MZfake executable")
        }}]);
        let error = materialize_mcp_tool_output_at_root(executable, root.path(), &provenance())
            .unwrap_err();
        assert!(error.contains("executable signature"));
        assert!(fs::read_dir(root.path()).unwrap().next().is_none());
    }

    #[test]
    fn rejects_oversize_before_decode() {
        let mut budget = MaterializationBudget::default();
        let encoded = "A".repeat(MAX_ENCODED_ITEM_BYTES + 1);
        assert!(decode_bounded_base64(&encoded, &mut budget)
            .unwrap_err()
            .contains("decoded-size limit"));
        assert_eq!(budget.total_bytes, 0);
    }

    #[test]
    fn collision_does_not_overwrite_existing_file() {
        let root = tempfile::tempdir().unwrap();
        let first = write_materialized_file(
            root.path(),
            "same.png",
            "mcp://one",
            "image/png",
            &png(3),
            &provenance(),
        )
        .unwrap();
        let second = write_materialized_file(
            root.path(),
            "same.png",
            "mcp://two",
            "image/png",
            &png(3),
            &provenance(),
        )
        .unwrap();
        assert_ne!(first.relative_path, second.relative_path);
        assert_eq!(
            fs::read(root.path().join(first.relative_path)).unwrap(),
            png(3)
        );
        assert_eq!(
            fs::read(root.path().join(second.relative_path)).unwrap(),
            png(3)
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_materialization_parent() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), root.path().join(MCP_SUBDIR)).unwrap();
        let output = json!([{"type":"image","mimeType":"image/png","data":BASE64.encode(png(4))}]);
        assert!(
            materialize_mcp_tool_output_at_root(output, root.path(), &provenance())
                .unwrap_err()
                .contains("symlinks")
        );
    }
}
