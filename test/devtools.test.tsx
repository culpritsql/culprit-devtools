import { describe, expect, test } from "bun:test";
import diagnosticsChannel from "node:diagnostics_channel";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { renderToString } from "react-dom/server";
import {
  CulpritDevtools,
  detectNPlusOneAdvice,
  fingerprintSql,
  normalizeSqlForFingerprint,
} from "../src/index.js";
import {
  CulpritCollector,
  createDevtoolsHandler,
  createNodeDevtoolsMiddleware,
  instrumentMysql,
  instrumentPg,
  instrumentSqlite,
  isSafeForAutoExplain,
  parseDeadlockText,
  parseExplainText,
  parseExtendedEventsXmlText,
  parseXelBytes,
} from "../src/server.js";

const SAMPLE_PG_EXPLAIN_JSON = JSON.stringify([
  {
    Plan: {
      "Node Type": "Limit",
      "Parallel Aware": false,
      "Async Capable": false,
      "Startup Cost": 420.1,
      "Total Cost": 422.5,
      "Plan Rows": 20,
      "Plan Width": 36,
      Plans: [
        {
          "Node Type": "Sort",
          "Parent Relationship": "Outer",
          "Parallel Aware": false,
          "Async Capable": false,
          "Startup Cost": 420.1,
          "Total Cost": 445.1,
          "Plan Rows": 10000,
          "Plan Width": 36,
          "Sort Key": ["o.created_at DESC"],
          Plans: [
            {
              "Node Type": "Seq Scan",
              "Parent Relationship": "Outer",
              "Parallel Aware": false,
              "Async Capable": false,
              "Relation Name": "orders",
              Alias: "o",
              "Startup Cost": 0.0,
              "Total Cost": 298.0,
              "Plan Rows": 10000,
              "Plan Width": 36,
              Filter: "(status = 'paid'::text)",
            },
          ],
        },
      ],
    },
  },
]);

describe("SQL normalization and fingerprinting", () => {
  test("strips comments, normalizes literals and placeholders, and preserves PostgreSQL type casts", () => {
    const q1 = `
      /* controller=orders */
      SELECT o.id, o.total_cents
      FROM "orders" o
      WHERE o.customer_id = $1
        AND o.status = 'shipped'::text
        AND o.total_cents >= 1500 -- minimum threshold
      LIMIT 25;
    `;
    const q2 =
      "SELECT o.id, o.total_cents FROM \"orders\" o WHERE o.customer_id = 99812 AND o.status = 'pending'::text AND o.total_cents >= 500 LIMIT 10";

    expect(normalizeSqlForFingerprint(q1)).toBe(
      'SELECT o.id, o.total_cents FROM "orders" o WHERE o.customer_id = ? AND o.status = ?::text AND o.total_cents >= ? LIMIT ?',
    );
    expect(normalizeSqlForFingerprint(q1)).toBe(normalizeSqlForFingerprint(q2));
    expect(fingerprintSql(q1)).toBe(fingerprintSql(q2));
  });

  test("collapses IN (?, ?, ...) lists and named/positional parameters to identical fingerprints", () => {
    const a = "SELECT * FROM order_items WHERE order_id IN (101, 102, 103, 104) AND region = :region";
    const b = "select * from order_items where order_id in ($1, $2) and region = ?";
    const c = "SELECT * FROM order_items WHERE order_id IN ('x') AND region = @regionName";

    expect(normalizeSqlForFingerprint(a)).toBe(
      "SELECT * FROM order_items WHERE order_id IN (?) AND region = ?",
    );
    expect(normalizeSqlForFingerprint(c)).toBe(
      "SELECT * FROM order_items WHERE order_id IN (?) AND region = ?",
    );
    expect(fingerprintSql(a)).toBe(fingerprintSql(b));
    expect(fingerprintSql(b)).toBe(fingerprintSql(c));
  });

  test("handles escaped single quotes, negative numbers, and dollar-quoted strings", () => {
    const sql =
      "SELECT id FROM users WHERE last_name = 'O''Connor' AND balance > -42.50 AND note = $$hello world$$";
    expect(normalizeSqlForFingerprint(sql)).toBe(
      "SELECT id FROM users WHERE last_name = ? AND balance > ? AND note = ?",
    );
  });
});

