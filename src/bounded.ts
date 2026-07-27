/** Divide a fixed global result budget deterministically across ordered work. */
export function distributeBudget(total: number, itemCount: number): number[] {
  if (itemCount < 1 || total < 1) return Array.from({ length: itemCount }, () => 0);
  const base = Math.floor(total / itemCount);
  const remainder = total % itemCount;
  return Array.from(
    { length: itemCount },
    (_, index) => base + (index < remainder ? 1 : 0),
  );
}

/** Preserve input order while bounding the number of asynchronous operations. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(items[index], index);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      () => worker(),
    ),
  );
  return results;
}
