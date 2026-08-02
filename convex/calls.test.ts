/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.js");

async function createUser(t: ReturnType<typeof convexTest>, email: string) {
  const userId = await t.run(async (ctx) => {
    return await ctx.db.insert("users", { email });
  });

  return {
    userId,
    authed: t.withIdentity({
      email,
      subject: userId,
      tokenIdentifier: `test|${userId}`,
    }),
  };
}

describe("calls", () => {
  test("starts, answers, and delivers ICE candidates for a family call", async () => {
    const t = convexTest({ schema, modules });
    const { authed: owner, userId: ownerId } = await createUser(
      t,
      "owner@example.com",
    );
    const { authed: member, userId: memberId } = await createUser(
      t,
      "member@example.com",
    );

    await owner.mutation(api.families.create, { name: "Korhonen" });
    const [family] = await owner.query(api.families.listMy, {});
    await member.mutation(api.families.join, {
      inviteCode: family.inviteCode,
    });

    const callId = await owner.mutation(api.calls.start, {
      familyId: family._id,
      calleeId: memberId,
      offerSdp: '{"type":"offer","sdp":"offer-sdp"}',
    });

    const incoming = await member.query(api.calls.watch, {
      familyId: family._id,
    });
    expect(incoming.call).toMatchObject({
      _id: callId,
      status: "ringing",
      callerId: ownerId,
      calleeId: memberId,
      offerSdp: '{"type":"offer","sdp":"offer-sdp"}',
    });

    const notificationPayload = await t.query(
      internal.callNotificationData.getIncomingCallPayload,
      { callId },
    );
    expect(notificationPayload).toMatchObject({
      callId,
      familyId: family._id,
    });

    await owner.mutation(api.calls.addIceCandidate, {
      callId,
      recipientId: memberId,
      candidate: "candidate-1",
      sdpMid: "0",
      sdpMLineIndex: 0,
    });

    const withCandidate = await member.query(api.calls.watch, {
      familyId: family._id,
    });
    expect(withCandidate.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidate: "candidate-1",
          recipientId: memberId,
          senderId: ownerId,
        }),
      ]),
    );

    await member.mutation(api.calls.answer, {
      callId,
      answerSdp: '{"type":"answer","sdp":"answer-sdp"}',
    });

    const active = await owner.query(api.calls.watch, {
      familyId: family._id,
    });
    expect(active.call).toMatchObject({
      _id: callId,
      status: "active",
      answerSdp: '{"type":"answer","sdp":"answer-sdp"}',
    });
    await owner.mutation(api.calls.end, { callId });
  });

  test("offers auto-answer after ten seconds and requires the caller to request it", async () => {
    const t = convexTest({ schema, modules });
    const { authed: caller, userId: callerId } = await createUser(
      t,
      "auto-caller@example.com",
    );
    const { authed: callee, userId: calleeId } = await createUser(
      t,
      "auto-callee@example.com",
    );

    await caller.mutation(api.families.create, { name: "Auto answer" });
    const [family] = await caller.query(api.families.listMy, {});
    await callee.mutation(api.families.join, {
      inviteCode: family.inviteCode,
    });
    const callId = await caller.mutation(api.calls.start, {
      calleeId,
      deviceId: "caller-phone",
      familyId: family._id,
      offerSdp: "offer",
    });

    await expect(callee.mutation(api.calls.offerAutoAnswer, {
      callId,
      deviceId: "callee-tablet",
    })).rejects.toThrow("Auto-answer is not available yet");
    await expect(caller.mutation(api.calls.offerAutoAnswer, {
      callId,
      deviceId: "caller-phone",
    })).rejects.toThrow("Only the callee can offer auto-answer");

    await t.run(async (ctx) => {
      await ctx.db.patch(callId, { createdAt: Date.now() - 10_001 });
    });
    expect(await callee.mutation(api.calls.offerAutoAnswer, {
      callId,
      deviceId: "callee-tablet",
    })).toBe(true);
    expect(await callee.mutation(api.calls.offerAutoAnswer, {
      callId,
      deviceId: "callee-phone",
    })).toBe(false);

    await expect(callee.mutation(api.calls.requestAutoAnswer, {
      callId,
      deviceId: "callee-tablet",
    })).rejects.toThrow("Only the caller can request auto-answer");
    await expect(caller.mutation(api.calls.requestAutoAnswer, {
      callId,
      deviceId: "",
    })).rejects.toThrow("A device ID is required to request auto-answer");
    await expect(caller.mutation(api.calls.requestAutoAnswer, {
      callId,
      deviceId: "caller-laptop",
    })).rejects.toThrow("This device does not own the call");
    await caller.mutation(api.calls.requestAutoAnswer, {
      callId,
      deviceId: "caller-phone",
    });

    const requested = await callee.query(api.calls.watch, {
      deviceId: "callee-tablet",
      familyId: family._id,
    });
    expect(requested.call).toMatchObject({
      autoAnswerOfferedByDeviceId: "callee-tablet",
      autoAnswerRequestedAt: expect.any(Number),
      calleeId,
      callerId,
      status: "ringing",
    });

    expect(await callee.mutation(api.calls.revokeAutoAnswerOffer, {
      callId,
      deviceId: "callee-phone",
    })).toBe(false);
    expect(await callee.mutation(api.calls.revokeAutoAnswerOffer, {
      callId,
      deviceId: "callee-tablet",
    })).toBe(true);
    const revoked = await caller.query(api.calls.watch, {
      deviceId: "caller-phone",
      familyId: family._id,
    });
    expect(revoked.call).not.toHaveProperty("autoAnswerOfferedByDeviceId");
    expect(revoked.call).not.toHaveProperty("autoAnswerRequestedAt");
  });

  test("expires abandoned calls and deletes their signaling candidates", async () => {
    const t = convexTest({ schema, modules });
    const { authed: owner, userId: ownerId } = await createUser(
      t,
      "owner@example.com",
    );
    const { authed: member, userId: memberId } = await createUser(
      t,
      "member@example.com",
    );

    await owner.mutation(api.families.create, { name: "Korhonen" });
    const [family] = await owner.query(api.families.listMy, {});
    await member.mutation(api.families.join, {
      inviteCode: family.inviteCode,
    });

    const callId = await t.run(async (ctx) => {
      return await ctx.db.insert("calls", {
        familyId: family._id,
        callerId: ownerId,
        calleeId: memberId,
        status: "ringing",
        offerSdp: "offer-sdp",
        createdAt: 0,
      });
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("callIceCandidates", {
        callId,
        recipientId: memberId,
        senderId: ownerId,
        candidate: "candidate-1",
        createdAt: 0,
      });
    });

    await t.mutation(internal.calls.expireStale, {});

    const call = await t.run(async (ctx) => await ctx.db.get(callId));
    expect(call).toMatchObject({ status: "ended" });
    const candidates = await t.run(async (ctx) =>
      ctx.db
        .query("callIceCandidates")
        .withIndex("by_callId", (q) => q.eq("callId", callId))
        .take(10),
    );
    expect(candidates).toEqual([]);
    const missedCalls = await member.query(api.calls.listMissed, {
      familyId: family._id,
    });
    expect(missedCalls).toEqual([
      expect.objectContaining({ callId, callerId: ownerId }),
    ]);
  });

  test("records canceled outgoing calls but not declined or answered calls as missed", async () => {
    const t = convexTest({ schema, modules });
    const { authed: caller, userId: callerId } = await createUser(
      t,
      "missed-caller@example.com",
    );
    const { authed: callee, userId: calleeId } = await createUser(
      t,
      "missed-callee@example.com",
    );
    await caller.mutation(api.families.create, { name: "Missed calls" });
    const [family] = await caller.query(api.families.listMy, {});
    await callee.mutation(api.families.join, { inviteCode: family.inviteCode });

    const canceledCallId = await caller.mutation(api.calls.start, {
      calleeId,
      deviceId: "caller-phone",
      familyId: family._id,
      offerSdp: "canceled-offer",
    });
    await caller.mutation(api.calls.end, {
      callId: canceledCallId,
      deviceId: "caller-phone",
    });

    const declinedCallId = await caller.mutation(api.calls.start, {
      calleeId,
      deviceId: "caller-phone",
      familyId: family._id,
      offerSdp: "declined-offer",
    });
    await callee.mutation(api.calls.decline, {
      callId: declinedCallId,
      deviceId: "callee-tablet",
    });

    const answeredCallId = await caller.mutation(api.calls.start, {
      calleeId,
      deviceId: "caller-phone",
      familyId: family._id,
      offerSdp: "answered-offer",
    });
    await callee.mutation(api.calls.answer, {
      answerSdp: "answer",
      callId: answeredCallId,
      deviceId: "callee-tablet",
    });
    await caller.mutation(api.calls.end, {
      callId: answeredCallId,
      deviceId: "caller-phone",
    });

    const missedCalls = await callee.query(api.calls.listMissed, {
      familyId: family._id,
    });
    expect(missedCalls).toEqual([
      expect.objectContaining({
        callId: canceledCallId,
        callerId,
      }),
    ]);
  });

  test("prevents a user from joining calls in two families at once", async () => {
    const t = convexTest({ schema, modules });
    const { authed: owner } = await createUser(t, "owner@example.com");
    const { authed: member, userId: memberId } = await createUser(
      t,
      "member@example.com",
    );

    await owner.mutation(api.families.create, { name: "First family" });
    await owner.mutation(api.families.create, { name: "Second family" });
    const families = await owner.query(api.families.listMy, {});
    for (const family of families) {
      await member.mutation(api.families.join, { inviteCode: family.inviteCode });
    }

    await owner.mutation(api.calls.start, {
      familyId: families[0]._id,
      calleeId: memberId,
      offerSdp: "first-offer",
    });

    await expect(owner.mutation(api.calls.start, {
      familyId: families[1]._id,
      calleeId: memberId,
      offerSdp: "second-offer",
    })).rejects.toThrow("A call is already in progress");
  });

  test("assigns an active call to the first answering device and scopes signaling", async () => {
    const t = convexTest({ schema, modules });
    const { authed: caller, userId: callerId } = await createUser(
      t,
      "caller@example.com",
    );
    const { authed: callee, userId: calleeId } = await createUser(
      t,
      "callee@example.com",
    );

    await caller.mutation(api.families.create, { name: "Two devices" });
    const [family] = await caller.query(api.families.listMy, {});
    await callee.mutation(api.families.join, {
      inviteCode: family.inviteCode,
    });
    await callee.mutation(api.pushTokens.register, {
      deviceId: "callee-phone",
      platform: "android",
      token: "phone-token",
    });
    await callee.mutation(api.pushTokens.register, {
      deviceId: "callee-tablet",
      platform: "android",
      token: "tablet-token",
    });

    const callId = await caller.mutation(api.calls.start, {
      calleeId,
      deviceId: "caller-phone",
      familyId: family._id,
      offerSdp: "offer",
    });
    const incomingPayload = await t.query(
      internal.callNotificationData.getIncomingCallPayload,
      { callId },
    );
    expect(incomingPayload?.tokens).toEqual(
      expect.arrayContaining(["phone-token", "tablet-token"]),
    );
    await expect(
      caller.mutation(api.calls.end, {
        callId,
        deviceId: "caller-tablet",
      }),
    ).rejects.toThrow("This device does not own the call");
    await expect(
      caller.mutation(api.calls.end, { callId }),
    ).rejects.toThrow("This device does not own the call");
    await expect(
      caller.mutation(api.calls.decline, { callId }),
    ).rejects.toThrow("This device does not own the call");
    await expect(
      caller.mutation(api.calls.addIceCandidate, {
        callId,
        candidate: "unowned-caller-candidate",
        recipientId: calleeId,
      }),
    ).rejects.toThrow("This device does not own the call");
    await expect(
      callee.mutation(api.calls.answer, {
        answerSdp: "legacy-answer",
        callId,
      }),
    ).rejects.toThrow("A device ID is required to answer this call");
    await expect(
      callee.mutation(api.calls.answer, {
        answerSdp: "empty-device-answer",
        callId,
        deviceId: "",
      }),
    ).rejects.toThrow("A device ID is required to answer this call");

    await caller.mutation(api.calls.addIceCandidate, {
      callId,
      candidate: "caller-candidate",
      deviceId: "caller-phone",
      recipientId: calleeId,
    });
    await callee.mutation(api.calls.addIceCandidate, {
      callId,
      candidate: "phone-candidate",
      deviceId: "callee-phone",
      recipientId: callerId,
    });
    await callee.mutation(api.calls.addIceCandidate, {
      callId,
      candidate: "tablet-candidate",
      deviceId: "callee-tablet",
      recipientId: callerId,
    });

    const ringingCaller = await caller.query(api.calls.watch, {
      deviceId: "caller-phone",
      familyId: family._id,
    });
    expect(ringingCaller.candidates).toEqual([]);
    const ringingCallee = await callee.query(api.calls.watch, {
      deviceId: "callee-phone",
      familyId: family._id,
    });
    expect(ringingCallee.candidates).toEqual([
      expect.objectContaining({
        candidate: "caller-candidate",
        senderDeviceId: "caller-phone",
      }),
    ]);

    await callee.mutation(api.calls.answer, {
      answerSdp: "phone-answer",
      callId,
      deviceId: "callee-phone",
    });
    await expect(
      callee.mutation(api.calls.answer, {
        answerSdp: "tablet-answer",
        callId,
        deviceId: "callee-tablet",
      }),
    ).rejects.toThrow("Call is no longer ringing");

    const activeCaller = await caller.query(api.calls.watch, {
      deviceId: "caller-phone",
      familyId: family._id,
    });
    expect(activeCaller.call).toMatchObject({
      answeredByDeviceId: "callee-phone",
      callerDeviceId: "caller-phone",
      status: "active",
    });
    expect(activeCaller.candidates).toEqual([
      expect.objectContaining({
        candidate: "phone-candidate",
        senderDeviceId: "callee-phone",
      }),
    ]);
    expect(activeCaller.candidates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ candidate: "tablet-candidate" }),
      ]),
    );

    const losingDevice = await callee.query(api.calls.watch, {
      deviceId: "callee-tablet",
      familyId: family._id,
    });
    expect(losingDevice.candidates).toEqual([]);
    const unidentifiedCallee = await callee.query(api.calls.watch, {
      familyId: family._id,
    });
    expect(unidentifiedCallee.candidates).toEqual([]);
    await expect(
      callee.mutation(api.calls.addIceCandidate, {
        callId,
        candidate: "late-tablet-candidate",
        deviceId: "callee-tablet",
        recipientId: callerId,
      }),
    ).rejects.toThrow("This device does not own the call");
    await expect(
      callee.mutation(api.calls.addIceCandidate, {
        callId,
        candidate: "unidentified-callee-candidate",
        recipientId: callerId,
      }),
    ).rejects.toThrow("This device does not own the call");
    await expect(
      callee.mutation(api.calls.end, {
        callId,
        deviceId: "callee-tablet",
      }),
    ).rejects.toThrow("This device does not own the call");
    await expect(
      callee.mutation(api.calls.end, { callId }),
    ).rejects.toThrow("This device does not own the call");
    await expect(
      caller.mutation(api.calls.end, { callId }),
    ).rejects.toThrow("This device does not own the call");

    const answeredPayload = await t.query(
      internal.callNotificationData.getResolvedCallPayload,
      { callId, resolution: "answered" },
    );
    expect(answeredPayload).toMatchObject({
      answeredByDeviceId: "callee-phone",
      resolution: "answered",
      tokens: ["tablet-token"],
    });

    await callee.mutation(api.calls.end, {
      callId,
      deviceId: "callee-phone",
    });
    const endedPayload = await t.query(
      internal.callNotificationData.getResolvedCallPayload,
      { callId, resolution: "ended" },
    );
    expect(endedPayload?.tokens).toEqual(
      expect.arrayContaining(["phone-token", "tablet-token"]),
    );
  });

  test("coordinates ICE restarts and rejects stale candidates", async () => {
    const t = convexTest({ schema, modules });
    const { authed: caller, userId: callerId } = await createUser(
      t,
      "restart-caller@example.com",
    );
    const { authed: callee, userId: calleeId } = await createUser(
      t,
      "restart-callee@example.com",
    );

    await caller.mutation(api.families.create, { name: "Resilient calls" });
    const [family] = await caller.query(api.families.listMy, {});
    await callee.mutation(api.families.join, { inviteCode: family.inviteCode });
    const callId = await caller.mutation(api.calls.start, {
      calleeId,
      deviceId: "caller-phone",
      familyId: family._id,
      offerSdp: "initial-offer",
    });
    await callee.mutation(api.calls.answer, {
      answerSdp: "initial-answer",
      callId,
      deviceId: "callee-tablet",
    });

    const revision = await callee.mutation(api.calls.requestIceRestart, {
      callId,
      deviceId: "callee-tablet",
    });
    expect(revision).toBe(1);
    expect(await caller.mutation(api.calls.requestIceRestart, {
      callId,
      deviceId: "caller-phone",
    })).toBe(1);

    await expect(caller.mutation(api.calls.addIceCandidate, {
      callId,
      candidate: "stale-candidate",
      deviceId: "caller-phone",
      negotiationRevision: 0,
      recipientId: calleeId,
    })).rejects.toThrow("Network negotiation is out of date");

    await caller.mutation(api.calls.submitIceRestartOffer, {
      callId,
      deviceId: "caller-phone",
      offerSdp: "restart-offer",
      revision,
    });
    await expect(caller.mutation(api.calls.submitIceRestartAnswer, {
      answerSdp: "invalid-answer",
      callId,
      deviceId: "caller-phone",
      revision,
    })).rejects.toThrow("Only the callee can answer a connection restart");
    await callee.mutation(api.calls.submitIceRestartAnswer, {
      answerSdp: "restart-answer",
      callId,
      deviceId: "callee-tablet",
      revision,
    });
    await callee.mutation(api.calls.addIceCandidate, {
      callId,
      candidate: "fresh-candidate",
      deviceId: "callee-tablet",
      negotiationRevision: revision,
      recipientId: callerId,
    });

    const restarted = await caller.query(api.calls.watch, {
      deviceId: "caller-phone",
      familyId: family._id,
    });
    expect(restarted.call).toMatchObject({
      iceRestartAnswerSdp: "restart-answer",
      iceRestartOfferSdp: "restart-offer",
      iceRestartRevision: revision,
    });
    expect(restarted.candidates).toEqual([
      expect.objectContaining({
        candidate: "fresh-candidate",
        negotiationRevision: revision,
      }),
    ]);
  });

  test("rotates and unregisters push tokens per authenticated device", async () => {
    const t = convexTest({ schema, modules });
    const { authed: user, userId } = await createUser(
      t,
      "devices@example.com",
    );

    await user.mutation(api.pushTokens.register, {
      deviceId: "phone",
      platform: "android",
      token: "old-phone-token",
    });
    await user.mutation(api.pushTokens.register, {
      deviceId: "tablet",
      platform: "android",
      token: "tablet-token",
    });
    await user.mutation(api.pushTokens.register, {
      deviceId: "phone",
      platform: "android",
      token: "new-phone-token",
    });

    const registrations = await t.run(async (ctx) => {
      const phone = await ctx.db
        .query("pushTokens")
        .withIndex("by_userId_and_deviceId", (q) =>
          q.eq("userId", userId).eq("deviceId", "phone"),
        )
        .take(10);
      const tablet = await ctx.db
        .query("pushTokens")
        .withIndex("by_userId_and_deviceId", (q) =>
          q.eq("userId", userId).eq("deviceId", "tablet"),
        )
        .take(10);
      return { phone, tablet };
    });
    expect(registrations.phone).toEqual([
      expect.objectContaining({ token: "new-phone-token" }),
    ]);
    expect(registrations.tablet).toEqual([
      expect.objectContaining({ token: "tablet-token" }),
    ]);

    expect(
      await user.mutation(api.pushTokens.unregisterDevice, {
        deviceId: "phone",
      }),
    ).toBe(1);
    const remaining = await t.run(async (ctx) =>
      ctx.db
        .query("pushTokens")
        .withIndex("by_userId_and_platform", (q) =>
          q.eq("userId", userId).eq("platform", "android"),
        )
        .take(10),
    );
    expect(remaining).toEqual([
      expect.objectContaining({
        deviceId: "tablet",
        token: "tablet-token",
      }),
    ]);
  });

  test("targets every callee device when a ringing call is declined", async () => {
    const t = convexTest({ schema, modules });
    const { authed: caller } = await createUser(t, "decline-caller@example.com");
    const { authed: callee, userId: calleeId } = await createUser(
      t,
      "decline-callee@example.com",
    );

    await caller.mutation(api.families.create, { name: "Decline" });
    const [family] = await caller.query(api.families.listMy, {});
    await callee.mutation(api.families.join, {
      inviteCode: family.inviteCode,
    });
    for (const [deviceId, token] of [
      ["phone", "decline-phone-token"],
      ["tablet", "decline-tablet-token"],
    ] as const) {
      await callee.mutation(api.pushTokens.register, {
        deviceId,
        platform: "android",
        token,
      });
    }

    const callId = await caller.mutation(api.calls.start, {
      calleeId,
      deviceId: "caller-device",
      familyId: family._id,
      offerSdp: "offer",
    });
    await callee.mutation(api.calls.decline, {
      callId,
      deviceId: "phone",
    });

    const payload = await t.query(
      internal.callNotificationData.getResolvedCallPayload,
      { callId, resolution: "declined" },
    );
    expect(payload?.tokens).toEqual(
      expect.arrayContaining([
        "decline-phone-token",
        "decline-tablet-token",
      ]),
    );
  });
});
