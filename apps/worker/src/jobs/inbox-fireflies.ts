/**
 * Fireflies.ai call transcripts and summaries for the unified inbox.
 *
 * Fireflies works in the background, so this is two jobs with the API's
 * webhook (apps/api/src/routes/webhooks-fireflies.ts) in between:
 *
 *   sendRecordingsToFireflies  – for each recording we hold in R2 ("stored"),
 *     hand Fireflies a short-lived signed download link, tagged with our
 *     recording id (client_reference_id). Only recent recordings are sent, so
 *     switching this on never bulk-sends the old backlog.
 *   (webhook)                  – Fireflies calls back; the API checks the
 *     signature and marks the recording ready (fireflies_ready_at).
 *   collectFirefliesResults    – fetch the transcript and summary for ready
 *     recordings and save them: transcript (plain text), transcript_lines
 *     (who said what), summary_json (the same shape the Claude summariser
 *     writes, so every screen that shows summaries keeps working).
 *
 * Off unless FIREFLIES_API_KEY is set. The webhook itself is configured in the
 * Fireflies app (Integrations → API → Webhook) with FIREFLIES_WEBHOOK_SECRET.
 */
import { and, eq, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { inboxRecording, type DbClient } from "@ms/db";
import type { RecordingStore } from "./inbox-recording-store.js";
import type { CallSummary, JobLogger } from "./inbox-voice.js";
import { publishProcessed } from "./inbox-voice.js";

const ENDPOINT = "https://api.fireflies.ai/graphql";
const MAX_ATTEMPTS = 5;
/** Recordings older than this are not sent automatically (no surprise backlog bill). */
const SEND_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
/** Fireflies queues uploads; give it a day to fetch the file. */
const LINK_TTL_S = 24 * 60 * 60;

// ── Fireflies API ────────────────────────────────────────────────────────────

export interface FirefliesSentence {
  index?: number | null;
  speaker_name?: string | null;
  text?: string | null;
  start_time?: number | string | null;
  end_time?: number | string | null;
}

export interface FirefliesTranscript {
  id: string;
  sentences?: FirefliesSentence[] | null;
  summary?: {
    overview?: string | null;
    gist?: string | null;
    short_summary?: string | null;
    action_items?: string | string[] | null;
  } | null;
  sentiments?: {
    positive_pct?: number | null;
    neutral_pct?: number | null;
    negative_pct?: number | null;
  } | null;
}

export interface FirefliesClient {
  uploadAudio(input: { url: string; title: string; clientReferenceId: string }): Promise<void>;
  /** null when Fireflies has no transcript with this id. */
  getTranscript(id: string): Promise<FirefliesTranscript | null>;
}

export class FirefliesError extends Error {}

type Fetch = typeof fetch;

export function firefliesClient(apiKey: string, fetchImpl: Fetch = fetch): FirefliesClient {
  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let body: {
      data?: T;
      errors?: { message?: string; code?: string; extensions?: { code?: string } }[];
    };
    try {
      body = JSON.parse(text);
    } catch {
      throw new FirefliesError(`Fireflies ${res.status}: ${text.slice(0, 200)}`);
    }
    if (body.errors?.length) {
      const e = body.errors[0]!;
      const code = e.code ?? e.extensions?.code;
      throw new FirefliesError(
        `Fireflies: ${code ? `${code}: ` : ""}${e.message ?? "error"}`.slice(0, 500),
      );
    }
    if (!res.ok || !body.data) throw new FirefliesError(`Fireflies ${res.status}: no data`);
    return body.data;
  }

  return {
    async uploadAudio({ url, title, clientReferenceId }) {
      const data = await gql<{ uploadAudio?: { success?: boolean; message?: string } }>(
        `mutation Upload($input: AudioUploadInput) { uploadAudio(input: $input) { success title message } }`,
        // bypass_size_check: short voicemails are under Fireflies' 50 KB minimum.
        { input: { url, title, client_reference_id: clientReferenceId, bypass_size_check: true } },
      );
      if (!data.uploadAudio?.success)
        throw new FirefliesError(
          `Fireflies upload refused: ${data.uploadAudio?.message ?? "no reason given"}`,
        );
    },

    async getTranscript(id) {
      const data = await gql<{ transcript: Omit<FirefliesTranscript, "sentiments"> | null }>(
        `query Transcript($id: String!) {
          transcript(id: $id) {
            id
            sentences { index speaker_name text start_time end_time }
            summary { overview gist short_summary action_items }
          }
        }`,
        { id },
      );
      if (!data.transcript) return null;
      // Sentiment needs Fireflies Pro; asked separately so a plan limit never blocks the transcript.
      let sentiments: FirefliesTranscript["sentiments"] = null;
      try {
        const a = await gql<{
          transcript: {
            analytics?: { sentiments?: FirefliesTranscript["sentiments"] } | null;
          } | null;
        }>(
          `query Sentiment($id: String!) { transcript(id: $id) { analytics { sentiments { positive_pct neutral_pct negative_pct } } } }`,
          { id },
        );
        sentiments = a.transcript?.analytics?.sentiments ?? null;
      } catch {
        /* no sentiment on this plan — mood is left neutral */
      }
      return { ...data.transcript, sentiments };
    },
  };
}

