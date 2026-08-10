export interface TokenCaptureTabsLike {
  get(tabId: number): Promise<Pick<chrome.tabs.Tab, "active">>;
}

export async function shouldAllowCapturedTokenIdentityChange(
  tabId: number,
  tabs: TokenCaptureTabsLike
): Promise<boolean> {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return false;
  }

  try {
    return (await tabs.get(tabId)).active === true;
  } catch {
    return false;
  }
}
