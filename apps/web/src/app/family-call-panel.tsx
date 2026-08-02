"use client";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { getOrCreateWebDeviceId } from "./web-device-identity";
import { useLanguage } from "./language";
import { MemberAvatar } from "./member-avatar";
import {
  isStaleNegotiationError,
  retryCallOperation,
} from "../../../../shared/call-retry";

type Member = {
  email: string | null;
  image: string | null;
  joinedAt: number;
  name: string | null;
  role: "member" | "owner";
  userId: Id<"users">;
};

type Props = {
  currentUserId: Id<"users">;
  familyId: Id<"families">;
  members: Member[];
  onCallSurfaceChange?: (visible: boolean) => void;
};

type CallSnapshot = {
  call: null | {
    _id: Id<"calls">;
    answerSdp?: string;
    answeredByDeviceId?: string;
    autoAnswerOfferedAt?: number;
    autoAnswerOfferedByDeviceId?: string;
    autoAnswerRequestedAt?: number;
    calleeId: Id<"users">;
    callerDeviceId?: string;
    callerId: Id<"users">;
    iceRestartAnswerSdp?: string;
    iceRestartOfferSdp?: string;
    iceRestartRevision?: number;
    offerSdp: string;
    status: "active" | "declined" | "ended" | "ringing";
  };
  candidates: Array<{
    _id: Id<"callIceCandidates">;
    candidate: string;
    recipientId: Id<"users">;
    senderDeviceId?: string;
    sdpMid?: string;
    sdpMLineIndex?: number;
    senderId: Id<"users">;
    usernameFragment?: string;
    negotiationRevision?: number;
  }>;
};

type PendingIceCandidate = {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  usernameFragment?: string;
  negotiationRevision: number;
};

type Call = NonNullable<CallSnapshot["call"]>;

function isCallOwnedByDevice(
  call: Call,
  currentUserId: Id<"users">,
  deviceId: string,
  locallyOwnedCallId: Id<"calls"> | null,
) {
  if (call.callerId === currentUserId) {
    return call.callerDeviceId === undefined
      ? locallyOwnedCallId === call._id
      : call.callerDeviceId === deviceId;
  }

  if (call.status !== "active") return false;
  return call.answeredByDeviceId === undefined
    ? locallyOwnedCallId === call._id
    : call.answeredByDeviceId === deviceId;
}

function expectedRemoteDeviceId(call: Call, currentUserId: Id<"users">) {
  return call.callerId === currentUserId
    ? call.answeredByDeviceId
    : call.callerDeviceId;
}

function subscribeToWebDeviceIdentity() {
  return () => undefined;
}

function serializeDescription(description: RTCSessionDescriptionInit) {
  return JSON.stringify({
    type: description.type,
    sdp: description.sdp ?? "",
  });
}

function parseDescription(serialized: string): RTCSessionDescriptionInit {
  const parsed = JSON.parse(serialized);
  return {
    type: parsed.type,
    sdp: parsed.sdp,
  };
}

