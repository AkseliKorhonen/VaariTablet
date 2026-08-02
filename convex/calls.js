import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";

const RINGING_TIMEOUT_MS = 2 * 60 * 1000;
const ACTIVE_CALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const AUTO_ANSWER_DELAY_MS = 10 * 1000;
const ICE_RESTART_COOLDOWN_MS = 3 * 1000;
const EXPIRY_BATCH_SIZE = 100;

function createNativeCallId() {
  return crypto.randomUUID();
}

async function requireUserId(ctx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new Error("Not authenticated");
  }
  return userId;
}

async function requireFamilyMembership(ctx, familyId, userId) {
  const membership = await ctx.db
    .query("familyMembers")
    .withIndex("by_familyId_and_userId", (q) =>
      q.eq("familyId", familyId).eq("userId", userId),
    )
    .unique();

  if (membership === null) {
    throw new Error("Family not found");
  }

  return membership;
}

async function getCallForUser(ctx, callId, userId) {
  const call = await ctx.db.get(callId);
  if (call === null) {
    throw new Error("Call not found");
  }
  if (call.callerId !== userId && call.calleeId !== userId) {
    throw new Error("Call not found");
  }
  await requireFamilyMembership(ctx, call.familyId, userId);
  return call;
}

async function getCallSummaries(ctx, calls) {
  return await Promise.all(
    calls.map(async (call) => {
      const caller = await ctx.db.get(call.callerId);
      const callee = await ctx.db.get(call.calleeId);
      return {
        ...call,
        caller: {
          _id: call.callerId,
          email: caller?.email ?? null,
          name: caller?.name ?? null,
        },
        callee: {
          _id: call.calleeId,
          email: callee?.email ?? null,
          name: callee?.name ?? null,
        },
      };
    }),
  );
}

async function deleteIceCandidates(ctx, callId) {
  const candidates = ctx.db
    .query("callIceCandidates")
    .withIndex("by_callId", (q) => q.eq("callId", callId));

  for await (const candidate of candidates) {
    await ctx.db.delete(candidate._id);
  }
}

async function recordMissedCall(ctx, call, missedAt) {
  const existing = await ctx.db
    .query("missedCalls")
    .withIndex("by_callId", (q) => q.eq("callId", call._id))
    .unique();
  if (existing !== null) return existing._id;

  return await ctx.db.insert("missedCalls", {
    callId: call._id,
    familyId: call.familyId,
    callerId: call.callerId,
    calleeId: call.calleeId,
    missedAt,
  });
}

async function hasBusyCall(ctx, userId) {
  const [ringingAsCaller, ringingAsCallee, activeAsCaller, activeAsCallee] =
    await Promise.all([
      ctx.db
        .query("calls")
        .withIndex("by_callerId_and_status", (q) =>
          q.eq("callerId", userId).eq("status", "ringing"),
        )
        .take(20),
      ctx.db
        .query("calls")
        .withIndex("by_calleeId_and_status", (q) =>
          q.eq("calleeId", userId).eq("status", "ringing"),
        )
        .take(20),
      ctx.db
        .query("calls")
        .withIndex("by_callerId_and_status", (q) =>
          q.eq("callerId", userId).eq("status", "active"),
        )
        .take(20),
      ctx.db
        .query("calls")
        .withIndex("by_calleeId_and_status", (q) =>
          q.eq("calleeId", userId).eq("status", "active"),
        )
        .take(20),
    ]);

  return [
    ...ringingAsCaller,
    ...ringingAsCallee,
    ...activeAsCaller,
    ...activeAsCallee,
  ].length > 0;
}

function deviceOwnsActiveCall(call, userId, deviceId) {
  const owningDeviceId = call.callerId === userId
    ? call.callerDeviceId
    : call.answeredByDeviceId;
  return owningDeviceId === undefined || owningDeviceId === deviceId;
}

function callerDeviceOwnsRingingCall(call, userId, deviceId) {
  return (
    userId !== call.callerId ||
    call.callerDeviceId === undefined ||
    call.callerDeviceId === deviceId
  );
}

