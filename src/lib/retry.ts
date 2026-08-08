export async function retryOnceIf<T>(
  operation: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  delayMilliseconds = 0
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!shouldRetry(error)) {
      throw error;
    }
    if (delayMilliseconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
    }
    return operation();
  }
}
