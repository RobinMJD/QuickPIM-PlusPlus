import { withTimeout } from "./async";

interface RuntimeMessageResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export const DEFAULT_RUNTIME_MESSAGE_TIMEOUT_MS = 30_000;

export async function sendRuntimeMessage<T>(
  message: Record<string, unknown>,
  options: { timeoutMs?: number; timeoutMessage?: string } = {}
): Promise<T> {
  const action = typeof message.action === "string" ? message.action : "background request";
  const response = await withTimeout(
    chrome.runtime.sendMessage(message) as Promise<RuntimeMessageResponse<T>>,
    options.timeoutMs ?? DEFAULT_RUNTIME_MESSAGE_TIMEOUT_MS,
    options.timeoutMessage || `QuickPIM++ ${action} timed out. Cached data is still available; retry the refresh.`
  );
  if (!response?.success) {
    throw new Error(response?.error || "QuickPIM++ background request failed.");
  }
  return response.data as T;
}
