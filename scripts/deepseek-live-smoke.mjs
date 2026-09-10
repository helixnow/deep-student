#!/usr/bin/env node

const officialKey = process.env.DEEPSEEK_API_KEY;
const siliconFlowKey = process.env.SILICONFLOW_API_KEY;

const officialBaseUrl = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const officialModel = process.env.DEEPSEEK_MODEL || process.env.DEEPSEEK_V4_MODEL || "deepseek-flash";
const siliconFlowBaseUrl = process.env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1";
const siliconFlowModel = process.env.SILICONFLOW_V32_MODEL || "deepseek-ai/DeepSeek-V3.2";
const siliconFlowV4Model = process.env.SILICONFLOW_V4_MODEL || "deepseek-ai/DeepSeek-V4-Flash";

const timeoutMs = Number(process.env.DEEPSEEK_SMOKE_TIMEOUT_MS || 90_000);

function endpoint(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function redact(value) {
  if (typeof value !== "string") return value;
  return value.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***");
}

function compactError(value) {
  if (!value) return undefined;
  if (typeof value === "string") return redact(value).slice(0, 500);
  if (typeof value === "object") {
    const message = value.error?.message || value.message || JSON.stringify(value);
    return redact(String(message)).slice(0, 500);
  }
  return redact(String(value)).slice(0, 500);
}

function requestShape(body) {
  return {
    keys: Object.keys(body).sort(),
    thinkingType: body.thinking?.type,
    reasoningEffort: body.reasoning_effort,
    enableThinking: body.enable_thinking,
    thinkingBudget: body.thinking_budget,
    hasSamplingControls: ["temperature", "top_p", "presence_penalty", "frequency_penalty"].filter(
      (key) => Object.prototype.hasOwnProperty.call(body, key),
    ),
  };
}

async function postChat({ name, provider, key, baseUrl, body }) {
  const shape = requestShape(body);
  if (!key) {
    return {
      name,
      provider,
      model: body.model,
      status: "blocked_credentials",
      requestShape: shape,
      message: provider === "deepseek" ? "DEEPSEEK_API_KEY is not set" : "SILICONFLOW_API_KEY is not set",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint(baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    if (!response.ok) {
      return {
        name,
        provider,
        model: body.model,
        status: "failed",
        httpStatus: response.status,
        requestShape: shape,
        error: compactError(json || text),
      };
    }

    return {
      name,
      provider,
      model: body.model,
      status: "passed",
      httpStatus: response.status,
      requestShape: shape,
      responseId: json?.id,
      responseModel: json?.model,
      usage: json?.usage,
      hasContent: Boolean(json?.choices?.[0]?.message?.content),
      hasReasoningContent: Boolean(json?.choices?.[0]?.message?.reasoning_content),
    };
  } catch (error) {
    return {
      name,
      provider,
      model: body.model,
      status: "failed",
      requestShape: shape,
      error: error?.name === "AbortError" ? `Timed out after ${timeoutMs}ms` : compactError(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function officialV4Body(mode) {
  const body = {
    model: officialModel,
    messages: [
      {
        role: "user",
        content: "Reply with exactly: DS_OK",
      },
    ],
    stream: false,
    max_tokens: mode === "disabled" ? 32 : 128,
    thinking: {
      type: mode === "disabled" ? "disabled" : "enabled",
    },
  };

  if (mode !== "disabled") {
    body.reasoning_effort = mode;
  }

  return body;
}

function siliconFlowV32Body() {
  return {
    model: siliconFlowModel,
    messages: [
      {
        role: "user",
        content: "Reply with exactly: SF_OK",
      },
    ],
    stream: false,
    max_tokens: 128,
    enable_thinking: true,
    thinking_budget: 512,
    temperature: 0.7,
    top_p: 0.7,
    presence_penalty: 0,
    frequency_penalty: 0,
  };
}

function siliconFlowV4Body(effort) {
  return {
    model: siliconFlowV4Model,
    messages: [
      {
        role: "user",
        content: "Reply with exactly: SF_V4_OK",
      },
    ],
    stream: false,
    max_tokens: 128,
    enable_thinking: true,
    reasoning_effort: effort,
  };
}

const cases = [
  {
    name: "official-v4-disabled",
    provider: "deepseek",
    key: officialKey,
    baseUrl: officialBaseUrl,
    body: officialV4Body("disabled"),
  },
  {
    name: "official-v4-high",
    provider: "deepseek",
    key: officialKey,
    baseUrl: officialBaseUrl,
    body: officialV4Body("high"),
  },
  {
    name: "official-v4-max",
    provider: "deepseek",
    key: officialKey,
    baseUrl: officialBaseUrl,
    body: officialV4Body("max"),
  },
  {
    name: "siliconflow-v32-thinking",
    provider: "siliconflow",
    key: siliconFlowKey,
    baseUrl: siliconFlowBaseUrl,
    body: siliconFlowV32Body(),
  },
  {
    name: "siliconflow-v4-high",
    provider: "siliconflow",
    key: siliconFlowKey,
    baseUrl: siliconFlowBaseUrl,
    body: siliconFlowV4Body("high"),
  },
  {
    name: "siliconflow-v4-max",
    provider: "siliconflow",
    key: siliconFlowKey,
    baseUrl: siliconFlowBaseUrl,
    body: siliconFlowV4Body("max"),
  },
];

const startedAt = new Date().toISOString();
const results = [];
for (const testCase of cases) {
  results.push(await postChat(testCase));
}

const summary = {
  startedAt,
  completedAt: new Date().toISOString(),
  officialBaseUrl,
  officialModel,
  siliconFlowBaseUrl,
  siliconFlowModel,
  results,
};

console.log(JSON.stringify(summary, null, 2));

const failed = results.some((result) => result.status === "failed");
const blocked = results.some((result) => result.status === "blocked_credentials");
process.exitCode = failed ? 1 : blocked ? 2 : 0;
