import crypto from "crypto";
import { DefaultExecutor } from "./default.js";
import { refreshCodebuddyToken, refreshCodebuddyIntlToken } from "../services/tokenRefresh.js";
import { resolveSessionId } from "../utils/sessionManager.js";

const CODEBUDDY_SYSTEM_PROMPT = "You are CodeBuddy Code.";

const CHANNEL_MARKERS = [
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "x-anthropic-billing-header",
  "Main branch (you will usually use this for PRs):",
];

const CHANNEL_MARKER_REGEX =
  /you are claude code|claude.?code.+official.+cli|anthropic.+official.+cli|anxthxropic.+official.+cli|you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)|cc_entrypoint\s*=\s*(?:cli|vscode|jetbrains|gui)|claude.?code.+issues|give feedback.+claude.?code|OhMyOpenCode/gi;

function sanitizeChannelMarkers(text) {
  if (typeof text !== "string" || !text) return text;
  let result = text;
  for (const marker of CHANNEL_MARKERS) {
    if (result.includes(marker)) {
      result = result.split(marker).join("[external-client-identity]");
    }
  }
  return result.replace(CHANNEL_MARKER_REGEX, "[external-client-identity]");
}

function getHeaderCaseInsensitive(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;
  const target = name.toLowerCase();
  for (const [key, val] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      if (Array.isArray(val)) return val[0];
      return val;
    }
  }
  return undefined;
}

function isValidB3TraceId(val) {
  if (typeof val !== "string") return false;
  const trimmed = val.trim();
  if (!/^[0-9a-fA-F]{16}$|^[0-9a-fA-F]{32}$/.test(trimmed)) return false;
  if (/^0+$/.test(trimmed)) return false;
  return true;
}

/**
 * Tencent CodeBuddy Executor (codebuddy-cn / codebuddy-intl)
 * Uses OpenAI-compatible chat completions API with CodeBuddy CLI channel headers.
 */
export class CodeBuddyExecutor extends DefaultExecutor {
  constructor(provider = "codebuddy-cn") {
    super(provider);
  }

