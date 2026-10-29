
import {
    OAuthResourceServer,
  } from "@cloudflare/workers-oauth-provider";
  
  const TOOL_NAMES = [
    "health",
    "summary",
    "invoices",
    "items",
    "warnings",
  ];
  
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
      name: "summary",
      description:
        "Lấy tổng quan doanh thu, VAT và tổng thanh toán hóa đơn.",
      inputSchema: {
        type: "object",
        properties: {
          year: {
            type: "integer",
            description: "Năm cần tổng hợp, ví dụ 2026.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "invoices",
      description: "Lấy danh sách dữ liệu hóa đơn.",
      inputSchema: {
        type: "object",
        properties: {
          year: {
            type: "integer",
            description: "Năm hóa đơn cần truy vấn, ví dụ 2026.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "items",
      description: "Lấy danh sách mặt hàng trên hóa đơn.",
      inputSchema: {
        type: "object",
        properties: {
          year: {
            type: "integer",
            description: "Năm hóa đơn cần truy vấn, ví dụ 2026.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "warnings",
      description:
        "Lấy cảnh báo xử lý hóa đơn và dữ liệu cần kiểm tra.",
      inputSchema: {
        type: "object",
        properties: {
          year: {
            type: "integer",
            description: "Năm cần kiểm tra, ví dụ 2026.",
          },
        },
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
    return {
      jsonrpc: "2.0",
      id,
      result,
    };
  }
  
  function rpcError(id, code, message) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code, message },
    };
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
  
    const allowedKeys = name === "health" ? [] : ["year"];
  
    for (const key of Object.keys(args)) {
      if (!allowedKeys.includes(key)) {
        throw new Error(`Tham số không được hỗ trợ: ${key}`);
      }
    }
  
    if (args.year !== undefined) {
      if (
        !Number.isInteger(args.year) ||
        args.year < 2000 ||
        args.year > 2100
      ) {
        throw new Error("year phải là số nguyên từ 2000 đến 2100.");
      }
    }
  
    return args;
  }
  
  async function callInvoiceApi(env, action, args = {}) {
    if (!env.APPS_SCRIPT_URL || !env.CHATGPT_BRIDGE_TOKEN) {
      throw new Error("Worker chưa cấu hình Apps Script hoặc secret.");
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
        "accept": "application/json",
      },
      body: JSON.stringify(payload),
      redirect: "follow",
    });
  
    const responseText = await response.text();
  
    if (!response.ok) {
      throw new Error(
        `Apps Script trả về HTTP ${response.status}.`,
      );
    }
  
    let data;
  
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error(
        "Apps Script không trả về JSON hợp lệ. Kiểm tra Web App và quyền truy cập.",
      );
    }
  
    if (data && data.error) {
      throw new Error(
        typeof data.error === "string"
          ? data.error
          : JSON.stringify(data.error),
      );
    }
  
    return data;
  }
  
  async function executeTool(env, name, rawArgs) {
    const args = validateArguments(name, rawArgs);
  
    // Chỉ chuyển các tham số đã được cho phép.
    const params = {};
    if (args.year !== undefined) {
      params.year = args.year;
    }
  
    return callInvoiceApi(env, name, params);
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
        rpcError(null, -32700, "Content-Type phải là application/json."),
        415,
      );
    }
  
    let message;
  
    try {
      message = await request.json();
    } catch {
      return jsonResponse(
        rpcError(null, -32700, "JSON không hợp lệ."),
        400,
      );
    }
  
    if (
      !message ||
      typeof message !== "object" ||
      message.jsonrpc !== "2.0" ||
      typeof message.method !== "string"
    ) {
      return jsonResponse(
        rpcError(message?.id ?? null, -32600, "Yêu cầu JSON-RPC không hợp lệ."),
        400,
      );
    }
  
    const id = message.id;
  
    // MCP notifications không yêu cầu JSON-RPC response.
    if (message.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
  
    if (message.method.startsWith("notifications/")) {
      return new Response(null, { status: 202 });
    }
  
    if (id === undefined) {
      return jsonResponse(
        rpcError(null, -32600, "Thiếu JSON-RPC id."),
        400,
      );
    }
  
    if (message.method === "initialize") {
      return jsonResponse(
        rpcResult(id, {
          protocolVersion: message.params?.protocolVersion || "2025-06-18",
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: "pdf-invoice-reader",
            version: "1.0.0",
          },
        }),
      );
    }
  
    if (message.method === "ping") {
      return jsonResponse(rpcResult(id, {}));
    }
  
    if (message.method === "tools/list") {
      return jsonResponse(
        rpcResult(id, {
          tools: TOOL_DEFINITIONS,
        }),
      );
    }
  
    if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
  
      try {
        const data = await executeTool(env, name, args);
        return jsonResponse(
          rpcResult(id, textResult(data)),
        );
      } catch (error) {
        return jsonResponse(
          rpcResult(
            id,
            textResult(
              error instanceof Error
                ? error.message
                : "Không thể xử lý yêu cầu hóa đơn.",
              true,
            ),
          ),
        );
      }
    }
  
    return jsonResponse(
      rpcError(id, -32601, `Method không được hỗ trợ: ${message.method}`),
      200,
    );
  }
  
  const resourceServer = new OAuthResourceServer({
    resourceMetadata: {
      resource: "https://pdf-invoice-bridge.thuandinhdev.workers.dev/mcp",
      authorization_servers: [
        "https://pdf-invoice-oauth.thuandinhdev.workers.dev",
      ],
    },
    requiredScopes: ["mcp:read"],
    validateToken: (env) => env.AUTH_SERVER.validateToken,
    handler: {
      fetch(request, env, ctx) {
        // OAuthResourceServer đã xác minh token trước khi gọi handler.
        return handleMcpRequest(request, env, ctx);
      },
    },
  });
  
  export default resourceServer;
  