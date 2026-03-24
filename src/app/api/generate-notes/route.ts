import { NextRequest } from "next/server";
import OpenAI from "openai";

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
}

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const { transcript, filename } = await req.json();

    if (!transcript) {
      return new Response(JSON.stringify({ error: "No transcript provided" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const systemPrompt = `You are an expert note-taker. Given a transcript from a video (meeting, lecture, presentation, or other), produce comprehensive, well-structured notes in Markdown format.

Your notes should include:

1. **Title & Overview** — A clear title and 2-3 sentence summary of what the video covers
2. **Key Topics** — Main subjects discussed, organized with clear headers
3. **Detailed Notes** — Under each topic, provide:
   - Key points and explanations
   - Important facts, figures, or data mentioned
   - Any definitions or terminology introduced
   - Examples or case studies discussed
4. **Action Items / Takeaways** — If applicable, list any action items, decisions made, or next steps
5. **Key Quotes** — Notable direct quotes (use blockquotes)
6. **Summary** — A concise recap of the most important points

Formatting rules:
- Use clear hierarchical headers (##, ###)
- Use bullet points for lists
- Bold key terms and important phrases
- Use tables where data comparisons exist
- Keep it comprehensive but scannable
- Don't include filler words or repetition from the transcript
- Infer structure even if the transcript is messy or informal`;

    const openai = getOpenAI();
    const stream = await openai.chat.completions.create({
      model: "gpt-4o",
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Here is the transcript from "${filename || "a video"}":\n\n${transcript}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    });

    // Stream the response
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        for await (const chunk of stream) {
          const text = chunk.choices[0]?.delta?.content || "";
          if (text) {
            controller.enqueue(encoder.encode(text));
          }
        }
        controller.close();
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
      },
    });
  } catch (error) {
    console.error("Note generation error:", error);
    const message = error instanceof Error ? error.message : "Note generation failed";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
