export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!items.length) {
    return [];
  }

  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function mapWithConcurrencySettled<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<Array<PromiseSettledResult<R>>> {
  return mapWithConcurrency(items, limit, async (item, index) => {
    try {
      return { status: "fulfilled", value: await mapper(item, index) } as const;
    } catch (reason) {
      return { status: "rejected", reason } as const;
    }
  });
}
