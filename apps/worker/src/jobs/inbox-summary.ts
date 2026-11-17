/**
 * AI call summary for the unified inbox: turns a call transcript into
 * {summary, call_reason, action_items, sentiment} for the customer's timeline.
 *
 * Off unless ANTHROPIC_API_KEY is set. Model is INBOX_SUMMARY_MODEL (default
 * claude-opus-5-5). Claude Haiku 5.5 (claude-haiku-5-5) is far cheaper per call
 * and likely good enough for short calls; that's a cost decision for the owner.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Summariser } from "./inbox-voice.js";

export interface CallSummary {
  summary: string;
  call_reason: string;
  action_items: string[];
  sentiment: "positive" | "neutral" | "negative";
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "call_reason", "action_items", "sentiment"],
  properties: {
    summary: { type: "string", description: "2-4 plain-English sentences." },
    call_reason: { type: "string", description: "Why the customer called, in a few words." },
    action_items: { type: "array", items: { type: "string" }, description: "Things staff must do next. Empty if none." },
    sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
  },
} as const;

const SYSTEM = `You summarise phone calls for Mrs Samuel, a fruit juice business in Nigeria, so staff can see what happened at a glance.
The transcript may label speakers as customer and staff. Nigerian English and Pidgin are normal; summarise in plain English.
Only state what was said. If the transcript is empty or unclear, say so in the summary and leave action_items empty.
Never include card numbers, PINs or passwords in the output.`;

export function isCallSummary(v: unknown): v is CallSummary {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.summary === "string" &&
    typeof o.call_reason === "string" &&
    Array.isArray(o.action_items) &&
    o.action_items.every((x) => typeof x === "string") &&
    (o.sentiment === "positive" || o.sentiment === "neutral" || o.sentiment === "negative")
  );
}

export function claudeSummariserFromEnv(env: NodeJS.ProcessEnv = process.env): Summariser | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120_000 });
  const model = env.INBOX_SUMMARY_MODEL || "claude-opus-5-5";

  return {
    async summariseCall(transcript: string): Promise<CallSummary> {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 2000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
        system: SYSTEM,
        messages: [{ role: "user", content: `Call transcript:\n\n${transcript.slice(0, 200_000)}` }],
      });
      if (response.stop_reason === "refusal") throw new Error("summary declined by the model");
      if (response.stop_reason === "max_tokens") throw new Error("summary cut off (max_tokens)");
      const text = response.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") throw new Error("summary: no text in response");
      const parsed: unknown = JSON.parse(text.text);
      if (!isCallSummary(parsed)) throw new Error("summary: unexpected shape");
      return parsed;
    },
  };
}
