export const CLAIMS_CHALLENGE_MESSAGE =
  "Microsoft requires an additional sign-in or MFA challenge before this activation can continue. Open the matching Microsoft portal page, complete the prompt, then retry.";

export function isClaimsChallengeMessage(message: string): boolean {
  const decoded = safeDecodeURIComponent(message);
  return [message, decoded].some((candidate) => {
    if (!candidate) {
      return false;
    }
    return (
      /(?:^|[?&\s])claims=|claims%3d|claims="/i.test(candidate) ||
      (/"access_token"\s*:/.test(candidate) && /"essential"\s*:\s*true/i.test(candidate)) ||
      (/\bacrs\b/i.test(candidate) && /\bessential\b/i.test(candidate))
    );
  });
}

export function redactClaimsChallengePayloads(message: string): string {
  return message
    .replace(/([?&])claims=[^&\s"']+/gi, "$1claims=[redacted]")
    .replace(/claims="[^"]+"/gi, 'claims="[redacted]"')
    .replace(/claims='[^']+'/gi, "claims='[redacted]'");
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}
