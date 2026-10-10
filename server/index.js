import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { randomBytes } from "crypto";
import multer from "multer";
import path from "path";
import fs from "fs";
import { createClient } from "@supabase/supabase-js";


const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;
const CLIENT_ORIGIN =
  process.env.CLIENT_ORIGIN || "http://localhost:5173";

app.use(express.json());
app.use(cors({ origin: CLIENT_ORIGIN }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Store recordings locally during development.
const recordingsDir = path.resolve("recordings");
fs.mkdirSync(recordingsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, recordingsDir);
  },

  filename: (req, file, cb) => {
    const safe = (value) =>
      String(value || "unknown")
        .replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 50) || "unknown";

    const roomId = safe(req.body.roomId);
    const participantId = safe(req.body.participantId);

    const extension = file.mimetype.includes("ogg")
      ? ".ogg"
      : file.mimetype.includes("mp4")
        ? ".m4a"
        : ".webm";

    cb(
      null,
      `${roomId}_${participantId}_${Date.now()}${extension}`
    );
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) {
      cb(null, true);
    } else {
      cb(new Error("Only audio files are accepted."));
    }
  },
});


const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = process.env.SUPABASE_BUCKET || "recording-chunks";

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

function safePathPart(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 80);
}

app.post(
  "/api/recordings",
  upload.single("audio"),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: "No audio file received.",
      });
    }

    res.status(201).json({
      ok: true,
      filename: req.file.filename,
      message: "Recording saved successfully.",
    });
  }
);

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError &&
      err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: "Recording exceeds the 100 MB limit.",
    });
  }

  res.status(400).json({
    error: err.message || "Upload failed.",
  });
});

// Upload one audio chunk to Supabase Storage
app.post(
  "/api/recordings/chunk",
  chunkUpload.single("audio"),
  async (req, res) => {
    try {
      const roomId = safePathPart(req.body.roomId);
      const participantId = safePathPart(req.body.participantId);
      const sequence = Number(req.body.sequence);

      if (
        !roomId ||
        !participantId ||
        !Number.isInteger(sequence) ||
        sequence < 0 ||
        !req.file
      ) {
        return res.status(400).json({
          error: "Invalid recording chunk",
        });
      }

      const path =
        `${roomId}/${participantId}/` +
        `${String(sequence).padStart(6, "0")}.webm`;

      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(path, req.file.buffer, {
          contentType: "audio/webm",
          upsert: true,
        });

      if (error) throw error;

      res.json({ success: true, sequence });
    } catch (error) {
      console.error("Chunk upload failed:", error.message);
      res.status(500).json({ error: "Could not save audio chunk" });
    }
  }
);

// Verify that all expected chunks have arrived
app.post("/api/recordings/finalize", async (req, res) => {
  try {
    const roomId = safePathPart(req.body.roomId);
    const participantId = safePathPart(req.body.participantId);
    const totalChunks = Number(req.body.totalChunks);

    if (
      !roomId ||
      !participantId ||
      !Number.isInteger(totalChunks) ||
      totalChunks < 0
    ) {
      return res.status(400).json({ error: "Invalid recording details" });
    }

    const folder = `${roomId}/${participantId}`;

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(folder, { limit: 1000 });

    if (error) throw error;

    const uploadedSequences = new Set(
      (data || [])
        .map((item) => item.name)
        .filter((name) => /^\d{6}\.webm$/.test(name))
        .map((name) => Number(name.replace(".webm", "")))
    );

    const missing = [];

    for (let i = 0; i < totalChunks; i++) {
      if (!uploadedSequences.has(i)) missing.push(i);
    }

    if (missing.length > 0) {
      return res.status(409).json({
        error: "Some audio chunks have not uploaded yet",
        missingSequences: missing,
      });
    }

    res.json({
      success: true,
      totalChunks,
      recordingPath: folder,
    });
  } catch (error) {
    console.error("Recording finalization failed:", error.message);
    res.status(500).json({ error: "Could not finalize recording" });
  }
});

const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ["GET", "POST"],
  },
});

const MAX_PARTICIPANTS = 8;
const rooms = new Map();

function makeRoomId() {
  return randomBytes(3).toString("hex").toUpperCase();
}

io.on("connection", (socket) => {
  socket.on("room:create", (callback) => {
    let roomId;

    do {
      roomId = makeRoomId();
    } while (rooms.has(roomId));

    rooms.set(roomId, new Set());

    callback?.({ ok: true, roomId });
  });

  socket.on("room:join", ({ roomId } = {}, callback) => {
    roomId = String(roomId || "").trim().toUpperCase();

    const members = rooms.get(roomId);

    if (!members) {
      return callback?.({
        ok: false,
        error: "Room not found. Ask the host to create it first.",
      });
    }

    if (members.size >= MAX_PARTICIPANTS) {
      return callback?.({
        ok: false,
        error: "Room is full.",
      });
    }

    const existingPeers = [...members];

    members.add(socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.to(roomId).emit("peer:joined", {
      peerId: socket.id,
    });

    callback?.({
      ok: true,
      roomId,
      peers: existingPeers,
    });
  });

  socket.on("webrtc:signal", ({ to, signal } = {}) => {
    if (to && signal) {
      io.to(to).emit("webrtc:signal", {
        from: socket.id,
        signal,
      });
    }
  });

  function leaveRoom() {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const members = rooms.get(roomId);

    socket.leave(roomId);

    if (members) {
      members.delete(socket.id);

      socket.to(roomId).emit("peer:left", {
        peerId: socket.id,
      });

      if (members.size === 0) {
        rooms.delete(roomId);
      }
    }

    socket.data.roomId = null;
  }

  socket.on("room:leave", leaveRoom);
  socket.on("disconnect", leaveRoom);
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
