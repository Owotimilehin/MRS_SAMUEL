/**
 * Unified-inbox background jobs, on their own loop so a slow media or
 * recording download can never hold up the shop's jobs (outbox, payments,
 * deliveries) in the main worker loop.
 *
 * Safe with more than one worker process: each job takes a Postgres advisory
 * lock for its run, and a worker that can't get it simply skips that tick.
 */
import { sql } from "drizzle-orm";
import type { DbClient } from "@ms/db";
import { runJob } from "./jobs/run-job.js";
import {
  retryWebhookEvents,
  downloadPendingMedia,
  sendAutoReplies,
  syncAllTemplates,
  refreshPendingTemplates,
  syncAllFlows,
} from "./jobs/inbox-whatsapp.js";
import { processPendingRecordings, sendMissedCallFollowups } from "./jobs/inbox-voice.js";
import { claudeSummariserFromEnv } from "./jobs/inbox-summary.js";
import { collectFirefliesResults, firefliesClientFromEnv, sendRecordingsToFireflies } from "./jobs/inbox-fireflies.js";
import { recordingStoreFromEnv } from "./jobs/inbox-recording-store.js";
import { sendMessagePushes } from "./jobs/inbox-push.js";
import { ensureMetaSubscriptions, refreshIdentityProfiles } from "./jobs/inbox-meta.js";
import { checkMetaHealth } from "./jobs/inbox-meta-health.js";
import { backfillComments, fillCommentDetails, pollComments } from "./jobs/social-comments.js";
import { runCatalogueBatchCheck, runCatalogueReconcile, runCatalogueSync, runChatOrderJobs } from "./jobs/catalogue.js";
import { publishDuePosts, reconcileUnknownTargets } from "./jobs/social-publish.js";
import { collectInsightsIfDue } from "./jobs/insights-collect.js";
import { backfillLeads, fetchLeads, syncForms } from "./jobs/leads.js";
import { runAdAttribution, runAdGuard, runAdPurchaseReports, runAdSyncIfDue, runAdTouchScan } from "./jobs/ads.js";
import {
  applyContactImports,
  cleanupContactImports,
  rebuildContactSummaries,
  refreshContactSummaries,
  sendContactConsentConfirmations,
} from "./jobs/contacts.js";
import { alertDueReminders, wakeSnoozed } from "./jobs/inbox-tasks.js";
import { checkBroadcastHealth, sendBroadcasts, startBroadcasts, sweepBroadcastRecipients } from "./jobs/broadcasts.js";

type Logger = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
};

/**
 * Run fn only if no other worker is running the same job. The lock lives for
 * the surrounding transaction, which stays open (idle) while fn works through
 * the normal connection pool.
 */
