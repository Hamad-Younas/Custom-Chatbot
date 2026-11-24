import { UAParser } from "ua-parser-js";

export function parseUserAgent(ua) {
  const r = new UAParser(ua || "").getResult();
  const t = r.device?.type;
  let device_type = "desktop";
  if (!ua) device_type = "unknown";
  else if (/bot|crawl|spider|slurp|headless/i.test(ua)) device_type = "bot";
  else if (t === "mobile") device_type = "mobile";
  else if (t === "tablet") device_type = "tablet";
  return {
    browser: r.browser?.name ? r.browser.name.slice(0, 60) : null,
    os: r.os?.name ? r.os.name.slice(0, 60) : null,
    device_type,
  };
}

export function deviceLabel(ua) {
  const p = parseUserAgent(ua);
  return [p.browser, p.os].filter(Boolean).join(" on ") || "Unknown device";
}

/** Country from common CDN/proxy headers (Cloudflare, Vercel, Fastly, CloudFront). */
export function geoFromHeaders(headers) {
  const c = headers["cf-ipcountry"] || headers["x-vercel-ip-country"] || headers["x-country-code"] || headers["cloudfront-viewer-country"];
  const city = headers["x-vercel-ip-city"] || headers["cf-ipcity"] || null;
  return {
    country_code: c && /^[A-Z]{2}$/i.test(c) && c.toUpperCase() !== "XX" ? c.toUpperCase() : null,
    city: city ? decodeURIComponent(String(city)).slice(0, 100) : null,
  };
}
