import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import diagnosticsChannel from "node:diagnostics_channel";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { init as initPlansWasm, ParserError, parsePlan } from "@culpritsql/plans";
import {
  type DevtoolsSnapshot,
  type Engine,
  fingerprintSql,
  type NPlusOneBurst,
  normalizeSqlForFingerprint,
  type Plan,
  type RecordedQuery,
} from "./shared.js";

export { ParserError };

export type RequestContext = {
  requestId: string;
  requestLabel: string;
};

export type ExplainRunner = (sql: string, params?: readonly unknown[]) => Promise<string | null | undefined>;

export type AutoExplainOptions = {
  enabled?: boolean;
  /** Minimum query duration in ms before running auto-EXPLAIN. Defaults to collector.slowThresholdMs. */
  thresholdMs?: number;
  /** Cap on total auto-EXPLAIN executions per collector buffer clear. Defaults to 50. */
  maxExplains?: number;
  /** Optional engine hint passed to `@culpritsql/plans`. */
  engine?: Engine;
  /** Custom async EXPLAIN runner for the database connection. */
  runExplain?: ExplainRunner;
};

export type CulpritCollectorOptions = {
  /** Ring buffer size cap. Defaults to 250. */
  maxQueries?: number;
  /** Queries at or above this duration (ms) count as slow. Defaults to 20. */
  slowThresholdMs?: number;
  /** Minimum repeated executions of the same fingerprint to flag an N+1 burst. Defaults to 5. */
  nPlusOneThreshold?: number;
  /** Master switch. Defaults to `process.env.NODE_ENV !== "production"`. */
  enabled?: boolean;
  /** Default SQL engine tag when a driver event omits one. */
  defaultEngine?: Engine;
  /** Optional safe auto-EXPLAIN configuration for slow single-statement SELECT queries. */
  autoExplain?: boolean | AutoExplainOptions;
};

export type RecordQueryInput = {
  id?: string;
  timestamp?: number;
  requestId?: string;
  requestLabel?: string;
  engine?: Engine | string;
  sql?: string;
  /** Alias accepted for Prisma `$on('query')` compatibility. */
  query?: string;
  durationMs?: number;
  /** Alias accepted for Prisma `$on('query')` compatibility. */
  duration?: number;
  rowCount?: number;
  params?: readonly unknown[] | string;
  paramsCount?: number;
  error?: string | Error;
  plan?: Plan;
  rawExplain?: string;
};

export type InstrumentDriverOptions = {
  collector?: CulpritCollector;
  engine?: Engine;
  autoExplain?: boolean | AutoExplainOptions;
};

export type DevtoolsHandlerOptions = {
  /** URL path prefix. Defaults to `"/__culprit"`. */
  basePath?: string;
  /** Allow non-loopback requests. Defaults to `false`. */
  allowRemote?: boolean;
  /** Allow serving in `NODE_ENV === "production"`. Defaults to `false`. */
  allowProduction?: boolean;
};

const INSTRUMENTED = Symbol.for("culprit.devtools.instrumented");
const CULPRIT_INTERNAL_TAG = "/* culprit */";
const SINGLE_SELECT_RE = /^\s*(?:with\b[\s\S]+?select|select)\b/i;
const MUTATING_KEYWORD_RE = /\b(?:insert|update|delete|merge|replace|upset|upsert|drop|alter|create|truncate|grant|revoke|call|exec|execute|copy|into)\b/i;
const ALREADY_EXPLAIN_RE = /^\s*explain\b/i;
const MAX_EXPLAIN_BODY_BYTES = 2 * 1024 * 1024;

let wasmInitPromise: Promise<void> | null = null;

/**
 * Initializes the `@culpritsql/plans` WebAssembly module once in Node.js / Bun
 * using `import.meta.resolve("@culpritsql/plans")` + `node:fs/promises`.
 */
export async function ensurePlansWasm(): Promise<void> {
  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      const entryUrl = import.meta.resolve("@culpritsql/plans");
      const wasmUrl = new URL("./native/culprit_wasm_bg.wasm", entryUrl);
      const wasmBytes = await readFile(wasmUrl);
      await initPlansWasm({ module_or_path: wasmBytes });
    })().catch((err) => {
      wasmInitPromise = null;
      throw err;
    });
  }
  return wasmInitPromise;
}

/**
 * Parses raw `EXPLAIN` output (JSON, text, or `.sqlplan` XML) into a typed Culprit `Plan`.
 */
export async function parseExplainText(rawExplain: string, engine?: Engine): Promise<Plan> {
  await ensurePlansWasm();
  return parsePlan(rawExplain, engine);
}

function coerceEngine(raw: unknown, fallback?: Engine): Engine | undefined {
  if (typeof raw !== "string") return fallback;
  const v = raw.toLowerCase().trim();
  if (v === "postgres" || v === "postgresql" || v === "pg") return "postgres";
  if (v === "mysql" || v === "mysql2" || v === "mariadb") return "mysql";
  if (v === "sqlite" || v === "sqlite3" || v === "better-sqlite3" || v === "libsql") return "sqlite";
  if (v === "mssql" || v === "sqlserver" || v === "tds") return "mssql";
  if (v === "yugabyte" || v === "yugabytedb") return "yugabyte";
  return fallback;
}

function stripCommentsAndStringsForSafetyCheck(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1] ?? "";
    if (ch === "-" && next === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += "''";
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += '""';
      continue;
    }
    out += ch;
    i++;
  }
  return out.trim();
}

/**
 * Returns true strictly for read-only, single-statement `SELECT` / `WITH ... SELECT`
 * queries that do not already begin with `EXPLAIN` and contain no data-modifying keywords.
 */
