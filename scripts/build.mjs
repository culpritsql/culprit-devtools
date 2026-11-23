import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const require = createRequire(import.meta.url);
const tscBin = require.resolve("typescript/bin/tsc");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const res = spawnSync(process.execPath, [tscBin, "-p", path.join(root, "tsconfig.json")], {
  cwd: root,
  stdio: "inherit",
});
if (res.status !== 0) {
  process.exit(res.status ?? 1);
}

const viewerCssPath = fileURLToPath(import.meta.resolve("@culpritsql/plan-viewer/styles.css"));
const [viewerCss, devtoolsCss] = await Promise.all([
  readFile(viewerCssPath, "utf8"),
  readFile(path.join(root, "src", "styles.css"), "utf8"),
]);
const mergedCss = devtoolsCss.replace('@import "@culpritsql/plan-viewer/styles.css";', viewerCss.trim());
await writeFile(path.join(distDir, "styles.css"), mergedCss, "utf8");
