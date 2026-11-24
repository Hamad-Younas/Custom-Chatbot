// Mapping between the dashboard/widget config object and the chatbot_* tables.
import { env } from "../config/env.js";
import { j, one, query, toJson } from "../db/pool.js";
import { z } from "../utils/validate.js";

export const TEMPLATE_PRESETS = {
  minimal: {
    primaryColor: "#1f1d1a", secondaryColor: "#6b6660", backgroundColor: "#ffffff", textColor: "#1f1d1a", headerColor: "#ffffff",
    bubbleColor: "#1f1d1a", botBubbleColor: "#f3f1ec", sendColor: "#1f1d1a", radius: 18, shadow: "soft",
  },
  gradient: {
    primaryColor: "#e5482f", secondaryColor: "#f59e0b", backgroundColor: "#fffaf5", textColor: "#1f1d1a", headerColor: "#e5482f",
    bubbleColor: "#e5482f", botBubbleColor: "#ffffff", sendColor: "#e5482f", radius: 24, shadow: "strong",
  },
  professional: {
    primaryColor: "#1d4ed8", secondaryColor: "#0f172a", backgroundColor: "#f8fafc", textColor: "#0f172a", headerColor: "#0f172a",
    bubbleColor: "#1d4ed8", botBubbleColor: "#ffffff", sendColor: "#1d4ed8", radius: 12, shadow: "strong",
  },
};
const TEMPLATE_TO_DB = { minimal: "modern_minimal", gradient: "modern_gradient", professional: "professional_support" };
const TEMPLATE_FROM_DB = Object.fromEntries(Object.entries(TEMPLATE_TO_DB).map(([a, b]) => [b, a]));

export function defaultConfig({ companyName = "", assistantName = "Assistant" } = {}) {
  return {
    template: "gradient",
    ...TEMPLATE_PRESETS.gradient,
    title: companyName ? `${companyName} Help`.slice(0, 100) : "Chat with us",
    subtitle: "We usually reply in a few seconds",
    assistantName,
    avatar: "✦",
    companyName: companyName || "",
    launcherIcon: "chat",
    launcherSize: 60,
    launcherAnimation: "pulse",
    position: "right",
    width: 380,
    height: 600,
    fontFamily: "Hanken Grotesk",
    fontSize: 14,
    theme: "light",
    online: true,
    availabilityText: "Online — AI replies instantly",
    offlineText: "We're away, leave a message",
    welcomeEnabled: true,
    welcomeMessage: `Hi there 👋 I'm ${assistantName}${companyName ? `, the ${companyName} assistant` : ""}. How can I help you today?`.slice(0, 300),
    suggestions: [],
    ctas: [],
    announcementEnabled: false,
    announcementText: "",
    showBranding: true,
  };
}

const hex = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "Use a hex color like #1F3A5F");
const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => {
    try {
      return ["http:", "https:"].includes(new URL(v).protocol);
    } catch {
      return false;
    }
  }, "Use a full link starting with https://");

export const configSchema = z
  .object({
    template: z.enum(["minimal", "gradient", "professional"]),
    primaryColor: hex, secondaryColor: hex, backgroundColor: hex, textColor: hex, headerColor: hex,
    bubbleColor: hex, botBubbleColor: hex, sendColor: hex,
    radius: z.coerce.number().int().min(0).max(40),
    shadow: z.enum(["none", "soft", "medium", "strong"]),
    title: z.string().trim().min(1).max(100),
    subtitle: z.string().trim().max(200),
    assistantName: z.string().trim().min(1).max(60),
    avatar: z.string().max(8),
    companyName: z.string().trim().max(150),
    launcherIcon: z.enum(["chat", "sparkle", "help", "wave"]),
    launcherSize: z.coerce.number().int().min(40).max(90),
    launcherAnimation: z.enum(["none", "pulse", "bounce", "wiggle"]),
    position: z.enum(["left", "right"]),
    width: z.coerce.number().int().min(300).max(480),
    height: z.coerce.number().int().min(400).max(800),
    fontFamily: z.string().trim().min(1).max(150),
    fontSize: z.coerce.number().int().min(11).max(20),
    theme: z.enum(["light", "dark", "auto"]),
    online: z.boolean(),
    availabilityText: z.string().trim().max(150),
    offlineText: z.string().trim().max(150),
    welcomeEnabled: z.boolean(),
    welcomeMessage: z.string().max(1000),
    suggestions: z.array(z.string().trim().min(1).max(300)).max(10),
    ctas: z.array(z.object({ label: z.string().trim().min(1).max(100), url: httpUrl })).max(6),
    announcementEnabled: z.boolean(),
    announcementText: z.string().trim().max(1000),
    showBranding: z.boolean(),
  })
  .partial();

