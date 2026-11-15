import { performance } from "node:perf_hooks";

export class StageTimings {
  constructor() {
    this.records = [];
  }

  async measure(stage, metadata, action) {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    try {
      const value = await action();
      this.records.push({ stage, startedAt, elapsedMs: Math.round(performance.now() - start), status: "ok", ...metadata });
      return value;
    } catch (error) {
      this.records.push({ stage, startedAt, elapsedMs: Math.round(performance.now() - start), status: "error",
        error: String(error?.message ?? error).split("\n")[0].slice(0, 300), ...metadata });
      throw error;
    }
  }

  record(stage, elapsedMs, status, metadata = {}) {
    this.records.push({ stage, startedAt: new Date().toISOString(), elapsedMs: Math.max(0, Math.round(elapsedMs)), status, ...metadata });
  }

  report() {
    const groups = new Map();
    for (const row of this.records) {
      const group = groups.get(row.stage) ?? { stage: row.stage, count: 0, totalMs: 0, minMs: Infinity, maxMs: 0, errors: 0, timeouts: 0 };
      group.count += 1;
      group.totalMs += row.elapsedMs;
      group.minMs = Math.min(group.minMs, row.elapsedMs);
      group.maxMs = Math.max(group.maxMs, row.elapsedMs);
      if (row.status === "error") group.errors += 1;
      if (row.status === "timeout") group.timeouts += 1;
      groups.set(row.stage, group);
    }
    return {
      generatedAt: new Date().toISOString(),
      stageTotals: [...groups.values()].map((group) => ({ ...group,
        averageMs: Math.round(group.totalMs / group.count), minMs: Number.isFinite(group.minMs) ? group.minMs : 0 }))
        .sort((left, right) => right.totalMs - left.totalMs),
      measurements: this.records,
    };
  }
}