describe("CulpritCollector correlation, diagnostics_channel, and N+1 detection", () => {
  test("correlates interleaved async queries accurately via AsyncLocalStorage", async () => {
    const collector = new CulpritCollector({ enabled: true });

    await Promise.all([
      collector.withRequest(
        "GET /api/orders",
        async () => {
          collector.recordQuery({ sql: "SELECT * FROM orders LIMIT 10", durationMs: 4.2 });
          await new Promise((r) => setTimeout(r, 15));
          collector.recordQuery({ sql: "SELECT * FROM users WHERE id = 1", durationMs: 1.8 });
        },
        "req-orders",
      ),
      collector.withRequest(
        "POST /api/checkout",
        async () => {
          await new Promise((r) => setTimeout(r, 5));
          collector.recordQuery({ sql: "SELECT * FROM carts WHERE id = 77", durationMs: 3.1 });
          await new Promise((r) => setTimeout(r, 15));
          collector.recordQuery({ sql: "INSERT INTO payments (cart_id) VALUES (77)", durationMs: 8.4 });
        },
        "req-checkout",
      ),
    ]);

    const snap = collector.getSnapshot();
    expect(snap.stats.totalQueries).toBe(4);

    const ordersQueries = snap.queries.filter((q) => q.requestId === "req-orders");
    const checkoutQueries = snap.queries.filter((q) => q.requestId === "req-checkout");

    expect(ordersQueries).toHaveLength(2);
    expect(ordersQueries.every((q) => q.requestLabel === "GET /api/orders")).toBe(true);

    expect(checkoutQueries).toHaveLength(2);
    expect(checkoutQueries.every((q) => q.requestLabel === "POST /api/checkout")).toBe(true);
  });

  test("captures reylo:query and pg:query events via node:diagnostics_channel", () => {
    const collector = new CulpritCollector({ enabled: true });
    const unsubscribe = collector.subscribeDiagnosticsChannels(["reylo:query", "pg:query"]);

    const reyloCh = diagnosticsChannel.channel("reylo:query");
    collector.withRequest("GET /api/feed", () => {
      reyloCh.publish({
        sql: "SELECT id, title FROM posts WHERE author_id = $1",
        params: [42],
        durationMs: 26.4,
        rowCount: 12,
        engine: "postgresql",
      });
    });

    const snap = collector.getSnapshot();
    expect(snap.stats.totalQueries).toBe(1);
    expect(snap.stats.slowCount).toBe(1);
    expect(snap.queries[0]?.engine).toBe("postgres");
    expect(snap.queries[0]?.requestLabel).toBe("GET /api/feed");
    expect(snap.queries[0]?.paramsCount).toBe(1);
    expect(snap.queries[0]?.rowCount).toBe(12);

    unsubscribe();
    reyloCh.publish({ sql: "SELECT 1", durationMs: 1 });
    expect(collector.getSnapshot().stats.totalQueries).toBe(1);
  });

  test("flags N+1 query bursts only when repeated count meets nPlusOneThreshold and enforces ring-buffer cap", () => {
    const collector = new CulpritCollector({
      enabled: true,
      nPlusOneThreshold: 5,
      maxQueries: 12,
    });

    // 4 queries: below threshold of 5
    collector.withRequest("GET /api/small", () => {
      for (let id = 1; id <= 4; id++) {
        collector.recordQuery({
          sql: `SELECT * FROM tags WHERE post_id = ${id}`,
          durationMs: 2,
          engine: "postgres",
        });
      }
    });
    expect(collector.getSnapshot().bursts).toHaveLength(0);

    // 6 queries in one request: triggers N+1 burst
    collector.withRequest("GET /api/orders", () => {
      for (let id = 100; id < 106; id++) {
        collector.recordQuery({
          sql: `SELECT id, sku FROM line_items WHERE order_id = ${id}`,
          durationMs: 3.5,
          engine: "postgres",
        });
      }
    });

    const snap = collector.getSnapshot();
    expect(snap.bursts).toHaveLength(1);
    const burst = snap.bursts[0]!;
    expect(burst.count).toBe(6);
    expect(burst.requestLabel).toBe("GET /api/orders");
    expect(burst.totalDurationMs).toBeCloseTo(21.0, 2);
    expect(burst.normalizedSql).toBe("SELECT id, sku FROM line_items WHERE order_id = ?");
    expect(detectNPlusOneAdvice(burst.normalizedSql, "postgres")).toContain("ANY($1)");

    // Push 5 more queries to exceed maxQueries=12
    for (let i = 0; i < 5; i++) {
      collector.recordQuery({ sql: `SELECT ${i}`, durationMs: 1 });
    }
    expect(collector.getSnapshot().queries).toHaveLength(12);
  });
});

