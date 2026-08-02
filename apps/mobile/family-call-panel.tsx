import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  mediaDevices,
  MediaStream,
  RTCPeerConnection,
  RTCRtpSender,
  RTCView,
} from "react-native-webrtc";
import {
  AUTO_ANSWER_DELAY_MS,
  canOfferAutoAnswer,
  shouldAcceptAutoAnswer,
} from "./auto-answer-policy";
import {
  bringCallAppToForeground,
  claimIncomingCallInApp,
  clearCallAppLockScreenVisibility,
  dismissNativeCall,
  dismissResolvedIncomingCall,
  initializeNativeCallService,
  markNativeCallActive,
  resumeIncomingCallAlert,
  setNativeCallHandlers,
  showIncomingCall,
  waitForCallAppForeground,
} from "./native-call-service";
import { MemberAvatar } from "./member-avatar";
import { useResponsiveLayout } from "./responsive-layout";
import { getSeniorModeLayout } from "./senior-mode-layout";
import { SeniorClock } from "./senior-clock";
import { useLanguage } from "./language";
import {
  isStaleNegotiationError,
  retryCallOperation,
} from "../../shared/call-retry";
import { formatCallTime } from "../../shared/call-time";
import { preferVp8VideoCodec } from "../../shared/video-codecs";

type Member = {
  email: string | null;
  image: string | null;
  name: string | null;
  userId: Id<"users">;
};

type Props = {
  autoAnswerCalls: boolean;
  currentUserId: Id<"users">;
  deviceId: string;
  familyId: Id<"families">;
  members: Member[];
  onCallSurfaceChange?: (visible: boolean) => void;
  onSelectFamily: (familyId: string) => void;
  seniorMode?: {
    memberIds: Id<"users">[];
    onExitRequest: () => void;
  };
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
    createdAt: number;
    iceRestartAnswerSdp?: string;
    iceRestartOfferSdp?: string;
    iceRestartRevision?: number;
    offerSdp: string;
    nativeCallId?: string;
    status: "active" | "declined" | "ended" | "ringing";
  };
  candidates: Array<{
    _id: Id<"callIceCandidates">;
    candidate: string;
    senderDeviceId?: string;
    sdpMid?: string;
    sdpMLineIndex?: number;
    usernameFragment?: string;
    negotiationRevision?: number;
  }>;
};

type PendingCandidate = {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  usernameFragment?: string;
  negotiationRevision: number;
};

type MissedCall = {
  _id: Id<"missedCalls">;
  callerId: Id<"users">;
  missedAt: number;
  caller: {
    email: string | null;
    name: string | null;
  };
};

type RemoteTrack = ReturnType<MediaStream["getTracks"]>[number];

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

type NativeConnectionEvents = {
  onconnectionstatechange: (() => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  onicecandidate: ((event: {
    candidate: null | {
      candidate: string;
      sdpMLineIndex?: number | null;
      sdpMid?: string | null;
      usernameFragment?: string | null;
    };
  }) => void) | null;
  ontrack: ((event: { streams: MediaStream[]; track?: RemoteTrack }) => void) | null;
};

function serializeDescription(description: { type?: string | null; sdp?: string | null }) {
  return JSON.stringify({ type: description.type, sdp: description.sdp ?? "" });
}

function parseDescription(serialized: string) {
  return JSON.parse(serialized) as { type: "answer" | "offer"; sdp: string };
}

function releaseLocalMediaStream(stream: MediaStream) {
  stream.getTracks().forEach((track) => track.stop());
  stream.release();
}

async function requestCameraAndMicrophone() {
  if (Platform.OS === "android") {
    const result = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.CAMERA,
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    ]);
    if (
      result[PermissionsAndroid.PERMISSIONS.CAMERA] !== PermissionsAndroid.RESULTS.GRANTED ||
      result[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] !== PermissionsAndroid.RESULTS.GRANTED
    ) {
      throw new Error("Camera and microphone access is required for calls.");
    }
  }
  return await mediaDevices.getUserMedia({
    audio: true,
    video: {
      facingMode: "user",
      frameRate: { ideal: 15, max: 24 },
      height: { ideal: 360, max: 720 },
      width: { ideal: 640, max: 1280 },
    },
  });
}