async function getCandidatesForDevice(ctx, call, userId, deviceId) {
  const isCaller = call.callerId === userId;

  // A callee may start gathering ICE before answering, but the caller must
  // never consume candidates until one callee device wins the answer race.
  if (call.status === "ringing" && isCaller) return [];
  if (
    call.status === "active" &&
    !deviceOwnsActiveCall(call, userId, deviceId)
  ) {
    return [];
  }

  const expectedSenderDeviceId = isCaller
    ? call.answeredByDeviceId
    : call.callerDeviceId;
  let candidates;
  if (expectedSenderDeviceId !== undefined) {
    candidates = await ctx.db
      .query("callIceCandidates")
      .withIndex(
        "by_callId_and_recipientId_and_senderDeviceId",
        (q) =>
          q
            .eq("callId", call._id)
            .eq("recipientId", userId)
            .eq("senderDeviceId", expectedSenderDeviceId),
      )
      .order("asc")
      .take(100);
  } else {
    // Calls created during a rolling upgrade may not yet have device fields.
    candidates = await ctx.db
      .query("callIceCandidates")
      .withIndex("by_callId_and_recipientId", (q) =>
        q.eq("callId", call._id).eq("recipientId", userId),
      )
      .order("asc")
      .take(100);
  }

  const negotiationRevision = call.iceRestartRevision ?? 0;
  return candidates.filter(
    (candidate) => (candidate.negotiationRevision ?? 0) === negotiationRevision,
  );
}

