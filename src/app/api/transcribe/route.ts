import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;
export const runtime = "nodejs";

// Proxy to OpenAI Whisper - streams the request body directly
// to avoid Vercel's body size limits
export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
    }

    // Forward the multipart form data directly to OpenAI
    const contentType = req.headers.get("content-type") || "";

    // Read raw body and rebuild form for OpenAI
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json(
        { error: "File too large. Vercel limits uploads to ~4.5MB. Please compress your audio first (e.g. convert to MP3 at 64kbps)." },
        { status: 413 }
      );
    }

    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    // Build a new FormData for OpenAI
    const openaiForm = new FormData();
    openaiForm.append("file", file, file.name);
    openaiForm.append("model", "whisper-1");
    openaiForm.append("response_format", "verbose_json");
    openaiForm.append("timestamp_granularities[]", "segment");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
      },
      body: openaiForm,
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("OpenAI error:", errText);
      let errMsg = "Transcription failed";
      try {
        const errJson = JSON.parse(errText);
        errMsg = errJson.error?.message || errMsg;
      } catch {}
      return NextResponse.json({ error: errMsg }, { status: response.status });
    }

    const data = await response.json();
    return NextResponse.json({ text: data.text });
  } catch (error) {
    console.error("Transcription error:", error);
    const message = error instanceof Error ? error.message : "Transcription failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
