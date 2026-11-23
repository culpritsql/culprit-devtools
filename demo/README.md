# `@culpritsql/devtools` Live Full-Stack Playground

This `demo/` directory is a zero-Docker, single-command playground showcasing `@culpritsql/devtools` in a live Node.js / Bun + React 19 app backed by an instrumented SQLite database, `AsyncLocalStorage` HTTP route correlation, `reylo:query` `diagnostics_channel` events, and real `@culpritsql/plans` WebAssembly execution plans.

## Run in 1 Command

From the repository root:

```sh
bun run demo
# or: npm run demo
```

Then open **http://127.0.0.1:4321** in your browser.

## Interactive Scenarios Included

1. **Trigger N+1 Burst (`GET /api/orders/n-plus-1`)**: Executes 1 parent `orders` query followed by 8 per-row `customers` lookups inside one HTTP request. Watch the floating HUD pill jump to coral **`⚡ SQL · ... · 1 N+1`** and open the **N+1 Bursts** tab for batching fix advice.
2. **Run Batched Fix (`GET /api/orders/batched`)**: Runs the 2-query `WHERE id IN (?, ...)` fix so you can compare request timings and query counts in the **Queries** tab.
3. **Slow Scan + Auto-EXPLAIN (`GET /api/analytics/unindexed`)**: Runs a slow aggregation and attaches a parsed execution plan via `@culpritsql/plans` WebAssembly. Click **Inspect Plan** in the drawer to explore the interactive `<PlanViewer />` and `<PlanCanvas />` flow diagrams.
4. **Emit `reylo:query` Diagnostics Channel (`POST /api/reylo/checkout`)**: Publishes structured SQL events on Node's `node:diagnostics_channel` (`reylo:query`) inside an `AsyncLocalStorage` request scope with zero driver wrapper code.
