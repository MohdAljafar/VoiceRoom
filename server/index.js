import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { randomBytes } from "crypto";
import multer from "multer";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { createClient } from "@supabase/supabase-js";
import {
  GoogleGenAI,
  createUserContent,
  createPartFromUri,
} from "@google/genai";

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3001);
const CLIENT_ORIGIN = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim());
const BUCKET = process.env.SUPABASE_BUCKET || "recording-chunks";
const ANALYSIS_MODEL = process.env.GEMINI_ANALYSIS_MODEL || "gemini-2.5-flash";

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Recording endpoints will not work until configured.",
  );
}
if (!process.env.GEMINI_API_KEY)
  console.warn(
    "Missing GEMINI_API_KEY. Analysis endpoint will not work until configured.",
  );

const supabase = createClient(
  process.env.SUPABASE_URL || "https://example.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "missing-service-role-key",
);
const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "missing-gemini-api-key",
});
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) cb(null, true);
    else cb(new Error("Only audio files are accepted."));
  },
});

function normalizeUsername(value) {
  const username = String(value || "")
    .trim()
    .toLowerCase();
  return /^[a-z0-9_]{3,20}$/.test(username) ? username : null;
}
function isValidSessionId(value) {
  return /^\d{13}_[a-z0-9]{6}$/.test(String(value || ""));
}
function recordingError(res, status, error) {
  return res.status(status).json({ error });
}

// Save one recording chunk to: username/sessionId/000000.webm
app.post(
  "/api/recordings/chunk",
  chunkUpload.single("audio"),
  async (req, res) => {
    try {
      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return recordingError(
          res,
          503,
          "Recording storage is not configured on the server.",
        );
      }
      const username = normalizeUsername(req.body.username);
      const sessionId = String(req.body.sessionId || "");
      const sequence = Number(req.body.sequence);
      if (
        !username ||
        !isValidSessionId(sessionId) ||
        !Number.isInteger(sequence) ||
        sequence < 0 ||
        sequence > 999999 ||
        !req.file
      ) {
        return recordingError(res, 400, "Invalid recording chunk details.");
      }
      const objectPath = `${username}/${sessionId}/${String(sequence).padStart(6, "0")}.webm`;
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(objectPath, req.file.buffer, {
          contentType: "audio/webm",
          upsert: true,
        });
      if (error) throw error;
      return res.json({ success: true, sequence });
    } catch (error) {
      console.error("Chunk upload failed:", error);
      return recordingError(res, 500, "Could not save audio chunk.");
    }
  },
);

// Verify chunks and mark this session as the user's latest completed recording.
app.post("/api/recordings/finalize", async (req, res) => {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return recordingError(
        res,
        503,
        "Recording storage is not configured on the server.",
      );
    }
    const username = normalizeUsername(req.body.username);
    const sessionId = String(req.body.sessionId || "");
    const totalChunks = Number(req.body.totalChunks);
    if (
      !username ||
      !isValidSessionId(sessionId) ||
      !Number.isInteger(totalChunks) ||
      totalChunks < 1 ||
      totalChunks > 1000
    ) {
      return recordingError(res, 400, "Invalid recording details.");
    }

    const folder = `${username}/${sessionId}`;
    const { data: files, error: listError } = await supabase.storage
      .from(BUCKET)
      .list(folder, { limit: 1000 });
    if (listError) throw listError;
    const sequences = new Set(
      (files || [])
        .map((file) => file.name)
        .filter((name) => /^\d{6}\.webm$/.test(name))
        .map((name) => Number(name.slice(0, 6))),
    );
    const missing = [];
    for (let i = 0; i < totalChunks; i++)
      if (!sequences.has(i)) missing.push(i);
    if (missing.length)
      return res
        .status(409)
        .json({
          error: "Some audio chunks have not uploaded yet.",
          missingSequences: missing,
        });

    const latest = {
      sessionId,
      totalChunks,
      completedAt: new Date().toISOString(),
    };
    const { error: indexError } = await supabase.storage
      .from(BUCKET)
      .upload(`${username}/_latest.json`, Buffer.from(JSON.stringify(latest)), {
        contentType: "application/json",
        upsert: true,
      });
    if (indexError) throw indexError;
    return res.json({
      success: true,
      totalChunks,
      sessionId,
      message: "Recording saved successfully.",
    });
  } catch (error) {
    console.error("Recording finalization failed:", error);
    return recordingError(res, 500, "Could not finalize recording.");
  }
});