export function FamilyCallPanel({
  autoAnswerCalls,
  currentUserId,
  deviceId,
  familyId,
  members,
  onCallSurfaceChange,
  onSelectFamily,
  seniorMode,
}: Props) {
  const { language, t, tError } = useLanguage();
  const insets = useSafeAreaInsets();
  const {
    height,
    isCompactLandscape,
    isLandscape,
    isTablet,
    width,
  } = useResponsiveLayout();
  const connectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const localStreamPromiseRef = useRef<Promise<MediaStream> | null>(null);
  const mediaRequestGenerationRef = useRef(0);
  const callGenerationRef = useRef(0);
  const callIdRef = useRef<Id<"calls"> | null>(null);
  const remoteUserIdRef = useRef<Id<"users"> | null>(null);
  const answeredCallIdRef = useRef<Id<"calls"> | null>(null);
  const locallyOwnedCallIdRef = useRef<Id<"calls"> | null>(null);
  const resolvedElsewhereCallIdRef = useRef<Id<"calls"> | null>(null);
  const acceptingCallIdRef = useRef<Id<"calls"> | null>(null);
  const processedCandidateIdsRef = useRef<Set<Id<"callIceCandidates">>>(new Set());
  const pendingCandidatesRef = useRef<PendingCandidate[]>([]);
  const remoteFallbackStreamRef = useRef<MediaStream | null>(null);
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const watchRef = useRef<CallSnapshot | undefined>(undefined);
  const nativeCallIdRef = useRef<string | null>(null);
  const resolvedNativeCallIdRef = useRef<string | null>(null);
  const autoAnswerOfferCallIdRef = useRef<Id<"calls"> | null>(null);
  const negotiationRevisionRef = useRef(0);
  const restartOfferRevisionRef = useRef(0);
  const restartAnswerRevisionRef = useRef(0);
  const preparedRestartRevisionRef = useRef(0);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stalledConnectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const relayAvailableRef = useRef(false);
  const remoteVideoReadyRef = useRef(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [remoteVideoReady, setRemoteVideoReady] = useState(false);
  const [remoteVideoRenderRevision, setRemoteVideoRenderRevision] = useState(0);
  const [answeringCallId, setAnsweringCallId] = useState<Id<"calls"> | null>(null);
  const [locallyOwnedCallId, setLocallyOwnedCallId] = useState<Id<"calls"> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appState, setAppState] = useState(AppState.currentState);
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  const getIceServers = useAction(api.callCredentials.getIceServers);
  const startCall = useMutation(api.calls.start);
  const answerCall = useMutation(api.calls.answer);
  const declineCall = useMutation(api.calls.decline);
  const endCall = useMutation(api.calls.end);
  const addIceCandidate = useMutation(api.calls.addIceCandidate);
  const offerAutoAnswer = useMutation(api.calls.offerAutoAnswer);
  const revokeAutoAnswerOffer = useMutation(api.calls.revokeAutoAnswerOffer);
  const requestAutoAnswer = useMutation(api.calls.requestAutoAnswer);
  const requestIceRestart = useMutation(api.calls.requestIceRestart);
  const submitIceRestartOffer = useMutation(api.calls.submitIceRestartOffer);
  const submitIceRestartAnswer = useMutation(api.calls.submitIceRestartAnswer);
  const callState = useQuery(api.calls.watch, { deviceId, familyId }) as CallSnapshot | undefined;
  const missedCalls = useQuery(api.calls.listMissed, { familyId }) as MissedCall[] | undefined;
  watchRef.current = callState;

  const activeCall = callState?.call ?? null;
  const incomingCall = activeCall?.status === "ringing" && activeCall.calleeId === currentUserId ? activeCall : null;
  const remoteUserId = activeCall
    ? activeCall.callerId === currentUserId ? activeCall.calleeId : activeCall.callerId
    : null;
  const remoteMember = members.find((member) => member.userId === remoteUserId);
  const callableMembers = members.filter((member) => member.userId !== currentUserId);
  const seniorModeMembers = seniorMode
    ? callableMembers.filter((member) => seniorMode.memberIds.includes(member.userId))
    : [];
  const memberLabel = (member: Member | undefined) =>
    member?.name ?? member?.email ?? t("Family member");
  const isOwnedCall = activeCall
    ? isCallOwnedByDevice(
        activeCall,
        currentUserId,
        deviceId,
        locallyOwnedCallId,
      )
    : false;
  const isCallOnAnotherDevice = activeCall !== null && !incomingCall && !isOwnedCall;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", setAppState);
    return () => subscription.remove();
  }, []);

  const teardown = (dismissNativePresentation = true) => {
    mediaRequestGenerationRef.current += 1;
    callGenerationRef.current += 1;
    syncQueueRef.current = Promise.resolve();
    if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
    recoveryTimerRef.current = null;
    if (stalledConnectionTimerRef.current) clearTimeout(stalledConnectionTimerRef.current);
    stalledConnectionTimerRef.current = null;
    const nativeCallId = nativeCallIdRef.current ?? activeCall?.nativeCallId ?? null;
    nativeCallIdRef.current = null;
    if (nativeCallId && dismissNativePresentation) dismissNativeCall(nativeCallId);
    else clearCallAppLockScreenVisibility();
    connectionRef.current?.close();
    connectionRef.current = null;
    if (localStreamRef.current) releaseLocalMediaStream(localStreamRef.current);
    localStreamRef.current = null;
    localStreamPromiseRef.current = null;
    remoteFallbackStreamRef.current?.release();
    remoteFallbackStreamRef.current = null;
    remoteVideoReadyRef.current = false;
    setLocalStream(null);
    setRemoteStream(null);
    setRemoteVideoReady(false);
    setRemoteVideoRenderRevision(0);
    setAnsweringCallId(null);
    setBusy(false);
    callIdRef.current = null;
    remoteUserIdRef.current = null;
    answeredCallIdRef.current = null;
    locallyOwnedCallIdRef.current = null;
    setLocallyOwnedCallId(null);
    acceptingCallIdRef.current = null;
    processedCandidateIdsRef.current = new Set();
    pendingCandidatesRef.current = [];
    negotiationRevisionRef.current = 0;
    restartOfferRevisionRef.current = 0;
    restartAnswerRevisionRef.current = 0;
    preparedRestartRevisionRef.current = 0;
    relayAvailableRef.current = false;
    setConnectionStatus("connecting");
  };

  const ensureLocalStream = async () => {
    if (localStreamRef.current) return localStreamRef.current;
    if (localStreamPromiseRef.current) return await localStreamPromiseRef.current;

    const generation = mediaRequestGenerationRef.current;
    const request = (async () => {
      await waitForCallAppForeground();
      const stream = await requestCameraAndMicrophone();
      if (generation !== mediaRequestGenerationRef.current) {
        releaseLocalMediaStream(stream);
        throw new Error("The call ended before the camera was ready.");
      }
      localStreamRef.current = stream;
      setLocalStream(stream);
      return stream;
    })();
    localStreamPromiseRef.current = request;

    try {
      return await request;
    } finally {
      if (localStreamPromiseRef.current === request) localStreamPromiseRef.current = null;
    }
  };

  const sendCandidate = async (candidate: PendingCandidate) => {
    if (!callIdRef.current || !remoteUserIdRef.current) {
      pendingCandidatesRef.current.push(candidate);
      return;
    }
    const callId = callIdRef.current;
    const recipientId = remoteUserIdRef.current;
    await retryCallOperation(() => addIceCandidate({
      callId,
      deviceId,
      recipientId,
      ...candidate,
    }));
  };

  const flushPendingCandidates = async () => {
    const generation = callGenerationRef.current;
    const candidates = pendingCandidatesRef.current;
    pendingCandidatesRef.current = [];
    for (const candidate of candidates) {
      if (generation !== callGenerationRef.current) return;
      await sendCandidate(candidate);
    }
  };

  const flushRemoteCandidates = async () => {
    const connection = connectionRef.current;
    const candidates = watchRef.current?.candidates ?? [];
    if (!connection?.remoteDescription) return;
    const call = watchRef.current?.call;
    const expectedSenderDeviceId = call
      ? expectedRemoteDeviceId(call, currentUserId)
      : undefined;
    const negotiationRevision = call?.iceRestartRevision ?? 0;
    for (const candidate of candidates) {
      if (processedCandidateIdsRef.current.has(candidate._id)) continue;
      if (
        candidate.senderDeviceId !== undefined
        && expectedSenderDeviceId !== undefined
        && candidate.senderDeviceId !== expectedSenderDeviceId
      ) continue;
      if ((candidate.negotiationRevision ?? 0) !== negotiationRevision) continue;
      processedCandidateIdsRef.current.add(candidate._id);
      try {
        await connection.addIceCandidate({
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
          usernameFragment: candidate.usernameFragment,
        });
      } catch (error) {
        processedCandidateIdsRef.current.delete(candidate._id);
        throw error;
      }
    }
  };

  const createConnection = async (otherUserId: Id<"users">) => {
    const generation = callGenerationRef.current;
    const { iceServers, relayAvailable } = await getIceServers({});
    relayAvailableRef.current = relayAvailable;
    if (generation !== callGenerationRef.current) {
      throw new Error("The call ended before the connection was ready.");
    }
    const connection = new RTCPeerConnection({ iceServers });
    connectionRef.current = connection;
    remoteUserIdRef.current = otherUserId;
    const remoteMediaStream = new MediaStream();
    remoteFallbackStreamRef.current = remoteMediaStream;

    let stream: MediaStream;
    try {
      stream = await ensureLocalStream();
      if (
        generation !== callGenerationRef.current ||
        connectionRef.current !== connection
      ) {
        throw new Error("The call ended before the connection was ready.");
      }
      stream.getTracks().forEach((track) => {
        const sender = connection.addTrack(track, stream) as unknown as {
          id?: string;
          getParameters?: () => { encodings?: Array<Record<string, unknown>>; degradationPreference?: string };
          setParameters?: (parameters: unknown) => Promise<void>;
        };
        if (track.kind !== "video" || !sender.getParameters || !sender.setParameters) return;
        try {
          const capabilities = RTCRtpSender.getCapabilities("video");
          const transceiver = connection.getTransceivers().find(
            (candidate) => candidate.sender.id === sender.id,
          );
          if (capabilities && transceiver) {
            transceiver.setCodecPreferences(preferVp8VideoCodec(capabilities.codecs));
          }
        } catch {
          // Codec preferences are an optimization; negotiation can use platform defaults.
        }
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
    } catch (error) {
      if (connectionRef.current === connection) connectionRef.current = null;
      connection.close();
      throw error;
    }
    const events = connection as unknown as NativeConnectionEvents;
    events.ontrack = (event) => {
      if (connectionRef.current !== connection) return;
      const tracks = [...(event.streams[0]?.getTracks() ?? [])];
      if (event.track && !tracks.some((track) => track.id === event.track?.id)) {
        tracks.push(event.track);
      }
      for (const track of tracks) {
        if (!remoteMediaStream.getTracks().some((candidate) => candidate.id === track.id)) {
          remoteMediaStream.addTrack(track);
        }
      }
      if (remoteMediaStream.getVideoTracks().length > 0) {
        setTimeout(() => {
          if (remoteFallbackStreamRef.current === remoteMediaStream) {
            setRemoteStream(remoteMediaStream);
          }
        }, 0);
      }
    };
    events.onicecandidate = (event) => {
      if (!event.candidate || connectionRef.current !== connection) return;
      void sendCandidate({
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid ?? undefined,
        sdpMLineIndex: event.candidate.sdpMLineIndex ?? undefined,
        usernameFragment: event.candidate.usernameFragment ?? undefined,
        negotiationRevision: negotiationRevisionRef.current,
      }).catch((candidateError) => {
        if (!isStaleNegotiationError(candidateError)) {
          setError(tError(candidateError, "Could not send network details."));
        }
      });
    };
    const handleConnectionState = () => {
      if (connectionRef.current !== connection) return;
      const state = connection.connectionState;
      if (state === "connected") {
        if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
        setConnectionStatus("connected");
        setError(null);
        return;
      }
      if (state !== "disconnected" && state !== "failed") return;
      setConnectionStatus("reconnecting");
      if (state === "failed" && !relayAvailableRef.current) {
        setError(t("No relay server is configured. This network may block the video connection."));
      }
      if (recoveryTimerRef.current) return;
      recoveryTimerRef.current = setTimeout(() => {
        recoveryTimerRef.current = null;
        const call = watchRef.current?.call;
        if (
          connectionRef.current !== connection
          || !call
          || call.status !== "active"
          || !isCallOwnedByDevice(call, currentUserId, deviceId, locallyOwnedCallIdRef.current)
        ) return;
        void retryCallOperation(() => requestIceRestart({ callId: call._id, deviceId }))
          .catch((restartError) => setError(tError(restartError, "Could not restore the call connection.")));
      }, state === "failed" ? 0 : 4_000);
    };
    events.onconnectionstatechange = handleConnectionState;
    events.oniceconnectionstatechange = handleConnectionState;
    return connection;
  };

  useEffect(() => {
    if (activeCall === null) {
      const resolvedNativeCallId = nativeCallIdRef.current;
      resolvedElsewhereCallIdRef.current = null;
      if (callIdRef.current) {
        teardown(false);
        if (resolvedNativeCallId) {
          void dismissResolvedIncomingCall(resolvedNativeCallId, "ended");
        }
      }
      return;
    }

    if (isCallOnAnotherDevice) {
      if (resolvedElsewhereCallIdRef.current !== activeCall._id) {
        resolvedElsewhereCallIdRef.current = activeCall._id;
        teardown(false);
      }
      return;
    }

    resolvedElsewhereCallIdRef.current = null;
    callIdRef.current = activeCall._id;
    remoteUserIdRef.current = activeCall.callerId === currentUserId ? activeCall.calleeId : activeCall.callerId;
  }, [activeCall, currentUserId, isCallOnAnotherDevice]);

  const declineIncomingCall = async (call: CallSnapshot["call"] = incomingCall) => {
    if (!call || call.status !== "ringing" || call.calleeId !== currentUserId) return;
    const claimedForegroundCall = call.nativeCallId
      ? claimIncomingCallInApp(call.nativeCallId)
      : false;
    setBusy(true); setError(null);
    try { await declineCall({ callId: call._id, deviceId }); }
    catch (callError) {
      if (
        claimedForegroundCall
        && call.nativeCallId
        && watchRef.current?.call?._id === call._id
        && watchRef.current.call.status === "ringing"
      ) {
        void resumeIncomingCallAlert({
          callId: call._id,
          familyId,
          nativeCallId: call.nativeCallId,
          callerName: memberLabel(members.find((member) => member.userId === call.callerId)),
        }).catch(() => undefined);
      }
      setError(tError(callError, "Could not decline the call."));
    }
    finally { setBusy(false); }
  };

  useEffect(() => {
    const generation = callGenerationRef.current;
    const connection = connectionRef.current;
    const sync = async () => {
      if (
        !activeCall ||
        !isOwnedCall ||
        !connection ||
        generation !== callGenerationRef.current ||
        connectionRef.current !== connection ||
        callIdRef.current !== activeCall._id
      ) return;
      if (activeCall.status === "active" && activeCall.callerId === currentUserId && activeCall.answerSdp && answeredCallIdRef.current !== activeCall._id) {
        answeredCallIdRef.current = activeCall._id;
        try {
          await connection.setRemoteDescription(parseDescription(activeCall.answerSdp));
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
          const configurable = connection as unknown as {
            setConfiguration?: (configuration: { iceServers: typeof credentials.iceServers }) => void;
          };
          configurable.setConfiguration?.({ iceServers: credentials.iceServers });
        } catch (restartError) {
          preparedRestartRevisionRef.current = revision - 1;
          throw restartError;
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
          const recoverable = connection as unknown as {
            restartIce?: () => void;
            createOffer: (options?: { iceRestart?: boolean }) => Promise<{ type: "offer"; sdp: string }>;
          };
          recoverable.restartIce?.();
          const offer = await recoverable.createOffer({ iceRestart: true });
          await connection.setLocalDescription(offer);
          await retryCallOperation(() => submitIceRestartOffer({
            callId: activeCall._id,
            deviceId,
            offerSdp: serializeDescription(connection.localDescription ?? offer),
            revision,
          }));
        } catch (restartError) {
          restartOfferRevisionRef.current = revision - 1;
          throw restartError;
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
        } catch (restartError) {
          restartAnswerRevisionRef.current = revision - 1;
          throw restartError;
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
        } catch (restartError) {
          restartAnswerRevisionRef.current = revision - 1;
          throw restartError;
        }
      }
      if (generation !== callGenerationRef.current || connectionRef.current !== connection) return;
      await flushRemoteCandidates();
    };
    const queuedSync = syncQueueRef.current.catch(() => undefined).then(sync);
    syncQueueRef.current = queuedSync;
    void queuedSync.catch((syncError) => setError(tError(syncError, "Could not sync call state.")));
  }, [activeCall, callState, currentUserId, isOwnedCall]);

  useEffect(() => {
    if (
      activeCall?.status !== "active"
      || !isOwnedCall
      || remoteVideoReady
      || stalledConnectionTimerRef.current
    ) return;

    stalledConnectionTimerRef.current = setTimeout(() => {
      stalledConnectionTimerRef.current = null;
      const call = watchRef.current?.call;
      if (
        !call
        || call.status !== "active"
        || !isCallOwnedByDevice(call, currentUserId, deviceId, locallyOwnedCallIdRef.current)
      ) return;
      setConnectionStatus("reconnecting");
      setRemoteVideoRenderRevision((revision) => revision + 1);
      void retryCallOperation(() => requestIceRestart({ callId: call._id, deviceId }))
        .catch((restartError) => setError(tError(restartError, "Could not restore the call connection.")));
    }, connectionStatus === "connecting" ? 12_000 : connectionStatus === "connected" ? 6_000 : 10_000);

    return () => {
      if (stalledConnectionTimerRef.current) clearTimeout(stalledConnectionTimerRef.current);
      stalledConnectionTimerRef.current = null;
    };
  }, [activeCall?._id, activeCall?.iceRestartRevision, activeCall?.status, connectionStatus, currentUserId, deviceId, isOwnedCall, remoteVideoReady, requestIceRestart, tError]);

  const markRemoteVideoReady = () => {
    if (remoteVideoReadyRef.current || !connectionRef.current) return;
    remoteVideoReadyRef.current = true;
    setRemoteVideoReady(true);
    setConnectionStatus("connected");
    setError(null);
  };

  useEffect(() => () => teardown(), []);

  const beginCall = async (calleeId: Id<"users">) => {
    const generation = callGenerationRef.current;
    setBusy(true); setError(null);
    try {
      const connection = await createConnection(calleeId);
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
      callIdRef.current = callId;
      locallyOwnedCallIdRef.current = callId;
      setLocallyOwnedCallId(callId);
      await flushPendingCandidates();
    } catch (callError) {
      if (generation !== callGenerationRef.current) return;
      teardown(); setError(tError(callError, "Could not start the call."));
    } finally {
      if (generation === callGenerationRef.current) setBusy(false);
    }
  };

  const acceptCall = async (call: CallSnapshot["call"] = incomingCall) => {
    if (!call || call.status !== "ringing" || call.calleeId !== currentUserId) return;
    if (acceptingCallIdRef.current === call._id || answeredCallIdRef.current === call._id) return;
    acceptingCallIdRef.current = call._id;
    callIdRef.current = call._id;
    const claimedForegroundCall = call.nativeCallId
      ? claimIncomingCallInApp(call.nativeCallId)
      : false;
    setAnsweringCallId(call._id);
    const generation = callGenerationRef.current;
    let answeredOnServer = false;
    setBusy(true); setError(null);
    try {
      const connection = await createConnection(call.callerId);
      if (generation !== callGenerationRef.current) return;
      await connection.setRemoteDescription(parseDescription(call.offerSdp));
      if (generation !== callGenerationRef.current) return;
      await flushRemoteCandidates();
      if (generation !== callGenerationRef.current) return;
      const answer = await connection.createAnswer();
      if (generation !== callGenerationRef.current) return;
      await connection.setLocalDescription(answer);
      if (generation !== callGenerationRef.current) return;
      await answerCall({
        callId: call._id,
        deviceId,
        answerSdp: serializeDescription(connection.localDescription ?? answer),
      });
      answeredOnServer = true;
      if (generation !== callGenerationRef.current) return;
      locallyOwnedCallIdRef.current = call._id;
      setLocallyOwnedCallId(call._id);
      if (call.nativeCallId) markNativeCallActive(call.nativeCallId);
      else bringCallAppToForeground();
      answeredCallIdRef.current = call._id;
      await flushPendingCandidates();
      if (generation !== callGenerationRef.current) return;
      await flushRemoteCandidates();
    } catch (callError) {
      if (generation !== callGenerationRef.current) return;
      if (answeredOnServer) {
        try {
          await endCall({ callId: call._id, deviceId });
        } catch {
          // The stale-call expiry job remains the final fallback if the network is gone.
        }
        if (generation !== callGenerationRef.current) return;
      }
      const wasAnsweredElsewhere =
        !answeredOnServer
        && callError instanceof Error
        && /no longer ringing/i.test(callError.message);
      teardown(!wasAnsweredElsewhere);
      if (wasAnsweredElsewhere && call.nativeCallId) {
        resolvedNativeCallIdRef.current = call.nativeCallId;
        void dismissResolvedIncomingCall(call.nativeCallId, "answered");
      }
      if (
        !answeredOnServer
        && claimedForegroundCall
        && call.nativeCallId
        && watchRef.current?.call?._id === call._id
        && watchRef.current.call.status === "ringing"
      ) {
        void resumeIncomingCallAlert({
          callId: call._id,
          familyId,
          nativeCallId: call.nativeCallId,
          callerName: memberLabel(members.find((member) => member.userId === call.callerId)),
        }).catch(() => undefined);
      }
      setError(
        wasAnsweredElsewhere
          ? null
          : callError instanceof Error
            ? tError(callError, "Could not answer the call.")
            : t("Could not answer the call."),
      );
    } finally {
      if (acceptingCallIdRef.current === call._id) acceptingCallIdRef.current = null;
      if (generation === callGenerationRef.current) setBusy(false);
    }
  };

  useEffect(() => {
    const call = incomingCall;
    if (
      !call
      || !canOfferAutoAnswer(autoAnswerCalls, appState)
      || call.autoAnswerOfferedByDeviceId !== undefined
    ) return;

    const timeout = setTimeout(() => {
      const currentCall = watchRef.current?.call;
      if (
        !canOfferAutoAnswer(autoAnswerCalls, AppState.currentState)
        || currentCall?._id !== call._id
        || currentCall.status !== "ringing"
        || currentCall.calleeId !== currentUserId
        || currentCall.autoAnswerOfferedByDeviceId !== undefined
      ) return;

      void offerAutoAnswer({ callId: call._id, deviceId })
        .then((offered) => {
          if (!offered) return;
          const currentCallAfterOffer = watchRef.current?.call;
          if (
            canOfferAutoAnswer(autoAnswerCalls, AppState.currentState)
            && currentCallAfterOffer?._id === call._id
            && currentCallAfterOffer.status === "ringing"
          ) {
            autoAnswerOfferCallIdRef.current = call._id;
            return;
          }
          void revokeAutoAnswerOffer({ callId: call._id, deviceId }).catch(
            () => undefined,
          );
        })
        .catch((offerError) => {
          setError(tError(offerError, "Could not make automatic answering available."));
        });
    }, AUTO_ANSWER_DELAY_MS);

    return () => clearTimeout(timeout);
  }, [
    appState,
    autoAnswerCalls,
    currentUserId,
    deviceId,
    incomingCall?._id,
    incomingCall?.autoAnswerOfferedByDeviceId,
    offerAutoAnswer,
    revokeAutoAnswerOffer,
  ]);

  useEffect(() => {
    const call = incomingCall;
    if (
      call?.autoAnswerOfferedByDeviceId === deviceId
      && canOfferAutoAnswer(autoAnswerCalls, appState)
    ) {
      autoAnswerOfferCallIdRef.current = call._id;
      return;
    }

    const offeredCallId = autoAnswerOfferCallIdRef.current;
    if (!offeredCallId) return;
    autoAnswerOfferCallIdRef.current = null;
    void revokeAutoAnswerOffer({ callId: offeredCallId, deviceId }).catch(
      () => undefined,
    );
  }, [
    appState,
    autoAnswerCalls,
    deviceId,
    incomingCall?._id,
    incomingCall?.autoAnswerOfferedByDeviceId,
    revokeAutoAnswerOffer,
  ]);

  useEffect(() => () => {
    const offeredCallId = autoAnswerOfferCallIdRef.current;
    if (!offeredCallId) return;
    autoAnswerOfferCallIdRef.current = null;
    void revokeAutoAnswerOffer({ callId: offeredCallId, deviceId }).catch(
      () => undefined,
    );
  }, [deviceId, revokeAutoAnswerOffer]);

  useEffect(() => {
    const call = incomingCall;
    if (
      !call
      || !shouldAcceptAutoAnswer(
        autoAnswerCalls,
        appState,
        deviceId,
        call.autoAnswerOfferedByDeviceId,
        call.autoAnswerRequestedAt,
      )
      || AppState.currentState !== "active"
    ) return;
    void acceptCall(call);
  }, [
    appState,
    autoAnswerCalls,
    deviceId,
    incomingCall?._id,
    incomingCall?.autoAnswerOfferedByDeviceId,
    incomingCall?.autoAnswerRequestedAt,
  ]);

  useEffect(() => {
    void initializeNativeCallService().catch((setupError) => {
      setError(tError(setupError, "Could not set up native calling."));
    });

    return setNativeCallHandlers({
      onAnswer: (callId, nativeFamilyId) => {
        if (nativeFamilyId && nativeFamilyId !== familyId) {
          onSelectFamily(nativeFamilyId);
          return false;
        }
        const snapshot = watchRef.current;
        if (snapshot === undefined) return false;
        const call = snapshot.call;
        if (call?._id === callId && call.status === "ringing" && call.calleeId === currentUserId) {
          void acceptCall(call);
          return true;
        }
        if (call?._id === callId && call.status === "active") {
          const ownsCall = isCallOwnedByDevice(
            call,
            currentUserId,
            deviceId,
            locallyOwnedCallIdRef.current,
          );
          if (
            !ownsCall
            && call.nativeCallId
            && resolvedNativeCallIdRef.current !== call.nativeCallId
          ) {
            resolvedNativeCallIdRef.current = call.nativeCallId;
            void dismissResolvedIncomingCall(call.nativeCallId, "answered");
          }
          return true;
        }
        return false;
      },
      onEnd: (callId, nativeFamilyId) => {
        if (nativeFamilyId && nativeFamilyId !== familyId) {
          onSelectFamily(nativeFamilyId);
          return false;
        }
        const snapshot = watchRef.current;
        if (snapshot === undefined) return false;
        const call = snapshot.call;
        if (!call || call._id !== callId) return true;
        if (call.status === "ringing" && call.calleeId === currentUserId) {
          void declineIncomingCall(call);
        } else if (
          isCallOwnedByDevice(
            call,
            currentUserId,
            deviceId,
            locallyOwnedCallIdRef.current,
          )
        ) {
          void hangUp(call);
        } else if (
          call.nativeCallId
          && resolvedNativeCallIdRef.current !== call.nativeCallId
        ) {
          resolvedNativeCallIdRef.current = call.nativeCallId;
          void dismissResolvedIncomingCall(call.nativeCallId, "answered");
        }
        return true;
      },
    });
  }, [currentUserId, deviceId, familyId, onSelectFamily]);

  useEffect(() => {
    const previousNativeCallId = nativeCallIdRef.current;
    const incomingNativeCallId =
      activeCall?.calleeId === currentUserId ? activeCall.nativeCallId : undefined;

    if (previousNativeCallId && previousNativeCallId !== incomingNativeCallId) {
      void dismissResolvedIncomingCall(previousNativeCallId, "ended");
      nativeCallIdRef.current = null;
    }

    if (!incomingNativeCallId || !activeCall) {
      nativeCallIdRef.current = null;
      resolvedNativeCallIdRef.current = null;
      return;
    }

    nativeCallIdRef.current = incomingNativeCallId;
    const callerName = memberLabel(remoteMember);
    if (activeCall.status === "ringing") {
      resolvedNativeCallIdRef.current = null;
      void showIncomingCall({ callId: activeCall._id, familyId, nativeCallId: incomingNativeCallId, callerName })
        .catch((callError) => setError(tError(callError, "Could not alert you to the incoming call.")));
    } else if (activeCall.status === "active") {
      if (isOwnedCall) {
        resolvedNativeCallIdRef.current = null;
        markNativeCallActive(incomingNativeCallId);
      } else {
        nativeCallIdRef.current = null;
        if (resolvedNativeCallIdRef.current !== incomingNativeCallId) {
          resolvedNativeCallIdRef.current = incomingNativeCallId;
          void dismissResolvedIncomingCall(incomingNativeCallId, "answered");
        }
      }
    }
  }, [activeCall, currentUserId, familyId, isOwnedCall, remoteMember]);

  const askForAutomaticAnswer = async () => {
    if (
      !activeCall
      || activeCall.status !== "ringing"
      || activeCall.callerId !== currentUserId
      || !isOwnedCall
    ) return;
    setBusy(true);
    setError(null);
    try {
      await requestAutoAnswer({ callId: activeCall._id, deviceId });
    } catch (requestError) {
      setError(tError(requestError, "Could not request automatic answering."));
    } finally {
      setBusy(false);
    }
  };

  const hangUp = async (call: CallSnapshot["call"] = activeCall) => {
    if (
      !call
      || !isCallOwnedByDevice(
        call,
        currentUserId,
        deviceId,
        locallyOwnedCallIdRef.current,
      )
    ) return;
    const isCanceling = call.status === "ringing" && call.callerId === currentUserId;
    setBusy(true); setError(null);
    try { await endCall({ callId: call._id, deviceId }); } catch (callError) {
      setError(tError(callError, isCanceling ? "Could not cancel the call." : "Could not end the call."));
    }
    finally { teardown(); setBusy(false); }
  };

  const isConnected = activeCall?.status === "active" && isOwnedCall;
  const isOutgoingCallAttempt =
    activeCall?.status === "ringing"
    && activeCall.callerId === currentUserId
    && isOwnedCall;
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
  const isShowingCallScreen =
    isConnected
    || answeringCallId !== null
    || (incomingCall !== null && !isCallOnAnotherDevice)
    || (seniorMode !== undefined && activeCall !== null && isOwnedCall);

  useLayoutEffect(() => {
    onCallSurfaceChange?.(isShowingCallScreen);
  }, [isShowingCallScreen, onCallSurfaceChange]);

  const isShowingIncomingPrompt = incomingCall !== null && answeringCallId === null;
  const callOnAnotherDeviceMessage =
    activeCall?.status === "active" && activeCall.calleeId === currentUserId
      ? t("Answered on another device.")
      : activeCall?.status === "ringing"
        ? t("This call was started on another device.")
        : t("This call is active on another device.");

  const localPreviewWidth = isTablet
    ? (isLandscape ? 210 : 168)
    : (isCompactLandscape ? 128 : 112);
  const localPreviewHeight = isTablet
    ? (isLandscape ? 148 : 224)
    : (isCompactLandscape ? 88 : 150);
  const embeddedVideoHeight = Math.max(
    180,
    Math.min(isTablet ? 360 : 280, Math.round(width * (isLandscape ? 0.42 : 0.62))),
  );
  const seniorHorizontalPadding = Math.max(insets.left + 20, 24)
    + Math.max(insets.right + 20, 24);
  const seniorLayout = getSeniorModeLayout({
    height,
    horizontalPadding: seniorHorizontalPadding,
    isLandscape,
    isTablet,
    memberCount: seniorModeMembers.length,
    reservedVerticalSpace: isCompactLandscape ? 180 : isTablet ? 230 : 210,
    width,
  });

  return <>
    <Modal
      animationType="fade"
      hardwareAccelerated
      navigationBarTranslucent
      onRequestClose={() => {
        if (busy) return;
        if (incomingCall) void declineIncomingCall();
        else void hangUp();
      }}
      presentationStyle="fullScreen"
      statusBarTranslucent
      supportedOrientations={[
        "portrait",
        "portrait-upside-down",
        "landscape",
        "landscape-left",
        "landscape-right",
      ]}
      visible={isShowingCallScreen}
    >
      <View style={styles.fullScreenCall}>
        {isConnected && remoteStream ? (
          <RTCView
            key={`${remoteStream.toURL()}-${remoteVideoRenderRevision}`}
            mirror={false}
            objectFit="cover"
            onDimensionsChange={({ nativeEvent }) => {
              if (nativeEvent.width > 0 && nativeEvent.height > 0) markRemoteVideoReady();
            }}
            streamURL={remoteStream.toURL()}
            style={styles.fullScreenVideo}
            zOrder={0}
          />
        ) : (
          <View style={styles.fullScreenBackdrop} />
        )}

        {isShowingIncomingPrompt ? (
          <ScrollView
            bounces={false}
            contentContainerStyle={[
              styles.callPromptScroll,
              {
                minHeight: height,
                paddingBottom: Math.max(insets.bottom + 18, 24),
                paddingLeft: Math.max(insets.left + 18, 24),
                paddingRight: Math.max(insets.right + 18, 24),
                paddingTop: Math.max(insets.top + 18, 24),
              },
            ]}
            style={StyleSheet.absoluteFill}
          >
            <View style={[styles.callPrompt, isCompactLandscape && styles.callPromptCompact]}>
              <MemberAvatar
                image={remoteMember?.image}
                label={memberLabel(remoteMember)}
                size={isCompactLandscape ? 64 : 88}
              />
              <Text style={styles.callPromptKicker}>{t("INCOMING FAMILY CALL")}</Text>
              <Text accessibilityRole="header" style={[styles.callPromptTitle, isCompactLandscape && styles.callPromptTitleCompact]}>
                {t("{name} is calling", { name: memberLabel(remoteMember) })}
              </Text>
              <Text style={styles.callPromptText}>{t("Answer to start your private video call.")}</Text>
              {error ? <Text accessibilityLiveRegion="assertive" style={styles.callModalErrorText}>{error}</Text> : null}
              <View style={styles.callPromptActions}>
                <Action label={t("Answer")} onPress={() => void acceptCall()} disabled={busy} />
                <Action label={t("Decline")} onPress={() => void declineIncomingCall()} disabled={busy} secondary />
              </View>
              {busy ? <ActivityIndicator color="#bae6fd" /> : null}
            </View>
          </ScrollView>
        ) : !isConnected || !remoteStream ? (
          <ScrollView
            bounces={false}
            contentContainerStyle={[
              styles.connectingCall,
              {
                minHeight: height,
                paddingBottom: Math.max(insets.bottom + 24, 32),
                paddingLeft: Math.max(insets.left + 24, 24),
                paddingRight: Math.max(insets.right + 24, 24),
                paddingTop: Math.max(insets.top + 24, 32),
              },
            ]}
            style={StyleSheet.absoluteFill}
          >
            <MemberAvatar
              image={remoteMember?.image}
              label={memberLabel(remoteMember)}
              size={72}
            />
            <ActivityIndicator color="#bae6fd" size="large" />
            <Text accessibilityLiveRegion="polite" style={styles.waiting}>
              {connectionStatus === "reconnecting"
                ? t("Restoring the video connection…")
                : t("Connecting video to {name}…", { name: memberLabel(remoteMember) })}
            </Text>
            {canRequestAutoAnswer ? (
              <View style={styles.autoAnswerAction}>
                <Text style={styles.autoAnswerText}>
                  {t("No answer yet. This device allows you to connect automatically.")}
                </Text>
                <Action
                  disabled={busy}
                  label={t("Connect automatically")}
                  onPress={() => void askForAutomaticAnswer()}
                />
              </View>
            ) : null}
            {automaticAnswerRequested ? (
              <Text accessibilityLiveRegion="polite" style={styles.autoAnswerText}>
                {t("Automatic answering requested. Waiting for the other device to connect…")}
              </Text>
            ) : null}
            {isOutgoingCallAttempt ? (
              <Action
                danger
                disabled={busy}
                label={t("Cancel call")}
                onPress={() => void hangUp()}
              />
            ) : null}
            {error ? <Text accessibilityLiveRegion="assertive" style={styles.callModalErrorText}>{error}</Text> : null}
          </ScrollView>
        ) : null}

        {isConnected && remoteStream && error ? (
          <View
            accessibilityLiveRegion="assertive"
            style={[
              styles.fullScreenError,
              {
                left: Math.max(insets.left + 16, 20),
                top: Math.max(insets.top + 16, 20),
                width: Math.max(180, Math.min(520, width - localPreviewWidth - 56)),
              },
            ]}
          >
            <Text style={styles.fullScreenErrorText}>{error}</Text>
          </View>
        ) : null}

        {isConnected && localStream ? (
          <View
            style={[
              styles.fullScreenLocal,
              {
                height: localPreviewHeight,
                right: Math.max(insets.right + 14, 18),
                top: Math.max(insets.top + 14, 18),
                width: localPreviewWidth,
              },
            ]}
          >
            <RTCView mirror objectFit="cover" streamURL={localStream.toURL()} style={styles.rtcView} zOrder={1} />
          </View>
        ) : null}
        {isConnected ? (
          <View
            style={[
              styles.fullScreenControls,
              {
                bottom: Math.max(insets.bottom + 16, 24),
                left: Math.max(insets.left + 20, 24),
                right: Math.max(insets.right + 20, 24),
              },
            ]}
          >
            <View style={styles.fullScreenControlInner}>
              <Action danger disabled={busy} label={t("End call")} onPress={() => void hangUp()} />
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  {seniorMode ? (
    <View style={styles.seniorScreen}>
      <ScrollView
        bounces={false}
        contentContainerStyle={[
          styles.seniorContent,
          {
            minHeight: height,
            paddingBottom: Math.max(
              insets.bottom + (isCompactLandscape ? 12 : 24),
              isCompactLandscape ? 18 : 32,
            ),
            paddingLeft: Math.max(insets.left + 20, 24),
            paddingRight: Math.max(insets.right + 20, 24),
            paddingTop: Math.max(
              insets.top + (isCompactLandscape ? 12 : 24),
              isCompactLandscape ? 18 : 32,
            ),
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <SeniorClock compact={isCompactLandscape} tablet={isTablet} />
        <View style={styles.seniorGrid}>
          {seniorModeMembers.map((member) => {
            const label = memberLabel(member);
            return (
              <Pressable
                accessibilityHint={t("Starts a video call")}
                accessibilityLabel={t("Call {name}", { name: label })}
                accessibilityRole="button"
                disabled={busy || activeCall !== null}
                key={member.userId}
                onPress={() => void beginCall(member.userId)}
                style={({ pressed }) => [
                  styles.seniorMember,
                  { width: seniorLayout.tileWidth },
                  pressed && styles.seniorMemberPressed,
                  (busy || activeCall !== null) && styles.disabled,
                ]}
              >
                <MemberAvatar
                  image={member.image}
                  label={label}
                  size={seniorLayout.avatarSize}
                />
                <Text numberOfLines={2} style={styles.seniorMemberName}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
        {missedCalls && missedCalls.length > 0 ? (
          <View style={styles.seniorMissedCalls}>
            <Text style={styles.seniorMissedCallsTitle}>{t("Missed calls")}</Text>
            {missedCalls.slice(0, 3).map((missedCall) => {
              const member = members.find((candidate) => candidate.userId === missedCall.callerId);
              const label = memberLabel(member ?? {
                email: missedCall.caller.email,
                image: null,
                name: missedCall.caller.name,
                userId: missedCall.callerId,
              });
              return (
                <View key={missedCall._id} style={styles.seniorMissedCallRow}>
                  <MemberAvatar image={member?.image ?? null} label={label} size={48} />
                  <View style={styles.missedCallText}>
                    <Text style={styles.seniorMissedCallName}>
                      {t("Missed call from {name}", { name: label })}
                    </Text>
                    <Text style={styles.seniorMissedCallTime}>
                      {formatCallTime(missedCall.missedAt, language)}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>
        ) : null}
        {isCallOnAnotherDevice ? (
          <Text accessibilityLiveRegion="polite" style={styles.seniorMessage}>
            {callOnAnotherDeviceMessage}
          </Text>
        ) : null}
        {error ? (
          <Text accessibilityLiveRegion="assertive" style={styles.seniorError}>{error}</Text>
        ) : null}
        {busy ? <ActivityIndicator color="#fbbf24" size="large" /> : null}
      </ScrollView>
      <Pressable
        accessibilityHint={t("Keep holding, then confirm, to return to the regular app")}
        accessibilityLabel={t("Exit Senior mode")}
        accessibilityRole="button"
        delayLongPress={5_000}
        onLongPress={seniorMode.onExitRequest}
        style={[
          styles.seniorExitTarget,
          {
            right: Math.max(insets.right, 0),
            top: Math.max(insets.top, 0),
          },
        ]}
      />
    </View>
  ) : (
    <View style={[styles.panel, isCompactLandscape && styles.panelCompact]}>
      <Text style={styles.kicker}>{t("FAMILY CALLS")}</Text>
      <Text style={styles.title}>{isCallOnAnotherDevice ? t("Call in progress") : activeCall ? t("Calling {name}", { name: memberLabel(remoteMember) }) : t("Face-to-face check-ins")}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {activeCall === null && missedCalls && missedCalls.length > 0 ? (
        <View style={styles.missedCalls}>
          <Text style={styles.missedCallsTitle}>{t("Missed calls")}</Text>
          {missedCalls.map((missedCall) => {
            const member = members.find((candidate) => candidate.userId === missedCall.callerId);
            const label = memberLabel(member ?? {
              email: missedCall.caller.email,
              image: null,
              name: missedCall.caller.name,
              userId: missedCall.callerId,
            });
            return (
              <View
                accessibilityLabel={`${t("Missed call from {name}", { name: label })}, ${formatCallTime(missedCall.missedAt, language)}`}
                accessible
                key={missedCall._id}
                style={styles.missedCallRow}
              >
                <MemberAvatar image={member?.image ?? null} label={label} size={38} />
                <View style={styles.missedCallText}>
                  <Text style={styles.missedCallName}>{t("Missed call from {name}", { name: label })}</Text>
                  <Text style={styles.missedCallTime}>{formatCallTime(missedCall.missedAt, language)}</Text>
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
      {isCallOnAnotherDevice ? <View style={styles.resolvedElsewhere}><Text style={styles.resolvedElsewhereText}>{callOnAnotherDeviceMessage}</Text></View> : activeCall && isOwnedCall && !isConnected ? <>
        <View style={[styles.videoGrid, { height: embeddedVideoHeight }]}>
          <View style={styles.video}>{remoteStream ? <RTCView key={`${remoteStream.toURL()}-${remoteVideoRenderRevision}`} mirror={false} objectFit="cover" onDimensionsChange={({ nativeEvent }) => { if (nativeEvent.width > 0 && nativeEvent.height > 0) markRemoteVideoReady(); }} streamURL={remoteStream.toURL()} style={styles.rtcView} zOrder={0} /> : <Text style={styles.waiting}>{t("Waiting for {name}…", { name: memberLabel(remoteMember) })}</Text>}</View>
          <View style={styles.localVideo}>{localStream ? <RTCView mirror objectFit="cover" streamURL={localStream.toURL()} style={styles.rtcView} zOrder={1} /> : null}</View>
        </View>
        {canRequestAutoAnswer ? (
          <View style={styles.autoAnswerAction}>
            <Text style={styles.autoAnswerText}>
              {t("No answer yet. This device allows you to connect automatically.")}
            </Text>
            <Action
              disabled={busy}
              label={t("Connect automatically")}
              onPress={() => void askForAutomaticAnswer()}
            />
          </View>
        ) : null}
        {automaticAnswerRequested ? (
          <Text accessibilityLiveRegion="polite" style={styles.autoAnswerText}>
            {t("Automatic answering requested. Waiting for the other device to connect…")}
          </Text>
        ) : null}
        <Action label={t(isOutgoingCallAttempt ? "Cancel call" : "Hang up")} onPress={() => void hangUp()} disabled={busy} danger />
      </> : !incomingCall ? <View style={styles.members}>{callableMembers.length === 0 ? <Text style={styles.waiting}>{t("Add another family member to start a call.")}</Text> : callableMembers.map((member) => <Action avatar={{ image: member.image, label: memberLabel(member) }} key={member.userId} label={t("Call {name}", { name: memberLabel(member) })} onPress={() => void beginCall(member.userId)} disabled={busy} />)}</View> : null}
      {busy ? <ActivityIndicator color="#bae6fd" style={styles.spinner} /> : null}
    </View>
  )}
  </>;
}

function Action({ avatar, label, onPress, disabled, secondary, danger }: { avatar?: { image: string | null; label: string }; label: string; onPress: () => void; disabled?: boolean; secondary?: boolean; danger?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary ? styles.secondaryButton : danger ? styles.dangerButton : styles.primaryButton,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      {avatar ? <MemberAvatar image={avatar.image} label={avatar.label} size={32} /> : null}
      <Text style={secondary ? styles.secondaryText : styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  seniorScreen: {
    backgroundColor: "#111111",
    flex: 1,
  },
  seniorContent: {
    alignItems: "center",
    flexGrow: 1,
    gap: 22,
    justifyContent: "center",
  },
  seniorGrid: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 20,
    justifyContent: "center",
    width: "100%",
  },
  seniorMember: {
    alignItems: "center",
    backgroundColor: "#1c1917",
    borderColor: "#fbbf24",
    borderRadius: 30,
    borderWidth: 2,
    elevation: 8,
    gap: 16,
    justifyContent: "center",
    minHeight: 210,
    padding: 16,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 14,
  },
  seniorMemberPressed: {
    opacity: 0.78,
    transform: [{ scale: 0.98 }],
  },
  seniorMemberName: {
    color: "#fafaf9",
    fontSize: 28,
    fontWeight: "700",
    lineHeight: 34,
    textAlign: "center",
  },
  seniorMessage: {
    color: "#fef3c7",
    fontSize: 18,
    fontWeight: "600",
    lineHeight: 25,
    textAlign: "center",
  },
  seniorError: {
    backgroundColor: "#4c0519",
    borderColor: "#fb7185",
    borderRadius: 16,
    borderWidth: 1,
    color: "#ffe4e6",
    fontSize: 16,
    lineHeight: 23,
    maxWidth: 620,
    padding: 14,
    textAlign: "center",
  },
  seniorExitTarget: {
    height: 64,
    opacity: 0.01,
    position: "absolute",
    width: 64,
  },
  autoAnswerAction: {
    alignSelf: "center",
    backgroundColor: "#0c4a6e",
    borderColor: "#38bdf8",
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
    maxWidth: 520,
    padding: 14,
    width: "100%",
  },
  autoAnswerText: {
    color: "#e0f2fe",
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
  },
  panel: {
    backgroundColor: "#082f49",
    borderColor: "#0ea5e9",
    borderRadius: 24,
    borderWidth: 1,
    gap: 12,
    padding: 18,
  },
  panelCompact: {
    padding: 14,
  },
  fullScreenCall: {
    alignItems: "center",
    backgroundColor: "#020617",
    flex: 1,
    justifyContent: "center",
  },
  fullScreenBackdrop: {
    backgroundColor: "#020617",
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  fullScreenVideo: {
    height: "100%",
    width: "100%",
  },
  fullScreenLocal: {
    backgroundColor: "#0f172a",
    borderColor: "#e0f2fe",
    borderRadius: 14,
    borderWidth: 1,
    elevation: 8,
    overflow: "hidden",
    position: "absolute",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 10,
  },
  fullScreenControls: {
    alignItems: "center",
    position: "absolute",
  },
  fullScreenControlInner: {
    maxWidth: 420,
    width: "100%",
  },
  fullScreenError: {
    backgroundColor: "rgba(76, 5, 25, 0.94)",
    borderColor: "#fb7185",
    borderRadius: 14,
    borderWidth: 1,
    elevation: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    position: "absolute",
    zIndex: 3,
  },
  fullScreenErrorText: {
    color: "#ffe4e6",
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 20,
  },
  connectingCall: {
    alignItems: "center",
    flexGrow: 1,
    gap: 14,
    justifyContent: "center",
  },
  callPromptScroll: {
    alignItems: "center",
    flexGrow: 1,
    justifyContent: "center",
  },
  callPrompt: {
    alignSelf: "center",
    backgroundColor: "rgba(8, 47, 73, 0.97)",
    borderColor: "#38bdf8",
    borderRadius: 26,
    borderWidth: 1,
    gap: 14,
    maxWidth: 520,
    padding: 24,
    width: "100%",
  },
  callPromptCompact: {
    gap: 9,
    maxWidth: 620,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  callPromptKicker: {
    color: "#bae6fd",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 2,
    textAlign: "center",
  },
  callPromptTitle: {
    color: "#f8fafc",
    fontSize: 30,
    fontWeight: "700",
    lineHeight: 36,
    textAlign: "center",
  },
  callPromptTitleCompact: {
    fontSize: 24,
    lineHeight: 29,
  },
  callPromptText: {
    color: "#cbd5e1",
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
  },
  callModalErrorText: {
    color: "#fecdd3",
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 20,
    textAlign: "center",
  },
  callPromptActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  kicker: {
    color: "#bae6fd",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 2,
  },
  title: {
    color: "#f8fafc",
    fontSize: 21,
    fontWeight: "700",
    lineHeight: 27,
  },
  error: {
    color: "#fecdd3",
    fontSize: 14,
    lineHeight: 20,
  },
  resolvedElsewhere: {
    backgroundColor: "#0c4a6e",
    borderColor: "#38bdf8",
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
  },
  resolvedElsewhereText: {
    color: "#e0f2fe",
    fontSize: 15,
    textAlign: "center",
  },
  members: {
    gap: 10,
  },
  seniorMissedCalls: {
    backgroundColor: "#1c1917",
    borderColor: "#78716c",
    borderRadius: 22,
    borderWidth: 1,
    gap: 12,
    maxWidth: 620,
    padding: 16,
    width: "100%",
  },
  seniorMissedCallsTitle: {
    color: "#fbbf24",
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
  },
  seniorMissedCallRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  seniorMissedCallName: {
    color: "#fafaf9",
    fontSize: 18,
    fontWeight: "700",
  },
  seniorMissedCallTime: {
    color: "#d6d3d1",
    fontSize: 16,
    marginTop: 2,
  },
  missedCalls: {
    backgroundColor: "#0c4a6e",
    borderColor: "#38bdf8",
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
    padding: 14,
  },
  missedCallsTitle: {
    color: "#e0f2fe",
    fontSize: 16,
    fontWeight: "700",
  },
  missedCallRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  missedCallText: {
    flex: 1,
  },
  missedCallName: {
    color: "#f8fafc",
    fontSize: 15,
    fontWeight: "600",
  },
  missedCallTime: {
    color: "#bae6fd",
    fontSize: 13,
    marginTop: 2,
  },
  button: {
    alignItems: "center",
    borderRadius: 14,
    flex: 1,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    minHeight: 50,
    minWidth: 120,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  primaryButton: {
    backgroundColor: "#7dd3fc",
  },
  secondaryButton: {
    borderColor: "#94a3b8",
    borderWidth: 1,
  },
  dangerButton: {
    backgroundColor: "#be123c",
  },
  buttonText: {
    color: "#082f49",
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center",
  },
  secondaryText: {
    color: "#e2e8f0",
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center",
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.8,
  },
  videoGrid: {
    backgroundColor: "#020617",
    borderRadius: 16,
    minHeight: 180,
    overflow: "hidden",
    position: "relative",
  },
  video: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  localVideo: {
    borderColor: "#e0f2fe",
    borderRadius: 12,
    borderWidth: 1,
    bottom: 10,
    height: 88,
    overflow: "hidden",
    position: "absolute",
    right: 10,
    width: 116,
  },
  rtcView: {
    flex: 1,
  },
  waiting: {
    color: "#cbd5e1",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  spinner: {
    marginTop: 4,
  },
});
