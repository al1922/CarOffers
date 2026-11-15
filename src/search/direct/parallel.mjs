export async function mapWithConcurrency(items, concurrency, worker, shouldStop = () => false) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(items.length, concurrency));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length && !shouldStop()) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}
