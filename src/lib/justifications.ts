export const GENERIC_JUSTIFICATION_WARNING =
  "Justifications are requested for audit and approval. Use a specific task, change, incident, or access reason. Generic answers such as BAU, Admin, or needed are blocked.";
export const ACTIVATION_JUSTIFICATION_SUFFIX = " {Activated using QuickPIM++}";
export const MAX_MICROSOFT_JUSTIFICATION_LENGTH = 1024;
export const MAX_USER_JUSTIFICATION_LENGTH =
  MAX_MICROSOFT_JUSTIFICATION_LENGTH - ACTIVATION_JUSTIFICATION_SUFFIX.length;

const GENERIC_JUSTIFICATIONS = new Set([
  "access",
  "admin",
  "administrator",
  "bau",
  "business as usual",
  "default",
  "na",
  "n/a",
  "need",
  "needed",
  "none",
  "required",
  "routine",
  "standard",
  "test",
  "testing"
]);

export function isGenericJustification(value: string): boolean {
  return GENERIC_JUSTIFICATIONS.has(normalizeJustification(value));
}

export function getGenericJustificationWarning(value: string): string | undefined {
  return value.trim() && isGenericJustification(value) ? GENERIC_JUSTIFICATION_WARNING : undefined;
}

export function formatJustificationForActivationRequest(value: string): string {
  const trimmed = value.trimEnd();
  if (trimmed.endsWith(ACTIVATION_JUSTIFICATION_SUFFIX.trim())) {
    return trimmed;
  }
  return trimmed ? `${trimmed}${ACTIVATION_JUSTIFICATION_SUFFIX}` : ACTIVATION_JUSTIFICATION_SUFFIX.trim();
}

export function sanitizeUserJustification(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const marker = ACTIVATION_JUSTIFICATION_SUFFIX.trim();
  const trimmed = value.trim();
  const withoutAuditMarker = trimmed.endsWith(marker)
    ? trimmed.slice(0, -marker.length).trimEnd()
    : trimmed;
  return withoutAuditMarker.slice(0, MAX_USER_JUSTIFICATION_LENGTH);
}

function normalizeJustification(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[\s.,;:!?'"`]+|[\s.,;:!?'"`]+$/g, "")
    .replace(/\s+/g, " ");
}
