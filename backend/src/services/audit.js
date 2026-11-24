import { query, toJson } from "../db/pool.js";

/** Security/admin audit trail. Never pass passwords, tokens or secrets in values/metadata. */
export async function audit(req, { action, userId = null, chatbotId = null, entityType = null, entityId = null, outcome = "success", oldValues, newValues, metadata, actorType = "user" }) {
  try {
    await query(
      `INSERT INTO audit_logs (actor_type, user_id, chatbot_id, action, entity_type, entity_id, outcome, old_values, new_values, metadata, ip_address, user_agent, request_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        actorType,
        userId ?? req?.user?.id ?? null,
        chatbotId,
        action,
        entityType,
        entityId === null || entityId === undefined ? null : String(entityId),
        outcome,
        toJson(oldValues),
        toJson(newValues),
        toJson(metadata),
        req?.ip ?? null,
        req?.get?.("user-agent")?.slice(0, 500) ?? null,
        req?.id ?? null,
      ],
    );
  } catch (e) {
    console.error("[audit] failed to write audit log:", e.message);
  }
}