app.post("/api/recordings/analyze-latest", async (req, res) => {
  let tempPath = null;
  let geminiFileName = null;
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return recordingError(
        res,
        503,
        "Recording storage is not configured on the server.",
      );
    }
    if (!process.env.GEMINI_API_KEY)
      return recordingError(
        res,
        503,
        "Gemini analysis is not configured on the server.",
      );

    const username = normalizeUsername(req.body.username);
    if (!username)
      return recordingError(
        res,
        400,
        "Enter a valid username (3–20 letters, numbers, or underscores).",
      );

    const { data: latestBlob, error: latestError } = await supabase.storage
      .from(BUCKET)
      .download(`${username}/_latest.json`);
    if (latestError || !latestBlob)
      return recordingError(
        res,
        404,
        "No saved recording found for this username. Complete a voice session first.",
      );

    let latest;
    try {
      latest = JSON.parse(await latestBlob.text());
    } catch {
      return recordingError(
        res,
        500,
        "Could not read the latest recording details.",
      );
    }

    const sessionId = String(latest.sessionId || "");
    const totalChunks = Number(latest.totalChunks);
    if (
      !isValidSessionId(sessionId) ||
      !Number.isInteger(totalChunks) ||
      totalChunks < 1 ||
      totalChunks > 1000
    ) {
      return recordingError(
        res,
        500,
        "The saved recording details are invalid.",
      );
    }

    const folder = `${username}/${sessionId}`;
    const { data: files, error: listError } = await supabase.storage
      .from(BUCKET)
      .list(folder, { limit: 1000 });
    if (listError) throw listError;
    const fileMap = new Map(
      (files || [])
        .filter((file) => /^\d{6}\.webm$/.test(file.name))
        .map((file) => [Number(file.name.slice(0, 6)), file.name]),
    );
    const buffers = [];
    for (let i = 0; i < totalChunks; i++) {
      const name = fileMap.get(i);
      if (!name)
        return recordingError(
          res,
          409,
          `Audio chunk ${i} is missing. Please record another session.`,
        );
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .download(`${folder}/${name}`);
      if (error || !data)
        throw error || new Error(`Could not download chunk ${i}.`);
      buffers.push(Buffer.from(await data.arrayBuffer()));
    }

    const completeAudio = Buffer.concat(buffers);
    if (!completeAudio.length)
      return recordingError(
        res,
        400,
        "The saved recording is empty. Please record again.",
      );
    tempPath = path.join(
      os.tmpdir(),
      `english-analysis-${randomBytes(12).toString("hex")}.webm`,
    );
    await fs.writeFile(tempPath, completeAudio);

    const uploadedFile = await genAI.files.upload({
      file: tempPath,
      config: {
        mimeType: "audio/webm",
        displayName: `English practice ${username}`,
      },
    });
    geminiFileName = uploadedFile.name;
    if (!uploadedFile.uri || !uploadedFile.mimeType)
      throw new Error("Gemini did not return a valid uploaded audio file.");

    const prompt = `You are a practical, supportive English speaking coach. Analyze only the learner's intelligible speech in the attached audio. Return ONLY valid JSON, with no Markdown fences or text outside JSON, using exactly this structure:
{
  "speechDetected": true,
  "noSpeechMessage": "",
  "mistakes": [{"original":"Exact incorrect sentence spoken","correction":"Correct sentence","reason":"Short explanation"}],
  "suggestions": [{"original":"Exact sentence spoken","naturalVersion":"More natural conversational version","reason":"Why it sounds more natural"}]
}
Rules:
- Only two feedback categories: mistakes and suggestions.
- Mistakes must be genuine grammar, vocabulary, or sentence-structure errors that are incorrect, confusing, or change meaning. Do not flag acceptable informal spoken English, accent, pauses, repetitions, or harmless fragments.
- Suggestions are optional naturalness improvements, not corrections of acceptable English. Avoid unnecessary suggestions.
- Quote only what the learner actually said. Never invent sentences or infer unclear words.
- If there is insufficient intelligible speech, set speechDetected=false, provide a helpful noSpeechMessage asking the user to record again and speak clearly, and return empty mistakes and suggestions arrays.
- If speech is intelligible but no mistakes qualify, return an empty mistakes array. If no useful suggestions qualify, return an empty suggestions array.
- When speechDetected=true, noSpeechMessage must be an empty string.
- Keep reasons concise and learner-friendly. Do not include extra keys.`;

    const response = await genAI.models.generateContent({
      model: ANALYSIS_MODEL,
      contents: createUserContent([
        createPartFromUri(uploadedFile.uri, uploadedFile.mimeType),
        prompt,
      ]),
      config: { responseMimeType: "application/json" },
    });
    const responseText = response.text;
    if (!responseText) throw new Error("Gemini returned an empty analysis.");
    let analysis;
    try {
      analysis = JSON.parse(responseText);
    } catch {
      console.error("Gemini returned invalid JSON:", responseText);
      throw new Error("Could not interpret the analysis. Please try again.");
    }
    if (
      typeof analysis.speechDetected !== "boolean" ||
      !Array.isArray(analysis.mistakes) ||
      !Array.isArray(analysis.suggestions)
    ) {
      throw new Error("Gemini returned an unexpected analysis format.");
    }
    if (!analysis.speechDetected) {
      analysis.mistakes = [];
      analysis.suggestions = [];
      analysis.noSpeechMessage ||=
        "I couldn't detect enough clear speech to analyze your English. Please record again and speak clearly.";
    }
    return res.json({
      success: true,
      username,
      sessionId,
      analysis,
      audioSizeBytes: completeAudio.length,
    });
  } catch (error) {
    console.error("Latest recording analysis failed:", error);
    return recordingError(
      res,
      500,
      error.message ||
        "Could not analyze your latest recording. Please try again.",
    );
  } finally {
    if (tempPath) await fs.unlink(tempPath).catch(() => {});
    if (geminiFileName)
      await genAI.files
        .delete({ name: geminiFileName })
        .catch((error) =>
          console.error(
            "Could not delete temporary Gemini file:",
            error.message,
          ),
        );
  }
});

