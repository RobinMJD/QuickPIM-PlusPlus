import { describe, expect, test } from "vitest";
import {
  formatUnknownWriteOutcome,
  isAmbiguousMicrosoftWriteFailure,
  isTransientMicrosoftFailure
} from "../src/lib/requestOutcome";

describe("Microsoft write outcome classification", () => {
  test("classifies transport and server failures as ambiguous", () => {
    expect(isAmbiguousMicrosoftWriteFailure("Microsoft API request timed out after 45 seconds.")).toBe(true);
    expect(isAmbiguousMicrosoftWriteFailure("Failed to fetch")).toBe(true);
    expect(isAmbiguousMicrosoftWriteFailure("503 Service Unavailable")).toBe(true);
  });

  test("does not classify deterministic or access-recovery failures as ambiguous", () => {
    expect(isAmbiguousMicrosoftWriteFailure("400 Bad Request")).toBe(false);
    expect(isAmbiguousMicrosoftWriteFailure("Failed to fetch", true)).toBe(false);
  });

  test("classifies throttling and server failures as transient reads", () => {
    expect(isTransientMicrosoftFailure("429 Too Many Requests")).toBe(true);
    expect(isTransientMicrosoftFailure("503 Service Unavailable")).toBe(true);
    expect(isTransientMicrosoftFailure("403 Forbidden")).toBe(false);
  });

  test("adds a no-duplicate recovery instruction", () => {
    expect(formatUnknownWriteOutcome("Network error.")).toContain(
      "QuickPIM++ will refresh Microsoft PIM state before you retry."
    );
  });
});