export const watch = query({
  args: {
    deviceId: v.optional(v.string()),
    familyId: v.id("families"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireFamilyMembership(ctx, args.familyId, userId);

    const [ringingCalls, activeCalls] = await Promise.all([
      ctx.db
        .query("calls")
        .withIndex("by_familyId_and_status", (q) =>
          q.eq("familyId", args.familyId).eq("status", "ringing"),
        )
        .order("desc")
        .take(20),
      ctx.db
        .query("calls")
        .withIndex("by_familyId_and_status", (q) =>
          q.eq("familyId", args.familyId).eq("status", "active"),
        )
        .order("desc")
        .take(20),
    ]);

    const currentCall =
      [...activeCalls, ...ringingCalls].find(
        (call) => call.callerId === userId || call.calleeId === userId,
      ) ?? null;

    if (currentCall === null) {
      return {
        call: null,
        candidates: [],
      };
    }

    const [callSummary] = await getCallSummaries(ctx, [currentCall]);
    const candidates = await getCandidatesForDevice(
      ctx,
      currentCall,
      userId,
      args.deviceId,
    );

    return {
      call: callSummary,
      candidates,
    };
  },
});

export const listMissed = query({
  args: { familyId: v.id("families") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await requireFamilyMembership(ctx, args.familyId, userId);

    const missedCalls = await ctx.db
      .query("missedCalls")
      .withIndex("by_calleeId_and_familyId_and_missedAt", (q) =>
        q.eq("calleeId", userId).eq("familyId", args.familyId),
      )
      .order("desc")
      .take(5);

    return await Promise.all(missedCalls.map(async (missedCall) => {
      const caller = await ctx.db.get(missedCall.callerId);
      return {
        _id: missedCall._id,
        callId: missedCall.callId,
        callerId: missedCall.callerId,
        missedAt: missedCall.missedAt,
        caller: {
          email: caller?.email ?? null,
          name: caller?.name ?? null,
        },
      };
    }));
  },
});

export const start = mutation({
  args: {
    familyId: v.id("families"),
    calleeId: v.id("users"),
    deviceId: v.optional(v.string()),
    offerSdp: v.string(),
  },
  handler: async (ctx, args) => {
    const callerId = await requireUserId(ctx);
    if (callerId === args.calleeId) {
      throw new Error("You cannot call yourself");
    }

    await requireFamilyMembership(ctx, args.familyId, callerId);
    await requireFamilyMembership(ctx, args.familyId, args.calleeId);

    const [callerBusy, calleeBusy] = await Promise.all([
      hasBusyCall(ctx, callerId),
      hasBusyCall(ctx, args.calleeId),
    ]);
    if (callerBusy || calleeBusy) {
      throw new Error("A call is already in progress");
    }

    const callId = await ctx.db.insert("calls", {
      familyId: args.familyId,
      callerId,
      calleeId: args.calleeId,
      status: "ringing",
      offerSdp: args.offerSdp,
      nativeCallId: createNativeCallId(),
      ...(args.deviceId === undefined
        ? {}
        : { callerDeviceId: args.deviceId }),
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.callNotifications.sendIncoming, { callId });
    return callId;
  },
});

export const answer = mutation({
  args: {
    callId: v.id("calls"),
    deviceId: v.optional(v.string()),
    answerSdp: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const call = await getCallForUser(ctx, args.callId, userId);

    if (call.calleeId !== userId) {
      throw new Error("Only the callee can answer");
    }
    if (call.status !== "ringing") {
      throw new Error("Call is no longer ringing");
    }
    if (
      call.callerDeviceId !== undefined &&
      (args.deviceId === undefined || args.deviceId.trim().length === 0)
    ) {
      throw new Error("A device ID is required to answer this call");
    }

    await ctx.db.patch(call._id, {
      status: "active",
      answerSdp: args.answerSdp,
      ...(args.deviceId === undefined
        ? {}
        : { answeredByDeviceId: args.deviceId }),
      answeredAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.callNotifications.sendResolved, {
      callId: call._id,
      resolution: "answered",
    });

    return call._id;
  },
});

export const offerAutoAnswer = mutation({
  args: {
    callId: v.id("calls"),
    deviceId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const call = await getCallForUser(ctx, args.callId, userId);

    if (call.calleeId !== userId) {
      throw new Error("Only the callee can offer auto-answer");
    }
    if (call.status !== "ringing") {
      throw new Error("Call is no longer ringing");
    }
    if (args.deviceId.trim().length === 0) {
      throw new Error("A device ID is required to offer auto-answer");
    }
    if (Date.now() - call.createdAt < AUTO_ANSWER_DELAY_MS) {
      throw new Error("Auto-answer is not available yet");
    }
    if (
      call.autoAnswerOfferedByDeviceId !== undefined
      && call.autoAnswerOfferedByDeviceId !== args.deviceId
    ) {
      return false;
    }
    if (call.autoAnswerOfferedByDeviceId === args.deviceId) {
      return true;
    }

    await ctx.db.patch(call._id, {
      autoAnswerOfferedByDeviceId: args.deviceId,
      autoAnswerOfferedAt: Date.now(),
    });
    return true;
  },
});

export const revokeAutoAnswerOffer = mutation({
  args: {
    callId: v.id("calls"),
    deviceId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const call = await getCallForUser(ctx, args.callId, userId);

    if (call.calleeId !== userId) {
      throw new Error("Only the callee can revoke auto-answer");
    }
    if (
      call.status !== "ringing"
      || call.autoAnswerOfferedByDeviceId !== args.deviceId
    ) {
      return false;
    }

    await ctx.db.patch(call._id, {
      autoAnswerOfferedByDeviceId: undefined,
      autoAnswerOfferedAt: undefined,
      autoAnswerRequestedAt: undefined,
    });
    return true;
  },
});

export const requestAutoAnswer = mutation({
  args: {
    callId: v.id("calls"),
    deviceId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const call = await getCallForUser(ctx, args.callId, userId);

    if (call.callerId !== userId) {
      throw new Error("Only the caller can request auto-answer");
    }
    if (call.status !== "ringing") {
      throw new Error("Call is no longer ringing");
    }
    if (args.deviceId.trim().length === 0) {
      throw new Error("A device ID is required to request auto-answer");
    }
    if (!callerDeviceOwnsRingingCall(call, userId, args.deviceId)) {
      throw new Error("This device does not own the call");
    }
    if (
      call.autoAnswerOfferedByDeviceId === undefined
      || call.autoAnswerOfferedAt === undefined
      || Date.now() - call.createdAt < AUTO_ANSWER_DELAY_MS
    ) {
      throw new Error("Auto-answer is not available");
    }

    if (call.autoAnswerRequestedAt === undefined) {
      await ctx.db.patch(call._id, { autoAnswerRequestedAt: Date.now() });
    }
    return call._id;
  },
});

export const decline = mutation({
  args: {
    callId: v.id("calls"),
    deviceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const call = await getCallForUser(ctx, args.callId, userId);

    if (call.status !== "ringing") {
      throw new Error("Call is no longer ringing");
    }
    if (!callerDeviceOwnsRingingCall(call, userId, args.deviceId)) {
      throw new Error("This device does not own the call");
    }

    await ctx.db.patch(call._id, {
      status: "declined",
      endedAt: Date.now(),
      endedBy: userId,
    });
    await deleteIceCandidates(ctx, call._id);
    await ctx.scheduler.runAfter(0, internal.callNotifications.sendResolved, {
      callId: call._id,
      resolution: "declined",
    });

    return call._id;
  },
});

export const end = mutation({
  args: {
    callId: v.id("calls"),
    deviceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const call = await getCallForUser(ctx, args.callId, userId);

    if (call.status !== "ringing" && call.status !== "active") {
      return call._id;
    }
    if (
      call.status === "ringing" &&
      !callerDeviceOwnsRingingCall(call, userId, args.deviceId)
    ) {
      throw new Error("This device does not own the call");
    }
    if (
      call.status === "active" &&
      !deviceOwnsActiveCall(call, userId, args.deviceId)
    ) {
      throw new Error("This device does not own the call");
    }

    const endedAt = Date.now();
    await ctx.db.patch(call._id, {
      status: "ended",
      endedAt,
      endedBy: userId,
    });
    if (call.status === "ringing" && userId === call.callerId) {
      await recordMissedCall(ctx, call, endedAt);
    }
    await deleteIceCandidates(ctx, call._id);
    await ctx.scheduler.runAfter(0, internal.callNotifications.sendResolved, {
      callId: call._id,
      resolution: "ended",
    });

    return call._id;
  },
});

export const requestIceRestart = mutation({
  args: {
    callId: v.id("calls"),
    deviceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const call = await getCallForUser(ctx, args.callId, userId);

    if (call.status !== "active") {
      throw new Error("Call is no longer active");
    }
    if (!deviceOwnsActiveCall(call, userId, args.deviceId)) {
      throw new Error("This device does not own the call");
    }

    const now = Date.now();
    if (
      call.iceRestartRequestedAt !== undefined
      && now - call.iceRestartRequestedAt < ICE_RESTART_COOLDOWN_MS
    ) {
      return call.iceRestartRevision ?? 0;
    }

    const revision = (call.iceRestartRevision ?? 0) + 1;
    await ctx.db.patch(call._id, {
      iceRestartRevision: revision,
      iceRestartRequestedAt: now,
      iceRestartOfferSdp: undefined,
      iceRestartAnswerSdp: undefined,
    });
    await deleteIceCandidates(ctx, call._id);
    return revision;
  },
});

export const submitIceRestartOffer = mutation({
  args: {
    callId: v.id("calls"),
    deviceId: v.optional(v.string()),
    revision: v.number(),
    offerSdp: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const call = await getCallForUser(ctx, args.callId, userId);
    if (call.status !== "active") throw new Error("Call is no longer active");
    if (call.callerId !== userId) throw new Error("Only the caller can restart the connection");
    if (!deviceOwnsActiveCall(call, userId, args.deviceId)) {
      throw new Error("This device does not own the call");
    }
    if ((call.iceRestartRevision ?? 0) !== args.revision) {
      throw new Error("Network negotiation is out of date");
    }

    await ctx.db.patch(call._id, {
      iceRestartOfferSdp: args.offerSdp,
      iceRestartAnswerSdp: undefined,
    });
    return call._id;
  },
});

export const submitIceRestartAnswer = mutation({
  args: {
    callId: v.id("calls"),
    deviceId: v.optional(v.string()),
    revision: v.number(),
    answerSdp: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const call = await getCallForUser(ctx, args.callId, userId);
    if (call.status !== "active") throw new Error("Call is no longer active");
    if (call.calleeId !== userId) throw new Error("Only the callee can answer a connection restart");
    if (!deviceOwnsActiveCall(call, userId, args.deviceId)) {
      throw new Error("This device does not own the call");
    }
    if ((call.iceRestartRevision ?? 0) !== args.revision || !call.iceRestartOfferSdp) {
      throw new Error("Network negotiation is out of date");
    }

    await ctx.db.patch(call._id, { iceRestartAnswerSdp: args.answerSdp });
    return call._id;
  },
});

export const expireStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const [staleRingingCalls, staleActiveCalls] = await Promise.all([
      ctx.db
        .query("calls")
        .withIndex("by_status_and_createdAt", (q) =>
          q.eq("status", "ringing").lt("createdAt", now - RINGING_TIMEOUT_MS),
        )
        .take(EXPIRY_BATCH_SIZE),
      ctx.db
        .query("calls")
        .withIndex("by_status_and_createdAt", (q) =>
          q.eq("status", "active").lt("createdAt", now - ACTIVE_CALL_TIMEOUT_MS),
        )
        .take(EXPIRY_BATCH_SIZE),
    ]);
    const staleCalls = [...staleRingingCalls, ...staleActiveCalls];

    for (const call of staleCalls) {
      await ctx.db.patch(call._id, {
        status: "ended",
        endedAt: now,
      });
      if (call.status === "ringing") {
        await recordMissedCall(ctx, call, now);
      }
      await deleteIceCandidates(ctx, call._id);
      await ctx.scheduler.runAfter(0, internal.callNotifications.sendResolved, {
        callId: call._id,
        resolution: "ended",
      });
    }

    if (
      staleRingingCalls.length === EXPIRY_BATCH_SIZE ||
      staleActiveCalls.length === EXPIRY_BATCH_SIZE
    ) {
      await ctx.scheduler.runAfter(0, internal.calls.expireStale, {});
    }

    return staleCalls.length;
  },
});

