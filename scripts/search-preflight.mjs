#!/usr/bin/env node
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let runId = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--run" && args[i + 1] && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(args[i + 1])) runId = args[++i];
  else throw new Error("Usage: npm run search:preflight -- [--run <run-id>]");
}

const sourceConfig = JSON.parse(await readFile(path.join(ROOT, "config/sources.json"), "utf8"));
let selected = sourceConfig.sources.filter((source) => source.enabled && source.category !== "auction" &&
  source.purchaseConditions?.auction !== true);
if (runId) {
  const run = path.join(ROOT, "runs", runId);
  const queue = JSON.parse(await readFile(path.join(run, "tasks.json"), "utf8"));
  const sourceIds = new Set(queue.tasks.filter((task) => task.kind === "search").map((task) => task.sourceId));
  selected = sourceConfig.sources.filter((source) => sourceIds.has(source.id));
}

const byHost = new Map();
for (const source of selected) {
  let host;
  try { host = new URL(source.searchUrl).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { continue; }
  const sources = byHost.get(host) ?? [];
  sources.push(source.id);
  byHost.set(host, sources);
}

async function resolveHost(host) {
  let timer;
  try {
    return await Promise.race([
      lookup(host, { all: true }).then((items) => items.map((item) => item.address)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("DNS lookup timed out")), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
}

const results = await Promise.all([...byHost].map(async ([host, sources]) => {
  try {
    const addresses = await resolveHost(host);
    return { host, sources, status: "resolved", addresses };
  } catch (error) {
    return { host, sources, status: "dns_error", error: String(error?.code ?? error?.message ?? error) };
  }
}));

const failures = results.filter((item) => item.status === "dns_error");
const environmentLikely = failures.length >= 3 && failures.length / Math.max(1, results.length) >= 0.5;
const report = {
  checkedAt: new Date().toISOString(),
  mode: "dns_only_no_portal_requests",
  runId,
  hostsChecked: results.length,
  dnsFailures: failures.length,
  status: environmentLikely ? "environment_dns_failure" : failures.length ? "some_hosts_failed" : "ready_for_portal_checks",
  guidance: environmentLikely
    ? "Several independent source hosts failed DNS. Treat this as a runtime network problem and retry the same permitted checker in an approved network-enabled runtime; do not classify it as portal availability."
    : failures.length
      ? "DNS failed for a subset of hosts. Review those sources individually; this probe does not establish HTTP access or listing availability."
      : "DNS resolved for selected hosts. This probe does not establish HTTP access, robots.txt permission, or listing availability.",
  results,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (environmentLikely) process.exitCode = 2;
