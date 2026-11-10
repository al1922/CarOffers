#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browsersPath = path.join(ROOT, "node_modules", ".cache", "ms-playwright");
process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
const cli = path.join(ROOT, "node_modules", "playwright", "cli.js");
const result = spawnSync(process.execPath, [cli, "install", "chromium"], {
  cwd: ROOT,
  env: process.env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
