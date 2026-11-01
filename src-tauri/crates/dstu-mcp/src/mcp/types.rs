// MCP 类型重新导出
// 从 client 模块导出常用类型，便于外部使用

pub use super::client::{
    ClientCapabilities,

    ClientInfo,
    // 内容类型
    Content,

    CreateMessageRequest,
    CreateMessageResult,

    JsonRpcError,
    JsonRpcNotification,

    // 基础协议类型
    JsonRpcRequest,
    JsonRpcResponse,
    LogEntry,

    // 日志相关
    LogLevel,
    // 错误和结果类型
    McpError,
    // 事件类型
    McpEvent,
    McpResult,

    // 提示相关
    Prompt,
    PromptArgument,
    PromptMessage,

    // 资源相关
    Resource,
    ResourceContent,
    ResourceTemplate,

    // 根目录相关
    Root,

    // 采样相关
    SamplingMessage,
    ServerCapabilities,
    // 服务器信息
    ServerInfo,
    // 工具相关
    Tool,
    ToolCall,
    ToolResult,
};