export function isSafeForAutoExplain(sql: string): boolean {
  if (!sql || sql.includes(CULPRIT_INTERNAL_TAG)) return false;
  const cleaned = stripCommentsAndStringsForSafetyCheck(sql);
  if (!cleaned || ALREADY_EXPLAIN_RE.test(cleaned)) return false;
  const withoutTrailingSemi = cleaned.replace(/;\s*$/, "");
  if (withoutTrailingSemi.includes(";")) return false;
  if (!SINGLE_SELECT_RE.test(withoutTrailingSemi)) return false;
  if (MUTATING_KEYWORD_RE.test(withoutTrailingSemi)) return false;
  return true;
}

function countParams(params: readonly unknown[] | string | undefined, explicit?: number): number | undefined {
  if (typeof explicit === "number") return explicit;
  if (Array.isArray(params)) return params.length;
  if (typeof params === "string" && params.trim().startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(params);
      if (Array.isArray(parsed)) return parsed.length;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export class CulpritCollector {
  readonly maxQueries: number;
  readonly slowThresholdMs: number;
  readonly nPlusOneThreshold: number;
  readonly enabled: boolean;
  readonly defaultEngine?: Engine;
  private readonly autoExplainConfig: AutoExplainOptions;
  private readonly als = new AsyncLocalStorage<RequestContext>();
  private queries: RecordedQuery[] = [];
  private explainCount = 0;
  private seq = 0;
  private activeSubscriptions = new Map<string, diagnosticsChannel.ChannelListener>();

  constructor(options: CulpritCollectorOptions = {}) {
    this.maxQueries = Math.max(1, options.maxQueries ?? 250);
    this.slowThresholdMs = options.slowThresholdMs ?? 20;
    this.nPlusOneThreshold = Math.max(2, options.nPlusOneThreshold ?? 5);
    this.enabled = options.enabled ?? process.env.NODE_ENV !== "production";
    this.defaultEngine = options.defaultEngine;
    if (typeof options.autoExplain === "boolean") {
      this.autoExplainConfig = { enabled: options.autoExplain };
    } else {
      this.autoExplainConfig = options.autoExplain ?? { enabled: false };
    }
  }

  /**
   * Runs `fn` inside an `AsyncLocalStorage` request scope so every query recorded
   * across async boundaries automatically inherits `requestId` and `requestLabel`.
   */
  withRequest<T>(label: string, fn: () => T, requestId: string = randomUUID()): T {
    return this.als.run({ requestId, requestLabel: label }, fn);
  }

  /** Returns the active `AsyncLocalStorage` request context, if any. */
  getCurrentRequest(): RequestContext | undefined {
    return this.als.getStore();
  }

  /** Clears all recorded queries and resets the auto-EXPLAIN counter. */
  clear(): void {
    this.queries = [];
    this.explainCount = 0;
  }

  /** Unsubscribes any active `diagnostics_channel` listeners registered by this collector. */
  dispose(): void {
    for (const [channelName, handler] of this.activeSubscriptions.entries()) {
      diagnosticsChannel.unsubscribe(channelName, handler);
    }
    this.activeSubscriptions.clear();
  }

  /**
   * Subscribes via `node:diagnostics_channel` so Reylo (`reylo:query`), `pg`, `mysql2`,
   * or custom query emitters stream directly into this collector.
   * Returns an `unsubscribe` cleanup function.
   */
  subscribeDiagnosticsChannels(
    channels: readonly string[] = ["reylo:query", "pg:query", "mysql2:query"],
  ): () => void {
    const registeredNow: string[] = [];
    for (const channelName of channels) {
      if (this.activeSubscriptions.has(channelName)) continue;
      const inferredEngine: Engine | undefined = channelName.startsWith("pg:")
        ? "postgres"
        : channelName.startsWith("mysql")
          ? "mysql"
          : undefined;

      const listener: diagnosticsChannel.ChannelListener = (message: unknown) => {
        if (!this.enabled || !message || typeof message !== "object") return;
        const msg = message as Record<string, unknown>;
        const rawQuery = msg.sql ?? msg.query ?? msg.text ?? msg.statement;
        let sql: string | undefined;
        let queryValues: readonly unknown[] | undefined;

        if (typeof rawQuery === "string") {
          sql = rawQuery;
        } else if (rawQuery && typeof rawQuery === "object") {
          const qObj = rawQuery as Record<string, unknown>;
          if (typeof qObj.text === "string") sql = qObj.text;
          else if (typeof qObj.sql === "string") sql = qObj.sql;
          if (Array.isArray(qObj.values)) queryValues = qObj.values;
        }
        if (!sql) return;

        const durationRaw = msg.durationMs ?? msg.duration ?? msg.elapsedMs ?? msg.timeMs;
        const durationMs = typeof durationRaw === "number" && Number.isFinite(durationRaw) ? durationRaw : 0;

        const rawParams = msg.params ?? msg.values ?? msg.parameters ?? msg.args ?? queryValues;
        const paramsCount =
          typeof msg.paramsCount === "number"
            ? msg.paramsCount
            : Array.isArray(rawParams)
              ? rawParams.length
              : undefined;

        const rowCount =
          typeof msg.rowCount === "number"
            ? msg.rowCount
            : Array.isArray(msg.rows)
              ? msg.rows.length
              : undefined;

        const errVal = msg.error;
        const error =
          errVal instanceof Error
            ? errVal.message
            : typeof errVal === "string"
              ? errVal
              : undefined;

        this.recordQuery({
          sql,
          durationMs,
          rowCount,
          paramsCount,
          engine: coerceEngine(msg.engine ?? msg.dialect, inferredEngine ?? this.defaultEngine),
          error,
          requestId: typeof msg.requestId === "string" ? msg.requestId : undefined,
          requestLabel: typeof msg.requestLabel === "string" ? msg.requestLabel : undefined,
          timestamp: typeof msg.timestamp === "number" ? msg.timestamp : undefined,
          plan: msg.plan as Plan | undefined,
          rawExplain: typeof msg.rawExplain === "string" ? msg.rawExplain : undefined,
        });
      };

      diagnosticsChannel.subscribe(channelName, listener);
      this.activeSubscriptions.set(channelName, listener);
      registeredNow.push(channelName);
    }

    return () => {
      for (const channelName of registeredNow) {
        const listener = this.activeSubscriptions.get(channelName);
        if (listener) {
          diagnosticsChannel.unsubscribe(channelName, listener);
          this.activeSubscriptions.delete(channelName);
        }
      }
    };
  }

  /**
   * Records a single SQL execution into the ring buffer. Suitable for Prisma (`$on('query')`),
   * Drizzle custom loggers, Kysely plugins, or direct instrumentation.
   */
  recordQuery(input: RecordQueryInput): RecordedQuery | null {
    if (!this.enabled) return null;
    const rawSql = (input.sql ?? input.query ?? "").trim();
    if (!rawSql || rawSql.includes(CULPRIT_INTERNAL_TAG)) return null;

    const ctx = this.als.getStore();
    const normalizedSql = normalizeSqlForFingerprint(rawSql);
    const fingerprint = fingerprintSql(rawSql);
    const durationRaw = input.durationMs ?? input.duration ?? 0;
    const durationMs = Math.max(0, Math.round(durationRaw * 1000) / 1000);

    const entry: RecordedQuery = {
      id: input.id ?? `q_${++this.seq}_${Date.now().toString(36)}`,
      timestamp: input.timestamp ?? Date.now(),
      requestId: input.requestId ?? ctx?.requestId,
      requestLabel: input.requestLabel ?? ctx?.requestLabel,
      engine: coerceEngine(input.engine, this.defaultEngine),
      sql: rawSql,
      normalizedSql,
      fingerprint,
      durationMs,
      rowCount: input.rowCount,
      paramsCount: countParams(input.params, input.paramsCount),
      error: input.error instanceof Error ? input.error.message : input.error,
      plan: input.plan,
      rawExplain: input.rawExplain,
    };

    this.queries.push(entry);
    if (this.queries.length > this.maxQueries) {
      this.queries.splice(0, this.queries.length - this.maxQueries);
    }

    if (
      !entry.plan &&
      !entry.error &&
      this.autoExplainConfig.enabled &&
      this.autoExplainConfig.runExplain
    ) {
      void this.maybeAutoExplain(entry, Array.isArray(input.params) ? input.params : undefined, this.autoExplainConfig);
    }

    return entry;
  }

  /**
   * Runs safe `EXPLAIN` for a recorded slow `SELECT` query and attaches the parsed `Plan`.
   */
  async maybeAutoExplain(
    entry: RecordedQuery,
    params: readonly unknown[] | undefined,
    override?: boolean | AutoExplainOptions,
  ): Promise<Plan | undefined> {
    if (!this.enabled || entry.plan || entry.error) return entry.plan;

    const merged: AutoExplainOptions =
      typeof override === "boolean"
        ? { ...this.autoExplainConfig, enabled: override }
        : { ...this.autoExplainConfig, ...override };

    if (!merged.enabled || !merged.runExplain) return undefined;
    const thresholdMs = merged.thresholdMs ?? this.slowThresholdMs;
    const maxExplains = merged.maxExplains ?? 50;

    if (entry.durationMs < thresholdMs) return undefined;
    if (this.explainCount >= maxExplains) return undefined;
    if (!isSafeForAutoExplain(entry.sql)) return undefined;

    this.explainCount++;
    try {
      const rawExplain = await merged.runExplain(entry.sql, params);
      if (!rawExplain || !rawExplain.trim()) return undefined;
      entry.rawExplain = rawExplain;
      const engineHint = merged.engine ?? entry.engine;
      const parsed = await parseExplainText(rawExplain, engineHint);
      if (!parsed.statement) {
        parsed.statement = entry.sql;
      }
      entry.plan = parsed;
      if (!entry.engine) {
        entry.engine = parsed.engine;
      }
      return parsed;
    } catch {
      // Never fail or disrupt host queries when auto-EXPLAIN is unsupported or rejected.
      return undefined;
    }
  }

  /**
   * Creates a Drizzle ORM `Logger` (`{ logQuery(query, params) }`) bound to this collector.
   */
  createDrizzleLogger(engine?: Engine): { logQuery: (query: string, params: unknown[]) => void } {
    return {
      logQuery: (query: string, params: unknown[]) => {
        this.recordQuery({ sql: query, durationMs: 0, params, engine: engine ?? this.defaultEngine });
      },
    };
  }

  /**
   * Computes a point-in-time `DevtoolsSnapshot` including N+1 bursts and summary counters.
   */
  getSnapshot(): DevtoolsSnapshot {
    // Newest queries first for responsive HUD display, while keeping deterministic burst grouping
    const queries = [...this.queries].reverse();

    type GroupAcc = {
      fingerprint: string;
      normalizedSql: string;
      count: number;
      totalDurationMs: number;
      maxDurationMs: number;
      requestId?: string;
      requestLabel?: string;
      queryIds: string[];
      sampleSql: string;
      anchorTimestamp: number;
    };

    const groups = new Map<string, GroupAcc>();
    const ungroupedWindowMs = 2000;

    for (const q of this.queries) {
      let key: string;
      if (q.requestId) {
        key = `req:${q.requestId}:${q.fingerprint}`;
      } else {
        const bucket = Math.floor(q.timestamp / ungroupedWindowMs);
        key = `win:${bucket}:${q.fingerprint}`;
      }

      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          fingerprint: q.fingerprint,
          normalizedSql: q.normalizedSql,
          count: 1,
          totalDurationMs: q.durationMs,
          maxDurationMs: q.durationMs,
          requestId: q.requestId,
          requestLabel: q.requestLabel,
          queryIds: [q.id],
          sampleSql: q.sql,
          anchorTimestamp: q.timestamp,
        });
      } else {
        existing.count += 1;
        existing.totalDurationMs = Math.round((existing.totalDurationMs + q.durationMs) * 1000) / 1000;
        if (q.durationMs > existing.maxDurationMs) {
          existing.maxDurationMs = q.durationMs;
          existing.sampleSql = q.sql;
        }
        existing.queryIds.push(q.id);
      }
    }

    const bursts: NPlusOneBurst[] = [];
    for (const g of groups.values()) {
      if (g.count >= this.nPlusOneThreshold) {
        bursts.push({
          fingerprint: g.fingerprint,
          normalizedSql: g.normalizedSql,
          count: g.count,
          totalDurationMs: g.totalDurationMs,
          maxDurationMs: g.maxDurationMs,
          requestId: g.requestId,
          requestLabel: g.requestLabel,
          queryIds: g.queryIds,
          sampleSql: g.sampleSql,
        });
      }
    }

    bursts.sort((a, b) => b.totalDurationMs - a.totalDurationMs || b.count - a.count);

    let slowCount = 0;
    let totalDurationMs = 0;
    for (const q of this.queries) {
      totalDurationMs += q.durationMs;
      if (q.durationMs >= this.slowThresholdMs) {
        slowCount += 1;
      }
    }

    return {
      queries,
      bursts,
      stats: {
        totalQueries: this.queries.length,
        slowCount,
        burstCount: bursts.length,
        totalDurationMs: Math.round(totalDurationMs * 100) / 100,
      },
    };
  }
}