export async function withJobLock<T>(db: DbClient, name: string, fn: () => Promise<T>): Promise<T | undefined> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ got: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${`inbox-job:${name}`})) as got`,
    );
    const got = (rows as unknown as { got: boolean }[])[0]?.got === true;
    if (!got) return undefined;
    return fn();
  });
}

interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
  last: number;
  /**
   * The job guards itself against a second worker and must not run inside withJobLock's
   * open transaction (a run that talks to Meta for minutes: suite spec 11).
   */
  ownLock?: true;
}

export async function runInboxLoop(db: DbClient, logger: Logger, isStopping: () => boolean): Promise<void> {
  const fireflies = firefliesClientFromEnv();
  const recordingStore = recordingStoreFromEnv();
  // With Fireflies on, it writes the summaries; Claude would otherwise race it for
  // recordings sitting at "transcribed" while Fireflies finishes its summary.
  const summariser = fireflies ? null : claudeSummariserFromEnv();
  const jobs: Job[] = [
    { name: "inbox_push", everyMs: 5_000, last: 0, run: () => sendMessagePushes(db, logger) },
    { name: "inbox_auto_reply", everyMs: 10_000, last: 0, run: () => sendAutoReplies(db, logger) },
    { name: "inbox_media", everyMs: 10_000, last: 0, run: () => downloadPendingMedia(db, logger) },
    { name: "inbox_recordings", everyMs: 15_000, last: 0, run: () => processPendingRecordings(db, logger, { summariser }) },
    // Fireflies transcripts (off without FIREFLIES_API_KEY): send recent recordings, then collect what its webhook marked ready.
    { name: "fireflies_send", everyMs: 30_000, last: 0, run: () => sendRecordingsToFireflies(db, logger, { client: fireflies, store: recordingStore }) },
    { name: "fireflies_collect", everyMs: 15_000, last: 0, run: () => collectFirefliesResults(db, logger, { client: fireflies }) },
    { name: "inbox_webhook_retry", everyMs: 30_000, last: 0, run: () => retryWebhookEvents(db, logger) },
    { name: "inbox_followups", everyMs: 60_000, last: 0, run: () => sendMissedCallFollowups(db, logger) },
    { name: "inbox_template_sync", everyMs: 60 * 60_000, last: 0, run: () => syncAllTemplates(db, logger) },
    { name: "inbox_template_pending", everyMs: 5 * 60_000, last: 0, run: () => refreshPendingTemplates(db, logger) },
    // WhatsApp forms (suite spec 07): status only; no job creates, publishes, retires or sends a form.
    { name: "wa_flow_sync", everyMs: 60 * 60_000, last: 0, run: () => syncAllFlows(db, logger) },
    { name: "inbox_identity_profiles", everyMs: 30_000, last: 0, run: () => refreshIdentityProfiles(db, logger) },
    { name: "inbox_meta_subscriptions", everyMs: 60 * 60_000, last: 0, run: () => ensureMetaSubscriptions(db, logger) },
    // Watchdog (blueprint stage 1): reads only. Listed after the subscription check so it reads that run's result.
    { name: "meta_connection_health", everyMs: 60 * 60_000, last: 0, run: () => checkMetaHealth(db, logger) },
    // Comments on Facebook and Instagram posts (suite spec 03): these only read from Meta.
    { name: "social_comment_fill", everyMs: 15_000, last: 0, run: () => fillCommentDetails(db, logger) },
    { name: "social_comment_backfill", everyMs: 60_000, last: 0, run: () => backfillComments(db, logger) },
    { name: "social_comment_poll", everyMs: 5 * 60_000, last: 0, run: () => pollComments(db, logger) },
    // Catalogue sync (suite spec 08). Nothing is sent unless the owner has switched sync on.
    { name: "catalogue_sync", everyMs: 10_000, last: 0, run: () => runCatalogueSync(db, logger) },
    { name: "catalogue_batch_check", everyMs: 20_000, last: 0, run: () => runCatalogueBatchCheck(db, logger) },
    { name: "catalogue_reconcile", everyMs: 30 * 60_000, last: 0, run: () => runCatalogueReconcile(db, logger) },
    // Automatic cart questions and order updates: each behind an owner switch, off by default.
    { name: "catalogue_chat_orders", everyMs: 10_000, last: 0, run: () => runChatOrderJobs(db, logger) },
    // Posts to Facebook and Instagram (suite spec 09). Only posts a person approved are ever sent.
    { name: "social_publish", everyMs: 30_000, last: 0, run: () => publishDuePosts(db, logger) },
    { name: "social_publish_reconcile", everyMs: 60_000, last: 0, run: () => reconcileUnknownTargets(db, logger) },
    { name: "insights_collect", everyMs: 10 * 60_000, last: 0, ownLock: true, run: () => collectInsightsIfDue(db, logger) },
    // Lead forms (suite spec 13).
    { name: "lead_fetch", everyMs: 15_000, last: 0, run: () => fetchLeads(db, logger) },
    { name: "lead_backfill", everyMs: 60_000, last: 0, run: () => backfillLeads(db, logger) },
    { name: "lead_forms_sync", everyMs: 6 * 60 * 60_000, last: 0, run: () => syncForms(db, logger) },
    // Ads (suite spec 12). Reading only, except: purchase reports (owner switch, off by default) and
    // ads_guard, which can only PAUSE an advert (the safety stop, and rules behind their owner switch).
    { name: "ads_touch_scan", everyMs: 60_000, last: 0, run: () => runAdTouchScan(db, logger) },
    { name: "ads_attribute", everyMs: 5 * 60_000, last: 0, run: () => runAdAttribution(db, logger) },
    { name: "ads_report_purchases", everyMs: 60_000, last: 0, run: () => runAdPurchaseReports(db, logger) },
    { name: "ads_sync", everyMs: 15 * 60_000, last: 0, run: () => runAdSyncIfDue(db, logger) },
    { name: "ads_guard", everyMs: 15 * 60_000, last: 0, run: () => runAdGuard(db, logger) },
    // Contacts (suite spec 14, Phase A).
    { name: "contact_summary_refresh", everyMs: 60_000, last: 0, run: () => refreshContactSummaries(db, logger) },
    { name: "contact_summary_rebuild", everyMs: 24 * 60 * 60_000, last: 0, run: () => rebuildContactSummaries(db, logger) },
    { name: "contact_consent_confirm", everyMs: 10_000, last: 0, run: () => sendContactConsentConfirmations(db, logger) },
    { name: "contact_import_apply", everyMs: 5_000, last: 0, run: () => applyContactImports(db, logger) },
    { name: "contact_import_cleanup", everyMs: 24 * 60 * 60_000, last: 0, run: () => cleanupContactImports(db, logger) },
    // Tasks and reminders (suite spec 15). Nothing is sent to a customer.
    { name: "inbox_snooze_wake", everyMs: 30_000, last: 0, run: () => wakeSnoozed(db, logger) },
    { name: "inbox_reminders_due", everyMs: 30_000, last: 0, run: () => alertDueReminders(db, logger) },
    // Broadcasts (suite spec 14, Phase B). The system only stops a broadcast; a person resumes it.
    { name: "broadcast_start", everyMs: 30_000, last: 0, run: () => startBroadcasts(db, logger) },
    { name: "broadcast_send", everyMs: 5_000, last: 0, run: () => sendBroadcasts(db, logger) },
    { name: "broadcast_sweep", everyMs: 60_000, last: 0, run: () => sweepBroadcastRecipients(db, logger) },
    { name: "broadcast_health", everyMs: 5 * 60_000, last: 0, run: () => checkBroadcastHealth(db, logger) },
  ];
  logger.info({ jobs: jobs.map((j) => j.name) }, "inbox loop started");
  while (!isStopping()) {
    for (const job of jobs) {
      if (isStopping()) break;
      const now = Date.now();
      if (now - job.last < job.everyMs) continue;
      job.last = now;
      await runJob(logger, job.name, job.ownLock ? job.run : () => withJobLock(db, job.name, job.run));
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
