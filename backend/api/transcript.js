import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import ytdlpWrapPkg from "yt-dlp-wrap";

const YTDlpWrap = ytdlpWrapPkg?.default || ytdlpWrapPkg;

// --- tiny utils
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*"); // or your frontend domain
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "X-Transcript-Source, Content-Disposition");
}

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

export default async function handler(req, res) {
  // CORS / preflight
  if (req.method === "OPTIONS") {
    cors(res);
    return res.status(204).end();
  }
  cors(res);

  try {
    const { url, format = "txt", lang = "", wrap } = req.query || {};
    if (!url) return res.status(400).json({ error: "Provide ?url=" });

    const normalizedUrl = normalizeYouTubeUrl(url);
    const videoId = extractVideoId(normalizedUrl);
    if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL" });

    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: "OPENAI_API_KEY is missing in project env" });
    }

    // Ensure yt-dlp binary exists in /tmp (the only writable dir on Vercel)
    const BIN_PATH = path.join(
      os.tmpdir(),
      process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
    );
    if (!fs.existsSync(BIN_PATH)) {
      try {
        await YTDlpWrap.downloadFromGithub(BIN_PATH);
        if (process.platform !== "win32") fs.chmodSync(BIN_PATH, 0o755);
      } catch (e) {
        return res.status(500).json({ error: "Failed to download yt-dlp binary" });
      }
    }
    const ytDlp = new YTDlpWrap(BIN_PATH);

    // Create a temp working dir and let yt-dlp pick the correct extension
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yta-"));
    const outTemplate = path.join(tmpDir, "audio.%(ext)s");

    try {
      await ytDlp.execPromise([
        "-f", "bestaudio/best",
        "--no-warnings",
        "--no-check-certificate",
        "-o", outTemplate,
        normalizedUrl,
      ]);
    } catch (e) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return res.status(500).json({ error: `yt-dlp failed: ${e?.message || e}` });
    }

    // Find the produced audio file with a supported extension
    const allowed = new Set(["flac","m4a","mp3","mp4","mpeg","mpga","oga","ogg","wav","webm"]);
    const files = fs.readdirSync(tmpDir)
      .map(f => path.join(tmpDir, f))
      .filter(f => allowed.has(path.extname(f).slice(1).toLowerCase()) && fs.statSync(f).isFile());

    if (!files.length) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return res.status(500).json({ error: "Download produced no supported audio file." });
    }

    // Choose the largest file (usually best quality)
    const filePath = files.map(f => ({ f, s: fs.statSync(f).size }))
                          .sort((a,b) => b.s - a.s)[0].f;

    // OpenAI Whisper
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const responseFormat = format === "srt" ? "srt" : "text";
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-1",
      response_format: responseFormat,
      language: lang || undefined,
    });

    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    // Respond
    res.setHeader("X-Transcript-Source", "openai");
    res.setHeader("Content-Disposition", `attachment; filename="${videoId}.${responseFormat === "srt" ? "srt" : "txt"}"`);
    if (wrap === "json") {
      return res.json({
        source: "openai",
        videoId,
        format: responseFormat === "srt" ? "srt" : "txt",
        text: transcription
      });
    }
    res.type("text/plain").send(transcription);
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Transcription failed" });
  }
}
