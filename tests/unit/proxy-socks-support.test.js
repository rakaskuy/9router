// Residential proxy networks ship SOCKS5 (usually authenticated) far more often
// than HTTP. undici's ProxyAgent accepts a socks5:// URI and then fails at
// connect time, so before this change a SOCKS pool entry was silently unusable:
// every request fell through to the direct IP, which is exactly what gets an
// account banned upstream.
//
// Two halves, one per layer:
//
// 1. proxyAwareFetch must route a socks:// proxy through socks-proxy-agent
//    instead of undici's ProxyAgent.
// 2. testProxyUrl must do the same, or a working SOCKS pool reports "error"
//    and gets deactivated by the pool test route.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";

vi.mock("@/models", () => ({
  getProxyPoolById: vi.fn(),
}));

// Captured before proxyFetch is imported: that module snapshots
// `globalThis.fetch` at module scope, so a later stub would never be seen.
const { directFetchMock } = vi.hoisted(() => ({ directFetchMock: vi.fn() }));

vi.mock("socks-proxy-agent", () => ({
  SocksProxyAgent: class {
    constructor(url) {
      this.url = url;
    }
  },
}));

const socksRequest = vi.fn();

function httpStub() {
  return { default: { request: (...a) => socksRequest(...a) }, request: (...a) => socksRequest(...a) };
}

vi.mock("node:https", httpStub);
vi.mock("node:http", httpStub);

const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
const { testProxyUrl } = await import("../../src/lib/network/proxyTest.js");

/**
 * A node:http request stub answering with a real Readable, because the SOCKS
 * path feeds the response through `Readable.toWeb()`.
 */
function respondOk(statusCode = 200) {
  return (_parsed, _opts, onResponse) => {
    const handlers = {};
    const req = {
      on(event, handler) {
        handlers[event] = handler;
        return req;
      },
      write() {},
      end() {
        const body = Readable.from(["{}"]);
        body.statusCode = statusCode;
        body.statusMessage = "OK";
        body.headers = { "content-type": "application/json" };
        onResponse(body);
      },
      destroy(err) {
        handlers.error?.(err);
      },
    };
    return req;
  };
}

describe("SOCKS proxy support", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    socksRequest.mockReset();
    directFetchMock.mockReset();
    directFetchMock.mockResolvedValue(new Response("direct", { status: 200 }));
    global.fetch = directFetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("routes an authenticated socks5 pool through socks-proxy-agent, not the direct IP", async () => {
    socksRequest.mockImplementation(respondOk());

    await proxyAwareFetch(
      "https://www.codebuddy.ai/v2/chat/completions",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      {
        connectionProxyEnabled: true,
        connectionProxyUrl: "socks5://user:pass@hk.residential.example:1080",
      },
    );

    expect(socksRequest).toHaveBeenCalledTimes(1);
    // The direct fetch must never run — that is the leak this guards.
    expect(directFetchMock).not.toHaveBeenCalled();
  });

  it("does not touch the SOCKS path for an http proxy", async () => {
    await proxyAwareFetch(
      "https://example.com",
      { method: "GET" },
      { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:7890" },
    );

    expect(socksRequest).not.toHaveBeenCalled();
  });

  it("probes a socks pool over the tunnel so it is not marked error", async () => {
    socksRequest.mockImplementation(respondOk());

    const result = await testProxyUrl({ proxyUrl: "socks5://user:pass@hk.residential.example:1080" });

    expect(socksRequest).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });
});
