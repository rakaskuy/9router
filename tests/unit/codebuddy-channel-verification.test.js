import { describe, it, expect } from "vitest";
import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";
import { buddyConversationHeaders } from "../../open-sse/shared/buddy/buddy-conversation-headers.js";

const REQUIRED_CONVERSATION_HEADERS = [
  "x-conversation-id",
  "x-conversation-request-id",
  "x-conversation-message-id",
];

describe("buddy conversation headers (Cartethyia contract)", () => {
  it("always emits the three mandatory headers, even with no caller ids", () => {
    const headers = buddyConversationHeaders();
    for (const name of REQUIRED_CONVERSATION_HEADERS) {
      expect(headers[name]).toBeTruthy();
    }
  });

  it("honours a caller-supplied conversation id", () => {
    const headers = buddyConversationHeaders({ conversationId: "conv-from-caller" });
    expect(headers["x-conversation-id"]).toBe("conv-from-caller");
    for (const name of REQUIRED_CONVERSATION_HEADERS) {
      expect(headers[name]).toBeTruthy();
    }
  });

  it("never forwards a blank conversation id", () => {
    const headers = buddyConversationHeaders({ conversationId: "   " });
    expect(headers["x-conversation-id"].trim().length).toBeGreaterThan(0);
  });

  it("keeps the request id conversation-scoped and the message id per message", () => {
    const headers = buddyConversationHeaders();
    expect(headers["x-root-request-id"]).toBe(headers["x-conversation-request-id"]);
    expect(headers["x-request-id"]).toBe(headers["x-conversation-message-id"]);
    expect(headers["x-conversation-request-id"]).not.toBe(headers["x-conversation-message-id"]);
  });

  it("keeps B3 ids hex even when the caller id is not", () => {
    const headers = buddyConversationHeaders({ conversationId: "not-a-hex-id-with-dashes" });
    expect(headers["x-b3-traceid"]).toMatch(/^[0-9a-f]{32}$/);
    expect(headers["x-b3-spanid"]).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("CodeBuddy channel verification (error 11128)", () => {
  it("sends the CLI identity envelope and conversation family on both providers", () => {
    const cnExec = new CodeBuddyExecutor();
    const intlExec = new CodeBuddyIntlExecutor();

    const cnHeaders = cnExec.buildHeaders({ accessToken: "tok-cn" }, true);
    const intlHeaders = intlExec.buildHeaders({ accessToken: "tok-intl" }, true);

    expect(cnHeaders["User-Agent"]).toBe("CLI/2.169.0 CodeBuddy/2.169.0");
    expect(cnHeaders["X-IDE-Type"]).toBe("CLI");
    expect(cnHeaders["X-IDE-Name"]).toBe("CLI");
    expect(cnHeaders["X-Domain"]).toBe("copilot.tencent.com");
    expect(cnHeaders["X-Agent-Intent"]).toBe("craft");
    expect(cnHeaders["X-Agent-Runtime"]).toBe("other");
    expect(cnHeaders["X-Agent-Purpose"]).toBe("conversation");
    expect(cnHeaders["x-stainless-lang"]).toBe("js");
    expect(cnHeaders["x-stainless-package-version"]).toBe("6.25.0");

    // The three mandatory headers, on both variants.
    for (const name of REQUIRED_CONVERSATION_HEADERS) {
      expect(cnHeaders[name]).toBeTruthy();
      expect(intlHeaders[name]).toBeTruthy();
    }

    // Browser-transport half must be absent from the CLI identity.
    expect(cnHeaders["x-requested-with"]).toBeUndefined();
    expect(cnHeaders["x-codebuddy-request"]).toBeUndefined();
    expect(intlHeaders["x-requested-with"]).toBeUndefined();
    expect(intlHeaders["x-codebuddy-request"]).toBeUndefined();

    expect(intlHeaders["X-Domain"]).toBe("www.codebuddy.ai");
    expect(intlHeaders["x-b3-traceid"]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("passes inbound conversation ids through and preserves sampled=0", () => {
    const intlExec = new CodeBuddyIntlExecutor();
    const inboundHeaders = {
      "x-conversation-id": "client-conv-1234",
      "x-conversation-request-id": "client-req-5678",
      "x-trace-id": "client-trace-9999",
      "x-b3-sampled": "0",
    };

    const headers = intlExec.buildHeaders(
      { accessToken: "tok-intl", rawHeaders: inboundHeaders },
      true
    );

    expect(headers["x-conversation-id"]).toBe("client-conv-1234");
    expect(headers["x-conversation-request-id"]).toBe("client-req-5678");
    expect(headers["x-root-request-id"]).toBe("client-req-5678");
    expect(headers["x-trace-id"]).toBe("client-trace-9999");
    expect(headers["x-b3-sampled"]).toBe("0");
    expect(headers["x-b3-spanid"]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("installs the fixed leading system prompt and drops caller system/developer turns", () => {
    const intlExec = new CodeBuddyIntlExecutor();
    const out = intlExec.transformRequest(
      "glm-5.2",
      {
        messages: [
          { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude." },
          { role: "developer", content: "Follow strict schema rules." },
          { role: "user", content: "hello" },
        ],
      },
      true,
      {}
    );

    expect(out.messages[0].role).toBe("system");
    expect(out.messages[0].content).toContain("pragmatic and direct software engineering assistant");
    // Caller identity text must not survive anywhere on the wire.
    expect(JSON.stringify(out.messages)).not.toContain("You are Claude Code");
    expect(JSON.stringify(out.messages)).not.toContain("Follow strict schema rules");
    expect(out.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "hello" }] });
  });

  it("coalesces consecutive user turns so images survive the upstream merge", () => {
    const intlExec = new CodeBuddyIntlExecutor();
    const out = intlExec.transformRequest(
      "glm-5.2",
      {
        messages: [
          { role: "user", content: "first" },
          { role: "user", content: "second" },
        ],
      },
      true,
      {}
    );

    const users = out.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0].content).toHaveLength(2);
  });

  it("forces stream and rewrites tool_choice objects to the wire string", () => {
    const intlExec = new CodeBuddyIntlExecutor();
    const out = intlExec.transformRequest(
      "glm-5.2",
      {
        stream: false,
        tool_choice: { type: "function", function: { name: "my_tool" } },
        messages: [{ role: "user", content: "hi" }],
      },
      false,
      {}
    );

    expect(out.stream).toBe(true);
    expect(out.tool_choice).toBe("my_tool");
  });

  it("rewrites a quoted 11128 in message text so the upstream does not self-block", () => {
    const intlExec = new CodeBuddyIntlExecutor();
    const out = intlExec.transformRequest(
      "glm-5.2",
      { messages: [{ role: "user", content: "error code 11128 from upstream" }] },
      true,
      {}
    );
    expect(JSON.stringify(out.messages)).not.toContain("11128");
    expect(JSON.stringify(out.messages)).toContain("11-128");
  });

  it.each([
    ["hy3-preview", "hy3"],
    ["glm-4.7", "glm-5.2"],
    ["glm-5.0", "glm-5.2"],
    ["glm-5.0-turbo", "glm-5.3-flash"],
    ["minimax-m2.7", "minimax-m3"],
    ["deepseek-v3-2-volc", "deepseek-v4.1-flash"],
    ["deepseek-v4-pro", "deepseek-v4.1-flash"],
  ])("automatically remaps retired model '%s' to active successor '%s'", (retired, successor) => {
    const intlExec = new CodeBuddyIntlExecutor();
    const out = intlExec.transformRequest(
      retired,
      { model: retired, messages: [{ role: "user", content: "test" }] },
      true,
      {}
    );
    expect(out.model).toBe(successor);
  });

  it("classifies 11102, 11128, and 11158 with distinct diagnostics", () => {
    const intlExec = new CodeBuddyIntlExecutor();

    const notServed = intlExec.parseError(
      { status: 400 },
      JSON.stringify({ code: 11102, msg: "model [hy3-preview] service info not found" })
    );
    expect(notServed.status).toBe(400);
    expect(notServed.message).toContain("11102");

    const channel = intlExec.parseError(
      { status: 400 },
      JSON.stringify({ code: 11128, msg: "request illegal" })
    );
    expect(channel.status).toBe(400);
    expect(channel.message).toContain("channel verification");

    const tier = intlExec.parseError(
      { status: 400 },
      JSON.stringify({ code: 11158, msg: "model [gpt-5.5] is not allowed for user type [personal_free_user]" })
    );
    expect(tier.status).toBe(403);
    expect(tier.message).toContain("tier");
  });
});
