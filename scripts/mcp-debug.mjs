// 调试MCP连接，查看实际的请求流程
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const sseUrl = "https://mcp.api-inference.modelscope.net/c1bef6c8cf2847/sse";

// 创建一个包装fetch来记录所有请求
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  console.log("\n[FETCH REQUEST]");
  console.log("URL:", input);
  console.log("Method:", init?.method || "GET");
  console.log("Headers:", init?.headers);
  if (init?.body) {
    console.log("Body:", typeof init.body === 'string' ? init.body : '[Stream/Buffer]');
  }
  
  const response = await originalFetch(input, init);
  console.log("[FETCH RESPONSE]");
  console.log("Status:", response.status);
  console.log("Headers:", Object.fromEntries(response.headers.entries()));
  
  // 为了调试，我们需要克隆response
  const cloned = response.clone();
  try {
    const text = await cloned.text();
    if (text) {
      console.log("Body preview:", text.substring(0, 200));
    }
  } catch {}
  
  return response;
};

async function main() {
  console.log("=== Starting MCP Debug ===");
  console.log("SSE URL:", sseUrl);
  
  const client = new Client({ name: "debug-client", version: "1.0.0" });
  const transport = new SSEClientTransport(new URL(sseUrl));
  
  // 拦截transport的内部方法看看它如何处理endpoint
  const originalFetch = transport._fetch || transport.fetch;
  if (originalFetch) {
    transport._fetch = transport.fetch = function(...args) {
      console.log("\n[SSEClientTransport fetch called]");
      console.log("Args:", args);
      return originalFetch.apply(this, args);
    };
  }
  
  try {
    console.log("\n=== Connecting to MCP server ===");
    await client.connect(transport);
    console.log("✅ Connected successfully!");
    
    console.log("\n=== Listing tools ===");
    const tools = await client.listTools();
    console.log("Tools count:", tools.tools.length);
    console.log("First tool:", tools.tools[0]?.name);
    
    await client.close();
    console.log("\n=== Connection closed ===");
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

main();