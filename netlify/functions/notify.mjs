// Noor Therapy Center — expiration notifier.
//
// A scheduled function that reads the tracker's shared data and sends a digest
// of anything overdue or coming due. Runs daily; see `config` at the bottom.
//
// WHAT IT CAN AND CANNOT SEE — read this before adding a module.
//
// This job runs on a server, so it can only read what the tracker has actually
// SHARED to Netlify Blobs. Modules holding client information are local to a
// browser by design (they are PHI and this storage carries no business
// associate agreement), so client authorizations, client supervision and
// client files are invisible here and cannot be notified on. That is the
// intended trade, not an oversight: the alternative is putting client names in
// an outbound email. Client work is surfaced on the dashboard instead, which
// runs in the browser that holds the data.
//
// Notifications also never include a client name, a date of birth, or anything
// else identifying — even from a module that somebody has deliberately shared.
// See scrub() below.
//
// Escalation, not repetition. An item is announced when it crosses a
// threshold (60, 30, 14, 7, 3, 1 days out, then overdue), and each threshold
// fires once. Without that a daily job re-sends the same twelve rows every
// morning until somebody stops reading it.

import { getStore } from "@netlify/blobs";

const TRACKER_STORE = "ntc-tracker";
const STATE_STORE = "ntc-notify";
const STATE_KEY = "sent";

// Only modules that are non-PHI AND carry a date. Keep in step with MODULES in
// staff-portal/tracker.js — the shapes are duplicated here because a scheduled
// function cannot import from a browser script.
const WATCHED = [
  { mod: "credentials", dueField: "expires",     label: "Credential expires",
    title: (r) => `${r.staff || "Unnamed"} — ${r.credType || "Credential"}` },
  { mod: "renewals",    dueField: "renewalDate", label: "Renews",
    title: (r) => r.item || "Untitled renewal" },
  { mod: "reminders",   dueField: "dueDate",     label: "Due",
    title: (r) => r.title || "Untitled reminder" },
];

// Days out at which an item is announced. Descending; "0" means due today or
// already past.
const STEPS = [60, 30, 14, 7, 3, 1, 0];

/* ----------------------------------------------------------------- helpers */

function env(name, fallback = "") {
  const v = process.env[name];
  return v === undefined || v === null || v === "" ? fallback : v;
}

// Dates are plain YYYY-MM-DD and compared as calendar days in the agency's own
// timezone, so an item is never "overdue" merely because the server is on UTC.
function todayInZone(tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function daysBetween(fromISO, toISO) {
  const a = Date.parse(fromISO + "T00:00:00Z");
  const b = Date.parse(toISO + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

// The tightest threshold this item has reached. STEPS descends, so the last
// match is the smallest one still >= days. null means it is further out than
// the widest step and is not worth mentioning yet.
function stepFor(days) {
  if (days <= 0) return 0;
  let hit = null;
  for (const s of STEPS) if (s !== 0 && days <= s) hit = s;
  return hit;
}

function fmtDate(iso) {
  const d = new Date(iso + "T12:00:00Z");
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function relative(days) {
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue`;
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  return `in ${days} days`;
}

// Belt and braces. Even a deliberately-shared module should not put a client
// name in an email, so only the fields the digest actually needs are read, and
// they are truncated and stripped of anything that looks like contact detail.
function scrub(s) {
  return String(s == null ? "" : s)
    .replace(/[\r\n]+/g, " ")
    .replace(/\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g, "[redacted]")   // SSN-shaped
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "[redacted]")          // email
    .slice(0, 120)
    .trim();
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* -------------------------------------------------------------- collecting */

async function collect(store, today) {
  const items = [];
  for (const w of WATCHED) {
    let doc = null;
    try {
      doc = await store.get(w.mod, { type: "json", consistency: "strong" });
    } catch (e) {
      // A module nobody has shared yet simply has no blob.
      continue;
    }
    for (const r of (doc && doc.records) || []) {
      if (!r || r.deletedAt) continue;
      const due = r[w.dueField];
      if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) continue;
      const days = daysBetween(today, due);
      if (days === null) continue;
      const step = stepFor(days);
      if (step === null) continue;                 // still beyond the widest step
      items.push({
        key: `${w.mod}:${r.id}:${due}`,            // a rescheduled item is a new item
        mod: w.mod, label: w.label,
        title: scrub(w.title(r)),
        due, days, step,
      });
    }
  }
  return items.sort((a, b) => a.days - b.days);
}

/* ---------------------------------------------------------------- delivery */

async function sendEmail(subject, html, text) {
  const to = env("NOTIFY_TO");
  if (!to) return { skipped: "NOTIFY_TO is not set" };
  const from = env("NOTIFY_FROM", "alerts@noortherapycenter.com");
  const list = to.split(",").map((s) => s.trim()).filter(Boolean);

  const resend = env("RESEND_API_KEY");
  if (resend) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resend}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: list, subject, html, text }),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return { sent: "resend", to: list.length };
  }

  const sendgrid = env("SENDGRID_API_KEY");
  if (sendgrid) {
    const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${sendgrid}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: list.map((e) => ({ email: e })) }],
        from: { email: from },
        subject,
        content: [{ type: "text/plain", value: text }, { type: "text/html", value: html }],
      }),
    });
    if (!r.ok) throw new Error(`SendGrid ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return { sent: "sendgrid", to: list.length };
  }

  return { skipped: "no email provider key set (RESEND_API_KEY or SENDGRID_API_KEY)" };
}

async function sendSms(text) {
  const to = env("NOTIFY_SMS_TO");
  const sid = env("TWILIO_ACCOUNT_SID");
  const token = env("TWILIO_AUTH_TOKEN");
  const from = env("TWILIO_FROM");
  if (!to || !sid || !token || !from) return { skipped: "Twilio not configured" };

  // A text message is a nudge, not the digest — the detail is in the email and
  // behind the sign-in, which is also where it belongs.
  const body = text.slice(0, 300);
  const results = [];
  for (const num of to.split(",").map((s) => s.trim()).filter(Boolean)) {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: num, From: from, Body: body }),
    });
    if (!r.ok) throw new Error(`Twilio ${r.status}: ${(await r.text()).slice(0, 300)}`);
    results.push(num);
  }
  return { sent: "twilio", to: results.length };
}