describe("Driver wrappers and real @culpritsql/plans WebAssembly auto-EXPLAIN", () => {
  test("isSafeForAutoExplain permits read-only single SELECTs and blocks mutations or multi-statements", () => {
    expect(isSafeForAutoExplain("SELECT * FROM orders WHERE id = $1")).toBe(true);
    expect(
      isSafeForAutoExplain("WITH recent AS (SELECT id FROM orders LIMIT 10) SELECT * FROM recent;"),
    ).toBe(true);

    expect(isSafeForAutoExplain("UPDATE orders SET status = 'paid' WHERE id = 1")).toBe(false);
    expect(isSafeForAutoExplain("DELETE FROM orders WHERE id = 1")).toBe(false);
    expect(
      isSafeForAutoExplain(
        "WITH purged AS (DELETE FROM orders RETURNING id) SELECT * FROM purged",
      ),
    ).toBe(false);
    expect(isSafeForAutoExplain("SELECT 1; SELECT 2")).toBe(false);
    expect(isSafeForAutoExplain("EXPLAIN SELECT * FROM orders")).toBe(false);
    expect(isSafeForAutoExplain("/* culprit */ SELECT * FROM orders")).toBe(false);
  });

  test("instrumentPg records queries and attaches Wasm-parsed Plan via autoExplain", async () => {
    const collector = new CulpritCollector({ enabled: true, slowThresholdMs: 10 });
    const executedSql: string[] = [];

    const fakePgPool = {
      async query(sql: string, params?: unknown[]) {
        executedSql.push(sql);
        if (sql.includes("EXPLAIN (FORMAT JSON)")) {
          return {
            rows: [{ "QUERY PLAN": JSON.parse(SAMPLE_PG_EXPLAIN_JSON) }],
            rowCount: 1,
          };
        }
        await new Promise((r) => setTimeout(r, 16));
        return {
          rows: [
            { id: 1, status: params?.[0] ?? "paid" },
            { id: 2, status: params?.[0] ?? "paid" },
          ],
          rowCount: 2,
        };
      },
    };

    const db = instrumentPg(fakePgPool, {
      collector,
      autoExplain: { enabled: true, thresholdMs: 10 },
    });

    const res = await collector.withRequest("GET /api/orders", () =>
      db.query("SELECT * FROM orders o WHERE status = $1 ORDER BY o.created_at DESC LIMIT 20", [
        "paid",
      ]),
    );

    expect(res.rowCount).toBe(2);
    expect(executedSql).toHaveLength(2);
    expect(executedSql[1]).toContain("/* culprit */ EXPLAIN (FORMAT JSON)");

    const snap = collector.getSnapshot();
    // Internal /* culprit */ EXPLAIN query is never recorded in the workload list
    expect(snap.stats.totalQueries).toBe(1);

    const recorded = snap.queries[0]!;
    expect(recorded.requestLabel).toBe("GET /api/orders");
    expect(recorded.rowCount).toBe(2);
    expect(recorded.paramsCount).toBe(1);
    expect(recorded.plan).toBeDefined();
    expect(recorded.plan?.engine).toBe("postgres");
    expect(recorded.plan?.root).toBeDefined();
  });

  test("instrumentSqlite and instrumentMysql capture timings and parse SQLite EXPLAIN QUERY PLAN", async () => {
    const collector = new CulpritCollector({ enabled: true, slowThresholdMs: 0 });

    const fakeSqlite = {
      prepare(sql: string) {
        return {
          all(..._params: unknown[]) {
            if (sql.includes("EXPLAIN QUERY PLAN")) {
              return [
                {
                  id: 2,
                  parent: 0,
                  notused: 0,
                  detail: "SEARCH orders USING INDEX orders_customer_idx (customer_id=?)",
                },
              ];
            }
            return [{ id: 10, customer_id: 99 }];
          },
        };
      },
    };

    const sqlite = instrumentSqlite(fakeSqlite, {
      collector,
      autoExplain: { enabled: true, thresholdMs: 0 },
    });
    const rows = sqlite.prepare("SELECT * FROM orders WHERE customer_id = ?").all(99);
    expect(rows).toHaveLength(1);

    // Wait briefly for background async Wasm explain on synchronous SQLite call
    await new Promise((r) => setTimeout(r, 40));

    const sqliteQuery = collector.getSnapshot().queries[0]!;
    expect(sqliteQuery.engine).toBe("sqlite");
    expect(sqliteQuery.plan?.engine).toBe("sqlite");

    const fakeMysql = {
      async execute(_sql: string, _values?: unknown[]) {
        return [[{ id: 1 }, { id: 2 }, { id: 3 }], []];
      },
      async query(_sql: string) {
        return [[], []];
      },
    };
    const mysql = instrumentMysql(fakeMysql, { collector });
    await mysql.execute("SELECT id FROM invoices WHERE tenant_id = ?", [7]);
    const latest = collector.getSnapshot().queries[0]!;
    expect(latest.engine).toBe("mysql");
    expect(latest.rowCount).toBe(3);
  });
});

