// Noor Therapy Center — Admin Tracker sync endpoint.
//
// Stores one JSON blob per tracker module in Netlify Blobs so several staff
// see the same data. Access is gated by the SAME signed cookie that
// staff-auth.js issues — the verify helper is duplicated here (a few lines)
// rather than shared, because every file in netlify/edge-functions/ is
// treated as a function of its own.
//
// Merge strategy: records carry an id + updatedAt, and the server merges
// per record instead of overwriting the whole list. Two people editing
// different rows at the same time therefore never clobber each other.
// Deletes are tombstones so they propagate to other browsers.

import { getStore } from "https://esm.sh/@netlify/blobs@11";

// Same signing key as staff-auth.js, read from the Netlify environment.
const STORE = "ntc-tracker";
const TOMBSTONE_DAYS = 90;
const MAX_BYTES = 2 * 1024 * 1024;

// Modules the client is allowed to sync. Keep in step with MODULES in tracker.js.
const ALLOWED = new Set([
  "staff", "clients", "training", "credentials", "renewals",
  "reminders", "checklists", "auths", "contacts",
  "empfiles", "clientfiles", "clientsup",
  // Retired. Kept only so the tracker's one-time sweep can DELETE what the
  // old staff Supervision & Observation module left here. Nothing writes it.
  "supervision",
]);

const enc = new TextEncoder();

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

// Drop tombstones nobody needs any more, so the blob does not grow forever.
function prune(records) {
  const cutoff = Date.now() - TOMBSTONE_DAYS * 86400000;
  return records.filter((r) => !(r.deletedAt && r.deletedAt < cutoff));
}

export default async (request) => {
  const SECRET = env("STAFF_COOKIE_SECRET");
  if (!(await unlocked(request, SECRET))) return json({ ok: false, error: "locked" }, 401);

  const url = new URL(request.url);
  const store = getStore(STORE);

  if (request.method === "GET") {
    const mod = url.searchParams.get("module") || "";
    if (!ALLOWED.has(mod)) return json({ ok: false, error: "unknown module" }, 400);
    let doc = null;
    try {
      doc = await store.get(mod, { type: "json", consistency: "strong" });
    } catch (e) {
      return json({ ok: false, error: "read failed: " + e.message }, 502);
    }
    return json({ ok: true, module: mod, records: (doc && doc.records) || [], rev: (doc && doc.rev) || 0 });
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }

    const mod = body && body.module;
    if (!ALLOWED.has(mod)) return json({ ok: false, error: "unknown module" }, 400);

    const upserts = Array.isArray(body.upserts) ? body.upserts : [];
    const deletes = Array.isArray(body.deletes) ? body.deletes : [];
    if (upserts.length > 500 || deletes.length > 500) return json({ ok: false, error: "too many records" }, 413);

    let doc = null;
    try {
      doc = await store.get(mod, { type: "json", consistency: "strong" });
    } catch (e) {
      return json({ ok: false, error: "read failed: " + e.message }, 502);
    }

    const byId = new Map();
    for (const r of (doc && doc.records) || []) if (r && r.id) byId.set(r.id, r);

    const now = Date.now();
    for (const r of upserts) {
      if (!r || typeof r.id !== "string") continue;
      const prev = byId.get(r.id);
      const stamped = Object.assign({}, r, { updatedAt: Number(r.updatedAt) || now });
      // Last edit wins, but only if it is actually newer than what is stored.
      if (!prev || stamped.updatedAt >= (prev.updatedAt || 0)) byId.set(r.id, stamped);
    }
    for (const id of deletes) {
      if (typeof id !== "string") continue;
      byId.set(id, { id, deletedAt: now, updatedAt: now });
    }

    const records = prune(Array.from(byId.values()));
    const next = { rev: ((doc && doc.rev) || 0) + 1, records, savedAt: now };

    const payload = JSON.stringify(next);
    if (payload.length > MAX_BYTES) return json({ ok: false, error: "module is full" }, 413);

    try {
      await store.setJSON(mod, next);
    } catch (e) {
      return json({ ok: false, error: "write failed: " + e.message }, 502);
    }
    return json({ ok: true, module: mod, records, rev: next.rev });
  }

  // Remove a module's stored copy outright.
  //
  // Deliberately NOT a bulk tombstone: a tombstone carries a fresh updatedAt,
  // so it would outrank the browser's own records and wipe them the moment the
  // module was shared again. Deleting the blob leaves nothing to out-rank, and
  // a browser that still holds the records can re-publish them intact.
  if (request.method === "DELETE") {
    const mod = url.searchParams.get("module") || "";
    if (!ALLOWED.has(mod)) return json({ ok: false, error: "unknown module" }, 400);
    try {
      await store.delete(mod);
    } catch (e) {
      return json({ ok: false, error: "delete failed: " + e.message }, 502);
    }
    return json({ ok: true, module: mod, deleted: true });
  }

  return json({ ok: false, error: "method not allowed" }, 405);
};
