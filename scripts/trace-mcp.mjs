// 详细追踪MCP连接的每一步
import https from 'https';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

// 拦截https.request查看实际请求
const originalRequest = https.request;
https.request = function(options, callback) {
  console.log('\n[HTTPS Request]');
  console.log('Host:', options.hostname || options.host);
  console.log('Path:', options.path);
  console.log('Method:', options.method || 'GET');
  console.log('Headers:', options.headers);
  return originalRequest.call(this, options, callback);
};

// 详细监听EventSource
import { EventSource } from 'eventsource';
const OrigEventSource = EventSource;
global.EventSource = class extends OrigEventSource {
  constructor(url, config) {
    console.log('\n[EventSource Created]');
    console.log('URL:', url);
    console.log('Config:', config);
    super(url, config);
    
    const origAddEventListener = this.addEventListener;
    this.addEventListener = function(type, listener) {
      console.log(`[EventSource] Adding listener for: ${type}`);
      const wrapped = (event) => {
        if (type === 'endpoint') {
          console.log(`\n[EventSource] endpoint event data: "${event.data}"`);
        }
        return listener(event);
      };
      return origAddEventListener.call(this, type, wrapped);
    };
  }
};

async function main() {
  const sseUrl = "https://mcp.api-inference.modelscope.net/c1bef6c8cf2847/sse";
  console.log("=== Starting Trace ===");
  
  const client = new Client({ name: "trace-client", version: "1.0.0" });
  const transport = new SSEClientTransport(new URL(sseUrl));
  
  try {
    console.log("\nConnecting...");
    await client.connect(transport);
    console.log("✅ Connected!");
    
    console.log("\nListing tools...");
    const tools = await client.listTools();
    console.log(`✅ Got ${tools.tools.length} tools`);
    
    await client.close();
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
}

main();