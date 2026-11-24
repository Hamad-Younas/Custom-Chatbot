// WhatsApp Business Cloud API (official Meta Graph API).
const VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";

async function graph(path, token, body) {
  const res = await fetch(`https://graph.facebook.com/${VERSION}/${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `WhatsApp error (HTTP ${res.status})`);
    err.httpStatus = res.status;
    err.permanent = [400, 401, 403, 404].includes(res.status);
    throw err;
  }
  return data;
}

const digits = (s) => String(s ?? "").replace(/[^\d]/g, "");

export const whatsapp = {
  async verify({ credentials, config }) {
    if (!config.phone_number_id) throw Object.assign(new Error("Phone number ID is required."), { permanent: true });
    if (!credentials.access_token) throw Object.assign(new Error("Access token is required."), { permanent: true });
    if (!digits(config.to)) throw Object.assign(new Error("Recipient number is required."), { permanent: true });
    const info = await graph(`${encodeURIComponent(config.phone_number_id)}?fields=display_phone_number,verified_name`, credentials.access_token);
    return { display_name: info.verified_name || info.display_phone_number || "WhatsApp Business" };
  },
  async send({ credentials, config }, { title, body, url }) {
    const text = `*${title}*${body ? `\n${body}` : ""}${url ? `\n\n${url}` : ""}`.slice(0, 4000);
    // Outside the 24-hour service window Meta only delivers approved templates: set template_name to use one.
    const payload = config.template_name
      ? {
          messaging_product: "whatsapp",
          to: digits(config.to),
          type: "template",
          template: {
            name: config.template_name,
            language: { code: config.template_lang || "en_US" },
            components: [{ type: "body", parameters: [{ type: "text", text: text.slice(0, 1000) }] }],
          },
        }
      : { messaging_product: "whatsapp", to: digits(config.to), type: "text", text: { body: text, preview_url: false } };
    const r = await graph(`${encodeURIComponent(config.phone_number_id)}/messages`, credentials.access_token, payload);
    return { providerMessageId: r?.messages?.[0]?.id ?? null, httpStatus: 200 };
  },
};
