import nodemailer from "nodemailer";
import { env } from "../config/env.js";

let platformTransport = null;
export function platformMailConfigured() {
  return Boolean(env.SMTP_HOST);
}
function transportFor(cfg) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port || 587),
    secure: Boolean(cfg.secure),
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
}
function platform() {
  if (!platformTransport) {
    platformTransport = transportFor({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE, user: env.SMTP_USER, pass: env.SMTP_PASSWORD });
  }
  return platformTransport;
}

/** Send through the platform SMTP (env) or an integration's own SMTP settings. */
export async function sendMail({ to, subject, html, text, smtp }) {
  if (!smtp && !platformMailConfigured()) {
    if (env.MAIL_DEV_LOG) {
      console.log(`\n──────── [dev email] ────────\nTo: ${to}\nSubject: ${subject}\n\n${text}\n─────────────────────────────\n`);
      return { providerMessageId: "dev-log", devLogged: true };
    }
    const e = new Error("Email is not configured (SMTP_HOST is empty).");
    e.permanent = true;
    throw e;
  }
  const t = smtp ? transportFor(smtp) : platform();
  const info = await t.sendMail({ from: smtp?.from || env.MAIL_FROM, to, subject, html, text });
  return { providerMessageId: info.messageId };
}

export async function verifySmtp(smtp) {
  await transportFor(smtp).verify();
}

// ---------------------------------------------------------------- templates
const wrap = (title, bodyHtml) => `<!doctype html><html><body style="margin:0;background:#f6f4ef;font-family:Arial,Helvetica,sans-serif;color:#1f1d1a">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;padding:32px">
<tr><td style="font-size:20px;font-weight:bold;padding-bottom:8px">parley</td></tr>
<tr><td style="font-size:22px;font-weight:bold;padding:12px 0">${title}</td></tr>
<tr><td style="font-size:15px;line-height:1.6">${bodyHtml}</td></tr>
<tr><td style="font-size:12px;color:#7a756d;padding-top:24px">If you didn't request this, you can safely ignore this email.</td></tr>
</table></td></tr></table></body></html>`;
const button = (url, label) =>
  `<p style="padding:16px 0"><a href="${url}" style="background:#e5482f;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:bold;display:inline-block">${label}</a></p><p style="font-size:12px;color:#7a756d;word-break:break-all">Or paste this link into your browser:<br>${url}</p>`;

export const templates = {
  verifyEmail: (name, url, hours) => ({
    subject: "Verify your email address",
    html: wrap(`Welcome, ${escapeHtml(name)}!`, `Please confirm your email address to activate your account.${button(url, "Verify email")}This link expires in ${hours} hours.`),
    text: `Welcome, ${name}!\n\nConfirm your email address: ${url}\n\nThis link expires in ${hours} hours.`,
  }),
  resetPassword: (name, url, minutes) => ({
    subject: "Reset your password",
    html: wrap("Reset your password", `Hi ${escapeHtml(name)}, we received a request to reset your password.${button(url, "Choose a new password")}This link expires in ${minutes} minutes.`),
    text: `Hi ${name},\n\nReset your password: ${url}\n\nThis link expires in ${minutes} minutes.`,
  }),
  emailChange: (name, url, hours) => ({
    subject: "Confirm your new email address",
    html: wrap("Confirm your new email", `Hi ${escapeHtml(name)}, confirm this address to finish changing your account email.${button(url, "Confirm email")}This link expires in ${hours} hours.`),
    text: `Hi ${name},\n\nConfirm your new email: ${url}\n\nThis link expires in ${hours} hours.`,
  }),
  passwordChanged: (name) => ({
    subject: "Your password was changed",
    html: wrap("Password changed", `Hi ${escapeHtml(name)}, your password was just changed and other sessions were signed out. If this wasn't you, reset your password immediately.`),
    text: `Hi ${name}, your password was just changed and other sessions were signed out. If this wasn't you, reset your password immediately.`,
  }),
  alert: (title, body, url) => ({
    subject: title,
    html: wrap(escapeHtml(title), `${escapeHtml(body || "")}${url ? button(url, "Open in dashboard") : ""}`),
    text: `${title}\n\n${body || ""}${url ? `\n\n${url}` : ""}`,
  }),
};

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
