/**
 * `9router test-models <provider> [options]`
 * Test all models (or a subset) for a provider through the local running 9router gateway.
 */

const client = require("../api/client");

const HELP = `
Usage: 9router test-models <provider> [options]

Test all models for a provider through your running 9router gateway.
Measures latency, validates endpoint responses, and checks upstream model health.

Examples:
  9router test-models cbai                       # Test all CodeBuddy International models
  9router test-models antigravity                # Test all Antigravity models
  9router test-models cbai --models hy3,glm-5.2  # Test specific models
  9router test-models cbai --concurrency 2       # Limit concurrent test workers
  9router test-models cbai --json                # Output machine-readable JSON

Options:
  -p, --port <port>          Gateway port (default: 20128)
  -H, --host <host>          Gateway host (default: 127.0.0.1)
  -c, --concurrency <number> Concurrent model test limit (default: 3)
  --models <list>            Comma-separated model IDs to test specifically
  --json                     Output raw JSON response
  -h, --help                 Show this help message
`;

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function parseArgs(argv) {
  const opts = {
    provider: null,
    port: 20128,
    host: "127.0.0.1",
    concurrency: 3,
    modelIds: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      opts.help = true;
    } else if (a === "--json") {
      opts.json = true;
    } else if (a === "-p" || a === "--port") {
      const v = argv[++i];
      if (!v) throw new Error("Missing value for --port");
      opts.port = parseInt(v, 10);
    } else if (a === "-H" || a === "--host") {
      const v = argv[++i];
      if (!v) throw new Error("Missing value for --host");
      opts.host = v;
    } else if (a === "-c" || a === "--concurrency") {
      const v = argv[++i];
      if (!v) throw new Error("Missing value for --concurrency");
      opts.concurrency = parseInt(v, 10);
    } else if (a === "--models") {
      const v = argv[++i];
      if (!v) throw new Error("Missing value for --models");
      opts.modelIds = v.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (!a.startsWith("-") && !opts.provider) {
      opts.provider = a;
    } else {
      throw new Error(`Unknown option or extra argument: ${a}`);
    }
  }

  return opts;
}

function printTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] || "").length))
  );

  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join("  ");
  const sepLine = widths.map((w) => "-".repeat(w)).join("  ");

  console.log(COLORS.bold + headerLine + COLORS.reset);
  console.log(COLORS.dim + sepLine + COLORS.reset);

  for (const r of rows) {
    const line = r.map((cell, i) => String(cell || "").padEnd(widths[i])).join("  ");
    console.log(line);
  }
}

async function run(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`${COLORS.red}Error:${COLORS.reset} ${err.message}`);
    console.log(HELP);
    return 1;
  }

  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  if (!opts.provider) {
    console.error(`${COLORS.red}Error:${COLORS.reset} Missing required <provider> argument.`);
    console.log(HELP);
    return 1;
  }

  client.configure({
    host: opts.host,
    port: opts.port,
    protocol: "http:",
  });

  if (!opts.json) {
    console.log(
      `${COLORS.cyan}Testing models for provider '${COLORS.bold}${opts.provider}${COLORS.reset}${COLORS.cyan}' via http://${opts.host}:${opts.port}...${COLORS.reset}\n`
    );
  }

  let res;
  try {
    res = await client.testProviderModels(opts.provider, {
      concurrency: opts.concurrency,
      ...(opts.modelIds?.length ? { modelIds: opts.modelIds } : {}),
    });
  } catch (err) {
    if (!opts.json) {
      console.error(
        `${COLORS.red}Connection error:${COLORS.reset} Could not reach 9router gateway at http://${opts.host}:${opts.port}.`
      );
      console.error(`Ensure 9router is running (run '9router' in a terminal). Detail: ${err.message}`);
    } else {
      console.log(JSON.stringify({ success: false, error: err.message }, null, 2));
    }
    return 1;
  }

  if (!res.success) {
    const errorMsg = res.error || (res.data && res.data.error) || "Test request failed";
    if (!opts.json) {
      console.error(`${COLORS.red}Failed:${COLORS.reset} ${errorMsg}`);
    } else {
      console.log(JSON.stringify(res, null, 2));
    }
    return 1;
  }

  const data = res.data;
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return (data.summary?.failed || 0) > 0 ? 1 : 0;
  }

  const results = data.results || [];
  const summary = data.summary || {
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };

  const tableHeaders = ["Model ID", "Name", "Status", "Latency", "Error / Diagnosis"];
  const tableRows = results.map((r) => {
    const statusCol = r.ok
      ? `${COLORS.green}PASS${COLORS.reset}`
      : `${COLORS.red}FAIL${COLORS.reset}`;
    const latencyCol = typeof r.latencyMs === "number" ? `${r.latencyMs}ms` : "-";
    const errorCol = !r.ok && r.error ? String(r.error).replace(/\n/g, " ").slice(0, 50) : "-";
    return [r.modelId, r.name || r.modelId, statusCol, latencyCol, errorCol];
  });

  printTable(tableHeaders, tableRows);

  const passedItems = results.filter((r) => r.ok && typeof r.latencyMs === "number");
  const avgLatency =
    passedItems.length > 0
      ? Math.round(passedItems.reduce((acc, curr) => acc + curr.latencyMs, 0) / passedItems.length)
      : 0;

  console.log("");
  console.log(
    `${COLORS.bold}Summary:${COLORS.reset} ${summary.total} tested | ${COLORS.green}${summary.passed} passed${COLORS.reset} | ${
      summary.failed > 0 ? `${COLORS.red}${summary.failed} failed${COLORS.reset}` : `0 failed`
    }${avgLatency > 0 ? ` | avg latency: ${avgLatency}ms` : ""}`
  );

  return summary.failed > 0 ? 1 : 0;
}

module.exports = {
  run,
  parseArgs,
  HELP,
};
