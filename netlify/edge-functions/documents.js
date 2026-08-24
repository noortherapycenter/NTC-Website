// Noor Therapy Center — completed-form storage.
//
// Holds the PDF of a completed form against the STAFF member it belongs to,
// so a finished packet lives under that person's profile instead of only in
// whoever's downloads folder. Access is gated by the same signed cookie
// staff-auth.js issues; the verify helper is duplicated here for the same
// reason it is duplicated in tracker-data.js — every file in
// netlify/edge-functions/ is a function of its own.
//
// STAFF ONLY, AND THE SERVER IS WHAT ENFORCES IT.
//
// Client paperwork (intake, CMDE, ITP, medical, releases) is protected health
// information. Netlify has not signed a business associate agreement covering
// this storage, so client documents must not be uploaded here at all — the UI
// records that a client form was COMPLETED against the client's file
// checklist, and the document itself stays with the EHR and the printed copy.
// A client upload is refused below rather than merely discouraged in the
// interface, because an interface rule is one bug away from not applying.

import { getStore } from "https://esm.sh/@netlify/blobs@11";

const STORE = "ntc-documents";
const MAX_BYTES = 8 * 1024 * 1024;   // one scanned packet, comfortably
const MAX_LIST = 500;

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

// Ids come from the tracker's uid() and from our own document catalog, so they
// are known-safe shapes. Anything else could climb out of its prefix.
const SAFE = /^[A-Za-z0-9_-]{1,64}$/;

function keyFor(entityId, uploadId) {
  return `staff/${entityId}/${uploadId}`;
}

export default async (request) => {
  const SECRET = env("STAFF_COOKIE_SECRET");
  if (!(await unlocked(request, SECRET))) return json({ ok: false, error: "locked" }, 401);

  const url = new URL(request.url);
  const store = getStore(STORE);

  /* ------------------------------------------------------------- upload */
  if (request.method === "POST") {
    const kind = url.searchParams.get("kind") || "";
    const entityId = url.searchParams.get("entityId") || "";
    const docId = url.searchParams.get("docId") || "";
    const name = (url.searchParams.get("name") || "Completed form").slice(0, 200);
    const entityName = (url.searchParams.get("entityName") || "").slice(0, 200);

    // The PHI rule, enforced where it cannot be bypassed.
    if (kind !== "staff") {
      return json({
        ok: false,
        error: "Only staff documents can be stored here. Client paperwork is protected health " +
               "information and this storage is not covered by a business associate agreement.",
      }, 403);
    }
    if (!SAFE.test(entityId)) return json({ ok: false, error: "bad entityId" }, 400);
    if (docId && !SAFE.test(docId)) return json({ ok: false, error: "bad docId" }, 400);

    const buf = await request.arrayBuffer();
    if (!buf.byteLength) return json({ ok: false, error: "empty upload" }, 400);
    if (buf.byteLength > MAX_BYTES) {
      return json({ ok: false, error: "That file is larger than 8 MB." }, 413);
    }

    // Store what we say we store: a PDF, not whatever was posted.
    const head = new Uint8Array(buf.slice(0, 5));
    const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
    if (!isPdf) return json({ ok: false, error: "Only PDF files can be stored." }, 415);

    const uploadId = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    const meta = {
      name, docId: docId || "", entityId, entityName,
      uploadedAt: Date.now(), size: buf.byteLength, contentType: "application/pdf",
    };

    try {
      await store.set(keyFor(entityId, uploadId), buf, { metadata: meta });
    } catch (e) {
      return json({ ok: false, error: "write failed: " + e.message }, 502);
    }
    return json({ ok: true, id: uploadId, ...meta });
  }

  /* ---------------------------------- list, or download a single document */
  if (request.method === "GET") {
    const entityId = url.searchParams.get("entityId") || "";
    const id = url.searchParams.get("id") || "";
    if (!SAFE.test(entityId)) return json({ ok: false, error: "bad entityId" }, 400);

    if (id) {
      if (!SAFE.test(id)) return json({ ok: false, error: "bad id" }, 400);
      let blob = null, meta = null;
      try {
        const got = await store.getWithMetadata(keyFor(entityId, id), { type: "arrayBuffer" });
        if (got) { blob = got.data; meta = got.metadata || {}; }
      } catch (e) {
        return json({ ok: false, error: "read failed: " + e.message }, 502);
      }
      if (!blob) return json({ ok: false, error: "not found" }, 404);

      const filename = String(meta.name || "document").replace(/[^A-Za-z0-9 ._-]/g, "") + ".pdf";
      return new Response(blob, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    let entries = [];
    try {
      const listed = await store.list({ prefix: `staff/${entityId}/` });
      const blobs = (listed && listed.blobs) || [];
      entries = await Promise.all(blobs.slice(0, MAX_LIST).map(async (b) => {
        let m = {};
        try { m = (await store.getMetadata(b.key))?.metadata || {}; } catch (e) {}
        return { id: b.key.split("/").pop(), ...m };
      }));
    } catch (e) {
      return json({ ok: false, error: "list failed: " + e.message }, 502);
    }
    entries.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
    return json({ ok: true, entityId, documents: entries });
  }

  /* ------------------------------------------------------------- remove */
  if (request.method === "DELETE") {
    const entityId = url.searchParams.get("entityId") || "";
    const id = url.searchParams.get("id") || "";
    if (!SAFE.test(entityId) || !SAFE.test(id)) return json({ ok: false, error: "bad id" }, 400);
    try {
      await store.delete(keyFor(entityId, id));
    } catch (e) {
      return json({ ok: false, error: "delete failed: " + e.message }, 502);
    }
    return json({ ok: true, deleted: id });
  }

  return json({ ok: false, error: "method not allowed" }, 405);
};
