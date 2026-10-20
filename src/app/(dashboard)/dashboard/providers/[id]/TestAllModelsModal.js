"use client";

import { useState, useMemo } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Badge } from "@/shared/components";

export default function TestAllModelsModal({
  isOpen,
  onClose,
  results,
  providerName = "Provider",
  onRetest,
  isRetesting = false,
}) {
  const [filter, setFilter] = useState("all"); // "all" | "passed" | "failed"

  const items = useMemo(() => results?.results || [], [results]);
  const summary = results?.summary || {
    total: items.length,
    passed: items.filter((r) => r.ok).length,
    failed: items.filter((r) => !r.ok).length,
  };

  const avgLatency = useMemo(() => {
    const passedItems = items.filter((r) => r.ok && typeof r.latencyMs === "number");
    if (passedItems.length === 0) return null;
    const sum = passedItems.reduce((acc, curr) => acc + curr.latencyMs, 0);
    return Math.round(sum / passedItems.length);
  }, [items]);

  const filteredItems = useMemo(() => {
    if (filter === "passed") return items.filter((r) => r.ok);
    if (filter === "failed") return items.filter((r) => !r.ok);
    return items;
  }, [items, filter]);

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Model Test Results — ${providerName}`}
      size="lg"
    >
      <div className="flex flex-col gap-4">
        {/* Summary Card */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-black/[0.02] p-3 dark:bg-white/[0.02]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-text-muted">Summary:</span>
            <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-500 dark:text-emerald-400">
              {summary.passed} Passed
            </span>
            {summary.failed > 0 && (
              <span className="rounded bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-500 dark:text-red-400">
                {summary.failed} Failed
              </span>
            )}
            <span className="text-xs text-text-muted">
              ({summary.total} total)
            </span>
          </div>

          {avgLatency !== null && (
            <div className="text-xs text-text-muted">
              Avg Latency: <span className="font-mono font-medium text-text-main">{avgLatency}ms</span>
            </div>
          )}
        </div>

        {/* Filter Tabs */}
        <div className="flex items-center gap-1.5 border-b border-border pb-2 text-xs">
          <button
            type="button"
            onClick={() => setFilter("all")}
            className={`rounded-lg px-2.5 py-1 font-medium transition-colors ${
              filter === "all"
                ? "bg-primary/10 text-primary"
                : "text-text-muted hover:text-text-main"
            }`}
          >
            All ({summary.total})
          </button>
          <button
            type="button"
            onClick={() => setFilter("passed")}
            className={`rounded-lg px-2.5 py-1 font-medium transition-colors ${
              filter === "passed"
                ? "bg-emerald-500/15 text-emerald-500 dark:text-emerald-400"
                : "text-text-muted hover:text-text-main"
            }`}
          >
            Passed ({summary.passed})
          </button>
          {summary.failed > 0 && (
            <button
              type="button"
              onClick={() => setFilter("failed")}
              className={`rounded-lg px-2.5 py-1 font-medium transition-colors ${
                filter === "failed"
                  ? "bg-red-500/15 text-red-500 dark:text-red-400"
                  : "text-text-muted hover:text-text-main"
              }`}
            >
              Failed ({summary.failed})
            </button>
          )}
        </div>

        {/* Models Results List */}
        <div className="flex max-h-[55vh] flex-col gap-2 overflow-y-auto pr-1">
          {filteredItems.length === 0 ? (
            <div className="py-8 text-center text-xs text-text-muted">
              No models match the selected filter.
            </div>
          ) : (
            filteredItems.map((r) => (
              <div
                key={r.modelId}
                className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-black/[0.02] p-2.5 text-xs transition-colors dark:bg-white/[0.02]"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={`material-symbols-outlined text-[16px] shrink-0 ${
                        r.ok ? "text-emerald-500" : "text-red-500"
                      }`}
                    >
                      {r.ok ? "check_circle" : "cancel"}
                    </span>
                    <span className="truncate font-mono font-medium text-text-main">
                      {r.modelId}
                    </span>
                    {r.name && r.name !== r.modelId && (
                      <span className="hidden truncate text-text-muted sm:inline">
                        ({r.name})
                      </span>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {typeof r.latencyMs === "number" && r.latencyMs > 0 && (
                      <span className="font-mono text-[11px] tabular-nums text-text-muted">
                        {r.latencyMs}ms
                      </span>
                    )}
                    <Badge variant={r.ok ? "success" : "error"} size="sm">
                      {r.ok ? "PASS" : r.status ? `HTTP ${r.status}` : "FAIL"}
                    </Badge>
                  </div>
                </div>

                {!r.ok && r.error && (
                  <div className="rounded bg-red-500/10 px-2 py-1 text-[11px] text-red-400 break-words">
                    {r.error}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Modal Actions */}
        <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
          <div className="text-[11px] text-text-muted">
            Tested through 9router internal gateway
          </div>
          <div className="flex items-center gap-2">
            {onRetest && (
              <Button
                variant="secondary"
                size="sm"
                icon={isRetesting ? "progress_activity" : "refresh"}
                onClick={onRetest}
                disabled={isRetesting}
              >
                {isRetesting ? "Testing..." : "Retest All"}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

TestAllModelsModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  results: PropTypes.object,
  providerName: PropTypes.string,
  onRetest: PropTypes.func,
  isRetesting: PropTypes.bool,
};
