import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CulpritDevtools } from "../dist/react.js";

type ScenarioResult = {
  route: string;
  summary: string;
  rows: Record<string, unknown>[];
  elapsedMs: number;
};

const SCENARIOS = [
  {
    id: "n-plus-1",
    method: "GET",
    path: "/api/orders/n-plus-1",
    badge: "Coral N+1 Alert",
    tone: "#f0676b",
    title: "1. Trigger N+1 Order Loop",
    desc: "Fetches 8 recent orders, then fires 8 separate customer SELECT queries inside one HTTP request.",
  },
  {
    id: "batched",
    method: "GET",
    path: "/api/orders/batched",
    badge: "2 Queries (Fast)",
    tone: "#4cbb84",
    title: "2. Run Batched IN (...) Fix",
    desc: "Loads the same 8 orders and all matching customers in 2 total SQL queries.",
  },
  {
    id: "unindexed",
    method: "GET",
    path: "/api/analytics/unindexed",
    badge: "Slow + Auto-EXPLAIN",
    tone: "#ffcf33",
    title: "3. Slow Disk-Spill Query + Plan",
    desc: "Runs an unindexed revenue aggregation and attaches a real Wasm-parsed EXPLAIN plan.",
  },
  {
    id: "reylo",
    method: "POST",
    path: "/api/reylo/checkout",
    badge: "diagnostics_channel",
    tone: "#7aa6f8",
    title: "4. Emit reylo:query Telemetry",
    desc: "Publishes structured SQL events over node:diagnostics_channel with AsyncLocalStorage route tags.",
  },
];

function DemoApp() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ScenarioResult | null>(null);

  const triggerScenario = async (sc: (typeof SCENARIOS)[number]) => {
    setBusyId(sc.id);
    try {
      const started = performance.now();
      const res = await fetch(sc.path, { method: sc.method });
      const body = (await res.json()) as { summary: string; rows: Record<string, unknown>[] };
      setLastResult({
        route: `${sc.method} ${sc.path}`,
        summary: body.summary,
        rows: body.rows ?? [],
        elapsedMs: Math.round((performance.now() - started) * 10) / 10,
      });
    } finally {
      setBusyId(null);
    }
  };

  const isDark = theme === "dark";

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: "32px 24px 560px",
        background: isDark ? "#0f0e0c" : "#f7f6f2",
        color: isDark ? "#f2f0ea" : "#181715",
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif',
        transition: "background 140ms ease, color 140ms ease",
      }}
    >
      <div style={{ maxWidth: 1080, margin: "0 auto" }}>
        <header
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            marginBottom: 24,
          }}
        >
          <div>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 10px",
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 600,
                background: isDark ? "rgba(255, 207, 51, 0.14)" : "rgba(43, 84, 216, 0.1)",
                color: isDark ? "#ffcf33" : "#2b54d8",
                marginBottom: 8,
              }}
            >
              @culpritsql/devtools · Live Full-Stack Playground
            </div>
            <h1 style={{ margin: 0, fontSize: 28, letterSpacing: "-0.025em" }}>
              Backend SQL HUD, N+1 Detector &amp; Live Plan Inspector
            </h1>
            <p style={{ margin: "6px 0 0", color: isDark ? "#a5a39c" : "#5c5a55", fontSize: 14.5 }}>
              Click any API scenario below and watch the docked Culprit SQL DevTools drawer update in real time.
            </p>
          </div>

          <button
            type="button"
            onClick={() => setTheme(isDark ? "light" : "dark")}
            style={{
              height: 36,
              padding: "0 14px",
              borderRadius: 8,
              border: `1px solid ${isDark ? "#2f2d28" : "#d8d5cc"}`,
              background: isDark ? "#191815" : "#ffffff",
              color: "inherit",
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Theme: {isDark ? "Dark" : "Light"}
          </button>
        </header>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 12,
            marginBottom: 20,
          }}
        >
          {SCENARIOS.map((sc) => (
            <button
              key={sc.id}
              type="button"
              data-scenario={sc.id}
              disabled={busyId !== null}
              onClick={() => void triggerScenario(sc)}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 10,
                padding: 16,
                borderRadius: 12,
                border: `1px solid ${isDark ? "#2a2823" : "#e2dfd7"}`,
                background: isDark ? "#181714" : "#ffffff",
                color: "inherit",
                textAlign: "left",
                cursor: busyId ? "progress" : "pointer",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                <code
                  style={{
                    fontSize: 11,
                    padding: "2px 6px",
                    borderRadius: 5,
                    background: isDark ? "#22201c" : "#f1efe9",
                    color: isDark ? "#c5c2b9" : "#4a4741",
                  }}
                >
                  {sc.method} {sc.path}
                </code>
                <span style={{ fontSize: 11, fontWeight: 700, color: sc.tone }}>{sc.badge}</span>
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14.5, marginBottom: 4 }}>{sc.title}</div>
                <div style={{ fontSize: 12.5, lineHeight: 1.45, color: isDark ? "#a5a39c" : "#5c5a55" }}>
                  {sc.desc}
                </div>
              </div>
            </button>
          ))}
        </section>

        {lastResult && (
          <div
            style={{
              padding: "12px 16px",
              borderRadius: 10,
              border: `1px solid ${isDark ? "#2a2823" : "#e2dfd7"}`,
              background: isDark ? "#151411" : "#ffffff",
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div>
              <strong>{lastResult.route}</strong>: {lastResult.summary}
            </div>
            <span style={{ fontFamily: "ui-monospace, monospace", color: isDark ? "#ffcf33" : "#2b54d8" }}>
              {lastResult.elapsedMs} ms round-trip · {lastResult.rows.length} row(s)
            </span>
          </div>
        )}
      </div>

      <CulpritDevtools endpoint="/__culprit" pollIntervalMs={600} defaultOpen theme={theme} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<DemoApp />);
