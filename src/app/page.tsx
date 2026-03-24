"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

type Stage = "idle" | "compressing" | "transcribing" | "generating" | "done" | "error";

interface LogEntry {
  time: string;
  message: string;
  type: "info" | "success" | "warn" | "error" | "ffmpeg";
}

function timestamp() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState("");
  const [progressPct, setProgressPct] = useState<number | null>(null);
  const [transcript, setTranscript] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<"notes" | "transcript">("notes");
  const [dragOver, setDragOver] = useState(false);
  const [compressionInfo, setCompressionInfo] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((message: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => [...prev, { time: timestamp(), message, type }]);
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const handleFile = useCallback((f: File) => {
    const validExts = [".mp4", ".webm", ".mov", ".m4a", ".mp3", ".wav", ".ogg", ".flac"];
    const isValidType = f.type.startsWith("video/") || f.type.startsWith("audio/");
    const isValidExt = validExts.some((ext) => f.name.toLowerCase().endsWith(ext));
    if (!isValidType && !isValidExt) {
      setError("Please upload a video or audio file (MP4, WebM, MOV, M4A, MP3, WAV)");
      return;
    }
    if (f.size > 500 * 1024 * 1024) {
      setError("File too large. Max 500MB.");
      return;
    }
    setFile(f);
    setError("");
    setNotes("");
    setTranscript("");
    setCompressionInfo("");
    setLogs([]);
    setStage("idle");
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }, [handleFile]);

  const loadFFmpeg = async () => {
    if (ffmpegRef.current?.loaded) return ffmpegRef.current;

    addLog("Initializing audio compressor...");
    const ffmpeg = new FFmpeg();

    ffmpeg.on("log", ({ message }) => {
      // Filter noise, keep useful ffmpeg output
      if (message.includes("Duration") || message.includes("size=") || message.includes("time=") || message.includes("Error") || message.includes("error")) {
        addLog(message, "ffmpeg");
      }
    });

    ffmpeg.on("progress", ({ progress: p }) => {
      const pct = Math.round(p * 100);
      setProgressPct(pct);
      if (pct % 20 === 0) {
        addLog(`Compression progress: ${pct}%`);
      }
    });

    // Single-threaded core — no SharedArrayBuffer needed, works in all browsers
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";

    try {
      addLog("Downloading ffmpeg core (~30MB, first time only)...");
      const coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript");
      addLog("Core JS loaded", "success");
      const wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm");
      addLog("WASM loaded", "success");
      addLog("Initializing ffmpeg (this can take 10-20s)...");
      await ffmpeg.load({ coreURL, wasmURL });
      addLog("Audio compressor ready", "success");
    } catch (loadErr) {
      const msg = loadErr instanceof Error ? loadErr.message : String(loadErr);
      addLog(`FFmpeg load failed: ${msg}`, "error");
      throw new Error("Failed to load audio compressor. Your browser may not support SharedArrayBuffer. Try Chrome or Edge.");
    }

    ffmpegRef.current = ffmpeg;
    return ffmpeg;
  };

  const compressAudio = async (inputFile: File): Promise<File> => {
    const ffmpeg = await loadFFmpeg();

    const ext = inputFile.name.substring(inputFile.name.lastIndexOf(".")) || ".mp4";
    const inputName = `input${ext}`;
    const outputName = "output.mp3";

    addLog(`Writing file to memory: ${inputFile.name} (${(inputFile.size / 1024 / 1024).toFixed(1)}MB)`);
    await ffmpeg.writeFile(inputName, await fetchFile(inputFile));

    addLog("Converting to MP3: mono, 64kbps, 16kHz...");
    setProgressPct(0);

    await ffmpeg.exec([
      "-i", inputName,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-b:a", "64k",
      "-f", "mp3",
      outputName,
    ]);

    setProgressPct(null);
    addLog("Conversion complete", "success");

    const data = await ffmpeg.readFile(outputName);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blob = new Blob([data as any], { type: "audio/mpeg" });

    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});

    const compressedName = inputFile.name.replace(/\.[^.]+$/, "") + ".mp3";
    return new File([blob], compressedName, { type: "audio/mpeg" });
  };

  const processFile = async () => {
    if (!file) return;
    setError("");
    setNotes("");
    setTranscript("");
    setCompressionInfo("");
    setLogs([]);
    setShowLogs(true);
    setProgressPct(null);

    addLog(`Starting: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);

    try {
      // Step 1: Compress
      setStage("compressing");
      setProgress("Compressing audio...");

      let fileToUpload = file;
      const originalSizeMB = file.size / (1024 * 1024);

      try {
        fileToUpload = await compressAudio(file);
        const compressedSizeMB = fileToUpload.size / (1024 * 1024);
        const reduction = ((1 - compressedSizeMB / originalSizeMB) * 100).toFixed(0);
        const info = `${originalSizeMB.toFixed(1)}MB → ${compressedSizeMB.toFixed(1)}MB (${reduction}% smaller)`;
        setCompressionInfo(info);
        addLog(info, "success");
      } catch (compressErr) {
        const msg = compressErr instanceof Error ? compressErr.message : String(compressErr);
        addLog(`Compression failed: ${msg}`, "error");
        if (originalSizeMB <= 4) {
          addLog("File small enough to upload directly, skipping compression", "warn");
          setCompressionInfo("Compression unavailable — uploading original");
        } else {
          throw new Error(msg);
        }
      }

      const uploadSizeMB = fileToUpload.size / (1024 * 1024);
      if (uploadSizeMB > 24) {
        throw new Error(`Compressed file is still ${uploadSizeMB.toFixed(1)}MB. Please try a shorter recording.`);
      }
      addLog(`Uploading ${uploadSizeMB.toFixed(1)}MB to transcription service...`);

      // Step 2: Transcribe
      setStage("transcribing");
      setProgress("Transcribing audio...");

      const formData = new FormData();
      formData.append("file", fileToUpload);

      const transcribeRes = await fetch("/api/transcribe", { method: "POST", body: formData });

      let transcribeData;
      const responseText = await transcribeRes.text();
      try {
        transcribeData = JSON.parse(responseText);
      } catch {
        if (responseText.includes("Request Entity") || responseText.includes("too large") || transcribeRes.status === 413) {
          throw new Error("Compressed file still too large for upload. Please try a shorter recording.");
        }
        throw new Error(`Server error: ${responseText.substring(0, 200)}`);
      }

      if (!transcribeRes.ok) {
        throw new Error(transcribeData.error || "Transcription failed");
      }

      const text = transcribeData.text;
      setTranscript(text);
      addLog(`Transcription complete: ${text.split(" ").length} words`, "success");

      // Step 3: Generate Notes
      setStage("generating");
      setProgress("Generating comprehensive notes...");
      addLog("Generating structured notes...");

      const notesRes = await fetch("/api/generate-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: text, filename: file.name }),
      });

      if (!notesRes.ok) {
        const err = await notesRes.json();
        throw new Error(err.error || "Note generation failed");
      }

      const reader = notesRes.body?.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";

      if (reader) {
        setStage("done");
        addLog("Streaming notes...", "success");
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          setNotes(accumulated);
        }
        addLog(`Done! ${accumulated.split("\n").length} lines of notes generated.`, "success");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setStage("error");
      setError(msg);
      addLog(msg, "error");
    }
  };

  const copyForNotion = async () => {
    try {
      await navigator.clipboard.writeText(notes);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = notes;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const downloadMarkdown = () => {
    const blob = new Blob([notes], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${file?.name?.replace(/\.[^.]+$/, "") || "notes"}-notes.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadHTML = () => {
    const container = document.getElementById("notes-content");
    if (!container) return;
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Notes - ${file?.name || "video"}</title>
<style>body{font-family:system-ui,sans-serif;max-width:800px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;line-height:1.7}
h1{font-size:1.5rem;border-bottom:2px solid #eee;padding-bottom:.5rem}
h2{font-size:1.25rem;margin-top:1.5rem;border-bottom:1px solid #eee;padding-bottom:.25rem}
h3{font-size:1.1rem}ul,ol{margin-left:1.25rem}li{margin-bottom:.25rem}
blockquote{border-left:3px solid #6366f1;padding-left:1rem;color:#666;font-style:italic}
strong{color:#111}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:.5rem .75rem;text-align:left}
th{background:#f5f5f5;font-weight:600}</style></head>
<body>${container.innerHTML}</body></html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${file?.name?.replace(/\.[^.]+$/, "") || "notes"}-notes.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const reset = () => {
    setFile(null);
    setStage("idle");
    setProgress("");
    setProgressPct(null);
    setTranscript("");
    setNotes("");
    setError("");
    setCompressionInfo("");
    setLogs([]);
    setShowLogs(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const logColorMap: Record<LogEntry["type"], string> = {
    info: "text-neutral-400",
    success: "text-green-400",
    warn: "text-yellow-400",
    error: "text-red-400",
    ffmpeg: "text-neutral-500",
  };

  const isProcessing = stage === "compressing" || stage === "transcribing" || stage === "generating";

  return (
    <main className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-neutral-800/50 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
                <polyline points="10 9 9 9 8 9"/>
              </svg>
            </div>
            <h1 className="text-lg font-semibold tracking-tight">Noted</h1>
          </div>
          <div className="flex items-center gap-4">
            {logs.length > 0 && (
              <button
                onClick={() => setShowLogs(!showLogs)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors ${
                  showLogs ? "bg-neutral-800 text-neutral-200" : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${isProcessing ? "bg-indigo-500 animate-pulse" : stage === "error" ? "bg-red-500" : "bg-green-500"}`} />
                Logs ({logs.length})
              </button>
            )}
            <span className="text-xs text-neutral-500">Video & Audio to Notes</span>
          </div>
        </div>
      </header>

      <div className="flex-1 flex max-w-6xl mx-auto w-full">
        {/* Main content */}
        <div className={`flex-1 px-6 py-8 transition-all ${showLogs ? "pr-0" : ""}`}>
          {/* Upload Area */}
          {stage === "idle" && !notes && (
            <div className="flex flex-col items-center justify-center min-h-[60vh]">
              <div
                onDrop={handleDrop}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onClick={() => fileInputRef.current?.click()}
                className={`w-full max-w-lg border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all duration-200 ${
                  dragOver
                    ? "border-indigo-500 bg-indigo-500/5"
                    : file
                    ? "border-neutral-600 bg-neutral-900/50"
                    : "border-neutral-700 hover:border-neutral-500 hover:bg-neutral-900/30"
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*,audio/*,.mp4,.webm,.mov,.m4a,.mp3,.wav,.ogg,.flac"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
                />
                {file ? (
                  <div>
                    <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-indigo-600/10 flex items-center justify-center">
                      {file.type.startsWith("audio/") || file.name.match(/\.(m4a|mp3|wav|ogg|flac)$/i) ? (
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                        </svg>
                      ) : (
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                        </svg>
                      )}
                    </div>
                    <p className="text-sm font-medium text-neutral-200 truncate">{file.name}</p>
                    <p className="text-xs text-neutral-500 mt-1">{formatFileSize(file.size)}</p>
                    <p className="text-xs text-neutral-600 mt-3">Click to change file</p>
                  </div>
                ) : (
                  <div>
                    <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-neutral-800 flex items-center justify-center">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#737373" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="17 8 12 3 7 8"/>
                        <line x1="12" y1="3" x2="12" y2="15"/>
                      </svg>
                    </div>
                    <p className="text-sm text-neutral-400">Drop a video or audio file here or click to browse</p>
                    <p className="text-xs text-neutral-600 mt-2">Any size — auto-compressed in your browser</p>
                  </div>
                )}
              </div>

              {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

              {file && (
                <button
                  onClick={processFile}
                  className="mt-6 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  Generate Notes
                </button>
              )}
            </div>
          )}

          {/* Processing */}
          {isProcessing && !notes && (
            <div className="flex flex-col items-center justify-center min-h-[60vh]">
              <div className="relative w-16 h-16 mb-6">
                {progressPct !== null ? (
                  <svg className="w-16 h-16 -rotate-90" viewBox="0 0 64 64">
                    <circle cx="32" cy="32" r="28" fill="none" stroke="#262626" strokeWidth="4" />
                    <circle
                      cx="32" cy="32" r="28" fill="none" stroke="#6366f1" strokeWidth="4"
                      strokeDasharray={`${2 * Math.PI * 28}`}
                      strokeDashoffset={`${2 * Math.PI * 28 * (1 - progressPct / 100)}`}
                      strokeLinecap="round"
                      className="transition-all duration-300"
                    />
                  </svg>
                ) : (
                  <>
                    <div className="absolute inset-0 rounded-full border-2 border-neutral-800"/>
                    <div className="absolute inset-0 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin"/>
                  </>
                )}
                {progressPct !== null && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-xs font-medium text-neutral-300">{progressPct}%</span>
                  </div>
                )}
              </div>
              <p className="text-sm font-medium text-neutral-300">{progress}</p>
              <p className="text-xs text-neutral-600 mt-2">
                {stage === "compressing"
                  ? "Converting to optimized MP3 in your browser"
                  : stage === "transcribing"
                  ? "This may take a minute for longer recordings"
                  : "Analyzing transcript and structuring notes"}
              </p>
              {compressionInfo && (
                <p className="text-xs text-indigo-400 mt-3">{compressionInfo}</p>
              )}
            </div>
          )}

          {/* Error */}
          {stage === "error" && (
            <div className="flex flex-col items-center justify-center min-h-[60vh]">
              <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mb-4">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="15" y1="9" x2="9" y2="15"/>
                  <line x1="9" y1="9" x2="15" y2="15"/>
                </svg>
              </div>
              <p className="text-sm text-red-400 mb-4 max-w-md text-center">{error}</p>
              <button onClick={reset} className="text-sm text-neutral-400 hover:text-neutral-200 underline underline-offset-4">
                Try again
              </button>
            </div>
          )}

          {/* Results */}
          {(stage === "done" || notes) && (
            <div>
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-4">
                  <div className="flex gap-1 bg-neutral-900 rounded-lg p-1">
                    <button
                      onClick={() => setActiveTab("notes")}
                      className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
                        activeTab === "notes" ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"
                      }`}
                    >
                      Notes
                    </button>
                    <button
                      onClick={() => setActiveTab("transcript")}
                      className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
                        activeTab === "transcript" ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"
                      }`}
                    >
                      Transcript
                    </button>
                  </div>
                  {compressionInfo && (
                    <span className="text-xs text-neutral-600">{compressionInfo}</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={copyForNotion}
                    className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                      copied ? "bg-green-600/20 text-green-400 border border-green-600/30" : "bg-indigo-600 hover:bg-indigo-500 text-white"
                    }`}
                  >
                    {copied ? "Copied!" : "Copy for Notion"}
                  </button>
                  <button onClick={downloadMarkdown} className="px-3 py-1.5 text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-md transition-colors">
                    Download .md
                  </button>
                  <button onClick={downloadHTML} className="px-3 py-1.5 text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-md transition-colors">
                    Download .html
                  </button>
                  <button onClick={reset} className="px-3 py-1.5 text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-md transition-colors">
                    New Video
                  </button>
                </div>
              </div>

              {activeTab === "notes" ? (
                <div id="notes-content" className="prose-notes bg-neutral-900/50 border border-neutral-800/50 rounded-xl p-8">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{notes}</ReactMarkdown>
                </div>
              ) : (
                <div className="bg-neutral-900/50 border border-neutral-800/50 rounded-xl p-8">
                  <p className="text-sm text-neutral-400 leading-relaxed whitespace-pre-wrap">{transcript}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Log Sidebar */}
        {showLogs && (
          <div className="w-80 border-l border-neutral-800/50 flex flex-col bg-neutral-950/80">
            <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800/50">
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${isProcessing ? "bg-indigo-500 animate-pulse" : stage === "error" ? "bg-red-500" : stage === "done" ? "bg-green-500" : "bg-neutral-600"}`} />
                <span className="text-xs font-medium text-neutral-300">Activity Log</span>
              </div>
              <button
                onClick={() => setShowLogs(false)}
                className="text-neutral-600 hover:text-neutral-400 transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1">
              {logs.map((log, i) => (
                <div key={i} className="flex gap-2 text-xs font-mono">
                  <span className="text-neutral-600 shrink-0">{log.time}</span>
                  <span className={logColorMap[log.type]}>{log.message}</span>
                </div>
              ))}
              {logs.length === 0 && (
                <p className="text-xs text-neutral-600 text-center mt-4">No activity yet</p>
              )}
              <div ref={logEndRef} />
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
