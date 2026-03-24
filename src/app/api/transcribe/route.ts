import { NextRequest, NextResponse } from "next/server";
import OpenAI, { toFile } from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const maxDuration = 300;
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const fileSizeMB = buffer.length / (1024 * 1024);

    // Whisper API accepts up to 25MB
    if (fileSizeMB > 25) {
      return NextResponse.json(
        { error: "File too large for transcription. Please upload a file under 25MB, or use a shorter video." },
        { status: 400 }
      );
    }

    const uploadFile = await toFile(buffer, file.name, { type: file.type });
    
    const transcription = await openai.audio.transcriptions.create({
      file: uploadFile,
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
    });

    return NextResponse.json({ text: transcription.text });
  } catch (error) {
    console.error("Transcription error:", error);
    const message = error instanceof Error ? error.message : "Transcription failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
