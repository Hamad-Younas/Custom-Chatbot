// Chat image cleanup — keeps server storage small.
// An image a visitor attached is kept only while it is among the last CHAT_IMAGE_KEEP_LAST_MESSAGES
// messages of its conversation (the same window the chat history uses). Once newer messages push it
// out, the image FILE is deleted from disk for good. The message row stays in the database; its
// metadata.attachment is marked { url: null, expired: true } and the widget/inbox show a placeholder.
//
// Runs two ways:
//   1. right after every new message in a conversation (scheduleImageCleanup, called from chatPipeline)
//   2. a safety sweep every 10 minutes (sweepChatImages, see jobs/scheduler.js) that also removes
//      images whose conversation was deleted and uploads that never got a message.
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { j, one, query, toJson } from "../db/pool.js";

const uploadRoot = path.resolve(env.UPLOAD_DIR);
// Messages that count towards the "last N messages" window (same as the chat history).
const COUNTED = "sender_type IN ('visitor','ai','human') AND content_type = 'text' AND is_deleted = 0";
const HAS_LIVE_IMAGE = "JSON_EXTRACT(metadata, '$.attachment') IS NOT NULL AND JSON_EXTRACT(metadata, '$.attachment.expired') IS NULL";

/** Delete one stored chat image from disk and mark its uploaded_files row deleted. */
async function removeStoredFile(fileId) {
  const f = fileId ? await one("SELECT id, storage_key, is_deleted FROM uploaded_files WHERE id = ?", [fileId]) : null;
  if (!f) return;
  if (!String(f.storage_key).startsWith("chat/")) return; // only ever touch chat images
  try {
    await fs.unlink(path.join(uploadRoot, f.storage_key));
  } catch (e) {
    if (e.code !== "ENOENT") throw e; // already gone is fine
  }
  if (!f.is_deleted) await query("UPDATE uploaded_files SET is_deleted = 1, deleted_at = UTC_TIMESTAMP() WHERE id = ?", [f.id]);
}

/** Delete the file first, then mark the message — if deleting fails, the next run tries again. */
async function expireMessageImage(m) {
  const meta = j(m.metadata, {}) || {};
  const a = meta.attachment;
  if (!a || a.expired) return false;
  await removeStoredFile(a.file_id);
  meta.attachment = {
    type: a.type || "image",
    name: a.name || null,
    mime: a.mime || null,
    size: a.size || null,
    file_id: a.file_id ?? null,
    url: null,
    expired: true,
    expired_at: new Date().toISOString(),
  };
  await query("UPDATE messages SET metadata = ? WHERE id = ?", [toJson(meta), m.id]);
  return true;
}

/**
 * Expire every image in the conversation that is no longer among its last `keep` messages
 * (or whose message / conversation was deleted). Returns how many images were removed.
 * `scanLimit` bounds the work done on every new message; the sweep passes null to check everything.
 */
export async function expireOldImages(conversationId, { keep = env.CHAT_IMAGE_KEEP_LAST_MESSAGES, scanLimit = 200 } = {}) {
  const conv = await one("SELECT id, is_deleted FROM conversations WHERE id = ?", [conversationId]);
  let cutoff = 0; // images in messages with id < cutoff are outside the window
  if (!conv || conv.is_deleted) cutoff = Number.MAX_SAFE_INTEGER;
  else {
    const edge = await one(`SELECT id FROM messages WHERE conversation_id = ? AND ${COUNTED} ORDER BY id DESC LIMIT 1 OFFSET ?`, [conversationId, Math.max(1, keep) - 1]);
    if (edge) cutoff = Number(edge.id);
  }
  const rows = await query(
    `SELECT id, metadata FROM messages WHERE conversation_id = ? AND (id < ? OR is_deleted = 1) AND ${HAS_LIVE_IMAGE}
     ORDER BY id DESC ${scanLimit ? "LIMIT " + Number(scanLimit) : ""}`,
    [conversationId, cutoff],
  );
  let n = 0;
  for (const m of rows) if (await expireMessageImage(m)) n++;
  return n;
}

// Debounced, fire-and-forget: never slows down or breaks sending a message.
const pending = new Set();
export function scheduleImageCleanup(conversationId) {
  if (!conversationId || pending.has(conversationId)) return;
  pending.add(conversationId);
  const t = setTimeout(() => {
    pending.delete(conversationId);
    expireOldImages(conversationId).catch((e) => console.error("[image-cleanup]", e.message));
  }, 1500);
  t.unref?.();
}

/**
 * Safety sweep over every chat image still on disk (uploaded_files rows under chat/).
 * - image's message found → run the normal "last N messages" check for its conversation
 * - no message for 1 hour (conversation deleted by retention, failed upload) → delete the file
 */
export async function sweepChatImages() {
  let lastId = 0;
  let removed = 0;
  for (;;) {
    const files = await query(
      `SELECT f.id,
              f.created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR) AS is_old,
              (SELECT m.conversation_id FROM messages m
                WHERE m.chatbot_id = f.chatbot_id
                  AND m.sent_at BETWEEN DATE_SUB(f.created_at, INTERVAL 10 MINUTE) AND DATE_ADD(f.created_at, INTERVAL 10 MINUTE)
                  AND JSON_EXTRACT(m.metadata, '$.attachment.file_id') = f.id
                LIMIT 1) AS conversation_id
       FROM uploaded_files f
       WHERE f.is_deleted = 0 AND f.purpose = 'other' AND f.storage_key LIKE 'chat/%' AND f.chatbot_id IS NOT NULL AND f.id > ?
       ORDER BY f.id LIMIT 200`,
      [lastId],
    );
    if (!files.length) break;
    const convs = new Set();
    for (const f of files) {
      lastId = Number(f.id);
      if (f.conversation_id) convs.add(Number(f.conversation_id));
      else if (Number(f.is_old)) {
        await removeStoredFile(f.id);
        removed++;
      }
    }
    for (const c of convs) removed += await expireOldImages(c, { scanLimit: null });
  }
  if (removed) console.log(`[image-cleanup] removed ${removed} old chat image(s)`);
  return removed;
}