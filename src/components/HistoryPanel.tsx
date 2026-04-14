"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Transcription } from "@/lib/supabase";

interface HistoryPanelProps {
  history: Transcription[];
  loading: boolean;
  onClose: () => void;
  onDelete: (id: string) => void;
}

export default function HistoryPanel({ history, loading, onClose, onDelete }: HistoryPanelProps) {
  const [selected, setSelected] = useState<Transcription | null>(null);
  const [activeTab, setActiveTab] = useState<"notes" | "transcript">("notes");

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      {/* Panel */}
      <div className="fixed inset-y-0 right-0 w-full max-w-2xl bg-neutral-950 border-l border-neutral-800 flex flex-col z-50">
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800 shrink-0">
          {selected ? (
            <button
              onClick={() => setSelected(null)}
              className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
              Back
            </button>
          ) : (
            <h2 className="text-sm font-semibold">Saved Transcriptions</h2>
          )}
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-300 transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {selected ? (
          <>
            <div className="px-6 py-3 border-b border-neutral-800 shrink-0 flex items-center justify-between">
              <span className="text-xs text-neutral-400 truncate flex-1 mr-4">{selected.filename}</span>
              <div className="flex gap-1 bg-neutral-900 rounded-lg p-1 shrink-0">
                <button
                  onClick={() => setActiveTab("notes")}
                  className={`px-3 py-1 text-xs rounded-md transition-colors ${activeTab === "notes" ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}
                >
                  Notes
                </button>
                <button
                  onClick={() => setActiveTab("transcript")}
                  className={`px-3 py-1 text-xs rounded-md transition-colors ${activeTab === "transcript" ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}
                >
                  Transcript
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {activeTab === "notes" ? (
                <div className="prose-notes">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.notes}</ReactMarkdown>
                </div>
              ) : (
                <p className="text-sm text-neutral-400 leading-relaxed whitespace-pre-wrap">{selected.transcript}</p>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center h-32">
                <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : history.length === 0 ? (
              <div className="text-center py-16">
                <p className="text-sm text-neutral-500">No saved transcriptions yet</p>
                <p className="text-xs text-neutral-600 mt-2">Generate notes to save them here</p>
              </div>
            ) : (
              <div className="divide-y divide-neutral-800/50">
                {history.map((item) => (
                  <div key={item.id} className="px-6 py-4 hover:bg-neutral-900/50 transition-colors">
                    <div className="flex items-start justify-between gap-4">
                      <button onClick={() => { setSelected(item); setActiveTab("notes"); }} className="text-left flex-1 min-w-0">
                        <p className="text-sm font-medium text-neutral-200 truncate">{item.filename}</p>
                        <p className="text-xs text-neutral-500 mt-0.5">
                          {new Date(item.created_at).toLocaleDateString("en-US", {
                            month: "short", day: "numeric", year: "numeric",
                            hour: "2-digit", minute: "2-digit",
                          })}
                        </p>
                        <p className="text-xs text-neutral-600 mt-1.5 line-clamp-2">
                          {item.notes.replace(/[#*`>]/g, "").substring(0, 140)}...
                        </p>
                      </button>
                      <button
                        onClick={() => onDelete(item.id)}
                        className="text-neutral-700 hover:text-red-400 transition-colors shrink-0 mt-0.5 p-1"
                        title="Delete"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6"/>
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
