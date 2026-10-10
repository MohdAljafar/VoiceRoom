import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import Peer from "simple-peer";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

export default function App() {
  const socketRef = useRef(null);
  const streamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const peersRef = useRef(new Map());
  const audioContainerRef = useRef(null);
  const chunkSequenceRef = useRef(0);
  const pendingUploadsRef = useRef([]);
  const recordingSessionIdRef = useRef("");

  // Navigation & Mode
  const [screen, setScreen] = useState("home"); // "home" | "call"
  const [mode, setMode] = useState("create"); // "create" | "join"

  // Form State
  const [username, setUsername] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [consent, setConsent] = useState(false);

  // Call & WebRTC State
  const [roomId, setRoomId] = useState("");
  const [muted, setMuted] = useState(false);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [participants, setParticipants] = useState(1);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  // Analysis State
  const [showAnalysisLogin, setShowAnalysisLogin] = useState(false);
  const [analysisUsername, setAnalysisUsername] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState("");

  const normalizeUsername = (value) => value.trim().toLowerCase();
  const validUsername = (value) => USERNAME_RE.test(normalizeUsername(value));

  const removePeer = useCallback((peerId) => {
    const entry = peersRef.current.get(peerId);
    if (!entry) return;
    try {
      entry.peer.destroy();
    } catch {}
    if (entry.audio) {
      entry.audio.srcObject = null;
      entry.audio.remove();
    }
    peersRef.current.delete(peerId);
    setParticipants(peersRef.current.size + 1);
  }, []);

  const createPeer = useCallback(
    (peerId, initiator) => {
      if (peersRef.current.has(peerId)) return peersRef.current.get(peerId);
      if (!streamRef.current) return null;
      const peer = new Peer({
        initiator,
        trickle: true,
        stream: streamRef.current,
        config: { iceServers: ICE_SERVERS },
      });
      const entry = { peer, audio: null };
      peersRef.current.set(peerId, entry);
      setParticipants(peersRef.current.size + 1);
      peer.on("signal", (signal) =>
        socketRef.current?.emit("webrtc:signal", { to: peerId, signal }),
      );
      peer.on("stream", (remoteStream) => {
        const audio = document.createElement("audio");
        audio.autoplay = true;
        audio.playsInline = true;
        audio.srcObject = remoteStream;
        audioContainerRef.current?.appendChild(audio);
        entry.audio = audio;
        audio
          .play()
          .catch(() =>
            setStatus("Click anywhere on the page if you cannot hear remote audio."),
          );
      });
      peer.on("close", () => removePeer(peerId));
      peer.on("error", () => removePeer(peerId));
      return entry;
    },
    [removePeer],
  );

  const cleanupPeersAndMic = useCallback(() => {
    for (const [, entry] of peersRef.current) {
      try {
        entry.peer.destroy();
      } catch {}
      if (entry.audio) {
        entry.audio.srcObject = null;
        entry.audio.remove();
      }
    }
    peersRef.current.clear();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setParticipants(1);
    setMuted(false);
  }, []);

  useEffect(() => {
    const socket = io(SERVER_URL);
    socketRef.current = socket;
    socket.on("connect_error", () =>
      setError("Cannot reach voice server. Verify backend connectivity."),
    );
    socket.on("peer:joined", ({ peerId }) => createPeer(peerId, true));
    socket.on("webrtc:signal", ({ from, signal }) => {
      let entry = peersRef.current.get(from);
      if (!entry) entry = createPeer(from, false);
      if (entry && !entry.peer.destroyed) entry.peer.signal(signal);
    });
    socket.on("peer:left", ({ peerId }) => removePeer(peerId));

    return () => {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {}
      }
      cleanupPeersAndMic();
      socket.disconnect();
    };
  }, [cleanupPeersAndMic, createPeer, removePeer]);

  function startRecording(localStream) {
    if (!window.MediaRecorder)
      throw new Error("Audio recording is unsupported in this browser.");
    recordingSessionIdRef.current = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    chunkSequenceRef.current = 0;
    pendingUploadsRef.current = [];
    const options = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? { mimeType: "audio/webm;codecs=opus" }
      : {};
    const recorder = new MediaRecorder(localStream, options);
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      const sequence = chunkSequenceRef.current++;
      const uploadPromise = (async () => {
        const formData = new FormData();
        formData.append("username", normalizeUsername(username));
        formData.append("sessionId", recordingSessionIdRef.current);
        formData.append("sequence", String(sequence));
        formData.append("audio", event.data, `${sequence}.webm`);
        const response = await fetch(`${SERVER_URL}/api/recordings/chunk`, {
          method: "POST",
          body: formData,
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(result.error || `Chunk ${sequence} upload failed.`);
      })();
      pendingUploadsRef.current.push(uploadPromise);
      uploadPromise.catch((err) => {
        console.error("Audio chunk upload failed:", err);
        setStatus("Network hiccup during upload. Stay connected.");
      });
    };

    recorder.onerror = () => setStatus("Browser media recording alert.");
    recorder.start(10000);
    setRecording(true);
    setStatus("Microphone active & transmitting.");
  }

  async function saveRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recordingSessionIdRef.current) {
      setStatus("No active session detected.");
      return false;
    }
    setSaving(true);
    setStatus("Finalizing audio stream...");
    try {
      if (recorder && recorder.state !== "inactive") {
        await new Promise((resolve, reject) => {
          recorder.addEventListener("stop", resolve, { once: true });
          try {
            recorder.stop();
          } catch (e) {
            reject(e);
          }
        });
      }
      setRecording(false);
      const results = await Promise.allSettled(pendingUploadsRef.current);
      const failed = results.some((result) => result.status === "rejected");
      if (failed)
        throw new Error("Incomplete upload. Re-check network and exit again.");
      const totalChunks = chunkSequenceRef.current;
      if (totalChunks < 1)
        throw new Error("No speech recorded. Speak before leaving.");

      const response = await fetch(`${SERVER_URL}/api/recordings/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: normalizeUsername(username),
          sessionId: recordingSessionIdRef.current,
          totalChunks,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(result.error || "Recording finalization failed.");

      setStatus("Session saved successfully.");
      return true;
    } catch (err) {
      console.error("Save error:", err);
      setStatus(err.message || "Failed to persist audio recording.");
      return false;
    } finally {
      setSaving(false);
      mediaRecorderRef.current = null;
    }
  }

  async function joinRoom(targetRoomId) {
    setError("");
    const normalized = normalizeUsername(username);
    if (!validUsername(normalized)) {
      setError("Username must be 3–20 alphanumeric characters or underscores.");
      return;
    }
    setUsername(normalized);

    if (!consent) {
      setError("Audio recording consent is required to enter voice rooms.");
      return;
    }
    if (!socketRef.current?.connected) {
      setError("Signaling server disconnected. Please refresh and retry.");
      return;
    }

    let stream;
    try {
      setStatus("Requesting microphone authorization...");
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      streamRef.current = stream;

      socketRef.current.emit("room:join", { roomId: targetRoomId }, (result) => {
        if (!result?.ok) {
          stream.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
          setStatus("Ready");
          setError(result?.error || "Could not join voice session.");
          return;
        }
        setRoomId(result.roomId);
        setRoomInput(result.roomId);
        setScreen("call");
        setMuted(false);
        try {
          startRecording(stream);
        } catch (err) {
          setError(err.message || "Microphone recording initialization failed.");
        }
        setStatus("Connected to voice channel.");
        result.peers.forEach((peerId) => createPeer(peerId, false));
      });
    } catch (err) {
      stream?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStatus("Ready");
      setError(
        err.name === "NotAllowedError"
          ? "Microphone permission denied. Allow mic access in browser settings."
          : "Audio device unreadable. Make sure you are on HTTPS or localhost.",
      );
    }
  }

  function handleFormSubmit(e) {
    e.preventDefault();
    setError("");

    const normalized = normalizeUsername(username);
    if (!validUsername(normalized)) {
      setError("Username must be 3–20 characters (letters, numbers, underscores).");
      return;
    }

    if (!consent) {
      setError("You must acknowledge and agree to microphone recording.");
      return;
    }

    if (!socketRef.current?.connected) {
      setError("Connection to voice server is offline. Check backend.");
      return;
    }

    if (mode === "create") {
      socketRef.current.emit("room:create", (result) => {
        if (!result?.ok) {
          setError(result?.error || "Room generation failed.");
          return;
        }
        joinRoom(result.roomId);
      });
    } else {
      const cleanId = roomInput.trim().toUpperCase();
      if (!cleanId) {
        setError("Please enter the Room ID to connect.");
        return;
      }
      joinRoom(cleanId);
    }
  }

  function toggleMute() {
    const stream = streamRef.current;
    if (!stream) return;
    const nextMuted = !muted;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setMuted(nextMuted);
  }

  async function leaveCall() {
    if (saving) return;
    const saved = await saveRecording();
    if (!saved) return;
    socketRef.current?.emit("room:leave");
    cleanupPeersAndMic();
    setRoomId("");
    setRoomInput("");
    setScreen("home");
    setStatus("Session closed and saved.");
  }

  async function copyRoomId() {
    try {
      await navigator.clipboard.writeText(roomId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      setStatus("Room ID copied to clipboard.");
    } catch {
      setStatus(`Room ID: ${roomId}`);
    }
  }

  async function analyzeLatest(e) {
    e?.preventDefault();
    const requestedUsername = normalizeUsername(analysisUsername);
    setAnalysisError("");
    if (!validUsername(requestedUsername)) {
      setAnalysisError("Enter a valid username (3–20 lowercase alphanumeric).");
      return;
    }
    setAnalyzing(true);
    setAnalysis(null);
    try {
      const response = await fetch(
        `${SERVER_URL}/api/recordings/analyze-latest`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: requestedUsername }),
        },
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(result.error || "Unable to retrieve analysis.");
      let parsed = result.analysis;
      if (typeof parsed === "string") {
        parsed = parsed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        parsed = JSON.parse(parsed);
      }
      setAnalysis(parsed);
      setShowAnalysisLogin(false);
    } catch (err) {
      setAnalysisError(err.message || "Failed to analyze speech records.");
    } finally {
      setAnalyzing(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 font-sans text-slate-100 antialiased selection:bg-slate-700 selection:text-white">
      {/* Background Subtle Gradient & Structure */}
      <div className="relative mx-auto flex min-h-screen max-w-4xl flex-col justify-between px-4 py-8 sm:px-6 sm:py-12">
        {/* Top Header */}
        <header className="flex items-center justify-between border-b border-slate-800/80 pb-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-800 border border-slate-700/60 shadow-sm">
              <span className="font-semibold text-slate-200">VR</span>
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-tight text-white">
                Voice Room
              </h1>
              <p className="text-xs text-slate-400">
                Peer-to-peer conversational space
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-800 bg-slate-900/60 px-3 py-1 text-xs font-medium text-slate-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              WebRTC Audio
            </span>
          </div>
        </header>

        {/* Main Content Area */}
        <main className="my-auto py-8">
          {screen === "home" ? (
            <div className="mx-auto max-w-lg">
              {/* Primary Action Card */}
              <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-6 shadow-xl backdrop-blur-sm sm:p-8">
                {/* Intro Copy */}
                <div className="mb-6 text-center sm:text-left">
                  <h2 className="text-2xl font-bold tracking-tight text-white">
                    Start Speaking
                  </h2>
                  <p className="mt-1 text-sm text-slate-400">
                    Collaborate with peers to build fluency. No passwords needed.
                  </p>
                </div>

                {/* Segmented Control / Toggle Switch */}
                <div
                  role="tablist"
                  aria-label="Room Action Selection"
                  className="mb-6 grid grid-cols-2 rounded-xl bg-slate-950 p-1 border border-slate-800"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "create"}
                    onClick={() => {
                      setMode("create");
                      setError("");
                    }}
                    className={`flex items-center justify-center gap-2 rounded-lg py-2.5 text-xs font-semibold tracking-wide transition-all ${
                      mode === "create"
                        ? "bg-slate-800 text-white shadow-sm border border-slate-700/60"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    <svg
                      className="h-3.5 w-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 4v16m8-8H4"
                      />
                    </svg>
                    Create a room
                  </button>

                  <button
                    type="button"
                    role="tab"
                    aria-selected={mode === "join"}
                    onClick={() => {
                      setMode("join");
                      setError("");
                    }}
                    className={`flex items-center justify-center gap-2 rounded-lg py-2.5 text-xs font-semibold tracking-wide transition-all ${
                      mode === "join"
                        ? "bg-slate-800 text-white shadow-sm border border-slate-700/60"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    <svg
                      className="h-3.5 w-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1"
                      />
                    </svg>
                    Join a room
                  </button>
                </div>

                {/* Form Handling Both Scenarios */}
                <form onSubmit={handleFormSubmit} className="space-y-4">
                  {/* Field: Username (Both modes) */}
                  <div>
                    <label
                      htmlFor="username"
                      className="block text-xs font-medium uppercase tracking-wider text-slate-300"
                    >
                      Your Username
                    </label>
                    <input
                      id="username"
                      type="text"
                      className="mt-1.5 w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-500 outline-none transition focus:border-slate-600 focus:ring-1 focus:ring-slate-600"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="e.g. aljafar_01"
                      minLength={3}
                      maxLength={20}
                      autoComplete="username"
                    />
                    <p className="mt-1 text-[11px] text-slate-500">
                      3–20 lowercase characters, numbers, or underscores.
                    </p>
                  </div>

                  {/* Field: Room ID (Only Join Mode) */}
                  {mode === "join" && (
                    <div className="transition-all duration-150">
                      <label
                        htmlFor="roomId"
                        className="block text-xs font-medium uppercase tracking-wider text-slate-300"
                      >
                        Room ID
                      </label>
                      <input
                        id="roomId"
                        type="text"
                        className="mt-1.5 w-full uppercase tracking-wider font-mono rounded-xl border border-slate-800 bg-slate-950/70 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-500 outline-none transition focus:border-slate-600 focus:ring-1 focus:ring-slate-600"
                        value={roomInput}
                        onChange={(e) => setRoomInput(e.target.value)}
                        placeholder="e.g. 7X9K2L"
                        autoComplete="off"
                      />
                    </div>
                  )}

                  {/* Field: Microphone Consent Checkbox (Both modes) */}
                  <label className="flex items-start gap-3 rounded-xl border border-slate-800/80 bg-slate-950/40 p-3.5 text-xs leading-relaxed text-slate-300 cursor-pointer select-none hover:border-slate-700 transition">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-slate-700 bg-slate-900 text-slate-100 accent-slate-600 focus:ring-0"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    <span>
                      I agree to have my microphone audio recorded and saved for
                      English language practice and evaluation.
                    </span>
                  </label>

                  {/* Error Notification */}
                  {error && (
                    <div
                      role="alert"
                      className="rounded-xl border border-rose-900/60 bg-rose-950/40 px-3.5 py-2.5 text-xs text-rose-300"
                    >
                      {error}
                    </div>
                  )}

                  {/* Submit CTA */}
                  <button
                    type="submit"
                    className="w-full rounded-xl bg-slate-100 py-3 text-sm font-semibold text-slate-950 shadow-md transition hover:bg-white active:scale-[0.99]"
                  >
                    {mode === "create" ? "Create Room & Connect" : "Join Voice Room"}
                  </button>
                </form>

                {/* Analysis Drawer Trigger */}
                <div className="mt-6 border-t border-slate-800/80 pt-5 text-center">
                  {!showAnalysisLogin ? (
                    <button
                      type="button"
                      onClick={() => {
                        setAnalysisUsername(username);
                        setShowAnalysisLogin(true);
                        setAnalysisError("");
                        setAnalysis(null);
                      }}
                      className="text-xs font-medium text-slate-400 hover:text-slate-200 transition"
                    >
                      Looking for past feedback? <span className="underline">Review latest analysis</span>
                    </button>
                  ) : (
                    <form onSubmit={analyzeLatest} className="space-y-3 text-left">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                          Inspect Past Performance
                        </span>
                        <button
                          type="button"
                          onClick={() => setShowAnalysisLogin(false)}
                          className="text-xs text-slate-400 hover:text-slate-200"
                        >
                          Close
                        </button>
                      </div>

                      <input
                        className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 outline-none focus:border-slate-600"
                        value={analysisUsername}
                        onChange={(e) => setAnalysisUsername(e.target.value)}
                        placeholder="Recorded username"
                      />

                      {analysisError && (
                        <p className="text-xs text-rose-400">{analysisError}</p>
                      )}

                      <button
                        type="submit"
                        disabled={analyzing}
                        className="w-full rounded-xl border border-slate-700 bg-slate-800 py-2 text-xs font-medium text-white hover:bg-slate-700 transition disabled:opacity-50"
                      >
                        {analyzing ? "Running analysis…" : "Fetch Speaking Report"}
                      </button>
                    </form>
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* Active Call Screen */
            <div className="mx-auto max-w-xl">
              <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl sm:p-8">
                {/* Room Status Indicator */}
                <div className="flex items-center justify-between border-b border-slate-800 pb-5">
                  <div>
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      Active Voice Session
                    </span>
                    <h2 className="text-xl font-bold tracking-tight text-white">
                      Room {roomId}
                    </h2>
                  </div>

                  <button
                    type="button"
                    onClick={copyRoomId}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/90 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700"
                  >
                    {copied ? "Copied!" : "Copy Room ID"}
                  </button>
                </div>

                {/* Session Meta */}
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                    <p className="text-xs text-slate-400">Connected As</p>
                    <p className="mt-1 font-mono text-sm font-semibold text-slate-200">
                      @{username}
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                    <p className="text-xs text-slate-400">Participants</p>
                    <p className="mt-1 text-sm font-semibold text-slate-200">
                      {participants} {participants === 1 ? "speaker" : "speakers"}
                    </p>
                  </div>
                </div>

                {/* Audio Status Banner */}
                <div className="mt-4 flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                  <div className="flex items-center gap-3">
                    <span
                      className={`relative flex h-3 w-3 ${
                        recording ? "opacity-100" : "opacity-40"
                      }`}
                    >
                      {recording && (
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
                      )}
                      <span
                        className={`relative inline-flex h-3 w-3 rounded-full ${
                          recording ? "bg-rose-500" : "bg-slate-600"
                        }`}
                      />
                    </span>
                    <span className="text-xs text-slate-300">
                      {saving ? "Finalizing audio chunks…" : status}
                    </span>
                  </div>

                  <span className="font-mono text-xs text-slate-400">
                    {muted ? "MUTED" : "LIVE"}
                  </span>
                </div>

                {/* Call Control Buttons */}
                <div className="mt-6 grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={toggleMute}
                    disabled={saving}
                    className={`rounded-xl border py-3 text-xs font-semibold tracking-wide transition ${
                      muted
                        ? "border-amber-700/80 bg-amber-950/30 text-amber-300 hover:bg-amber-950/50"
                        : "border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
                    }`}
                  >
                    {muted ? "Unmute Microphone" : "Mute Microphone"}
                  </button>

                  <button
                    type="button"
                    onClick={leaveCall}
                    disabled={saving}
                    className="rounded-xl border border-rose-900/80 bg-rose-950/40 py-3 text-xs font-semibold tracking-wide text-rose-200 transition hover:bg-rose-900/60 disabled:opacity-50"
                  >
                    {saving ? "Saving..." : "Leave & Save Audio"}
                  </button>
                </div>

                {error && (
                  <p className="mt-4 text-xs text-rose-400" role="alert">
                    {error}
                  </p>
                )}

                {/* Hidden container for WebRTC Remote Audio Elements */}
                <div ref={audioContainerRef} className="hidden" aria-hidden="true" />
              </div>
            </div>
          )}

          {/* Analysis Results Display */}
          {analysis && (
            <div className="mx-auto mt-8 max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl sm:p-8">
              <div className="flex items-center justify-between border-b border-slate-800 pb-4">
                <div>
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Speech Evaluation
                  </span>
                  <h3 className="text-lg font-bold text-white">
                    Performance Breakdown
                  </h3>
                </div>
                <span className="rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1 font-mono text-xs text-slate-300">
                  @{analysisUsername}
                </span>
              </div>

              {!analysis.speechDetected ? (
                <div className="mt-5 rounded-xl border border-amber-900/60 bg-amber-950/30 p-4 text-xs text-amber-200 leading-relaxed">
                  {analysis.noSpeechMessage ||
                    "Insufficient audio detected. Please record a conversation where you speak clearly."}
                </div>
              ) : (
                <div className="mt-6 space-y-6">
                  {/* Mistakes */}
                  <div>
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                      Identified Grammatical Inaccuracies
                    </h4>
                    {analysis.mistakes?.length ? (
                      <div className="mt-3 space-y-3">
                        {analysis.mistakes.map((item, idx) => (
                          <div
                            key={`m-${idx}`}
                            className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-xs"
                          >
                            <p className="text-slate-400 line-through">
                              {item.original}
                            </p>
                            <p className="mt-1.5 font-semibold text-emerald-400">
                              {item.correction}
                            </p>
                            <p className="mt-2 text-slate-400">
                              <span className="text-slate-300 font-medium">Context:</span>{" "}
                              {item.reason}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-slate-400">
                        No major grammatical errors flagged.
                      </p>
                    )}
                  </div>

                  {/* Suggestions */}
                  <div>
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                      Natural Phrasing Suggestions
                    </h4>
                    {analysis.suggestions?.length ? (
                      <div className="mt-3 space-y-3">
                        {analysis.suggestions.map((item, idx) => (
                          <div
                            key={`s-${idx}`}
                            className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-xs"
                          >
                            <p className="text-slate-400">{item.original}</p>
                            <p className="mt-1.5 font-semibold text-slate-200">
                              {item.naturalVersion}
                            </p>
                            <p className="mt-2 text-slate-400">
                              <span className="text-slate-300 font-medium">Rationale:</span>{" "}
                              {item.reason}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-slate-400">
                        Phrasing sounded natural and conversational.
                      </p>
                    )}
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={() => {
                  setAnalysis(null);
                  setShowAnalysisLogin(true);
                }}
                className="mt-6 w-full rounded-xl border border-slate-700 bg-slate-800 py-2.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700"
              >
                Analyze Another User
              </button>
            </div>
          )}
        </main>

        {/* Quiet Footer */}
        <footer className="border-t border-slate-800/60 pt-4 text-center text-xs text-slate-400">
          Peer-to-peer audio encrypted via WebRTC. Recordings retained exclusively under your specified username.
        </footer>
      </div>
    </div>
  );
}