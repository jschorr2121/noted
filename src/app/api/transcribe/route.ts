import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const maxDuration = 300; // 5 min for large files

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    // Save to temp file (Whisper needs a file path)
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const tmpDir = join(tmpdir(), "noted");
    await mkdir(tmpDir, { recursive: true });
    const tmpPath = join(tmpDir, `${randomUUID()}-${file.name}`);
    await writeFile(tmpPath, buffer);

    try {
      // Whisper API - supports up to 25MB per request
      // For larger files, we chunk the audio
      const fileSizeMB = buffer.length / (1024 * 1024);

      let fullTranscript = "";

      if (fileSizeMB <= 24) {
        // Direct transcription
        const { File: NodeFile } = await import("node:buffer");
        const transcription = await openai.audio.transcriptions.create({
          file: new File([buffer], file.name, { type: file.type }),
          model: "whisper-1",
          response_format: "verbose_json",
          timestamp_granularities: ["segment"],
        });
        fullTranscript = transcription.text;
      } else {
        // For large files, use ffmpeg to extract audio and compress
        const { execSync } = await import("child_process");
        const audioPath = join(tmpDir, `${randomUUID()}.mp3`);
        
        try {
          // Extract audio as compressed mp3 (much smaller than video)
          execSync(
            `ffmpeg -i "${tmpPath}" -vn -acodec libmp3lame -ab 64k -ar 16000 "${audioPath}" -y 2>/dev/null`,
            { timeout: 120000 }
          );

          const { readFile } = await import("fs/promises");
          const audioBuffer = await readFile(audioPath);
          const audioSizeMB = audioBuffer.length / (1024 * 1024);

          if (audioSizeMB <= 24) {
            const transcription = await openai.audio.transcriptions.create({
              file: new File([audioBuffer], "audio.mp3", { type: "audio/mpeg" }),
              model: "whisper-1",
              response_format: "verbose_json",
              timestamp_granularities: ["segment"],
            });
            fullTranscript = transcription.text;
          } else {
            // Split into chunks using ffmpeg
            const chunkDuration = 600; // 10 minutes per chunk
            const durationOutput = execSync(
              `ffprobe -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`,
              { timeout: 30000 }
            ).toString().trim();
            const totalDuration = parseFloat(durationOutput);
            const chunks = Math.ceil(totalDuration / chunkDuration);

            const parts: string[] = [];
            for (let i = 0; i < chunks; i++) {
              const start = i * chunkDuration;
              const chunkPath = join(tmpDir, `${randomUUID()}-chunk-${i}.mp3`);
              execSync(
                `ffmpeg -i "${audioPath}" -ss ${start} -t ${chunkDuration} -acodec libmp3lame -ab 64k -ar 16000 "${chunkPath}" -y 2>/dev/null`,
                { timeout: 60000 }
              );

              const chunkBuffer = await readFile(chunkPath);
              const transcription = await openai.audio.transcriptions.create({
                file: new File([chunkBuffer], `chunk-${i}.mp3`, { type: "audio/mpeg" }),
                model: "whisper-1",
                response_format: "verbose_json",
                timestamp_granularities: ["segment"],
              });
              parts.push(transcription.text);
              await unlink(chunkPath).catch(() => {});
            }
            fullTranscript = parts.join(" ");
          }
          await unlink(audioPath).catch(() => {});
        } catch (ffmpegError) {
          // Fallback: try direct upload anyway
          const transcription = await openai.audio.transcriptions.create({
            file: new File([buffer], file.name, { type: file.type }),
            model: "whisper-1",
            response_format: "verbose_json",
            timestamp_granularities: ["segment"],
          });
          fullTranscript = transcription.text;
        }
      }

      return NextResponse.json({ text: fullTranscript });
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  } catch (error) {
    console.error("Transcription error:", error);
    const message = error instanceof Error ? error.message : "Transcription failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
