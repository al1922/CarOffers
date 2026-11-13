#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, link, unlink, readdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = { claimStdin: false, bundle: null, maxPages: 2, maxCards: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--claim-stdin") options.claimStdin = true;
    else if (arg === "--bundle") options.bundle = argv[++i];
    else if (arg === "--max-pages") options.maxPages = Number(argv[++i]);
    else if (arg === "--max-cards") options.maxCards = Number(argv[++i]);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.claimStdin === Boolean(options.bundle)) {
    throw new Error("Usage: npm run search:network-worker -- (--claim-stdin | --bundle <worker-bundle-dir>) [--max-pages N] [--max-cards N]");
  }
  if (options.bundle !== null && !options.bundle) throw new Error("--bundle requires a directory path");
  if (!Number.isInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 20) {
    throw new Error("--max-pages must be an integer from 1 to 20");
  }
  if (!Number.isInteger(options.maxCards) || options.maxCards < 1 || options.maxCards > 200) {
    throw new Error("--max-cards must be an integer from 1 to 200");
  }
  return options;
}

async function readStdinJson() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text);
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function currentProjectFiles() {
  const files = [];
  for (const [folder, suffixes] of [["scripts", new Set([".mjs", ".py"])], ["config", new Set([".json"])], ["knowledge/models", new Set([".json"])]] ) {
    for (const name of await readdir(path.join(ROOT, folder))) {
      if (suffixes.has(path.extname(name))) files.push(`${folder}/${name}`);
    }
  }
  for (const name of ["package.json", "package-lock.json"]) {
    try { await readFile(path.join(ROOT, name)); files.push(name); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const entries = await Promise.all(files.sort().map(async (name) => [name, sha256(await readFile(path.join(ROOT, name)))]));
  return Object.fromEntries(entries);
}

async function readWorkerBundle(bundlePath) {
  const absolute = path.resolve(ROOT, bundlePath);
  const relative = path.relative(ROOT, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Worker bundle must be inside this CarOffers checkout");
  }
  const manifest = JSON.parse(await readFile(path.join(absolute, "manifest.json"), "utf8"));
  const claimBytes = await readFile(path.join(absolute, "claim.json"));
  const claimHash = sha256(claimBytes);
  const inputFiles = manifest.inputFiles;
  if (manifest.formatVersion !== 1 || !inputFiles || typeof inputFiles !== "object" ||
      Array.isArray(inputFiles) || inputFiles["claim.json"] !== claimHash) {
    throw new Error("Worker bundle manifest or claim checksum is invalid");
  }
  const allowedFiles = new Set(["claim.json", "continuation-source-result.json"]);
  for (const [name, expectedHash] of Object.entries(inputFiles)) {
    if (!allowedFiles.has(name)) throw new Error(`Unexpected worker bundle input: ${name}`);
    if (name === "claim.json") continue;
    const bytes = await readFile(path.join(absolute, name));
    if (sha256(bytes) !== expectedHash) throw new Error(`Worker bundle input checksum failed: ${name}`);
  }
  if (!isDeepStrictEqual(manifest.projectFiles, await currentProjectFiles())) {
    throw new Error("Worker bundle needs the matching CarOffers code/config checkout and dependencies");
  }
  const claim = JSON.parse(claimBytes.toString("utf8"));
  const taskFields = ["id", "kind", "state", "worker", "sourceId", "modelKey", "searchProfile", "continuation"];
  if (!manifest.task || taskFields.some((field) => !isDeepStrictEqual(manifest.task[field], claim[field] ?? null)) ||
      manifest.runId !== claim.runId || manifest.taskId !== claim.id || manifest.worker !== claim.worker ||
      manifest.sourceId !== claim.sourceId || (manifest.modelKey ?? null) !== (claim.modelKey ?? null)) {
    throw new Error("Worker bundle identity does not match its claim");
  }
  const hasContinuationResult = Object.prototype.hasOwnProperty.call(inputFiles, "continuation-source-result.json");
  if (Boolean(claim.continuation) !== hasContinuationResult) {
    throw new Error("Worker bundle is missing or has an unexpected continuation source result");
  }
  if (hasContinuationResult) {
    claim.workerContinuationSourceResult = JSON.parse(
      (await readFile(path.join(absolute, "continuation-source-result.json"))).toString("utf8"));
  }
  return { absolute, manifest, claim };
}

async function writeBundleResult(bundlePath, resultText) {
  const resultPath = path.join(bundlePath, "result.json");
  const receiptPath = path.join(bundlePath, "result.sha256");
  const resultTemp = path.join(bundlePath, `.result.${randomUUID()}.tmp`);
  const receiptTemp = path.join(bundlePath, `.receipt.${randomUUID()}.tmp`);
  let resultTempCreated = false;
  let receiptTempCreated = false;
  let resultLinked = false;
  let receiptLinked = false;
  try {
    const resultHandle = await open(resultTemp, "wx");
    resultTempCreated = true;
    try { await resultHandle.writeFile(resultText, "utf8"); await resultHandle.sync(); }
    finally { await resultHandle.close(); }
    const receiptHandle = await open(receiptTemp, "wx");
    receiptTempCreated = true;
    try { await receiptHandle.writeFile(`${sha256(Buffer.from(resultText, "utf8"))}\n`, "ascii"); await receiptHandle.sync(); }
    finally { await receiptHandle.close(); }
    await link(resultTemp, resultPath);
    resultLinked = true;
    await link(receiptTemp, receiptPath);
    receiptLinked = true;
  } finally {
    if (resultTempCreated) await unlink(resultTemp).catch(() => {});
    if (receiptTempCreated) await unlink(receiptTemp).catch(() => {});
    if (resultLinked && !receiptLinked) await unlink(resultPath).catch(() => {});
    if (receiptLinked && !resultLinked) await unlink(receiptPath).catch(() => {});
  }
}

function runReader(claim, options) {
  return new Promise((resolve, reject) => {
    const args = [path.join(ROOT, "scripts/portal-search.mjs"), "--claim-stdin", "--verify-cards",
      "--max-pages", String(options.maxPages), "--max-cards", String(options.maxCards)];
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["pipe", "pipe", "inherit"] });
    const chunks = [];
    let length = 0;
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > 80 * 1024 * 1024) {
        child.kill();
        reject(new Error("Reader output exceeded the 80 MiB safety limit"));
        return;
      }
      chunks.push(chunk);
    });
    child.once("close", (code, signal) => {
      if (signal || code !== 0) {
        reject(new Error(`Portal reader stopped (exit ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""})`));
        return;
      }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (error) { reject(new Error(`Portal reader did not return one JSON result: ${error.message}`)); }
    });
    child.stdin.end(JSON.stringify(claim));
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let bundleDir = null;
  let claim;
  if (options.bundle) {
    const bundle = await readWorkerBundle(options.bundle);
    bundleDir = bundle.absolute;
    claim = bundle.claim;
  } else {
    claim = await readStdinJson();
  }
  if (!claim || claim.kind !== "search" || claim.state !== "running" || !claim.worker || !claim.sourceId ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(claim.runId ?? "") || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(claim.id ?? "")) {
    throw new Error("Input must be a claimed running search task or a valid exported worker bundle");
  }
  if (!bundleDir) {
    const runDir = path.resolve(ROOT, "runs", claim.runId);
    const queuePath = path.join(runDir, "tasks.json");
    const queue = JSON.parse(await readFile(queuePath, "utf8"));
    const queuedTask = queue.tasks.find((task) => task.id === claim.id);
    if (!queuedTask || queuedTask.state !== "running" || queuedTask.worker !== claim.worker ||
        queuedTask.kind !== "search" || queuedTask.sourceId !== claim.sourceId ||
        queuedTask.modelKey !== claim.modelKey ||
        !isDeepStrictEqual(queuedTask.searchProfile, claim.searchProfile) ||
        !isDeepStrictEqual(queuedTask.continuation ?? null, claim.continuation ?? null)) {
      throw new Error("Claim does not match the running task, frozen search profile, or continuation in tasks.json");
    }
  }
  const resultsDir = bundleDir ?? path.resolve(ROOT, "runs", claim.runId, "results");
  const resultPath = bundleDir ? path.join(resultsDir, "result.json") : path.resolve(resultsDir, `${claim.id}.json`);
  if (!bundleDir && path.dirname(resultPath) !== resultsDir) throw new Error("Result path escaped the run results directory");
  const receiptPath = bundleDir ? path.join(resultsDir, "result.sha256") : null;
  const lockPath = path.join(resultsDir, bundleDir ? ".network-worker.lock" : `.${claim.id}.network-worker.lock`);
  const lock = await open(lockPath, "wx");
  const tempPath = path.join(resultsDir, `.${claim.id}.${randomUUID()}.tmp`);
  let tempCreated = false;
  try {
    try {
      await readFile(resultPath);
      throw new Error(`Result already exists; preserving it: ${resultPath}`);
    }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (receiptPath) {
      try { await readFile(receiptPath); throw new Error(`Result receipt already exists; preserving it: ${receiptPath}`); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }

    const result = await runReader(claim, options);
    if (!result || result.taskId !== claim.id || !["complete", "partial", "blocked", "no_matches"].includes(result.outcome)) {
      throw new Error("Portal reader returned a result with a mismatched taskId or invalid outcome");
    }
    const resultText = `${JSON.stringify(result, null, 2)}\n`;
    if (bundleDir) {
      await writeBundleResult(bundleDir, resultText);
      process.stdout.write(`Saved ${result.outcome} result in worker bundle ${path.relative(ROOT, bundleDir).replaceAll(path.sep, "/")}\n`);
    } else {
      const handle = await open(tempPath, "wx");
      tempCreated = true;
      try { await handle.writeFile(resultText, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await link(tempPath, resultPath);
      await unlink(tempPath);
      tempCreated = false;
      process.stdout.write(`Saved ${result.outcome} result for ${claim.id} to ${path.relative(ROOT, resultPath).replaceAll(path.sep, "/")}\n`);
    }
  } finally {
    if (tempCreated) await unlink(tempPath).catch(() => {});
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
