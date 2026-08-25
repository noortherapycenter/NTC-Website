// Noor Therapy Center — client alert beacon.
//
// Client records live only in the browser they were entered on, so a
// server-side job cannot see them and cannot tell you when a client
// authorization is about to lapse. This endpoint is the narrow bridge: when a
// staff member opens the portal, their browser works out which CLIENT items
// need attention and posts a minimal summary here, which the scheduled
// notifier (netlify/functions/notify.mjs) folds into its daily digest.
//
// WHAT IS ALLOWED THROUGH, AND WHY IT IS ENFORCED HERE.
//
// Only initials, a fixed reason code, and a date. Never a name, never a note,
// never a free-text field. The browser is written to send only that, but the
// browser is also the thing most likely to be changed later by someone who has
// not read this comment — so the rule is enforced on the server, where a UI
// mistake cannot get around it. Anything failing validation is dropped, not
// stored.
//
// This is a deliberate decision by the agency, taken with the trade understood:
// initials attached to clinical status are still identifying, especially for a
// small caseload, and the digest lands in an ordinary email inbox. The limits
// below exist to keep that exposure to the minimum the decision requires.

import { getStore } from "https://esm.sh/@netlify/blobs@11";

const STORE = "ntc-notify";
const KEY = "clientalerts";
const MAX_ITEMS = 300;
const enc = new TextEncoder();

// Initials only: letters, dots and hyphens, at most five characters. "A.K."
// passes. "Amina K" does not — the space gives away that it is a name.
const INITIALS = /^[A-Za-z][A-Za-z.\-]{0,4}$/;

// A fixed vocabulary, so no free text can ride along in this field.
const REASONS = new Set([
  "Authorization ends",
  "File incomplete",
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_KEY = /^[A-Za-z0-9_:-]{1,80}$/;

function env(name) {
  try { if (typeof Netlify !== "undefined" && Netlify.env) return Netlify.env.get(name); } catch (e) {}
  try { if (typeof Deno !== "undefined" && Deno.env) return Deno.env.get(name); } catch (e) {}
  return "";
}

async function sign(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function unlocked(request, secret) {
  if (!secret) return false;
  const m = (request.headers.get("cookie") || "").match(/ntc_staff=([^;]+)/);
  if (!m) return false;
  const parts = m[1].split(".");
  if (parts.length !== 2) return false;
  if (!(Date.now() < Number(parts[0]))) return false;
  return parts[1] === (await sign(parts[0], secret));
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Keep only what is allowed, in the shape it is allowed in. Anything else is
// dropped silently — a rejected item must never be stored "just in case".
function clean(raw) {
  if (!raw || typeof raw !== "object") return null;
  const initials = String(raw.initials || "").trim();
  const reason = String(raw.reason || "").trim();
  const key = String(raw.key || "").trim();
  const due = String(raw.due || "").trim();

  if (!INITIALS.test(initials)) return null;
  if (!REASONS.has(reason)) return null;
  if (!SAFE_KEY.test(key)) return null;
  if (due && !ISO_DATE.test(due)) return null;

  return { key, initials: initials.toUpperCase(), reason, due: due || "" };
}

export default async (request) => {
  const SECRET = env("STAFF_COOKIE_SECRET");
  if (!(await unlocked(request, SECRET))) return json({ ok: false, error: "locked" }, 401);

  const store = getStore(STORE);

  if (request.method === "GET") {
    let doc = null;
    try { doc = await store.get(KEY, { type: "json", consistency: "strong" }); } catch (e) {}
    return json({ ok: true, ...(doc || { items: [], updatedAt: 0 }) });
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }

    const raw = Array.isArray(body && body.items) ? body.items : [];
    if (raw.length > MAX_ITEMS) return json({ ok: false, error: "too many items" }, 413);

    const items = [];
    let dropped = 0;
    for (const r of raw) {
      const c = clean(r);
      if (c) items.push(c); else dropped++;
    }

    // The browser sends the whole current picture each time, so this replaces
    // rather than merges: an item that has been dealt with disappears by
    // being absent, and no stale row lingers.
    const next = { items, updatedAt: Date.now() };
    try {
      await store.setJSON(KEY, next);
    } catch (e) {
      return json({ ok: false, error: "write failed: " + e.message }, 502);
    }
    return json({ ok: true, stored: items.length, dropped });
  }

  if (request.method === "DELETE") {
    try { await store.delete(KEY); } catch (e) {
      return json({ ok: false, error: "delete failed: " + e.message }, 502);
    }
    return json({ ok: true, deleted: true });
  }

  return json({ ok: false, error: "method not allowed" }, 405);
};
