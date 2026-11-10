import { assertAllowedApiUrl } from "./security";

// Keep the deadline alive until the response body has been consumed. Fetch
// resolves at headers; clearing its timer there leaves JSON/error reads stuck.
export async function fetchMicrosoftApi<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  readResponse: (response: Response) => Promise<T>,
  parentSignal?: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<T> {
  assertAllowedApiUrl(url);
  const canceledMessage = "Microsoft API request was canceled because the refresh deadline expired.";
  if (parentSignal?.aborted) throw new Error(canceledMessage);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancelFromParent: () => void = () => undefined;
  const deadline = new Promise<never>((_, reject) => {
    const cancel = (message: string) => {
      reject(new Error(message));
      controller.abort();
    };
    cancelFromParent = () => cancel(canceledMessage);
    parentSignal?.addEventListener("abort", cancelFromParent, { once: true });
    timeout = setTimeout(() => cancel(`Microsoft API request timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`), timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => readResponse(await fetchImpl(url, {
        ...init,
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal
      })))(),
      deadline
    ]);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", cancelFromParent);
  }
}
