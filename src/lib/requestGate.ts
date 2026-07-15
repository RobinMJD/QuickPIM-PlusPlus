import { getActivationItemIdentity } from "./activationIdentity";
import type { ActivationItem } from "./types";

const inFlightActivationItems = new Set<string>();

export async function runWithActivationItemLock<T>(
  item: ActivationItem,
  operation: () => Promise<T>
): Promise<T> {
  const identity = getActivationItemIdentity(item);
  if (inFlightActivationItems.has(identity)) {
    throw new Error(`A QuickPIM++ request for ${item.displayName || item.sourceName || "this item"} is already in progress.`);
  }

  inFlightActivationItems.add(identity);
  try {
    return await operation();
  } finally {
    inFlightActivationItems.delete(identity);
  }
}
