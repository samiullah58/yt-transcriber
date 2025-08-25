// backend/api/transcript.js
import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import { pipeline } from "stream/promises";

/* ---------- CORS ---------- */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "X-Transcript-Source, Content-Disposition");
}

/* ---------- Helpers ---------- */
function extractVideoId(u) {
  const m =
    u?.match(/[?&]v=([^&]+)/) ||
    u?.match(/youtu\.be\/([^?]+)/) ||
    u?.match(/youtube\.com\/shorts\/([^?]+)/);
  return m ? m[1] : null;
}
function normalizeYouTubeUrl(input) {
  if (!input) return input;
  const v = input.match(/[?&]v=([^&]+)/);
  if (v) return `https://www.youtube.com/watch?v=${v[1]}`;
  const be = input.match(/youtu\.be\/([^?]+)/);
  if (be) return `https://www.youtube.com/watch?v=${be[1]}`;
  const sh = input.match(/youtube\.com\/shorts\/([^?]+)/);
  if (sh) return `https://www.youtube.com/watch?v=${sh[1]}`;
  return input;
}
function toMsTimeout(ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error("timeout")), ms);
  return { signal: ac.signal, clear: () => clearTimeout(t) };
}

/* ---------- Piped config ---------- */
// You can override with a CSV env var, e.g.:
// PIPED_API_BASES="https://pipedapi.kavin.rocks,https://pipedapi.tokhmi.xyz"
const DEFAULT_PIPED_BASES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.tokhmi.xyz",
  "https://pipedapi.12a.app",
  "https://piped-api.game.yt",
  "https://pipedapi.projectsegfau.lt"
];
const PIPED_API_BASES = (process.env.PIPED_API_BASES || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const PIPED_BASES = PIPED_API_BASES.length ? PIPED_API_BASES : DEFAULT_PIPED_BASES;

/* ---------- Piped calls ---------- */
async function getPipedStreamsFrom(baseUrl, videoId, timeoutMs = 9000) {
  const url = `${baseUrl.replace(/\/+$/,"")}/api/v1/streams/${videoId}`;
  const { signal, clear } = toMsTimeout(timeoutMs);
  try {
    const r = await fetch(url, {
      signal,
      headers: {
        "user-agent": "Mozilla/5.0",
        "accept": "application/json"
      },
      redirect: "follow"
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    return json;
  } finally {
    clear();
  }
}

async function getPipedStreams(videoId) {
  let lastErr;
  for (const base of PIPED_BASES) {
    try {
      const json = await getPipedStreamsFrom(base, videoId);
      if (json) return json;
    } catch (e) {
      lastErr = e;
      // try next instance
    }
  }
  throw new Error(`Piped streams fetch failed (${lastErr?.message || "unknown"})`);
}

/* ---------- pick best audio ---------- */
function pickAudioAndExt(streamsJson) {
  const list = streamsJson?.audioStreams || streamsJson?.audio || [];
  if (!Array.isArray(list) || !list.length) return null;

  const sorted = list
    .map(s => {
      let br = 0;
      if (typeof s.bitrate === "number") br = s.bitrate;
      else if (typeof s.bitrate === "string") {
        const m = s.bitrate.match(/(\d+)/);
        if (m) br = parseInt(m[1], 10);
      }
      return { ...s, __br: br };
    })
    .sort((a,b) => (b.__br - a.__br));

  const chosen = sorted[0];
  const mime = (chosen.mimeType || chosen.type || "").toLowerCase();
  const codec = (chosen.codec || "").toLowerCase();
  const container = (chosen.container || "").toLowerCase();

  let ext = "webm";
  if (mime.includes("mp4") || mime.includes("m4a") || container.includes("mp4") || codec.includes("aac")) ext = "m4a";
  else if (mime.includes("mp3")) ext = "mp3";
  else if (mime.includes("ogg") || mime.includes("opus")) ext = "webm";

  return { url: chosen.url, ext };
}

/* ---------- Handler ---------- */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    return res.status(204).end();
  }
  setCors(res);

  try {
    const { url, format = "txt", lang = "", wrap } = req.query || {};
    if (!url) return res.status(400).json({ error: "Provide ?url=" });

    const normalizedUrl = normalizeYouTubeUrl(url);
    const videoId = extractVideoId(normalizedUrl);
    if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL" });

    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: "OPENAI_API_KEY is missing in project env" });
    }

    // 1) Try multiple Piped instances
    const streamsJson = await getPipedStreams(videoId);

    // 2) Choose best audio
    const chosen = pickAudioAndExt(streamsJson);
    if (!chosen?.url) {
      return res.status(502).json({ error: "No audio streams available from Piped for this video." });
    }

    // 3) Download audio to /tmp with a sane timeout per download
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yta-"));
    const filePath = path.join(tmpDir, `audio.${chosen.ext}`);
    const { signal, clear } = toMsTimeout(20000);
    try {
      const resp = await fetch(chosen.url, {
        signal,
        headers: {
          "user-agent": "Mozilla/5.0",
          "accept": "*/*"
        },
        redirect: "follow"
      });
      if (!resp.ok || !resp.body) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        return res.status(502).json({ error: `Failed to download audio (${resp.status})` });
      }
      await pipeline(resp.body, fs.createWriteStream(filePath));
    } finally {
      clear();
    }

    // 4) Transcribe with OpenAI Whisper
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const responseFormat = format === "srt" ? "srt" : "text";
    const tr = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-1",
      response_format: responseFormat,
      language: lang || undefined
    });

    // 5) Clean up & respond
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    res.setHeader("X-Transcript-Source", "openai");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${videoId}.${responseFormat === "srt" ? "srt" : "txt"}"`
    );

    if (wrap === "json") {
      return res.json({
        source: "openai",
        videoId,
        format: responseFormat === "srt" ? "srt" : "txt",
        text: tr
      });
    }
    return res.type("text/plain").send(tr);

  } catch (e) {
    return res.status(500).json({ error: e?.message || "Transcription failed" });
  }
}
