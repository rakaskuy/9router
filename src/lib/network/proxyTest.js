import { ProxyAgent, fetch as undiciFetch } from "undici";

const DEFAULT_TEST_URL = "https://google.com/";
const DEFAULT_TIMEOUT_MS = 8000;

function getErrorMessage(err) {
  if (!err) return "Unknown error";
  const base = err?.message || String(err);
  const causeCode = err?.cause?.code || err?.code;
  const causeMessage = err?.cause?.message;

  if (causeMessage && causeMessage !== base) {
    return causeCode ? `${base}: ${causeMessage} (${causeCode})` : `${base}: ${causeMessage}`;
  }

  if (causeCode && !base.includes(causeCode)) {
    return `${base} (${causeCode})`;
  }

  return base;
}

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

let _socksAgentPromise = null;

async function createSocksAgent(proxyUrl) {
  if (!_socksAgentPromise) {
    _socksAgentPromise = import("socks-proxy-agent")
      .then((m) => m.SocksProxyAgent || m.default?.SocksProxyAgent || m.default)
      .catch((e) => {
        console.warn(`[proxyTest] socks-proxy-agent unavailable: ${e?.message || e}`);
        return null;
      });
  }
  const SocksProxyAgent = await _socksAgentPromise;
  if (!SocksProxyAgent) throw new Error("socks-proxy-agent unavailable");
  return new SocksProxyAgent(proxyUrl);
}

/** Minimal HEAD probe over a node Agent (SOCKS), shaped like a fetch Response. */
function socksHeadRequest(url, agent, signal) {
  return import("node:url").then(({ URL: NodeURL }) => {
    const parsed = new NodeURL(url);
    const protoMod = parsed.protocol === "http:" ? import("node:http") : import("node:https");
    return protoMod.then((mod) => {
      const lib = mod.default ?? mod;
      return new Promise((resolve, reject) => {
        const req = lib.request(
          parsed,
          { method: "HEAD", agent, headers: { "User-Agent": "9Router" } },
          (res) => {
            res.resume();
            resolve({
              ok: (res.statusCode || 500) >= 200 && (res.statusCode || 500) < 400,
              status: res.statusCode || 500,
              statusText: res.statusMessage || "",
            });
          },
        );
        if (signal) {
          if (signal.aborted) req.destroy(new Error("aborted"));
          else signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
        }
        req.on("error", reject);
        req.end();
      });
    });
  });
}

export async function testProxyUrl({ proxyUrl, testUrl, timeoutMs } = {}) {
  const normalizedProxyUrl = normalizeString(proxyUrl);
  if (!normalizedProxyUrl) {
    return { ok: false, status: 400, error: "proxyUrl is required" };
  }

  const normalizedTestUrl = normalizeString(testUrl) || DEFAULT_TEST_URL;
  const timeoutMsRaw = Number(timeoutMs);
  const normalizedTimeoutMs =
    Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.min(timeoutMsRaw, 30000)
      : DEFAULT_TIMEOUT_MS;

  let dispatcher;

  try {
    const isSocks = /^socks(4|4a|5|5h)?:/i.test(normalizedProxyUrl);

    try {
      // undici's ProxyAgent accepts a socks5:// URI and then fails at connect
      // time, so a SOCKS pool would always report "error" without this branch.
      dispatcher = isSocks
        ? await createSocksAgent(normalizedProxyUrl)
        : new ProxyAgent({ uri: normalizedProxyUrl });
    } catch (err) {
      return {
        ok: false,
        status: 400,
        error: `Invalid proxy URL: ${err?.message || String(err)}`,
      };
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), normalizedTimeoutMs);

    try {
      // socks-proxy-agent yields a node Agent, not an undici dispatcher, so the
      // SOCKS branch goes through node:http(s) instead of undiciFetch.
      const res = isSocks
        ? await socksHeadRequest(normalizedTestUrl, dispatcher, controller.signal)
        : await undiciFetch(normalizedTestUrl, {
          method: "HEAD",
          dispatcher,
          signal: controller.signal,
          headers: {
            "User-Agent": "9Router",
          },
        });

      return {
        ok: res.ok || (res.status >= 200 && res.status < 400),
        status: res.status,
        statusText: res.statusText,
        url: normalizedTestUrl,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      const message =
        err?.name === "AbortError"
          ? "Proxy test timed out"
          : getErrorMessage(err);
      return { ok: false, status: 500, error: message };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    try {
      await dispatcher?.close?.();
    } catch {
      // ignore
    }
  }
}
