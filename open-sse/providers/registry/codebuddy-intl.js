// CodeBuddy international (codebuddy.ai) — mirrors codebuddy-cn registry shape,
// swapping the Tencent CN domain for the .ai endpoint set. All OAuth/plugin URLs
// use the /v2/plugin prefix with platform=ide (CN uses platform=CLI).
export default {
  id: "codebuddy-intl",
  alias: "cbai",
  uiAlias: "cbai",
  hidden: false,
  priority: 90,
  display: {
    name: "CodeBuddy",
    icon: "smart_toy",
    color: "#006EFF",
    website: "https://www.codebuddy.ai",
    notice: {
      signupUrl: "https://www.codebuddy.ai",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    // Chat gateway is OpenAI-compatible SSE (same /v2/chat/completions path as CN).
    baseUrl: "https://www.codebuddy.ai/v2/chat/completions",
    forceStream: true,
    // CodeBuddy intl speaks the same unified OpenAI reasoning_effort shape as CN.
    thinkingFormat: "openai",
    headers: {
      "User-Agent": "CLI/2.108.1 CodeBuddy/2.108.1",
      "X-Product": "SaaS",
      "X-IDE-Type": "CLI",
      "X-IDE-Name": "CLI",
      "x-requested-with": "XMLHttpRequest",
      "x-codebuddy-request": "1",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    // Intl billing endpoint mirrors CN shape (data.Response.Data.Accounts[]).
    usage: {
      url: "https://www.codebuddy.ai/v2/billing/meter/get-user-resource",
    },
  },
  // Live model lineup exposed by the CodeBuddy International gateway (codebuddy.ai).
  // Models retired by upstream (glm-5.0, glm-4.7, glm-5.0-turbo, minimax-m2.7, hy3-preview,
  // deepseek-v4-pro, deepseek-v3-2-volc) route transparently to active successors via upstreamModelId.
  models: [
    { id: "claude-opus-4.7-1m", name: "Claude Opus 4.7 1M" },
    { id: "hy3", name: "Hy3" },
    { id: "hy4-preview", name: "Hy4-Preview" },
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash" },
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "glm-5.1", name: "GLM-5.1" },
    { id: "glm-5v-turbo", name: "GLM-5v-Turbo" },
    { id: "minimax-m3", name: "MiniMax-M3" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash" },
    { id: "kimi-k2.8-preview", name: "Kimi-K2.8-Preview" },
    { id: "kimi-k2.7", name: "Kimi-K2.7-Code" },
    { id: "kimi-k2.6", name: "Kimi-K2.6" },
    { id: "kimi-k2.5", name: "Kimi-K2.5" },
    // Aliases for retired models pointing to active successors
    { id: "hy3-preview", name: "Hy3 Preview", upstreamModelId: "hy3" },
    { id: "glm-4.7", name: "GLM-4.7", upstreamModelId: "glm-5.2" },
    { id: "glm-5.0", name: "GLM-5.0", upstreamModelId: "glm-5.2" },
    { id: "glm-5.0-turbo", name: "GLM-5.0-Turbo", upstreamModelId: "glm-5.3-flash" },
    { id: "minimax-m2.7", name: "MiniMax-M2.7", upstreamModelId: "minimax-m3" },
    { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", upstreamModelId: "deepseek-v4.1-flash" },
    { id: "deepseek-v3-2-volc", name: "DeepSeek-V3.2", upstreamModelId: "deepseek-v4.1-flash" },
  ],
  oauth: {
    baseUrl: "https://www.codebuddy.ai",
    stateUrl: "https://www.codebuddy.ai/v2/plugin/auth/state",
    tokenUrl: "https://www.codebuddy.ai/v2/plugin/auth/token",
    refreshUrl: "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
    userAgent: "IDE/2.63.2 CodeBuddy/2.63.2",
    platform: "ide",
    pollInterval: 5000,
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};
