import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import { pipeline } from "stream/promises";
import ytdlpWrapPkg from "yt-dlp-wrap";

const YTDlpWrap = ytdlpWrapPkg?.default || ytdlpWrapPkg;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
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

/** Choose the correct compiled asset for the current platform/arch */
function getYtDlpAssetInfo() {
  const p = process.platform;
  const a = process.arch;

  if (p === "win32") {
    return { name: "yt-dlp.exe", url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" };
  }
  if (p === "darwin") {
    // Compiled macOS build
    return { name: "yt-dlp_macos", url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos" };
  }
  // Linux
  if (a === "x64") {
    return { name: "yt-dlp_linux", url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" };
  }
  if (a === "arm64") {
    return { name: "yt-dlp_linux_aarch64", url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64" };
  }
  if (a === "arm") {
    return { name: "yt-dlp_linux_armv7l", url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_armv7l" };
  }
  // Fallback to generic (may require python; better to fail loudly than fetch wrong)
  return { name: "yt-dlp_linux", url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" };
}

/** Download the compiled yt-dlp binary to /tmp if missing (no python required) */
async function ensureStandaloneYtDlp() {
  const { name, url } = getYtDlpAssetInfo();
  const binPath = path.join(os.tmpdir(), name);

  if (!fs.existsSync(binPath)) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to download yt-dlp binary (${resp.status}) from ${url}`);
    const file = fs.createWriteStream(binPath);
    await pipeline(resp.body, file);
    if (process.platform !== "win32") {
      fs.chmodSync(binPath, 0o755);
    }
  }
  return binPath;
}

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

    // Ensure **compiled** yt-dlp (no python3)
    const BIN_PATH = await ensureStandaloneYtDlp();
    const ytDlp = new YTDlpWrap(BIN_PATH);

    // Temp dir in /tmp (the only writable path on Vercel)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yta-"));
    const outTemplate = path.join(tmpDir, "audio.%(ext)s");

    // Download best audio; let yt-dlp choose real extension
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

    // Pick supported audio output
    const allowed = new Set(["flac","m4a","mp3","mp4","mpeg","mpga","oga","ogg","wav","webm"]);
    const files = fs.readdirSync(tmpDir)
      .map(f => path.join(tmpDir, f))
      .filter(f => allowed.has(path.extname(f).slice(1).toLowerCase()) && fs.statSync(f).isFile());

    if (!files.length) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return res.status(500).json({ error: "Download produced no supported audio file." });
    }

    // Choose the largest file (usually the best-quality audio)
    const filePath = files
      .map(f => ({ f, s: fs.statSync(f).size }))
      .sort((a, b) => b.s - a.s)[0].f;

    // OpenAI Whisper
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const responseFormat = format === "srt" ? "srt" : "text";

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-1",
      response_format: responseFormat,
      language: lang || undefined, // let Whisper auto-detect if not provided
    });

    // Cleanup temp
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
