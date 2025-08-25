// backend/index.js
// Local dev server for transcript API (OpenAI-only).
// NOTE: On Vercel, this file is NOT used; backend/api/*.js functions are deployed instead.

import "dotenv/config";
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import os from "os";
import tmp from "tmp";
import OpenAI from "openai";
import ytdlpWrapPkg from "yt-dlp-wrap";

// ---------- Setup ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(
  cors({
    origin: "*",
    exposedHeaders: ["X-Transcript-Source", "Content-Disposition"],
  })
);

const PORT = process.env.PORT || 3001;
const DEFAULT_LANG = process.env.DEFAULT_LANG || ""; // "" = auto-detect

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

// yt-dlp-wrap export compatibility (ESM/CJS)
const YTDlpWrap = ytdlpWrapPkg?.default || ytdlpWrapPkg;

// --- yt-dlp init (use local bin if present; otherwise auto-download to backend/bin) ---
const BIN_DIR = path.join(__dirname, "bin");
const BIN_PATH =
  process.env.YTDLP_PATH ||
  path.join(BIN_DIR, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");

let ytDlp; // assigned after we ensure the binary exists

async function ensureYtDlp() {
  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
  if (!fs.existsSync(BIN_PATH)) {
    console.log(`[yt-dlp] Not found. Downloading to: ${BIN_PATH}`);
    await YTDlpWrap.downloadFromGithub(BIN_PATH);
    if (process.platform !== "win32") fs.chmodSync(BIN_PATH, 0o755);
    console.log("[yt-dlp] Download complete.");
  } else {
    if (process.platform !== "win32") {
      try { fs.chmodSync(BIN_PATH, 0o755); } catch {}
    }
    console.log(`[yt-dlp] Using binary at: ${BIN_PATH}`);
  }
  ytDlp = new YTDlpWrap(BIN_PATH);
}

// ---------- Helpers ----------
function extractVideoId(u) {
  const m =
    u?.match(/[?&]v=([^&]+)/) ||
    u?.match(/youtu\.be\/([^?]+)/) ||
    u?.match(/youtube\.com\/shorts\/([^?]+)/);
  return m ? m[1] : null;
}
function normalizeYouTubeUrl(input) {
  if (!input) return input;
  const vMatch = input.match(/[?&]v=([^&]+)/);
  if (vMatch) return `https://www.youtube.com/watch?v=${vMatch[1]}`;
  const be = input.match(/youtu\.be\/([^?]+)/);
  if (be) return `https://www.youtube.com/watch?v=${be[1]}`;
  const shorts = input.match(/youtube\.com\/shorts\/([^?]+)/);
  if (shorts) return `https://www.youtube.com/watch?v=${shorts[1]}`;
  return input;
}

// ---------- Routes ----------
app.get("/health", (_req, res) => res.json({ ok: true }));

// OpenAI-only transcript: yt-dlp (auto-downloaded) → Whisper → txt/srt
app.get("/transcript", async (req, res) => {
  try {
    const { url, format = "txt", lang = DEFAULT_LANG, wrap } = req.query || {};
    if (!url) return res.status(400).json({ error: "Provide ?url=" });

    const normalizedUrl = normalizeYouTubeUrl(url);
    const videoId = extractVideoId(normalizedUrl);
    if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL" });

    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: "OPENAI_API_KEY is missing in .env" });
    }

    const outExt = format === "srt" ? "srt" : "txt";
    const sendOutput = (data) => {
      res.setHeader("X-Transcript-Source", "openai");
      res.setHeader("Access-Control-Expose-Headers", "X-Transcript-Source, Content-Disposition");
      if (wrap === "json") {
        return res.json({ source: "openai", videoId, format: outExt, text: data });
      }
      res.setHeader("Content-Disposition", `attachment; filename="${videoId}.${outExt}"`);
      return res.type("text/plain").send(data);
    };

    // Ensure yt-dlp is ready
    if (!ytDlp) await ensureYtDlp();

    // Create a temp dir; let yt-dlp pick the correct extension
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yta-"));
    const outTemplate = path.join(tmpDir, "audio.%(ext)s");

    // Download best audio (no ffmpeg required)
    await ytDlp.execPromise([
      "-f", "bestaudio/best",
      "--no-warnings",
      "--no-check-certificate",
      "-o", outTemplate,
      normalizedUrl,
    ]);

    // Pick a supported audio file
    const allowed = new Set(["flac","m4a","mp3","mp4","mpeg","mpga","oga","ogg","wav","webm"]);
    const files = fs.readdirSync(tmpDir)
      .map(f => path.join(tmpDir, f))
      .filter(f => allowed.has(path.extname(f).slice(1).toLowerCase()) && fs.statSync(f).isFile());

    if (!files.length) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return res.status(500).json({ error: "Download produced no supported audio file." });
    }

    const filePath = files
      .map(f => ({ f, s: fs.statSync(f).size }))
      .sort((a, b) => b.s - a.s)[0].f;

    // OpenAI Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-1",
      response_format: outExt === "srt" ? "srt" : "text",
      language: lang || undefined,
    });

    // Cleanup temp
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    return sendOutput(transcription);
  } catch (e) {
    console.error("Transcription failed:", e?.message || e);
    return res.status(500).json({ error: e?.message || "Transcription failed" });
  }
});

// ---------- Start ----------
await ensureYtDlp();

app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
  console.log(
    `Config: DEFAULT_LANG=${DEFAULT_LANG || "(auto)"} | OPENAI_API_KEY=${process.env.OPENAI_API_KEY ? "set" : "missing"}`
  );
});
