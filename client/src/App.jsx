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

  const [screen, setScreen] = useState("home");
  const [username, setUsername] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [roomId, setRoomId] = useState("");
  const [consent, setConsent] = useState(false);
  const [muted, setMuted] = useState(false);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [participants, setParticipants] = useState(1);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState("");
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
            setStatus("Tap the page if you cannot hear other participants."),
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
      setError(
        "Cannot connect to the voice server. Check that the backend is running.",
      ),
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
      throw new Error("This browser does not support audio recording.");
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
          throw new Error(
            result.error || `Audio chunk ${sequence} failed to upload.`,
          );
      })();
      pendingUploadsRef.current.push(uploadPromise);
      uploadPromise.catch((err) => {
        console.error("Audio chunk upload failed:", err);
        setStatus(
          "An audio upload failed. Keep the tab open and try leaving again.",
        );
      });
    };
    recorder.onerror = () =>
      setStatus("The browser reported a recording error.");
    recorder.start(10000);
    setRecording(true);
    setStatus("Recording your microphone and saving audio chunks...");
  }

  async function saveRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recordingSessionIdRef.current) {
      setStatus("No recording session was started. Please rejoin the room.");
      return false;
    }
    setSaving(true);
    setStatus("Finishing audio upload...");
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
        throw new Error(
          "Some audio chunks failed to upload. Please check your connection and leave the room again.",
        );
      const totalChunks = chunkSequenceRef.current;
      if (totalChunks < 1)
        throw new Error(
          "No audio chunks were recorded. Speak for at least a few seconds and try again.",
        );
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
        throw new Error(result.error || "Could not finalize the recording.");
      setStatus(
        "Recording saved successfully. You can open Analysis from the home screen.",
      );
      return true;
    } catch (err) {
      console.error("Could not finish recording:", err);
      setStatus(err.message || "Recording could not be saved.");
      return false;
    } finally {
      setSaving(false);
      mediaRecorderRef.current = null;
    }
  }

  async function joinRoom(id) {
    setError("");
    const normalized = normalizeUsername(username);
    if (!validUsername(normalized)) {
      setError("Username must contain 3–20 letters, numbers, or underscores.");
      return;
    }
    setUsername(normalized);
    if (!consent) {
      setError("Please agree to recording before joining.");
      return;
    }
    if (!socketRef.current?.connected) {
      setError("Voice server is disconnected. Try again.");
      return;
    }
    let stream;
    try {
      setStatus("Requesting microphone permission...");
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      streamRef.current = stream;
      socketRef.current.emit("room:join", { roomId: id }, (result) => {
        if (!result?.ok) {
          stream.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
          setStatus("Ready");
          setError(result?.error || "Could not join room.");
          return;
        }
        setRoomId(result.roomId);
        setRoomInput(result.roomId);
        setScreen("call");
        setMuted(false);
        try {
          startRecording(stream);
        } catch (err) {
          setError(err.message || "Could not start recording.");
        }
        setStatus("Connected. Your microphone is being recorded.");
        result.peers.forEach((peerId) => createPeer(peerId, false));
      });
    } catch (err) {
      stream?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStatus("Ready");
      setError(
        err.name === "NotAllowedError"
          ? "Allow microphone access in your browser and try again."
          : "Could not access your microphone. Use localhost or HTTPS.",
      );
    }
  }

  function createRoom() {
    setError("");
    if (!validUsername(username)) {
      setError("Username must contain 3–20 letters, numbers, or underscores.");
      return;
    }
    if (!consent) {
      setError("Please agree to recording before creating a room.");
      return;
    }
    if (!socketRef.current?.connected) {
      setError("Voice server is disconnected. Try again.");
      return;
    }
    socketRef.current.emit("room:create", (result) => {
      if (!result?.ok) {
        setError(result?.error || "Could not create a room.");
        return;
      }
      joinRoom(result.roomId);
    });
  }

  function joinById(event) {
    event.preventDefault();
    const id = roomInput.trim().toUpperCase();
    if (!id) {
      setError("Enter a room ID.");
      return;
    }
    joinRoom(id);
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
    setStatus("Recording saved. Ready for another session.");
  }

  async function copyRoomId() {
    try {
      await navigator.clipboard.writeText(roomId);
      setStatus("Room ID copied.");
    } catch {
      setStatus(`Share this room ID: ${roomId}`);
    }
  }

  async function analyzeLatest(event) {
    event?.preventDefault();
    const requestedUsername = normalizeUsername(analysisUsername);
    setAnalysisError("");
    if (!validUsername(requestedUsername)) {
      setAnalysisError(
        "Enter a username with 3–20 letters, numbers, or underscores.",
      );
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
        throw new Error(
          result.error || "Could not retrieve your latest recording.",
        );
      let parsed = result.analysis;
      if (typeof parsed === "string") {
        parsed = parsed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        parsed = JSON.parse(parsed);
      }
      setAnalysis(parsed);
      setShowAnalysisLogin(false);
    } catch (err) {
      setAnalysisError(
        err.message || "Could not analyze the latest recording.",
      );
    } finally {
      setAnalyzing(false);
    }
  }

  const inputClass =
    "w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100";
  const primaryClass =
    "inline-flex items-center justify-center rounded-xl bg-indigo-600 px-5 py-3 font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus:ring-4 focus:ring-indigo-200 disabled:cursor-not-allowed disabled:opacity-50";
  const secondaryClass =
    "inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-5 py-3 font-semibold text-slate-700 transition hover:bg-slate-50 focus:outline-none focus:ring-4 focus:ring-slate-100 disabled:opacity-50";

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 text-slate-900 sm:px-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-indigo-600 text-xl font-black text-white shadow-sm">
            E
          </div>
          <div>
            <p className="text-lg font-bold tracking-tight">English Practice</p>
            <p className="text-sm text-slate-500">
              Voice rooms · Speak, learn, improve
            </p>
          </div>
        </header>

        {screen === "home" ? (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-9">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-600">
              Practise together
            </p>
            <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              Speak English
              <br />
              <span className="text-indigo-600">with your friends.</span>
            </h1>
            <p className="mt-4 max-w-xl leading-7 text-slate-600">
              Create a room or join your friend's room using a room ID. No
              account needed. Use the same username whenever you want to view
              your latest analysis.
            </p>

            <div className="mt-7 space-y-2">
              <label htmlFor="username" className="block text-sm font-semibold">
                Your username
              </label>
              <input
                id="username"
                className={inputClass}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. aljafar_01"
                minLength={3}
                maxLength={20}
                autoComplete="username"
              />
              <p className="text-xs leading-5 text-slate-500">
                3–20 characters: lowercase letters, numbers, and underscores.
                Usernames are not passwords or verified identities.
              </p>
            </div>

            <button
              className={`${primaryClass} mt-5 w-full`}
              onClick={createRoom}
            >
              ＋ Create a room
            </button>
            <div className="my-6 flex items-center gap-3 text-xs font-semibold uppercase tracking-widest text-slate-400">
              <span className="h-px flex-1 bg-slate-200" />
              Or join a room
              <span className="h-px flex-1 bg-slate-200" />
            </div>
            <form onSubmit={joinById} className="space-y-3">
              <label htmlFor="roomId" className="block text-sm font-semibold">
                Room ID
              </label>
              <input
                id="roomId"
                className={inputClass}
                value={roomInput}
                onChange={(e) => setRoomInput(e.target.value)}
                placeholder="e.g. A1B2C3"
                autoComplete="off"
              />
              <button className={`${secondaryClass} w-full`} type="submit">
                Join room
              </button>
            </form>
            <label className="mt-6 flex cursor-pointer items-start gap-3 rounded-xl bg-slate-50 p-4 text-sm leading-6 text-slate-600">
              <input
                className="mt-1 h-4 w-4 accent-indigo-600"
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>
                I agree to have my microphone audio recorded and saved for
                English practice. I will tell other participants that recording
                is enabled.
              </span>
            </label>
            {error && (
              <p
                role="alert"
                className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-700"
              >
                {error}
              </p>
            )}

            <div className="mt-8 border-t border-slate-100 pt-6">
              <h2 className="font-bold">Review your latest recording</h2>
              <p className="mt-1 text-sm leading-6 text-slate-500">
                Enter your username to analyze the latest completed session
                saved under it.
              </p>
              {!showAnalysisLogin ? (
                <button
                  className={`${secondaryClass} mt-4 w-full`}
                  onClick={() => {
                    setAnalysisUsername(username);
                    setShowAnalysisLogin(true);
                    setAnalysisError("");
                    setAnalysis(null);
                  }}
                >
                  View my analysis
                </button>
              ) : (
                <form className="mt-4 space-y-3" onSubmit={analyzeLatest}>
                  <label
                    htmlFor="analysisUsername"
                    className="block text-sm font-semibold"
                  >
                    Username for analysis
                  </label>
                  <input
                    id="analysisUsername"
                    className={inputClass}
                    value={analysisUsername}
                    onChange={(e) => setAnalysisUsername(e.target.value)}
                    placeholder="Enter the username used for recording"
                    autoComplete="username"
                  />
                  {analysisError && (
                    <p role="alert" className="text-sm text-rose-700">
                      {analysisError}
                    </p>
                  )}
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <button
                      className={`${primaryClass} flex-1`}
                      type="submit"
                      disabled={analyzing}
                    >
                      {analyzing
                        ? "Analyzing latest recording…"
                        : "Get my analysis"}
                    </button>
                    <button
                      className={secondaryClass}
                      type="button"
                      onClick={() => setShowAnalysisLogin(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          </section>
        ) : (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-9">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-600">
              Voice room
            </p>
            <h1 className="mt-3 text-3xl font-bold">
              Room <span className="text-indigo-600">{roomId}</span>
            </h1>
            <p className="mt-3 text-slate-600">
              You are joining as <strong>{username}</strong>. Share this room ID
              with your friends.
            </p>
            <div className="mt-5 flex items-center justify-between rounded-2xl bg-slate-50 p-4">
              <span className="font-mono text-xl font-bold tracking-widest">
                {roomId}
              </span>
              <button className={secondaryClass} onClick={copyRoomId}>
                Copy ID
              </button>
            </div>
            <div className="mt-5 flex items-center gap-4 rounded-2xl border border-slate-200 p-4">
              <div className="grid h-12 w-12 place-items-center rounded-xl bg-indigo-50 text-2xl">
                {muted ? "🔇" : "🎙️"}
              </div>
              <div>
                <p className="font-semibold">
                  {participants} {participants === 1 ? "person" : "people"} in
                  the room
                </p>
                <p className="text-sm text-slate-500">
                  {saving
                    ? "Saving recording…"
                    : recording
                      ? "Recording your microphone"
                      : status}
                </p>
              </div>
              <span
                className={`ml-auto h-2.5 w-2.5 rounded-full ${recording ? "animate-pulse bg-rose-500" : "bg-slate-300"}`}
              />
            </div>
            <p className="mt-4 text-sm leading-6 text-slate-500">
              Only your own microphone audio is saved. Keep this tab open during
              the call so audio chunks can upload.
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <button
                className={secondaryClass}
                onClick={toggleMute}
                disabled={saving}
              >
                {muted ? "Unmute microphone" : "Mute microphone"}
              </button>
              <button
                className="inline-flex items-center justify-center rounded-xl bg-rose-600 px-5 py-3 font-semibold text-white transition hover:bg-rose-700 disabled:opacity-50"
                onClick={leaveCall}
                disabled={saving}
              >
                {saving ? "Saving audio…" : "Leave call & save"}
              </button>
            </div>
            {status && (
              <p className="mt-4 text-sm text-slate-600" role="status">
                {status}
              </p>
            )}
            {error && (
              <p
                role="alert"
                className="mt-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-700"
              >
                {error}
              </p>
            )}
            <div
              ref={audioContainerRef}
              className="hidden"
              aria-hidden="true"
            />
          </section>
        )}

        {analysis && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-9">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-600">
                  Speaking review
                </p>
                <h2 className="mt-2 text-2xl font-bold">
                  Your English analysis
                </h2>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                @{analysisUsername.trim().toLowerCase()}
              </span>
            </div>
            {!analysis.speechDetected ? (
              <p className="mt-5 rounded-2xl bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                {analysis.noSpeechMessage ||
                  "I couldn't detect enough clear speech to analyze your English. Please record again and speak clearly."}
              </p>
            ) : (
              <>
                <div className="mt-6">
                  <h3 className="text-lg font-bold">1. Mistakes</h3>
                  {analysis.mistakes?.length ? (
                    <div className="mt-3 space-y-3">
                      {analysis.mistakes.map((item, index) => (
                        <article
                          key={`m-${index}`}
                          className="rounded-2xl border border-rose-100 bg-rose-50/50 p-4"
                        >
                          <p className="text-xs font-bold uppercase tracking-wider text-rose-700">
                            Original
                          </p>
                          <p className="mt-1 leading-6 text-slate-700">
                            <s>{item.original}</s>
                          </p>
                          <p className="mt-3 text-xs font-bold uppercase tracking-wider text-emerald-700">
                            Correct sentence
                          </p>
                          <p className="mt-1 font-medium leading-6 text-slate-900">
                            {item.correction}
                          </p>
                          <p className="mt-3 text-sm leading-6 text-slate-600">
                            <strong>Reason:</strong> {item.reason}
                          </p>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">
                      No significant mistakes found.
                    </p>
                  )}
                </div>
                <div className="mt-7">
                  <h3 className="text-lg font-bold">2. Suggestions</h3>
                  {analysis.suggestions?.length ? (
                    <div className="mt-3 space-y-3">
                      {analysis.suggestions.map((item, index) => (
                        <article
                          key={`s-${index}`}
                          className="rounded-2xl border border-indigo-100 bg-indigo-50/50 p-4"
                        >
                          <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
                            Your sentence
                          </p>
                          <p className="mt-1 leading-6 text-slate-700">
                            {item.original}
                          </p>
                          <p className="mt-3 text-xs font-bold uppercase tracking-wider text-indigo-700">
                            For a more natural tone
                          </p>
                          <p className="mt-1 font-medium leading-6 text-slate-900">
                            {item.naturalVersion}
                          </p>
                          <p className="mt-3 text-sm leading-6 text-slate-600">
                            <strong>Reason:</strong> {item.reason}
                          </p>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
                      No suggestions needed.
                    </p>
                  )}
                </div>
              </>
            )}
            <button
              className={`${secondaryClass} mt-6 w-full`}
              onClick={() => {
                setAnalysis(null);
                setShowAnalysisLogin(true);
              }}
            >
              Analyze another username
            </button>
          </section>
        )}
        <footer className="pb-4 text-center text-xs leading-5 text-slate-400">
          Simple, friendly English practice. No account required. Audio is saved
          for analysis under the username you provide.
        </footer>
      </div>
    </main>
  );
}