// An escape hatch: point this at Zapier, Make, Slack, or anything else that
// takes a JSON POST, and route it however you like.
async function sendWebhook(payload) {
  const url = env("NOTIFY_WEBHOOK");
  if (!url) return { skipped: "NOTIFY_WEBHOOK is not set" };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Webhook ${r.status}`);
  return { sent: "webhook" };
}

/* ------------------------------------------------------------- the message */

function render(items, portalUrl) {
  const overdue = items.filter((i) => i.days < 0);
  const today = items.filter((i) => i.days === 0);
  const soon = items.filter((i) => i.days > 0);

  const line = (i) => `${i.title} — ${i.label.toLowerCase()} ${fmtDate(i.due)} (${relative(i.days)})`;

  const text = [
    overdue.length ? `OVERDUE (${overdue.length})\n` + overdue.map((i) => "  • " + line(i)).join("\n") : "",
    today.length ? `DUE TODAY (${today.length})\n` + today.map((i) => "  • " + line(i)).join("\n") : "",
    soon.length ? `COMING UP (${soon.length})\n` + soon.map((i) => "  • " + line(i)).join("\n") : "",
    `\nOpen the tracker: ${portalUrl}`,
    "\nClient authorizations and client supervision are not included — that data stays in the browser and never reaches this job.",
  ].filter(Boolean).join("\n\n");

  const group = (name, list, tone) => !list.length ? "" :
    `<h2 style="font:800 13px/1.4 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:${tone};margin:26px 0 10px">${name} (${list.length})</h2>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">` +
    list.map((i) => `<tr>
        <td style="padding:9px 0;border-bottom:1px solid #e6e0cc;font:600 14px/1.4 system-ui,sans-serif;color:#1f2e1a">
          ${esc(i.title)}
          <div style="font:500 12.5px/1.5 system-ui,sans-serif;color:#6b7561;margin-top:2px">
            ${esc(i.label)} ${esc(fmtDate(i.due))} · ${esc(relative(i.days))}
          </div>
        </td></tr>`).join("") +
    `</table>`;

  const html = `<div style="max-width:560px;margin:0 auto;padding:26px 22px;background:#fff">
    <div style="font:800 11px/1 system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#2aa63a">Noor Therapy Center</div>
    <h1 style="font:800 22px/1.25 system-ui,sans-serif;color:#1f2e1a;margin:8px 0 4px">What needs attention</h1>
    <p style="font:500 13.5px/1.6 system-ui,sans-serif;color:#6b7561;margin:0">
      ${overdue.length ? `<strong style="color:#d64545">${overdue.length} overdue.</strong> ` : ""}${items.length} item${items.length === 1 ? "" : "s"} crossed a deadline threshold.
    </p>
    ${group("Overdue", overdue, "#d64545")}
    ${group("Due today", today, "#b25f10")}
    ${group("Coming up", soon, "#6b7561")}
    <p style="margin:28px 0 0">
      <a href="${esc(portalUrl)}" style="display:inline-block;font:800 14px/1 system-ui,sans-serif;color:#fff;background:#2aa63a;border-radius:999px;padding:13px 26px;text-decoration:none">Open the tracker</a>
    </p>
    <p style="font:500 11.5px/1.6 system-ui,sans-serif;color:#8a9182;margin:24px 0 0;border-top:1px solid #e6e0cc;padding-top:14px">
      Client authorizations and client supervision are deliberately not included: that data stays in
      the browser it was entered on, so this message can never carry a client name.
    </p>
  </div>`;

  const subject = overdue.length
    ? `${overdue.length} overdue · Noor Therapy Center`
    : `${items.length} coming due · Noor Therapy Center`;

  return { subject, html, text };
}

