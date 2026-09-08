import { CLAIMS_CHALLENGE_MESSAGE } from "./apiErrors";
import { MicrosoftApiError } from "./microsoftApiError";
import type { ActivationItem } from "./types";

export async function runWithActivationPreflight<T>(
  item: ActivationItem,
  validate: (() => Promise<unknown>) | undefined,
  activate: () => Promise<T>
): Promise<T> {
  if (validate) {
    try {
      await validate();
    } catch (error) {
      // An assignment at one scope must not satisfy another scope's activation.
      // Only an explicit duplicate from the optional validation-only POST may
      // fall through to the unchanged real POST, which enforces all PIM rules.
      if (!isDirectoryRolePreflightConflict(item, error)) throw error;
    }
  }

  // Keep the actual write outside the preflight catch: never retry a rejected
  // or ambiguous write, or turn it into a successful activation.
  return activate();
}

function isDirectoryRolePreflightConflict(item: ActivationItem, error: unknown): boolean {
  if (item.type !== "directoryRole") return false;
  if (!(error instanceof MicrosoftApiError) || ![400, 409].includes(error.status)) return false;
  if (error.message === CLAIMS_CHALLENGE_MESSAGE) return false;

  const code = error.code?.toLowerCase();
  if (code === "roleassignmentexists" || code === "roleassignmentalreadyexists") return true;
  // Some Graph responses wrap the precise legacy message in a generic code.
  // Do not accept arbitrary conflict messages or other service error codes.
  return (!code || ["badrequest", "request_badrequest", "conflict"].includes(code))
    && /^(?:the )?role assignment already exists\.?$/iu.test(error.message);
}
