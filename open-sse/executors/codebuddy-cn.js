import { DefaultExecutor } from "./default.js";
import { refreshCodebuddyToken, refreshCodebuddyIntlToken } from "../services/tokenRefresh.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { buddyConversationHeaders } from "../shared/buddy/buddy-conversation-headers.js";
import { buddyCliHeaders, buddyCliTraceHeaders } from "../shared/buddy/buddy-cli-headers.js";
import {
  applyBuddySystemPrompt,
  buddyPrePayloadCommon,
  coalesceConsecutiveUserMessages,
  dropEmptyBuddyMessages,
  ensureBuddyLeadingSystem,
} from "../shared/buddy/buddy-chat-shared.js";

/**
 * Client identity behind the per-request CodeBuddy headers.
 *
 * Ported from risunCodex/Cartethyia: the desktop product sends conversation
 * headers plus browser transport, while the CLI sends the agent envelope plus
 * the OpenAI Node SDK fingerprint and no browser headers at all. A request
 * carrying both halves is a hybrid no real client produces, which is what risk
 * control keys on.
 */
const CODEBUDDY_VERSION = "2.169.0";

/**
 * Leading system turn for the international variant.
 *
 * The upstream validates that the wire *opens* with a `system` turn (code
 * `11128`) and validates its text: substituting caller text there answers
 * `11128 "Illegal API invocation from an unapproved channel"`, because it
 * reads that prompt as the calling channel's identity. So this text is a wire
 * contract rather than a product choice, and caller `system`/`developer` turns
 * are dropped rather than merged into it.
 */
export const CODEBUDDY_SYSTEM_PROMPT =
  "You are a pragmatic and direct software engineering assistant. " +
  "Be honest and truthful: state what you know, say plainly when you are unsure " +
  "or do not know, and never claim to have done something you have not done. " +
  "Prefer concrete answers over filler, and say so when a request is ambiguous " +
  "instead of guessing silently.";

/** CN neutralizer — replaces flagged agent prompts, keeps legitimate caller ones. */
const CODEBUDDY_CN_NEUTRAL_PROMPT =
  "You are a helpful AI assistant that helps with software engineering tasks.";

const CN_AGENT_PATTERN =
  /you are claude code|claude.?code.+official.+cli|anthropic.+official.+cli|anxthxropic.+official.+cli|you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)|you are an? (?:ai )?(?:coding |code )?agent|cc_entrypoint\s*=\s*(?:cli|vscode|jetbrains|gui)|claude.?code.+issues|give feedback.+claude.?code|you are .{0,30}(?:powerful )?ai agent|orchestration capabilities|OhMyOpenCode|<agent-identity>|<Role>|<Behavior_Instructions>/i;

// Mapping for retired/deprecated model IDs to their active successors upstream
const CODEBUDDY_RETIRED_MODEL_MAP = {
  "hy3-preview": "hy3",
  "glm-4.7": "glm-5.2",
  "glm-5.0": "glm-5.2",
  "glm-5.0-turbo": "glm-5.3-flash",
  "minimax-m2.7": "minimax-m3",
  "deepseek-v3-2-volc": "deepseek-v4.1-flash",
  "deepseek-v4-pro": "deepseek-v4.1-flash",
  "kimi-k3-1": "kimi-k2.8-preview",
};

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

function flattenContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

function neutralizeCnMessages(messages) {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== "system") continue;
    const content = message.content;
    const text = flattenContent(content);
    if (text.length <= 2000 && !CN_AGENT_PATTERN.test(text)) continue;
    messages[index] =
      typeof content === "string"
        ? { ...message, content: CODEBUDDY_CN_NEUTRAL_PROMPT }
        : { ...message, content: [{ type: "text", text: CODEBUDDY_CN_NEUTRAL_PROMPT }] };
  }
}

/**
 * The upstream blocks any request whose message text quotes its own error code
 * `11128` — a tool result echoing an error page is enough to get refused.
 */
function rewriteBlockedCode(messages) {
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    for (const field of ["content", "reasoning_content"]) {
      const value = message[field];
      if (typeof value === "string") {
        if (value.includes("11128")) message[field] = value.split("11128").join("11-128");
      } else if (Array.isArray(value)) {
        for (const part of value) {
          if (part && typeof part === "object" && typeof part.text === "string" && part.text.includes("11128")) {
            part.text = part.text.split("11128").join("11-128");
          }
        }
      }
    }
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const fn = call && typeof call === "object" ? call.function : null;
        if (fn && typeof fn.arguments === "string" && fn.arguments.includes("11128")) {
          fn.arguments = fn.arguments.split("11128").join("11-128");
        }
      }
    }
  }
}

/**
 * Tencent CodeBuddy Executor (codebuddy-cn / codebuddy-intl).
 *
 * Chat wire contract follows risunCodex/Cartethyia: force stream, fixed leading
 * system prompt, the conversation/tracing header family, and the CLI identity
 * envelope. Only three headers are mandatory upstream
 * (`x-conversation-id`, `x-conversation-request-id`,
 * `x-conversation-message-id`); the rest are sent because a real client sends
 * them.
 */
export class CodeBuddyExecutor extends DefaultExecutor {
  constructor(provider = "codebuddy-cn") {
    super(provider);
  }

