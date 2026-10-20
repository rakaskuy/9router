import { NextResponse } from "next/server";
import { getProviderConnectionById, getProviderConnections } from "@/lib/localDb";
import { resolveProviderId } from "@/shared/constants/providers.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import { getProviderModels, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { pingModelByKind } from "@/app/api/models/test/ping";

async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let currentIndex = 0;
  async function worker() {
    while (currentIndex < items.length) {
      const i = currentIndex++;
      results[i] = await fn(items[i], i);
    }
  }
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function safePing(model, alias, baseUrl) {
  const kind = model.kind || model.type || "llm";
  try {
    const res = await pingModelByKind(`${alias}/${model.id}`, kind, baseUrl);
    return {
      modelId: model.id,
      name: model.name || model.id,
      ok: Boolean(res?.ok),
      latencyMs: typeof res?.latencyMs === "number" ? res.latencyMs : 0,
      status: res?.status ?? null,
      error: res?.error ?? null,
    };
  } catch (err) {
    return {
      modelId: model.id,
      name: model.name || model.id,
      ok: false,
      latencyMs: 0,
      status: null,
      error: err.message || "Test failed",
    };
  }
}

/**
 * POST /api/providers/[id]/test-models
 * id = connectionId (UUID) OR providerId (e.g. codebuddy-intl) OR alias (e.g. cbai).
 * Optional request body: { modelIds?: string[], concurrency?: number }
 */
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    let connection = await getProviderConnectionById(id);
    let providerId = null;
    let connectionId = null;

    if (connection) {
      providerId = connection.provider;
      connectionId = connection.id;
    } else {
      // Resolve providerId from alias/id
      const resolved = resolveProviderId(id);
      providerId = resolved !== id ? resolved : resolveProviderAlias(id);

      // Look up active connection for this provider
      const activeConnections = await getProviderConnections({ provider: providerId, isActive: true });
      if (activeConnections && activeConnections.length > 0) {
        connection = activeConnections[0];
        connectionId = connection.id;
      } else {
        const allConnections = await getProviderConnections({ provider: providerId });
        if (allConnections && allConnections.length > 0) {
          return NextResponse.json(
            { error: "No active connection found for provider" },
            { status: 404 }
          );
        }
      }
    }

    if (!providerId) {
      return NextResponse.json({ error: "Provider or connection not found" }, { status: 404 });
    }

    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const { modelIds, concurrency = 3 } = body || {};

    const isCompatible = isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);
    const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;

    let models = getProviderModels(alias);

    const baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;

    // Compatible providers: fetch live model list
    if (isCompatible && models.length === 0 && connectionId) {
      try {
        const modelsRes = await fetch(`${baseUrl}/api/providers/${connectionId}/models`);
        if (modelsRes.ok) {
          const data = await modelsRes.json();
          models = (data.models || []).map((m) => ({ id: m.id || m.name, name: m.name || m.id }));
        }
      } catch { /* fallback to empty */ }
    }

    // Filter by modelIds if requested
    if (Array.isArray(modelIds) && modelIds.length > 0) {
      const allowed = new Set(modelIds);
      models = models.filter((m) => allowed.has(m.id));
    }

    if (models.length === 0) {
      return NextResponse.json({ error: "No models configured for this provider" }, { status: 400 });
    }

    // Warm up with first model to trigger token refresh (if needed) before parallel calls.
    // This prevents race condition where multiple requests concurrently refresh the same token.
    const [first, ...rest] = models;
    const firstResult = await safePing(first, alias, baseUrl);
    const results = [firstResult];

    if (rest.length > 0) {
      const concurrencyLimit = Math.max(1, Number(concurrency) || 3);
      const restResults = await runWithConcurrency(rest, concurrencyLimit, (model) =>
        safePing(model, alias, baseUrl)
      );
      results.push(...restResults);
    }

    const summary = {
      total: results.length,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    };

    return NextResponse.json({ provider: providerId, connectionId, summary, results });
  } catch (error) {
    console.log("Error testing models:", error);
    return NextResponse.json({ error: "Test failed" }, { status: 500 });
  }
}
