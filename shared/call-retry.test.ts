import { describe, expect, test, vi } from "vitest";
import { retryCallOperation } from "./call-retry";

describe("retryCallOperation", () => {
  test("retries temporary signaling failures", async () => {
    vi.useFakeTimers();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Network request failed"))
      .mockResolvedValue("sent");

    const result = retryCallOperation(operation);
    await vi.advanceTimersByTimeAsync(300);
    await expect(result).resolves.toBe("sent");
    expect(operation).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  test("does not retry stale negotiation work", async () => {
    const operation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("Network negotiation is out of date"));

    await expect(retryCallOperation(operation)).rejects.toThrow(
      "Network negotiation is out of date",
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
