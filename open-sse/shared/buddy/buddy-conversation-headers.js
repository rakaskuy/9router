/**
 * Buddy conversation & tracing header family (Tencent CodeBuddy / WorkBuddy).
 *
 * Ported from risunCodex/Cartethyia
 * (`src/providers/integrations/buddy/buddy-conversation-headers.ts`) after
 * live measurement against `https://www.codebuddy.ai/v2/chat/completions` on
 * 2026-10-19 (see `.skills/cartethyia-reverse-engineering/references/
 * codebuddy-dispatch-headers.md` in that repo).
 *
 * ## What the measurement found
 *
 * Exactly three headers are mandatory. Removing any one of them yields
 * `400 · 11128 "request illegal"`:
 *
 *   x-conversation-id            required
 *   x-conversation-request-id    required
 *   x-conversation-message-id    required
 *
 * Everything else in the client's real request — the B3 set, W3C
 * `traceparent`, `x-request-id`/`x-root-request-id`/`x-trace-id`, the
 * stainless set, the agent block and the IDE block — answers 200 when dropped.
 * They are still sent because they are part of what a real client emits, and
 * matching the client is the defence against a channel check tightening.
 *
 * The requirement is **turn-shaped, not id-shaped**: `x-conversation-id: ""`
 * is refused exactly like an absent header, so a caller with no session must
 * be given a generated id rather than having a blank value forwarded.
 *
 * ## Four lifetimes, which is why one id is not enough
 *
 * - `X-Conversation-ID` — conversation-scoped, stable across turns. Passed
 *   through from the client when one arrives; otherwise generated per dispatch
 *   (never a blank), because withholding it guarantees a refusal.
 * - `X-Conversation-Request-ID` / `X-Root-Request-ID` — turn-scoped
 *   aggregation key. Every tool call, retry, failover and degradation inside
 *   one user send reuses the same value so the backend aggregates them into a
 *   single record instead of fragmenting.
 * - `X-Conversation-Message-ID` = `X-Request-ID` — message-scoped, fresh per
 *   outbound message.
 * - `X-B3-TraceId` / `X-B3-SpanId` / `X-B3-Sampled` — the B3 trace family.
 *
 * B3 is stricter than the rest: the spec accepts only a 16- or 32-character
 * hex trace id and a 16-character hex span id. An inbound conversation id is
 * arbitrary (it may carry dashes or be non-hex), and putting it straight into
 * `X-B3-TraceId` breaks trace correlation — so it is validated and falls back
 * to the message id, which is always 32 hex.
 */

import crypto from "node:crypto";

/** A 32-character hex id, the shape the upstream's own message ids use. */
export function newBuddyMessageId() {
  return crypto.randomUUID().replace(/-/g, "");
}

/** True when `value` is a valid B3 trace id: 16 or 32 hex characters. */
export function isValidB3TraceId(value) {
  if (typeof value !== "string") return false;
  if (value.length !== 16 && value.length !== 32) return false;
  if (!/^[0-9a-fA-F]+$/.test(value)) return false;
  // An all-zero trace id is invalid per the B3 spec.
  if (/^0+$/.test(value)) return false;
  return true;
}

/**
 * Builds the conversation/tracing headers for one outbound chat request.
 *
 * @param {object} [ids]
 * @param {string} [ids.conversationId] Conversation-scoped id from the client.
 * @param {string} [ids.conversationRequestId] Turn-scoped aggregation key.
 * @param {string} [ids.traceId] Inbound trace id to pass through.
 * @returns {Record<string, string>} Headers to merge into the outbound request.
 */
export function buddyConversationHeaders(ids = {}) {
  const rawRequestId = typeof ids.conversationRequestId === "string" ? ids.conversationRequestId.trim() : "";
  const conversationRequestId = rawRequestId.length > 0 ? rawRequestId : newBuddyMessageId();
  const messageId = newBuddyMessageId();
  const rawTraceId = typeof ids.traceId === "string" ? ids.traceId.trim() : "";
  const traceId = rawTraceId.length > 0 ? rawTraceId : conversationRequestId;
  // B3 accepts hex only. A conversation/request id built from a UUID is 32 hex,
  // but an inbound client id may carry dashes — fall back to the message id,
  // which is always 32 hex.
  const b3TraceId = isValidB3TraceId(conversationRequestId) ? conversationRequestId : messageId;
  const spanId = messageId.slice(0, 16);

  const headers = {
    "x-conversation-request-id": conversationRequestId,
    "x-conversation-message-id": messageId,
    "x-request-id": messageId,
    "x-root-request-id": conversationRequestId,
    "x-trace-id": traceId,
    // W3C trace context alongside the B3 set below: the upstream reads both,
    // and every reference request carries `traceparent`.
    traceparent: `00-${b3TraceId}-${spanId}-01`,
    "x-b3-traceid": b3TraceId,
    "x-b3-spanid": spanId,
    "x-b3-sampled": "1",
  };

  // Always sent, generated when the caller gave none. A blank value is refused
  // exactly like an absent header, so a whitespace id must fall back rather
  // than be forwarded.
  const rawConversationId = typeof ids.conversationId === "string" ? ids.conversationId.trim() : "";
  headers["x-conversation-id"] = rawConversationId.length > 0 ? rawConversationId : newBuddyMessageId();

  return headers;
}
