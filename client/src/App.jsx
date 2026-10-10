
import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import Peer from "simple-peer";

const SERVER_URL =
  import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
];

export default function App() {
  const socketRef = useRef(null);
  const streamRef = useRef(null);
  const mediaRecorderRef = useRef(null);

  const peersRef = useRef(new Map());
  const audioContainerRef = useRef(null);

  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const participantIdRef = useRef(
    `student_${Math.random().toString(36).slice(2, 10)}`
  );
  const recordingStartRef = useRef(0);

  const [screen, setScreen] = useState("home");
  const [roomInput, setRoomInput] = useState("");
  const [roomId, setRoomId] = useState("");
  const [consent, setConsent] = useState(false);
  const [muted, setMuted] = useState(false);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [participants, setParticipants] = useState(1);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState("");

  const chunkSequenceRef = useRef(0);
  const pendingUploadsRef = useRef([]);

  useEffect(() => {
    const socket = io(SERVER_URL);
    socketRef.current = socket;

    socket.on("connect_error", () => {
      setError("Cannot connect to the voice server.");
    });

    socket.on("peer:joined", ({ peerId }) => {
      createPeer(peerId, true);
    });

    socket.on("webrtc:signal", ({ from, signal }) => {
      let entry = peersRef.current.get(from);

      if (!entry) entry = createPeer(from, false);

      if (entry && !entry.peer.destroyed) {
        entry.peer.signal(signal);
      }
    });

    socket.on("peer:left", ({ peerId }) => {
      removePeer(peerId);
    });

    return () => {
      // Do not upload during an unexpected component unmount.
      stopRecordingWithoutUpload();
      cleanupPeersAndMic();
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function createPeer(peerId, initiator) {
    if (peersRef.current.has(peerId)) {
      return peersRef.current.get(peerId);
    }

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

    peer.on("signal", (signal) => {
      socketRef.current?.emit("webrtc:signal", {
        to: peerId,
        signal,
      });
    });

    peer.on("stream", (remoteStream) => {
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      audio.srcObject = remoteStream;

      audioContainerRef.current?.appendChild(audio);
      entry.audio = audio;

      audio.play().catch(() => {
        setStatus("Tap the page if you cannot hear other participants.");
      });
    });

    peer.on("close", () => removePeer(peerId));
    peer.on("error", () => removePeer(peerId));

    return entry;
  }

  function removePeer(peerId) {
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
  }

  function startRecording(localStream, activeRoomId) {
  const recorder = new MediaRecorder(localStream);

  mediaRecorderRef.current = recorder;
  chunkSequenceRef.current = 0;
  pendingUploadsRef.current = [];
  recordingStartRef.current = Date.now();

  recorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return;

    const sequence = chunkSequenceRef.current++;

    const uploadPromise = (async () => {
      const formData = new FormData();

      formData.append("roomId", activeRoomId);
      formData.append("participantId", participantIdRef.current);
      formData.append("sequence", String(sequence));
      formData.append("audio", event.data, `${sequence}.webm`);

      const response = await fetch(
        `${SERVER_URL}/api/recordings/chunk`,
        {
          method: "POST",
          body: formData,
        }
      );

      if (!response.ok) {
        throw new Error(`Chunk ${sequence} failed to upload`);
      }
    })();

    pendingUploadsRef.current.push(uploadPromise);

    // Prevent unhandled rejection warnings.
    uploadPromise.catch((error) => {
      console.error("Audio chunk upload failed:", error);
      setStatus("An audio upload failed. Keep the tab open and retry.");
    });
  };

  // Emit audio data approximately every 15 seconds.
  recorder.start(15000);

  setRecording(true);
  setStatus("Recording and saving audio...");
}

  function stopRecordingWithoutUpload() {
    const recorder = recorderRef.current;

    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {}
    }

    recorderRef.current = null;
    chunksRef.current = [];
    setRecording(false);
  }

  async function saveRecording(activeRoomId) {
  const recorder = mediaRecorderRef.current;

  try {
    if (recorder && recorder.state !== "inactive") {
      await new Promise((resolve) => {
        recorder.addEventListener("stop", resolve, { once: true });
        recorder.stop();
      });
    }

    setRecording(false);
    setSaving(true);
    setStatus("Finishing audio upload...");

    const results = await Promise.allSettled(
      pendingUploadsRef.current
    );

    const failed = results.some(
      (result) => result.status === "rejected"
    );

    if (failed) {
      throw new Error(
        "Some audio chunks failed to upload. Please retry before analysis."
      );
    }
    // delete it (start)
    console.log("Finalizing recording:", {
      roomId: activeRoomId,
      participantId: participantIdRef.current,
      totalChunks: chunkSequenceRef.current,
    });
    // delete it (last)
    const response = await fetch(
      `${SERVER_URL}/api/recordings/finalize`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId: activeRoomId,
          participantId: participantIdRef.current,
          totalChunks: chunkSequenceRef.current,
        }),
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        result.error || "Could not finalize the recording"
      );
    }

    setStatus("Recording saved successfully. Ready for analysis.");
    return true;
  } catch (error) {
    console.error("Could not finish recording:", error);
    setStatus(error.message || "Recording could not be saved.");
    return false;
  } finally {
    setSaving(false);
  }
}

  async function joinRoom(id) {
    setError("");

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

        // Record this participant's microphone stream.
        startRecording(stream, result.roomId);

        setStatus("Connected. Your microphone is being recorded.");

        // Existing room members receive peer:joined and initiate calls.
        result.peers.forEach((peerId) => createPeer(peerId, false));
      });
    } catch (err) {
      stream?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;

      setStatus("Ready");
      setError(
        err.name === "NotAllowedError"
          ? "Allow microphone access in your browser and try again."
          : "Could not access your microphone. Use localhost or HTTPS."
      );
    }
  }

  function createRoom() {
    setError("");

    if (!consent) {
      setError("Please agree to recording before creating a room.");
      return;
    }

    socketRef.current.emit("room:create", (result) => {
      if (!result?.ok) {
        setError("Could not create a room.");
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

  function cleanupPeersAndMic() {
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
  }

  async function leaveCall() {
  const currentRoomId = roomId;

  // Save before resetting the room state.
  const saved = await saveRecording(currentRoomId);

  if (!saved) {
    // Keep the room ID and recording information available for retry.
    return;
  }

  socketRef.current?.emit("room:leave");

  peersRef.current.forEach((peer) => peer.destroy());
  peersRef.current.clear();

  streamRef.current?.getTracks().forEach((track) => track.stop());
  streamRef.current = null;

  setRoomId("");
  setRoomInput("");
  setScreen("home");
  setStatus("Ready");
}

  async function copyRoomId() {
    try {
      await navigator.clipboard.writeText(roomId);
      setStatus("Room ID copied.");
    } catch {
      setStatus(`Share this room ID: ${roomId}`);
    }
  }

  return (
    <main className="page">
      <header className="topbar">
        <div className="brand-mark">E</div>
        <div>
          <div className="brand">English Practice</div>
          <div className="subbrand">Voice rooms</div>
        </div>
      </header>

      {screen === "home" ? (
        <section className="card home-card">
          <div className="eyebrow">PRACTISE TOGETHER</div>
          <h1>
            Speak English
            <br />
            <span>with your friends.</span>
          </h1>
          <p className="intro">
            Create a room or join your friend's room using a room ID.
            No account needed.
          </p>

          <button className="primary full" onClick={createRoom}>
            + Create a room
          </button>

          <div className="divider">
            <span>OR JOIN A ROOM</span>
          </div>

          <form onSubmit={joinById} className="join-form">
            <label htmlFor="roomId">Room ID</label>
            <input
              id="roomId"
              value={roomInput}
              onChange={(e) => setRoomInput(e.target.value)}
              placeholder="e.g. A1B2C3"
              autoComplete="off"
            />
            <button className="secondary full" type="submit">
              Join room
            </button>
          </form>

          <label className="consent-row">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>
              I agree to have my microphone audio recorded and saved
              for English practice.
            </span>
          </label>

          {error && <p className="error">{error}</p>}

          <p className="privacy-note">
            Every participant must agree. Tell everyone that recording
            is enabled before the conversation begins.
          </p>
        </section>
      ) : (
        <section className="card call-card">
          <div className="eyebrow">VOICE ROOM</div>
          <h1>
            Room <span>{roomId}</span>
          </h1>

          <p className="intro">
            Share this room ID with your friends.
          </p>

          <div className="room-share">
            <strong>{roomId}</strong>
            <button className="secondary small" onClick={copyRoomId}>
              Copy ID
            </button>
          </div>

          <div className="participant-box">
            <div className="mic-icon">{muted ? "🔇" : "🎙️"}</div>
            <div>
              <strong>You are in the room</strong>
              <p>{participants} people including you</p>
            </div>
          </div>

          <div className="recording-banner">
            <span className="recording-dot" />
            <div>
              <strong>
                {saving
                  ? "Saving recording..."
                  : recording
                    ? "Recording your microphone"
                    : "Recording stopped"}
              </strong>
              <p>Only your own microphone audio is saved.</p>
            </div>
          </div>

          <p className="status-text">{status}</p>

          <div className="call-actions">
            <button
              className="mute-button"
              onClick={toggleMute}
              disabled={saving}
            >
              {muted ? "Unmute microphone" : "Mute microphone"}
            </button>

            <button
              className="danger-button"
              onClick={leaveCall}
              disabled={saving}
            >
              {saving ? "Saving audio..." : "Leave call"}
            </button>
          </div>

          <div
            ref={audioContainerRef}
            className="audio-container"
            aria-hidden="true"
          />

          {error && <p className="error">{error}</p>}
        </section>
      )}

      <footer>Simple, friendly English practice. No login required.</footer>
    </main>
  );
}
