// 使用 @modelcontextprotocol/sdk 连接 WebSocket 类型的 MCP 服务器并做自检
// 前置：npm i -D @modelcontextprotocol/sdk
// 用法：
//   node ./scripts/mcp-ws-test.mjs ws://localhost:8000
//   或 MCP_WS_URL=ws://... node ./scripts/mcp-ws-test.mjs

const urlFromArg = process.argv[2];
const urlFromEnv = process.env.MCP_WS_URL;
const wsUrl = urlFromArg || urlFromEnv || 'ws://localhost:8000';

async function main() {
  let Client, WebSocketClientTransport;
  try {
    ({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
    ({ WebSocketClientTransport } = await import('@modelcontextprotocol/sdk/client/websocket.js'));
  } catch (err) {
    console.error('未找到 @modelcontextprotocol/sdk，请先安装依赖：');
    console.error('  npm i -D @modelcontextprotocol/sdk\n');
    throw err;
  }

  console.log('目标 WS MCP 服务器:', wsUrl);
  const client = new Client({ name: 'dstu-mcp-ws-test', version: '0.0.1' });
  const transport = new WebSocketClientTransport(new URL(wsUrl));

  const timeout = setTimeout(() => {
    console.error('连接/请求超时(15s)');
    try { client.close?.(); } catch {}
    process.exit(1);
  }, 15_000);

  try {
    await client.connect(transport);
    console.log('✅ 已连接');

    // tools/list
    let tools;
    try {
      tools = typeof client.listTools === 'function'
        ? await client.listTools()
        : await client.request({ method: 'tools/list', params: {} });
      console.log('🧰 工具列表:');
      console.log(JSON.stringify(tools, null, 2));
    } catch (e) { console.warn('获取 tools 失败:', e?.message || e); }

    // prompts/list
    try {
      const prompts = typeof client.listPrompts === 'function'
        ? await client.listPrompts()
        : await client.request({ method: 'prompts/list', params: {} });
      if (prompts) {
        console.log('📝 Prompts 列表:');
        console.log(JSON.stringify(prompts, null, 2));
      }
    } catch (e) { console.warn('获取 prompts 失败:', e?.message || e); }

    // resources/list + read
    try {
      const resources = typeof client.listResources === 'function'
        ? await client.listResources()
        : await client.request({ method: 'resources/list', params: {} });
      if (resources) {
        console.log('📦 Resources 列表:');
        console.log(JSON.stringify(resources, null, 2));
        const first = resources.resources?.[0] || resources[0];
        if (first?.uri || first?.id) {
          const uri = first.uri || first.id;
          try {
            const content = typeof client.readResource === 'function'
              ? await client.readResource(uri)
              : await client.request({ method: 'resources/read', params: { uri } });
            console.log('📄 读取首个资源:', JSON.stringify({
              uri,
              mimeType: content?.mimeType || content?.mime_type,
              textLen: content?.text?.length,
              base64Len: content?.base64?.length,
            }, null, 2));
          } catch (e) { console.warn('读取资源失败:', e?.message || e); }
        }
      }
    } catch (e) { console.warn('获取 resources 失败:', e?.message || e); }

    await client.close();
    console.log('🔚 连接已关闭');
  } catch (err) {
    console.error('❌ 测试失败:', err?.message || err);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
}

main();

