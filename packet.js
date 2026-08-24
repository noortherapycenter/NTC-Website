/* Noor Therapy Center — active onboarding packet, shared across the site.
 *
 * The staff portal (/staff-portal/*) and the fillable forms (/Fillable Forms/*)
 * are separate pages that never share a script scope, but they do share an
 * origin — so the "who is this packet for?" answer lives in localStorage and
 * both sides read it from here. Loaded as an absolute /packet.js from both.
 *
 * Writing back to the tracker.
 * A form must not talk to /api/tracker itself. tracker.js owns the sync rules
 * (per-record merge, tombstones, and which modules are allowed to leave the
 * device at all), and a second writer would have to duplicate every one of
 * them. Instead a form appends to an inbox in localStorage and tracker.js
 * drains it through its own Store on next load. That keeps one writer, and it
 * works with no network — which is the point of the paper fallback.
 */
(function (root) {
  'use strict';

  var PACKET_KEY = 'noor-packet';
  var INBOX_KEY  = 'noor-tracker-inbox';
  var LS_PREFIX  = 'noor-tracker:';
  var MAX_INBOX  = 500;

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      var v = raw ? JSON.parse(raw) : null;
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }

  function uid() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function todayISO() {
    var n = new Date();
    return n.getFullYear() + '-' +
      String(n.getMonth() + 1).padStart(2, '0') + '-' +
      String(n.getDate()).padStart(2, '0');
  }

  var Packet = {
    KINDS: { staff: { module: 'staff', files: 'empfiles', noun: 'staff member' },
             client: { module: 'clients', files: 'clientfiles', noun: 'client' } },

    /* ---- who the current packet is for ---- */

    get: function () {
      var p = readJSON(PACKET_KEY, null);
      if (!p || !p.id || !Packet.KINDS[p.kind]) return null;
      return p;
    },
    set: function (kind, id, name) {
      if (!Packet.KINDS[kind]) return null;
      var p = { kind: kind, id: id, name: name || '', at: Date.now() };
      writeJSON(PACKET_KEY, p);
      return p;
    },
    clear: function () {
      try { localStorage.removeItem(PACKET_KEY); } catch (e) {}
    },

    /* ---- rosters ----
     * localStorage first, because that is what the tracker has already put
     * there and it works offline. Shared modules fall back to the API for a
     * browser that has never opened the tracker. Client records are local-only
     * by design, so there is deliberately no network fallback for them.
     */
    roster: function (kind) {
      var def = Packet.KINDS[kind];
      if (!def) return Promise.resolve([]);
      var local = readJSON(LS_PREFIX + def.module, []);
      if (!Array.isArray(local)) local = [];
      local = local.filter(function (r) { return r && r.id && !r.deletedAt; });
      if (local.length || kind !== 'staff') return Promise.resolve(local);

      return fetch('/api/tracker?module=' + encodeURIComponent(def.module))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (body) {
          if (!body || !body.ok) return [];
          return (body.records || []).filter(function (r) { return r && r.id && !r.deletedAt; });
        })
        .catch(function () { return []; });
    },

    /* ---- queued writes, drained by tracker.js ---- */

    queue: function (entry) {
      var inbox = readJSON(INBOX_KEY, []);
      if (!Array.isArray(inbox)) inbox = [];
      // A runaway writer should not fill the quota and take localStorage down
      // with it; the oldest entries lose.
      if (inbox.length >= MAX_INBOX) inbox = inbox.slice(-(MAX_INBOX - 1));
      inbox.push(Object.assign({ at: Date.now() }, entry));
      return writeJSON(INBOX_KEY, inbox);
    },
    peek: function () {
      var inbox = readJSON(INBOX_KEY, []);
      return Array.isArray(inbox) ? inbox : [];
    },
    drain: function () {
      var inbox = Packet.peek();
      try { localStorage.removeItem(INBOX_KEY); } catch (e) {}
      return inbox;
    },

    /* ---- the two things a form needs to do ---- */

    // Create a person and make them the active packet, without waiting for the
    // tracker to be open. The id is minted here so the caller can use it now.
    createPerson: function (kind, name, extra) {
      var def = Packet.KINDS[kind];
      if (!def || !name) return null;
      var rec = Object.assign({ id: uid(), name: name }, extra || {});
      Packet.queue({ t: 'upsert', mod: def.module, rec: rec });
      Packet.set(kind, rec.id, rec.name);
      return rec;
    },

    /* Current state of one checklist item, reading the tracker's own cache
     * plus anything still sitting in the inbox — so a form submitted a moment
     * ago already reads as done, before the tracker has been opened to drain
     * it. Returns 'yes' | 'na' | 'none'.
     */
    docStatus: function (kind, entityId, docId) {
      var def = Packet.KINDS[kind];
      if (!def || !entityId || !docId) return 'none';

      var status = 'none';
      var recs = readJSON(LS_PREFIX + def.files, []);
      if (Array.isArray(recs)) {
        recs.forEach(function (r) {
          if (r && r.id === entityId && !r.deletedAt && r.docs && r.docs[docId]) {
            status = r.docs[docId].status || 'none';
          }
        });
      }
      // Queued entries are newer than the cache by definition.
      Packet.peek().forEach(function (e) {
        if (e.t === 'doc' && e.key === def.files && e.entityId === entityId && e.docId === docId) {
          status = e.status || 'yes';
        }
      });
      return status;
    },

    // Mark a document complete on this person's file checklist.
    markDoc: function (kind, entityId, docId, patch) {
      var def = Packet.KINDS[kind];
      if (!def || !entityId || !docId) return false;
      return Packet.queue(Object.assign({
        t: 'doc', key: def.files, entityId: entityId, docId: docId,
        status: 'yes', date: todayISO()
      }, patch || {}));
    },

    /* ---- which checklist item a form satisfies ----
     * Keyed by the form's filename without .html. Only unambiguous pairings
     * are listed: a form that is not here still gets stored (staff) and still
     * prints, it just does not tick a box on its own. Doc ids come from
     * EMPLOYEE_DOCS / CLIENT_DOCS in staff-portal/tracker.js — keep them in
     * step if either list changes.
     */
    FORMS: {
      'Employment Application':                    { kind: 'staff',  doc: 'app' },
      'Offer Letter - QSP':                        { kind: 'staff',  doc: 'offer' },
      'Offer Letter - Level I':                    { kind: 'staff',  doc: 'offer' },
      'Offer Letter - Level II':                   { kind: 'staff',  doc: 'offer' },
      'Offer Letter - Level III':                  { kind: 'staff',  doc: 'offer' },
      'Background Check Consent':                  { kind: 'staff',  doc: 'bgconsent' },
      'DHS-4138 Provider Agreement':               { kind: 'staff',  doc: 'dhs4138' },
      'DHS-7120A CMDE':                            { kind: 'staff',  doc: 'dhs7120' },
      'DHS-7120B Agency':                          { kind: 'staff',  doc: 'dhs7120' },
      'DHS-7120C QSP':                             { kind: 'staff',  doc: 'dhs7120' },
      'DHS-7120D Level I':                         { kind: 'staff',  doc: 'dhs7120' },
      'DHS-7120E Level II':                        { kind: 'staff',  doc: 'dhs7120' },
      'DHS-7120F Level III':                       { kind: 'staff',  doc: 'dhs7120' },
      'Form W-4':                                  { kind: 'staff',  doc: 'w4' },
      'Form I-9':                                  { kind: 'staff',  doc: 'i9' },
      'Direct Deposit Authorization':              { kind: 'staff',  doc: 'dd' },
      'Handbook Acknowledgement':                  { kind: 'staff',  doc: 'handbook' },
      'Confidentiality and HIPAA Agreement':       { kind: 'staff',  doc: 'hipaa' },
      'Client Intake Form':                        { kind: 'client', doc: 'intake' },
      'MN Consent to Release Health Information':  { kind: 'client', doc: 'roi' }
    },

    // The form this page is, worked out from its own URL.
    formName: function () {
      try {
        var last = decodeURIComponent(location.pathname.split('/').pop() || '');
        return last.replace(/\.html?$/i, '');
      } catch (e) { return ''; }
    },
    formInfo: function () {
      return Packet.FORMS[Packet.formName()] || null;
    },

    uid: uid,
    todayISO: todayISO
  };

  root.NoorPacket = Packet;
})(window);