export function firefliesClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FirefliesClient | null {
  return env.FIREFLIES_API_KEY ? firefliesClient(env.FIREFLIES_API_KEY) : null;
}

// ── Turning a Fireflies transcript into what the suite stores ────────────────

export interface TranscriptLine {
  speaker: string;
  text: string;
  start_s: number | null;
  end_s: number | null;
}

function seconds(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function transcriptLines(t: FirefliesTranscript): TranscriptLine[] {
  return [...(t.sentences ?? [])]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((s) => ({
      speaker: s.speaker_name?.trim() || "Speaker",
      text: (s.text ?? "").trim(),
      start_s: seconds(s.start_time),
      end_s: seconds(s.end_time),
    }))
    .filter((l) => l.text.length > 0);
}

/** "Name: words" per turn; consecutive lines from one speaker are joined. */
export function transcriptText(lines: TranscriptLine[]): string {
  const turns: { speaker: string; text: string }[] = [];
  for (const l of lines) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === l.speaker) last.text += ` ${l.text}`;
    else turns.push({ speaker: l.speaker, text: l.text });
  }
  return turns.map((t) => `${t.speaker}: ${t.text}`).join("\n");
}

/**
 * Fireflies returns action items as one block of text, often grouped under a
 * bold speaker name ("**Tunde**\nSend the invoice (01:22)"). One item per line,
 * markdown, bullets and timestamps removed, headings dropped.
 */
export function actionItems(raw: string | string[] | null | undefined): string[] {
  const lines = Array.isArray(raw) ? raw : (raw ?? "").split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\*\*[^*]+\*\*:?$/.test(trimmed) || /^#+\s/.test(trimmed)) continue; // a heading, not an item
    const item = trimmed
      .replace(/^[-*•]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/\*\*/g, "")
      .replace(/\s*\(\d{1,2}:\d{2}(?::\d{2})?\)\s*$/, "")
      .trim();
    if (item) out.push(item);
  }
  return out;
}

export function sentiment(s: FirefliesTranscript["sentiments"]): CallSummary["sentiment"] {
  const pos = s?.positive_pct ?? 0;
  const neu = s?.neutral_pct ?? 0;
  const neg = s?.negative_pct ?? 0;
  if (pos > neu && pos > neg) return "positive";
  if (neg > neu && neg > pos) return "negative";
  return "neutral";
}

