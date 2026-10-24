/**
 * Chat-wire payload and message normalization shared by the Tencent "buddy"
 * family providers — CodeBuddy International (`codebuddy-intl`), CodeBuddy CN
 * (`codebuddy-cn`), and WorkBuddy.
 *
 * Ported from risunCodex/Cartethyia
 * (`src/providers/integrations/buddy/buddy-chat-shared.ts`). All three speak
 * the same upstream contract for this part of the payload, so the rules live
 * here once instead of being copied per variant:
 *
 * - streaming is mandatory (`stream=true`) — a non-stream chat answers `11101`;
 * - `reasoning_summary` is opted in only when a `reasoning_effort` is
 *   requested;
 * - the agent-namespace fields are never forwarded;
 * - caller `system`/`developer` turns are dropped and replaced by the
 *   variant's fixed leading system prompt, and bare string user content
 *   becomes a typed text block; and
 * - consecutive same-role `user` turns are merged before dispatch, because the
 *   upstream merges them itself and silently drops `image_url` parts while
 *   doing so.
 *
 * ## Why the leading system turn is fixed
 *
 * The upstream validates that the wire *opens* with a `system` turn
 * (`11128 "first message is not system prompt"`). Substituting caller text in
 * that slot answers `11128 "Illegal API invocation from an unapproved
 * channel"` on CodeBuddy — it reads the prompt as the calling channel's
 * identity — and forwarding caller text as a `developer` turn is rejected too.
 * Only the prompt *text* differs per variant, which is why the caller passes
 * it in.
 */

const BUDDY_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const INVALID_BUDDY_TOOL_NAME_CHARS = /[^a-zA-Z0-9_-]/g;
const MAX_BUDDY_TOOL_NAME_LENGTH = 64;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uniqueToolName(base, used) {
  const clipped = (base || "tool").slice(0, MAX_BUDDY_TOOL_NAME_LENGTH);
  if (!used.has(clipped)) return clipped;
  for (let suffix = 2; ; suffix += 1) {
    const suffixText = `_${suffix}`;
    const candidate = `${clipped.slice(0, MAX_BUDDY_TOOL_NAME_LENGTH - suffixText.length)}${suffixText}`;
    if (!used.has(candidate)) return candidate;
  }
}

function normalizedToolName(value, index, used) {
  const base =
    BUDDY_TOOL_NAME_PATTERN.test(value) && value.length <= MAX_BUDDY_TOOL_NAME_LENGTH
      ? value
      : value.replace(INVALID_BUDDY_TOOL_NAME_CHARS, "");
  return uniqueToolName(base || `tool_${index + 1}`, used);
}

/**
 * Buddy's Chat Completions wire has no `web_search_preview` hosted tool; its
 * search is an ordinary function named `web_search` with a `{query}` schema.
 * Rewriting the hosted declaration here lets the caller's own tool loop run the
 * query at `POST /v1/search`. The gateway never executes it: an unexecuted call
 * is returned to the caller like any other function call.
 */
function buddyHostedSearchFunction(rawTool) {
  const type = rawTool["type"];
  if (type !== "web_search" && type !== "web_search_preview") return undefined;
  return {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  };
}

/**
 * Normalizes tool names to the buddy wire's `[a-zA-Z0-9_-]{1,64}` shape,
 * rewrites hosted search declarations into ordinary functions, and applies the
 * same rename to historical `tool_calls` and `tool_choice`.
 *
 * @param {Record<string, unknown>} payload
 */
export function normalizeBuddyToolNames(payload) {
  if (!Array.isArray(payload["tools"])) return;
  const used = new Set();
  const replacements = new Map();
  payload["tools"] = payload["tools"].map((rawTool, index) => {
    if (!isRecord(rawTool)) return rawTool;
    const hostedSearch = buddyHostedSearchFunction(rawTool);
    if (hostedSearch !== undefined) {
      used.add("web_search");
      return hostedSearch;
    }
    const fn = isRecord(rawTool["function"]) ? rawTool["function"] : undefined;
    const custom = isRecord(rawTool["custom"]) ? rawTool["custom"] : undefined;
    const sourceName = fn?.["name"] ?? custom?.["name"] ?? rawTool["name"];
    if (typeof sourceName !== "string") return rawTool;
    const name = normalizedToolName(sourceName, index, used);
    used.add(name);
    if (!replacements.has(sourceName)) replacements.set(sourceName, name);
    if (fn !== undefined) return { ...rawTool, function: { ...fn, name } };
    if (custom !== undefined) return { ...rawTool, custom: { ...custom, name } };
    return { ...rawTool, name };
  });

  const messages = payload["messages"];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRecord(message) || !Array.isArray(message["tool_calls"])) continue;
      for (const call of message["tool_calls"]) {
        if (!isRecord(call) || !isRecord(call["function"])) continue;
        const name = call["function"]["name"];
        const replacement = typeof name === "string" ? replacements.get(name) : undefined;
        if (replacement !== undefined) call["function"]["name"] = replacement;
      }
    }
  }

  const choice = payload["tool_choice"];
  if (isRecord(choice) && isRecord(choice["function"])) {
    const name = choice["function"]["name"];
    const replacement = typeof name === "string" ? replacements.get(name) : undefined;
    if (replacement !== undefined) {
      payload["tool_choice"] = { ...choice, function: { ...choice["function"], name: replacement } };
    }
  }
}

