import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";

export async function POST(req: NextRequest) {
  try {
    const { transcript, filename } = await req.json();

    if (!transcript) {
      return NextResponse.json({ error: "No transcript provided" }, { status: 400 });
    }

    const dir = path.join(process.cwd(), "transcripts");
    await mkdir(dir, { recursive: true });

    // Clean filename and add timestamp
    const base = (filename || "transcript").replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_\-\s]/g, "");
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outFile = `${base}_${ts}.txt`;
    const outPath = path.join(dir, outFile);

    await writeFile(outPath, transcript, "utf-8");

    return NextResponse.json({ saved: outFile });
  } catch (error) {
    console.error("Save transcript error:", error);
    return NextResponse.json({ error: "Failed to save transcript" }, { status: 500 });
  }
}