/** null when Fireflies has not written its summary yet. */
export function callSummary(t: FirefliesTranscript): CallSummary | null {
  const s = t.summary;
  const summary = (s?.overview || s?.short_summary || s?.gist || "").trim();
  if (!summary) return null;
  return {
    summary,
    call_reason: (s?.gist || s?.short_summary || "").trim(),
    action_items: actionItems(s?.action_items),
    sentiment: sentiment(t.sentiments),
  };
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

export interface FirefliesJobDeps {
  client: FirefliesClient | null;
  store?: RecordingStore | null;
  now?: Date;
  batchSize?: number;
}

function titleFor(kind: string, createdAt: Date): string {
  // No phone numbers or names: the title is visible in the Fireflies app.
  return `Mrs Samuel ${kind === "voicemail" ? "voicemail" : "call"} ${createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

async function recordFailure(
  db: DbClient,
  id: string,
  attempts: number,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await db
    .update(inboxRecording)
    .set({ attempts: attempts + 1, lastError: `fireflies: ${message}`.slice(0, 1000) })
    .where(eq(inboxRecording.id, id));
}

/** Send recent stored recordings to Fireflies. Returns how many were sent. */
export async function sendRecordingsToFireflies(
  db: DbClient,
  logger: JobLogger,
  deps: FirefliesJobDeps,
): Promise<number> {
  const { client, store } = deps;
  if (!client || !store?.presignGet) return 0;
  const now = deps.now ?? new Date();

  const rows = await db
    .select()
    .from(inboxRecording)
    .where(
      and(
        eq(inboxRecording.status, "stored"),
        isNotNull(inboxRecording.storageKey),
        isNull(inboxRecording.firefliesSentAt),
        gte(inboxRecording.createdAt, new Date(now.getTime() - SEND_WINDOW_MS)),
        lt(inboxRecording.attempts, MAX_ATTEMPTS),
      ),
    )
    .orderBy(inboxRecording.createdAt)
    .limit(deps.batchSize ?? 5);

  let sent = 0;
  for (const rec of rows) {
    try {
      await client.uploadAudio({
        url: store.presignGet(rec.storageKey!, LINK_TTL_S),
        title: titleFor(rec.kind, rec.createdAt),
        clientReferenceId: rec.id,
      });
      await db
        .update(inboxRecording)
        .set({ firefliesSentAt: now, lastError: null })
        .where(eq(inboxRecording.id, rec.id));
      sent++;
    } catch (err) {
      logger.warn({ err, recordingId: rec.id }, "fireflies: upload failed");
      await recordFailure(db, rec.id, rec.attempts, err);
    }
  }
  return sent;
}

/** Fetch results the webhook marked ready. Returns how many recordings were updated. */
export async function collectFirefliesResults(
  db: DbClient,
  logger: JobLogger,
  deps: FirefliesJobDeps,
): Promise<number> {
  const { client } = deps;
  if (!client) return 0;
  const now = deps.now ?? new Date();

  const rows = await db
    .select()
    .from(inboxRecording)
    .where(
      and(
        isNotNull(inboxRecording.firefliesReadyAt),
        isNotNull(inboxRecording.firefliesMeetingId),
        inArray(inboxRecording.status, ["stored", "transcribed"]),
        lt(inboxRecording.attempts, MAX_ATTEMPTS),
      ),
    )
    .orderBy(inboxRecording.firefliesReadyAt)
    .limit(deps.batchSize ?? 10);

  let done = 0;
  for (const rec of rows) {
    try {
      const t = await client.getTranscript(rec.firefliesMeetingId!);
      if (!t) throw new Error(`no transcript ${rec.firefliesMeetingId}`);
      const lines = transcriptLines(t);
      const summary = callSummary(t);
      const [updated] = await db
        .update(inboxRecording)
        .set({
          transcript: transcriptText(lines),
          transcriptLines: lines,
          // No summary yet: stay "transcribed" until Fireflies' meeting.summarized call.
          ...(summary
            ? { summaryJson: summary, status: "summarised" as const }
            : { status: "transcribed" as const }),
          firefliesReadyAt: null,
          lastError: null,
          processedAt: now,
        })
        // Only clear the flag we read: a newer webhook that arrived meanwhile stays set.
        .where(
          and(
            eq(inboxRecording.id, rec.id),
            eq(inboxRecording.firefliesReadyAt, rec.firefliesReadyAt!),
          ),
        )
        .returning();
      if (updated) {
        done++;
        await publishProcessed(db, updated);
      }
    } catch (err) {
      logger.warn({ err, recordingId: rec.id }, "fireflies: fetching the result failed");
      await recordFailure(db, rec.id, rec.attempts, err);
    }
  }
  return done;
}