// Multer and unexpected API errors
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res
      .status(413)
      .json({ error: "Audio chunk exceeds the 5 MB limit." });
  }
  console.error("Request error:", err);
  return res.status(400).json({ error: err.message || "Request failed." });
});

// Socket.IO handles room signaling only; audio travels peer-to-peer via WebRTC.
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN, methods: ["GET", "POST"] },
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
    roomId = String(roomId || "")
      .trim()
      .toUpperCase();
    const members = rooms.get(roomId);
    if (!members)
      return callback?.({
        ok: false,
        error: "Room not found. Ask the host to create it first.",
      });
    if (members.has(socket.id))
      return callback?.({ ok: false, error: "You are already in this room." });
    if (members.size >= MAX_PARTICIPANTS)
      return callback?.({ ok: false, error: "Room is full." });
    const existingPeers = [...members];
    members.add(socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.to(roomId).emit("peer:joined", { peerId: socket.id });
    callback?.({ ok: true, roomId, peers: existingPeers });
  });

  socket.on("webrtc:signal", ({ to, signal } = {}) => {
    if (to && signal)
      io.to(to).emit("webrtc:signal", { from: socket.id, signal });
  });

  function leaveRoom() {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const members = rooms.get(roomId);
    socket.leave(roomId);
    if (members) {
      members.delete(socket.id);
      socket.to(roomId).emit("peer:left", { peerId: socket.id });
      if (members.size === 0) rooms.delete(roomId);
    }
    socket.data.roomId = null;
  }
  socket.on("room:leave", leaveRoom);
  socket.on("disconnect", leaveRoom);
});

server.listen(PORT, () =>
  console.log(`Voice room server listening on port ${PORT}`),
);