/** Shared default collector singleton for zero-boilerplate driver instrumentation. */
export const defaultCollector = new CulpritCollector();

// ───────── Zero-Dependency Driver Wrappers ─────────

export type PgQueryResultLike = {
  rows?: unknown[];
  rowCount?: number | null;
};

export type PgQueryable = {
  query: (...args: any[]) => any;
};

function extractPgExplainText(res: unknown): string | null {
  if (!res || typeof res !== "object") return null;
  const rows = (res as PgQueryResultLike).rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first = rows[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object") {
    const record = first as Record<string, unknown>;
    const qp = record["QUERY PLAN"] ?? record["query plan"] ?? Object.values(record)[0];
    if (typeof qp === "string") {
      // Multiple text lines returned as rows by EXPLAIN (ANALYZE)
      if (rows.length > 1) {
        return rows
          .map((r) => {
            if (typeof r === "string") return r;
            if (r && typeof r === "object") {
              const v = (r as Record<string, unknown>)["QUERY PLAN"] ?? Object.values(r as Record<string, unknown>)[0];
              return typeof v === "string" ? v : "";
            }
            return "";
          })
          .join("\n");
      }
      return qp;
    }
    if (qp !== undefined) {
      return JSON.stringify(qp);
    }
  }
  return null;
}