export const addIceCandidate = mutation({
  args: {
    callId: v.id("calls"),
    recipientId: v.id("users"),
    deviceId: v.optional(v.string()),
    candidate: v.string(),
    sdpMid: v.optional(v.string()),
    sdpMLineIndex: v.optional(v.number()),
    usernameFragment: v.optional(v.string()),
    negotiationRevision: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const senderId = await requireUserId(ctx);
    const call = await getCallForUser(ctx, args.callId, senderId);
    const otherUserId =
      call.callerId === senderId ? call.calleeId : call.callerId;

    if (args.recipientId !== otherUserId) {
      throw new Error("Invalid ICE recipient");
    }
    if (call.status !== "ringing" && call.status !== "active") {
      throw new Error("Call is no longer active");
    }
    if (
      call.status === "active" &&
      !deviceOwnsActiveCall(call, senderId, args.deviceId)
    ) {
      throw new Error("This device does not own the call");
    }
    if (
      call.status === "ringing" &&
      !callerDeviceOwnsRingingCall(call, senderId, args.deviceId)
    ) {
      throw new Error("This device does not own the call");
    }

    const negotiationRevision = call.iceRestartRevision ?? 0;
    if ((args.negotiationRevision ?? 0) !== negotiationRevision) {
      throw new Error("Network negotiation is out of date");
    }

    const senderDeviceId =
      args.deviceId ??
      (senderId === call.callerId
        ? call.callerDeviceId
        : call.answeredByDeviceId);

    return await ctx.db.insert("callIceCandidates", {
      callId: call._id,
      recipientId: args.recipientId,
      senderId,
      ...(senderDeviceId === undefined ? {} : { senderDeviceId }),
      candidate: args.candidate,
      sdpMid: args.sdpMid,
      sdpMLineIndex: args.sdpMLineIndex,
      usernameFragment: args.usernameFragment,
      ...(negotiationRevision === 0 ? {} : { negotiationRevision }),
      createdAt: Date.now(),
    });
  },
});