async function requestLocalMedia() {
  const attempts: MediaStreamConstraints[] = [
    {
      audio: true,
      video: {
        facingMode: "user",
        frameRate: { ideal: 15, max: 24 },
        height: { ideal: 360, max: 720 },
        width: { ideal: 640, max: 1280 },
      },
    },
    {
      audio: true,
      video: true,
    },
  ];

  let lastError: unknown = null;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export function FamilyCallPanel({
  currentUserId,
  familyId,
  members,
  onCallSurfaceChange,
}: Props) {
  const { t, tError } = useLanguage();
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const callSurfaceRef = useRef<HTMLDivElement | null>(null);
  const primaryCallActionRef = useRef<HTMLButtonElement | null>(null);
  const previousCallFocusRef = useRef<HTMLElement | null>(null);
  const wasPhoneCallDialogRef = useRef(false);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const localStreamPromiseRef = useRef<Promise<MediaStream> | null>(null);
  const mediaRequestGenerationRef = useRef(0);
  const callGenerationRef = useRef(0);
  const watchRef = useRef<CallSnapshot | null | undefined>(undefined);
  const remoteUserIdRef = useRef<Id<"users"> | null>(null);
  const currentCallIdRef = useRef<Id<"calls"> | null>(null);
  const answeredCallIdRef = useRef<Id<"calls"> | null>(null);
  const handledElsewhereCallIdRef = useRef<Id<"calls"> | null>(null);
  const processedCandidateIdsRef = useRef<Set<Id<"callIceCandidates">>>(new Set());
  const pendingIceCandidatesRef = useRef<PendingIceCandidate[]>([]);
  const negotiationRevisionRef = useRef(0);
  const restartOfferRevisionRef = useRef(0);
  const restartAnswerRevisionRef = useRef(0);
  const preparedRestartRevisionRef = useRef(0);
  const recoveryTimerRef = useRef<number | null>(null);
  const stalledConnectionTimerRef = useRef<number | null>(null);
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const relayAvailableRef = useRef(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<Id<"users"> | null>(null);
  const [locallyOwnedCallId, setLocallyOwnedCallId] = useState<Id<"calls"> | null>(null);
  const [isPhoneViewport, setIsPhoneViewport] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  const deviceId = useSyncExternalStore(
    subscribeToWebDeviceIdentity,
    getOrCreateWebDeviceId,
    () => null,
  );
  const getIceServers = useAction(api.callCredentials.getIceServers);
  const callState = useQuery(
    api.calls.watch,
    deviceId ? { deviceId, familyId } : "skip",
  ) as CallSnapshot | undefined;
  const startCall = useMutation(api.calls.start);
  const answerCall = useMutation(api.calls.answer);
  const declineCall = useMutation(api.calls.decline);
  const endCall = useMutation(api.calls.end);
  const addIceCandidate = useMutation(api.calls.addIceCandidate);
  const requestAutoAnswer = useMutation(api.calls.requestAutoAnswer);
  const requestIceRestart = useMutation(api.calls.requestIceRestart);
  const submitIceRestartOffer = useMutation(api.calls.submitIceRestartOffer);
  const submitIceRestartAnswer = useMutation(api.calls.submitIceRestartAnswer);

  useEffect(() => {
    const phoneMedia = window.matchMedia("(max-width: 639px)");
    const syncPhoneViewport = () => setIsPhoneViewport(phoneMedia.matches);

    syncPhoneViewport();
    phoneMedia.addEventListener("change", syncPhoneViewport);
    return () => phoneMedia.removeEventListener("change", syncPhoneViewport);
  }, []);

  const activeCall = callState?.call ?? null;
  const incomingCall =
    activeCall?.status === "ringing" && activeCall.calleeId === currentUserId
      ? activeCall
      : null;
  const currentRemoteUserId =
    activeCall === null
      ? null
      : activeCall.callerId === currentUserId
        ? activeCall.calleeId
        : activeCall.callerId;
  const remoteMember = members.find(
    (member) => member.userId === currentRemoteUserId,
  );
  const callableMembers = members.filter(
    (member) => member.userId !== currentUserId,
  );
  const memberLabel = (member: Member | undefined) =>
    member?.name ?? member?.email ?? t("Family member");
  const isOwnedCall = activeCall !== null && deviceId !== null
    ? isCallOwnedByDevice(
        activeCall,
        currentUserId,
        deviceId,
        locallyOwnedCallId,
      )
    : false;
  const isCallOnAnotherDevice = activeCall !== null && !incomingCall && !isOwnedCall;

  const attachStreams = useCallback(
    (
      nextLocalStream: MediaStream | null,
      nextRemoteStream: MediaStream | null,
    ) => {
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = nextLocalStream;
      }
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = nextRemoteStream;
      }
    },
    [],
  );

  const teardownConnection = useCallback((stopLocalTracks: boolean) => {
    mediaRequestGenerationRef.current += 1;
    callGenerationRef.current += 1;
    if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
    recoveryTimerRef.current = null;
    if (stalledConnectionTimerRef.current) clearTimeout(stalledConnectionTimerRef.current);
    stalledConnectionTimerRef.current = null;
    syncQueueRef.current = Promise.resolve();
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    if (stopLocalTracks) {
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      localStreamPromiseRef.current = null;
      setLocalStream(null);
    }
    setRemoteStream(null);
    attachStreams(stopLocalTracks ? null : localStreamRef.current, null);
    currentCallIdRef.current = null;
    remoteUserIdRef.current = null;
    answeredCallIdRef.current = null;
    setLocallyOwnedCallId(null);
    processedCandidateIdsRef.current = new Set();
    pendingIceCandidatesRef.current = [];
    negotiationRevisionRef.current = 0;
    restartOfferRevisionRef.current = 0;
    restartAnswerRevisionRef.current = 0;
    preparedRestartRevisionRef.current = 0;
    relayAvailableRef.current = false;
    setConnectionStatus("connecting");
    setBusyUserId(null);
  }, [attachStreams]);

  const ensureLocalStream = async () => {
    if (localStreamRef.current) {
      return localStreamRef.current;
    }
    if (localStreamPromiseRef.current) {
      return await localStreamPromiseRef.current;
    }

    const generation = mediaRequestGenerationRef.current;
    const request = (async () => {
      const stream = await requestLocalMedia();
      if (generation !== mediaRequestGenerationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("The call ended before the camera was ready.");
      }
      localStreamRef.current = stream;
      setLocalStream(stream);
      attachStreams(stream, remoteStream);
      return stream;
    })();
    localStreamPromiseRef.current = request;

    try {
      return await request;
    } finally {
      if (localStreamPromiseRef.current === request) {
        localStreamPromiseRef.current = null;
      }
    }
  };

  const flushCandidates = useCallback(async () => {
    const peerConnection = peerConnectionRef.current;
    const snapshot = watchRef.current;
    if (!peerConnection || !snapshot?.candidates) {
      return;
    }

    const negotiationRevision = snapshot.call?.iceRestartRevision ?? 0;
    for (const candidate of snapshot.candidates) {
      if (processedCandidateIdsRef.current.has(candidate._id)) {
        continue;
      }
      const call = snapshot.call;
      const expectedSenderDeviceId = call
        ? expectedRemoteDeviceId(call, currentUserId)
        : undefined;
      if (
        candidate.senderDeviceId !== undefined
        && expectedSenderDeviceId !== undefined
        && candidate.senderDeviceId !== expectedSenderDeviceId
      ) {
        continue;
      }
      if ((candidate.negotiationRevision ?? 0) !== negotiationRevision) continue;
      await peerConnection.addIceCandidate({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? undefined,
        sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
        usernameFragment: candidate.usernameFragment ?? undefined,
      });
      processedCandidateIdsRef.current.add(candidate._id);
    }
  }, [currentUserId]);

  const sendIceCandidate = async (candidate: PendingIceCandidate) => {
    const callId = currentCallIdRef.current;
    const recipientId = remoteUserIdRef.current;
    if (!callId || !recipientId || !deviceId) {
      pendingIceCandidatesRef.current.push(candidate);
      return;
    }

    await retryCallOperation(() => addIceCandidate({
      callId,
      deviceId,
      recipientId,
      ...candidate,
    }));
  };

  const flushPendingIceCandidates = async () => {
    const generation = callGenerationRef.current;
    const pendingCandidates = pendingIceCandidatesRef.current;
    pendingIceCandidatesRef.current = [];

    for (const candidate of pendingCandidates) {
      if (generation !== callGenerationRef.current) return;
      await sendIceCandidate(candidate);
    }
  };

  const createPeerConnection = async (otherUserId: Id<"users">) => {
    const generation = callGenerationRef.current;
    const credentials = await getIceServers({});
    relayAvailableRef.current = credentials.relayAvailable;
    if (generation !== callGenerationRef.current) {
      throw new Error("The call ended before the connection was ready.");
    }
    const connection = new RTCPeerConnection({
      iceServers: credentials.iceServers,
    });
    peerConnectionRef.current = connection;
    remoteUserIdRef.current = otherUserId;
    let stream: MediaStream;
    try {
      stream = await ensureLocalStream();
      if (
        generation !== callGenerationRef.current
        || peerConnectionRef.current !== connection
      ) {
        throw new Error("The call ended before the connection was ready.");
      }
    } catch (error) {
      if (peerConnectionRef.current === connection) {
        peerConnectionRef.current = null;
      }
      connection.close();
      throw error;
    }
    const nextRemoteStream = new MediaStream();

    stream.getTracks().forEach((track) => {
      const sender = connection.addTrack(track, stream);
      if (track.kind !== "video") return;
      const parameters = sender.getParameters();
      parameters.encodings ??= [{}];
      parameters.encodings[0] = {
        ...parameters.encodings[0],
        maxBitrate: 650_000,
        maxFramerate: 24,
      };
      parameters.degradationPreference = "balanced";
      void sender.setParameters(parameters).catch(() => undefined);
    });
    connection.ontrack = (event) => {
      if (peerConnectionRef.current !== connection) return;
      event.streams[0]?.getTracks().forEach((track) => {
        nextRemoteStream.addTrack(track);
      });
      setRemoteStream(nextRemoteStream);
      attachStreams(stream, nextRemoteStream);
    };
    connection.onicecandidate = (event) => {
      if (!event.candidate || peerConnectionRef.current !== connection) {
        return;
      }

      void sendIceCandidate({
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid ?? undefined,
        sdpMLineIndex: event.candidate.sdpMLineIndex ?? undefined,
        usernameFragment: event.candidate.usernameFragment ?? undefined,
        negotiationRevision: negotiationRevisionRef.current,
      }).catch((error) => {
        if (!isStaleNegotiationError(error)) {
          setCallError(tError(error, "Could not send network details."));
        }
      });
    };
    const handleConnectionState = () => {
      if (peerConnectionRef.current !== connection) return;
      const state = connection.connectionState;
      if (state === "connected") {
        if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
        setConnectionStatus("connected");
        setCallError(null);
        return;
      }
      if (state !== "disconnected" && state !== "failed") return;
      setConnectionStatus("reconnecting");
      if (state === "failed" && !relayAvailableRef.current) {
        setCallError(t("No relay server is configured. This network may block the video connection."));
      }
      if (recoveryTimerRef.current) return;
      recoveryTimerRef.current = window.setTimeout(() => {
        recoveryTimerRef.current = null;
        const call = watchRef.current?.call;
        if (
          peerConnectionRef.current !== connection
          || !call
          || call.status !== "active"
          || !deviceId
          || !isCallOwnedByDevice(call, currentUserId, deviceId, locallyOwnedCallId)
        ) return;
        void retryCallOperation(() => requestIceRestart({ callId: call._id, deviceId }))
          .catch((error) => setCallError(tError(error, "Could not restore the call connection.")));
      }, state === "failed" ? 0 : 4_000);
    };
    connection.onconnectionstatechange = handleConnectionState;
    connection.oniceconnectionstatechange = handleConnectionState;

    setRemoteStream(nextRemoteStream);
    attachStreams(stream, nextRemoteStream);
    return connection;
  };

  useEffect(() => {
    attachStreams(localStream, remoteStream);
  }, [attachStreams, isOwnedCall, localStream, remoteStream]);

  useEffect(() => {
    watchRef.current = callState;
  }, [callState]);

  useEffect(() => {
    if (activeCall === null) {
      handledElsewhereCallIdRef.current = null;
      if (currentCallIdRef.current !== null) {
        teardownConnection(true);
      }
      const resetBusyUser = window.setTimeout(() => setBusyUserId(null), 0);
      return () => window.clearTimeout(resetBusyUser);
    }

    if (isCallOnAnotherDevice) {
      if (handledElsewhereCallIdRef.current !== activeCall._id) {
        handledElsewhereCallIdRef.current = activeCall._id;
        teardownConnection(true);
      }
      return;
    }

    handledElsewhereCallIdRef.current = null;
    currentCallIdRef.current = activeCall._id;
    remoteUserIdRef.current =
      activeCall.callerId === currentUserId
        ? activeCall.calleeId
        : activeCall.callerId;
  }, [activeCall, currentUserId, isCallOnAnotherDevice, teardownConnection]);

  useEffect(() => {
    const generation = callGenerationRef.current;
    const syncCall = async () => {
      const connection = peerConnectionRef.current;
      if (!activeCall || !isOwnedCall || !connection || !deviceId) {
        return;
      }

      if (
        activeCall.status === "active" &&
        activeCall.callerId === currentUserId &&
        activeCall.answerSdp &&
        answeredCallIdRef.current !== activeCall._id
      ) {
        answeredCallIdRef.current = activeCall._id;
        try {
          await connection.setRemoteDescription(
            parseDescription(activeCall.answerSdp),
          );
        } catch (error) {
          answeredCallIdRef.current = null;
          throw error;
        }
      }

      const revision = activeCall.iceRestartRevision ?? 0;
      if (revision > 0 && preparedRestartRevisionRef.current < revision) {
        preparedRestartRevisionRef.current = revision;
        try {
          const credentials = await retryCallOperation(() => getIceServers({}));
          relayAvailableRef.current = credentials.relayAvailable;
          connection.setConfiguration({ iceServers: credentials.iceServers });
        } catch (error) {
          preparedRestartRevisionRef.current = revision - 1;
          throw error;
        }
      }
      if (
        revision > 0
        && activeCall.callerId === currentUserId
        && restartOfferRevisionRef.current < revision
      ) {
        restartOfferRevisionRef.current = revision;
        negotiationRevisionRef.current = revision;
        processedCandidateIdsRef.current = new Set();
        try {
          connection.restartIce();
          const offer = await connection.createOffer({ iceRestart: true });
          await connection.setLocalDescription(offer);
          await retryCallOperation(() => submitIceRestartOffer({
            callId: activeCall._id,
            deviceId,
            offerSdp: serializeDescription(connection.localDescription ?? offer),
            revision,
          }));
        } catch (error) {
          restartOfferRevisionRef.current = revision - 1;
          throw error;
        }
      }
      if (
        revision > 0
        && activeCall.calleeId === currentUserId
        && activeCall.iceRestartOfferSdp
        && restartAnswerRevisionRef.current < revision
      ) {
        restartAnswerRevisionRef.current = revision;
        negotiationRevisionRef.current = revision;
        processedCandidateIdsRef.current = new Set();
        try {
          await connection.setRemoteDescription(parseDescription(activeCall.iceRestartOfferSdp));
          const answer = await connection.createAnswer();
          await connection.setLocalDescription(answer);
          await retryCallOperation(() => submitIceRestartAnswer({
            answerSdp: serializeDescription(connection.localDescription ?? answer),
            callId: activeCall._id,
            deviceId,
            revision,
          }));
        } catch (error) {
          restartAnswerRevisionRef.current = revision - 1;
          throw error;
        }
      }
      if (
        revision > 0
        && activeCall.callerId === currentUserId
        && activeCall.iceRestartAnswerSdp
        && restartAnswerRevisionRef.current < revision
      ) {
        restartAnswerRevisionRef.current = revision;
        try {
          await connection.setRemoteDescription(parseDescription(activeCall.iceRestartAnswerSdp));
        } catch (error) {
          restartAnswerRevisionRef.current = revision - 1;
          throw error;
        }
      }

      if (
        generation !== callGenerationRef.current
        || peerConnectionRef.current !== connection
      ) return;
      await flushCandidates();
    };

    const queuedSync = syncQueueRef.current.catch(() => undefined).then(syncCall);
    syncQueueRef.current = queuedSync;
    void queuedSync.catch((error) => {
      if (generation !== callGenerationRef.current) return;
      setCallError(tError(error, "Could not sync call state."));
    });
  }, [activeCall, currentUserId, callState, flushCandidates, isOwnedCall, tError]);

  useEffect(() => {
    if (
      activeCall?.status !== "active"
      || !isOwnedCall
      || !deviceId
      || connectionStatus === "connected"
      || stalledConnectionTimerRef.current
    ) return;

    stalledConnectionTimerRef.current = window.setTimeout(() => {
      stalledConnectionTimerRef.current = null;
      const call = watchRef.current?.call;
      if (
        !call
        || call.status !== "active"
        || !isCallOwnedByDevice(call, currentUserId, deviceId, locallyOwnedCallId)
      ) return;
      setConnectionStatus("reconnecting");
      void retryCallOperation(() => requestIceRestart({ callId: call._id, deviceId }))
        .catch((error) => setCallError(tError(error, "Could not restore the call connection.")));
    }, connectionStatus === "connecting" ? 12_000 : 10_000);

    return () => {
      if (stalledConnectionTimerRef.current) window.clearTimeout(stalledConnectionTimerRef.current);
      stalledConnectionTimerRef.current = null;
    };
  }, [activeCall?._id, activeCall?.iceRestartRevision, activeCall?.status, connectionStatus, currentUserId, deviceId, isOwnedCall, locallyOwnedCallId, requestIceRestart, tError]);

  useEffect(() => {
    return () => {
      teardownConnection(true);
    };
  }, [teardownConnection]);

  const onStartCall = async (calleeId: Id<"users">) => {
    if (!deviceId) {
      setCallError(t("This device is still being prepared for calls."));
      return;
    }
    if (typeof window === "undefined" || !window.RTCPeerConnection) {
      setCallError(t("This browser does not support video calling."));
      return;
    }

    const generation = callGenerationRef.current;
    setBusyUserId(calleeId);
    setCallError(null);
    try {
      const connection = await createPeerConnection(calleeId);
      if (generation !== callGenerationRef.current) return;
      const offer = await connection.createOffer();
      if (generation !== callGenerationRef.current) return;
      await connection.setLocalDescription(offer);
      if (generation !== callGenerationRef.current) return;
      const callId = await startCall({
        familyId,
        calleeId,
        deviceId,
        offerSdp: serializeDescription(connection.localDescription ?? offer),
      });
      if (generation !== callGenerationRef.current) return;
      currentCallIdRef.current = callId;
      setLocallyOwnedCallId(callId);
      await flushPendingIceCandidates();
    } catch (error) {
      if (generation !== callGenerationRef.current) return;
      teardownConnection(true);
      setCallError(
        error instanceof Error && error.name === "NotFoundError"
          ? t("No camera or microphone was found. Check this device's media settings and try again.")
          : tError(error, "Could not start the call."),
      );
    } finally {
      if (generation === callGenerationRef.current) setBusyUserId(null);
    }
  };

  const onAccept = async () => {
    if (!incomingCall || !deviceId) {
      return;
    }

    const generation = callGenerationRef.current;
    setBusyUserId(incomingCall.callerId);
    setCallError(null);
    try {
      const connection = await createPeerConnection(incomingCall.callerId);
      if (generation !== callGenerationRef.current) return;
      await connection.setRemoteDescription(
        parseDescription(incomingCall.offerSdp),
      );
      if (generation !== callGenerationRef.current) return;
      await flushCandidates();
      if (generation !== callGenerationRef.current) return;
      const answer = await connection.createAnswer();
      if (generation !== callGenerationRef.current) return;
      await connection.setLocalDescription(answer);
      if (generation !== callGenerationRef.current) return;
      await answerCall({
        callId: incomingCall._id,
        deviceId,
        answerSdp: serializeDescription(connection.localDescription ?? answer),
      });
      if (generation !== callGenerationRef.current) return;
      setLocallyOwnedCallId(incomingCall._id);
      answeredCallIdRef.current = incomingCall._id;
      await flushCandidates();
    } catch (error) {
      if (generation !== callGenerationRef.current) return;
      teardownConnection(true);
      const wasAnsweredElsewhere =
        error instanceof Error && /no longer ringing/i.test(error.message);
      setCallError(
        wasAnsweredElsewhere
          ? null
          : error instanceof Error && error.name === "NotFoundError"
            ? t("No camera or microphone was found. Check this device's media settings and try again.")
            : tError(error, "Could not answer the call."),
      );
    } finally {
      if (generation === callGenerationRef.current) setBusyUserId(null);
    }
  };

  const onDecline = async () => {
    if (!incomingCall || !deviceId) {
      return;
    }
    setBusyUserId(incomingCall.callerId);
    setCallError(null);
    try {
      await declineCall({ callId: incomingCall._id, deviceId });
    } catch (error) {
      setCallError(tError(error, "Could not decline the call."));
    } finally {
      setBusyUserId(null);
    }
  };

  const onHangUp = async () => {
    if (!activeCall || !deviceId || !isOwnedCall) {
      return;
    }
    setBusyUserId(currentRemoteUserId);
    setCallError(null);
    try {
      await endCall({ callId: activeCall._id, deviceId });
    } catch (error) {
      setCallError(tError(error, "Could not end the call."));
    } finally {
      teardownConnection(true);
      setBusyUserId(null);
    }
  };

  const onRequestAutoAnswer = async () => {
    if (
      !activeCall
      || !deviceId
      || activeCall.status !== "ringing"
      || activeCall.callerId !== currentUserId
      || !isOwnedCall
    ) return;
    setBusyUserId(activeCall.calleeId);
    setCallError(null);
    try {
      await requestAutoAnswer({ callId: activeCall._id, deviceId });
    } catch (error) {
      setCallError(tError(error, "Could not request automatic answering."));
    } finally {
      setBusyUserId(null);
    }
  };

  const isOnCall = activeCall !== null;
  const isIncoming = incomingCall !== null;
  const canRequestAutoAnswer =
    activeCall?.status === "ringing"
    && activeCall.callerId === currentUserId
    && isOwnedCall
    && activeCall.autoAnswerOfferedByDeviceId !== undefined
    && activeCall.autoAnswerRequestedAt === undefined;
  const automaticAnswerRequested =
    activeCall?.status === "ringing"
    && activeCall.callerId === currentUserId
    && isOwnedCall
    && activeCall.autoAnswerRequestedAt !== undefined;
  const hasForegroundCallSurface =
    !isCallOnAnotherDevice && (isIncoming || isOwnedCall);
  const isPhoneCallDialog = hasForegroundCallSurface && isPhoneViewport;

  useEffect(() => {
    onCallSurfaceChange?.(hasForegroundCallSurface);
  }, [hasForegroundCallSurface, onCallSurfaceChange]);

  useEffect(() => {
    if (!isPhoneCallDialog) {
      if (hasForegroundCallSurface) return;

      if (!wasPhoneCallDialogRef.current) return;
      wasPhoneCallDialogRef.current = false;
      const previousFocus = previousCallFocusRef.current;
      previousCallFocusRef.current = null;
      const restoreFrame = window.requestAnimationFrame(() => {
        const isMeaningfulRestoreTarget =
          previousFocus?.isConnected &&
          previousFocus !== document.body &&
          previousFocus !== document.documentElement;
        if (isMeaningfulRestoreTarget) {
          previousFocus.focus();
          if (document.activeElement === previousFocus) return;
        }
        const fallbackAction = callSurfaceRef.current?.querySelector<HTMLButtonElement>(
          "button:not([disabled])",
        );
        (fallbackAction ?? callSurfaceRef.current)?.focus();
      });
      return () => window.cancelAnimationFrame(restoreFrame);
    }

    wasPhoneCallDialogRef.current = true;
    if (
      previousCallFocusRef.current === null &&
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body &&
      document.activeElement !== document.documentElement
    ) {
      previousCallFocusRef.current = document.activeElement;
    }
    const focusFrame = window.requestAnimationFrame(() => {
      const primaryAction = primaryCallActionRef.current;
      if (primaryAction && !primaryAction.disabled) {
        primaryAction.focus();
      } else {
        callSurfaceRef.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [busyUserId, deviceId, hasForegroundCallSurface, isIncoming, isOwnedCall, isPhoneCallDialog]);

  const keepFocusInsideCallSurface = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (!isPhoneCallDialog || event.key !== "Tab") return;
    const callSurface = callSurfaceRef.current;
    if (!callSurface) return;
    const focusableElements = Array.from(
      callSurface.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
    );
    const first = focusableElements[0];
    const last = focusableElements.at(-1);
    if (!first || !last) {
      event.preventDefault();
      callSurface.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const remoteLabel = memberLabel(remoteMember);
  const callOnAnotherDeviceMessage =
    activeCall?.status === "active" && activeCall.calleeId === currentUserId
      ? t("Answered on another device.")
      : activeCall?.status === "ringing"
        ? t("This call was started on another device.")
        : t("This call is active on another device.");

  return (
    <div
      ref={callSurfaceRef}
      aria-labelledby={isPhoneCallDialog ? "family-call-title" : undefined}
      aria-modal={isPhoneCallDialog || undefined}
      className={`min-w-0 space-y-4 rounded-3xl border border-sky-400/20 bg-sky-400/5 p-4 sm:p-5 ${hasForegroundCallSurface ? "foreground-call-surface" : ""}`}
      onKeyDown={keepFocusInsideCallSurface}
      role={isPhoneCallDialog ? "dialog" : undefined}
      tabIndex={-1}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm uppercase tracking-[0.3em] text-sky-200">
            {t("Family Calls")}
          </p>
          <div className="mt-2 flex min-w-0 items-center gap-3">
            {remoteMember ? (
              <MemberAvatar
                className="size-11"
                image={remoteMember.image}
                label={remoteLabel}
              />
            ) : null}
            <h3 className="min-w-0 break-words text-xl font-semibold text-stone-50 sm:text-2xl" id="family-call-title">
              {isIncoming
                ? t("{name} is calling", { name: remoteLabel })
                : isOwnedCall
                  ? t("Call with {name}", { name: remoteLabel })
                  : t("Start a face-to-face check-in")}
            </h3>
          </div>
          <p className="call-description mt-2 max-w-2xl text-sm leading-6 text-stone-300">
            {t("Calls use WebRTC in the browser. Convex handles the live signaling, and Cloudflare TURN can be used as the relay when direct peer connections are not enough.")}
          </p>
        </div>
        {isOwnedCall ? (
          <button
            ref={primaryCallActionRef}
            className="min-h-11 w-full shrink-0 rounded-2xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm font-medium text-rose-100 transition hover:border-rose-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-200 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
            disabled={busyUserId !== null}
            onClick={onHangUp}
            type="button"
          >
            {t("Hang up")}
          </button>
        ) : null}
      </div>

      {callError ? (
        <p className="break-words rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
          {callError}
        </p>
      ) : null}

      {isCallOnAnotherDevice ? (
        <p className="rounded-2xl border border-sky-300/30 bg-sky-300/10 px-4 py-3 text-sm text-sky-100">
          {callOnAnotherDeviceMessage}
        </p>
      ) : null}

      {isOwnedCall && connectionStatus === "reconnecting" ? (
        <p aria-live="polite" className="rounded-2xl border border-amber-300/30 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
          {t("Restoring the video connection…")}
        </p>
      ) : null}

      {canRequestAutoAnswer ? (
        <div className="flex min-w-0 flex-col gap-3 rounded-2xl border border-sky-300/30 bg-sky-300/10 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm leading-6 text-sky-100">
            {t("No answer yet. This device allows you to connect automatically.")}
          </p>
          <button
            className="min-h-11 shrink-0 rounded-2xl bg-sky-200 px-4 py-3 text-sm font-medium text-stone-950 transition hover:bg-sky-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-100 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={busyUserId !== null || deviceId === null}
            onClick={onRequestAutoAnswer}
            type="button"
          >
            {t("Connect automatically")}
          </button>
        </div>
      ) : null}

      {automaticAnswerRequested ? (
        <p aria-live="polite" className="rounded-2xl border border-sky-300/30 bg-sky-300/10 px-4 py-3 text-sm text-sky-100">
          {t("Automatic answering requested. Waiting for the other device to connect…")}
        </p>
      ) : null}

      {isIncoming ? (
        <div aria-live="assertive" className="flex min-w-0 flex-col gap-4 rounded-2xl border border-amber-300/30 bg-amber-300/10 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <MemberAvatar
              className="size-14"
              image={remoteMember?.image}
              label={remoteLabel}
            />
            <div className="min-w-0">
              <p className="text-sm uppercase tracking-[0.24em] text-amber-200">
                {t("Incoming call")}
              </p>
              <p className="mt-2 break-words text-lg font-medium text-stone-50">
                {t("{name} is calling you", { name: remoteLabel })}
              </p>
            </div>
          </div>
          <div className="grid w-full grid-cols-2 gap-3 sm:w-auto">
            <button
              ref={primaryCallActionRef}
              className="min-h-11 rounded-2xl bg-emerald-300 px-4 py-3 text-sm font-medium text-stone-950 transition hover:bg-emerald-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={busyUserId !== null || deviceId === null}
              onClick={onAccept}
              type="button"
            >
              {t("Answer")}
            </button>
            <button
              className="min-h-11 rounded-2xl border border-stone-600 px-4 py-3 text-sm font-medium text-stone-100 transition hover:border-stone-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-200 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={busyUserId !== null || deviceId === null}
              onClick={onDecline}
              type="button"
            >
              {t("Decline")}
            </button>
          </div>
        </div>
      ) : null}

      {!isOnCall ? (
        <div className="grid gap-3 sm:flex sm:flex-wrap">
          {callableMembers.length === 0 ? (
            <p className="text-sm text-stone-400">
              {t("Add another family member to start a call.")}
            </p>
          ) : (
            callableMembers.map((member) => (
              <button
                key={member.userId}
                className="flex min-h-11 min-w-0 items-center justify-center gap-2 break-words rounded-2xl border border-sky-300/30 bg-sky-300/10 px-4 py-2 text-sm font-medium text-sky-100 transition hover:border-sky-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-200 disabled:cursor-not-allowed disabled:opacity-60 sm:rounded-full"
                disabled={busyUserId !== null || deviceId === null}
                onClick={() => onStartCall(member.userId)}
                type="button"
              >
                <MemberAvatar
                  className="size-8"
                  image={member.image}
                  label={memberLabel(member)}
                />
                <span>{t("Call {name}", { name: memberLabel(member) })}</span>
              </button>
            ))
          )}
        </div>
      ) : null}

      {isOwnedCall ? <div className="foreground-video-grid grid min-w-0 gap-4 md:grid-cols-2">
        <div className="min-w-0 overflow-hidden rounded-3xl border border-stone-800 bg-stone-950">
          <div className="border-b border-stone-800 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.24em] text-stone-500">
              {t("You")}
            </p>
          </div>
          <video
            ref={localVideoRef}
            autoPlay
            className="block aspect-video min-w-0 w-full bg-stone-950 object-cover"
            muted
            playsInline
          />
        </div>
        <div className="min-w-0 overflow-hidden rounded-3xl border border-stone-800 bg-stone-950">
          <div className="border-b border-stone-800 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.24em] text-stone-500">
              {isOnCall ? remoteLabel : t("Waiting for call")}
            </p>
          </div>
          <video
            ref={remoteVideoRef}
            autoPlay
            className="block aspect-video min-w-0 w-full bg-stone-950 object-cover"
            playsInline
          />
        </div>
      </div> : null}
    </div>
  );
}
