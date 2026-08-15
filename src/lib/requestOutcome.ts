const UNKNOWN_WRITE_OUTCOME_SUFFIX =
  "The result may be unknown. QuickPIM++ will refresh Microsoft PIM state before you retry.";

export function isAmbiguousMicrosoftWriteFailure(
  message: string,
  accessRecoveryRequired = false
): boolean {
  return !accessRecoveryRequired && isTransientMicrosoftFailure(message);
}

export function isTransientMicrosoftFailure(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (/timed out|network(?: error| failure)|failed to fetch|load failed|request (?:was )?aborted|bad gateway|gateway timeout|service unavailable|internal server error|temporar(?:y|ily)|too many requests|throttl/u.test(normalized)) {
    return true;
  }
  return /(?:^|\b)(?:http(?: status)?|status(?: code)?|response)\s*[:=]?\s*(?:408|425|429|5\d\d)(?:\b|$)/u.test(normalized);
}

export function formatUnknownWriteOutcome(error: string): string {
  const detail = error.trim();
  return detail ? `${detail} ${UNKNOWN_WRITE_OUTCOME_SUFFIX}` : UNKNOWN_WRITE_OUTCOME_SUFFIX;
}
