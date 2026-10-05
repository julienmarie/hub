import type { ProviderEventReceiptRecord } from "./types.js";

// Only an immutable version mismatch fences all replays. A shared route or a
// transient configuration failure must remain retryable for its other routes.
export function isFencedManualAdmission(
  receipt: Pick<
    ProviderEventReceiptRecord,
    "provider" | "source" | "payload" | "acceptedRoutes" | "droppedReason"
  >,
): boolean {
  const payload = receipt.payload;
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    !("expectedVersionId" in payload)
  )
    return false;
  const expected = payload.expectedVersionId;
  return (
    receipt.provider === "manual" &&
    receipt.source === "manual.run" &&
    receipt.droppedReason === "configuration_unavailable" &&
    typeof expected === "string" &&
    receipt.acceptedRoutes?.length === 1 &&
    receipt.acceptedRoutes[0]?.configurationRevisionId !== expected
  );
}
