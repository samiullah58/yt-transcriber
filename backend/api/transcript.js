import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import { pipeline } from "stream/promises";
import ytdl from "ytdl-core";

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
function guessExt(fmt) {
  const byContainer = fmt?.container && String(fmt.container).toLowerCase();
  if (byContainer) return byContainer;
  const mt = fmt?.mimeType || "";
  // e.g. "audio/webm; codecs=\"opus\"" or "audio/mp4; codecs=\"mp4a.40.2\""
  if (/audio\/webm/i.test(mt) || /opus/i.test(mt)) return "webm";
  if (/audio\/mp4/i.test(mt) || /m4a/i.test(mt) || /aac/i.test(mt)) return "m4a";
  if (/audio\/mpeg/i.test(mt)) return "mp3";
  if (/audio\/ogg/i.test(mt)) return "ogg";
  return "webm";
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

    // Validate URL with ytdl-core first
    if (!ytdl.validateURL(normalizedUrl)) {
      return res.status(400).json({ error: "Invalid or unsupported YouTube URL" });
    }

    // Prepare headers to look like a real browser (helps with some regions)
    const headers = {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      "accept-language": "en-US,en;q=0.9"
    };

    // Fetch info & choose best audio-only format
    let info;
    try {
      info = await ytdl.getInfo(normalizedUrl, { requestOptions: { headers } });
    } catch (e) {
      const msg = e?.message || String(e);
      console.error("[ytdl] getInfo failed:", msg);
      return res.status(502).json({ error: `ytdl getInfo failed: ${msg}`, ...(debug ? { stack: e?.stack } : {}) });
    }

    const formatChosen = ytdl.chooseFormat(info.formats, {
      quality: "highestaudio",
      filter: "audioonly"
    });
    if (!formatChosen || (!formatChosen.url && !formatChosen.signatureCipher)) {
      return res.status(502).json({ error: "No suitable audio format found from YouTube." });
    }

    // Create temp file in /tmp and stream audio into it
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yta-"));
    const ext = guessExt(formatChosen);
    const filePath = path.join(tmpDir, `audio.${ext}`);

    try {
      const readStream = ytdl.downloadFromInfo(info, {
        format: formatChosen,
        requestOptions: { headers },
        highWaterMark: 1 << 25 // 32MB buffer to reduce chunking overhead
      });
      await pipeline(readStream, fs.createWriteStream(filePath));
    } catch (e) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      const msg = e?.message || String(e);
      console.error("[ytdl] download failed:", msg);
      return res.status(502).json({ error: `Audio download failed: ${msg}`, ...(debug ? { stack: e?.stack } : {}) });
    }

    // OpenAI Whisper
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

    // Cleanup & respond
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
    console.error("[handler] error", e?.message || e);
    const payload = { error: e?.message || "Transcription failed" };
    if (String(req.query?.debug || "").toLowerCase() === "1") {
      payload.stack = e?.stack;
    }
    return res.status(500).json(payload);
  }
}
