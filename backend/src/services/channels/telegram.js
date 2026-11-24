const API = "https://api.telegram.org";

async function call(token, method, body) {
  const res = await fetch(`${API}/bot${encodeURIComponent(token)}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const err = new Error(data.description || `Telegram error (HTTP ${res.status})`);
    err.httpStatus = res.status;
    err.permanent = res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404;
    throw err;
  }
  return data.result;
}

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

export const telegram = {
  async verify({ credentials, config }) {
    if (!credentials.bot_token) throw Object.assign(new Error("Bot token is required."), { permanent: true });
    if (!config.chat_id) throw Object.assign(new Error("Destination chat ID is required."), { permanent: true });
    const me = await call(credentials.bot_token, "getMe");
    return { display_name: me.username ? `@${me.username}` : me.first_name };
  },
  async send({ credentials, config }, { title, body, url }) {
    const text = `<b>${esc(title)}</b>${body ? `\n${esc(body)}` : ""}${url ? `\n\n<a href="${esc(url)}">Open in dashboard</a>` : ""}`;
    const r = await call(credentials.bot_token, "sendMessage", { chat_id: config.chat_id, text, parse_mode: "HTML", disable_web_page_preview: true });
    return { providerMessageId: String(r.message_id ?? ""), httpStatus: 200 };
  },
};
