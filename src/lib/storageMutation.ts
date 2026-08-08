export function createStorageMutationLock(lockName: string) {
  let fallbackQueue: Promise<void> = Promise.resolve();

  return async function withStorageMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    if (typeof navigator !== "undefined" && navigator.locks?.request) {
      return navigator.locks.request(lockName, operation);
    }

    let result: T;
    const mutation = fallbackQueue.then(async () => {
      result = await operation();
    });
    fallbackQueue = mutation.catch(() => undefined);
    await mutation;
    return result!;
  };
}
