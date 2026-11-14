#!/usr/bin/env node
// Minimal stdio MCP server used by the MCPBench dataset test.
// Speaks JSON-RPC 2.0 over JSONL and runs the WAVE0 `success` script, whose
// `web_search` tool returns the canned MCPBench answers. This is a real child
// process, not a client stub. Tool set and replies: ../../equivalence/protocol.ts.

import { runStdioServer } from '../../equivalence/stdio-server.ts';

runStdioServer('success', { logFile: null });
