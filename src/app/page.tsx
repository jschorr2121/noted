"use client";

import { useState, useCallback, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

type Stage = "idle" | "uploading" | "compressing" | "transcribing" | "generating" | "done" | "error";

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState("");
  const [transcript, setTranscript] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<"notes" | "transcript">("notes");
  const [dragOver, setDragOver] = useState(false);
  const [compressionInfo, setCompressionInfo] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ffmpegRef = useRef<FFmpeg | null>(null);

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
    const ffmpeg = new FFmpeg();
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
    });
    ffmpegRef.current = ffmpeg;
    return ffmpeg;
  };

  const compressAudio = async (inputFile: File): Promise<File> => {
    const ffmpeg = await loadFFmpeg();

    const inputName = "input" + inputFile.name.substring(inputFile.name.lastIndexOf("."));
    const outputName = "output.mp3";

    await ffmpeg.writeFile(inputName, await fetchFile(inputFile));

    // Convert to mono MP3 at 64kbps, 16kHz (optimal for Whisper)
    await ffmpeg.exec([
      "-i", inputName,
      "-vn",                    // strip video
      "-ac", "1",               // mono
      "-ar", "16000",           // 16kHz sample rate
      "-b:a", "64k",            // 64kbps bitrate
      "-f", "mp3",
      outputName,
    ]);

    const data = await ffmpeg.readFile(outputName);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blob = new Blob([data as any], { type: "audio/mpeg" });

    // Cleanup
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

    try {
      // Step 1: Compress audio in browser
      setStage("compressing");
      setProgress("Loading audio compressor...");

      let fileToUpload = file;
      const originalSizeMB = file.size / (1024 * 1024);

      // Always compress — extracts audio from video, converts to optimized MP3
      try {
        setProgress("Compressing audio...");
        fileToUpload = await compressAudio(file);
        const compressedSizeMB = fileToUpload.size / (1024 * 1024);
        const reduction = ((1 - compressedSizeMB / originalSizeMB) * 100).toFixed(0);
        setCompressionInfo(
          `${originalSizeMB.toFixed(1)}MB → ${compressedSizeMB.toFixed(1)}MB (${reduction}% smaller)`
        );
      } catch (compressErr) {
        console.warn("Compression failed, uploading original:", compressErr);
        // If compression fails and file is small enough, try original
        if (originalSizeMB > 4) {
          throw new Error("Could not compress file. Please try a smaller file or convert to MP3 first.");
        }
      }

      // Check compressed size
      const uploadSizeMB = fileToUpload.size / (1024 * 1024);
      if (uploadSizeMB > 24) {
        throw new Error(`Compressed file is still ${uploadSizeMB.toFixed(1)}MB. Please try a shorter recording.`);
      }

      // Step 2: Transcribe
      setStage("transcribing");
      setProgress("Transcribing audio...");

      const formData = new FormData();
      formData.append("file", fileToUpload);

      const transcribeRes = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
      });

      let transcribeData;
      const responseText = await transcribeRes.text();
      try {
        transcribeData = JSON.parse(responseText);
      } catch {
        if (responseText.includes("Request Entity") || responseText.includes("too large") || transcribeRes.status === 413) {
          throw new Error("Compressed file still too large for upload. Please try a shorter recording.");
        }
        throw new Error(`Server error: ${responseText.substring(0, 100)}`);
      }

      if (!transcribeRes.ok) {
        throw new Error(transcribeData.error || "Transcription failed");
      }

      const text = transcribeData.text;
      setTranscript(text);

      // Step 3: Generate Notes
      setStage("generating");
      setProgress("Generating comprehensive notes...");

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
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          setNotes(accumulated);
        }
      }
    } catch (err) {
      setStage("error");
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  };

  const [copied, setCopied] = useState(false);

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
    setTranscript("");
    setNotes("");
    setError("");
    setCompressionInfo("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <main className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-neutral-800/50 px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
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
          <span className="text-xs text-neutral-500">Video & Audio to Notes</span>
        </div>
      </header>

      <div className="flex-1 max-w-4xl mx-auto w-full px-6 py-8">
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

            {error && (
              <p className="mt-4 text-sm text-red-400">{error}</p>
            )}

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
        {(stage === "compressing" || stage === "transcribing" || stage === "generating") && !notes && (
          <div className="flex flex-col items-center justify-center min-h-[60vh]">
            <div className="relative w-12 h-12 mb-6">
              <div className="absolute inset-0 rounded-full border-2 border-neutral-800"/>
              <div className="absolute inset-0 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin"/>
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
            <p className="text-sm text-red-400 mb-4">{error}</p>
            <button onClick={reset} className="text-sm text-neutral-400 hover:text-neutral-200 underline underline-offset-4">
              Try again
            </button>
          </div>
        )}

        {/* Results */}
        {(stage === "done" || notes) && (
          <div>
            {/* Tabs + Actions */}
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-4">
                <div className="flex gap-1 bg-neutral-900 rounded-lg p-1">
                  <button
                    onClick={() => setActiveTab("notes")}
                    className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
                      activeTab === "notes"
                        ? "bg-neutral-800 text-neutral-100"
                        : "text-neutral-500 hover:text-neutral-300"
                    }`}
                  >
                    Notes
                  </button>
                  <button
                    onClick={() => setActiveTab("transcript")}
                    className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
                      activeTab === "transcript"
                        ? "bg-neutral-800 text-neutral-100"
                        : "text-neutral-500 hover:text-neutral-300"
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
                    copied
                      ? "bg-green-600/20 text-green-400 border border-green-600/30"
                      : "bg-indigo-600 hover:bg-indigo-500 text-white"
                  }`}
                >
                  {copied ? "Copied!" : "Copy for Notion"}
                </button>
                <button
                  onClick={downloadMarkdown}
                  className="px-3 py-1.5 text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-md transition-colors"
                >
                  Download .md
                </button>
                <button
                  onClick={downloadHTML}
                  className="px-3 py-1.5 text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-md transition-colors"
                >
                  Download .html
                </button>
                <button
                  onClick={reset}
                  className="px-3 py-1.5 text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-md transition-colors"
                >
                  New Video
                </button>
              </div>
            </div>

            {/* Content */}
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
    </main>
  );
}
