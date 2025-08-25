import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import { pipeline } from "stream/promises";

/* ---------------- CORS ---------------- */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "X-Transcript-Source, Content-Disposition");
}

/* ---------------- Helpers ---------------- */
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

/* ------------- Configurable Piped instances ------------- */
/** You can override with a CSV env var:
 *   PIPED_API_BASES="https://pipedapi.kavin.rocks,https://pipedapi.tokhmi.xyz"
 */
const DEFAULT_PIPED_BASES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.tokhmi.xyz",
  "https://pipedapi.projectsegfau.lt",
  "https://pipedapi.lunar.icu",
  "https://pipedapi.12a.app",
  "https://piped-api.game.yt"
];
const PIPED_API_BASES = (process.env.PIPED_API_BASES || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const PIPED_BASES = PIPED_API_BASES.length ? PIPED_API_BASES : DEFAULT_PIPED_BASES;

const DEFAULT_TIMEOUT_STREAMS_MS = parseInt(process.env.PIPED_TIMEOUT_MS || "9000", 10) || 9000;
const DEFAULT_TIMEOUT_AUDIO_MS   = parseInt(process.env.AUDIO_TIMEOUT_MS || "20000", 10) || 20000;

const DEBUG_ENV = String(process.env.DEBUG || "").toLowerCase() === "1";

/* ------------- Piped ------------- */
async function getPipedStreamsFrom(baseUrl, videoId, timeoutMs) {
  const url = `${baseUrl.replace(/\/+$/,"")}/api/v1/streams/${videoId}`;
  const { signal, clear } = toMsTimeout(timeoutMs);
  try {
    const r = await fetch(url, {
      signal,
      headers: {
        "user-agent": "Mozilla/5.0",
        "accept": "application/json"
      },
      redirect: "follow",
      cache: "no-store"
    });
    const text = await r.text();
    if (!r.ok) {
      throw new Error(`HTTP ${r.status} ${r.statusText}: ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response from ${baseUrl} (len=${text.length})`);
    }
  } finally {
    clear();
  }
}

async function getPipedStreams(videoId, timeoutMs, attemptsLog) {
  let lastErr = null;
  for (const base of PIPED_BASES) {
    try {
      const json = await getPipedStreamsFrom(base, videoId, timeoutMs);
      attemptsLog.push({ base, ok: true });
      return json;
    } catch (e) {
      attemptsLog.push({ base, ok: false, error: String(e?.message || e) });
      console.error("[piped] fail", base, e?.message || e);
      lastErr = e;
      // try next
    }
  }
  throw new Error(`Piped streams fetch failed: ${lastErr?.message || "no instances available"}`);
}

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

  return { url: chosen.url, ext, meta: { mime, codec, container, br: chosen.__br } };
}

/* ------------- Handler ------------- */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    return res.status(204).end();
  }
  setCors(res);

  const debug = DEBUG_ENV || String(req.query?.debug || "").toLowerCase() === "1";

  try {
    const { url, format = "txt", lang = "", wrap } = req.query || {};
    if (!url) return res.status(400).json({ error: "Provide ?url=" });

    const normalizedUrl = normalizeYouTubeUrl(url);
    const videoId = extractVideoId(normalizedUrl);
    if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL" });

    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: "OPENAI_API_KEY is missing in project env" });
    }

    const attemptsLog = [];

    // 1) Streams JSON from a working Piped instance
    const streamsJson = await getPipedStreams(videoId, DEFAULT_TIMEOUT_STREAMS_MS, attemptsLog);

    // 2) Choose best audio
    const chosen = pickAudioAndExt(streamsJson);
    if (!chosen?.url) {
      const payload = { error: "No audio streams available from Piped for this video." };
      if (debug) payload.attempts = attemptsLog;
      return res.status(502).json(payload);
    }

    // 3) Download audio to /tmp (with timeout)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yta-"));
    const filePath = path.join(tmpDir, `audio.${chosen.ext}`);

    const { signal, clear } = toMsTimeout(DEFAULT_TIMEOUT_AUDIO_MS);
    try {
      const resp = await fetch(chosen.url, {
        signal,
        headers: {
          "user-agent": "Mozilla/5.0",
          "accept": "*/*"
        },
        redirect: "follow",
        cache: "no-store"
      });
      if (!resp.ok || !resp.body) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        const payload = { error: `Failed to download audio (${resp.status})` };
        if (debug) payload.attempts = attemptsLog;
        return res.status(502).json(payload);
      }
      await pipeline(resp.body, fs.createWriteStream(filePath));
    } finally {
      clear();
    }

    // 4) OpenAI Whisper
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const responseFormat = format === "srt" ? "srt" : "text";
      const tr = await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: "whisper-1",
        response_format: responseFormat,
        language: lang || undefined
      });

      // Cleanup
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
          text: tr,
          ...(debug ? { chosen } : {})
        });
      }
      return res.type("text/plain").send(tr);
    } catch (e) {
      console.error("[openai] transcription failed", e?.message || e);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      const payload = { error: e?.message || "Transcription failed" };
      if (debug) payload.attempts = attemptsLog;
      return res.status(500).json(payload);
    }

  } catch (e) {
    console.error("[handler] error", e?.message || e);
    const payload = { error: e?.message || "Transcription failed" };
    if (DEBUG_ENV || String(req.query?.debug || "").toLowerCase() === "1") {
      payload.stack = e?.stack;
    }
    return res.status(500).json(payload);
  }
}
