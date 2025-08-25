// backend/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import { pipeline } from "stream/promises";
import ytdl from "@distube/ytdl-core";
import compression from "compression";
import zlib from "zlib"; // <-- add

const app = express();
app.use(cors({ origin: "*", exposedHeaders: ["X-Transcript-Source", "Content-Disposition"] }));
app.use((req, res, next) => {
  // keep connections alive for long jobs
  req.setTimeout(0);
  res.setTimeout(0);
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // hint: don't buffer large bodies
  next();
});
app.use(compression({ threshold: 1024 })); // fine; we'll still force gzip below

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
async function getInfoRobust(url, headers) {
  const clients = (process.env.YTDL_CLIENTS || "ANDROID,IOS,WEB")
    .split(",")
    .map(s => s.trim().toUpperCase());
  let lastErr;
  for (const client of clients) {
    try {
      ytdl.setDefaultClient?.(client);
      return await ytdl.getInfo(url, { requestOptions: { headers } });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("getInfo failed");
}

// helper to ALWAYS gzip the outgoing payload so Cloudflare reads the compressed size
function sendGzippedText(res, filename, text) {
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(String(text), "utf8");
  const gz = zlib.gzipSync(buf, { level: zlib.constants.Z_BEST_COMPRESSION });
  res.setHeader("X-Transcript-Source", "openai");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Encoding", "gzip");
  res.setHeader("Content-Length", String(gz.length));
  res.end(gz);
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/transcript", async (req, res) => {
  const { url, format = "txt", lang = "", wrap } = req.query || {};
  if (!url) return res.status(400).json({ error: "Provide ?url=" });

  const normalizedUrl = normalizeYouTubeUrl(url);
  const videoId = extractVideoId(normalizedUrl);
  if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: "OPENAI_API_KEY is missing in env" });

  if (!ytdl.validateURL(normalizedUrl)) {
    return res.status(400).json({ error: "Invalid or unsupported YouTube URL" });
  }

  // Browser-like headers (+ cookies/token if provided)
  const cookieHeader = process.env.YTDL_COOKIE || "";
  const idToken = process.env.YTDL_ID_TOKEN || "";
  const userAgent =
    process.env.YTDL_UA ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";

  const headers = {
    "user-agent": userAgent,
    "accept-language": "en-US,en;q=0.9",
    referer: `https://www.youtube.com/watch?v=${videoId}`,
    origin: "https://www.youtube.com",
    ...(cookieHeader ? { cookie: cookieHeader } : {}),
    ...(idToken ? { "x-youtube-identity-token": idToken } : {}),
  };

  let info;
  try {
    info = await getInfoRobust(normalizedUrl, headers);
  } catch (e) {
    const msg = e?.message || String(e);
    return res.status(502).json({
      error: `ytdl getInfo failed: ${msg}`,
      hint: cookieHeader
        ? "Cookies may be stale or missing CONSENT/VISITOR_INFO1_LIVE/PREF/YSC. Refresh and redeploy."
        : "Add YTDL_COOKIE env (single-line) and redeploy.",
    });
  }

  const fmt = ytdl.chooseFormat(info.formats, { quality: "highestaudio", filter: "audioonly" });
  if (!fmt || (!fmt.url && !fmt.signatureCipher)) {
    return res.status(502).json({ error: "No suitable audio format found from YouTube." });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yta-"));
  const filePath = path.join(tmpDir, `audio.${guessExt(fmt)}`);

  try {
    const readStream = ytdl.downloadFromInfo(info, {
      format: fmt,
      requestOptions: { headers },
      highWaterMark: 1 << 26, // 64MB buffer
    });
    await pipeline(readStream, fs.createWriteStream(filePath));
  } catch (e) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return res.status(502).json({ error: `Audio download failed: ${e?.message || e}` });
  }

  const openai = new OpenAI({ apiKey });
  const responseFormat = format === "srt" ? "srt" : "text";

  let tr;
  try {
    tr = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-1",
      response_format: responseFormat,
      language: lang || undefined,
    });
  } catch (e) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    return res.status(500).json({ error: e?.message || "Transcription failed" });
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  // If wrap=json, still send gzipped JSON (browser will auto-decompress)
  if (wrap === "json") {
    const payload = JSON.stringify({ source: "openai", videoId, format: responseFormat, text: tr });
    return sendGzippedText(res, `${videoId}.${responseFormat}`, payload);
  }

  // ALWAYS gzip to stay below Cloudflare’s 25 MiB "bytes read" limit
  const filename = `${videoId}.${responseFormat === "srt" ? "srt" : "txt"}`;
  return sendGzippedText(res, filename, tr);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend listening on :${PORT}`));
