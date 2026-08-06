import { APP_NAME, APP_VERSION } from "../src/lib/appMetadata";

export const TEST_APP_VERSION = APP_VERSION;
export const TEST_RELEASE_TAG = `v${APP_VERSION}`;
export const TEST_MANIFEST = Object.freeze({ name: APP_NAME, version: APP_VERSION });

export function testReleaseUrl(): string {
  return `https://github.com/RobinMJD/QuickPIM-PlusPlus/releases/tag/${TEST_RELEASE_TAG}`;
}
