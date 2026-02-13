import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

// 拦截transport的send方法
async function test() {
  const client = new Client({ name: "trace", version: "1.0.0" });
  const transport = new SSEClientTransport(
    new URL("https://mcp.api-inference.modelscope.net/c1bef6c8cf2847/sse")
  );
  
  // Hook into transport's send
  const originalStart = transport.start.bind(transport);
  transport.start = async function() {
    console.log('[Transport] Starting...');
    const result = await originalStart();
    
    // Hook send after start
    if (this.send) {
      const originalSend = this.send.bind(this);
      this.send = function(message) {
        console.log('[Transport] Sending:', JSON.stringify(message, null, 2));
        return originalSend(message);
      };
    }
    
    return result;
  };
  
  // Hook onmessage
  const originalOnMessage = transport.onmessage;
  transport.onmessage = function(message, extra) {
    console.log('[Transport] Received:', JSON.stringify(message, null, 2));
    if (originalOnMessage) originalOnMessage.call(this, message, extra);
  };
  
  console.log('=== Connecting ===');
  await client.connect(transport);
  console.log('=== Connected ===');
  
  console.log('\n=== Listing tools ===');
  const tools = await client.listTools();
  console.log('Tools count:', tools.tools.length);
  
  await client.close();
}

test().catch(console.error);