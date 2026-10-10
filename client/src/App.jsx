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

  // Theme State
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });

  const isDark = theme === "dark";

  const toggleTheme = () => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      localStorage.setItem("theme", next);
      return next;
    });
  };

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
            setStatus(
              "Click anywhere on the page if you cannot hear remote audio.",
            ),
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

      socketRef.current.emit(
        "room:join",
        { roomId: targetRoomId },
        (result) => {
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
            setError(
              err.message || "Microphone recording initialization failed.",
            );
          }
          setStatus("Connected to voice channel.");
          result.peers.forEach((peerId) => createPeer(peerId, false));
        },
      );
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
      setError(
        "Username must be 3–20 characters (letters, numbers, underscores).",
      );
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
    <div
      className={`min-h-screen font-sans antialiased transition-colors duration-200 ${
        isDark ? "bg-slate-950 text-slate-100" : "bg-slate-50 text-slate-900"
      }`}
    >
      <div className="relative mx-auto flex min-h-screen max-w-4xl flex-col justify-between px-4 py-8 sm:px-6 sm:py-12">
        {/* Header */}
        <header
          className={`flex items-center justify-between border-b pb-6 transition-colors ${
            isDark ? "border-slate-800" : "border-slate-200"
          }`}
        >
          <div className="flex items-center gap-3">
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-xl border font-semibold shadow-sm transition-colors ${
                isDark
                  ? "border-slate-700 bg-slate-800 text-slate-200"
                  : "border-slate-200 bg-white text-slate-800"
              }`}
            >
              VR
            </div>
            <div>
              <h1
                className={`text-base font-semibold tracking-tight ${
                  isDark ? "text-white" : "text-slate-900"
                }`}
              >
                Voice Room
              </h1>
              <p
                className={`text-xs ${isDark ? "text-slate-400" : "text-slate-500"}`}
              >
                Peer-to-peer conversational space
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            {/* Status Pill */}
            <span
              className={`hidden sm:inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${
                isDark
                  ? "border-slate-800 bg-slate-900/60 text-slate-300"
                  : "border-slate-200 bg-white text-slate-600"
              }`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              WebRTC Audio
            </span>

            {/* Light / Dark Mode Toggle Button */}
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={
                isDark ? "Switch to light theme" : "Switch to dark theme"
              }
              className={`flex h-9 w-9 items-center justify-center rounded-xl border transition-all ${
                isDark
                  ? "border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-700 hover:text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900 shadow-sm"
              }`}
            >
              {isDark ? (
                /* Sun Icon */
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                  />
                </svg>
              ) : (
                /* Moon Icon */
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                  />
                </svg>
              )}
            </button>
          </div>
        </header>

        {/* Main Body */}
        <main className="my-auto py-8">
          {screen === "home" ? (
            <div className="mx-auto max-w-lg">
              <div
                className={`rounded-2xl border p-6 shadow-xl backdrop-blur-sm sm:p-8 transition-colors ${
                  isDark
                    ? "border-slate-800 bg-slate-900/90"
                    : "border-slate-200 bg-white"
                }`}
              >
                <div className="mb-6 text-center sm:text-left">
                  <h2
                    className={`text-2xl font-bold tracking-tight ${
                      isDark ? "text-white" : "text-slate-900"
                    }`}
                  >
                    Start Speaking
                  </h2>
                  <p
                    className={`mt-1 text-sm ${
                      isDark ? "text-slate-400" : "text-slate-500"
                    }`}
                  >
                    Collaborate with peers to build fluency. No passwords
                    needed.
                  </p>
                </div>

                {/* Segmented Toggle: Create vs Join */}
                <div
                  role="tablist"
                  aria-label="Room Action Selection"
                  className={`mb-6 grid grid-cols-2 rounded-xl p-1 border transition-colors ${
                    isDark
                      ? "border-slate-800 bg-slate-950"
                      : "border-slate-200 bg-slate-100"
                  }`}
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
                        ? isDark
                          ? "border border-slate-700/60 bg-slate-800 text-white shadow-sm"
                          : "border border-slate-200/80 bg-white text-slate-900 shadow-sm"
                        : isDark
                          ? "text-slate-400 hover:text-slate-200"
                          : "text-slate-500 hover:text-slate-800"
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
                        ? isDark
                          ? "border border-slate-700/60 bg-slate-800 text-white shadow-sm"
                          : "border border-slate-200/80 bg-white text-slate-900 shadow-sm"
                        : isDark
                          ? "text-slate-400 hover:text-slate-200"
                          : "text-slate-500 hover:text-slate-800"
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

                {/* Main Form */}
                <form onSubmit={handleFormSubmit} className="space-y-4">
                  {/* Field: Username */}
                  <div>
                    <label
                      htmlFor="username"
                      className={`block text-xs font-medium uppercase tracking-wider ${
                        isDark ? "text-slate-300" : "text-slate-700"
                      }`}
                    >
                      Your Username
                    </label>
                    <input
                      id="username"
                      type="text"
                      className={`mt-1.5 w-full rounded-xl border px-3.5 py-2.5 text-sm outline-none transition ${
                        isDark
                          ? "border-slate-800 bg-slate-950/70 text-slate-100 placeholder-slate-500 focus:border-slate-600 focus:ring-1 focus:ring-slate-600"
                          : "border-slate-200 bg-slate-50 text-slate-900 placeholder-slate-400 focus:border-slate-400 focus:bg-white focus:ring-1 focus:ring-slate-300"
                      }`}
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="e.g. aljafar_01"
                      minLength={3}
                      maxLength={20}
                      autoComplete="username"
                    />
                    <p
                      className={`mt-1 text-[11px] ${
                        isDark ? "text-slate-500" : "text-slate-400"
                      }`}
                    >
                      3–20 lowercase characters, numbers, or underscores.
                    </p>
                  </div>

                  {/* Field: Room ID (Only for Join) */}
                  {mode === "join" && (
                    <div className="transition-all duration-150">
                      <label
                        htmlFor="roomId"
                        className={`block text-xs font-medium uppercase tracking-wider ${
                          isDark ? "text-slate-300" : "text-slate-700"
                        }`}
                      >
                        Room ID
                      </label>
                      <input
                        id="roomId"
                        type="text"
                        className={`mt-1.5 w-full font-mono uppercase tracking-wider rounded-xl border px-3.5 py-2.5 text-sm outline-none transition ${
                          isDark
                            ? "border-slate-800 bg-slate-950/70 text-slate-100 placeholder-slate-500 focus:border-slate-600 focus:ring-1 focus:ring-slate-600"
                            : "border-slate-200 bg-slate-50 text-slate-900 placeholder-slate-400 focus:border-slate-400 focus:bg-white focus:ring-1 focus:ring-slate-300"
                        }`}
                        value={roomInput}
                        onChange={(e) => setRoomInput(e.target.value)}
                        placeholder="e.g. 7X9K2L"
                        autoComplete="off"
                      />
                    </div>
                  )}

                  {/* Field: Microphone Consent Checkbox */}
                  <label
                    className={`flex items-start gap-3 rounded-xl border p-3.5 text-xs leading-relaxed cursor-pointer select-none transition ${
                      isDark
                        ? "border-slate-800/80 bg-slate-950/40 text-slate-300 hover:border-slate-700"
                        : "border-slate-200 bg-slate-50/70 text-slate-600 hover:border-slate-300"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className={`mt-0.5 h-4 w-4 rounded accent-slate-700 ${
                        isDark
                          ? "border-slate-700 bg-slate-900"
                          : "border-slate-300 bg-white"
                      }`}
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    <span>
                      I agree to have my microphone audio recorded and saved for
                      English language practice and evaluation.
                    </span>
                  </label>

                  {/* Error Banner */}
                  {error && (
                    <div
                      role="alert"
                      className={`rounded-xl border px-3.5 py-2.5 text-xs ${
                        isDark
                          ? "border-rose-900/60 bg-rose-950/40 text-rose-300"
                          : "border-rose-200 bg-rose-50 text-rose-700"
                      }`}
                    >
                      {error}
                    </div>
                  )}

                  {/* Submit CTA */}
                  <button
                    type="submit"
                    className={`w-full rounded-xl py-3 text-sm font-semibold shadow-sm transition active:scale-[0.99] ${
                      isDark
                        ? "bg-slate-100 text-slate-950 hover:bg-white"
                        : "bg-slate-900 text-white hover:bg-slate-800"
                    }`}
                  >
                    {mode === "create"
                      ? "Create Room & Connect"
                      : "Join Voice Room"}
                  </button>
                </form>

                {/* Analysis Accordion */}
                <div
                  className={`mt-6 border-t pt-5 text-center ${
                    isDark ? "border-slate-800/80" : "border-slate-200"
                  }`}
                >
                  {!showAnalysisLogin ? (
                    <button
                      type="button"
                      onClick={() => {
                        setAnalysisUsername(username);
                        setShowAnalysisLogin(true);
                        setAnalysisError("");
                        setAnalysis(null);
                      }}
                      className={`text-xs font-medium transition ${
                        isDark
                          ? "text-slate-400 hover:text-slate-200"
                          : "text-slate-500 hover:text-slate-800"
                      }`}
                    >
                      Looking for past feedback?{" "}
                      <span className="underline">Review latest analysis</span>
                    </button>
                  ) : (
                    <form
                      onSubmit={analyzeLatest}
                      className="space-y-3 text-left"
                    >
                      <div className="flex items-center justify-between">
                        <span
                          className={`text-xs font-semibold uppercase tracking-wider ${
                            isDark ? "text-slate-300" : "text-slate-700"
                          }`}
                        >
                          Inspect Past Performance
                        </span>
                        <button
                          type="button"
                          onClick={() => setShowAnalysisLogin(false)}
                          className={`text-xs ${
                            isDark
                              ? "text-slate-400 hover:text-slate-200"
                              : "text-slate-500 hover:text-slate-800"
                          }`}
                        >
                          Close
                        </button>
                      </div>

                      <input
                        className={`w-full rounded-xl border px-3 py-2 text-xs outline-none ${
                          isDark
                            ? "border-slate-800 bg-slate-950 text-slate-100 placeholder-slate-500 focus:border-slate-600"
                            : "border-slate-200 bg-slate-50 text-slate-900 placeholder-slate-400 focus:border-slate-400 focus:bg-white"
                        }`}
                        value={analysisUsername}
                        onChange={(e) => setAnalysisUsername(e.target.value)}
                        placeholder="Recorded username"
                      />

                      {analysisError && (
                        <p
                          className={`text-xs ${
                            isDark ? "text-rose-400" : "text-rose-600"
                          }`}
                        >
                          {analysisError}
                        </p>
                      )}

                      <button
                        type="submit"
                        disabled={analyzing}
                        className={`w-full rounded-xl border py-2 text-xs font-medium transition disabled:opacity-50 ${
                          isDark
                            ? "border-slate-700 bg-slate-800 text-white hover:bg-slate-700"
                            : "border-slate-300 bg-slate-100 text-slate-800 hover:bg-slate-200"
                        }`}
                      >
                        {analyzing
                          ? "Running analysis…"
                          : "Fetch Speaking Report"}
                      </button>
                    </form>
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* Active Call Screen */
            <div className="mx-auto max-w-xl">
              <div
                className={`rounded-2xl border p-6 shadow-xl sm:p-8 transition-colors ${
                  isDark
                    ? "border-slate-800 bg-slate-900"
                    : "border-slate-200 bg-white"
                }`}
              >
                <div
                  className={`flex items-center justify-between border-b pb-5 ${
                    isDark ? "border-slate-800" : "border-slate-200"
                  }`}
                >
                  <div>
                    <span
                      className={`text-[11px] font-semibold uppercase tracking-wider ${
                        isDark ? "text-slate-400" : "text-slate-500"
                      }`}
                    >
                      Active Voice Session
                    </span>
                    <h2
                      className={`text-xl font-bold tracking-tight ${
                        isDark ? "text-white" : "text-slate-900"
                      }`}
                    >
                      Room {roomId}
                    </h2>
                  </div>

                  <button
                    type="button"
                    onClick={copyRoomId}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                      isDark
                        ? "border-slate-700 bg-slate-800/90 text-slate-200 hover:bg-slate-700"
                        : "border-slate-200 bg-slate-100 text-slate-700 hover:bg-slate-200"
                    }`}
                  >
                    {copied ? "Copied!" : "Copy Room ID"}
                  </button>
                </div>

                {/* Session Meta */}
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <div
                    className={`rounded-xl border p-4 ${
                      isDark
                        ? "border-slate-800 bg-slate-950/60"
                        : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <p
                      className={`text-xs ${
                        isDark ? "text-slate-400" : "text-slate-500"
                      }`}
                    >
                      Connected As
                    </p>
                    <p
                      className={`mt-1 font-mono text-sm font-semibold ${
                        isDark ? "text-slate-200" : "text-slate-800"
                      }`}
                    >
                      @{username}
                    </p>
                  </div>
                  <div
                    className={`rounded-xl border p-4 ${
                      isDark
                        ? "border-slate-800 bg-slate-950/60"
                        : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <p
                      className={`text-xs ${
                        isDark ? "text-slate-400" : "text-slate-500"
                      }`}
                    >
                      Participants
                    </p>
                    <p
                      className={`mt-1 text-sm font-semibold ${
                        isDark ? "text-slate-200" : "text-slate-800"
                      }`}
                    >
                      {participants}{" "}
                      {participants === 1 ? "speaker" : "speakers"}
                    </p>
                  </div>
                </div>

                {/* Audio Status Banner */}
                <div
                  className={`mt-4 flex items-center justify-between rounded-xl border p-4 ${
                    isDark
                      ? "border-slate-800 bg-slate-950/40"
                      : "border-slate-200 bg-slate-50"
                  }`}
                >
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
                          recording ? "bg-rose-500" : "bg-slate-400"
                        }`}
                      />
                    </span>
                    <span
                      className={`text-xs ${
                        isDark ? "text-slate-300" : "text-slate-600"
                      }`}
                    >
                      {saving ? "Finalizing audio chunks…" : status}
                    </span>
                  </div>

                  <span
                    className={`font-mono text-xs ${
                      isDark ? "text-slate-400" : "text-slate-500"
                    }`}
                  >
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
                        ? isDark
                          ? "border-amber-700/80 bg-amber-950/30 text-amber-300 hover:bg-amber-950/50"
                          : "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
                        : isDark
                          ? "border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
                          : "border-slate-200 bg-slate-100 text-slate-700 hover:bg-slate-200"
                    }`}
                  >
                    {muted ? "Unmute Microphone" : "Mute Microphone"}
                  </button>

                  <button
                    type="button"
                    onClick={leaveCall}
                    disabled={saving}
                    className={`rounded-xl border py-3 text-xs font-semibold tracking-wide transition disabled:opacity-50 ${
                      isDark
                        ? "border-rose-900/80 bg-rose-950/40 text-rose-200 hover:bg-rose-900/60"
                        : "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
                    }`}
                  >
                    {saving ? "Saving..." : "Leave & Save Audio"}
                  </button>
                </div>

                {error && (
                  <p
                    className={`mt-4 text-xs ${
                      isDark ? "text-rose-400" : "text-rose-600"
                    }`}
                    role="alert"
                  >
                    {error}
                  </p>
                )}

                <div
                  ref={audioContainerRef}
                  className="hidden"
                  aria-hidden="true"
                />
              </div>
            </div>
          )}

          {/* Analysis View */}
          {analysis && (
            <div
              className={`mx-auto mt-8 max-w-2xl rounded-2xl border p-6 shadow-xl sm:p-8 transition-colors ${
                isDark
                  ? "border-slate-800 bg-slate-900"
                  : "border-slate-200 bg-white"
              }`}
            >
              <div
                className={`flex items-center justify-between border-b pb-4 ${
                  isDark ? "border-slate-800" : "border-slate-200"
                }`}
              >
                <div>
                  <span
                    className={`text-[11px] font-semibold uppercase tracking-wider ${
                      isDark ? "text-slate-400" : "text-slate-500"
                    }`}
                  >
                    Speech Evaluation
                  </span>
                  <h3
                    className={`text-lg font-bold ${
                      isDark ? "text-white" : "text-slate-900"
                    }`}
                  >
                    Performance Breakdown
                  </h3>
                </div>
                <span
                  className={`rounded-lg border px-2.5 py-1 font-mono text-xs ${
                    isDark
                      ? "border-slate-800 bg-slate-950 text-slate-300"
                      : "border-slate-200 bg-slate-50 text-slate-700"
                  }`}
                >
                  @{analysisUsername}
                </span>
              </div>

              {!analysis.speechDetected ? (
                <div
                  className={`mt-5 rounded-xl border p-4 text-xs leading-relaxed ${
                    isDark
                      ? "border-amber-900/60 bg-amber-950/30 text-amber-200"
                      : "border-amber-200 bg-amber-50 text-amber-800"
                  }`}
                >
                  {analysis.noSpeechMessage ||
                    "Insufficient audio detected. Please record a conversation where you speak clearly."}
                </div>
              ) : (
                <div className="mt-6 space-y-6">
                  {/* Mistakes */}
                  <div>
                    <h4
                      className={`text-xs font-bold uppercase tracking-wider ${
                        isDark ? "text-slate-400" : "text-slate-500"
                      }`}
                    >
                      Identified Grammatical Inaccuracies
                    </h4>
                    {analysis.mistakes?.length ? (
                      <div className="mt-3 space-y-3">
                        {analysis.mistakes.map((item, idx) => (
                          <div
                            key={`m-${idx}`}
                            className={`rounded-xl border p-4 text-xs ${
                              isDark
                                ? "border-slate-800 bg-slate-950/70"
                                : "border-slate-200 bg-slate-50"
                            }`}
                          >
                            <p
                              className={`line-through ${
                                isDark ? "text-red-300" : "text-red-400"
                              }`}
                            >
                              {item.original}
                            </p>
                            <p
                              className={`mt-1.5 font-semibold ${
                                isDark ? "text-green-300" : "text-green-800"
                              }`}
                            >
                              {item.correction}
                            </p>
                            <p
                              className={`mt-2 ${
                                isDark ? "text-slate-400" : "text-slate-600"
                              }`}
                            >
                              <span
                                className={`font-medium ${
                                  isDark ? "text-slate-300" : "text-slate-700"
                                }`}
                              >
                                Reason:
                              </span>{" "}
                              {item.reason}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p
                        className={`mt-2 text-xs ${
                          isDark ? "text-slate-400" : "text-slate-500"
                        }`}
                      >
                        No major grammatical errors flagged.
                      </p>
                    )}
                  </div>

                  {/* Suggestions */}
                  <div>
                    <h4
                      className={`text-xs font-bold uppercase tracking-wider ${
                        isDark ? "text-slate-400" : "text-slate-500"
                      }`}
                    >
                      Natural Phrasing Suggestions
                    </h4>
                    {analysis.suggestions?.length ? (
                      <div className="mt-3 space-y-3">
                        {analysis.suggestions.map((item, idx) => (
                          <div
                            key={`s-${idx}`}
                            className={`rounded-xl border p-4 text-xs ${
                              isDark
                                ? "border-slate-800 bg-slate-950/70"
                                : "border-slate-200 bg-slate-50"
                            }`}
                          >
                            <p
                              className={
                                isDark ? "text-slate-400" : "text-slate-500"
                              }
                            >
                              {item.original}
                            </p>
                            <p
                              className={`mt-1.5 font-semibold ${
                                isDark ? "text-blue-400" : "text-blue-600"
                              }`}
                            >
                              {item.naturalVersion}
                            </p>
                            <p
                              className={`mt-2 ${
                                isDark ? "text-slate-400" : "text-slate-600"
                              }`}
                            >
                              <span
                                className={`font-medium ${
                                  isDark ? "text-slate-300" : "text-slate-700"
                                }`}
                              >
                                Reason:
                              </span>{" "}
                              {item.reason}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p
                        className={`mt-2 text-xs ${
                          isDark ? "text-slate-400" : "text-slate-500"
                        }`}
                      >
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
                className={`mt-6 w-full rounded-xl border py-2.5 text-xs font-medium transition ${
                  isDark
                    ? "border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
                    : "border-slate-200 bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                Analyze Another User
              </button>
            </div>
          )}
        </main>

        {/* Footer */}
        <footer
          className={`border-t pt-4 text-center text-xs transition-colors ${
            isDark
              ? "border-slate-800 text-slate-500"
              : "border-slate-200 text-slate-400"
          }`}
        >
          Peer-to-peer audio encrypted via WebRTC. Recordings retained
          exclusively under your specified username.
        </footer>
      </div>
    </div>
  );
}