/** Read the live (published) config from the chatbot tables. */
export async function readPublishedConfig(chatbotId, conn) {
  const a = await one("SELECT * FROM chatbot_appearance WHERE chatbot_id = ? AND is_deleted = 0", [chatbotId], conn);
  const s = await one("SELECT * FROM chatbot_settings WHERE chatbot_id = ? AND is_deleted = 0", [chatbotId], conn);
  if (!a || !s) return null;
  const welcome = await one(
    "SELECT message FROM welcome_messages WHERE chatbot_id = ? AND is_deleted = 0 ORDER BY priority DESC, id LIMIT 1",
    [chatbotId],
    conn,
  );
  const sugg = await query("SELECT question FROM suggested_questions WHERE chatbot_id = ? AND is_deleted = 0 AND is_enabled = 1 ORDER BY sort_order, id", [chatbotId], conn);
  const ctas = await query("SELECT label, url FROM cta_buttons WHERE chatbot_id = ? AND is_deleted = 0 AND is_enabled = 1 ORDER BY sort_order, id", [chatbotId], conn);
  const ann = await one("SELECT title, is_enabled FROM announcements WHERE chatbot_id = ? AND is_deleted = 0 ORDER BY id LIMIT 1", [chatbotId], conn);
  const extra = j(a.extra, {});
  const fileUrl = async (id) => {
    if (!id) return null;
    const f = await one("SELECT storage_key FROM uploaded_files WHERE id = ? AND is_deleted = 0", [id], conn);
    return f ? `${env.PUBLIC_API_URL}/uploads/${f.storage_key}` : null;
  };
  const avatarUrl = await fileUrl(a.avatar_file_id);
  const logoUrl = await fileUrl(a.logo_file_id);
  const template = TEMPLATE_FROM_DB[a.template_key] || "gradient";
  return {
    template,
    primaryColor: a.primary_color,
    secondaryColor: a.secondary_color,
    backgroundColor: a.background_color,
    textColor: a.text_color,
    headerColor: a.header_color || TEMPLATE_PRESETS[template].headerColor,
    bubbleColor: a.user_bubble_color || a.primary_color,
    botBubbleColor: a.bot_bubble_color || TEMPLATE_PRESETS[template].botBubbleColor,
    sendColor: a.send_button_color || a.primary_color,
    radius: a.border_radius,
    shadow: a.shadow,
    title: a.title,
    subtitle: a.subtitle || "",
    assistantName: a.assistant_name,
    avatar: extra.avatar ?? "✦",
    companyName: a.company_branding || "",
    launcherIcon: a.launcher_icon,
    launcherSize: a.launcher_size,
    launcherAnimation: a.launcher_animation,
    position: a.position === "bottom-left" ? "left" : "right",
    width: a.width,
    height: a.height,
    fontFamily: a.font_family,
    fontSize: a.font_size,
    theme: a.theme,
    online: s.availability_mode !== "always_offline",
    availabilityText: s.online_text || "",
    offlineText: s.offline_text || "",
    welcomeEnabled: Boolean(s.welcome_enabled),
    welcomeMessage: welcome?.message || "",
    suggestions: sugg.map((r) => r.question),
    ctas: ctas.map((r) => ({ label: r.label, url: r.url || "" })),
    announcementEnabled: Boolean(ann?.is_enabled),
    announcementText: ann?.title || "",
    showBranding: Boolean(a.show_powered_by),
    avatarUrl,
    logoUrl,
  };
}

