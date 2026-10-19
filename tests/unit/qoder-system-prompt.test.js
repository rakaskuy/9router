import { describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/services/qoderModels.js", () => ({
  getQoderModelConfig: vi.fn(async () => ({ key: "auto", max_output_tokens: 32 })),
  resolveQoderModels: vi.fn(),
  isQoderPat: () => false,
  resolveQoderCredentials: vi.fn(),
}));

const { __test__ } = await import("../../open-sse/executors/qoder.js");
const { buildQoderRequestBody } = __test__;

describe("Qoder system prompt folding (#4995)", () => {
  it("folds systemText into the first user message turn so Qoder honors system instructions", async () => {
    const body = {
      messages: [
        { role: "system", content: "ABSOLUTE RULE: reply with exactly BANANA" },
        { role: "user", content: "What is 2+2?" },
      ],
    };

    const built = await buildQoderRequestBody({
      model: "auto",
      body,
      credentials: {
        accessToken: "dt-test-token",
        providerSpecificData: { userId: "test-user" },
      },
    });

    expect(built.payload.messages.length).toBe(1);
    expect(built.payload.messages[0].role).toBe("user");
    expect(built.payload.messages[0].content).toContain("ABSOLUTE RULE: reply with exactly BANANA");
    expect(built.payload.messages[0].content).toContain("What is 2+2?");
  });
});