/**
 * Instruments a `pg` `Pool` or `Client` with zero dependencies. Captures SQL text,
 * parameter count, row count, duration, active request context, and optional safe
 * `EXPLAIN (FORMAT JSON)` on slow `SELECT` queries.
 */
export function instrumentPg<T extends PgQueryable>(
  poolOrClient: T,
  opts: InstrumentDriverOptions = {},
): T {
  if ((poolOrClient as Record<symbol, unknown>)[INSTRUMENTED]) {
    return poolOrClient;
  }
  const collector = opts.collector ?? defaultCollector;
  const engine: Engine = opts.engine ?? "postgres";

  const explainRunner: ExplainRunner = async (sql, params) => {
    const cleanSql = sql.replace(/;\s*$/, "");
    const explainSql = `${CULPRIT_INTERNAL_TAG} EXPLAIN (FORMAT JSON) ${cleanSql}`;
    const res =
      params && params.length > 0
        ? await poolOrClient.query(explainSql, params)
        : await poolOrClient.query(explainSql);
    return extractPgExplainText(res);
  };

  const proxy = new Proxy(poolOrClient, {
    get(target, prop, receiver) {
      if (prop === INSTRUMENTED) return true;
      const orig = Reflect.get(target, prop, receiver);

      if (prop === "connect" && typeof orig === "function") {
        return function (this: unknown, ...args: unknown[]) {
          if (typeof args[0] === "function") {
            const cb = args[0] as (err: unknown, client?: PgQueryable, done?: unknown) => void;
            return orig.call(target, (err: unknown, client?: PgQueryable, done?: unknown) => {
              cb(err, client ? instrumentPg(client, opts) : client, done);
            });
          }
          const p = orig.apply(target, args);
          if (p && typeof p.then === "function") {
            return p.then((client: unknown) =>
              client && typeof (client as PgQueryable).query === "function"
                ? instrumentPg(client as PgQueryable, opts)
                : client,
            );
          }
          return p;
        };
      }

      if (prop !== "query" || typeof orig !== "function") {
        return typeof orig === "function" ? orig.bind(target) : orig;
      }

      return function (this: unknown, ...args: unknown[]) {
        if (!collector.enabled) {
          return orig.apply(target, args);
        }

        let sql = "";
        let params: readonly unknown[] | undefined;
        let callbackIndex = -1;

        if (typeof args[0] === "string") {
          sql = args[0];
          if (Array.isArray(args[1])) {
            params = args[1];
            if (typeof args[2] === "function") callbackIndex = 2;
          } else if (typeof args[1] === "function") {
            callbackIndex = 1;
          }
        } else if (args[0] && typeof args[0] === "object") {
          const cfg = args[0] as { text?: string; values?: readonly unknown[]; callback?: unknown };
          sql = cfg.text ?? "";
          if (Array.isArray(cfg.values)) params = cfg.values;
          if (typeof args[1] === "function") callbackIndex = 1;
        }

        if (!sql || sql.includes(CULPRIT_INTERNAL_TAG)) {
          return orig.apply(target, args);
        }

        const startedAt = performance.now();
        const timestamp = Date.now();
        const reqCtx = collector.getCurrentRequest();

        const resolveExplainOpts = (): AutoExplainOptions | undefined => {
          if (opts.autoExplain === false) return { enabled: false };
          if (opts.autoExplain === true) return { enabled: true, engine, runExplain: explainRunner };
          if (opts.autoExplain && typeof opts.autoExplain === "object") {
            return {
              enabled: opts.autoExplain.enabled ?? true,
              engine,
              runExplain: opts.autoExplain.runExplain ?? explainRunner,
              thresholdMs: opts.autoExplain.thresholdMs,
              maxExplains: opts.autoExplain.maxExplains,
            };
          }
          return { engine, runExplain: explainRunner };
        };

        if (callbackIndex >= 0) {
          const origCb = args[callbackIndex] as (err: unknown, res?: PgQueryResultLike) => void;
          const nextArgs = [...args];
          nextArgs[callbackIndex] = (err: unknown, res?: PgQueryResultLike) => {
            const durationMs = performance.now() - startedAt;
            const rowCount =
              typeof res?.rowCount === "number"
                ? res.rowCount
                : Array.isArray(res?.rows)
                  ? res.rows.length
                  : undefined;
            const entry = collector.recordQuery({
              sql,
              durationMs,
              params,
              rowCount,
              engine,
              timestamp,
              requestId: reqCtx?.requestId,
              requestLabel: reqCtx?.requestLabel,
              error: err ? (err instanceof Error ? err : String(err)) : undefined,
            });
            if (entry && !err) {
              void collector.maybeAutoExplain(entry, params, resolveExplainOpts()).finally(() => {
                origCb(err, res);
              });
              return;
            }
            origCb(err, res);
          };
          return orig.apply(target, nextArgs);
        }

        const resultPromise = orig.apply(target, args);
        if (resultPromise && typeof resultPromise.then === "function") {
          return (resultPromise as Promise<PgQueryResultLike>).then(
            async (res) => {
              const durationMs = performance.now() - startedAt;
              const rowCount =
                typeof res?.rowCount === "number"
                  ? res.rowCount
                  : Array.isArray(res?.rows)
                    ? res.rows.length
                    : undefined;
              const entry = collector.recordQuery({
                sql,
                durationMs,
                params,
                rowCount,
                engine,
                timestamp,
                requestId: reqCtx?.requestId,
                requestLabel: reqCtx?.requestLabel,
              });
              if (entry) {
                await collector.maybeAutoExplain(entry, params, resolveExplainOpts());
              }
              return res;
            },
            (err: unknown) => {
              const durationMs = performance.now() - startedAt;
              collector.recordQuery({
                sql,
                durationMs,
                params,
                engine,
                timestamp,
                requestId: reqCtx?.requestId,
                requestLabel: reqCtx?.requestLabel,
                error: err instanceof Error ? err : String(err),
              });
              throw err;
            },
          );
        }
        return resultPromise;
      };
    },
  });

  return proxy;
}

