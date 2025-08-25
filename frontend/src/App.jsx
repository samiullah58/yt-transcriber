import { useState } from "react";
import "./App.css";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:3001";

export default function App() {
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState("txt"); // txt | srt
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState("");

  const fetchTranscript = async (e) => {
    e.preventDefault();
    setError("");
    setText("");
    if (!url.trim()) {
      setError("Please paste a YouTube link.");
      return;
    }

    setLoading(true);
    try {
      const resp = await fetch(
        `${API_BASE}/transcript?url=${encodeURIComponent(url)}&format=${format}`
      );
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${resp.status}`);
      }
      const t = await resp.text();
      setText(t);
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      alert("Copied to clipboard");
    } catch {
      alert("Copy failed");
    }
  };

  const handleDownload = () => {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `transcript.${format}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="app">
      <h1>YouTube Transcript</h1>

      <form className="form" onSubmit={fetchTranscript}>
        <input
          className="input"
          type="url"
          placeholder="Paste YouTube URL…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button className="button" type="submit" disabled={loading}>
          {loading ? "Working…" : "Get Transcript"}
        </button>
      </form>

      <div className="toolbar">
        <label htmlFor="format">Format:</label>
        <select
          id="format"
          className="select"
          value={format}
          onChange={(e) => setFormat(e.target.value)}
          disabled={loading}
        >
          <option value="txt">TXT</option>
          <option value="srt">SRT</option>
        </select>

        <div className="spacer" />

        <button
          className="ghost"
          type="button"
          onClick={handleCopy}
          disabled={!text || loading}
          title="Copy transcript to clipboard"
        >
          Copy
        </button>
        <button
          className="ghost"
          type="button"
          onClick={handleDownload}
          disabled={!text || loading}
          title="Download transcript file"
        >
          Download
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="skeleton">
          <div className="skel-row w95" />
          <div className="skel-row w80" />
          <div className="skel-row w95" />
          <div className="skel-row w60" />
          <div className="skel-row w95" />
          <div className="skel-row w70" />
          <div className="skel-row w90" />
        </div>
      ) : (
        <pre className="output">{text || "Transcript will appear here…"}</pre>
      )}

      <footer className="footer">
        <span>API:</span>{" "}
        <code>{API_BASE.replace(/^https?:\/\//, "")}/transcript</code>
      </footer>
    </div>
  );
}
