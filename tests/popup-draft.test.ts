import { describe, expect, test } from "vitest";
import { hasPopupDraftContent, sanitizePopupDraft } from "../src/lib/popupDraft";

const now = Date.parse("2026-06-12T12:00:00.000Z");

describe("popup draft storage", () => {
  test("sanitizes persisted popup request state", () => {
    const draft = sanitizePopupDraft(
      {
        updatedAt: now,
        tab: "pimGroup",
        search: " groups ",
        sortMode: "activationCount",
        selectedIds: ["pimGroup:group-1:member", "pimGroup:group-1:member", 42],
        durationHours: 3.7,
        justification: " Need access ",
        ticketSystem: " ServiceNow ",
        ticketNumber: " INC-123 ",
        isActivationReviewOpen: true,
        requestMode: "deactivate"
      },
      now
    );

    expect(draft).toMatchObject({
      tab: "pimGroup",
      search: "groups",
      sortMode: "activationCount",
      selectedIds: ["pimGroup:group-1:member"],
      durationHours: 3.5,
      justification: "Need access",
      ticketSystem: "ServiceNow",
      ticketNumber: "INC-123",
      isActivationReviewOpen: true,
      requestMode: "deactivate"
    });
  });

  test("drops expired or empty drafts", () => {
    expect(sanitizePopupDraft({ updatedAt: now - 25 * 60 * 60 * 1000, selectedIds: ["role-1"] }, now)).toBeUndefined();
    expect(sanitizePopupDraft({ updatedAt: now, selectedIds: [], isActivationReviewOpen: true }, now)).toBeUndefined();
    expect(
      hasPopupDraftContent({
        tab: "directoryRole",
        search: "",
        sortMode: "name",
        selectedIds: ["role-1"],
        durationHours: 0.5,
        justification: "",
        ticketSystem: "",
        ticketNumber: "",
        isActivationReviewOpen: false,
        requestMode: "activate"
      })
    ).toBe(true);
  });

  test("drops invalid popup request modes", () => {
    expect(
      sanitizePopupDraft(
        {
          updatedAt: now,
          selectedIds: ["role-1"],
          requestMode: "delete"
        },
        now
      )?.requestMode
    ).toBeUndefined();
  });
});
