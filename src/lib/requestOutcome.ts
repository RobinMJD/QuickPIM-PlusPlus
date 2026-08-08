const UNKNOWN_WRITE_OUTCOME_SUFFIX =
  "The result may be unknown. QuickPIM++ will refresh Microsoft PIM state before you retry.";

export function isAmbiguousMicrosoftWriteFailure(
  message: string,
  accessRecoveryRequired = false
): boolean {
  return !accessRecoveryRequired && isTransientMicrosoftFailure(message);
}

export function isTransientMicrosoftFailure(message: string): boolean {
  return /timed out|network|failed to fetch|load failed|aborted|gateway|service unavailable|internal server|temporar|too many requests|throttl|\b429\b|\b5\d\d\b/i.test(message);
}

export function formatUnknownWriteOutcome(error: string): string {
  const detail = error.trim();
  return detail ? `${detail} ${UNKNOWN_WRITE_OUTCOME_SUFFIX}` : UNKNOWN_WRITE_OUTCOME_SUFFIX;
}
