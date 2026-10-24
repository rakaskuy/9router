/**
 * The header family only the CodeBuddy CLI identity sends.
 *
 * Ported from risunCodex/Cartethyia
 * (`src/providers/integrations/buddy/buddy-cli-headers.ts`).
 *
 * Two reference clients, two fingerprints: the hub derives OS/arch and a Node
 * version from its own host, while codebuddy2api pins a fixed
 * Linux/x64/v24.21.0 set. Neither can be right for every deployment, so the
 * values here follow the host this gateway actually runs on — they are a
 * fingerprint of the process, not a claim about a remote machine.
 *
 * A request carrying both the browser half (`X-Requested-With`,
 * `x-codebuddy-request`) and the CLI half is a hybrid no real client produces,
 * which is what risk control keys on. Each identity therefore sends only its
 * own half.
 */

/** OpenAI Node SDK 6.25.0 `x-stainless-*` fingerprint; both references agree. */
export const STAINLESS_PACKAGE_VERSION = "6.25.0";

function hostOs() {
  if (process.platform === "win32") return "Windows";
  if (process.platform === "darwin") return "MacOS";
  return "Linux";
}

function hostArch() {
  return process.arch === "arm64" || process.arch === "ia32" ? process.arch : "x64";
}

/**
 * The SDK fingerprint headers.
 *
 * `x-stainless-timeout` is in the hub only and `x-stainless-retry-count` is in
 * both; the SDK sends both, so both go out.
 */
export function buddyStainlessHeaders() {
  return {
    "x-stainless-lang": "js",
    "x-stainless-package-version": STAINLESS_PACKAGE_VERSION,
    "x-stainless-os": hostOs(),
    "x-stainless-arch": hostArch(),
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "x-stainless-retry-count": "0",
    "x-stainless-timeout": "1200",
  };
}

/**
 * The trace family the CLI carries as a child span.
 *
 * The desktop product omits the parent; the CLI conversation request is a child
 * span, so it also sends B3's fourth field and `X-B3-ParentSpanId`.
 * `buddyConversationHeaders` already produces `traceparent`, `b3`, and the
 * `X-B3-*` set, so only the parent is added here.
 */
export function buddyCliTraceHeaders(conversation) {
  const traceId = conversation["x-trace-id"] ?? conversation["x-b3-traceid"];
  const spanId = conversation["x-b3-spanid"];
  if (traceId === undefined) return {};
  const b3 = `${traceId}-${spanId ?? traceId.slice(0, 16)}-1-${traceId.slice(0, 16)}`;
  return { ...(spanId === undefined ? {} : { "X-B3-ParentSpanId": spanId }), b3 };
}

/**
 * The full CLI identity envelope, minus what each caller already supplies.
 *
 * The caller keeps ownership of `User-Agent`, `X-IDE-*`, `X-Domain`, and the
 * conversation family, because those vary by provider and realm: only the
 * headers that are the same for every CLI dispatch are built here.
 *
 * @param {{ userId: string }} args
 */
export function buddyCliHeaders({ userId }) {
  return {
    "X-Agent-Intent": "craft",
    "X-Agent-Type": "main",
    // The reference enum is local-agent / cloud-agent / agent-agent, and its
    // parser returns "other" for anything unknown or absent. A gateway is none
    // of the three, so "other" is the honest value rather than a guess.
    "X-Agent-Runtime": "other",
    "X-User-Id": userId,
    // Personal accounts are not an enterprise and the reference sends the flag
    // either way (`true` only for an enterprise id), so the non-enterprise
    // default goes out here.
    "X-Private-Data": "false",
    ...buddyStainlessHeaders(),
  };
}
