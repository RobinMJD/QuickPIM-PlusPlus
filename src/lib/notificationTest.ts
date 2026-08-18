export const NOTIFICATION_TEST_ID = "quickpim-notification-test";
export const NOTIFICATION_TEST_RESULT_ID = "quickpim-notification-test-result";
export const NOTIFICATION_TEST_BUTTON_TITLES = ["Test button 1", "Test button 2"] as const;

export function getNotificationTestButtonResult(buttonIndex: number): { title: string; message: string } | undefined {
  if (buttonIndex < 0 || buttonIndex >= NOTIFICATION_TEST_BUTTON_TITLES.length) return undefined;
  return {
    title: `${NOTIFICATION_TEST_BUTTON_TITLES[buttonIndex]} works`,
    message: "Notification action buttons are supported by this browser. No PIM request was changed."
  };
}