export type MysqlQueryable = {
  query: (...args: any[]) => any;
  execute?: (...args: any[]) => any;
};

function extractMysqlExplainText(res: unknown): string | null {
  const rows = Array.isArray(res) && Array.isArray(res[0]) ? (res[0] as unknown[]) : Array.isArray(res) ? res : null;
  if (!rows || rows.length === 0) return null;
  const first = rows[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object") {
    const rec = first as Record<string, unknown>;
    const val = rec.EXPLAIN ?? rec.explain ?? Object.values(rec)[0];
    if (typeof val === "string") return val;
    if (val !== undefined) return JSON.stringify(val);
  }
  return null;
}

/**
 * Instruments a `mysql2` Promise or callback pool/connection (`query` and `execute`).
 */
export function instrumentMysql<T extends MysqlQueryable>(
  poolOrConn: T,
  opts: InstrumentDriverOptions = {},
): T {
  if ((poolOrConn as Record<symbol, unknown>)[INSTRUMENTED]) {
    return poolOrConn;
  }
  const collector = opts.collector ?? defaultCollector;
  const engine: Engine = opts.engine ?? "mysql";

  const explainRunner: ExplainRunner = async (sql, params) => {
    const cleanSql = sql.replace(/;\s*$/, "");
    const explainSql = `${CULPRIT_INTERNAL_TAG} EXPLAIN FORMAT=JSON ${cleanSql}`;
    const res =
      params && params.length > 0
        ? await poolOrConn.query(explainSql, params)
        : await poolOrConn.query(explainSql);
    return extractMysqlExplainText(res);
  };

  return new Proxy(poolOrConn, {
    get(target, prop, receiver) {
      if (prop === INSTRUMENTED) return true;
      const orig = Reflect.get(target, prop, receiver);
      if ((prop !== "query" && prop !== "execute") || typeof orig !== "function") {
        return typeof orig === "function" ? orig.bind(target) : orig;
      }

      return function (this: unknown, ...args: unknown[]) {
        if (!collector.enabled) return orig.apply(target, args);

        let sql = "";
        let params: readonly unknown[] | undefined;
        if (typeof args[0] === "string") {
          sql = args[0];
          if (Array.isArray(args[1])) params = args[1];
        } else if (args[0] && typeof args[0] === "object") {
          const cfg = args[0] as { sql?: string; values?: readonly unknown[] };
          sql = cfg.sql ?? "";
          if (Array.isArray(cfg.values)) params = cfg.values;
          else if (Array.isArray(args[1])) params = args[1];
        }

        if (!sql || sql.includes(CULPRIT_INTERNAL_TAG)) {
          return orig.apply(target, args);
        }

        const startedAt = performance.now();
        const timestamp = Date.now();
        const reqCtx = collector.getCurrentRequest();

        const resolveExplainOpts = (): AutoExplainOptions => {
          if (opts.autoExplain === false) return { enabled: false };
          if (opts.autoExplain === true) return { enabled: true, engine, runExplain: explainRunner };
          if (opts.autoExplain && typeof opts.autoExplain === "object") {
            return {
              enabled: opts.autoExplain.enabled ?? true,
              engine,
              runExplain: opts.autoExplain.runExplain ?? explainRunner,
              thresholdMs: opts.autoExplain.thresholdMs,
              maxExplains: opts.autoExplain.maxExplains,
            };
          }
          return { engine, runExplain: explainRunner };
        };

        const out = orig.apply(target, args);
        if (out && typeof out.then === "function") {
          return (out as Promise<unknown>).then(
            async (res) => {
              const durationMs = performance.now() - startedAt;
              const rowsPart = Array.isArray(res) ? res[0] : res;
              const rowCount = Array.isArray(rowsPart)
                ? rowsPart.length
                : rowsPart && typeof rowsPart === "object" && typeof (rowsPart as { affectedRows?: number }).affectedRows === "number"
                  ? (rowsPart as { affectedRows: number }).affectedRows
                  : undefined;

              const entry = collector.recordQuery({
                sql,
                durationMs,
                params,
                rowCount,
                engine,
                timestamp,
                requestId: reqCtx?.requestId,
                requestLabel: reqCtx?.requestLabel,
              });
              if (entry) {
                await collector.maybeAutoExplain(entry, params, resolveExplainOpts());
              }
              return res;
            },
            (err: unknown) => {
              collector.recordQuery({
                sql,
                durationMs: performance.now() - startedAt,
                params,
                engine,
                timestamp,
                requestId: reqCtx?.requestId,
                requestLabel: reqCtx?.requestLabel,
                error: err instanceof Error ? err : String(err),
              });
              throw err;
            },
          );
        }
        return out;
      };
    },
  });
}

