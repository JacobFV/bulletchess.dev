import type { Env } from "./env";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Development-only sink, readable through /api/dev/mailbox (never in production). */
export const devMailbox: OutgoingEmail[] = [];

/** "Name <addr@host>" → { name, email } (Cloudflare Email Sending rejects the combined form). */
export function parseFrom(from: string): string | { name: string; email: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(from);
  return m ? { name: m[1]!.trim(), email: m[2]! } : from.trim();
}

export async function sendEmail(env: Env, msg: OutgoingEmail): Promise<void> {
  if (env.EMAIL_PROVIDER === "disabled") throw new Error("Email is disabled");
  if (env.EMAIL_PROVIDER === "log") {
    if (env.ENVIRONMENT === "production") throw new Error("log email provider is not allowed in production");
    devMailbox.push(msg);
    if (devMailbox.length > 100) devMailbox.shift();
    console.log(`[dev email] to=${msg.to} subject=${msg.subject}\n${msg.text}`);
    return;
  }
  if (!env.EMAIL) throw new Error("send_email binding EMAIL is not configured");
  try {
    await env.EMAIL.send({ to: msg.to, from: parseFrom(env.EMAIL_FROM), subject: msg.subject, text: msg.text, html: msg.html });
  } catch (e) {
    const code = String((e as { code?: string }).code ?? (e as Error).name ?? "error").slice(0, 60);
    console.error(JSON.stringify({ event: "email.send_failed", code }));
    throw e;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Minimal, accessible transactional email body. */
export function emailHtml(heading: string, body: string, cta: { label: string; url: string }, footer: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#16130f;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#ece6dc">
<table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#221d17;border-radius:12px;padding:28px">
<tr><td><div style="font-weight:800;font-size:20px;letter-spacing:-.02em;margin-bottom:18px">bullet<span style="color:#f2a541">chess</span></div>
<h1 style="font-size:20px;margin:0 0 12px">${esc(heading)}</h1>
<p style="line-height:1.55;margin:0 0 22px;color:#cfc6b8">${esc(body)}</p>
<a href="${esc(cta.url)}" style="display:inline-block;background:#f2a541;color:#1b150e;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px">${esc(cta.label)}</a>
<p style="line-height:1.5;margin:22px 0 0;font-size:13px;color:#958b7c">${esc(footer)}<br><br>If the button does not work, paste this link into your browser:<br><span style="word-break:break-all">${esc(cta.url)}</span></p>
</td></tr></table></body></html>`;
}
