import { describe, it, expect } from "vitest";
import { claudeToOpenAIResponse } from "../../open-sse/translator/response/claude-to-openai.js";

describe("Claude to OpenAI response usage cache details (#5030)", () => {
  it("preserves cache_read_input_tokens as prompt_tokens_details.cached_tokens in final chunk", () => {
    const state = {};

    // 1. message_start carries input tokens and cache read tokens
    claudeToOpenAIResponse({
      type: "message_start",
      message: {
        id: "msg_123",
        role: "assistant",
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 8000,
          cache_creation_input_tokens: 0,
          output_tokens: 1
        }
      }
    }, state);

    // 2. content_block_delta
    claudeToOpenAIResponse({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "OK" }
    }, state);

    // 3. message_delta carries final output tokens
    const chunks = claudeToOpenAIResponse({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: {
        output_tokens: 15
      }
    }, state);

    expect(chunks).toBeDefined();
    expect(chunks.length).toBeGreaterThan(0);

    const finalChunk = chunks.find((c) => c.usage);
    expect(finalChunk).toBeDefined();
    expect(finalChunk.usage.prompt_tokens).toBe(8100);
    expect(finalChunk.usage.completion_tokens).toBe(15);
    expect(finalChunk.usage.prompt_tokens_details).toBeDefined();
    expect(finalChunk.usage.prompt_tokens_details.cached_tokens).toBe(8000);
  });
});
