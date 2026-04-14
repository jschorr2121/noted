"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { supabase, type Transcription } from "@/lib/supabase";
import type { User } from "@supabase/supabase-js";
import AuthModal from "@/components/AuthModal";
import HistoryPanel from "@/components/HistoryPanel";

type Stage = "idle" | "compressing" | "transcribing" | "generating" | "done" | "error";

interface LogEntry {
  time: string;
  message: string;
  type: "info" | "success" | "warn" | "error" | "ffmpeg";
}

function timestamp() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const MAX_CHUNK_MB = 3.5;

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

  // Auth state
  const [user, setUser] = useState<User | null>(null);
  const [showAuth, setShowAuth] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<Transcription[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [savedToAccount, setSavedToAccount] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Load auth session on mount
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

  const loadHistory = useCallback(async () => {
    if (!supabase || !user) return;
    setLoadingHistory(true);
    const { data } = await supabase
      .from("transcriptions")
      .select("*")
      .order("created_at", { ascending: false });
    setHistory((data as Transcription[]) ?? []);
    setLoadingHistory(false);
  }, [user]);

  useEffect(() => {
    if (showHistory && user) loadHistory();
  }, [showHistory, user, loadHistory]);

  const deleteTranscription = async (id: string) => {
    if (!supabase) return;
    await supabase.from("transcriptions").delete().eq("id", id);
    setHistory((prev) => prev.filter((t) => t.id !== id));
  };

  const addLog = useCallback((message: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => [...prev, { time: timestamp(), message, type }]);
  }, []);

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
    setSavedToAccount(false);
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
      if (message.includes("Duration") || message.includes("size=") || message.includes("Error") || message.includes("error")) {
        addLog(message, "ffmpeg");
      }
    });

    ffmpeg.on("progress", ({ progress: p }) => {
      const pct = Math.round(p * 100);
      setProgressPct(Math.min(pct, 100));
    });

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
      throw new Error("Failed to load audio compressor. Try Chrome or Edge.");
    }

    ffmpegRef.current = ffmpeg;
    return ffmpeg;
  };

  const getDuration = async (ffmpeg: FFmpeg, filename: string): Promise<number> => {
    let duration = 0;
    const handler = ({ message }: { message: string }) => {
      const match = message.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
      if (match) {
        duration = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + parseInt(match[4]) / 100;
      }
    };
    ffmpeg.on("log", handler);
    await ffmpeg.exec(["-i", filename, "-f", "null", "-t", "0", "/dev/null"]).catch(() => {});
    ffmpeg.off("log", handler);
    return duration;
  };

  const compressAndChunk = async (inputFile: File): Promise<File[]> => {
    const ffmpeg = await loadFFmpeg();

    const ext = inputFile.name.substring(inputFile.name.lastIndexOf(".")) || ".mp4";
    const inputName = `input${ext}`;

    addLog(`Writing file to memory: ${inputFile.name} (${(inputFile.size / 1024 / 1024).toFixed(1)}MB)`);
    await ffmpeg.writeFile(inputName, await fetchFile(inputFile));

    const duration = await getDuration(ffmpeg, inputName);
    addLog(`Audio duration: ${Math.floor(duration / 60)}m ${Math.floor(duration % 60)}s`);

    const minutesPerChunk = (MAX_CHUNK_MB * 8) / 0.064 / 60;
    const secondsPerChunk = Math.floor(minutesPerChunk * 60);
    const numChunks = Math.max(1, Math.ceil(duration / secondsPerChunk));

    addLog(`Splitting into ${numChunks} chunk${numChunks > 1 ? "s" : ""} (${Math.ceil(secondsPerChunk / 60)}min each)`);

    const chunks: File[] = [];

    for (let i = 0; i < numChunks; i++) {
      const start = i * secondsPerChunk;
      const chunkName = `chunk_${i}.mp3`;

      setProgress(`Compressing chunk ${i + 1}/${numChunks}...`);
      setProgressPct(0);

      await ffmpeg.exec([
        "-i", inputName,
        "-ss", String(start),
        "-t", String(secondsPerChunk),
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-b:a", "64k",
        "-f", "mp3",
        chunkName,
      ]);

      const data = await ffmpeg.readFile(chunkName);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const blob = new Blob([data as any], { type: "audio/mpeg" });
      const sizeMB = blob.size / 1024 / 1024;
      chunks.push(new File([blob], chunkName, { type: "audio/mpeg" }));
      addLog(`Chunk ${i + 1}: ${sizeMB.toFixed(1)}MB`, "success");

      await ffmpeg.deleteFile(chunkName).catch(() => {});
    }

    await ffmpeg.deleteFile(inputName).catch(() => {});
    setProgressPct(null);

    const totalCompressed = chunks.reduce((s, c) => s + c.size, 0);
    const originalMB = inputFile.size / 1024 / 1024;
    const compressedMB = totalCompressed / 1024 / 1024;
    const reduction = Math.round((1 - compressedMB / originalMB) * 100);
    const chunkInfo = numChunks > 1 ? `, ${numChunks} chunks` : "";
    const info = reduction > 15
      ? `${originalMB.toFixed(1)}MB → ${compressedMB.toFixed(1)}MB (${reduction}% smaller${chunkInfo})`
      : `Processed: ${numChunks} chunk${numChunks > 1 ? "s" : ""}, ${compressedMB.toFixed(1)}MB total`;
    setCompressionInfo(info);
    addLog(info, "success");

    return chunks;
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
    setSavedToAccount(false);

    addLog(`Starting: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);

    try {
      setStage("compressing");
      setProgress("Compressing audio...");

      let chunks: File[];
      try {
        chunks = await compressAndChunk(file);
      } catch (compressErr) {
        const msg = compressErr instanceof Error ? compressErr.message : String(compressErr);
        addLog(`Compression failed: ${msg}`, "error");
        if (file.size / 1024 / 1024 <= MAX_CHUNK_MB) {
          addLog("File small enough to upload directly", "warn");
          chunks = [file];
        } else {
          throw new Error(msg);
        }
      }

      setStage("transcribing");
      const transcriptParts: string[] = [];

      for (let i = 0; i < chunks.length; i++) {
        setProgress(`Transcribing${chunks.length > 1 ? ` chunk ${i + 1}/${chunks.length}` : ""}...`);
        setProgressPct(Math.round((i / chunks.length) * 100));
        addLog(`Uploading chunk ${i + 1} (${(chunks[i].size / 1024 / 1024).toFixed(1)}MB)...`);

        const formData = new FormData();
        formData.append("file", chunks[i]);

        const res = await fetch("/api/transcribe", { method: "POST", body: formData });

        let data;
        const responseText = await res.text();
        try {
          data = JSON.parse(responseText);
        } catch {
          throw new Error(`Server error on chunk ${i + 1}: ${responseText.substring(0, 200)}`);
        }

        if (!res.ok) {
          throw new Error(data.error || `Transcription failed on chunk ${i + 1}`);
        }

        transcriptParts.push(data.text);
        addLog(`Chunk ${i + 1} transcribed: ${data.text.split(" ").length} words`, "success");
      }

      setProgressPct(null);
      const fullTranscript = transcriptParts.join(" ");
      setTranscript(fullTranscript);
      addLog(`Full transcription: ${fullTranscript.split(" ").length} words`, "success");

      try {
        const saveRes = await fetch("/api/save-transcript", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript: fullTranscript, filename: file.name }),
        });
        if (saveRes.ok) {
          const { saved } = await saveRes.json();
          addLog(`Transcript saved: ${saved}`, "success");
        }
      } catch {
        addLog("Could not save transcript to server", "warn");
      }

      setStage("generating");
      setProgress("Generating comprehensive notes...");
      addLog("Generating structured notes...");

      const notesRes = await fetch("/api/generate-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: fullTranscript, filename: file.name }),
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
        // Auto-close log drawer on mobile so it doesn't block buttons
        if (navigator.maxTouchPoints > 0) setShowLogs(false);

        // Save to Supabase if logged in
        if (supabase && user) {
          const { error: dbError } = await supabase.from("transcriptions").insert({
            user_id: user.id,
            filename: file.name,
            transcript: fullTranscript,
            notes: accumulated,
          });
          if (dbError) {
            addLog(`Could not save to account: ${dbError.message}`, "warn");
          } else {
            setSavedToAccount(true);
            addLog("Saved to your account", "success");
          }
        } else if (supabase && !user) {
          addLog("Not signed in — notes not saved to account", "warn");
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setStage("error");
      setError(msg);
      addLog(msg, "error");
      if (navigator.maxTouchPoints > 0) setShowLogs(false);
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

  const buildPrintHTML = () => {
    const container = document.getElementById("notes-content");
    if (!container) return null;
    const title = file?.name?.replace(/\.[^.]+$/, "") || "notes";
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:800px;margin:2rem auto;padding:0 1.5rem;color:#1a1a1a;line-height:1.7;font-size:14px}
  h1{font-size:1.5rem;border-bottom:2px solid #eee;padding-bottom:.5rem;margin-top:0}
  h2{font-size:1.2rem;margin-top:1.5rem;border-bottom:1px solid #eee;padding-bottom:.25rem}
  h3{font-size:1rem}
  ul,ol{margin-left:1.25rem}li{margin-bottom:.25rem}
  blockquote{border-left:3px solid #6366f1;padding-left:1rem;color:#555;font-style:italic;margin:1rem 0}
  strong{color:#111}
  table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:.5rem .75rem;text-align:left}
  th{background:#f5f5f5;font-weight:600}
  @media print{body{margin:0;padding:1rem}}
</style></head>
<body>${container.innerHTML}</body></html>`;
  };

  const downloadPDF = async () => {
    const isMobile = typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0);

    if (isMobile) {
      // iOS/Android block programmatic PDF generation — open printable page instead
      const html = buildPrintHTML();
      if (!html) return;
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return;
    }

    // Desktop: use html2pdf
    const container = document.getElementById("notes-content");
    if (!container) return;
    const html2pdf = (await import("html2pdf.js")).default;
    const clone = container.cloneNode(true) as HTMLElement;
    clone.style.cssText = "background:#fff;color:#1a1a1a;padding:32px;font-family:system-ui,sans-serif;font-size:13px;line-height:1.7";
    clone.querySelectorAll("h1,h2,h3").forEach((el) => { (el as HTMLElement).style.color = "#1a1a1a"; });
    clone.querySelectorAll("p,li,td").forEach((el) => { (el as HTMLElement).style.color = "#333"; });
    clone.querySelectorAll("strong").forEach((el) => { (el as HTMLElement).style.color = "#111"; });
    clone.querySelectorAll("blockquote").forEach((el) => {
      (el as HTMLElement).style.cssText = "border-left:3px solid #6366f1;padding-left:12px;color:#555;font-style:italic";
    });
    clone.querySelectorAll("th").forEach((el) => {
      (el as HTMLElement).style.cssText = "background:#f5f5f5;color:#1a1a1a;border:1px solid #ddd;padding:6px 10px";
    });
    clone.querySelectorAll("td").forEach((el) => {
      (el as HTMLElement).style.cssText = "border:1px solid #ddd;padding:6px 10px";
    });
    const filename = `${file?.name?.replace(/\.[^.]+$/, "") || "notes"}-notes.pdf`;
    html2pdf().set({
      margin: [12, 12, 12, 12],
      filename,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
    }).from(clone).save();
  };

  const downloadTranscript = () => {
    const blob = new Blob([transcript], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${file?.name?.replace(/\.[^.]+$/, "") || "transcript"}-transcript.txt`;
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
    setSavedToAccount(false);
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
      <header className="border-b border-neutral-800/50 px-4 sm:px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0">
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
          <div className="flex items-center gap-2 sm:gap-4">
            {logs.length > 0 && (
              <button
                onClick={() => setShowLogs(!showLogs)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors ${
                  showLogs ? "bg-neutral-800 text-neutral-200" : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${isProcessing ? "bg-indigo-500 animate-pulse" : stage === "error" ? "bg-red-500" : "bg-green-500"}`} />
                <span className="hidden sm:inline">Logs ({logs.length})</span>
                <span className="sm:hidden">{logs.length}</span>
              </button>
            )}

            {supabase && (
              user ? (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowHistory(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded-md transition-colors"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 3h6l3 9 3-6h6"/><path d="M21 3v18H3V3"/>
                    </svg>
                    <span className="hidden sm:inline">History</span>
                  </button>
                  <button
                    onClick={() => supabase?.auth.signOut()}
                    className="px-3 py-1.5 text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
                  >
                    Sign out
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowAuth(true)}
                  className="px-3 py-1.5 text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-md transition-colors"
                >
                  Sign in
                </button>
              )
            )}

            <span className="text-xs text-neutral-600 hidden sm:inline">Video & Audio to Notes</span>
          </div>
        </div>
      </header>

      <div className="flex-1 flex max-w-6xl mx-auto w-full relative">
        <div className="flex-1 px-4 sm:px-6 py-8 min-w-0">
          {/* Upload */}
          {stage === "idle" && !notes && (
            <div className="flex flex-col items-center justify-center min-h-[60vh]">
              <div
                onDrop={handleDrop}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onClick={() => fileInputRef.current?.click()}
                className={`w-full max-w-lg border-2 border-dashed rounded-xl p-10 sm:p-12 text-center cursor-pointer transition-all duration-200 ${
                  dragOver ? "border-indigo-500 bg-indigo-500/5" : file ? "border-neutral-600 bg-neutral-900/50" : "border-neutral-700 hover:border-neutral-500 hover:bg-neutral-900/30"
                }`}
              >
                <input ref={fileInputRef} type="file" accept="video/*,audio/*,.mp4,.webm,.mov,.m4a,.mp3,.wav,.ogg,.flac" className="hidden" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
                {file ? (
                  <div>
                    <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-indigo-600/10 flex items-center justify-center">
                      {file.type.startsWith("audio/") || file.name.match(/\.(m4a|mp3|wav|ogg|flac)$/i) ? (
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
                      ) : (
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                      )}
                    </div>
                    <p className="text-sm font-medium text-neutral-200 truncate">{file.name}</p>
                    <p className="text-xs text-neutral-500 mt-1">{formatFileSize(file.size)}</p>
                    <p className="text-xs text-neutral-600 mt-3">Tap to change file</p>
                  </div>
                ) : (
                  <div>
                    <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-neutral-800 flex items-center justify-center">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#737373" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    </div>
                    <p className="text-sm text-neutral-400">Drop a video or audio file here or tap to browse</p>
                    <p className="text-xs text-neutral-600 mt-2">Any size — auto-compressed & chunked in your browser</p>
                  </div>
                )}
              </div>
              {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
              {file && (
                <div className="flex flex-col items-center gap-2 mt-6">
                  <button
                    onClick={(e) => { e.stopPropagation(); processFile(); }}
                    className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    Generate Notes
                  </button>
                  {supabase && !user && (
                    <p className="text-xs text-neutral-600">
                      <button onClick={() => setShowAuth(true)} className="text-indigo-400 hover:text-indigo-300 transition-colors">Sign in</button>
                      {" "}to save notes to your account
                    </p>
                  )}
                </div>
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
                    <circle cx="32" cy="32" r="28" fill="none" stroke="#6366f1" strokeWidth="4"
                      strokeDasharray={`${2 * Math.PI * 28}`}
                      strokeDashoffset={`${2 * Math.PI * 28 * (1 - progressPct / 100)}`}
                      strokeLinecap="round" className="transition-all duration-300" />
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
              <p className="text-xs text-neutral-600 mt-2 text-center px-4">
                {stage === "compressing" ? "Converting & splitting audio in your browser" : stage === "transcribing" ? "Sending chunks to Whisper" : "Analyzing transcript and structuring notes"}
              </p>
              {compressionInfo && <p className="text-xs text-indigo-400 mt-3">{compressionInfo}</p>}
            </div>
          )}

          {/* Error */}
          {stage === "error" && (
            <div className="flex flex-col items-center justify-center min-h-[60vh]">
              <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mb-4">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              </div>
              <p className="text-sm text-red-400 mb-4 max-w-md text-center">{error}</p>
              <button onClick={reset} className="text-sm text-neutral-400 hover:text-neutral-200 underline underline-offset-4">Try again</button>
            </div>
          )}

          {/* Results */}
          {(stage === "done" || notes) && (
            <div>
              {/* Save status */}
              {savedToAccount && (
                <div className="flex items-center gap-1.5 text-xs text-green-400 mb-3">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  Saved to your account
                </div>
              )}
              {!savedToAccount && stage === "done" && supabase && !user && (
                <div className="flex items-center gap-2 text-xs text-neutral-500 mb-3">
                  <button onClick={() => setShowAuth(true)} className="text-indigo-400 hover:text-indigo-300 transition-colors underline underline-offset-2">Sign in</button>
                  to save this to your account
                </div>
              )}

              {/* Results header — stacks vertically on mobile */}
              <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-4 flex-wrap">
                  <div className="flex gap-1 bg-neutral-900 rounded-lg p-1">
                    <button
                      onClick={() => setActiveTab("notes")}
                      className={`px-4 py-1.5 text-sm rounded-md transition-colors ${activeTab === "notes" ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}
                    >
                      Notes
                    </button>
                    <button
                      onClick={() => setActiveTab("transcript")}
                      className={`px-4 py-1.5 text-sm rounded-md transition-colors ${activeTab === "transcript" ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}
                    >
                      Transcript
                    </button>
                  </div>
                  {compressionInfo && <span className="text-xs text-neutral-600">{compressionInfo}</span>}
                </div>

                {/* Buttons — wrap on mobile */}
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={copyForNotion}
                    className={`px-3 py-2 text-xs rounded-md transition-colors ${copied ? "bg-green-600/20 text-green-400 border border-green-600/30" : "bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white"}`}
                  >
                    {copied ? "Copied!" : "Copy for Notion"}
                  </button>
                  <button onClick={downloadPDF} className="px-3 py-2 text-xs bg-neutral-800 hover:bg-neutral-700 active:bg-neutral-600 text-neutral-300 rounded-md transition-colors">
                    Download .pdf
                  </button>
                  <button onClick={downloadMarkdown} className="px-3 py-2 text-xs bg-neutral-800 hover:bg-neutral-700 active:bg-neutral-600 text-neutral-300 rounded-md transition-colors">
                    Download .md
                  </button>
                  <button onClick={downloadHTML} className="px-3 py-2 text-xs bg-neutral-800 hover:bg-neutral-700 active:bg-neutral-600 text-neutral-300 rounded-md transition-colors">
                    Download .html
                  </button>
                  {transcript && (
                    <button onClick={downloadTranscript} className="px-3 py-2 text-xs bg-neutral-800 hover:bg-neutral-700 active:bg-neutral-600 text-neutral-300 rounded-md transition-colors">
                      Download .txt
                    </button>
                  )}
                  <button onClick={reset} className="px-3 py-2 text-xs bg-neutral-800 hover:bg-neutral-700 active:bg-neutral-600 text-neutral-300 rounded-md transition-colors">
                    New Video
                  </button>
                </div>
              </div>

              {activeTab === "notes" ? (
                <div id="notes-content" className="prose-notes bg-neutral-900/50 border border-neutral-800/50 rounded-xl p-6 sm:p-8">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{notes}</ReactMarkdown>
                </div>
              ) : (
                <div className="bg-neutral-900/50 border border-neutral-800/50 rounded-xl p-6 sm:p-8">
                  <p className="text-sm text-neutral-400 leading-relaxed whitespace-pre-wrap">{transcript}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Log Sidebar — fixed overlay on mobile, inline on desktop */}
        {showLogs && (
          <>
            <div
              className="fixed inset-0 bg-black/40 z-30 sm:hidden"
              onClick={() => setShowLogs(false)}
            />
            <div className="fixed right-0 top-0 bottom-0 w-[85vw] max-w-xs sm:relative sm:inset-auto sm:w-80 border-l border-neutral-800/50 flex flex-col bg-neutral-950 z-40 sm:z-auto">
              <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800/50">
                <div className="flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full ${isProcessing ? "bg-indigo-500 animate-pulse" : stage === "error" ? "bg-red-500" : stage === "done" ? "bg-green-500" : "bg-neutral-600"}`} />
                  <span className="text-xs font-medium text-neutral-300">Activity Log</span>
                </div>
                <button onClick={() => setShowLogs(false)} className="text-neutral-600 hover:text-neutral-400 transition-colors p-1">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-1">
                {logs.map((log, i) => (
                  <div key={i} className="flex gap-2 text-xs font-mono">
                    <span className="text-neutral-600 shrink-0">{log.time}</span>
                    <span className={logColorMap[log.type]}>{log.message}</span>
                  </div>
                ))}
                {logs.length === 0 && <p className="text-xs text-neutral-600 text-center mt-4">No activity yet</p>}
                <div ref={logEndRef} />
              </div>
            </div>
          </>
        )}
      </div>

      {/* Auth modal */}
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}

      {/* History panel */}
      {showHistory && (
        <HistoryPanel
          history={history}
          loading={loadingHistory}
          onClose={() => setShowHistory(false)}
          onDelete={deleteTranscription}
        />
      )}
    </main>
  );
}
