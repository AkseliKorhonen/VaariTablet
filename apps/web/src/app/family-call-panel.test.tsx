import type { Id } from "../../../../convex/_generated/dataModel";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("convex/react", () => ({
  useAction: () => vi.fn(),
  useMutation: () => vi.fn(),
  useQuery: (...args: unknown[]) => queryMock(...args),
}));

describe("FamilyCallPanel", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  test("keeps incoming call controls together in the foreground call surface", async () => {
    const currentUserId = "user_current" as Id<"users">;
    const remoteUserId = "user_remote" as Id<"users">;
    queryMock.mockReturnValue({
      call: {
        _id: "call_1" as Id<"calls">,
        calleeId: currentUserId,
        callerId: remoteUserId,
        offerSdp: "offer",
        status: "ringing",
      },
      candidates: [],
    });
    const { FamilyCallPanel } = await import("./family-call-panel");

    const html = renderToString(
      <FamilyCallPanel
        currentUserId={currentUserId}
        familyId={"family_1" as Id<"families">}
        members={[
          {
            email: "caller@example.com",
            image: null,
            joinedAt: 0,
            name: "Caller",
            role: "member",
            userId: remoteUserId,
          },
        ]}
      />,
    );

    expect(html).toContain("foreground-call-surface");
    expect(html).toContain("Answer");
    expect(html).toContain("Decline");
    expect(html).not.toContain("<video");
  });

  test("displays recent missed calls with the caller and time", async () => {
    const currentUserId = "user_current" as Id<"users">;
    const remoteUserId = "user_remote" as Id<"users">;
    queryMock
      .mockReturnValueOnce({ call: null, candidates: [] })
      .mockReturnValueOnce([
        {
          _id: "missed_1" as Id<"missedCalls">,
          caller: { email: "caller@example.com", name: "Caller" },
          callerId: remoteUserId,
          missedAt: Date.UTC(2026, 7, 2, 12, 5),
        },
      ]);
    const { FamilyCallPanel } = await import("./family-call-panel");

    const html = renderToString(
      <FamilyCallPanel
        currentUserId={currentUserId}
        familyId={"family_1" as Id<"families">}
        members={[
          {
            email: "caller@example.com",
            image: null,
            joinedAt: 0,
            name: "Caller",
            role: "member",
            userId: remoteUserId,
          },
        ]}
      />,
    );

    expect(html).toContain("Missed calls");
    expect(html).toContain("Missed call from Caller");
    expect(html).toContain("2026-08-02T12:05:00.000Z");
  });
});
