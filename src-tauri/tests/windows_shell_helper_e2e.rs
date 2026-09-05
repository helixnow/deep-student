#![cfg(windows)]

use std::fs;
use std::process::Command;

use serde_json::json;
use uuid::Uuid;

const PAYLOAD_PREFIX: &str = "deep-student-shell-sandbox-";

fn powershell_literal(value: &str) -> String {
    value.replace('\'', "''")
}

fn payload(command: &str, cwd: &std::path::Path) -> serde_json::Value {
    json!({
        "command": command,
        "cwd": cwd,
        "policy": {
            "readable_roots": [cwd],
            "writable_roots": [cwd],
            "protected_read_roots": [],
            "protected_write_roots": [],
            "restrict_read_to_roots": false,
            "allow_network": false
        },
        "profile_name": format!("DeepStudent.DangerShell.{}", Uuid::new_v4().simple()),
        "prefer_git_bash": false,
        "shell_path": null
    })
}

#[test]
fn helper_consumes_only_fixed_root_payload_and_executes_with_rewritten_temp() {
    let command_root = tempfile::tempdir().expect("command root");
    let marker = command_root.path().join("helper-ran.txt");
    let command = format!(
        "Set-Content -LiteralPath '{}' -Value 'ok' -NoNewline",
        powershell_literal(&marker.to_string_lossy()),
    );
    let payload_root =
        deep_student_lib::chat_v2::tools::shell_sandbox::windows_shell_payload_root()
            .expect("fixed payload root");
    let helper_arg = deep_student_lib::chat_v2::tools::shell_sandbox::windows_shell_helper_arg();
    let payload_path =
        payload_root.join(format!("{PAYLOAD_PREFIX}{}.json", Uuid::new_v4().simple()));
    fs::write(
        &payload_path,
        serde_json::to_vec(&payload(&command, command_root.path())).expect("encode payload"),
    )
    .expect("write payload");

    let status = Command::new(env!("CARGO_BIN_EXE_deep-student"))
        .arg(helper_arg)
        .arg(&payload_path)
        .current_dir(command_root.path())
        .env("TEMP", command_root.path())
        .env("TMP", command_root.path())
        .status()
        .expect("run helper");

    assert!(status.success(), "helper exit status: {status}");
    assert_eq!(fs::read_to_string(&marker).expect("marker"), "ok");
    assert!(
        !payload_path.exists(),
        "payload must be consumed exactly once"
    );

    let unauthorized = command_root
        .path()
        .join(format!("{PAYLOAD_PREFIX}{}.json", Uuid::new_v4().simple()));
    fs::write(
        &unauthorized,
        serde_json::to_vec(&payload("Write-Output 'must not run'", command_root.path()))
            .expect("encode unauthorized payload"),
    )
    .expect("write unauthorized payload");
    let rejected = Command::new(env!("CARGO_BIN_EXE_deep-student"))
        .arg(helper_arg)
        .arg(&unauthorized)
        .current_dir(command_root.path())
        .status()
        .expect("run rejected helper");

    assert_eq!(rejected.code(), Some(126));
    assert!(
        unauthorized.exists(),
        "unauthorized files must not be consumed"
    );
}
