import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    profileImageStorageId: v.optional(v.id("_storage")),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"])
    .index("by_profileImageStorageId", ["profileImageStorageId"]),
  families: defineTable({
    name: v.string(),
    createdBy: v.id("users"),
    inviteCode: v.string(),
    createdAt: v.number(),
  })
    .index("by_createdBy", ["createdBy"])
    .index("by_inviteCode", ["inviteCode"]),
  familyMembers: defineTable({
    familyId: v.id("families"),
    userId: v.id("users"),
    role: v.union(v.literal("owner"), v.literal("member")),
    joinedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_familyId", ["familyId"])
    .index("by_familyId_and_userId", ["familyId", "userId"]),
  familyPresence: defineTable({
    // Deprecated: retained until the cleanup migration has completed in every
    // deployment. No application code reads or writes this table.
    familyId: v.id("families"),
    userId: v.id("users"),
    lastSeenAt: v.number(),
  })
    .index("by_familyId", ["familyId"])
    .index("by_userId", ["userId"])
    .index("by_familyId_and_userId", ["familyId", "userId"]),
  calls: defineTable({
    familyId: v.id("families"),
    callerId: v.id("users"),
    calleeId: v.id("users"),
    status: v.union(
      v.literal("ringing"),
      v.literal("active"),
      v.literal("declined"),
      v.literal("ended"),
    ),
    offerSdp: v.string(),
    nativeCallId: v.optional(v.string()),
    callerDeviceId: v.optional(v.string()),
    answerSdp: v.optional(v.string()),
    answeredByDeviceId: v.optional(v.string()),
    iceRestartRevision: v.optional(v.number()),
    iceRestartRequestedAt: v.optional(v.number()),
    iceRestartOfferSdp: v.optional(v.string()),
    iceRestartAnswerSdp: v.optional(v.string()),
    autoAnswerOfferedByDeviceId: v.optional(v.string()),
    autoAnswerOfferedAt: v.optional(v.number()),
    autoAnswerRequestedAt: v.optional(v.number()),
    createdAt: v.number(),
    answeredAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    endedBy: v.optional(v.id("users")),
  })
    .index("by_familyId_and_status", ["familyId", "status"])
    .index("by_calleeId_and_status", ["calleeId", "status"])
    .index("by_callerId_and_status", ["callerId", "status"])
    .index("by_status_and_createdAt", ["status", "createdAt"]),
  callIceCandidates: defineTable({
    callId: v.id("calls"),
    recipientId: v.id("users"),
    senderId: v.id("users"),
    senderDeviceId: v.optional(v.string()),
    candidate: v.string(),
    sdpMid: v.optional(v.string()),
    sdpMLineIndex: v.optional(v.number()),
    usernameFragment: v.optional(v.string()),
    negotiationRevision: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_callId", ["callId"])
    .index("by_callId_and_recipientId", ["callId", "recipientId"])
    .index("by_callId_and_recipientId_and_senderDeviceId", [
      "callId",
      "recipientId",
      "senderDeviceId",
    ]),
  pushTokens: defineTable({
    userId: v.id("users"),
    platform: v.union(v.literal("android"), v.literal("ios")),
    token: v.string(),
    deviceId: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_userId_and_deviceId", ["userId", "deviceId"])
    .index("by_userId_and_platform", ["userId", "platform"]),
  notes: defineTable({
    // Deprecated: the sample API was removed. Retain this table until the
    // cleanup migration has completed in every deployment.
    text: v.string(),
    createdAt: v.number(),
  }),
});
