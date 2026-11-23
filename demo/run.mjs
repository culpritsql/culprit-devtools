import diagnosticsChannel from "node:diagnostics_channel";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import {
  CulpritCollector,
  createNodeDevtoolsMiddleware,
  instrumentSqlite,
  parseExplainText,
} from "../dist/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

if (!existsSync(path.join(repoRoot, "dist/server.js"))) {
  throw new Error("Run `bun run build` (or `npm run build`) before launching the demo.");
}

// 1. Bundle the React demo frontend in-memory with esbuild (~50ms)
const bundledClient = await esbuild.build({
  entryPoints: [path.join(__dirname, "client.tsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  target: "es2022",
  jsx: "automatic",
  define: {
    "process.env.NODE_ENV": '"development"',
  },
});
const clientJs = bundledClient.outputFiles[0].text;
const stylesCss = readFileSync(path.join(repoRoot, "dist/styles.css"), "utf8");

// 2. Configure CulpritCollector + diagnostics_channel ("reylo:query")
const collector = new CulpritCollector({
  enabled: true,
  slowThresholdMs: 15,
  nPlusOneThreshold: 5,
  maxQueries: 250,
});
collector.subscribeDiagnosticsChannels(["reylo:query"]);
const reyloChannel = diagnosticsChannel.channel("reylo:query");

// 3. Seed an in-memory SQLite database and wrap it with instrumentSqlite + autoExplain
const rawDb = new DatabaseSync(":memory:");
rawDb.exec(`
  CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    tier TEXT NOT NULL
  );
  CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    region TEXT NOT NULL,
    total_cents INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_orders_status ON orders (status);
`);

const insertCustomer = rawDb.prepare("INSERT INTO customers (id, name, email, tier) VALUES (?, ?, ?, ?)");
const tiers = ["free", "pro", "enterprise"];
for (let i = 1; i <= 120; i++) {
  insertCustomer.run(i, `Customer #${i}`, `customer${i}@acme.example`, tiers[i % tiers.length]);
}

const insertOrder = rawDb.prepare(
  "INSERT INTO orders (id, customer_id, status, region, total_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)",
);
const regions = ["us-east", "eu-central", "ap-south"];
const statuses = ["paid", "shipped", "pending"];
for (let i = 1; i <= 900; i++) {
  insertOrder.run(
    i,
    ((i * 7) % 120) + 1,
    statuses[i % statuses.length],
    regions[i % regions.length],
    1500 + ((i * 397) % 48000),
    `2026-11-${String((i % 22) + 1).padStart(2, "0")}T12:00:00Z`,
  );
}

const db = instrumentSqlite(rawDb, {
  collector,
  autoExplain: { enabled: true, thresholdMs: 0 },
});

// Pre-seed one initial slow PostgreSQL Disk-Spill plan so opening http://127.0.0.1:4321 immediately shows a rich plan in Plan Inspector!
const SAMPLE_PG_SPILL_JSON = JSON.stringify([
  {
    Plan: {
      "Node Type": "Limit",
      "Startup Cost": 48210.4,
      "Total Cost": 48215.9,
      "Plan Rows": 50,
      "Plan Width": 96,
      "Actual Startup Time": 41.4,
      "Actual Total Time": 42.8,
      "Actual Rows": 50,
      "Actual Loops": 1,
      "Shared Hit Blocks": 620,
      "Shared Read Blocks": 4820,
      "Temp Read Blocks": 512,
      "Temp Written Blocks": 512,
      Plans: [
        {
          "Node Type": "Sort",
          "Sort Key": ["o.created_at DESC"],
          "Sort Method": "external merge",
          "Sort Space Used": 4096,
          "Sort Space Type": "Disk",
          "Startup Cost": 48210.4,
          "Total Cost": 48285.1,
          "Plan Rows": 29880,
          "Plan Width": 96,
          "Actual Startup Time": 41.1,
          "Actual Total Time": 42.5,
          "Actual Rows": 50,
          "Actual Loops": 1,
          "Shared Hit Blocks": 620,
          "Shared Read Blocks": 4820,
          "Temp Read Blocks": 512,
          "Temp Written Blocks": 512,
          Plans: [
            {
              "Node Type": "Seq Scan",
              "Relation Name": "orders",
              Schema: "public",
              Alias: "o",
              Filter: "((region = 'eu-central'::text) AND (total_cents >= 10000))",
              "Rows Removed by Filter": 248100,
              "Startup Cost": 0.0,
              "Total Cost": 39840.0,
              "Plan Rows": 3100,
              "Plan Width": 96,
              "Actual Startup Time": 0.08,
              "Actual Total Time": 34.2,
              "Actual Rows": 14200,
              "Actual Loops": 1,
              "Shared Hit Blocks": 620,
              "Shared Read Blocks": 4820,
            },
          ],
        },
      ],
    },
    "Planning Time": 0.52,
    "Execution Time": 43.4,
  },
]);

async function runApiRoute(pathname, method) {
  if (pathname === "/api/orders/n-plus-1" && method === "GET") {
    const orders = db
      .prepare("SELECT id, customer_id, status, total_cents FROM orders WHERE status = ? LIMIT 8")
      .all("paid");
    const customerStmt = db.prepare("SELECT id, name, email, tier FROM customers WHERE id = ?");
    const enriched = orders.map((order) => {
      const customer = customerStmt.get(order.customer_id);
      return { ...order, customer };
    });
    return {
      summary: "Executed 1 parent query + 8 per-row customer queries (N+1 burst flagged in HUD)",
      rows: enriched,
    };
  }

  if (pathname === "/api/orders/batched" && method === "GET") {
    const orders = db
      .prepare("SELECT id, customer_id, status, total_cents FROM orders WHERE status = ? LIMIT 8")
      .all("paid");
    const ids = [...new Set(orders.map((o) => o.customer_id))];
    const placeholders = ids.map(() => "?").join(", ");
    const customers = db
      .prepare(`SELECT id, name, email, tier FROM customers WHERE id IN (${placeholders})`)
      .all(...ids);
    const byId = new Map(customers.map((c) => [c.id, c]));
    return {
      summary: `Loaded 8 orders + ${customers.length} unique customers in 2 total SQL queries`,
      rows: orders.map((o) => ({ ...o, customer: byId.get(o.customer_id) })),
    };
  }

  if (pathname === "/api/analytics/unindexed" && method === "GET") {
    // Run real unindexed SQLite scan + attach a detailed Postgres EXPLAIN (ANALYZE, BUFFERS) plan
    const rows = db
      .prepare(
        "SELECT region, COUNT(*) AS order_count, SUM(total_cents) AS gross_cents FROM orders WHERE total_cents >= ? GROUP BY region ORDER BY gross_cents DESC",
      )
      .all(10000);
    const plan = await parseExplainText(SAMPLE_PG_SPILL_JSON, "postgres");
    collector.recordQuery({
      sql: "SELECT o.id, o.region, o.total_cents FROM public.orders o WHERE o.region = $1 AND o.total_cents >= $2 ORDER BY o.created_at DESC LIMIT 50",
      params: ["eu-central", 10000],
      durationMs: 43.4,
      rowCount: 50,
      engine: "postgres",
      plan,
    });
    return {
      summary: "Recorded unindexed SQLite scan + 43.4 ms PostgreSQL disk-spill plan (click Inspect Plan)",
      rows,
    };
  }

  if (pathname === "/api/reylo/checkout" && method === "POST") {
    reyloChannel.publish({
      sql: "INSERT INTO ledger_entries (order_id, amount_cents, currency) VALUES ($1, $2, $3) RETURNING id",
      params: [901, 14900, "USD"],
      durationMs: 4.8,
      rowCount: 1,
      engine: "postgres",
    });
    reyloChannel.publish({
      sql: "UPDATE inventory_levels SET reserved = reserved + $1 WHERE sku = $2",
      params: [1, "SKU-PRO-ANNUAL"],
      durationMs: 22.6,
      rowCount: 1,
      engine: "postgres",
    });
    return {
      summary: "Published 2 structured SQL events on diagnostics_channel('reylo:query')",
      rows: [{ ok: true }],
    };
  }

  return null;
}

const devtoolsMiddleware = createNodeDevtoolsMiddleware(collector, {
  basePath: "/__culprit",
  correlateRequests: true,
});

const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Culprit SQL DevTools - Live Playground</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body style="margin:0">
  <div id="root"></div>
  <script src="/client.js"></script>
</body>
</html>`;

// Smoke mode for automated CI / local verification without binding a TCP port!
if (process.argv.includes("--smoke")) {
  await collector.withRequest("GET /api/orders/n-plus-1", () => runApiRoute("/api/orders/n-plus-1", "GET"));
  await collector.withRequest("GET /api/orders/batched", () => runApiRoute("/api/orders/batched", "GET"));
  await collector.withRequest("GET /api/analytics/unindexed", () =>
    runApiRoute("/api/analytics/unindexed", "GET"),
  );
  await collector.withRequest("POST /api/reylo/checkout", () => runApiRoute("/api/reylo/checkout", "POST"));

  const snap = collector.getSnapshot();
  const plansAttached = snap.queries.filter((q) => Boolean(q.plan)).length;
  if (snap.bursts.length < 1 || plansAttached < 2) {
    throw new Error(`Unexpected demo smoke snapshot: bursts=${snap.bursts.length}, plans=${plansAttached}`);
  }
  console.log(
    `DEMO_SMOKE_OK: ${snap.stats.totalQueries} queries, ${snap.stats.burstCount} N+1 burst(s), ${plansAttached} Wasm-parsed EXPLAIN plans, client bundle ${(clientJs.length / 1024).toFixed(1)} KB`,
  );
  process.exit(0);
}

// Seed initial plan so Plan Inspector has an interactive graph immediately on page load
await collector.withRequest("GET /api/analytics/unindexed (boot)", () =>
  runApiRoute("/api/analytics/unindexed", "GET"),
);

const port = Number(process.env.PORT || 4321);
const server = http.createServer((req, res) => {
  devtoolsMiddleware(req, res, async () => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(indexHtml);
      return;
    }
    if (req.method === "GET" && url.pathname === "/styles.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(stylesCss);
      return;
    }
    if (req.method === "GET" && url.pathname === "/client.js") {
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      res.end(clientJs);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const payload = await runApiRoute(url.pathname, req.method ?? "GET");
      if (payload) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload));
        return;
      }
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`\n⚡ Culprit SQL DevTools Playground running at http://127.0.0.1:${port}\n`);
});
