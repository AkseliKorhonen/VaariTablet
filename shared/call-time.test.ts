import { describe, expect, test } from "vitest";
import { formatCallTime } from "./call-time";

describe("formatCallTime", () => {
  const timestamp = Date.UTC(2026, 7, 2, 12, 5);

  test("uses the selected English locale", () => {
    expect(formatCallTime(timestamp, "en")).toMatch(/Aug|2|12|05/i);
  });

  test("uses the selected Finnish locale", () => {
    expect(formatCallTime(timestamp, "fi")).toMatch(/elo|2|12|05/i);
  });
});
