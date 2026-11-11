
import { OAuthResourceServer } from "@cloudflare/workers-oauth-provider";

const TOOL_NAMES = [
  "health",
  "tax_report",
  "validate_tax_report",
  "generate_tax_declaration",
  "export_vat_xlsx",
];

const PERIOD_SCHEMA = {
  period: {
    type: "string",
    description: "Kỳ báo cáo: 2026-Q3, 2026-Q2, 2026-09 hoặc 2026.",
  },
};

const TOOL_DEFINITIONS = [
  {
    name: "health",
    description: "Kiểm tra trạng thái kết nối hệ thống hóa đơn.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "tax_report",
    description: "Lấy báo cáo thuế GTGT theo kỳ tháng, quý hoặc năm.",
    inputSchema: {
      type: "object",
      properties: PERIOD_SCHEMA,
      required: ["period"],
      additionalProperties: false,
    },
  },
  {
    name: "validate_tax_report",
    description: "Kiểm tra tính hợp lệ báo cáo thuế theo kỳ.",
    inputSchema: {
      type: "object",
      properties: PERIOD_SCHEMA,
      required: ["period"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_tax_declaration",
    description: "Tạo dữ liệu tờ khai VAT theo kỳ.",
    inputSchema: {
      type: "object",
      properties: PERIOD_SCHEMA,
      required: ["period"],
      additionalProperties: false,
    },
  },
  {
    name: "export_vat_xlsx",
    description: "Xuất báo cáo/tờ khai VAT Excel lên Google Drive.",
    inputSchema: {
      type: "object",
      properties: PERIOD_SCHEMA,
      required: ["period"],
      additionalProperties: false,
    },
  },
];

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function textResult(value, isError = false) {
  const text =
    typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);

  return {
    content: [{ type: "text", text }],
    isError,
  };
}

function validateArguments(name, args) {
  if (!TOOL_NAMES.includes(name)) {
    throw new Error(`Công cụ không được hỗ trợ: ${name}`);
  }

  if (
    args === null ||
    typeof args !== "object" ||
    Array.isArray(args)
  ) {
    throw new Error("arguments phải là một object.");
  }

  if (name === "health") {
    if (Object.keys(args).length) {
      throw new Error("health không nhận tham số.");
    }
    return args;
  }

  for (const key of Object.keys(args)) {
    if (key !== "period") {
      throw new Error(`Tham số không được hỗ trợ: ${key}`);
    }
  }

  const period = args.period;

  if (
    typeof period !== "string" ||
    !/^\d{4}-(Q[1-4]|0[1-9]|1[0-2])$|^\d{4}$/.test(period)
  ) {
    throw new Error(
      "period không hợp lệ. Dùng 2026-Q3, 2026-09 hoặc 2026."
    );
  }

  return args;
}

async function callInvoiceApi(env, action, args = {}) {
  if (!env.APPS_SCRIPT_URL || !env.CHATGPT_BRIDGE_TOKEN) {
    throw new Error(
      "Worker chưa cấu hình APPS_SCRIPT_URL hoặc CHATGPT_BRIDGE_TOKEN."
    );
  }

  const payload = {
    action,
    bridge_token: env.CHATGPT_BRIDGE_TOKEN,
    ...args,
  };

  const response = await fetch(env.APPS_SCRIPT_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
    redirect: "follow",
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Apps Script trả về HTTP ${response.status}.`
    );
  }

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      "Apps Script không trả JSON hợp lệ. Kiểm tra Web App/deployment."
    );
  }

  if (data && (data.error || data.success === false)) {
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : JSON.stringify(data.error || data)
    );
  }

  return data;
}

async function executeTool(env, name, rawArgs = {}) {
  const args = validateArguments(name, rawArgs);

  if (name === "health") {
    return callInvoiceApi(env, "health", {});
  }

  return callInvoiceApi(env, name, {
    period: args.period,
  });
}

async function handleMcpRequest(request, env, ctx) {
  const url = new URL(request.url);

  if (url.pathname !== "/mcp") {
    return new Response("Not found", { status: 404 });
  }

  if (request.method === "GET") {
    return new Response("MCP Streamable HTTP: POST required.", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  const contentType = request.headers.get("content-type") || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    return jsonResponse(
      rpcError(
        null,
        -32700,
        "Content-Type phải là application/json."
      ),
      415
    );
  }

  let message;

  try {
    message = await request.json();
  } catch {
    return jsonResponse(
      rpcError(null, -32700, "JSON không hợp lệ."),
      400
    );
  }

  if (
    !message ||
    typeof message !== "object" ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string"
  ) {
    return jsonResponse(
      rpcError(
        message?.id ?? null,
        -32600,
        "Yêu cầu JSON-RPC không hợp lệ."
      ),
      400
    );
  }

  const id = message.id;

  if (
    message.method === "notifications/initialized" ||
    message.method.startsWith("notifications/")
  ) {
    return new Response(null, { status: 202 });
  }

  if (id === undefined) {
    return jsonResponse(
      rpcError(null, -32600, "Thiếu JSON-RPC id."),
      400
    );
  }

  if (message.method === "initialize") {
    return jsonResponse(
      rpcResult(id, {
        protocolVersion:
          message.params?.protocolVersion || "2025-06-18",
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: "pdf-invoice-reader",
          version: "2.0.0",
        },
      })
    );
  }

  if (message.method === "ping") {
    return jsonResponse(rpcResult(id, {}));
  }

  if (message.method === "tools/list") {
    return jsonResponse(
      rpcResult(id, {
        tools: TOOL_DEFINITIONS,
      })
    );
  }

  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};

    try {
      const data = await executeTool(env, name, args);

      return jsonResponse(
        rpcResult(id, textResult(data))
      );
    } catch (error) {
      return jsonResponse(
        rpcResult(
          id,
          textResult(
            error instanceof Error
              ? error.message
              : "Không thể xử lý yêu cầu thuế.",
            true
          )
        )
      );
    }
  }

  return jsonResponse(
    rpcError(
      id,
      -32601,
      `Method không được hỗ trợ: ${message.method}`
    ),
    200
  );
}

const resourceServer = new OAuthResourceServer({
  resourceMetadata: {
    resource:
      "https://pdf-invoice-bridge.thuandinhdev.workers.dev/mcp",
    authorization_servers: [
      "https://pdf-invoice-oauth.thuandinhdev.workers.dev",
    ],
  },

  requiredScopes: ["mcp:read"],

  validateToken: (env) => env.AUTH_SERVER.validateToken,

  handler: {
    fetch(request, env, ctx) {
      // OAuthResourceServer xác minh token trước khi gọi handler.
      return handleMcpRequest(request, env, ctx);
    },
  },
});

export default resourceServer;
