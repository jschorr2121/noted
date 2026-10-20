import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { NextRequest, NextResponse } from "next/server";

const url = process.env.KV_REST_API_URL;
const token = process.env.KV_REST_API_TOKEN;
const redis = url && token ? new Redis({ url, token }) : null;

// Per-IP sliding windows. transcribe is called once per ~8min audio chunk,
// so 200/h ≈ 25h of audio per IP per hour.
const limiters = redis && {
  transcribe: new Ratelimit({ redis, prefix: "rl:transcribe", limiter: Ratelimit.slidingWindow(200, "1 h") }),
  notes: new Ratelimit({ redis, prefix: "rl:notes", limiter: Ratelimit.slidingWindow(40, "1 h") }),
};

// Returns a 429 response if over the limit, else null.
// ponytail: no Redis env (local dev without `vercel env pull`) = no limit.
export async function rateLimit(req: NextRequest, kind: "transcribe" | "notes") {
  if (!limiters) return null;
  const ip = req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const { success, reset } = await limiters[kind].limit(ip);
  if (success) return null;
  const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
  return NextResponse.json(
    { error: `Rate limit reached. Try again in ${Math.ceil(retryAfter / 60)} min.` },
    { status: 429, headers: { "Retry-After": String(retryAfter) } }
  );
}