describe("Fetch and Node HTTP DevTools handlers and security guards", () => {
  test("enforces loopback and NODE_ENV=production guards and serves /snapshot, /parse, /clear", async () => {
    const collector = new CulpritCollector({ enabled: true });
    collector.recordQuery({ sql: "SELECT * FROM accounts WHERE id = 1", durationMs: 12.5 });

    const handler = createDevtoolsHandler(collector);

    // Loopback GET /__culprit/snapshot succeeds
    const okRes = await handler(new Request("http://localhost:3000/__culprit/snapshot"));
    expect(okRes.status).toBe(200);
    const snap = await okRes.json();
    expect(snap.stats.totalQueries).toBe(1);

    // Non-loopback host, X-Forwarded-For, and remoteAddress are rejected with 403
    const remoteHostRes = await handler(new Request("http://203.0.113.25:3000/__culprit/snapshot"));
    expect(remoteHostRes.status).toBe(403);

    const forwardedRes = await handler(
      new Request("http://localhost:3000/__culprit/snapshot", {
        headers: { "x-forwarded-for": "198.51.100.42" },
      }),
    );
    expect(forwardedRes.status).toBe(403);

    const socketRemoteRes = await handler(new Request("http://127.0.0.1/__culprit/snapshot"), {
      remoteAddress: "10.0.4.15",
    });
    expect(socketRemoteRes.status).toBe(403);

    // Explicit allowRemote: true permits remote access
    const remoteAllowedHandler = createDevtoolsHandler(collector, { allowRemote: true });
    const allowedRes = await remoteAllowedHandler(
      new Request("http://203.0.113.25:3000/__culprit/snapshot"),
    );
    expect(allowedRes.status).toBe(200);

    // Production guard
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const prodBlocked = await handler(new Request("http://localhost:3000/__culprit/snapshot"));
      expect(prodBlocked.status).toBe(403);

      const prodAllowedHandler = createDevtoolsHandler(collector, { allowProduction: true });
      const prodAllowed = await prodAllowedHandler(
        new Request("http://localhost:3000/__culprit/snapshot"),
      );
      expect(prodAllowed.status).toBe(200);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }

    // POST /__culprit/parse parses raw EXPLAIN via Wasm
    const parseRes = await handler(
      new Request("http://127.0.0.1/__culprit/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rawExplain: SAMPLE_PG_EXPLAIN_JSON, engine: "postgres" }),
      }),
    );
    expect(parseRes.status).toBe(200);
    const parsedPayload = (await parseRes.json()) as { plan: { engine: string } };
    expect(parsedPayload.plan.engine).toBe("postgres");

    // Invalid EXPLAIN returns 400 structured error without crashing Wasm
    const badParseRes = await handler(
      new Request("http://127.0.0.1/__culprit/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rawExplain: "not a valid execution plan" }),
      }),
    );
    expect(badParseRes.status).toBe(400);

    // POST /__culprit/parse parses SQL Server Extended Events XML and rejects XML on xelBase64
    const xeXml = [
      '<RingBufferTarget>',
      '  <event name="attention" package="sqlserver" timestamp="2026-11-25T10:20:00.000Z">',
      '    <data name="duration"><value>30000000</value></data>',
      '    <action name="sql_text" package="sqlserver"><value>SELECT * FROM invoices WHERE secret = \'top-secret\';</value></action>',
      '  </event>',
      '</RingBufferTarget>',
    ].join("\n");
    const xeParseRes = await handler(
      new Request("http://127.0.0.1/__culprit/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rawExplain: xeXml }),
      }),
    );
    expect(xeParseRes.status).toBe(200);
    const xeBody = (await xeParseRes.json()) as {
      events: { format: string; records: Array<{ kind: { event: string } }> };
    };
    expect(xeBody.events.format).toBe("xml");
    expect(xeBody.events.records).toHaveLength(1);
    expect(xeBody.events.records[0]?.kind.event).toBe("attention");
    expect(JSON.stringify(xeBody)).not.toContain("top-secret");

    const xelBadRes = await handler(
      new Request("http://127.0.0.1/__culprit/parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ xelBase64: Buffer.from(xeXml, "utf8").toString("base64") }),
      }),
    );
    expect(xelBadRes.status).toBe(400);
    let xelThrew = false;
    try {
      await parseXelBytes(new Uint8Array(Buffer.from(xeXml, "utf8")));
    } catch {
      xelThrew = true;
    }
    expect(xelThrew).toBe(true);
    const parsedDls = await parseDeadlockText(
      "ERROR:  deadlock detected\nDETAIL:  Process 10 waits for ShareLock on transaction 1; blocked by process 20.\nProcess 20 waits for ShareLock on transaction 2; blocked by process 10.\nProcess 10: UPDATE a SET x = 1;\nProcess 20: UPDATE b SET x = 1;",
    );
    expect(parsedDls).toHaveLength(1);

    // POST /__culprit/clear resets ring buffer
    const clearRes = await handler(
      new Request("http://127.0.0.1/__culprit/clear", { method: "POST" }),
    );
    expect(clearRes.status).toBe(200);
    expect(collector.getSnapshot().stats.totalQueries).toBe(0);
  });

  test("createNodeDevtoolsMiddleware correlates downstream HTTP requests and serves snapshot", async () => {
    const collector = new CulpritCollector({ enabled: true });
    const middleware = createNodeDevtoolsMiddleware(collector);

    const invokeMiddleware = (
      method: string,
      url: string,
      remoteAddress = "127.0.0.1",
      nextHandler?: () => void,
    ) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const reqEmitter = new EventEmitter();
        const req = Object.assign(reqEmitter, {
          method,
          url,
          headers: { host: "localhost:3000" },
          socket: { remoteAddress },
        }) as unknown as IncomingMessage;

        const resObj = {
          statusCode: 200,
          headers: new Map<string, string>(),
          setHeader(k: string, v: string) {
            this.headers.set(k.toLowerCase(), v);
          },
          end(chunk?: string) {
            resolve({ status: this.statusCode, body: chunk ?? "" });
          },
        };
        const res = resObj as unknown as ServerResponse;

        middleware(
          req,
          res,
          nextHandler
            ? () => {
                nextHandler();
                resObj.end("ok");
              }
            : undefined,
        );
        queueMicrotask(() => reqEmitter.emit("end"));
      });

    const appRes = await invokeMiddleware("GET", "/api/widgets", "127.0.0.1", () => {
      collector.recordQuery({ sql: "SELECT * FROM widgets WHERE active = TRUE", durationMs: 5 });
    });
    expect(appRes.status).toBe(200);

    const dtRes = await invokeMiddleware("GET", "/__culprit/snapshot", "127.0.0.1");
    expect(dtRes.status).toBe(200);
    const snap = JSON.parse(dtRes.body) as { queries: Array<{ requestLabel?: string }> };
    expect(snap.queries[0]?.requestLabel).toBe("GET /api/widgets");

    // Non-loopback socket address is rejected by Node middleware too
    const blockedRes = await invokeMiddleware("GET", "/__culprit/snapshot", "192.0.2.88");
    expect(blockedRes.status).toBe(403);
  });
});