export type SqliteStatementLike = {
  all?: (...params: any[]) => any;
  get?: (...params: any[]) => any;
  run?: (...params: any[]) => any;
  values?: (...params: any[]) => any;
};

export type SqliteDatabaseLike = {
  prepare?: (sql: string) => SqliteStatementLike;
  exec?: (sql: string) => any;
  query?: (sql: string) => SqliteStatementLike;
};

function formatSqliteExplainRows(rows: unknown): string | null {
  if (typeof rows === "string") return rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const lines: string[] = [];
  for (let idx = 0; idx < rows.length; idx++) {
    const r = rows[idx];
    if (r && typeof r === "object") {
      const rec = r as Record<string, unknown>;
      const id = rec.id ?? rec.selectid ?? idx + 1;
      const parent = rec.parent ?? 0;
      const notused = rec.notused ?? 0;
      const detail = rec.detail ?? "";
      if (typeof detail === "string" && detail.length > 0) {
        lines.push(`${id}|${parent}|${notused}|${detail}`);
      }
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Instruments a synchronous SQLite handle (`better-sqlite3`, `node:sqlite`, `bun:sqlite`).
 */
export function instrumentSqlite<T extends SqliteDatabaseLike>(
  db: T,
  opts: InstrumentDriverOptions = {},
): T {
  if ((db as Record<symbol, unknown>)[INSTRUMENTED]) {
    return db;
  }
  const collector = opts.collector ?? defaultCollector;
  const engine: Engine = opts.engine ?? "sqlite";

  const explainRunner: ExplainRunner = async (sql, params) => {
    const cleanSql = sql.replace(/;\s*$/, "");
    const explainSql = `${CULPRIT_INTERNAL_TAG} EXPLAIN QUERY PLAN ${cleanSql}`;
    const prep = db.prepare ?? db.query;
    if (typeof prep !== "function") return null;
    const stmt = prep.call(db, explainSql);
    if (typeof stmt.all !== "function") return null;
    const rows = params && params.length > 0 ? stmt.all(...params) : stmt.all();
    return formatSqliteExplainRows(rows);
  };

  const wrapStatement = (stmt: SqliteStatementLike, sql: string): SqliteStatementLike => {
    if (!stmt || typeof stmt !== "object" || sql.includes(CULPRIT_INTERNAL_TAG)) {
      return stmt;
    }
    return new Proxy(stmt, {
      get(stmtTarget, methodProp, stmtReceiver) {
        const method = Reflect.get(stmtTarget, methodProp, stmtReceiver);
        if (
          (methodProp !== "all" && methodProp !== "get" && methodProp !== "run" && methodProp !== "values") ||
          typeof method !== "function"
        ) {
          return typeof method === "function" ? method.bind(stmtTarget) : method;
        }

        return function (this: unknown, ...callArgs: unknown[]) {
          if (!collector.enabled) return method.apply(stmtTarget, callArgs);
          const params =
            callArgs.length === 1 && Array.isArray(callArgs[0])
              ? (callArgs[0] as unknown[])
              : callArgs;
          const startedAt = performance.now();
          try {
            const res = method.apply(stmtTarget, callArgs);
            const durationMs = performance.now() - startedAt;
            const rowCount =
              methodProp === "all" || methodProp === "values"
                ? Array.isArray(res)
                  ? res.length
                  : undefined
                : methodProp === "get"
                  ? res === undefined || res === null
                    ? 0
                    : 1
                  : res && typeof res === "object" && typeof (res as { changes?: number }).changes === "number"
                    ? (res as { changes: number }).changes
                    : undefined;

            const entry = collector.recordQuery({
              sql,
              durationMs,
              params,
              rowCount,
              engine,
            });
            if (entry && opts.autoExplain) {
              const explainOpts: AutoExplainOptions =
                typeof opts.autoExplain === "boolean"
                  ? { enabled: opts.autoExplain, engine, runExplain: explainRunner }
                  : {
                      enabled: opts.autoExplain.enabled ?? true,
                      engine,
                      runExplain: opts.autoExplain.runExplain ?? explainRunner,
                      thresholdMs: opts.autoExplain.thresholdMs,
                      maxExplains: opts.autoExplain.maxExplains,
                    };
              void collector.maybeAutoExplain(entry, params, explainOpts);
            }
            return res;
          } catch (err) {
            collector.recordQuery({
              sql,
              durationMs: performance.now() - startedAt,
              params,
              engine,
              error: err instanceof Error ? err : String(err),
            });
            throw err;
          }
        };
      },
    });
  };

  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === INSTRUMENTED) return true;
      const orig = Reflect.get(target, prop, receiver);

      if ((prop === "prepare" || prop === "query") && typeof orig === "function") {
        return function (this: unknown, sql: string, ...rest: unknown[]) {
          const stmt = orig.call(target, sql, ...rest) as SqliteStatementLike;
          return wrapStatement(stmt, sql);
        };
      }

      if (prop === "exec" && typeof orig === "function") {
        return function (this: unknown, sql: string, ...rest: unknown[]) {
          if (!collector.enabled || sql.includes(CULPRIT_INTERNAL_TAG)) {
            return orig.call(target, sql, ...rest);
          }
          const startedAt = performance.now();
          try {
            const out = orig.call(target, sql, ...rest);
            collector.recordQuery({ sql, durationMs: performance.now() - startedAt, engine });
            return out;
          } catch (err) {
            collector.recordQuery({
              sql,
              durationMs: performance.now() - startedAt,
              engine,
              error: err instanceof Error ? err : String(err),
            });
            throw err;
          }
        };
      }

      return typeof orig === "function" ? orig.bind(target) : orig;
    },
  });
}

