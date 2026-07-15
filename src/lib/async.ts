export class OperationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationTimeoutError";
  }
}

export function withTimeout<T>(operation: PromiseLike<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve(operation);
  }

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new OperationTimeoutError(message)), timeoutMs);
    Promise.resolve(operation).then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

export function isOperationTimeoutError(error: unknown): error is OperationTimeoutError {
  return error instanceof OperationTimeoutError || (
    error instanceof Error && error.name === "OperationTimeoutError"
  );
}
