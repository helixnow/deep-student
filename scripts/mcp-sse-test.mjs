// 使用 @modelcontextprotocol/sdk 连接 SSE 类型的 MCP 服务器并做简单自检
// 运行前请确保已安装依赖：
//   npm i -D @modelcontextprotocol/sdk
// 用法：
//   node ./scripts/mcp-sse-test.mjs [SSE_URL]
// 或设置环境变量：
//   MCP_SSE_URL=... node ./scripts/mcp-sse-test.mjs

const DEFAULT_CONFIG = {
  mcpServers: {
    fetch: {
      type: "sse",
      url: "https://mcp.api-inference.modelscope.net/c1bef6c8cf2847/sse",
    },
  },
};

const urlFromArg = process.argv[2];
const urlFromEnv = process.env.MCP_SSE_URL;
const sseUrl = urlFromArg || urlFromEnv || DEFAULT_CONFIG.mcpServers.fetch.url;

async function main() {
  let Client, SSEClientTransport;
  try {
    // 导入高级 Client 与 SSE 传输实现
    ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js"));
  } catch (err) {
    console.error("未找到 @modelcontextprotocol/sdk，请先安装依赖：");
    console.error("  npm i -D @modelcontextprotocol/sdk\n");
    throw err;
  }

  console.log("目标 SSE MCP 服务器:", sseUrl);

  const client = new Client({ name: "dstu-mcp-test", version: "0.0.1" });
  const transport = new SSEClientTransport(new URL(sseUrl));

  const timeout = setTimeout(() => {
    console.error("连接/请求超时(15s)");
    try { client.close?.(); } catch {}
    process.exit(1);
  }, 15_000);

  try {
    await client.connect(transport);
    console.log("✅ 已连接到 MCP 服务器");

    // 优先尝试 SDK 的便捷方法；若不可用，回退到通用 JSON-RPC 请求
    let tools;
    try {
      if (typeof client.listTools === "function") {
        tools = await client.listTools();
      } else if (typeof client.request === "function") {
        tools = await client.request({ method: "tools/list", params: {} });
      }
    } catch (e) {
      console.warn("获取 tools 失败(可能未实现):", e?.message || e);
    }

    if (tools) {
      console.log("🧰 工具列表:");
      console.log(JSON.stringify(tools, null, 2));
    }

    // 尝试获取 prompts（若服务器实现该能力）
    try {
      let prompts;
      if (typeof client.listPrompts === "function") {
        prompts = await client.listPrompts();
      } else if (typeof client.request === "function") {
        prompts = await client.request({ method: "prompts/list", params: {} });
      }
      if (prompts) {
        console.log("📝 Prompts 列表:");
        console.log(JSON.stringify(prompts, null, 2));
      }
    } catch (e) {
      console.warn("获取 prompts 失败(可能未实现):", e?.message || e);
    }

    // 尝试获取 resources（若服务器实现该能力）
    try {
      let resources;
      if (typeof client.listResources === "function") {
        resources = await client.listResources();
      } else if (typeof client.request === "function") {
        resources = await client.request({ method: "resources/list", params: {} });
      }
      if (resources) {
        console.log("📦 Resources 列表:");
        console.log(JSON.stringify(resources, null, 2));
        const first = resources.resources?.[0] || resources[0];
        if (first?.uri || first?.id) {
          const uri = first.uri || first.id;
          try {
            let content;
            if (typeof client.readResource === "function") {
              content = await client.readResource(uri);
            } else if (typeof client.request === "function") {
              content = await client.request({ method: "resources/read", params: { uri } });
            }
            if (content) {
              console.log("📄 读取首个资源:", uri);
              console.log(JSON.stringify({
                mimeType: content.mimeType || content.mime_type,
                textLen: content.text?.length,
                base64Len: content.base64?.length,
              }, null, 2));
            }
          } catch (e) {
            console.warn("读取资源失败:", e?.message || e);
          }
        }
      }
    } catch (e) {
      console.warn("获取 resources 失败(可能未实现):", e?.message || e);
    }

    await client.close();
    console.log("🔚 已关闭连接");
  } catch (err) {
    console.error("❌ 测试失败:", err?.message || err);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
}

main();
