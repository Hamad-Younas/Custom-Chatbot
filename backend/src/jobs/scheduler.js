import cron from "node-cron";
import { env } from "../config/env.js";
import { query } from "../db/pool.js";
import { rollupDay } from "../services/analytics.js";
import { sweepChatImages } from "../services/imageCleanup.js";
import { retryDeletionRequests } from "../services/chatbots.js";
import { markInactiveInstallations } from "../services/install.js";
import { notify, runDeliveryQueue } from "../services/notifier.js";
import { visitorName } from "../services/serializers.js";
import { settingInt } from "../services/settings.js";
import { pollActiveJobs } from "../services/training.js";

function guard(name, fn) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      console.error(`[cron:${name}]`, e.message);
    } finally {
      running = false;
    }
  };
}

/** Conversations waiting for a person longer than N minutes → one 'conversation_waiting' alert. */
async function waitingAlerts() {
  const rows = await query(
    `SELECT c.id, c.chatbot_id, c.conversation_uid, v.name, v.visitor_uid FROM conversations c JOIN visitors v ON v.id = c.visitor_id
     WHERE c.human_requested = 1 AND c.status <> 'resolved' AND (c.handling_mode = 'ai' OR c.assigned_agent_id IS NULL) AND c.waiting_alert_sent_at IS NULL
       AND c.human_requested_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE) AND c.is_deleted = 0 LIMIT 50`,
    [env.CONVERSATION_WAITING_ALERT_MINUTES],
  );
  for (const c of rows) {
    await query("UPDATE conversations SET waiting_alert_sent_at = UTC_TIMESTAMP() WHERE id = ?", [c.id]);
    await notify({
      chatbotId: c.chatbot_id,
      event: "conversation_waiting",
      title: `${visitorName(c)} has been waiting ${env.CONVERSATION_WAITING_ALERT_MINUTES}+ minutes for a person`,
      conversationId: c.id,
      data: { conversation_uid: c.conversation_uid },
      dedupe: `wait:${c.id}`,
    });
  }
}

/** Retention: delete conversations / visitors older than the chatbot's configured limits. */
async function retention() {
  await query(
    `DELETE c FROM conversations c JOIN chatbot_settings s ON s.chatbot_id = c.chatbot_id
     WHERE s.retention_days_conversations IS NOT NULL AND c.last_message_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL s.retention_days_conversations DAY)`,
  );
  await query(
    `DELETE v FROM visitors v JOIN chatbot_settings s ON s.chatbot_id = v.chatbot_id
     WHERE s.retention_days_visitors IS NOT NULL AND v.last_seen_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL s.retention_days_visitors DAY)`,
  );
  await query("DELETE FROM auth_tokens WHERE expires_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)");
  await query("DELETE FROM user_sessions WHERE expires_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)");
  await query("DELETE FROM login_attempts WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 DAY)");
}

export function startScheduler() {
  const jobs = guard("training", pollActiveJobs);
  setInterval(jobs, Math.max(2, env.AI_JOB_POLL_SECONDS) * 1000);
  setInterval(guard("deliveries", runDeliveryQueue), 10_000);
  setInterval(guard("waiting", waitingAlerts), 60_000);
  cron.schedule("*/15 * * * *", guard("installations", async () => markInactiveInstallations(await settingInt("installation_inactive_after_hours", 72))));
  cron.schedule("*/10 * * * *", guard("deletions", retryDeletionRequests));
  // old chat images: delete files that left the last-N-messages window (messages are kept)
  const images = guard("chat-images", sweepChatImages);
  cron.schedule("*/10 * * * *", images);
  setTimeout(images, 30_000).unref?.();
  cron.schedule("15 3 * * *", guard("retention", retention), { timezone: "UTC" });
  cron.schedule("5 * * * *", guard("rollup", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    await rollupDay(yesterday);
    await rollupDay(today);
  }), { timezone: "UTC" });
  console.log("[cron] background jobs started");
}
