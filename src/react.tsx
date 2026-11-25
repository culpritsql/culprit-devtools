import {
  DeadlockViewer,
  ExtendedEventsViewer,
  PlanCanvas,
  PlanDiffViewer,
  PlanViewer,
  type PlanViewerTheme,
  type QueryStat,
  Sql,
} from "@culpritsql/plan-viewer";
import {
  AlertTriangle,
  Database,
  FileSearch,
  FolderOpen,
  Layers,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Search,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { type ChangeEvent, type DragEvent, useEffect, useMemo, useState } from "react";
import {
  type Deadlock,
  type DevtoolsSnapshot,
  detectNPlusOneAdvice,
  EMPTY_DEVTOOLS_SNAPSHOT,
  type Engine,
  type ExtendedEventsBatch,
  type Plan,
  type RecordedQuery,
} from "./shared.js";

export { DeadlockViewer, ExtendedEventsViewer, PlanCanvas, PlanDiffViewer, PlanViewer };

export type DevtoolsPosition = "bottom-right" | "bottom-left" | "top-right" | "top-left";
export type DevtoolsTab = "queries" | "bursts" | "plan";
export type QueryFilterMode = "all" | "slow" | "nplus1" | "with-plan";
export type InspectorMode = "viewer" | "canvas";

export type InspectorPayload =
  | { kind: "plan"; plan: Plan; label?: string }
  | { kind: "events"; events: ExtendedEventsBatch; label?: string }
  | { kind: "deadlocks"; deadlocks: Deadlock[]; label?: string };

export type CulpritDevtoolsProps = {
  /** DevTools server route prefix. Defaults to `"/__culprit"`. */
  endpoint?: string;
  /** Controlled snapshot for offline, Storybook, or static inspection without polling. */
  snapshot?: DevtoolsSnapshot;
  /** Initial snapshot rendered immediately in SSR and hydrated before the first poll. */
  initialSnapshot?: DevtoolsSnapshot;
  /** Polling interval in milliseconds when `snapshot` is uncontrolled. Defaults to `1500` (<= 0 disables polling). */
  pollIntervalMs?: number;
  /** Corner anchor for the floating trigger pill. Defaults to `"bottom-right"`. */
  position?: DevtoolsPosition;
  /** Color theme applied to both the DevTools drawer and embedded `<PlanViewer />`. Defaults to `"dark"`. */
  theme?: PlanViewerTheme;
  /** Queries at or above this threshold (ms) are highlighted as slow in the UI. Defaults to `20`. */
  slowThresholdMs?: number;
  /** Open the docked drawer initially (useful for SSR previews and tests). Defaults to `false`. */
  defaultOpen?: boolean;
  /** Controlled open state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Initial active tab (`"queries" | "bursts" | "plan"`). Defaults to `"queries"`. */
  defaultTab?: DevtoolsTab;
  /** Controlled active tab. */
  tab?: DevtoolsTab;
  onTabChange?: (tab: DevtoolsTab) => void;
  /** Pre-selected query id for the Plan Inspector tab. */
  defaultSelectedQueryId?: string | null;
  /** Pre-loaded plan, deadlock, or Extended Events batch for the Inspector tab (SSR / Storybook / offline). */
  initialInspectorPayload?: InspectorPayload | null;
  /** Optional custom EXPLAIN parser callback for serverless / browser-only setups. */
  onParseExplain?: (rawExplain: string, engine?: Engine) => Promise<Plan> | Plan;
  /** Optional custom binary `.xel` parser callback for serverless / browser-only setups. */
  onParseXel?: (bytes: Uint8Array) => Promise<ExtendedEventsBatch> | ExtendedEventsBatch;
  className?: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
}

function hasXelHeader(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x5a &&
    bytes[1] === 0x37 &&
    bytes[2] === 0xab &&
    bytes[3] === 0xef
  );
}

function decodeUploadedText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 10) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function toQueryStat(query: RecordedQuery): QueryStat {
  return {
    requests: null,
    resolved_write_target: null,
    id: query.id,
    query_hash: query.fingerprint,
    text: query.sql,
    parameters: null,
    object_name: null,
    executions: 1,
    total_time_ms: query.durationMs,
    mean_time_ms: query.durationMs,
    max_time_ms: query.durationMs,
    stddev_time_ms: null,
    cpu_time_ms: null,
    rows: query.rowCount ?? null,
    logical_reads: null,
    physical_reads: null,
    temporary_work: null,
    first_seen: null,
    last_seen: null,
    plans: [],
    plan: query.plan ?? null,
    waits: [],
    trend: null,
    spread: null,
    costs: null,
    rows_affected: null,
    plan_id: null,
  };
}

