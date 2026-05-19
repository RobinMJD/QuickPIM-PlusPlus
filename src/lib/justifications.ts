export const GENERIC_JUSTIFICATION_WARNING =
  "Justifications are requested for audit and approval. Use a specific task, change, incident, or access reason. Generic answers such as BAU, Admin, or needed are blocked.";
export const ACTIVATION_JUSTIFICATION_SUFFIX = " {Activated using QuickPIM++}";

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

function normalizeJustification(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[\s.,;:!?'"`]+|[\s.,;:!?'"`]+$/g, "")
    .replace(/\s+/g, " ");
}