/**
 * `tool_choice` on the buddy wire is a Go string — the object form 400s with
 * code `11101`. Normalize every accepted shape to the wire string.
 */
export function normalizeBuddyToolChoice(payload) {
  if (!("tool_choice" in payload)) return;
  const tc = payload["tool_choice"];
  if (typeof tc === "string") {
    // `none` means "do not call this turn", not "forget the tool schemas".
    // Deleting tools makes DeepSeek emit unparseable DSML text instead.
    if (tc.trim().toLowerCase() === "none") payload["tool_choice"] = "none";
    return;
  }
  if (isRecord(tc)) {
    const typ = typeof tc["type"] === "string" ? tc["type"].trim().toLowerCase() : "";
    if (typ === "none") {
      payload["tool_choice"] = "none";
    } else if (typ === "auto" || typ === "required") {
      payload["tool_choice"] = typ;
    } else if (typ === "function") {
      let name = "";
      const fn = tc["function"];
      if (isRecord(fn) && typeof fn["name"] === "string") name = fn["name"];
      if (!name && typeof tc["name"] === "string") name = tc["name"];
      name = name.trim();
      payload["tool_choice"] = name.length > 0 ? name : "auto";
    } else {
      delete payload["tool_choice"];
    }
    return;
  }
  delete payload["tool_choice"];
}

/**
 * `image_url` may be a bare string on the OpenAI wire but must be `{url}` on
 * the buddy wire.
 */
export function normalizeBuddyImageUrl(payload, maxImages = 32) {
  const messages = payload["messages"];
  if (!Array.isArray(messages)) return;
  let kept = 0;
  for (const m of messages) {
    if (!isRecord(m)) continue;
    const content = m["content"];
    if (!Array.isArray(content)) continue;
    for (let index = 0; index < content.length; index += 1) {
      const part = content[index];
      if (!isRecord(part)) continue;
      if (part["type"] !== "image_url") continue;
      const v = part["image_url"];
      if (typeof v === "string") {
        if (v.length === 0) continue;
        part["image_url"] = { url: v };
      }
      kept += 1;
      if (kept > maxImages) {
        content[index] = { type: "text", text: "[image omitted: too many attachments]" };
      }
    }
  }
}

/** The buddy wire whitelist rejects `developer` (`11128`); fold it into `system`. */
export function normalizeBuddyRoles(payload) {
  const messages = payload["messages"];
  if (!Array.isArray(messages)) return;
  for (const m of messages) {
    if (!isRecord(m)) continue;
    if (m["role"] === "developer") m["role"] = "system";
  }
}

