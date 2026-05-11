import pino from "pino";

const logger = pino({ base: { service: "ms-worker", part: "telegram" } });

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  logger.warn("TELEGRAM_BOT_TOKEN not set — telegram messages will be skipped");
}

/**
 * Send a Markdown-formatted message to a single Telegram chat (channel id).
 * Errors are surfaced to the caller so the outbox can mark the event as
 * failed and back off.
 */
export async function sendMessage(chatId: string, text: string): Promise<void> {
  if (!TOKEN) return;
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`telegram send failed: ${res.status} ${body}`);
  }
}

/**
 * Channel id lookup. Owner sets these as env vars; if a channel id is
 * missing we just skip that recipient rather than failing the whole event.
 */
export const channels = {
  owner: (): string | undefined => process.env.TELEGRAM_OWNER_CHANNEL_ID,
  factory: (): string | undefined => process.env.TELEGRAM_FACTORY_CHANNEL_ID,
  branchAjao: (): string | undefined => process.env.TELEGRAM_BRANCH_AJAO_CHANNEL_ID,
};
