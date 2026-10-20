import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  getProviderConnections: vi.fn(),
  getApiKeys: vi.fn(),
  getConsistentMachineId: vi.fn(),
  pingModelByKind: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  getProviderConnections: mocks.getProviderConnections,
  getApiKeys: mocks.getApiKeys,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/app/api/models/test/ping", () => ({
  pingModelByKind: mocks.pingModelByKind,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

describe("POST /api/providers/[id]/test-models", () => {
  let POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../../src/app/api/providers/[id]/test-models/route.js");
    POST = mod.POST;

    mocks.getApiKeys.mockResolvedValue([{ key: "sk-internal", isActive: true }]);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.pingModelByKind.mockResolvedValue({
      ok: true,
      latencyMs: 120,
      status: 200,
      error: null,
    });
  });

  it("tests models using a direct connection ID", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-cbai-1",
      provider: "codebuddy-intl",
    });

    const req = new Request("http://localhost/api/providers/conn-cbai-1/test-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req, { params: Promise.resolve({ id: "conn-cbai-1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.provider).toBe("codebuddy-intl");
    expect(body.connectionId).toBe("conn-cbai-1");
    expect(body.summary.total).toBeGreaterThan(0);
    expect(body.summary.passed).toBe(body.summary.total);
    expect(body.summary.failed).toBe(0);
    expect(body.results.length).toBe(body.summary.total);
  });

  it("resolves provider ID directly and finds the active connection", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(null);
    mocks.getProviderConnections.mockResolvedValue([
      { id: "conn-active", provider: "codebuddy-intl", isActive: true },
    ]);

    const req = new Request("http://localhost/api/providers/codebuddy-intl/test-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req, { params: Promise.resolve({ id: "codebuddy-intl" }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.provider).toBe("codebuddy-intl");
    expect(body.connectionId).toBe("conn-active");
    expect(mocks.getProviderConnections).toHaveBeenCalledWith({
      provider: "codebuddy-intl",
      isActive: true,
    });
  });

  it("resolves provider alias (e.g. cbai) to the canonical provider ID", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(null);
    mocks.getProviderConnections.mockResolvedValue([
      { id: "conn-alias", provider: "codebuddy-intl", isActive: true },
    ]);

    const req = new Request("http://localhost/api/providers/cbai/test-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req, { params: Promise.resolve({ id: "cbai" }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.provider).toBe("codebuddy-intl");
    expect(body.connectionId).toBe("conn-alias");
  });

  it("returns 404 when provider has connections but all are inactive", async () => {
    mocks.getProviderConnectionById.mockResolvedValue(null);
    mocks.getProviderConnections.mockImplementation(async (filter) => {
      if (filter.isActive) return [];
      return [{ id: "conn-inactive", provider: "codebuddy-intl", isActive: false }];
    });

    const req = new Request("http://localhost/api/providers/codebuddy-intl/test-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req, { params: Promise.resolve({ id: "codebuddy-intl" }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("No active connection found");
  });

  it("filters models when modelIds array is provided in request body", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-1",
      provider: "codebuddy-intl",
    });

    const req = new Request("http://localhost/api/providers/conn-1/test-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelIds: ["hy3", "glm-5.2"] }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "conn-1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.summary.total).toBe(2);
    expect(body.results.map((r) => r.modelId)).toEqual(["hy3", "glm-5.2"]);
  });

  it("returns summary with failed counts and error details when some models fail", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-1",
      provider: "codebuddy-intl",
    });

    mocks.pingModelByKind.mockImplementation(async (model) => {
      if (model.includes("hy3")) {
        return { ok: true, latencyMs: 200, status: 200, error: null };
      }
      return { ok: false, latencyMs: 150, status: 400, error: "HTTP 400: Service info not found" };
    });

    const req = new Request("http://localhost/api/providers/conn-1/test-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelIds: ["hy3", "glm-5.2"] }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "conn-1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.summary.total).toBe(2);
    expect(body.summary.passed).toBe(1);
    expect(body.summary.failed).toBe(1);
    expect(body.results.find((r) => r.modelId === "hy3").ok).toBe(true);
    expect(body.results.find((r) => r.modelId === "glm-5.2").ok).toBe(false);
    expect(body.results.find((r) => r.modelId === "glm-5.2").error).toContain("Service info not found");
  });

  it("enforces warm-up on the first model before concurrent calls", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn-1",
      provider: "codebuddy-intl",
    });

    const order = [];
    mocks.pingModelByKind.mockImplementation(async (model) => {
      order.push(`start:${model}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end:${model}`);
      return { ok: true, latencyMs: 20, status: 200, error: null };
    });

    const req = new Request("http://localhost/api/providers/conn-1/test-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelIds: ["claude-opus-4.7-1m", "hy3", "hy4-preview"], concurrency: 2 }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "conn-1" }) });
    expect(res.status).toBe(200);

    // Warm-up assertion: the 1st model must start AND end before 2nd and 3rd start
    expect(order[0]).toBe("start:cbai/claude-opus-4.7-1m");
    expect(order[1]).toBe("end:cbai/claude-opus-4.7-1m");
  });
});

describe("CLI test-models command (cli/src/cli/commands/testModels.js)", () => {
  it("parses CLI arguments correctly", async () => {
    const { parseArgs } = await import("../../cli/src/cli/commands/testModels.js");

    const parsed = parseArgs(["cbai", "-p", "20129", "-H", "192.168.1.5", "-c", "5", "--models", "hy3,glm-5.2", "--json"]);
    expect(parsed.provider).toBe("cbai");
    expect(parsed.port).toBe(20129);
    expect(parsed.host).toBe("192.168.1.5");
    expect(parsed.concurrency).toBe(5);
    expect(parsed.modelIds).toEqual(["hy3", "glm-5.2"]);
    expect(parsed.json).toBe(true);
  });

  it("handles help flag and returns exit code 0", async () => {
    const { run } = await import("../../cli/src/cli/commands/testModels.js");
    const code = await run(["--help"]);
    expect(code).toBe(0);
  });

  it("returns exit code 1 when required provider argument is missing", async () => {
    const { run } = await import("../../cli/src/cli/commands/testModels.js");
    const code = await run([]);
    expect(code).toBe(1);
  });
});