  buildHeaders(credentials, stream = true, url, model, transformedBody) {
    const headers = super.buildHeaders(credentials, true);
    const rawHeaders = credentials?.rawHeaders || {};
    const isCn = this.provider === "codebuddy-cn";

    const domain =
      credentials?.providerSpecificData?.domain ||
      (isCn ? "copilot.tencent.com" : "www.codebuddy.ai");

    // Conversation-scoped id: inbound header, then body hint, then the existing
    // session resolver. A blank or absent value is generated inside
    // buddyConversationHeaders — withholding the header guarantees a refusal.
    const headerConvId = getHeaderCaseInsensitive(rawHeaders, "x-conversation-id");
    const bodyConvId =
      transformedBody?.conversation_id ||
      transformedBody?.session_id ||
      transformedBody?.metadata?.conversation_id ||
      transformedBody?.metadata?.session_id;

    let conversationId = headerConvId || bodyConvId;
    if (!conversationId) {
      try {
        conversationId = resolveSessionId({
          headers: rawHeaders,
          body: transformedBody,
          connectionId: credentials?.connectionId,
          scope: this.provider,
        });
      } catch {
        conversationId = undefined;
      }
    }

    const inboundReqId =
      getHeaderCaseInsensitive(rawHeaders, "x-conversation-request-id") ||
      getHeaderCaseInsensitive(rawHeaders, "x-root-request-id");
    const inboundTraceId = getHeaderCaseInsensitive(rawHeaders, "x-trace-id");

    const conversation = buddyConversationHeaders({
      ...(conversationId ? { conversationId } : {}),
      ...(inboundReqId ? { conversationRequestId: inboundReqId } : {}),
      ...(inboundTraceId ? { traceId: inboundTraceId } : {}),
    });

    // Inbound B3 sampled=0 is preserved; the helper always emits "1".
    const inboundSampled = getHeaderCaseInsensitive(rawHeaders, "x-b3-sampled");
    if (inboundSampled === "0") conversation["x-b3-sampled"] = "0";

    const userId =
      credentials?.providerSpecificData?.userId ||
      credentials?.userId ||
      credentials?.email ||
      "anonymous";

    // Browser transport headers belong to the desktop identity only; the CLI
    // branch drops them so a request never carries both halves.
    delete headers["x-requested-with"];
    delete headers["x-codebuddy-request"];

    Object.assign(headers, {
      "Content-Type": "application/json; charset=utf-8",
      accept: "application/json",
      "User-Agent": `CLI/${CODEBUDDY_VERSION} CodeBuddy/${CODEBUDDY_VERSION}`,
      "X-Product": "SaaS",
      "X-IDE-Type": "CLI",
      "X-IDE-Name": "CLI",
      "X-IDE-Version": CODEBUDDY_VERSION,
      "X-Domain": domain,
      "X-Agent-Purpose": "conversation",
      ...conversation,
      ...buddyCliTraceHeaders(conversation),
      ...buddyCliHeaders({ userId }),
    });

    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    const nextBody = super.transformRequest(model, body, stream, credentials);
    const isCn = this.provider === "codebuddy-cn";

    // Remap retired/deprecated model IDs to active successors
    if (nextBody.model && CODEBUDDY_RETIRED_MODEL_MAP[nextBody.model]) {
      nextBody.model = CODEBUDDY_RETIRED_MODEL_MAP[nextBody.model];
    } else if (model && CODEBUDDY_RETIRED_MODEL_MAP[model]) {
      nextBody.model = CODEBUDDY_RETIRED_MODEL_MAP[model];
    }

    if (isCn) {
      // CN: neutralize flagged agent prompts, keep legitimate caller system
      // turns, then run the shared envelope tail.
      buddyPrePayloadCommon(nextBody, CODEBUDDY_CN_NEUTRAL_PROMPT);
      if (Array.isArray(nextBody.messages)) {
        neutralizeCnMessages(nextBody.messages);
        coalesceConsecutiveUserMessages(nextBody.messages);
        dropEmptyBuddyMessages(nextBody.messages);
        ensureBuddyLeadingSystem(nextBody.messages, CODEBUDDY_CN_NEUTRAL_PROMPT);
      }
    } else {
      // Intl: the fixed leading prompt is a wire contract — caller
      // system/developer turns are dropped, not merged into it.
      buddyPrePayloadCommon(nextBody, CODEBUDDY_SYSTEM_PROMPT, { dropSystem: true });
      if (Array.isArray(nextBody.messages)) {
        applyBuddySystemPrompt(nextBody.messages, CODEBUDDY_SYSTEM_PROMPT);
      }
    }

    if (Array.isArray(nextBody.messages)) rewriteBlockedCode(nextBody.messages);
    return nextBody;
  }

  parseError(response, bodyText) {
    if (bodyText) {
      try {
        const parsed = JSON.parse(bodyText);
        const msg = parsed?.msg || parsed?.message || parsed?.error?.message || "";
        if (parsed?.code === 11128) {
          return {
            status: 400,
            message:
              "CodeBuddy channel verification failed (11128): the conversation header family or the leading system turn was rejected. " +
              String(msg).slice(0, 200),
          };
        }
        if (parsed?.code === 11102) {
          return {
            status: 400,
            message: `CodeBuddy model unavailable (11102): ${msg}. Please switch to an active model: hy3, hy4-preview, glm-5.3, glm-5.3-flash, glm-5.2, deepseek-v4.1-flash, kimi-k2.8-preview, or claude-opus-4.7-1m.`,
          };
        }
        if (parsed?.code === 11158) {
          return {
            status: 403,
            message: `CodeBuddy model not allowed for this account tier (11158): ${String(msg).slice(0, 200)}`,
          };
        }
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