export function CulpritDevtools({
  endpoint = "/__culprit",
  snapshot: controlledSnapshot,
  initialSnapshot,
  pollIntervalMs = 1500,
  position = "bottom-right",
  theme = "dark",
  slowThresholdMs = 20,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  defaultTab = "queries",
  tab: controlledTab,
  onTabChange,
  defaultSelectedQueryId,
  initialInspectorPayload = null,
  onParseExplain,
  onParseXel,
  className,
}: CulpritDevtoolsProps) {
  const [internalSnapshot, setInternalSnapshot] = useState<DevtoolsSnapshot>(
    initialSnapshot ?? EMPTY_DEVTOOLS_SNAPSHOT,
  );
  const [internalOpen, setInternalOpen] = useState<boolean>(defaultOpen);
  const [internalTab, setInternalTab] = useState<DevtoolsTab>(defaultTab);
  const [paused, setPaused] = useState<boolean>(false);
  const [expanded, setExpanded] = useState<boolean>(false);
  const [filterMode, setFilterMode] = useState<QueryFilterMode>("all");
  const [burstFingerprintFilter, setBurstFingerprintFilter] = useState<string | null>(null);
  const [searchText, setSearchText] = useState<string>("");
  const [selectedQueryId, setSelectedQueryId] = useState<string | null>(() => {
    if (defaultSelectedQueryId !== undefined) return defaultSelectedQueryId;
    const snap = controlledSnapshot ?? initialSnapshot;
    return snap?.queries.find((q) => Boolean(q.plan))?.id ?? snap?.queries[0]?.id ?? null;
  });
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>("viewer");
  const [pastedExplain, setPastedExplain] = useState<string>("");
  const [pasteEngine, setPasteEngine] = useState<Engine | "auto">("auto");
  const [pastedPayload, setPastedPayload] = useState<InspectorPayload | null>(
    initialInspectorPayload,
  );
  const [deadlockIdx, setDeadlockIdx] = useState<number>(0);
  const [parseError, setParseError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState<boolean>(false);
  const [pasteOpen, setPasteOpen] = useState<boolean>(false);

  const activeSnapshot = controlledSnapshot ?? internalSnapshot;
  const isOpen = controlledOpen ?? internalOpen;
  const activeTab = controlledTab ?? internalTab;

  const setOpen = (next: boolean) => {
    setInternalOpen(next);
    onOpenChange?.(next);
  };

  const setTab = (next: DevtoolsTab) => {
    setInternalTab(next);
    onTabChange?.(next);
  };

  const normalizedEndpoint = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;

  useEffect(() => {
    if (controlledSnapshot !== undefined || paused || pollIntervalMs <= 0) {
      return;
    }
    let cancelled = false;

    const pull = async () => {
      try {
        const res = await fetch(`${normalizedEndpoint}/snapshot`, {
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as DevtoolsSnapshot;
        if (!cancelled && data && Array.isArray(data.queries)) {
          setInternalSnapshot(data);
        }
      } catch {
        // Keep existing snapshot silently when server is restarting or offline.
      }
    };

    void pull();
    const timer = setInterval(() => {
      void pull();
    }, pollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [controlledSnapshot, normalizedEndpoint, paused, pollIntervalMs]);

  const burstFingerprints = useMemo(() => {
    const set = new Set<string>();
    for (const b of activeSnapshot.bursts) {
      set.add(b.fingerprint);
    }
    return set;
  }, [activeSnapshot.bursts]);

  const maxQueryDuration = useMemo(() => {
    let max = 1;
    for (const q of activeSnapshot.queries) {
      if (q.durationMs > max) max = q.durationMs;
    }
    return max;
  }, [activeSnapshot.queries]);

  const filteredQueries = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    return activeSnapshot.queries.filter((q) => {
      if (burstFingerprintFilter && q.fingerprint !== burstFingerprintFilter) {
        return false;
      }
      if (filterMode === "slow" && q.durationMs < slowThresholdMs) return false;
      if (filterMode === "nplus1" && !burstFingerprints.has(q.fingerprint)) return false;
      if (filterMode === "with-plan" && !q.plan && !q.rawExplain) return false;
      if (needle) {
        const hay = `${q.sql} ${q.requestLabel ?? ""} ${q.engine ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [activeSnapshot.queries, burstFingerprintFilter, burstFingerprints, filterMode, searchText, slowThresholdMs]);

  const queriesWithPlan = useMemo(
    () => activeSnapshot.queries.filter((q) => Boolean(q.plan)),
    [activeSnapshot.queries],
  );

  const selectedQuery = useMemo(() => {
    if (selectedQueryId) {
      const match = activeSnapshot.queries.find((q) => q.id === selectedQueryId);
      if (match) return match;
    }
    return queriesWithPlan[0] ?? activeSnapshot.queries[0] ?? null;
  }, [activeSnapshot.queries, queriesWithPlan, selectedQueryId]);

  const pastedPlan = pastedPayload?.kind === "plan" ? pastedPayload.plan : null;
  const activePlan: Plan | null = pastedPlan ?? (pastedPayload ? null : (selectedQuery?.plan ?? null));
  const activeInspectorPayload: InspectorPayload | null =
    pastedPayload ?? (selectedQuery?.plan ? { kind: "plan", plan: selectedQuery.plan } : null);
  const activeQueryStat = useMemo(
    () => (pastedPayload || !selectedQuery ? null : toQueryStat(selectedQuery)),
    [pastedPayload, selectedQuery],
  );

  const hasErrors = useMemo(
    () => activeSnapshot.queries.some((q) => Boolean(q.error)),
    [activeSnapshot.queries],
  );

  const statusTone: "good" | "amber" | "coral" =
    activeSnapshot.stats.burstCount > 0 || hasErrors
      ? "coral"
      : activeSnapshot.stats.slowCount > 0
        ? "amber"
        : "good";

  const pillSummary =
    activeSnapshot.stats.burstCount > 0
      ? `⚡ SQL · ${activeSnapshot.stats.totalQueries} · ${activeSnapshot.stats.burstCount} N+1`
      : activeSnapshot.stats.slowCount > 0
        ? `⚡ SQL · ${activeSnapshot.stats.totalQueries} · ${activeSnapshot.stats.slowCount} slow`
        : `⚡ SQL · ${activeSnapshot.stats.totalQueries}`;

  const handleClear = async () => {
    setPastedPayload(null);
    setBurstFingerprintFilter(null);
    if (controlledSnapshot === undefined) {
      setInternalSnapshot(EMPTY_DEVTOOLS_SNAPSHOT);
      try {
        await fetch(`${normalizedEndpoint}/clear`, { method: "POST" });
      } catch {
        // Ignore network errors when clearing offline buffer
      }
    }
  };

  const handleInspectQuery = async (q: RecordedQuery) => {
    setPastedPayload(null);
    setParseError(null);
    setSelectedQueryId(q.id);
    setTab("plan");

    if (!q.plan && q.rawExplain) {
      await handleParseText(q.rawExplain, q.engine);
    } else if (!q.plan) {
      setPasteOpen(true);
    }
  };

  const handleParseText = async (rawText: string, engineHint?: Engine, customLabel?: string) => {
    const trimmed = rawText.trim();
    if (!trimmed) {
      setParseError("Paste non-empty EXPLAIN, deadlock, or Extended Events output to inspect.");
      return;
    }
    setIsParsing(true);
    setParseError(null);
    try {
      if (onParseExplain) {
        const parsed = await onParseExplain(trimmed, engineHint);
        setPastedPayload({ kind: "plan", plan: parsed, label: customLabel });
        setPasteOpen(false);
      } else {
        const res = await fetch(`${normalizedEndpoint}/parse`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rawExplain: trimmed, engine: engineHint }),
        });
        const data = (await res.json()) as {
          plan?: Plan;
          events?: ExtendedEventsBatch;
          deadlocks?: Deadlock[];
          error?: string;
        };
        if (!res.ok) {
          setParseError(data.error ?? "Unable to parse diagnostic output.");
          return;
        }
        if (data.events) {
          setPastedPayload({ kind: "events", events: data.events, label: customLabel });
          setPasteOpen(false);
          return;
        }
        if (data.deadlocks && data.deadlocks.length > 0) {
          setDeadlockIdx(0);
          setPastedPayload({ kind: "deadlocks", deadlocks: data.deadlocks, label: customLabel });
          setPasteOpen(false);
          return;
        }
        if (!data.plan) {
          setParseError(data.error ?? "Unable to parse EXPLAIN output.");
          return;
        }
        setPastedPayload({ kind: "plan", plan: data.plan, label: customLabel });
        setPasteOpen(false);
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Unable to reach DevTools /parse endpoint.");
    } finally {
      setIsParsing(false);
    }
  };

  const handleParseXelFile = async (bytes: Uint8Array, fileName: string) => {
    setIsParsing(true);
    setParseError(null);
    try {
      if (onParseXel) {
        const events = await onParseXel(bytes);
        setPastedPayload({ kind: "events", events, label: fileName });
        setPasteOpen(false);
      } else {
        const res = await fetch(`${normalizedEndpoint}/parse`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ xelBase64: bytesToBase64(bytes) }),
        });
        const data = (await res.json()) as { events?: ExtendedEventsBatch; error?: string };
        if (!res.ok || !data.events) {
          setParseError(data.error ?? "Unable to parse .xel Extended Events file.");
          return;
        }
        setPastedPayload({ kind: "events", events: data.events, label: fileName });
        setPasteOpen(false);
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Unable to reach DevTools /parse endpoint.");
    } finally {
      setIsParsing(false);
    }
  };

  const handleInspectorFile = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/\.xel$/i.test(file.name) || hasXelHeader(bytes)) {
      await handleParseXelFile(bytes, file.name);
      return;
    }
    const text = decodeUploadedText(bytes);
    setPastedExplain(text);
    await handleParseText(
      text,
      pasteEngine === "auto" ? undefined : pasteEngine,
      file.name,
    );
  };

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) {
      void handleInspectorFile(file);
    }
  };

  const handlePasteBoxDrop = (e: DragEvent<HTMLDivElement>) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    void handleInspectorFile(file);
  };

  const themeAttr = theme === "system" ? undefined : theme;

  return (
    <div
      className={`culprit-dt culprit-dt-pos-${position} ${className ?? ""}`.trim()}
      data-theme={themeAttr}
    >
      <button
        type="button"
        className={`culprit-dt-pill culprit-dt-tone-${statusTone}`}
        onClick={() => setOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-label="Toggle Culprit SQL DevTools"
      >
        <span className={`culprit-dt-dot culprit-dt-dot-${statusTone}`} aria-hidden="true" />
        <span className="culprit-dt-pill-label">{pillSummary}</span>
      </button>

      {isOpen && (
        <section
          className={`culprit-dt-drawer ${expanded ? "culprit-dt-drawer-expanded" : ""}`}
          aria-label="Culprit SQL DevTools"
        >
          <header className="culprit-dt-header">
            <div className="culprit-dt-brand">
              <span className="culprit-dt-brand-mark" aria-hidden="true">
                <Zap size={14} />
              </span>
              <strong className="culprit-dt-title">Culprit SQL</strong>
              <span className="culprit-dt-summary">
                {`${activeSnapshot.stats.totalQueries} queries · ${formatDuration(activeSnapshot.stats.totalDurationMs)}`}
              </span>
            </div>

            <nav className="culprit-dt-tabs" role="tablist" aria-label="DevTools views">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "queries"}
                className={`culprit-dt-tab ${activeTab === "queries" ? "is-active" : ""}`}
                onClick={() => setTab("queries")}
              >
                <Database size={13} />
                <span>Queries</span>
                <span className="culprit-dt-count">{activeSnapshot.stats.totalQueries}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "bursts"}
                className={`culprit-dt-tab ${activeTab === "bursts" ? "is-active" : ""}`}
                onClick={() => setTab("bursts")}
              >
                <Layers size={13} />
                <span>N+1 Bursts</span>
                <span
                  className={`culprit-dt-count ${activeSnapshot.stats.burstCount > 0 ? "is-coral" : ""}`}
                >
                  {activeSnapshot.stats.burstCount}
                </span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "plan"}
                className={`culprit-dt-tab ${activeTab === "plan" ? "is-active" : ""}`}
                onClick={() => setTab("plan")}
              >
                <FileSearch size={13} />
                <span>Plan Inspector</span>
                {queriesWithPlan.length > 0 && (
                  <span className="culprit-dt-count">{queriesWithPlan.length}</span>
                )}
              </button>
            </nav>

            <div className="culprit-dt-actions">
              {controlledSnapshot === undefined && pollIntervalMs > 0 && (
                <button
                  type="button"
                  className="culprit-dt-icon-btn"
                  onClick={() => setPaused((p) => !p)}
                  title={paused ? "Resume live polling" : "Pause live polling"}
                  aria-label={paused ? "Resume live polling" : "Pause live polling"}
                >
                  {paused ? <Play size={14} /> : <Pause size={14} />}
                </button>
              )}
              <button
                type="button"
                className="culprit-dt-icon-btn"
                onClick={() => void handleClear()}
                title="Clear recorded queries"
                aria-label="Clear recorded queries"
              >
                <Trash2 size={14} />
              </button>
              <button
                type="button"
                className="culprit-dt-icon-btn"
                onClick={() => setExpanded((e) => !e)}
                title={expanded ? "Restore drawer height" : "Expand drawer height"}
                aria-label={expanded ? "Restore drawer height" : "Expand drawer height"}
              >
                {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
              <button
                type="button"
                className="culprit-dt-icon-btn"
                onClick={() => setOpen(false)}
                title="Close DevTools"
                aria-label="Close DevTools"
              >
                <X size={14} />
              </button>
            </div>
          </header>

          {activeTab === "queries" && (
            <div className="culprit-dt-panel">
              <div className="culprit-dt-subbar">
                <div className="culprit-dt-filters" role="group" aria-label="Query filters">
                  {(
                    [
                      ["all", "All"],
                      ["slow", `Slow (>=${slowThresholdMs}ms)`],
                      ["nplus1", "N+1"],
                      ["with-plan", "With Plan"],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      className={`culprit-dt-chip ${filterMode === mode ? "is-active" : ""}`}
                      onClick={() => setFilterMode(mode)}
                    >
                      {label}
                    </button>
                  ))}
                  {burstFingerprintFilter && (
                    <button
                      type="button"
                      className="culprit-dt-chip is-active"
                      onClick={() => setBurstFingerprintFilter(null)}
                    >
                      Burst filter · Clear
                    </button>
                  )}
                </div>

                <label className="culprit-dt-search">
                  <Search size={13} aria-hidden="true" />
                  <input
                    type="search"
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                    placeholder="Filter SQL, route, or engine..."
                    aria-label="Filter recorded SQL queries"
                  />
                </label>
              </div>

              {filteredQueries.length === 0 ? (
                <div className="culprit-dt-empty">
                  <Database size={20} />
                  <p>No SQL queries match the current filter.</p>
                </div>
              ) : (
                <div className="culprit-dt-list">
                  {filteredQueries.map((q) => {
                    const isSlow = q.durationMs >= slowThresholdMs;
                    const isBurst = burstFingerprints.has(q.fingerprint);
                    const pct = Math.max(3, Math.min(100, Math.round((q.durationMs / maxQueryDuration) * 100)));
                    const barTone = q.error || isBurst ? "coral" : isSlow ? "amber" : "good";

                    return (
                      <article key={q.id} className="culprit-dt-query-row">
                        <div className="culprit-dt-query-meta">
                          <div className="culprit-dt-duration-cell">
                            <span className={`culprit-dt-duration is-${barTone}`}>
                              {formatDuration(q.durationMs)}
                            </span>
                            <div className="culprit-dt-bar-track" aria-hidden="true">
                              <div
                                className={`culprit-dt-bar-fill is-${barTone}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>

                          <div className="culprit-dt-badges">
                            {q.requestLabel && (
                              <span className="culprit-dt-badge is-route">{q.requestLabel}</span>
                            )}
                            {q.engine && <span className="culprit-dt-badge">{q.engine}</span>}
                            {isBurst && <span className="culprit-dt-badge is-coral">N+1</span>}
                            {isSlow && <span className="culprit-dt-badge is-amber">Slow</span>}
                            {typeof q.rowCount === "number" && (
                              <span className="culprit-dt-badge is-muted">{q.rowCount} rows</span>
                            )}
                            {typeof q.paramsCount === "number" && q.paramsCount > 0 && (
                              <span className="culprit-dt-badge is-muted">{q.paramsCount} params</span>
                            )}
                            {q.error && (
                              <span className="culprit-dt-badge is-coral">Error: {q.error}</span>
                            )}
                          </div>

                          <button
                            type="button"
                            className={`culprit-dt-inspect-btn ${q.plan ? "has-plan" : ""}`}
                            onClick={() => void handleInspectQuery(q)}
                          >
                            <FileSearch size={12} />
                            <span>{q.plan ? "Inspect Plan" : "EXPLAIN"}</span>
                          </button>
                        </div>

                        <div className="culprit-dt-sql-box">
                          <Sql text={q.sql} pretty={false} />
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === "bursts" && (
            <div className="culprit-dt-panel">
              {activeSnapshot.bursts.length === 0 ? (
                <div className="culprit-dt-empty">
                  <Sparkles size={20} />
                  <p>No N+1 query bursts detected across recent requests.</p>
                </div>
              ) : (
                <div className="culprit-dt-list">
                  {activeSnapshot.bursts.map((burst) => {
                    const sampleQuery = activeSnapshot.queries.find(
                      (q) => q.fingerprint === burst.fingerprint,
                    );
                    const advice = detectNPlusOneAdvice(burst.normalizedSql, sampleQuery?.engine);
                    return (
                      <article
                        key={`${burst.requestId ?? "win"}:${burst.fingerprint}`}
                        className="culprit-dt-burst-card"
                      >
                        <div className="culprit-dt-burst-head">
                          <div className="culprit-dt-badges">
                            <span className="culprit-dt-burst-mult">
                              <AlertTriangle size={12} />
                              <span>{`${burst.count}x`}</span>
                            </span>
                            <span className="culprit-dt-duration is-coral">
                              {`${formatDuration(burst.totalDurationMs)} total`}
                            </span>
                            <span className="culprit-dt-badge is-muted">
                              {`max ${formatDuration(burst.maxDurationMs)}`}
                            </span>
                            {burst.requestLabel && (
                              <span className="culprit-dt-badge is-route">{burst.requestLabel}</span>
                            )}
                          </div>

                          <button
                            type="button"
                            className="culprit-dt-inspect-btn"
                            onClick={() => {
                              setBurstFingerprintFilter(burst.fingerprint);
                              setFilterMode("all");
                              setTab("queries");
                            }}
                          >
                            <span>{`View ${burst.count} queries`}</span>
                          </button>
                        </div>

                        <div className="culprit-dt-sql-box">
                          <Sql text={burst.normalizedSql} pretty={false} />
                        </div>

                        <div className="culprit-dt-advice">
                          <strong>Batching fix:</strong> {advice}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === "plan" && (
            <div className="culprit-dt-panel culprit-dt-plan-panel">
              <div className="culprit-dt-subbar">
                <div className="culprit-dt-filters">
                  {queriesWithPlan.length > 0 && (
                    <select
                      className="culprit-dt-select"
                      aria-label="Select recorded query plan"
                      value={pastedPayload ? "__pasted__" : (selectedQuery?.id ?? "")}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === "__pasted__") return;
                        setPastedPayload(null);
                        setSelectedQueryId(val);
                      }}
                    >
                      {pastedPayload && (
                        <option value="__pasted__">
                          {pastedPayload.label ??
                            (pastedPayload.kind === "events"
                              ? "Loaded Extended Events"
                              : pastedPayload.kind === "deadlocks"
                                ? "Loaded Deadlock"
                                : "Pasted EXPLAIN plan")}
                        </option>
                      )}
                      {queriesWithPlan.map((q) => (
                        <option key={q.id} value={q.id}>
                          {formatDuration(q.durationMs)} ·{" "}
                          {q.sql.length > 68 ? `${q.sql.slice(0, 68)}...` : q.sql}
                        </option>
                      ))}
                    </select>
                  )}

                  {activePlan && (
                    <div className="culprit-dt-mode-toggle" role="group" aria-label="Plan view mode">
                      <button
                        type="button"
                        className={`culprit-dt-chip ${inspectorMode === "viewer" ? "is-active" : ""}`}
                        onClick={() => setInspectorMode("viewer")}
                      >
                        PlanViewer
                      </button>
                      <button
                        type="button"
                        className={`culprit-dt-chip ${inspectorMode === "canvas" ? "is-active" : ""}`}
                        onClick={() => setInspectorMode("canvas")}
                      >
                        PlanCanvas
                      </button>
                    </div>
                  )}
                </div>

                <div className="culprit-dt-filters">
                  <label className="culprit-dt-chip culprit-dt-file-chip">
                    <FolderOpen size={12} aria-hidden="true" />
                    <span>Load .xel / File</span>
                    <input
                      type="file"
                      accept=".xel,.sqlplan,.xdl,.xml,.json,.txt,.log"
                      hidden
                      onChange={handleFileInputChange}
                    />
                  </label>
                  <button
                    type="button"
                    className={`culprit-dt-chip ${pasteOpen || !activeInspectorPayload ? "is-active" : ""}`}
                    onClick={() => setPasteOpen((v) => !v)}
                  >
                    Paste EXPLAIN
                  </button>
                </div>
              </div>

              {(pasteOpen || !activeInspectorPayload) && (
                <div
                  className="culprit-dt-paste-box"
                  onDragOver={(e) => {
                    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
                  }}
                  onDrop={handlePasteBoxDrop}
                >
                  <textarea
                    className="culprit-dt-textarea"
                    rows={4}
                    value={pastedExplain}
                    onChange={(e) => setPastedExplain(e.target.value)}
                    placeholder="Paste EXPLAIN output, SQL Server .sqlplan / <deadlock> / Extended Events XML, or drop a binary .xel file..."
                    aria-label="Raw EXPLAIN input"
                  />
                  <div className="culprit-dt-paste-footer">
                    <select
                      className="culprit-dt-select"
                      aria-label="SQL engine format"
                      value={pasteEngine}
                      onChange={(e) => setPasteEngine(e.target.value as Engine | "auto")}
                    >
                      <option value="auto">Auto-detect engine</option>
                      <option value="postgres">PostgreSQL</option>
                      <option value="mysql">MySQL / MariaDB</option>
                      <option value="sqlite">SQLite</option>
                      <option value="mssql">SQL Server</option>
                      <option value="yugabyte">YugabyteDB</option>
                    </select>

                    {parseError && <span className="culprit-dt-error-msg">{parseError}</span>}

                    <button
                      type="button"
                      className="culprit-dt-primary-btn"
                      disabled={isParsing}
                      onClick={() =>
                        void handleParseText(
                          pastedExplain,
                          pasteEngine === "auto" ? undefined : pasteEngine,
                        )
                      }
                    >
                      {isParsing ? "Parsing..." : "Render Plan"}
                    </button>
                  </div>
                </div>
              )}

              {activeInspectorPayload ? (
                <div className="culprit-dt-viewer-stage">
                  {activeInspectorPayload.kind === "events" ? (
                    <ExtendedEventsViewer batch={activeInspectorPayload.events} theme={theme} />
                  ) : activeInspectorPayload.kind === "deadlocks" ? (
                    <div className="culprit-dt-deadlock-stage">
                      {activeInspectorPayload.deadlocks.length > 1 && (
                        <div className="culprit-dt-filters">
                          {activeInspectorPayload.deadlocks.map((_, idx) => (
                            <button
                              key={idx}
                              type="button"
                              className={`culprit-dt-chip ${deadlockIdx === idx ? "is-active" : ""}`}
                              onClick={() => setDeadlockIdx(idx)}
                            >
                              {`Cycle ${idx + 1}`}
                            </button>
                          ))}
                        </div>
                      )}
                      <DeadlockViewer
                        deadlock={
                          activeInspectorPayload.deadlocks[deadlockIdx] ??
                          activeInspectorPayload.deadlocks[0]!
                        }
                        theme={theme}
                      />
                    </div>
                  ) : inspectorMode === "viewer" ? (
                    <PlanViewer
                      plan={activeInspectorPayload.plan}
                      query={activeQueryStat}
                      theme={theme}
                      title={
                        pastedPayload
                          ? (pastedPayload.label ?? "Pasted Plan")
                          : selectedQuery?.requestLabel ?? "Recorded Query Plan"
                      }
                    />
                  ) : (
                    <PlanCanvas
                      plan={activeInspectorPayload.plan}
                      query={activeQueryStat}
                      showInsights
                      height={360}
                      theme={theme}
                    />
                  )}
                </div>
              ) : (
                <div className="culprit-dt-empty">
                  <FileSearch size={20} />
                  <p>
                    Enable <code>autoExplain: true</code> on slow queries or paste any{" "}
                    <code>EXPLAIN</code> output above to inspect its interactive plan diagram.
                  </p>
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
