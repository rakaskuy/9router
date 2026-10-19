import { describe, it, expect } from "vitest";
import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";

describe("CodeBuddy channel verification (error 11128)", () => {
  it("sets required CLI, Stainless, conversation, and tracing headers on codebuddy-cn and codebuddy-intl", () => {
    const cnExec = new CodeBuddyExecutor();
    const intlExec = new CodeBuddyIntlExecutor();

    const cnHeaders = cnExec.buildHeaders({ accessToken: "tok-cn" }, true);
    const intlHeaders = intlExec.buildHeaders({ accessToken: "tok-intl" }, true);

    expect(cnHeaders["User-Agent"]).toBe("CLI/2.108.1 CodeBuddy/2.108.1");
    expect(cnHeaders["X-App"]).toBe("cli");
    expect(cnHeaders["X-IDE-Type"]).toBe("CLI");
    expect(cnHeaders["X-IDE-Name"]).toBe("CLI");
    expect(cnHeaders["X-IDE-Version"]).toBe("2.108.1");
    expect(cnHeaders["X-Domain"]).toBe("copilot.tencent.com");
    expect(cnHeaders["X-Stainless-Lang"]).toBe("js");
    expect(cnHeaders["X-Request-ID"]).toMatch(/^[0-9a-f]{32}$/);
    expect(cnHeaders["X-Conversation-ID"]).toBeTruthy();
    expect(cnHeaders["X-Conversation-Request-ID"]).toBeTruthy();
    expect(cnHeaders["X-Conversation-Message-ID"]).toBeTruthy();
    expect(cnHeaders["X-Root-Request-ID"]).toBe(cnHeaders["X-Conversation-Request-ID"]);
    expect(cnHeaders["X-Trace-ID"]).toBe(cnHeaders["X-Conversation-Request-ID"]);
    expect(cnHeaders["X-B3-TraceId"]).toMatch(/^[0-9a-f]{32}$/);
    expect(cnHeaders["X-B3-SpanId"]).toMatch(/^[0-9a-f]{16}$/);
    expect(cnHeaders["X-B3-Sampled"]).toBe("1");
    expect(cnHeaders["X-Agent-Intent"]).toBe("craft");
    expect(cnHeaders["X-Agent-Purpose"]).toBe("conversation");

    expect(intlHeaders["User-Agent"]).toBe("CLI/2.108.1 CodeBuddy/2.108.1");
    expect(intlHeaders["X-Domain"]).toBe("www.codebuddy.ai");
    expect(intlHeaders["X-Request-ID"]).toMatch(/^[0-9a-f]{32}$/);
    expect(intlHeaders["X-Conversation-ID"]).toBeTruthy();
    expect(intlHeaders["X-B3-TraceId"]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("prioritizes inbound X-Conversation-ID and respects inbound B3 headers", () => {
    const intlExec = new CodeBuddyIntlExecutor();
    const inboundHeaders = {
      "x-conversation-id": "client-conv-1234",
      "x-conversation-request-id": "client-req-5678",
      "x-trace-id": "client-trace-9999",
      "x-b3-traceid": "463ac35c9f6413ad48485a3953bb6124",
      "x-b3-sampled": "0",
    };

    const headers = intlExec.buildHeaders({
      accessToken: "tok-intl",
      rawHeaders: inboundHeaders,
    }, true);

    expect(headers["X-Conversation-ID"]).toBe("client-conv-1234");
    expect(headers["X-Conversation-Request-ID"]).toBe("client-req-5678");
    expect(headers["X-Root-Request-ID"]).toBe("client-req-5678");
    expect(headers["X-Trace-ID"]).toBe("client-trace-9999");
    expect(headers["X-B3-TraceId"]).toBe("463ac35c9f6413ad48485a3953bb6124");
    expect(headers["X-B3-Sampled"]).toBe("0");
    expect(headers["X-B3-SpanId"]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("prepends 'You are CodeBuddy Code.', preserves caller system/developer instructions, and sanitizes external client markers", () => {
    const intlExec = new CodeBuddyIntlExecutor();
    const out = intlExec.transformRequest(
      "glm-5.2",
      {
        messages: [
          {
            role: "system",
            content:
              "You are Claude Code, Anthropic's official CLI for Claude.\nAlways reply in JSON.",
          },
          {
            role: "developer",
            content: "Follow strict schema rules.",
          },
          {
            role: "user",
            content: "hello",
          },
          {
            role: "assistant",
            content: "I am running with cc_entrypoint=cli",
          },
        ],
      },
      true,
      {}
    );

    expect(out.messages[0].role).toBe("system");
    expect(out.messages[0].content.startsWith("You are CodeBuddy Code.")).toBe(true);
    expect(out.messages[0].content).toContain("Always reply in JSON.");
    expect(out.messages[0].content).toContain("Follow strict schema rules.");
    expect(out.messages[0].content).not.toContain("You are Claude Code");

    expect(out.messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
    expect(out.messages[2].content).not.toContain("cc_entrypoint=cli");
    expect(out.messages[2].content).toContain("[external-client-identity]");
  });
});