/** Normalizes one message's content into a Chat-wire content-part array. */
function contentParts(content) {
  if (typeof content === "string") return content.length === 0 ? [] : [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((part) => part !== null && typeof part === "object");
}

/**
 * Coalesces consecutive `user` messages into one, preserving content-part
 * order. The buddy upstream merges consecutive same-role turns itself and
 * drops `image_url` parts while doing so, so an attachment delivered as its
 * own user turn (the shape VS Code Copilot emits for a pasted screenshot)
 * reaches the model as text only — the image is silently gone even though the
 * gateway forwarded it. Merging here keeps every image in the same message as
 * the text the caller sent alongside it.
 *
 * Lossless: only adjacent same-role `user` turns merge, and every part is
 * retained in order. Assistant/tool/system turns are untouched.
 */
export function coalesceConsecutiveUserMessages(messages) {
  const out = [];
  for (const message of messages) {
    const previous = out[out.length - 1];
    if (message["role"] !== "user" || previous?.["role"] !== "user") {
      out.push(message);
      continue;
    }
    out[out.length - 1] = {
      ...previous,
      content: [...contentParts(previous["content"]), ...contentParts(message["content"])],
    };
  }
  messages.length = 0;
  messages.push(...out);
}

/**
 * Drops turns the upstream rejects with `11151` — an empty `content` with no
 * tool call, tool result, or reasoning payload behind it.
 */
export function dropEmptyBuddyMessages(messages) {
  const kept = messages.filter((message) => {
    if (!isRecord(message)) return true;
    if (Array.isArray(message["tool_calls"]) && message["tool_calls"].length > 0) return true;
    if (typeof message["tool_call_id"] === "string" && message["tool_call_id"].trim().length > 0) return true;
    if (typeof message["reasoning_content"] === "string") return true;
    const content = message["content"];
    if (typeof content === "string") return content.trim().length > 0;
    if (Array.isArray(content)) return content.length > 0;
    // Null content with no tool/reasoning load is a bare turn the upstream
    // rejects — drop it rather than dispatch a known-invalid payload.
    return false;
  });
  if (kept.length === messages.length) return;
  messages.length = 0;
  messages.push(...kept);
}

/**
 * Guarantees the wire opens with a `system` turn. The buddy upstream rejects a
 * first message that is not a system prompt (code `11128`), and a neutralized
 * or caller-less history can otherwise arrive with a bare `user` turn first.
 */
export function ensureBuddyLeadingSystem(messages, systemPrompt) {
  if (messages.length === 0) {
    messages.push({ role: "system", content: systemPrompt });
    return;
  }
  const first = messages[0];
  if (isRecord(first) && first["role"] === "system") return;
  messages.unshift({ role: "system", content: systemPrompt });
}

/**
 * Runs the full buddy message-envelope tail shared by every variant: merge
 * consecutive user turns, drop empty-content turns, then guarantee a leading
 * system turn.
 */
export function finalizeBuddyMessages(messages, systemPrompt) {
  coalesceConsecutiveUserMessages(messages);
  dropEmptyBuddyMessages(messages);
  ensureBuddyLeadingSystem(messages, systemPrompt);
}

/**
 * Applies the buddy-family message envelope in place: drop caller
 * `system`/`developer` turns, install the variant's fixed leading system
 * prompt, rebuild bare string user content as a typed text block, then
 * coalesce consecutive user turns.
 *
 * @param {Array<Record<string, unknown>>} messages
 * @param {string} systemPrompt
 */
export function applyBuddySystemPrompt(messages, systemPrompt) {
  const source = messages.filter(
    (message) => message["role"] !== "system" && message["role"] !== "developer",
  );
  messages.length = 0;
  messages.push({ role: "system", content: systemPrompt });
  for (const message of source) {
    if (message["role"] === "user" && typeof message["content"] === "string") {
      messages.push({ ...message, content: [{ type: "text", text: message["content"] }] });
    } else {
      messages.push({ ...message });
    }
  }
  finalizeBuddyMessages(messages, systemPrompt);
}

/**
 * The payload prefix shared by every buddy pre-payload hook.
 *
 * @param {Record<string, unknown>} payload
 * @param {string} systemPrompt
 * @param {{ dropSystem?: boolean }} [opts]
 */
export function buddyPrePayloadCommon(payload, systemPrompt, opts = {}) {
  // Canonical upstream renames: max_completion_tokens is the OpenAI compat
  // alias, buddy only reads max_tokens.
  if (payload["max_tokens"] === undefined && payload["max_completion_tokens"] !== undefined) {
    const v = payload["max_completion_tokens"];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) payload["max_tokens"] = v;
  }
  delete payload["max_completion_tokens"];

  normalizeBuddyToolChoice(payload);
  normalizeBuddyImageUrl(payload);
  normalizeBuddyRoles(payload);

  payload["stream"] = true;

  const effort = payload["reasoning_effort"];
  if (effort === "none" || effort === "off") {
    delete payload["reasoning_effort"];
    delete payload["reasoning_summary"];
  } else if (typeof effort === "string" && effort.length > 0) {
    payload["reasoning_summary"] = "auto";
  } else {
    delete payload["reasoning_summary"];
  }

  // Agent-namespace fields are never part of the chat wire.
  delete payload["agent"];
  delete payload["agent_mode"];
  delete payload["agent_prompt"];

  const messages = payload["messages"];
  if (Array.isArray(messages)) {
    if (opts.dropSystem) {
      applyBuddySystemPrompt(messages, systemPrompt);
    } else {
      finalizeBuddyMessages(messages, systemPrompt);
    }
  }

  normalizeBuddyToolNames(payload);
}
