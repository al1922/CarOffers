#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const help = args.includes("--help") || args.includes("-h");

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function run(script, childArgs, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", script), ...childArgs], {
      cwd: ROOT, stdio: ["pipe", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) process.exitCode = 1;
      else process.exitCode = code ?? 1;
      resolve();
    });
    child.stdin.end(input);
  });
}

async function main() {
  if (help) return run("portal-candidates.mjs", args, "");
  if (!args.includes("--claim-stdin")) throw new Error("Provide --claim-stdin with one claimed task JSON");
  const input = await readStdin();
  const task = JSON.parse(input);
  if (task.kind !== "search" || task.state !== "running" || !task.worker || !task.sourceId) {
    throw new Error("Input must be one running search task printed by a successful claim");
  }
  const config = JSON.parse(await readFile(path.join(ROOT, "config/portal-adapters.json"), "utf8"));
  const adapter = config.adapters?.[task.sourceId];
  if (!adapter) throw new Error(`Missing portal adapter for ${task.sourceId}`);
  if (adapter.mode !== "dedicated") return run("portal-candidates.mjs", args, input);

  const dedicated = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--verify-cards") dedicated.push("--verify");
    else if (["--max-pages", "--max-cards"].includes(args[index])) {
      dedicated.push(args[index], args[++index]);
    } else if (args[index] === "--card-reader") {
      dedicated.push(args[index], args[++index]);
    } else if (!["--claim-stdin"].includes(args[index])) {
      throw new Error(`Option ${args[index]} is not supported by the dedicated ${task.sourceId} adapter`);
    }
  }
  return run("sprzedajemy-search.mjs", ["--claim-stdin", ...dedicated], input);
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 2;
});