/** Write a full config object into the chatbot tables (inside a transaction). */
export async function writePublishedConfig(conn, chatbotId, c) {
  await query(
    `UPDATE chatbot_appearance SET template_key=?, theme=?, primary_color=?, secondary_color=?, background_color=?, text_color=?, header_color=?,
       header_text_color=?, user_bubble_color=?, user_bubble_text_color='#FFFFFF', bot_bubble_color=?, bot_bubble_text_color=?, send_button_color=?,
       gradient_css=?, title=?, subtitle=?, assistant_name=?, company_branding=?, show_powered_by=?, launcher_icon=?, launcher_size=?,
       launcher_animation=?, position=?, width=?, height=?, border_radius=?, shadow=?, font_family=?, font_size=?, extra=?
     WHERE chatbot_id=?`,
    [
      TEMPLATE_TO_DB[c.template] || "modern_gradient", c.theme, c.primaryColor, c.secondaryColor, c.backgroundColor, c.textColor, c.headerColor,
      c.template === "minimal" ? c.textColor : "#FFFFFF", c.bubbleColor, c.botBubbleColor, c.textColor, c.sendColor,
      c.template === "gradient" ? `linear-gradient(135deg,${c.primaryColor},${c.secondaryColor})` : null,
      c.title, c.subtitle || null, c.assistantName, c.companyName || null, c.showBranding ? 1 : 0, c.launcherIcon, c.launcherSize,
      c.launcherAnimation, c.position === "left" ? "bottom-left" : "bottom-right", c.width, c.height, c.radius, c.shadow, c.fontFamily, c.fontSize,
      toJson({ avatar: c.avatar }), chatbotId,
    ],
    conn,
  );
  await query(
    "UPDATE chatbot_settings SET welcome_enabled=?, show_suggested_questions=?, availability_mode=?, online_text=?, offline_text=? WHERE chatbot_id=?",
    [c.welcomeEnabled ? 1 : 0, c.suggestions.length ? 1 : 0, c.online ? "always_online" : "always_offline", c.availabilityText || null, c.offlineText || null, chatbotId],
    conn,
  );
  const w = await one("SELECT id FROM welcome_messages WHERE chatbot_id=? AND is_deleted=0 ORDER BY priority DESC, id LIMIT 1", [chatbotId], conn);
  if (w) await query("UPDATE welcome_messages SET message=?, is_enabled=? WHERE id=?", [c.welcomeMessage || "", c.welcomeEnabled ? 1 : 0, w.id], conn);
  else await query("INSERT INTO welcome_messages (chatbot_id, message, is_enabled) VALUES (?,?,?)", [chatbotId, c.welcomeMessage || "", c.welcomeEnabled ? 1 : 0], conn);

  await query("UPDATE suggested_questions SET is_deleted=1, deleted_at=UTC_TIMESTAMP() WHERE chatbot_id=? AND is_deleted=0", [chatbotId], conn);
  for (const [i, q] of c.suggestions.entries()) await query("INSERT INTO suggested_questions (chatbot_id, question, sort_order) VALUES (?,?,?)", [chatbotId, q, i], conn);

  await query("UPDATE cta_buttons SET is_deleted=1, deleted_at=UTC_TIMESTAMP() WHERE chatbot_id=? AND is_deleted=0", [chatbotId], conn);
  for (const [i, b] of c.ctas.entries())
    await query("INSERT INTO cta_buttons (chatbot_id, label, action_type, url, sort_order) VALUES (?,?, 'link', ?, ?)", [chatbotId, b.label, b.url, i], conn);

  const ann = await one("SELECT id FROM announcements WHERE chatbot_id=? AND is_deleted=0 ORDER BY id LIMIT 1", [chatbotId], conn);
  const annTitle = (c.announcementText || "").slice(0, 150) || "Announcement";
  if (ann) await query("UPDATE announcements SET title=?, body=?, is_enabled=? WHERE id=?", [annTitle, c.announcementText || null, c.announcementEnabled ? 1 : 0, ann.id], conn);
  else if (c.announcementText || c.announcementEnabled)
    await query("INSERT INTO announcements (chatbot_id, title, body, is_enabled) VALUES (?,?,?,?)", [chatbotId, annTitle, c.announcementText || null, c.announcementEnabled ? 1 : 0], conn);
}

/** Create appearance/settings rows for a new chatbot. */
export async function insertDefaultRows(conn, chatbotId, config) {
  await query("INSERT INTO chatbot_appearance (chatbot_id) VALUES (?)", [chatbotId], conn);
  await query(
    `INSERT INTO chatbot_settings (chatbot_id, not_found_message, error_message, handover_requested_message, no_agent_message, consent_text)
     VALUES (?,?,?,?,?,?)`,
    [
      chatbotId,
      "I couldn't find that in our information. Could you rephrase, or would you like to talk to a person?",
      "Sorry, I'm having trouble answering right now. Please try again in a moment.",
      "Of course — I've let the team know you'd like to talk to a person. Someone will join this chat shortly.",
      "Our team isn't online right now. Leave your email and we'll get back to you as soon as possible.",
      "We store this chat to help answer your questions.",
    ],
    conn,
  );
  await writePublishedConfig(conn, chatbotId, config);
}