// ───────── HTTP / Fetch DevTools Endpoints ─────────

function isLoopbackToken(raw: string): boolean {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return false;
  // Strip brackets and optional :port on IPv4 / localhost
  let host = trimmed;
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close !== -1) host = host.slice(1, close);
  } else if (host.split(":").length === 2) {
    // host:port (not raw IPv6)
    host = host.split(":")[0]!;
  }
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "::ffff:127.0.0.1" ||
    host === "0:0:0:0:0:0:0:1" ||
    host.startsWith("127.")
  );
}

function checkAccessAllowed(
  params: {
    urlHost: string;
    hostHeader?: string | null;
    forwardedFor?: string | null;
    remoteAddress?: string | null;
  },
  options: DevtoolsHandlerOptions,
): { ok: true } | { ok: false; status: number; reason: string } {
  if (process.env.NODE_ENV === "production" && !options.allowProduction) {
    return {
      ok: false,
      status: 403,
      reason: "Culprit DevTools endpoint is disabled when NODE_ENV is production.",
    };
  }

  if (options.allowRemote) {
    return { ok: true };
  }

  if (params.forwardedFor) {
    const hops = params.forwardedFor.split(",").map((s) => s.trim()).filter(Boolean);
    if (hops.some((hop) => !isLoopbackToken(hop))) {
      return {
        ok: false,
        status: 403,
        reason: "Culprit DevTools refuses non-loopback requests unless allowRemote is true.",
      };
    }
  }

  if (params.remoteAddress && !isLoopbackToken(params.remoteAddress)) {
    return {
      ok: false,
      status: 403,
      reason: "Culprit DevTools refuses non-loopback requests unless allowRemote is true.",
    };
  }

  if (params.hostHeader && !isLoopbackToken(params.hostHeader)) {
    return {
      ok: false,
      status: 403,
      reason: "Culprit DevTools refuses non-loopback requests unless allowRemote is true.",
    };
  }

  if (params.urlHost && !isLoopbackToken(params.urlHost)) {
    return {
      ok: false,
      status: 403,
      reason: "Culprit DevTools refuses non-loopback requests unless allowRemote is true.",
    };
  }

  return { ok: true };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function normalizeBasePath(basePath?: string): string {
  const raw = (basePath ?? "/__culprit").trim();
  if (!raw || raw === "/") return "/__culprit";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

/**
 * Creates a standard Web Fetch `(req: Request) => Promise<Response>` handler
 * suitable for Next.js Route Handlers, Hono, Remix, SvelteKit, Astro, and Bun.serve.
 *
 * Routes:
 * - `GET  /__culprit/snapshot` -> `DevtoolsSnapshot`
 * - `POST /__culprit/clear`    -> clears recorded queries
 * - `POST /__culprit/parse`    -> parses raw `EXPLAIN` text into a `Plan` via `@culpritsql/plans`
 */
export function createDevtoolsHandler(
  collector: CulpritCollector = defaultCollector,
  options: DevtoolsHandlerOptions = {},
): (req: Request, info?: { remoteAddress?: string }) => Promise<Response> {
  const basePath = normalizeBasePath(options.basePath);

  return async (req: Request, info?: { remoteAddress?: string }): Promise<Response> => {
    const parsedUrl = new URL(req.url, "http://localhost");
    const access = checkAccessAllowed(
      {
        urlHost: parsedUrl.hostname,
        hostHeader: req.headers.get("host"),
        forwardedFor: req.headers.get("x-forwarded-for"),
        remoteAddress: info?.remoteAddress ?? null,
      },
      options,
    );
    if (!access.ok) {
      return jsonResponse({ error: access.reason }, access.status);
    }

    const pathname = parsedUrl.pathname.replace(/\/+$/, "") || "/";
    const route = pathname.startsWith(basePath) ? pathname.slice(basePath.length) || "/" : pathname;

    if (req.method === "GET" && (route === "/snapshot" || route === "/")) {
      return jsonResponse(collector.getSnapshot());
    }

    if (req.method === "POST" && route === "/clear") {
      collector.clear();
      return jsonResponse(collector.getSnapshot());
    }

    if (req.method === "POST" && route === "/parse") {
      const rawText = await req.text();
      if (Buffer.byteLength(rawText, "utf8") > MAX_EXPLAIN_BODY_BYTES) {
        return jsonResponse({ error: "EXPLAIN payload exceeds maximum allowed size (2 MB)." }, 413);
      }

      let rawExplain = rawText;
      let engine: Engine | undefined;
      const contentType = req.headers.get("content-type") ?? "";
      if (contentType.includes("application/json") || rawText.trim().startsWith("{")) {
        try {
          const parsedBody = JSON.parse(rawText) as Record<string, unknown>;
          if (typeof parsedBody.rawExplain === "string") {
            rawExplain = parsedBody.rawExplain;
            engine = coerceEngine(parsedBody.engine);
          } else if (typeof parsedBody.explain === "string") {
            rawExplain = parsedBody.explain;
            engine = coerceEngine(parsedBody.engine);
          }
        } catch {
          // If the raw body itself is a JSON plan (e.g. MySQL EXPLAIN FORMAT=JSON object), pass rawText directly.
        }
      }

      if (!rawExplain || !rawExplain.trim()) {
        return jsonResponse({ error: "Provide non-empty EXPLAIN output to parse." }, 400);
      }

      try {
        const plan = await parseExplainText(rawExplain, engine);
        return jsonResponse({ plan });
      } catch (err) {
        if (err instanceof ParserError) {
          return jsonResponse(
            {
              error: err.error.message,
              code: err.error.code,
              hint: err.error.hint,
            },
            400,
          );
        }
        return jsonResponse(
          { error: err instanceof Error ? err.message : "Failed to parse EXPLAIN output." },
          400,
        );
      }
    }

    return jsonResponse({ error: `Unknown Culprit DevTools route: ${req.method} ${pathname}` }, 404);
  };
}

function readNodeRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      total += buf.length;
      if (total > maxBytes) {
        reject(new Error("BODY_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Creates a Connect / Express / Node `http.Server` middleware for `/__culprit/*`.
 * For non-DevTools routes, when `next` is provided, automatically wraps downstream
 * handlers inside `collector.withRequest("METHOD /path", ...)` so queries inherit request labels!
 */
export function createNodeDevtoolsMiddleware(
  collector: CulpritCollector = defaultCollector,
  options: DevtoolsHandlerOptions & { correlateRequests?: boolean } = {},
): (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => void {
  const basePath = normalizeBasePath(options.basePath);
  const fetchHandler = createDevtoolsHandler(collector, options);
  const correlate = options.correlateRequests ?? true;

  return (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => {
    const rawUrl = req.url ?? "/";
    const hostHeader = typeof req.headers.host === "string" ? req.headers.host : "localhost";
    const parsedUrl = new URL(rawUrl, `http://${hostHeader}`);

    if (!parsedUrl.pathname.startsWith(basePath)) {
      if (next) {
        if (correlate && collector.enabled) {
          const label = `${req.method ?? "GET"} ${parsedUrl.pathname}`;
          collector.withRequest(label, () => next());
        } else {
          next();
        }
        return;
      }
      res.statusCode = 404;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Not Found" }));
      return;
    }

    void (async () => {
      try {
        const method = req.method ?? "GET";
        const body =
          method === "GET" || method === "HEAD"
            ? undefined
            : await readNodeRequestBody(req, MAX_EXPLAIN_BODY_BYTES + 1024);

        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string") headers.set(key, value);
          else if (Array.isArray(value)) headers.set(key, value.join(", "));
        }

        const webReq = new Request(parsedUrl.toString(), {
          method,
          headers,
          body,
        });

        const webRes = await fetchHandler(webReq, {
          remoteAddress: req.socket?.remoteAddress,
        });

        res.statusCode = webRes.status;
        webRes.headers.forEach((v, k) => res.setHeader(k, v));
        const text = await webRes.text();
        res.end(text);
      } catch (err) {
        if (err instanceof Error && err.message === "BODY_TOO_LARGE") {
          res.statusCode = 413;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "EXPLAIN payload exceeds maximum allowed size (2 MB)." }));
          return;
        }
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "Internal Culprit DevTools error." }));
      }
    })();
  };
}
