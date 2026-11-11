
import {
    OAuthResourceServer,
  } from "@cloudflare/workers-oauth-provider";
  
  const TOOL_NAMES = [
    "health",
    "tax_report",
    "validate_tax_report",
    "generate_tax_declaration",
    "export_vat_xlsx"
  ];
  
  const DATE_FILTER_PROPERTIES = {
    year: {
      type: "integer",
      description: "Năm cần truy vấn, ví dụ 2026. Không dùng cùng date_from/date_to.",
    },
    date_from: {
      type: "string",
      description: "Ngày bắt đầu, định dạng YYYY-MM-DD.",
    },
    date_to: {
      type: "string",
      description: "Ngày kết thúc, định dạng YYYY-MM-DD.",
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
      name: "summary",
      description:
        "Lấy tổng quan doanh thu, VAT và tổng thanh toán hóa đơn theo năm hoặc khoảng ngày.",
      inputSchema: {
        type: "object",
        properties: DATE_FILTER_PROPERTIES,
        additionalProperties: false,
      },
    },
    {
      name: "invoices",
      description:
        "Lấy danh sách dữ liệu hóa đơn theo năm hoặc khoảng ngày.",
      inputSchema: {
        type: "object",
        properties: DATE_FILTER_PROPERTIES,
        additionalProperties: false,
      },
    },
    {
      name: "items",
      description:
        "Lấy danh sách mặt hàng trên hóa đơn theo năm hoặc khoảng ngày.",
      inputSchema: {
        type: "object",
        properties: DATE_FILTER_PROPERTIES,
        additionalProperties: false,
      },
    },
    {
      name: "warnings",
      description:
        "Lấy cảnh báo xử lý hóa đơn và dữ liệu cần kiểm tra theo năm hoặc khoảng ngày.",
      inputSchema: {
        type: "object",
        properties: DATE_FILTER_PROPERTIES,
        additionalProperties: false,
      },
    },
    {
        name: "tax_report",
        description:
          "Lấy báo cáo thuế GTGT theo kỳ tháng, quý hoặc năm. Trả số liệu và trạng thái kiểm tra.",
        inputSchema: {
          type: "object",
          properties: {
            period: {
              type: "string",
              description: "Kỳ báo cáo: 2026-Q3, 2026-Q2 hoặc 2026.",
            },
          },
          required: ["period"],
          additionalProperties: false,
        },
      },
      {
        name: "generate_tax_declaration",
        description:
          "Tạo dữ liệu tờ khai VAT theo mẫu hiện tại của người dùng. Không tự thay đổi mapping.",
        inputSchema: {
          type: "object",
          properties: {
            period: {
              type: "string",
              description: "Kỳ khai thuế, ví dụ 2026-Q3.",
            },
          },
          required: ["period"],
          additionalProperties: false,
        },
      },
      {
        name: "export_vat_xlsx",
        description:
          "Xuất báo cáo hoặc tờ khai VAT Excel lên Google Drive. Trả về URL tải file XLSX.",
        inputSchema: {
          type: "object",
          properties: {
            period: {
              type: "string",
              description: "Kỳ xuất báo cáo, ví dụ 2026-Q3.",
            },
          },
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
  
  function isValidDate(value) {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value)
    ) {
      return false;
    }
  
    const date = new Date(`${value}T00:00:00Z`);
  
    return (
      !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
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
  
    const allowedKeys =
      name === "health"
        ? []
        : ["year", "date_from", "date_to"];
  
    for (const key of Object.keys(args)) {
      if (!allowedKeys.includes(key)) {
        throw new Error(`Tham số không được hỗ trợ: ${key}`);
      }
    }
  
    if (name === "health") {
      return args;
    }

    const PERIOD_TOOLS = [
        "tax_report",
        "generate_tax_declaration",
        "export_vat_xlsx",
      ];
      
      if (PERIOD_TOOLS.includes(name)) {
        if (
          typeof args.period !== "string" ||
          !/^\d{4}-(Q[1-4]|0[1-9]|1[0-2])$|^\d{4}$/.test(args.period)
        ) {
          throw new Error(
            "period không hợp lệ. Ví dụ: 2026-Q3, 2026-09 hoặc 2026."
          );
        }
      
        return args;
      }
  
    const hasYear = args.year !== undefined;
    const hasFrom = args.date_from !== undefined;
    const hasTo = args.date_to !== undefined;
  
    if (hasYear && (hasFrom || hasTo)) {
      throw new Error(
        "Chỉ dùng year hoặc cặp date_from/date_to, không dùng đồng thời."
      );
    }
  
    if (hasYear) {
      if (
        !Number.isInteger(args.year) ||
        args.year < 2000 ||
        args.year > 2100
      ) {
        throw new Error(
          "year phải là số nguyên từ 2000 đến 2100."
        );
      }
  
      return args;
    }
  
    if (hasFrom !== hasTo) {
      throw new Error(
        "Phải cung cấp cả date_from và date_to."
      );
    }
  
    if (!hasFrom && !hasTo) {
      throw new Error(
        "Hãy cung cấp year hoặc cả date_from và date_to."
      );
    }
  
    if (!isValidDate(args.date_from)) {
      throw new Error(
        "date_from không hợp lệ; dùng định dạng YYYY-MM-DD."
      );
    }
  
    if (!isValidDate(args.date_to)) {
      throw new Error(
        "date_to không hợp lệ; dùng định dạng YYYY-MM-DD."
      );
    }
  
    if (args.date_from > args.date_to) {
      throw new Error(
        "date_from phải nhỏ hơn hoặc bằng date_to."
      );
    }
  
    return args;
  }
  
  async function callInvoiceApi(env, action, args = {}) {
    if (!env.APPS_SCRIPT_URL || !env.CHATGPT_BRIDGE_TOKEN) {
      throw new Error(
        "Worker chưa cấu hình Apps Script hoặc secret."
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
        "accept": "application/json",
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
        "Apps Script không trả về JSON hợp lệ. Kiểm tra Web App và quyền truy cập."
      );
    }
  
    if (data && data.error) {
      throw new Error(
        typeof data.error === "string"
          ? data.error
          : JSON.stringify(data.error)
      );
    }
  
    return data;
  }
  
  async function executeTool(env, name, rawArgs) {
    const args = validateArguments(name, rawArgs);
  
    if (name === "health") {
      return callInvoiceApi(env, name, {});
    }
  
    const PERIOD_TOOLS = [
      "tax_report",
      "generate_tax_declaration",
      "export_vat_xlsx",
    ];
  
    if (PERIOD_TOOLS.includes(name)) {
      return callInvoiceApi(env, name, {
        period: args.period,
      });
    }
  
    let params = {};
  
    if (args.year !== undefined) {
      params = {
        date_from: `${args.year}-01-01`,
        date_to: `${args.year}-12-31`,
      };
    } else {
      params = {
        date_from: args.date_from,
        date_to: args.date_to,
      };
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
            version: "1.1.0",
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
                : "Không thể xử lý yêu cầu hóa đơn.",
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
        // OAuthResourceServer đã xác minh token trước khi gọi handler.
        return handleMcpRequest(request, env, ctx);
      },
    },
  });
  
  export default resourceServer;
