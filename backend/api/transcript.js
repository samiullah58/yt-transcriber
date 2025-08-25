import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import { pipeline } from "stream/promises";
import ytdl from "@distube/ytdl-core";

/* ------------- CORS ------------- */
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "X-Transcript-Source, Content-Disposition");
}

/* ------------- Helpers ------------- */
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
function guessExt(fmt) {
  const c = (fmt?.container || "").toLowerCase();
  if (c) return c;
  const mt = (fmt?.mimeType || "").toLowerCase();
  if (mt.includes("webm") || mt.includes("opus")) return "webm";
  if (mt.includes("mp4") || mt.includes("m4a") || mt.includes("aac")) return "m4a";
  if (mt.includes("mpeg")) return "mp3";
  if (mt.includes("ogg")) return "ogg";
  return "webm";
}

/* Try getInfo with different YouTube clients to avoid 410 */
async function getInfoRobust(url, headers, debug) {
  // Preferred order: ANDROID → WEB
  const clients = ["ANDROID", "WEB"];
  let lastErr;

  for (const client of clients) {
    try {
      // @distube/ytdl-core exposes setDefaultClient at runtime (safe to call)
      ytdl.setDefaultClient?.(client);
      const info = await ytdl.getInfo(url, { requestOptions: { headers } });
      if (debug) console.log(`[ytdl] getInfo ok via ${client}`);
      return info;
    } catch (e) {
      lastErr = e;
      if (debug) console.error(`[ytdl] getInfo failed via ${client}:`, e?.message || e);
      // try next client
    }
  }
  throw lastErr || new Error("getInfo failed");
}

/* ------------- Handler ------------- */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    return res.status(204).end();
  }
  setCors(res);

  const debug = String(req.query?.debug || "").toLowerCase() === "1";

  try {
    const { url, format = "txt", lang = "", wrap } = req.query || {};
    if (!url) return res.status(400).json({ error: "Provide ?url=" });

    const normalizedUrl = normalizeYouTubeUrl(url);
    const videoId = extractVideoId(normalizedUrl);
    if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL" });

    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: "OPENAI_API_KEY is missing in project env" });
    }

    // ytdl-core validation
    if (!ytdl.validateURL(normalizedUrl)) {
      return res.status(400).json({ error: "Invalid or unsupported YouTube URL" });
    }

    // Realistic headers help in serverless regions
    const headers = {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
      "referer": "https://www.youtube.com/"
    };

    // 1) Robust info fetch (ANDROID → WEB)
    let info;
    try {
      info = await getInfoRobust(normalizedUrl, headers, debug);
    } catch (e) {
      const msg = e?.message || String(e);
      console.error("[ytdl] getInfo failed (all clients):", msg);
      return res.status(502).json({ error: `ytdl getInfo failed: ${msg}`, ...(debug ? { stack: e?.stack } : {}) });
    }

    // 2) Choose best audio
    const formatChosen = ytdl.chooseFormat(info.formats, { quality: "highestaudio", filter: "audioonly" });
    if (!formatChosen || (!formatChosen.url && !formatChosen.signatureCipher)) {
      return res.status(502).json({ error: "No suitable audio format found from YouTube." });
    }

    // 3) Save audio to /tmp
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yta-"));
    const ext = guessExt(formatChosen);
    const filePath = path.join(tmpDir, `audio.${ext}`);

    try {
      const readStream = ytdl.downloadFromInfo(info, {
        format: formatChosen,
        requestOptions: { headers },
        highWaterMark: 1 << 25 // 32MB
      });
      await pipeline(readStream, fs.createWriteStream(filePath));
    } catch (e) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      const msg = e?.message || String(e);
      console.error("[ytdl] download failed:", msg);
      return res.status(502).json({ error: `Audio download failed: ${msg}`, ...(debug ? { stack: e?.stack } : {}) });
    }

    // 4) Whisper
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const responseFormat = format === "srt" ? "srt" : "text";
    let tr;
    try {
      tr = await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: "whisper-1",
        response_format: responseFormat,
        language: lang || undefined
      });
    } catch (e) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      const msg = e?.message || String(e);
      console.error("[openai] transcription failed:", msg);
      return res.status(500).json({ error: msg, ...(debug ? { stack: e?.stack } : {}) });
    }

    // 5) Cleanup & respond
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    res.setHeader("X-Transcript-Source", "openai");
    res.setHeader("Content-Disposition", `attachment; filename="${videoId}.${responseFormat === "srt" ? "srt" : "txt"}"`);
    if (wrap === "json") {
      return res.json({ source: "openai", videoId, format: responseFormat === "srt" ? "srt" : "txt", text: tr });
    }
    return res.type("text/plain").send(tr);

  } catch (e) {
    console.error("[handler] error", e?.message || e);
    const payload = { error: e?.message || "Transcription failed" };
    if (debug) payload.stack = e?.stack;
    return res.status(500).json(payload);
  }
}
