"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { zipSync, strToU8 } from "fflate";
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

interface FileResult {
  transcript: string;
  notes: string;
  error: string;
}

const baseName = (name: string) => name.replace(/\.[^.]+$/, "");

export default function Home() {
  const [files, setFiles] = useState<File[]>([]);
  const [results, setResults] = useState<FileResult[]>([]);
  const [sel, setSel] = useState(0);
  const [summarize, setSummarize] = useState(true);
  const [dark, setDark] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState("");
  const [progressPct, setProgressPct] = useState<number | null>(null);
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
  const coreURLsRef = useRef<{ coreURL: string; wasmURL: string } | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.theme = next ? "dark" : "light"; } catch {}
  };

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

  // Derived view of the selected file so single-file UI/download code stays unchanged
  const file = files[sel] ?? null;
  const transcript = results[sel]?.transcript ?? "";
  const notes = results[sel]?.notes ?? "";

  const updateResult = (i: number, patch: Partial<FileResult>) =>
    setResults((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const handleFiles = useCallback((list: FileList | File[]) => {
    const validExts = [".mp4", ".webm", ".mov", ".m4a", ".mp3", ".wav", ".ogg", ".flac"];
    const valid: File[] = [];
    const skipped: string[] = [];
    for (const f of Array.from(list)) {
      const isValidType = f.type.startsWith("video/") || f.type.startsWith("audio/");
      const isValidExt = validExts.some((ext) => f.name.toLowerCase().endsWith(ext));
      if ((!isValidType && !isValidExt) || f.size > 500 * 1024 * 1024) skipped.push(f.name);
      else valid.push(f);
    }
    setError(skipped.length ? `Skipped (not audio/video or over 500MB): ${skipped.join(", ")}` : "");
    if (!valid.length) return;
    setFiles(valid);
    setResults([]);
    setSel(0);
    setCompressionInfo("");
    setLogs([]);
    setStage("idle");
    setSavedToAccount(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

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
      if (!coreURLsRef.current) {
        addLog("Downloading ffmpeg core (~30MB, first time only)...");
        const coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript");
        addLog("Core JS loaded", "success");
        const wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm");
        addLog("WASM loaded", "success");
        coreURLsRef.current = { coreURL, wasmURL };
      }
      addLog("Initializing ffmpeg...");
      await ffmpeg.load(coreURLsRef.current);
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

  const transcribeOne = async (f: File, i: number) => {
    setStage("compressing");
    setProgress("Compressing audio...");

    let chunks: File[];
    try {
      chunks = await compressAndChunk(f);
    } catch (compressErr) {
      const msg = compressErr instanceof Error ? compressErr.message : String(compressErr);
      addLog(`Compression failed: ${msg}`, "error");
      if (f.size / 1024 / 1024 <= MAX_CHUNK_MB) {
        addLog("File small enough to upload directly", "warn");
        chunks = [f];
      } else {
        throw new Error(msg);
      }
    }

    setStage("transcribing");
    const transcriptParts: string[] = [];

    for (let c = 0; c < chunks.length; c++) {
      setProgress(`Transcribing${chunks.length > 1 ? ` chunk ${c + 1}/${chunks.length}` : ""}...`);
      setProgressPct(Math.round((c / chunks.length) * 100));
      addLog(`Uploading chunk ${c + 1} (${(chunks[c].size / 1024 / 1024).toFixed(1)}MB)...`);

      const formData = new FormData();
      formData.append("file", chunks[c]);

      const res = await fetch("/api/transcribe", { method: "POST", body: formData });

      let data;
      const responseText = await res.text();
      try {
        data = JSON.parse(responseText);
      } catch {
        throw new Error(`Server error on chunk ${c + 1}: ${responseText.substring(0, 200)}`);
      }

      if (!res.ok) {
        throw new Error(data.error || `Transcription failed on chunk ${c + 1}`);
      }

      transcriptParts.push(data.text);
      addLog(`Chunk ${c + 1} transcribed: ${data.text.split(" ").length} words`, "success");
    }

    setProgressPct(null);
    const fullTranscript = transcriptParts.join(" ");
    updateResult(i, { transcript: fullTranscript });
    addLog(`Full transcription: ${fullTranscript.split(" ").length} words`, "success");

    let accumulated = "";
    if (summarize) {
      setStage("generating");
      setProgress("Generating comprehensive notes...");
      addLog("Generating structured notes...");

      const notesRes = await fetch("/api/generate-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: fullTranscript, filename: f.name }),
      });

      if (!notesRes.ok) {
        const err = await notesRes.json();
        throw new Error(err.error || "Note generation failed");
      }

      const reader = notesRes.body?.getReader();
      const decoder = new TextDecoder();
      if (reader) {
        addLog("Streaming notes...", "success");
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          updateResult(i, { notes: accumulated });
        }
        addLog(`Done! ${accumulated.split("\n").length} lines of notes generated.`, "success");
      }
    }

    // Save to Supabase if logged in
    if (supabase && user) {
      const { error: dbError } = await supabase.from("transcriptions").insert({
        user_id: user.id,
        filename: f.name,
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
      addLog("Not signed in — not saved to account", "warn");
    }
  };

  // ponytail: files run one at a time — ffmpeg.wasm is a single instance and the
  // transcribe API is rate-limited; pipeline compress/transcribe if batches get slow.
  const processFiles = async (retryFailed = false) => {
    if (!files.length) return;
    setError("");
    const todo = files.map((_, i) => i).filter((i) => !retryFailed || results[i]?.error);
    if (retryFailed) {
      todo.forEach((i) => updateResult(i, { transcript: "", notes: "", error: "" }));
      addLog(`Retrying ${todo.length} failed file${todo.length > 1 ? "s" : ""}`, "warn");
    } else {
      setResults(files.map(() => ({ transcript: "", notes: "", error: "" })));
      setActiveTab(summarize ? "notes" : "transcript");
      setCompressionInfo("");
      setLogs([]);
      setSavedToAccount(false);
    }
    setShowLogs(true);
    setProgressPct(null);

    let lastError = "";
    let failures = 0;
    for (const i of todo) {
      const f = files[i];
      setSel(i);
      addLog(`Starting${files.length > 1 ? ` ${i + 1}/${files.length}` : ""}: ${f.name} (${(f.size / 1024 / 1024).toFixed(1)}MB)`);
      try {
        await transcribeOne(f, i);
      } catch (err) {
        lastError = err instanceof Error ? err.message : "Something went wrong";
        failures++;
        updateResult(i, { error: lastError });
        addLog(`${f.name}: ${lastError}`, "error");
      } finally {
        // ffmpeg.wasm leaks heap across runs and is unusable after a crash
        // ("memory access out of bounds"), so every file gets a fresh instance.
        ffmpegRef.current?.terminate();
        ffmpegRef.current = null;
      }
    }

    // Files skipped on retry already succeeded, so only this run's failures matter
    if (failures === files.length) {
      setStage("error");
      setError(lastError);
    } else {
      setStage("done");
      setSel(0);
      if (failures) addLog(`${failures} of ${todo.length} files failed`, "warn");
    }
    // Auto-close log drawer on mobile so it doesn't block buttons
    if (navigator.maxTouchPoints > 0) setShowLogs(false);
  };

  const downloadZip = () => {
    const entries: Record<string, Uint8Array> = {};
    const add = (name: string, text: string) => {
      let n = name;
      for (let k = 2; n in entries; k++) n = name.replace(/(\.[^.]+)$/, ` (${k})$1`);
      entries[n] = strToU8(text);
    };
    files.forEach((f, i) => {
      const r = results[i];
      if (!r?.transcript) return;
      add(`${baseName(f.name)}.txt`, r.transcript);
      if (r.notes) add(`${baseName(f.name)}-notes.md`, r.notes);
    });
    const blob = new Blob([zipSync(entries)], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "transcripts.zip";
    a.click();
    URL.revokeObjectURL(url);
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
    setFiles([]);
    setResults([]);
    setSel(0);
    setStage("idle");
    setProgress("");
    setProgressPct(null);
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
            <button
              onClick={toggleTheme}
              aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
              className="p-1.5 text-neutral-500 hover:text-neutral-300 rounded-md transition-colors"
            >
              {dark ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
              )}
            </button>
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
                <input ref={fileInputRef} type="file" accept="video/*,audio/*,.mp4,.webm,.mov,.m4a,.mp3,.wav,.ogg,.flac" multiple className="hidden" onChange={(e) => e.target.files?.length && handleFiles(e.target.files)} />
                {files.length > 1 ? (
                  <div>
                    <p className="text-sm font-medium text-neutral-200">{files.length} files selected</p>
                    <p className="text-xs text-neutral-500 mt-1">{formatFileSize(files.reduce((s, f) => s + f.size, 0))} total</p>
                    <ul className="text-xs text-neutral-500 mt-3 space-y-0.5 max-h-32 overflow-y-auto">
                      {files.map((f, i) => <li key={i} className="truncate">{f.name}</li>)}
                    </ul>
                    <p className="text-xs text-neutral-600 mt-3">Tap to change files</p>
                  </div>
                ) : file ? (
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
                    <p className="text-sm text-neutral-400">Drop video or audio files here or tap to browse</p>
                    <p className="text-xs text-neutral-600 mt-2">Any size — auto-compressed & chunked in your browser</p>
                  </div>
                )}
              </div>
              {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
              <label className="flex items-center gap-2 text-sm text-neutral-400 cursor-pointer mt-6">
                <input type="checkbox" checked={summarize} onChange={(e) => setSummarize(e.target.checked)} className="accent-indigo-600" />
                Generate AI notes{files.length > 1 ? " for each file" : ""} (uncheck for transcript only)
              </label>
              {file && (
                <div className="flex flex-col items-center gap-2 mt-4">
                  <button
                    onClick={(e) => { e.stopPropagation(); processFiles(); }}
                    className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    {summarize ? "Generate Notes" : "Transcribe"}{files.length > 1 ? ` (${files.length} files)` : ""}
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

          {/* Batch file switcher */}
          {files.length > 1 && results.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 mb-6">
              {files.map((f, i) => {
                const r = results[i];
                const dot = r?.error ? "bg-red-500" : isProcessing && i === sel ? "bg-indigo-500 animate-pulse" : r?.transcript ? "bg-green-500" : "bg-neutral-600";
                return (
                  <button
                    key={i}
                    onClick={() => !isProcessing && setSel(i)}
                    disabled={isProcessing}
                    className={`flex items-center gap-1.5 max-w-[14rem] px-3 py-1.5 text-xs rounded-md transition-colors ${i === sel ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
                    <span className="truncate">{f.name}</span>
                  </button>
                );
              })}
              {!isProcessing && results.some((r) => r.error) && (
                <button onClick={() => processFiles(true)} className="px-3 py-1.5 text-xs bg-neutral-800 hover:bg-neutral-700 active:bg-neutral-600 text-neutral-300 rounded-md transition-colors">
                  Retry failed ({results.filter((r) => r.error).length})
                </button>
              )}
              {results.some((r) => r.transcript) && (
                <button onClick={downloadZip} className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white rounded-md transition-colors">
                  Download all (.zip)
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
                    <circle cx="32" cy="32" r="28" fill="none" className="stroke-neutral-800" strokeWidth="4" />
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
              <p className="text-sm font-medium text-neutral-300">{files.length > 1 ? `File ${sel + 1}/${files.length} — ` : ""}{progress}</p>
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
          {(stage === "done" || notes) && results[sel]?.error ? (
            <p className="text-sm text-red-400">{file?.name}: {results[sel].error}</p>
          ) : (stage === "done" || notes) && (
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
                    {notes && <button
                      onClick={() => setActiveTab("notes")}
                      className={`px-4 py-1.5 text-sm rounded-md transition-colors ${activeTab === "notes" ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}
                    >
                      Notes
                    </button>}
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
                  {notes && <>
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
                  </>}
                  {transcript && (
                    <button onClick={downloadTranscript} className="px-3 py-2 text-xs bg-neutral-800 hover:bg-neutral-700 active:bg-neutral-600 text-neutral-300 rounded-md transition-colors">
                      Download .txt
                    </button>
                  )}
                  <button onClick={reset} className="px-3 py-2 text-xs bg-neutral-800 hover:bg-neutral-700 active:bg-neutral-600 text-neutral-300 rounded-md transition-colors">
                    {files.length > 1 ? "New Files" : "New Video"}
                  </button>
                </div>
              </div>

              {activeTab === "notes" && notes ? (
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
