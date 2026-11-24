// Chatbot images (widget avatar / logo). Applied immediately to the live widget.
import { Router } from "express";
import { one, query } from "../db/pool.js";
import { requireManager } from "../middleware/auth.js";
import { toWidgets } from "../realtime/bus.js";
import { ah, badRequest, notFound } from "../utils/errors.js";
import { imageUpload, removeFile, saveImage } from "./account.routes.js";

const r = Router({ mergeParams: true });
const COL = { avatar: "avatar_file_id", logo: "logo_file_id" };

r.post("/:purpose", requireManager, imageUpload.single("file"), ah(async (req, res) => {
  const col = COL[req.params.purpose];
  if (!col) throw notFound("Unknown asset type.");
  if (!req.file) throw badRequest("Choose an image to upload.");
  const saved = await saveImage(req.file, { userId: req.user.id, chatbotId: req.chatbot.id, purpose: req.params.purpose });
  const a = await one(`SELECT ${col} AS f FROM chatbot_appearance WHERE chatbot_id = ?`, [req.chatbot.id]);
  await query(`UPDATE chatbot_appearance SET ${col} = ? WHERE chatbot_id = ?`, [saved.id, req.chatbot.id]);
  await query("UPDATE chatbots SET settings_version = settings_version + 1 WHERE id = ?", [req.chatbot.id]);
  if (a?.f) await removeFile(a.f);
  toWidgets(req.chatbot.id, "config_updated", {});
  res.json({ url: saved.url });
}));

r.delete("/:purpose", requireManager, ah(async (req, res) => {
  const col = COL[req.params.purpose];
  if (!col) throw notFound("Unknown asset type.");
  const a = await one(`SELECT ${col} AS f FROM chatbot_appearance WHERE chatbot_id = ?`, [req.chatbot.id]);
  await query(`UPDATE chatbot_appearance SET ${col} = NULL WHERE chatbot_id = ?`, [req.chatbot.id]);
  if (a?.f) await removeFile(a.f);
  toWidgets(req.chatbot.id, "config_updated", {});
  res.json({ ok: true });
}));

export default r;
