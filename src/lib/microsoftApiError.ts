import { CLAIMS_CHALLENGE_MESSAGE, isClaimsChallengeMessage } from "./apiErrors";
import { sanitizeErrorMessage } from "./security";

export class MicrosoftApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(sanitizeErrorMessage(message));
    this.name = "MicrosoftApiError";
  }
}

export async function readMicrosoftApiError(response: Response): Promise<MicrosoftApiError> {
  const fallback = `Microsoft API returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`;
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  let payload: unknown;
  let text = "";
  try {
    text = (await response.text()).slice(0, 8_192);
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }

  const error = getErrorRecord(payload);
  const code = typeof error?.code === "string" && /^[A-Za-z0-9_.-]{1,120}$/u.test(error.code)
    ? error.code
    : undefined;
  const authenticateHeader = response.headers.get("www-authenticate") || "";
  const apiMessage = typeof error?.message === "string" ? error.message : undefined;
  let message: string;
  if (isClaimsChallengeMessage(authenticateHeader) || (apiMessage && isClaimsChallengeMessage(apiMessage))) {
    message = CLAIMS_CHALLENGE_MESSAGE;
  } else if (apiMessage) {
    message = apiMessage;
  } else if (contentType.includes("text/html") || /<\s*!doctype|<\s*html/i.test(text)) {
    message = `${fallback} The Microsoft gateway returned an HTML error page; retry after the portal session is ready.`;
  } else {
    message = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || fallback;
  }
  return new MicrosoftApiError(message, response.status, code);
}

function getErrorRecord(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const error = (payload as Record<string, unknown>).error;
  return error && typeof error === "object" && !Array.isArray(error)
    ? error as Record<string, unknown>
    : undefined;
}