/* -------------------------------------------------------------- entrypoint */

export default async (req) => {
  const tz = env("NOTIFY_TZ", "America/Chicago");
  const portalUrl = env("PORTAL_URL", "https://noortherapycenter.com/staff-portal/tracker.html");
  const today = todayInZone(tz);

  const url = new URL(req.url);

  /* Who is allowed to run this.
   *
   * Netlify invokes a scheduled function with a POST and no query string, so a
   * bare POST is taken as the schedule. That is a weak signal on its own —
   * anyone who guesses the URL can POST it — so it is only ever allowed to do
   * the ordinary thing: send items that have genuinely crossed a new
   * threshold, which the stored state already limits to once each. Repeated
   * POSTs therefore send nothing.
   *
   * The two switches that COULD be abused into a mail loop, `force` (ignore
   * the state) and `dry` (dump the digest as JSON), always require the key,
   * schedule or not. So does any GET.
   */
  const key = env("NOTIFY_TEST_KEY");
  const authed = !!key && url.searchParams.get("key") === key;
  const dry = authed && url.searchParams.get("dry") === "1";
  const force = authed && url.searchParams.get("force") === "1";

  if (!authed && req.method !== "POST") return new Response("Not found", { status: 404 });

  const tracker = getStore(TRACKER_STORE);
  const state = getStore(STATE_STORE);

  const items = await collect(tracker, today);

  let sent = {};
  try { sent = (await state.get(STATE_KEY, { type: "json" })) || {}; } catch (e) { sent = {}; }

  // Announce an item only when it reaches a threshold it has not reached yet.
  const fresh = force ? items : items.filter((i) => {
    const last = sent[i.key];
    return last === undefined || i.step < last;
  });

  if (!fresh.length) {
    return Response.json({ ok: true, today, checked: items.length, sent: 0, note: "nothing new" });
  }

  const msg = render(fresh, portalUrl);
  const delivery = {};

  if (dry) {
    return Response.json({ ok: true, dry: true, today, would_send: fresh.length, subject: msg.subject, text: msg.text });
  }

  // One channel failing must not stop the others, and must not mark the items
  // as announced — otherwise a bad API key silently swallows a whole cycle.
  let anyDelivered = false;
  for (const [name, fn] of [
    ["email", () => sendEmail(msg.subject, msg.html, msg.text)],
    ["sms", () => sendSms(`${msg.subject}. Open the tracker: ${portalUrl}`)],
    ["webhook", () => sendWebhook({ subject: msg.subject, items: fresh, portalUrl })],
  ]) {
    try {
      const r = await fn();
      delivery[name] = r;
      if (r && r.sent) anyDelivered = true;
    } catch (e) {
      delivery[name] = { error: e.message };
    }
  }

  if (anyDelivered && !force) {
    const next = { ...sent };
    for (const i of fresh) next[i.key] = i.step;
    // Forget items whose date has passed well enough to stop mattering.
    for (const k of Object.keys(next)) {
      const due = k.split(":").pop();
      const age = daysBetween(due, today);
      if (age !== null && age > 120) delete next[k];
    }
    try { await state.setJSON(STATE_KEY, next); } catch (e) { /* retried next run */ }
  }

  return Response.json({
    ok: anyDelivered, today, checked: items.length, announced: fresh.length, delivery,
  });
};

// Daily at 13:00 UTC — 8am Central in summer, 7am in winter. The escalation
// steps, not the schedule, are what keep this from becoming noise.
export const config = {
  schedule: "0 13 * * *",
};