  buildHeaders(credentials, stream = true, url, model, transformedBody) {
    const headers = super.buildHeaders(credentials, true);
    const rawHeaders = credentials?.rawHeaders || {};

    const domain =
      credentials?.providerSpecificData?.domain ||
      (this.provider === "codebuddy-cn" ? "copilot.tencent.com" : "www.codebuddy.ai");

    // 1. Resolve conversation ID (inbound header > body > sessionResolver > UUID)
    const headerConvId = getHeaderCaseInsensitive(rawHeaders, "x-conversation-id");
    const bodyConvId =
      transformedBody?.conversation_id ||
      transformedBody?.session_id ||
      transformedBody?.metadata?.conversation_id ||
      transformedBody?.metadata?.session_id;

    let convId = headerConvId || bodyConvId;
    if (!convId) {
      try {
        convId = resolveSessionId({
          headers: rawHeaders,
          body: transformedBody,
          connectionId: credentials?.connectionId,
          scope: this.provider,
        });
      } catch {
        convId = null;
      }
    }
    if (!convId) {
      convId = crypto.randomUUID();
    }

    // 2. Request & Turn IDs
    const inboundReqId =
      getHeaderCaseInsensitive(rawHeaders, "x-conversation-request-id") ||
      getHeaderCaseInsensitive(rawHeaders, "x-root-request-id");
    const convReqId = inboundReqId ? inboundReqId.trim() : crypto.randomUUID();
    const convMsgId = crypto.randomUUID();
    const reqId = convMsgId.replace(/-/g, "");

    // 3. Distributed tracing headers
    const inboundTraceId = getHeaderCaseInsensitive(rawHeaders, "x-trace-id");
    const traceId = inboundTraceId ? inboundTraceId.trim() : convReqId;

    const inboundB3Trace = getHeaderCaseInsensitive(rawHeaders, "x-b3-traceid");
    const b3TraceId = isValidB3TraceId(inboundB3Trace)
      ? inboundB3Trace.trim().toLowerCase()
      : crypto.randomBytes(16).toString("hex");

    const b3SpanId = crypto.randomBytes(8).toString("hex");

    const inboundB3Sampled = getHeaderCaseInsensitive(rawHeaders, "x-b3-sampled");
    const b3Sampled = inboundB3Sampled === "0" ? "0" : "1";

    delete headers["x-requested-with"];
    delete headers["x-codebuddy-request"];

    Object.assign(headers, {
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": "CLI/2.108.1 CodeBuddy/2.108.1",
      "X-Product": "SaaS",
      "X-App": "cli",
      "X-IDE-Type": "CLI",
      "X-IDE-Name": "CLI",
      "X-IDE-Version": "2.108.1",
      "X-Private-Data": "false",
      "X-Requested-With": "XMLHttpRequest",
      "X-CodeBuddy-Request": "1",
      "X-Domain": domain,
      "X-Stainless-Runtime": "node",
      "X-Stainless-Runtime-Version": process.version || "v24.11.1",
      "X-Stainless-Lang": "js",
      "X-Stainless-Arch": "x64",
      "X-Stainless-Os": "Windows",
      "X-Stainless-Package-Version": "6.25.0",
      "X-Stainless-Helper-Method": "stream",
      "X-Stainless-Retry-Count": "0",
      "X-Request-ID": reqId,
      "X-Conversation-ID": convId,
      "X-Conversation-Request-ID": convReqId,
      "X-Conversation-Message-ID": convMsgId,
      "X-Root-Request-ID": convReqId,
      "X-Trace-ID": traceId,
      "X-B3-TraceId": b3TraceId,
      "X-B3-SpanId": b3SpanId,
      "X-B3-Sampled": b3Sampled,
      "X-Agent-Intent": "craft",
      "X-Agent-Purpose": "conversation",
    });

    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    const nextBody = super.transformRequest(model, body, stream, credentials);
    nextBody.stream = true;
    const effort = nextBody.reasoning_effort;
    if (effort === "none" || effort === "off") {
      delete nextBody.reasoning_effort;
    } else if (effort) {
      nextBody.reasoning_summary = "auto";
    }

    const inputMessages = Array.isArray(nextBody.messages) ? nextBody.messages : [];
    const systemParts = [CODEBUDDY_SYSTEM_PROMPT];
    const otherMessages = [];

    for (const m of inputMessages) {
      if (!m || typeof m !== "object") continue;
      if (m.role === "system" || m.role === "developer") {
        const rawText =
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content
                  .map((b) => (typeof b === "string" ? b : b && typeof b.text === "string" ? b.text : ""))
                  .join("\n")
              : "";
        const cleaned = sanitizeChannelMarkers(rawText).trim();
        if (cleaned && cleaned !== CODEBUDDY_SYSTEM_PROMPT) {
          systemParts.push(cleaned);
        }
        continue;
      }
      if (m.role === "user" && typeof m.content === "string") {
        otherMessages.push({ ...m, content: [{ type: "text", text: m.content }] });
        continue;
      }
      if (m.role === "assistant") {
        const nextMsg = { ...m };
        if (typeof nextMsg.content === "string") {
          nextMsg.content = sanitizeChannelMarkers(nextMsg.content);
        } else if (Array.isArray(nextMsg.content)) {
          nextMsg.content = nextMsg.content.map((b) =>
            b && typeof b === "object" && typeof b.text === "string"
              ? { ...b, text: sanitizeChannelMarkers(b.text) }
              : b
          );
        }
        otherMessages.push(nextMsg);
        continue;
      }
      otherMessages.push({ ...m });
    }

    nextBody.messages = [{ role: "system", content: systemParts.join("\n\n") }, ...otherMessages];
    return nextBody;
  }

  parseError(response, bodyText) {
    if (bodyText) {
      try {
        const parsed = JSON.parse(bodyText);
        const msg = parsed?.msg || parsed?.message || parsed?.error?.message || "";
        if (parsed?.code === 6004 || /超出频率限制|frequency limit|限额/i.test(msg)) {
          let resetsAtMs = null;
          const match = msg.match(
            /(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s*UTC\+?([0-9:]+))?/i
          );
          if (match) {
            const dateStr = match[1];
            const timeStr = match[2];
            const tzOffset = match[3]
              ? match[3].includes(":")
                ? match[3].startsWith("+")
                  ? match[3]
                  : `+${match[3]}`
                : `+${match[3].padStart(2, "0")}:00`
              : "+08:00";
            const parsedDate = new Date(`${dateStr}T${timeStr}${tzOffset}`);
            if (!isNaN(parsedDate.getTime())) {
              resetsAtMs = parsedDate.getTime();
            }
          }
          return {
            status: 429,
            message: msg || "CodeBuddy frequency limit (6004)",
            resetsAtMs,
          };
        }
      } catch {
        // Not JSON, fall through
      }
    }
    return super.parseError(response, bodyText);
  }

  async refreshCredentials(credentials, log) {
    if (!credentials?.refreshToken) return null;
    return this.provider === "codebuddy-intl"
      ? refreshCodebuddyIntlToken(credentials.refreshToken, log)
      : refreshCodebuddyToken(credentials.refreshToken, log);
  }
}

export default CodeBuddyExecutor;