describe("React SSR rendering, PlanViewer integration, and browser bundle isolation", () => {
  test("renders HUD pill, Queries tab, N+1 Bursts tab, and PlanViewer cleanly in SSR", async () => {
    const collector = new CulpritCollector({ enabled: true, nPlusOneThreshold: 5 });
    const parsedPlan = await parseExplainText(SAMPLE_PG_EXPLAIN_JSON, "postgres");

    collector.withRequest("GET /api/orders", () => {
      collector.recordQuery({
        sql: "SELECT * FROM orders o WHERE status = 'paid'::text ORDER BY o.created_at DESC LIMIT 20",
        durationMs: 48.6,
        rowCount: 20,
        engine: "postgres",
        plan: parsedPlan,
      });
      for (let i = 1; i <= 6; i++) {
        collector.recordQuery({
          sql: `SELECT * FROM order_items WHERE order_id = ${i}`,
          durationMs: 4.1,
          rowCount: 3,
          engine: "postgres",
        });
      }
    });

    const snapshot = collector.getSnapshot();

    // 1. Queries tab + floating trigger pill
    const queriesHtml = renderToString(
      <CulpritDevtools initialSnapshot={snapshot} defaultOpen theme="dark" />,
    );
    expect(queriesHtml).toContain("culprit-dt");
    expect(queriesHtml).toContain("⚡ SQL · 7 · 1 N+1");
    expect(queriesHtml).toContain("culprit-dt-dot-coral");
    expect(queriesHtml).toContain("GET /api/orders");
    expect(queriesHtml).toContain("Inspect Plan");

    // 2. N+1 Bursts tab
    const burstsHtml = renderToString(
      <CulpritDevtools initialSnapshot={snapshot} defaultOpen defaultTab="bursts" />,
    );
    expect(burstsHtml).toContain("6x");
    expect(burstsHtml).toContain("Batching fix:");
    expect(burstsHtml).toContain("ANY($1)");

    // 3. Plan Inspector tab with @culpritsql/plan-viewer <PlanViewer />
    const planHtml = renderToString(
      <CulpritDevtools initialSnapshot={snapshot} defaultOpen defaultTab="plan" />,
    );
    expect(planHtml).toContain("culprit-pv");
    expect(planHtml).toContain("orders");

    // 4. Plan Inspector tab with @culpritsql/plan-viewer <ExtendedEventsViewer />
    const xeBatch = await parseExtendedEventsXmlText(
      '<RingBufferTarget><event name="error_reported" package="sqlserver" timestamp="2026-11-25T10:30:00Z"><data name="error_number"><value>1205</value></data><data name="severity"><value>13</value></data><data name="state"><value>51</value></data></event></RingBufferTarget>',
    );
    const eventsHtml = renderToString(
      <CulpritDevtools
        initialSnapshot={snapshot}
        initialInspectorPayload={{ kind: "events", events: xeBatch, label: "system_health.xel" }}
        defaultOpen
        defaultTab="plan"
      />,
    );
    expect(eventsHtml).toContain("culprit-pv");
    expect(eventsHtml).toContain("1205");
  });

  test("client entrypoints bundle for browsers without pulling Node builtins and CSS stays strictly scoped", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

    const bundle = await esbuild.build({
      entryPoints: [path.join(repoRoot, "src/index.ts"), path.join(repoRoot, "src/react.tsx")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      outdir: "out",
      external: ["react", "react-dom", "react/jsx-runtime", "@culpritsql/plan-viewer", "lucide-react"],
    });
    expect(bundle.errors).toHaveLength(0);
    for (const file of bundle.outputFiles) {
      expect(file.text).not.toContain("node:async_hooks");
      expect(file.text).not.toContain("node:diagnostics_channel");
      expect(file.text).not.toContain("node:fs");
    }

    const css = await readFile(path.join(repoRoot, "src/styles.css"), "utf8");
    expect(css).toContain('@import "@culpritsql/plan-viewer/styles.css";');
    // Every selector line outside @import / @media / comments must reference .culprit-dt
    const selectorLines = css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.endsWith("{") && !l.startsWith("@"));
    expect(selectorLines.length).toBeGreaterThan(10);
    for (const selector of selectorLines) {
      expect(selector).toContain(".culprit-dt");
    }
  });
});
