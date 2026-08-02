const RETRY_DELAYS_MS = [0, 300, 900, 1_800] as const;

function isPermanentCallError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /no longer (active|ringing)|does not own the call|negotiation is out of date|not authenticated/i.test(
    error.message,
  );
}

export function isStaleNegotiationError(error: unknown) {
  return error instanceof Error && /negotiation is out of date/i.test(error.message);
}

export async function retryCallOperation<T>(operation: () => Promise<T>) {
  let lastError: unknown;

  for (const delay of RETRY_DELAYS_MS) {
    if (delay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (isPermanentCallError(error)) throw error;
    }
  }

  throw lastError;
}
