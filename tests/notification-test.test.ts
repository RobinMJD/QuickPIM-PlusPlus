import { describe, expect, test } from "vitest";
import {
  NOTIFICATION_TEST_BUTTON_TITLES,
  getNotificationTestButtonResult
} from "../src/lib/notificationTest";

describe("notification action test", () => {
  test("exposes exactly two harmless test actions", () => {
    expect(NOTIFICATION_TEST_BUTTON_TITLES).toEqual(["Test button 1", "Test button 2"]);
    expect(getNotificationTestButtonResult(0)).toEqual({
      title: "Test button 1 works",
      message: "Notification action buttons are supported by this browser. No PIM request was changed."
    });
    expect(getNotificationTestButtonResult(1)?.title).toBe("Test button 2 works");
  });

  test("ignores unknown button indexes", () => {
    expect(getNotificationTestButtonResult(-1)).toBeUndefined();
    expect(getNotificationTestButtonResult(2)).toBeUndefined();
  });
});
