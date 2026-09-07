//! MCP stdio 探针：复用 deep-student 真实 spawn/握手代码路径，定位 propose 连测失败根因。
//! 阶段 1：transport 层原始收发（观察 server 返回的原始字节）。
//! 阶段 2：McpClient::connect + initialize（复现 "Initialize failed"）。

use deep_student_lib::mcp::client::{
    ClientCapabilities, ClientInfo, DefaultNotificationHandler, McpClient, RootsCapability,
    SamplingCapability,
};
use deep_student_lib::mcp::global::create_stdio_transport;
use deep_student_lib::mcp::transport::Transport;
use deep_student_lib::mcp::McpFraming;
use std::collections::HashMap;
use std::time::Duration;

const CMD: &str = r"C:\Users\Administrator\.playwright-mcp\start-mcp.cmd";

#[tokio::main]
async fn main() {
    println!("=== STAGE 1: raw transport probe ===");
    let empty_args: Vec<String> = Vec::new();
    let empty_env: HashMap<String, String> = HashMap::new();
    let t1 = create_stdio_transport(CMD, &empty_args, &McpFraming::JsonLines, &empty_env, None)
        .await
        .expect("stage1 spawn failed");
    let t1: Box<dyn Transport> = Box::new(t1);

    // 与 mcp_propose_executor::gather_probe 完全一致的 initialize 请求
    let req = r#"{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"roots":{"listChanged":true},"sampling":{"enabled":true}},"clientInfo":{"name":"dstu-mcp-tester-stdio","version":"0.9.53"}},"id":"550e8400-e29b-41d4-a716-446655440000"}"#;
    match t1.send(req).await {
        Ok(()) => println!("SEND ok"),
        Err(e) => println!("SEND ERR: {:?}", e),
    }

    for i in 0..5 {
        match tokio::time::timeout(Duration::from_secs(8), t1.receive()).await {
            Ok(Ok(msg)) => println!("RECV[{}]: {}", i, msg),
            Ok(Err(e)) => {
                println!("RECV[{}] ERR: {:?}", i, e);
                break;
            }
            Err(_) => {
                println!("RECV[{}] timeout (8s)", i);
                break;
            }
        }
    }
    let _ = t1.close().await;

    println!("=== STAGE 2: McpClient probe (real gather_probe path) ===");
    let t2 = create_stdio_transport(CMD, &empty_args, &McpFraming::JsonLines, &empty_env, None)
        .await
        .expect("stage2 spawn failed");
    let client_info = ClientInfo {
        name: "dstu-mcp-tester-stdio".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        protocol_version: "2025-06-18".to_string(),
        capabilities: ClientCapabilities {
            roots: Some(RootsCapability {
                list_changed: Some(true),
            }),
            sampling: Some(SamplingCapability { enabled: true }),
            experimental: None,
        },
    };
    let client = McpClient::with_options(
        Box::new(t2),
        client_info,
        Box::new(DefaultNotificationHandler),
        Duration::from_secs(60),
        128,
        Duration::from_secs(300),
        16,
    );
    match client.connect().await {
        Ok(()) => println!("CONNECT ok"),
        Err(e) => println!("CONNECT ERR: {:?}", e),
    }
    match client.initialize().await {
        Ok(info) => println!(
            "INIT OK: name={} version={} proto={}",
            info.name, info.version, info.protocol_version
        ),
        Err(e) => println!("INIT ERR: {:?}", e),
    }
    let _ = client.disconnect().await;

    println!("=== STAGE 3: wire round-trip with real JsonRpcRequest/Response types ===");
    let t3 = create_stdio_transport(CMD, &empty_args, &McpFraming::JsonLines, &empty_env, None)
        .await
        .expect("stage3 spawn failed");
    let t3: Box<dyn Transport> = Box::new(t3);
    let id = uuid::Uuid::new_v4().to_string();
    let request = deep_student_lib::mcp::client::JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        method: "initialize".to_string(),
        params: Some(serde_json::json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {
                "roots": {"listChanged": true},
                "sampling": {"enabled": true}
            },
            "clientInfo": {"name": "dstu-mcp-tester-stdio", "version": "0.9.53"}
        })),
        id: Some(serde_json::Value::String(id.clone())),
    };
    let wire = serde_json::to_string(&request).expect("serialize request failed");
    println!("WIRE: {}", wire);
    t3.send(&wire).await.expect("stage3 send failed");
    match tokio::time::timeout(Duration::from_secs(8), t3.receive()).await {
        Ok(Ok(m)) => {
            println!("RAW: {}", m);
            match serde_json::from_str::<deep_student_lib::mcp::client::JsonRpcResponse>(&m) {
                Ok(r) => println!(
                    "PARSED ok: id={:?} result_some={} error={:?}",
                    r.id,
                    r.result.is_some(),
                    r.error
                ),
                Err(e) => println!("PARSE ERR: {}", e),
            }
        }
        Ok(Err(e)) => println!("RECV ERR: {:?}", e),
        Err(_) => println!("RECV timeout"),
    }
    let _ = t3.close().await;

    println!("=== STAGE 4: extended-length (\\\\?\\) command path ===");
    // 复现安装版 22:06 失败：\\?\ 前缀 cmd 批处理静默不执行 → 请求超时。
    // normalize_command_path 修复后应与 STAGE 1 等价。
    let t4 = create_stdio_transport(
        &format!(r"\\?\{}", CMD),
        &empty_args,
        &McpFraming::JsonLines,
        &empty_env,
        None,
    )
    .await
    .expect("stage4 spawn failed");
    let t4: Box<dyn Transport> = Box::new(t4);
    let req4 = r#"{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"roots":{"listChanged":true},"sampling":{"enabled":true}},"clientInfo":{"name":"probe","version":"0.9.53"}},"id":"extlen-0001"}"#;
    t4.send(req4).await.expect("stage4 send failed");
    match tokio::time::timeout(Duration::from_secs(8), t4.receive()).await {
        Ok(Ok(m)) => println!(
            "STAGE4 RECV ok (has_result={}): {}",
            m.contains("\"result\""),
            &m.chars().take(120).collect::<String>()
        ),
        Ok(Err(e)) => println!("STAGE4 RECV ERR: {:?}", e),
        Err(_) => println!("STAGE4 RECV timeout (8s)"),
    }
    let _ = t4.close().await;
    println!("=== PROBE DONE ===");
}
