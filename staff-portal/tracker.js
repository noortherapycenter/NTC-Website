/* Noor Therapy Center — Admin Tracker
 *
 * Records expirations, deadlines, trainings, reminders and checklists.
 * No build step: plain JS, no imports, no bundler.
 *
 * Storage. Every module is stored twice-capable:
 *   - "shared"  -> synced through /api/tracker (Netlify Blobs) so all staff
 *                  see the same data, merged per record.
 *   - "local"   -> localStorage on this browser only, never transmitted.
 * Modules holding client information default to LOCAL because client names
 * attached to services are PHI. The scope can be changed per module in
 * Settings; doing so is a deliberate decision, so it warns first.
 */
(function () {
  'use strict';

  var LS_PREFIX = 'noor-tracker:';
  var LS_SCOPE = 'noor-tracker-scope';
  var LS_PHI_FIX = 'noor-tracker-phi-fix';
  var LS_RETIRED = 'noor-tracker-retired';
  var LS_BEACON = 'noor-tracker-beacon';
  var LS_NOTDUPE = 'noor-tracker-notdupes';
  var API = '/api/tracker';

  /* Modules that used to exist. Leaving their records behind would mean staff
   * names sitting in storage nothing reads any more, so each is cleared once —
   * locally, and on the server — the first time this version runs. The keys
   * stay in the edge function's allowlist purely so that DELETE can reach
   * them; nothing writes to them again. */
  var RETIRED_KEYS = ['supervision'];

  // Modules pulled back to this device by the one-time PHI scope repair,
  // reported once on the dashboard so the change is not silent.
  var phiRepaired = [];

  /* ---------------------------------------------------------------- utils */

  var uid = function () {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // Dates are stored as plain YYYY-MM-DD and compared in local time, so a
  // deadline never slips a day because of a timezone offset.
  function parseDate(s) {
    if (!s) return null;
    var p = String(s).split('-');
    if (p.length !== 3) return null;
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return isNaN(d) ? null : d;
  }
  function today() {
    var n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }
  function toISO(d) {
    if (!d) return '';
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }
  function daysUntil(s) {
    var d = parseDate(s);
    if (!d) return null;
    return Math.round((d - today()) / 86400000);
  }
  function addMonths(s, n) {
    var d = parseDate(s);
    if (!d) return '';
    var day = d.getDate();
    var t = new Date(d.getFullYear(), d.getMonth() + n, 1);
    // Clamp to the last day of the target month (31 Jan + 1 month = 28/29 Feb).
    t.setDate(Math.min(day, new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()));
    return toISO(t);
  }
  function fmtDate(s) {
    var d = parseDate(s);
    if (!d) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function relative(days) {
    if (days == null) return '';
    if (days < 0) return Math.abs(days) + (Math.abs(days) === 1 ? ' day overdue' : ' days overdue');
    if (days === 0) return 'due today';
    if (days === 1) return 'due tomorrow';
    return 'in ' + days + ' days';
  }
  // Green / amber / red banding used by every dated row and the dashboard.
  function band(days, warnAt) {
    if (days == null) return 'none';
    if (days < 0) return 'over';
    if (days <= (warnAt || 30)) return 'soon';
    return 'ok';
  }

  /* ------------------------------------------------------- training catalog
   * Taken verbatim from the onboarding pages so the tracker and the packets
   * cannot drift apart. req = Required, cond = Required on the alternate
   * pathway only, rec = Recommended, null = not applicable to that role.
   */
  var ROLES = [
    { k: 'qsp', label: 'QSP / BCBA' },
    { k: 'l1', label: 'Level I' },
    { k: 'l2', label: 'Level II' },
    { k: 'l3', label: 'Level III' },
    { k: 'admin', label: 'Admin / Office' }
  ];

  var TRAININGS = [
    { id: 'cultural',   name: 'Cultural Responsiveness in ASD Services', via: 'TrainLink',
      req: { qsp: 'req', l1: 'req', l2: 'req', l3: 'req', admin: 'req' } },
    { id: 'vamr',       name: 'Vulnerable Adults Mandated Reporting (VAMR)', via: 'DHS online',
      req: { qsp: 'req', l1: 'req', l2: 'req', l3: 'req', admin: 'req' } },
    { id: 'mandated',   name: 'Mandated Reporter (child maltreatment)', via: 'MN Child Welfare Training Academy',
      req: { qsp: 'req', l1: 'req', l2: 'req', l3: 'req', admin: 'req' } },
    { id: 'asdsa',      name: 'ASD Strategies in Action', via: 'Autism Certification Center',
      req: { qsp: 'rec', l1: 'cond', l2: 'cond', l3: 'req', admin: null } },
    { id: 'eidbi101',   name: 'EIDBI 101: Overview of the Benefit', via: 'TrainLink',
      req: { qsp: 'rec', l1: 'cond', l2: 'cond', l3: 'req', admin: null } },
    { id: 'cmdeitp',    name: 'CMDE and ITP Overview', via: 'TrainLink',
      req: { qsp: 'rec', l1: 'rec', l2: null, l3: null, admin: null } },
    { id: 'coord',      name: 'Coordinating Services and Supports', via: 'TrainLink',
      req: { qsp: 'rec', l1: 'rec', l2: 'rec', l3: 'rec', admin: null } },
    { id: 'telehealth', name: 'Telehealth for Early Intervention', via: 'TrainLink',
      req: { qsp: 'rec', l1: 'rec', l2: 'rec', l3: 'rec', admin: null } }
  ];

  // Required trainings are due within six months of the hire date.
  var TRAINING_WINDOW_MONTHS = 6;

  function requirementFor(staff, training) {
    var level = training.req[staff.role];
    if (!level) return null;
    // "Required — alternate pathway" only bites if the provider enrolled that way.
    if (level === 'cond') return staff.altPathway ? 'req' : 'rec';
    return level;
  }
  function trainingDue(staff) {
    return staff.hireDate ? addMonths(staff.hireDate, TRAINING_WINDOW_MONTHS) : '';
  }

  /* ----------------------------------------------------- file checklists
   * Both lists are taken verbatim from the printed forms so the tracker and
   * the paperwork cannot drift apart:
   *   Fillable Forms/Employee File Checklist.html
   *   Fillable Forms/Client File Checklist.html
   * Each document is either on file, not applicable, or still outstanding.
   */
  var EMPLOYEE_DOCS = [
    { group: 'Application & hiring', items: [
      { id: 'app',        name: 'Employment application' },
      { id: 'offer',      name: 'Signed offer letter' },
      { id: 'resume',     name: 'Resume / CV' },
      { id: 'diploma',    name: 'Diploma / transcripts' },
      { id: 'id',         name: 'Copy of ID' }
    ] },
    { group: 'Payroll', items: [
      { id: 'i9',         name: 'Form I-9 & supporting ID', note: 'Keep in a separate confidential folder' },
      { id: 'w4',         name: 'Form W-4' },
      { id: 'dd',         name: 'Direct deposit authorization' }
    ] },
    { group: 'Consents & acknowledgments', items: [
      { id: 'hipaa',      name: 'Confidentiality / HIPAA agreement' },
      { id: 'handbook',   name: 'Employee handbook acknowledgment' }
    ] },
    { group: 'Background checks', items: [
      { id: 'netstudy',   name: 'NetStudy background check clearance' },
      { id: 'bgconsent',  name: 'Background check consent' },
      { id: 'tb',         name: 'TB test / health clearance', note: 'If required' }
    ] },
    { group: 'Credentials & experience', items: [
      { id: 'license',    name: 'Copy of license / certification', note: 'BCBA, RBT, etc.' },
      { id: 'priorhours', name: 'Supervision hours from previous center', note: 'If applicable' }
    ] },
    { group: 'Training certificates', items: [
      { id: 'tl_eidbi',   name: 'TrainLink: EIDBI 101' },
      { id: 'tl_cmde',    name: 'TrainLink: CMDE and ITP overview' },
      { id: 'tl_cultural',name: 'TrainLink: Cultural responsiveness in ASD services' },
      { id: 'vamr',       name: 'VAMR certificate' },
      { id: 'mandated',   name: 'Mandated reporter training certificate' },
      { id: 'asdsa',      name: 'ASD Strategies in Action certificates' },
      { id: 'reqtrain',   name: 'Required trainings completed', note: 'HIPAA, safety, mandated reporter' }
    ] },
    { group: 'State / federal / DHS', items: [
      { id: 'dhs4138',    name: 'DHS-4138 provider agreement' },
      { id: 'dhs7120',    name: 'DHS-7120 assurance statement', note: 'C for QSP, D/E/F by provider level' },
      { id: 'welcome',    name: 'DHS welcome letter' }
    ] }
  ];

  var CLIENT_DOCS = [
    { group: 'Starting services', items: [
      { id: 'intake',     name: 'Intake' },
      { id: 'insurance',  name: 'Insurance' },
      { id: 'agreement',  name: 'Service agreement' },
      { id: 'roi',        name: 'Release of information (ROI)' }
    ] },
    { group: 'Clinical', items: [
      { id: 'cmde',       name: 'CMDE' },
      { id: 'itp',        name: 'ITP' },
      { id: 'iep',        name: 'IEP', note: 'If applicable' }
    ] },
    { group: 'Closing', items: [
      { id: 'discharge',  name: 'Discharge', note: 'If applicable' }
    ] }
  ];

  // A file checklist is an entity roster crossed with a document catalog.
  // One stored record per person: { id: <entityId>, docs: { <docId>: {...} } }.
  var FILES = {
    empfiles: {
      label: 'Employee Files', short: 'Employee file', color: 'orange', phi: false,
      entity: 'staff', noun: 'employee', docs: EMPLOYEE_DOCS,
      blurb: 'Every document HR needs on file, per employee. Mirrors the printed Employee File Checklist.'
    },
    clientfiles: {
      label: 'Client Files', short: 'Client file', color: 'berry', phi: true,
      entity: 'clients', noun: 'client', docs: CLIENT_DOCS,
      blurb: 'Required paperwork per client, from intake through discharge. Mirrors the printed Client File Checklist.'
    }
  };

  var FILE_STATES = { none: 'Outstanding', yes: 'On file', na: 'Not applicable' };

  /* Definition lookup across BOTH registries.
   *
   * File checklists live in FILES, not MODULES, so anything that reached for
   * MODULES[key] alone saw `undefined` for empfiles/clientfiles — which meant
   * clientfiles.phi (true) was ignored: it defaulted to SHARED and skipped the
   * PHI confirmation. Every scope decision goes through here now. */
  function defOf(key) {
    return MODULES[key] || FILES[key] || SUPS[key] || {};
  }

  function fileRec(key, entityId) {
    var r = Store.get(key, entityId);
    return (r && !r.deletedAt) ? r : { id: entityId, docs: {} };
  }
  function docState(key, entityId, docId) {
    return (fileRec(key, entityId).docs || {})[docId] || { status: 'none', date: '', note: '' };
  }
  // "Not applicable" is excluded from the denominator, so a file can read 100%
  // complete even when some documents genuinely do not apply to that person.
  function fileStats(key, entityId) {
    var rec = fileRec(key, entityId), total = 0, done = 0, na = 0, missing = [];
    FILES[key].docs.forEach(function (g) {
      g.items.forEach(function (d) {
        var st = (rec.docs || {})[d.id] || {};
        if (st.status === 'na') { na++; return; }
        total++;
        if (st.status === 'yes') done++; else missing.push(d.name);
      });
    });
    return { total: total, done: done, na: na, missing: missing,
             pct: total ? Math.round((done / total) * 100) : 0 };
  }
  function fileProgressText(key, entityId) {
    var s = fileStats(key, entityId);
    return s.done + ' / ' + s.total + (s.na ? ' (' + s.na + ' n/a)' : '');
  }

  /* ------------------------------------------------- client supervision
   * Monthly supervision compliance, one record per client per month, laid
   * out like the clinical supervision report it replaces: direct therapy
   * hours drive the hours REQUIRED, the session log drives the hours
   * actually PROVIDED, and the gap between them is the thing to catch
   * before the month closes rather than after.
   *
   * One hour of supervision per SUP_RATIO hours of direct therapy. Checked
   * against the June 2026 report: 177h58m direct required 11h07m of
   * supervision, which is 1:16 to the minute.
   */
  var SUP_RATIO = 16;
  var SUP_CODES = ['H0032', '97155', '97156', 'Other'];
  // Direct intervention. These do not become supervision sessions — they are
  // summed into the month's direct therapy total, which is what drives the
  // required supervision hours (direct / SUP_RATIO). Add codes here if your
  // billing uses others.
  var DIRECT_CODES = ['97153', '97154', 'H2019'];
  var SUP_LOCATIONS = ['Home', 'Clinic', 'Center', 'School', 'Telehealth', 'Other'];

  var SUPS = {
    clientsup: {
      label: 'Client Supervision', short: 'Supervision month', color: 'berry', phi: true,
      entity: 'clients', noun: 'client',
      blurb: 'Supervision required vs. provided, per client per month. Required hours are computed ' +
             'from direct therapy at 1 hour per ' + SUP_RATIO + '.'
    }
  };

  // 667 -> "11 hrs 7 mins". Whole hours and whole minutes read better here
  // than a decimal, because that is how the report and the payer state it.
  function hm(mins) {
    var m = Math.max(0, Math.round(mins || 0));
    var h = Math.floor(m / 60), r = m % 60;
    if (!h && !r) return '0 mins';
    if (!h) return r + (r === 1 ? ' min' : ' mins');
    if (!r) return h + (h === 1 ? ' hr' : ' hrs');
    return h + (h === 1 ? ' hr ' : ' hrs ') + r + (r === 1 ? ' min' : ' mins');
  }

  // "HH:MM" from <input type="time">, in local wall-clock terms.
  function minsBetween(a, b) {
    var pa = /^(\d{1,2}):(\d{2})$/.exec(a || '');
    var pb = /^(\d{1,2}):(\d{2})$/.exec(b || '');
    if (!pa || !pb) return 0;
    var n = (+pb[1] * 60 + +pb[2]) - (+pa[1] * 60 + +pa[2]);
    // An end before the start is a typo, not a negative session.
    return n > 0 ? n : 0;
  }

  function fmtTime(s) {
    var p = /^(\d{1,2}):(\d{2})$/.exec(s || '');
    if (!p) return '—';
    var h = +p[1], ap = h < 12 ? 'am' : 'pm';
    return ((h % 12) || 12) + ':' + p[2] + ap;
  }

  // Month is stored as YYYY-MM, the value an <input type="month"> gives back.
  function monthLabel(s) {
    var p = /^(\d{4})-(\d{2})$/.exec(s || '');
    if (!p) return '—';
    return new Date(+p[1], +p[2] - 1, 1)
      .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
  function monthStart(s) {
    var p = /^(\d{4})-(\d{2})$/.exec(s || '');
    return p ? p[1] + '-' + p[2] + '-01' : '';
  }
  function monthEnd(s) {
    var p = /^(\d{4})-(\d{2})$/.exec(s || '');
    if (!p) return '';
    return toISO(new Date(+p[1], +p[2], 0));
  }
  function thisMonth() {
    var n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0');
  }

  function supStats(r) {
    var direct = Math.max(0, Math.round(+(r && r.directMin) || 0));
    var required = Math.round(direct / SUP_RATIO);
    var provided = ((r && r.sessions) || []).reduce(function (n, s) {
      return n + minsBetween(s.start, s.end);
    }, 0);
    return {
      direct: direct, required: required, provided: provided,
      short: Math.max(0, required - provided),
      pct: required ? Math.min(100, Math.round((provided / required) * 100)) : 100
    };
  }

  // A month still running is "in progress", not yet a shortfall to answer for.
  function supOpen(r) {
    var end = monthEnd(r && r.month);
    return !end || daysUntil(end) >= 0;
  }

  // Supervision is now client-first: #clientsup -> #clientsup:<client> ->
  // #clientsup:<client>:<monthRecordId>. The client segment is the client's
  // name, URI-encoded, so it never collides with the ':' separator and works
  // for records whose client is not (or no longer) on the roster.
  function supKey(name) { return encodeURIComponent(String(name || '')); }
  function supName(key) {
    try { return decodeURIComponent(String(key || '')); } catch (e) { return String(key || ''); }
  }
  function supHash(r) { return 'clientsup:' + supKey(r.client) + ':' + r.id; }

  // Every client with supervision records, plus every active roster client,
  // each appearing exactly once.
  function supClients() {
    var seen = {}, out = [];
    Store.all('clientsup').forEach(function (r) {
      var nm = r.client || 'Unnamed client';
      if (!seen[nm]) { seen[nm] = { name: nm, rows: [] }; out.push(seen[nm]); }
      seen[nm].rows.push(r);
    });
    Store.all('clients').forEach(function (c) {
      if (c.active === false || !c.name || seen[c.name]) return;
      seen[c.name] = { name: c.name, rows: [] };
      out.push(seen[c.name]);
    });
    return out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  /* ------------------------------------------------ near-duplicate names
   *
   * Supervision months key the client by NAME, so "Suhaib Musa" and "Suhaib
   * Muse" are two people as far as the data is concerned. That is how one
   * human ends up listed twice: the roster says one spelling, an export says
   * another, and the importer matches on exact text.
   *
   * These are only ever SUGGESTIONS. "Ahmed Ali" and "Ahmad Ali" are one
   * character apart and may well be two different children — so nothing is
   * merged without someone saying so. The cost of a wrong auto-merge is two
   * clients' records silently fused; the cost of a missed suggestion is a
   * duplicate row somebody notices.
   */
  function normName(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip accents
      .replace(/[^a-z0-9\s]/g, ' ')                      // punctuation to space
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Bounded Levenshtein: stops as soon as it is certain the distance is > max,
  // because anything beyond that is not a suggestion worth making.
  function editDistance(a, b, max) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i;
      var best = cur[0];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1)
        );
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1;
      for (j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
  }

  // How alike two names are: 'same' once normalising makes them identical,
  // 'close' for a small typo, or null.
  function nameLikeness(a, b) {
    var na = normName(a), nb = normName(b);
    if (!na || !nb) return null;
    if (na === nb) return 'same';

    // Spacing and punctuation do not make a different person: "O'Brien" and
    // "OBrien", "Mary-Jane" and "Mary Jane".
    var sa = na.replace(/\s/g, ''), sb = nb.replace(/\s/g, '');
    if (sa === sb) return 'same';

    // The same words in a different order — "Musa Suhaib" vs "Suhaib Musa",
    // which is how a surname-first export collides with a roster.
    var wa = na.split(' ').slice().sort().join(' ');
    var wb = nb.split(' ').slice().sort().join(' ');
    if (wa === wb) return 'same';

    // Below this, a single edit says too little: "Ali M" and "Ala M" are not
    // a suggestion worth making. Measured without spaces so a middle name
    // does not inflate the count.
    var len = Math.min(sa.length, sb.length);
    if (len < 6) return null;

    var d = editDistance(na, nb, 2);
    if (d <= 1) return 'close';
    if (d === 2 && len >= 12) return 'close';

    return null;
  }

  // Pairs of names in the supervision view that look like one person. The
  // roster spelling is preferred as the survivor, because that record is what
  // files, authorizations and everything else already point at.
  // Pairs somebody has already said are two different people. Keyed on the
  // normalised names so re-importing the same spellings does not resurrect a
  // question that has been answered.
  function dupePairKey(a, b) {
    return [normName(a), normName(b)].sort().join('|');
  }
  function dismissedPairs() {
    try { return JSON.parse(localStorage.getItem(LS_NOTDUPE) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function dismissPair(a, b) {
    var d = dismissedPairs();
    d[dupePairKey(a, b)] = 1;
    try { localStorage.setItem(LS_NOTDUPE, JSON.stringify(d)); } catch (e) {}
  }

  function supDuplicates() {
    var names = supClients().map(function (c) { return c.name; });
    var onRoster = {};
    Store.all('clients').forEach(function (c) {
      if (c.name && c.active !== false) onRoster[c.name] = 1;
    });
    var dismissed = dismissedPairs();

    var pairs = [];
    for (var i = 0; i < names.length; i++) {
      for (var j = i + 1; j < names.length; j++) {
        var how = nameLikeness(names[i], names[j]);
        if (!how) continue;
        if (dismissed[dupePairKey(names[i], names[j])]) continue;
        var a = names[i], b = names[j];
        // Keep the roster spelling; failing that, keep the one with months.
        var keep, drop;
        if (onRoster[a] && !onRoster[b]) { keep = a; drop = b; }
        else if (onRoster[b] && !onRoster[a]) { keep = b; drop = a; }
        else { keep = a; drop = b; }
        pairs.push({ keep: keep, drop: drop, how: how, bothOnRoster: !!(onRoster[a] && onRoster[b]) });
      }
    }
    return pairs;
  }

  // Move every supervision month from one name onto another.
  //
  // One record per client per month is an invariant the rest of the module
  // relies on, and a merge is exactly where it would break: both spellings can
  // hold the same month. Where that happens the two are folded into one —
  // sessions combined and de-duplicated, and the larger direct-therapy figure
  // kept, since a zero means "never imported" rather than "no therapy".
  function supMergeNames(fromName, toName) {
    var moving = Store.all('clientsup').filter(function (r) { return r.client === fromName; });
    var target = {};
    Store.all('clientsup').forEach(function (r) {
      if (r.client === toName) target[r.month] = r;
    });

    var moved = 0, folded = 0;
    moving.forEach(function (r) {
      var into = target[r.month];
      if (!into) {
        Store.save('clientsup', Object.assign({}, r, { client: toName }));
        moved++;
        return;
      }
      var sessions = (into.sessions || []).slice();
      var have = {};
      sessions.forEach(function (s) { have[s.date + '|' + s.start + '|' + s.end] = 1; });
      (r.sessions || []).forEach(function (s) {
        var k = s.date + '|' + s.start + '|' + s.end;
        if (have[k]) return;
        have[k] = 1;
        sessions.push(Object.assign({}, s, { id: s.id || uid() }));
      });
      Store.save('clientsup', Object.assign({}, into, {
        sessions: sessions,
        directMin: Math.max(+into.directMin || 0, +r.directMin || 0),
        notes: [into.notes, r.notes].filter(Boolean).join(' · ')
      }));
      Store.remove('clientsup', r.id);
      folded++;
    });

    // If the name being dropped was its own roster entry, retire it — leaving
    // it behind is what keeps the duplicate visible.
    var strays = Store.all('clients').filter(function (c) { return c.name === fromName; });
    strays.forEach(function (c) { Store.remove('clients', c.id); });

    return { moved: moved, folded: folded, rosterRemoved: strays.length };
  }

  // Totals across one client's months, so the top row can say something useful
  // without opening anything.
  function supRollup(rows) {
    var req = 0, prov = 0, short = 0, closedShort = 0;
    rows.forEach(function (r) {
      var st = supStats(r);
      req += st.required; prov += st.provided;
      if (!supOpen(r) && st.short > 0) { short += st.short; closedShort++; }
    });
    return { required: req, provided: prov, short: short, closedShort: closedShort,
             pct: req ? Math.min(100, Math.round((prov / req) * 100)) : 100 };
  }

  function supTitle(r) {
    return (r.client || 'Unnamed client') + ' — ' + monthLabel(r.month);
  }

  /* --------------------------------------------------------------- modules */

  var MODULES = {
    auths: {
      label: 'Client Authorizations', short: 'Auths', color: 'green', phi: true,
      blurb: 'Service authorizations and the date each one runs out.',
      dueField: 'endDate', dueLabel: 'Authorization ends', warnAt: 45,
      titleOf: function (r) { return r.client || 'Untitled'; },
      sub: function (r) { return [r.payer, r.service].filter(Boolean).join(' · '); },
      fields: [
        { k: 'client', label: 'Client', type: 'client', required: true },
        { k: 'clientId', label: 'Client / MA ID', type: 'text' },
        { k: 'payer', label: 'Payer', type: 'text', placeholder: 'UCare, BCBS, MA fee-for-service…' },
        { k: 'service', label: 'Service / code', type: 'text', placeholder: '97153, 97155…' },
        { k: 'authNumber', label: 'Authorization number', type: 'text' },
        { k: 'startDate', label: 'Start date', type: 'date' },
        { k: 'endDate', label: 'End date', type: 'date', required: true },
        { k: 'unitsAuth', label: 'Units authorized', type: 'number' },
        { k: 'unitsUsed', label: 'Units used', type: 'number' },
        { k: 'owner', label: 'Owner', type: 'text' },
        { k: 'notes', label: 'Notes', type: 'textarea' }
      ],
      columns: [
        { k: 'client', label: 'Client', wide: true },
        { k: 'payer', label: 'Payer' },
        { k: 'service', label: 'Service' },
        { k: 'endDate', label: 'Ends', type: 'date' },
        { k: '_units', label: 'Units', compute: function (r) {
            if (!r.unitsAuth) return '—';
            var used = Number(r.unitsUsed || 0), auth = Number(r.unitsAuth);
            var pct = auth ? Math.round((used / auth) * 100) : 0;
            return used + ' / ' + auth + ' (' + pct + '%)';
          } },
        { k: '_status', label: 'Status', type: 'status' }
      ]
    },

    clients: {
      label: 'Clients', short: 'Client', color: 'berry', phi: true,
      blurb: 'The client roster. Drives the client file checklists and the authorization list.',
      dueField: null,
      titleOf: function (r) { return r.name || 'Unnamed'; },
      fields: [
        { k: 'name', label: 'Client name', type: 'text', required: true },
        { k: 'clientId', label: 'Client / MA ID', type: 'text' },
        { k: 'dob', label: 'Date of birth', type: 'date' },
        { k: 'startDate', label: 'Start of services', type: 'date' },
        { k: 'payer', label: 'Payer', type: 'text' },
        { k: 'guardian', label: 'Parent / guardian', type: 'text' },
        { k: 'phone', label: 'Phone', type: 'text' },
        { k: 'active', label: 'Currently receiving services', type: 'check', default: true },
        { k: 'notes', label: 'Notes', type: 'textarea' }
      ],
      columns: [
        { k: 'name', label: 'Client', wide: true },
        { k: 'clientId', label: 'ID' },
        { k: 'payer', label: 'Payer' },
        { k: 'startDate', label: 'Started', type: 'date' },
        { k: '_files', label: 'File', compute: function (r) { return fileProgressText('clientfiles', r.id); } },
        { k: '_active', label: 'Status', compute: function (r) { return r.active === false ? 'Discharged' : 'Active'; } }
      ]
    },

    staff: {
      label: 'Staff Roster', short: 'Staff', color: 'blue', phi: false,
      blurb: 'Everyone on the team. Roles and hire dates drive the training deadlines.',
      dueField: null,
      titleOf: function (r) { return r.name || 'Unnamed'; },
      fields: [
        { k: 'name', label: 'Name', type: 'text', required: true },
        { k: 'role', label: 'Role', type: 'select', required: true,
          options: ROLES.map(function (r) { return r.label; }), valueMap: ROLES },
        { k: 'hireDate', label: 'Hire date', type: 'date' },
        { k: 'altPathway', label: 'Enrolled under the alternate pathway', type: 'check',
          help: 'Makes “Required — alternate pathway” trainings count as required for this person.' },
        { k: 'email', label: 'Email', type: 'text' },
        { k: 'active', label: 'Currently employed', type: 'check', default: true },
        { k: 'notes', label: 'Notes', type: 'textarea' }
      ],
      columns: [
        { k: 'name', label: 'Name', wide: true },
        { k: '_role', label: 'Role', compute: function (r) { return roleLabel(r.role); } },
        { k: 'hireDate', label: 'Hired', type: 'date' },
        { k: '_due', label: 'Training due', type: 'date', compute: function (r) { return trainingDue(r); } },
        { k: '_files', label: 'File', compute: function (r) { return fileProgressText('empfiles', r.id); } },
        { k: '_active', label: 'Status', compute: function (r) { return r.active === false ? 'Inactive' : 'Active'; } }
      ]
    },

    credentials: {
      label: 'Staff Credentials', short: 'Credentials', color: 'purple', phi: false,
      blurb: 'Licenses, certifications and background studies that expire.',
      dueField: 'expires', dueLabel: 'Expires', warnAt: 60,
      titleOf: function (r) { return (r.staff || 'Unnamed') + ' — ' + (r.credType || 'Credential'); },
      fields: [
        { k: 'staff', label: 'Staff member', type: 'staff', required: true },
        { k: 'credType', label: 'Credential', type: 'select', required: true,
          options: ['BCBA / LBA license', 'BCaBA', 'RBT certification', 'DHS background study',
                    'CPR / First aid', 'Driver’s license', 'Auto insurance', 'Mental health license', 'Other'] },
        { k: 'number', label: 'Number', type: 'text' },
        { k: 'issued', label: 'Issued', type: 'date' },
        { k: 'expires', label: 'Expires', type: 'date', required: true },
        { k: 'onFile', label: 'Copy on file', type: 'check' },
        { k: 'notes', label: 'Notes', type: 'textarea' }
      ],
      columns: [
        { k: 'staff', label: 'Staff', wide: true },
        { k: 'credType', label: 'Credential' },
        { k: 'number', label: 'Number' },
        { k: 'expires', label: 'Expires', type: 'date' },
        { k: '_file', label: 'On file', compute: function (r) { return r.onFile ? 'Yes' : 'No'; } },
        { k: '_status', label: 'Status', type: 'status' }
      ]
    },

    renewals: {
      label: 'Agency Renewals', short: 'Renewals', color: 'orange', phi: false,
      blurb: 'Insurance, enrollment, licensing and anything else the agency must renew.',
      dueField: 'renewalDate', dueLabel: 'Renews', warnAt: 60,
      titleOf: function (r) { return r.item || 'Untitled'; },
      fields: [
        { k: 'item', label: 'Item', type: 'text', required: true,
          placeholder: 'Liability insurance, MHCP revalidation…' },
        { k: 'vendor', label: 'Vendor / agency', type: 'text' },
        { k: 'policyNumber', label: 'Policy / reference number', type: 'text' },
        { k: 'renewalDate', label: 'Renewal date', type: 'date', required: true },
        { k: 'owner', label: 'Owner', type: 'text' },
        { k: 'cost', label: 'Cost', type: 'text' },
        { k: 'notes', label: 'Notes', type: 'textarea' }
      ],
      columns: [
        { k: 'item', label: 'Item', wide: true },
        { k: 'vendor', label: 'Vendor' },
        { k: 'owner', label: 'Owner' },
        { k: 'renewalDate', label: 'Renews', type: 'date' },
        { k: '_status', label: 'Status', type: 'status' }
      ]
    },

    reminders: {
      label: 'Payroll & Billing Reminders', short: 'Reminders', color: 'green', phi: false,
      blurb: 'Recurring deadlines. Marking one done rolls it to the next occurrence.',
      dueField: 'dueDate', dueLabel: 'Due', warnAt: 7, recurring: true,
      titleOf: function (r) { return r.title || 'Untitled'; },
      fields: [
        { k: 'title', label: 'Reminder', type: 'text', required: true,
          placeholder: 'Submit payroll, send claims, reconcile ERAs…' },
        { k: 'category', label: 'Category', type: 'select', required: true,
          options: ['Payroll', 'Billing', 'Compliance', 'Other'] },
        { k: 'dueDate', label: 'Next due', type: 'date', required: true },
        { k: 'repeat', label: 'Repeats', type: 'select',
          options: ['Does not repeat', 'Weekly', 'Every 2 weeks', 'Twice a month (1st & 15th)',
                    'Monthly', 'Quarterly', 'Yearly'] },
        { k: 'owner', label: 'Owner', type: 'text' },
        { k: 'notes', label: 'Notes', type: 'textarea' }
      ],
      columns: [
        { k: 'title', label: 'Reminder', wide: true },
        { k: 'category', label: 'Category' },
        { k: 'repeat', label: 'Repeats' },
        { k: 'owner', label: 'Owner' },
        { k: 'dueDate', label: 'Due', type: 'date' },
        { k: '_status', label: 'Status', type: 'status' }
      ]
    },

    /* The staff "Supervision & Observation" module was removed: the note-taking
     * software already tracks QSP observation of staff, and a second place to
     * record it is a second place to keep in step. RETIRED_KEYS below clears
     * what it left behind. Client supervision (SUPS.clientsup) is unrelated and
     * stays \u2014 that one tracks required vs. provided hours per client. */

    contacts: {
      label: 'Contacts', short: 'Contact', color: 'blue', phi: false,
      blurb: 'Payers, case managers, county workers, vendors \u2014 the numbers you keep hunting for.',
      dueField: null,
      titleOf: function (r) { return r.name || 'Unnamed'; },
      fields: [
        { k: 'name', label: 'Name', type: 'text', required: true },
        { k: 'org', label: 'Organisation', type: 'text', placeholder: 'UCare, Hennepin County, landlord\u2026' },
        { k: 'category', label: 'Category', type: 'select',
          options: ['Payer', 'Case manager', 'County', 'School', 'Vendor', 'Clinical', 'Other'] },
        { k: 'phone', label: 'Phone', type: 'text' },
        { k: 'email', label: 'Email', type: 'text' },
        { k: 'notes', label: 'Notes', type: 'textarea' }
      ],
      columns: [
        { k: 'name', label: 'Name', wide: true },
        { k: 'org', label: 'Organisation' },
        { k: 'category', label: 'Category' },
        { k: 'phone', label: 'Phone' },
        { k: 'email', label: 'Email' }
      ]
    }
  };

  function roleLabel(k) {
    for (var i = 0; i < ROLES.length; i++) if (ROLES[i].k === k) return ROLES[i].label;
    return k || '—';
  }
  function roleKey(label) {
    for (var i = 0; i < ROLES.length; i++) if (ROLES[i].label === label) return ROLES[i].k;
    return label;
  }

  // Modules that live in their own tab but are not plain record tables.
  var ALL_KEYS = Object.keys(MODULES)
    .concat(['training', 'checklists'])
    .concat(Object.keys(FILES))
    .concat(Object.keys(SUPS));

  /* ----------------------------------------------------------------- store
   * Every module keeps a local cache in localStorage, so the page renders
   * instantly and still works if the network is down. Shared modules also
   * push and pull through /api/tracker, merging per record.
   */
  var Store = (function () {
    var cache = {};          // module -> [record]
    var index = {};          // module -> { id: record }  (kept in step with cache)
    var scopes = {};         // module -> 'local' | 'shared'
    var status = {};         // module -> 'local' | 'syncing' | 'ok' | 'error'
    var listeners = [];
    var statusNote = {};   // module -> last error message

    function defaultScope(mod) {
      // defOf, not MODULES — file checklists and supervision months live in
      // their own registries, and reading MODULES alone silently dropped
      // their phi flag.
      return defOf(mod).phi ? 'local' : 'shared';
    }

    function loadScopes() {
      var saved = {};
      try { saved = JSON.parse(localStorage.getItem(LS_SCOPE) || '{}') || {}; } catch (e) {}
      ALL_KEYS.forEach(function (m) {
        scopes[m] = saved[m] === 'local' || saved[m] === 'shared' ? saved[m] : defaultScope(m);
      });

      // One-time repair. Browsers that ran the version where defaultScope
      // could not see FILES have clientfiles saved as 'shared'. That choice
      // was never made deliberately — no PHI prompt was ever shown — so pull
      // every PHI module back to this device. Re-sharing is still possible,
      // it just has to go through the prompt now.
      var repaired = [];
      try {
        if (!localStorage.getItem(LS_PHI_FIX)) {
          ALL_KEYS.forEach(function (m) {
            if (defOf(m).phi && scopes[m] === 'shared') { scopes[m] = 'local'; repaired.push(m); }
          });
          localStorage.setItem(LS_PHI_FIX, '1');
          if (repaired.length) saveScopes();
        }
      } catch (e) {}
      phiRepaired = repaired;
    }
    function saveScopes() {
      try { localStorage.setItem(LS_SCOPE, JSON.stringify(scopes)); } catch (e) {}
    }

    function readLocal(mod) {
      try {
        var raw = localStorage.getItem(LS_PREFIX + mod);
        var parsed = raw ? JSON.parse(raw) : null;
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) { return []; }
    }
    function writeLocal(mod) {
      try { localStorage.setItem(LS_PREFIX + mod, JSON.stringify(cache[mod] || [])); }
      catch (e) { flash('Could not save locally — browser storage may be full.', true); }
    }

    function emit(mod) {
      listeners.forEach(function (fn) { try { fn(mod); } catch (e) {} });
    }

    // Merge incoming records into the cache, newest updatedAt wins.
    function merge(mod, incoming) {
      var byId = {};
      (cache[mod] || []).forEach(function (r) { byId[r.id] = r; });
      (incoming || []).forEach(function (r) {
        if (!r || !r.id) return;
        var prev = byId[r.id];
        if (!prev || (r.updatedAt || 0) >= (prev.updatedAt || 0)) byId[r.id] = r;
      });
      cache[mod] = Object.keys(byId).map(function (k) { return byId[k]; });
      index[mod] = byId;
      writeLocal(mod);
    }

    function api(opts) {
      return fetch(opts.url, opts.init).then(function (res) {
        if (res.status === 401) throw new Error('Your session locked — reload the page and enter the staff code.');
        return res.json().catch(function () { throw new Error('Server sent an unreadable response.'); });
      }).then(function (body) {
        if (!body || !body.ok) throw new Error((body && body.error) || 'Sync failed.');
        return body;
      });
    }

    function pull(mod) {
      if (scopes[mod] !== 'shared') { status[mod] = 'local'; return Promise.resolve(); }
      status[mod] = 'syncing'; emit(mod);
      return api({ url: API + '?module=' + encodeURIComponent(mod) })
        .then(function (body) {
          merge(mod, body.records);
          status[mod] = 'ok';
          emit(mod);
        })
        .catch(function (err) {
          status[mod] = 'error';
          statusNote[mod] = err.message;
          emit(mod);
        });
    }

    function push(mod, upserts, deletes) {
      if (scopes[mod] !== 'shared') { status[mod] = 'local'; return Promise.resolve(); }
      status[mod] = 'syncing'; emit(mod);
      return api({
        url: API,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ module: mod, upserts: upserts || [], deletes: deletes || [] })
        }
      }).then(function (body) {
        merge(mod, body.records);
        status[mod] = 'ok';
        emit(mod);
      }).catch(function (err) {
        // The edit is already in the local cache, so nothing is lost —
        // it will go up on the next successful sync.
        status[mod] = 'error';
        statusNote[mod] = err.message;
        emit(mod);
      });
    }

    return {
      // Clear anything a removed module left behind, once.
      sweepRetired: function () {
        var done = false;
        try { done = !!localStorage.getItem(LS_RETIRED); } catch (e) {}
        if (done) return Promise.resolve(0);

        var hit = [];
        RETIRED_KEYS.forEach(function (m) {
          try {
            if (localStorage.getItem(LS_PREFIX + m) != null) hit.push(m);
            localStorage.removeItem(LS_PREFIX + m);
          } catch (e) {}
        });
        try { localStorage.setItem(LS_RETIRED, '1'); } catch (e) {}

        // Best effort: an offline browser simply sweeps again next time, so
        // the flag is only set above once the local half has succeeded.
        return Promise.all(RETIRED_KEYS.map(function (m) {
          return api({ url: API + '?module=' + encodeURIComponent(m), init: { method: 'DELETE' } })
            .catch(function () { return null; });
        })).then(function () { return hit.length; });
      },
      init: function () {
        loadScopes();
        ALL_KEYS.forEach(function (m) {
          cache[m] = readLocal(m);
          index[m] = {};
          cache[m].forEach(function (r) { if (r && r.id) index[m][r.id] = r; });
          status[m] = scopes[m] === 'shared' ? 'syncing' : 'local';
        });
      },
      onChange: function (fn) { listeners.push(fn); },
      scope: function (mod) { return scopes[mod]; },
      setScope: function (mod, s) {
        scopes[mod] = s;
        saveScopes();
        if (s === 'shared') {
          // Publish everything this browser holds, then adopt the merged result.
          push(mod, (cache[mod] || []).filter(function (r) { return !r.deletedAt; }), []);
        } else {
          status[mod] = 'local';
          emit(mod);
        }
      },
      status: function (mod) { return status[mod]; },
      note: function (mod) { return statusNote[mod]; },
      all: function (mod) {
        return (cache[mod] || []).filter(function (r) { return !r.deletedAt; });
      },
      get: function (mod, id) {
        var r = (index[mod] || {})[id];
        return r || null;
      },
      save: function (mod, rec) {
        if (!rec.id) rec.id = uid();
        rec.updatedAt = Date.now();
        merge(mod, [rec]);
        emit(mod);
        push(mod, [rec], []);
        return rec;
      },
      remove: function (mod, id) {
        merge(mod, [{ id: id, deletedAt: Date.now(), updatedAt: Date.now() }]);
        emit(mod);
        push(mod, [], [id]);
      },
      // Delete the server's copy of a module without touching this browser's.
      // The response is deliberately not merged: merging would pull the very
      // records we just removed back into the local cache.
      purgeServer: function (mod) {
        return api({ url: API + '?module=' + encodeURIComponent(mod), init: { method: 'DELETE' } });
      },
      pull: pull,
      pullAll: function () {
        return Promise.all(ALL_KEYS.map(function (m) { return pull(m); }));
      },
      // Everything on this browser, for the backup file.
      exportAll: function () {
        var out = { format: 'noor-tracker', version: 1, exportedAt: new Date().toISOString(), modules: {} };
        ALL_KEYS.forEach(function (m) { out.modules[m] = cache[m] || []; });
        return out;
      },
      importAll: function (doc) {
        if (!doc || doc.format !== 'noor-tracker' || !doc.modules) throw new Error('Not a Noor tracker backup file.');
        var count = 0;
        ALL_KEYS.forEach(function (m) {
          var recs = doc.modules[m];
          if (!Array.isArray(recs)) return;
          count += recs.length;
          merge(m, recs);
          if (scopes[m] === 'shared') push(m, recs.filter(function (r) { return !r.deletedAt; }), []);
        });
        emit(null);
        return count;
      }
    };
  })();

  /* -------------------------------------------------------- training state */

  function trainingRecId(staffId, trainingId) { return 't_' + staffId + '_' + trainingId; }

  function trainingState(staffId, trainingId) {
    var r = Store.get('training', trainingRecId(staffId, trainingId));
    return (r && !r.deletedAt) ? r : { id: trainingRecId(staffId, trainingId), staffId: staffId,
      trainingId: trainingId, status: 'none', completedDate: '', certOnFile: false };
  }

  function trainingSummary(staff) {
    var req = 0, done = 0, outstanding = [];
    TRAININGS.forEach(function (t) {
      if (requirementFor(staff, t) !== 'req') return;
      req++;
      var st = trainingState(staff.id, t.id);
      if (st.status === 'done') done++; else outstanding.push(t.name);
    });
    return { required: req, done: done, outstanding: outstanding };
  }

  /* ------------------------------------------------------------- dashboard */

  function dueItems(within) {
    var out = [];

    Object.keys(MODULES).forEach(function (mod) {
      var def = MODULES[mod];
      if (!def.dueField) return;
      Store.all(mod).forEach(function (r) {
        // Finished paperwork should stop nagging.
        if (mod === 'cmde' && (r.status === 'Submitted' || r.status === 'Approved')) return;
        var days = daysUntil(r[def.dueField]);
        if (days == null) return;
        out.push({
          mod: mod, id: r.id, color: def.color,
          title: def.titleOf(r), sub: def.sub ? def.sub(r) : '',
          what: def.dueLabel, date: r[def.dueField], days: days, warnAt: def.warnAt
        });
      });
    });

    // One row per staff member with required trainings still outstanding.
    Store.all('staff').forEach(function (s) {
      if (s.active === false || !s.hireDate) return;
      var sum = trainingSummary(s);
      if (!sum.outstanding.length) return;
      var due = trainingDue(s);
      out.push({
        mod: 'training', id: s.id, color: 'blue',
        title: s.name + ' — ' + sum.outstanding.length + ' required training' +
               (sum.outstanding.length === 1 ? '' : 's') + ' outstanding',
        sub: sum.outstanding.join(', '),
        what: 'Training deadline', date: due, days: daysUntil(due), warnAt: 30
      });
    });

    return out.filter(function (i) { return i.days != null && i.days <= within; })
              .sort(function (a, b) { return a.days - b.days; });
  }

  function renderDashboard() {
    var within = 60;
    var items = dueItems(within);
    var over = items.filter(function (i) { return i.days < 0; });
    var soon = items.filter(function (i) { return i.days >= 0 && i.days <= 14; });
    var later = items.filter(function (i) { return i.days > 14; });
    var openItems = openChecklistCount();
    var files = incompleteFiles();

    var h = '<div class="tk-head"><div>' +
      '<h2>Everything at a glance</h2>' +
      '<p class="tk-sub">Anything overdue or due in the next ' + within + ' days, your checklists, ' +
      'and any file still missing paperwork.</p>' +
      '</div><div class="tk-head-actions">' +
      '<button type="button" class="tk-btn" data-jump="reminders">+ Reminder</button>' +
      '<button type="button" class="tk-btn" data-jump="checklists">+ Checklist</button>' +
      '</div></div>';

    var supShort = supShortfalls();

    // The scope repair moved data without being asked. Say so, once.
    if (phiRepaired.length) {
      h += '<p class="tk-note tk-note-warn"><strong>Client data was pulled back to this browser.</strong> ' +
        esc(phiRepaired.map(function (m) { return defOf(m).label || m; }).join(', ')) +
        ' had been syncing to the server because of a bug — the prompt warning that this is protected ' +
        'health information never appeared. New edits stay on this device. Copies already uploaded are ' +
        'still on the server: clear them from <a href="#settings" data-jump="settings">Settings</a>.</p>';
    }

    h += '<div class="tk-stats">' +
      statTile('Overdue', over.length, over.length ? 'over' : 'ok') +
      statTile('Next 14 days', soon.length, soon.length ? 'soon' : 'ok') +
      statTile('Open checklist items', openItems, openItems ? 'soon' : 'ok') +
      statTile('Files incomplete', files.length, files.length ? 'over' : 'ok') +
      // Neutral, not red: these are closed months, so the figure is a record
      // rather than something to act on.
      statTile('Supervision short', supShort.length, supShort.length ? 'none' : 'ok') +
      '</div>';

    h += group('Overdue', over) + group('Next 14 days', soon);

    // ---- supervision months that closed under the requirement ----
    if (supShort.length) {
      h += '<div class="tk-group"><h3>Supervision shortfalls <span>' + supShort.length + '</span></h3>' +
        '<div class="tk-filelist">';
      supShort.forEach(function (r) {
        var st = supStats(r);
        h += '<a class="tk-filerow" href="#' + esc(supHash(r)) + '" data-jump="' + esc(supHash(r)) + '">' +
          '<span class="tk-due-main"><strong>' + esc(r.client || 'Unnamed client') + '</strong>' +
          '<small>' + esc(monthLabel(r.month)) + ' closed ' + esc(hm(st.short)) + ' short</small></span>' +
          '<span class="tk-badge tk-over">' + esc(hm(st.provided)) + ' / ' + esc(hm(st.required)) + '</span></a>';
      });
      h += '</div></div>';
    }

    // ---- checklists, in full, because this is what gets checked daily ----
    var lists = Store.all('checklists').sort(function (a, b) {
      return String(a.name).localeCompare(String(b.name));
    });
    if (lists.length) {
      h += '<div class="tk-group"><h3>Checklists <span>' + lists.length + '</span></h3><div class="tk-lists">';
      lists.forEach(function (c) {
        var all = c.items || [];
        var done = all.filter(function (i) { return i.done; }).length;
        var pct = all.length ? Math.round((done / all.length) * 100) : 0;
        var open = all.filter(function (i) { return !i.done; });

        h += '<section class="tk-list"><header>' +
          '<h3>' + esc(c.name || 'Untitled') + '</h3>' +
          '<span class="tk-count">' + done + ' / ' + all.length + '</span>' +
          '<span class="tk-progress"><span style="width:' + pct + '%"></span></span>' +
          '</header>';
        if (c.note) h += '<p class="tk-listnote">' + esc(c.note) + '</p>';
        if (!open.length) {
          h += '<p class="tk-alldone">All done.</p>';
        } else {
          h += '<ul>';
          open.slice(0, 6).forEach(function (it) {
            h += '<li><label><input type="checkbox" data-check="' + esc(c.id) + '|' + esc(it.id) + '"/>' +
              '<span>' + esc(it.text) + '</span></label>' +
              (it.note ? '<p class="tk-itemnote">' + esc(it.note) + '</p>' : '') + '</li>';
          });
          if (open.length > 6) {
            h += '<li class="tk-more"><a href="#checklists" data-jump="checklists">+ ' +
                 (open.length - 6) + ' more</a></li>';
          }
          h += '</ul>';
        }
        h += '</section>';
      });
      h += '</div></div>';
    }

    // ---- files still missing paperwork ----
    if (files.length) {
      h += '<div class="tk-group"><h3>Files missing paperwork <span>' + files.length + '</span></h3><div class="tk-due">';
      files.slice(0, 12).forEach(function (f) {
        h += '<a class="tk-due-row" href="#' + esc(f.key) + ':' + esc(f.id) + '" data-jump="' + esc(f.key) + ':' + esc(f.id) + '">' +
          '<span class="tk-pip tk-' + esc(FILES[f.key].color) + '"></span>' +
          '<span class="tk-due-main"><strong>' + esc(f.name) + '</strong>' +
          '<small>' + esc(f.missing.slice(0, 3).join(', ')) +
          (f.missing.length > 3 ? ' +' + (f.missing.length - 3) + ' more' : '') + '</small></span>' +
          '<span class="tk-due-meta"><em>' + esc(FILES[f.key].noun) + ' file</em>' + f.done + ' / ' + f.total + '</span>' +
          '<span class="tk-badge tk-' + (f.pct >= 60 ? 'soon' : 'over') + '">' + f.pct + '%</span></a>';
      });
      h += '</div></div>';
    }

    h += group('Later', later);

    if (!items.length && !lists.length && !files.length) {
      h += '<div class="tk-empty"><strong>Nothing to show yet.</strong> ' +
           'Add staff, clients, reminders or a checklist and this page fills itself in.</div>';
    }
    return h;

    function group(label, list) {
      if (!list.length) return '';
      var s = '<div class="tk-group"><h3>' + esc(label) + ' <span>' + list.length + '</span></h3><div class="tk-due">';
      list.forEach(function (i) {
        var b = band(i.days, i.warnAt);
        s += '<a class="tk-due-row" href="#' + esc(i.mod) + '" data-jump="' + esc(i.mod) + '">' +
             '<span class="tk-pip tk-' + esc(i.color) + '"></span>' +
             '<span class="tk-due-main"><strong>' + esc(i.title) + '</strong>' +
             (i.sub ? '<small>' + esc(i.sub) + '</small>' : '') + '</span>' +
             '<span class="tk-due-meta"><em>' + esc(i.what) + '</em>' + fmtDate(i.date) + '</span>' +
             '<span class="tk-badge tk-' + b + '">' + esc(relative(i.days)) + '</span></a>';
      });
      return s + '</div></div>';
    }
  }

  // Anyone whose file still has outstanding documents, worst first.
  function incompleteFiles() {
    var out = [];
    Object.keys(FILES).forEach(function (key) {
      var def = FILES[key];
      Store.all(def.entity).forEach(function (e) {
        if (e.active === false) return;
        var st = fileStats(key, e.id);
        if (!st.total || !st.missing.length) return;
        out.push({ key: key, id: e.id, name: e.name, missing: st.missing,
                   done: st.done, total: st.total, pct: st.pct });
      });
    });
    return out.sort(function (a, b) { return a.pct - b.pct; });
  }

  function statTile(label, n, tone) {
    return '<div class="tk-stat tk-' + tone + '"><span class="n">' + n + '</span><span class="l">' + esc(label) + '</span></div>';
  }

  function openChecklistCount() {
    var n = 0;
    Store.all('checklists').forEach(function (c) {
      (c.items || []).forEach(function (it) { if (!it.done) n++; });
    });
    return n;
  }

  /* -------------------------------------------------------- table renderer */

  var filters = {};   // module -> search string

  function cellValue(col, r) {
    if (col.compute) return col.compute(r);
    var v = r[col.k];
    if (col.type === 'date') return fmtDate(v);
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    return v == null || v === '' ? '—' : v;
  }

  function renderTable(mod) {
    var def = MODULES[mod];
    var q = (filters[mod] || '').toLowerCase();
    var rows = Store.all(mod);

    if (q) {
      rows = rows.filter(function (r) {
        return Object.keys(r).some(function (k) {
          return k.charAt(0) !== '_' && String(r[k] || '').toLowerCase().indexOf(q) >= 0;
        });
      });
    }

    // Dated modules sort by urgency; everything else alphabetically.
    if (def.dueField) {
      rows.sort(function (a, b) {
        var x = daysUntil(a[def.dueField]), y = daysUntil(b[def.dueField]);
        if (x == null) return 1;
        if (y == null) return -1;
        return x - y;
      });
    } else {
      rows.sort(function (a, b) { return String(def.titleOf(a)).localeCompare(String(def.titleOf(b))); });
    }

    var h = moduleHead(mod, def);

    if (!Store.all(mod).length) {
      h += '<div class="tk-empty"><strong>No records yet.</strong> ' +
           esc(def.blurb) + ' Use <em>Add ' + esc(def.short) + '</em> to start.</div>';
      return h;
    }

    h += '<div class="tk-tablewrap"><table class="tk-table"><thead><tr>';
    def.columns.forEach(function (c) {
      h += '<th' + (c.wide ? ' class="wide"' : '') + '>' + esc(c.label) + '</th>';
    });
    h += '<th class="tk-actions-h"><span class="sr">Actions</span></th></tr></thead><tbody>';

    if (!rows.length) {
      h += '<tr><td class="tk-nomatch" colspan="' + (def.columns.length + 1) + '">No records match “' + esc(filters[mod]) + '”.</td></tr>';
    }

    rows.forEach(function (r) {
      var days = def.dueField ? daysUntil(r[def.dueField]) : null;
      var b = band(days, def.warnAt);
      h += '<tr data-id="' + esc(r.id) + '" class="tk-row tk-row-' + b + '">';
      def.columns.forEach(function (c) {
        if (c.type === 'status') {
          h += '<td>' + (days == null ? '<span class="tk-badge tk-none">no date</span>'
                : '<span class="tk-badge tk-' + b + '">' + esc(relative(days)) + '</span>') + '</td>';
        } else {
          h += '<td' + (c.wide ? ' class="wide"' : '') + '>' + esc(cellValue(c, r)) + '</td>';
        }
      });
      h += '<td class="tk-actions">';
      if (def.recurring) h += '<button type="button" class="tk-mini" data-done="' + esc(r.id) + '">Done</button>';
      h += '<button type="button" class="tk-mini" data-edit="' + esc(r.id) + '">Edit</button>' +
           '<button type="button" class="tk-mini tk-danger" data-del="' + esc(r.id) + '">Delete</button>' +
           '</td></tr>';
    });

    return h + '</tbody></table></div>';
  }

  function moduleHead(mod, def) {
    return '<div class="tk-head">' +
      '<div><h2>' + esc(def.label) + '</h2><p class="tk-sub">' + esc(def.blurb) + '</p></div>' +
      '<div class="tk-head-actions">' + syncChip(mod) +
      '<button type="button" class="tk-btn tk-primary" data-add="' + esc(mod) + '">+ Add ' + esc(def.short) + '</button>' +
      '</div></div>' +
      '<div class="tk-toolbar"><label class="tk-search">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' +
      '<input type="search" placeholder="Filter ' + esc(def.label.toLowerCase()) + '…" data-filter="' + esc(mod) + '" value="' + esc(filters[mod] || '') + '"/>' +
      '</label><span class="tk-count">' + Store.all(mod).length + ' record' + (Store.all(mod).length === 1 ? '' : 's') + '</span></div>';
  }

  function syncChip(mod) {
    var scope = Store.scope(mod), st = Store.status(mod);
    var text, cls;
    if (scope === 'local') { text = 'This browser only'; cls = 'local'; }
    else if (st === 'syncing') { text = 'Syncing…'; cls = 'syncing'; }
    else if (st === 'error') { text = 'Sync problem'; cls = 'error'; }
    else { text = 'Shared with staff'; cls = 'ok'; }
    return '<button type="button" class="tk-chip tk-chip-' + cls + '" data-scope="' + esc(mod) + '" ' +
           'title="' + esc(Store.note(mod) || 'Change where this tab stores its data') + '">' + esc(text) + '</button>';
  }

  /* ------------------------------------------------------- training matrix */

  var TRAINING_SHORT = {
    cultural: 'Cultural', vamr: 'VAMR', mandated: 'Mandated rep.', asdsa: 'ASD Strategies',
    eidbi101: 'EIDBI 101', cmdeitp: 'CMDE / ITP', coord: 'Coord. services', telehealth: 'Telehealth'
  };
  var STATUS_LABEL = { none: 'Not started', progress: 'In progress', done: 'Complete' };

  function renderTraining() {
    var staff = Store.all('staff').filter(function (s) { return s.active !== false; })
      .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });

    var h = '<div class="tk-head">' +
      '<div><h2>Staff EIDBI Training</h2>' +
      '<p class="tk-sub">The DHS training list from your onboarding packets. Required trainings are due within ' +
      TRAINING_WINDOW_MONTHS + ' months of the hire date.</p></div>' +
      '<div class="tk-head-actions">' + syncChip('training') +
      '<button type="button" class="tk-btn" data-jump="staff">Manage staff</button></div></div>';

    if (!staff.length) {
      return h + '<div class="tk-empty"><strong>No staff yet.</strong> ' +
        'Add people on the <a href="#staff" data-jump="staff">Staff</a> tab — their role decides which ' +
        'trainings apply, and their hire date sets the deadline.</div>';
    }

    h += '<div class="tk-legend">' +
      '<span><i class="tk-key tk-req"></i>Required</span>' +
      '<span><i class="tk-key tk-rec"></i>Recommended</span>' +
      '<span><i class="tk-key tk-na"></i>Not applicable to the role</span>' +
      '<span class="tk-legend-note">Click any cell to record completion.</span></div>';

    h += '<div class="tk-tablewrap"><table class="tk-table tk-matrix"><thead><tr>' +
      '<th class="wide">Staff</th><th>Role</th><th>Deadline</th>';
    TRAININGS.forEach(function (t) {
      h += '<th class="tk-vert" title="' + esc(t.name + ' — ' + t.via) + '">' + esc(TRAINING_SHORT[t.id] || t.name) + '</th>';
    });
    h += '<th>Required done</th></tr></thead><tbody>';

    staff.forEach(function (s) {
      var sum = trainingSummary(s);
      var due = trainingDue(s);
      var days = due ? daysUntil(due) : null;
      var complete = sum.required && sum.done === sum.required;
      var b = complete ? 'ok' : band(days, 30);

      h += '<tr class="tk-row tk-row-' + (complete ? 'none' : b) + '">' +
        '<td class="wide"><strong>' + esc(s.name) + '</strong></td>' +
        '<td>' + esc(roleLabel(s.role)) + '</td>' +
        '<td>' + (due ? fmtDate(due) + '<br><span class="tk-badge tk-' + (complete ? 'ok' : b) + '">' +
          esc(complete ? 'complete' : relative(days)) + '</span>' : '<span class="tk-badge tk-none">no hire date</span>') + '</td>';

      TRAININGS.forEach(function (t) {
        var need = requirementFor(s, t);
        if (!need) { h += '<td class="tk-cell-na">—</td>'; return; }
        var st = trainingState(s.id, t.id);
        h += '<td><button type="button" class="tk-cell tk-' + need + ' is-' + esc(st.status) + '" ' +
          'data-train="' + esc(s.id) + '|' + esc(t.id) + '" ' +
          'title="' + esc(s.name + ' — ' + t.name + ': ' + (STATUS_LABEL[st.status] || 'Not started') +
            (st.completedDate ? ' (' + fmtDate(st.completedDate) + ')' : '')) + '">' +
          (st.status === 'done' ? '&#10003;' : st.status === 'progress' ? '&#8943;' : '') +
          '</button></td>';
      });

      h += '<td><strong>' + sum.done + ' / ' + sum.required + '</strong></td></tr>';
    });

    return h + '</tbody></table></div>';
  }

  /* ---------------------------------------------------------- file checklists
   * A 25-column matrix would be unusable, and you work one person's file at a
   * time anyway — so this is a roster with completion bars that opens into a
   * single grouped checklist, mirroring the printed form. The open file is
   * held in the hash (#empfiles:<id>) so it survives a repaint and can be
   * linked to from the dashboard.
   */
  function docSet(key, entityId, docId, patch) {
    var rec = fileRec(key, entityId);
    var docs = Object.assign({}, rec.docs || {});
    docs[docId] = Object.assign({ status: 'none', date: '', note: '' }, docs[docId], patch);
    Store.save(key, Object.assign({}, rec, { id: entityId, docs: docs }));
  }

  function renderFiles(key) {
    var def = FILES[key];
    var ents = Store.all(def.entity)
      .filter(function (e) { return e.active !== false; })
      .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });

    var head = '<div class="tk-head"><div><h2>' + esc(def.label) + '</h2>' +
      '<p class="tk-sub">' + esc(def.blurb) + '</p></div>' +
      '<div class="tk-head-actions">' + syncChip(key) +
      '<button type="button" class="tk-btn" data-jump="' + esc(def.entity) + '">Manage ' + esc(def.noun) + 's</button>' +
      '</div></div>';

    if (!ents.length) {
      return head + '<div class="tk-empty"><strong>No ' + esc(def.noun) + 's yet.</strong> ' +
        'Add them on the <a href="#' + esc(def.entity) + '" data-jump="' + esc(def.entity) + '">' +
        esc(MODULES[def.entity].label) + '</a> tab first — each one gets its own file checklist here.</div>';
    }

    // ---- one file open ----
    if (currentId) {
      var ent = Store.get(def.entity, currentId);
      if (!ent) { location.hash = key; return head; }
      var st = fileStats(key, currentId);

      var h = '<a class="page-back" href="#' + esc(key) + '" data-jump="' + esc(key) + '">&larr; All ' + esc(def.noun) + ' files</a>' +
        '<div class="tk-head"><div><h2>' + esc(ent.name) + '</h2>' +
        '<p class="tk-sub">' + esc(def.label) + ' &middot; ' + st.done + ' of ' + st.total + ' on file' +
        (st.na ? ' &middot; ' + st.na + ' not applicable' : '') + '</p></div>' +
        '<div class="tk-head-actions"><span class="tk-badge tk-' + (st.pct === 100 ? 'ok' : st.pct >= 60 ? 'soon' : 'over') + '">' +
        st.pct + '% complete</span></div></div>' +
        '<span class="tk-progress tk-progress-lg"><span style="width:' + st.pct + '%"></span></span>';

      def.docs.forEach(function (g) {
        h += '<div class="tk-group"><h3>' + esc(g.group) + '</h3><div class="tk-docs">';
        g.items.forEach(function (d) {
          var ds = docState(key, currentId, d.id);
          var ref = esc(key + '|' + currentId + '|' + d.id);
          h += '<div class="tk-doc is-' + esc(ds.status) + '">' +
            '<button type="button" class="tk-state" data-cycle="' + ref + '" ' +
              'title="' + esc(FILE_STATES[ds.status] || 'Outstanding') + ' — click to change">' +
              (ds.status === 'yes' ? '&#10003;' : ds.status === 'na' ? '&ndash;' : '') + '</button>' +
            '<span class="tk-doc-name">' + esc(d.name) +
              (d.note ? '<small>' + esc(d.note) + '</small>' : '') + '</span>' +
            '<input type="date" class="tk-doc-date" data-docdate="' + ref + '" value="' + esc(ds.date || '') + '" ' +
              'aria-label="Date for ' + esc(d.name) + '"/>' +
            // One grid cell for the trailing controls, so adding the PDF link
            // does not push the row onto a second line.
            '<span class="tk-doc-acts">' +
              '<button type="button" class="tk-mini tk-notebtn' + (ds.note ? ' has-note' : '') + '" ' +
                'data-docnote="' + ref + '">' + (ds.note ? 'Note' : '+ Note') + '</button>' +
              // Only employee files ever carry a stored PDF; client paperwork is
              // recorded as done and the document itself never comes here.
              (key === 'empfiles' && ds.file && ds.file.id
                ? '<a class="tk-mini tk-docfile" target="_blank" rel="noopener" href="/api/documents?entityId=' +
                  encodeURIComponent(currentId) + '&amp;id=' + encodeURIComponent(ds.file.id) + '">PDF</a>'
                : '') +
            '</span>' +
            (ds.note ? '<p class="tk-itemnote">' + esc(ds.note) + '</p>' : '') +
            '</div>';
        });
        h += '</div></div>';
      });
      return h;
    }

    // ---- roster ----
    var h2 = head + '<div class="tk-filelist">';
    ents.forEach(function (e) {
      var st = fileStats(key, e.id);
      var tone = st.pct === 100 ? 'ok' : st.pct >= 60 ? 'soon' : 'over';
      h2 += '<a class="tk-filerow" href="#' + esc(key) + ':' + esc(e.id) + '" data-jump="' + esc(key) + ':' + esc(e.id) + '">' +
        '<span class="tk-due-main"><strong>' + esc(e.name) + '</strong>' +
        '<small>' + (st.missing.length
            ? esc(st.missing.slice(0, 3).join(', ')) + (st.missing.length > 3 ? ' +' + (st.missing.length - 3) + ' more' : '')
            : 'Complete') + '</small></span>' +
        '<span class="tk-progress"><span style="width:' + st.pct + '%"></span></span>' +
        '<span class="tk-badge tk-' + tone + '">' + st.done + ' / ' + st.total + '</span></a>';
    });
    return h2 + '</div>';
  }

  /* ------------------------------------------------- client supervision UI */

  function supRows() {
    return Store.all('clientsup').sort(function (a, b) {
      // Newest month first, then client name inside a month.
      if (a.month !== b.month) return String(b.month).localeCompare(String(a.month));
      return String(a.client).localeCompare(String(b.client));
    });
  }

  // Months that closed short. This is the number the dashboard leads with.
  function supShortfalls() {
    return supRows().filter(function (r) { return !supOpen(r) && supStats(r).short > 0; });
  }

  function supTone(r) {
    var st = supStats(r);
    if (!st.short) return 'ok';
    return supOpen(r) ? 'soon' : 'over';
  }

  function renderClientSup() {
    var def = SUPS.clientsup;
    var rows = supRows();

    var head = '<div class="tk-head"><div><h2>' + esc(def.label) + '</h2>' +
      '<p class="tk-sub">' + esc(def.blurb) + '</p></div>' +
      '<div class="tk-head-actions">' + syncChip('clientsup') +
      '<button type="button" class="tk-btn" data-suppaste="">Import sessions</button>' +
      '<button type="button" class="tk-btn tk-primary" data-supadd="">+ Month</button>' +
      '</div></div>';

    /* ---------------- one month open: the report ---------------- */
    if (currentSub) {
      var r = Store.get('clientsup', currentSub);
      if (!r) { location.hash = 'clientsup:' + currentId; return head; }
      var st = supStats(r);
      var open = supOpen(r);
      var tone = supTone(r);

      var h = '<a class="page-back" href="#clientsup:' + esc(currentId) + '" data-jump="clientsup:' +
        esc(currentId) + '">&larr; ' + esc(supName(currentId) || 'All clients') + '</a>' +
        '<div class="tk-head"><div><h2>' + esc(r.client || 'Unnamed client') + '</h2>' +
        '<p class="tk-sub">' + esc(monthLabel(r.month)) +
        (r.qsp ? ' &middot; Primary BCBA / QSP ' + esc(r.qsp) : '') +
        (r.location ? ' &middot; ' + esc(r.location === 'Other' && r.locationOther ? r.locationOther : r.location) : '') +
        '</p></div><div class="tk-head-actions">' +
        '<button type="button" class="tk-btn" data-supedit="' + esc(r.id) + '">Edit details</button>' +
        '<button type="button" class="tk-btn tk-x" data-supdel="' + esc(r.id) + '">Delete</button>' +
        '<button type="button" class="tk-btn" data-supprint="1">Print</button>' +
        '<button type="button" class="tk-btn tk-primary" data-sesadd="' + esc(r.id) + '">+ Session</button>' +
        '</div></div>';

      // Required vs provided, stated the way the payer states it.
      h += '<div class="tk-sup-summary">' +
        '<div class="tk-sup-fig"><span class="tk-sup-k">Direct therapy this month</span>' +
          '<strong>' + esc(hm(st.direct)) + '</strong></div>' +
        '<div class="tk-sup-fig"><span class="tk-sup-k">Supervision required</span>' +
          '<strong>' + esc(hm(st.required)) + '</strong>' +
          '<small>1 hr per ' + SUP_RATIO + ' hrs of direct therapy</small></div>' +
        '<div class="tk-sup-fig tk-' + tone + '"><span class="tk-sup-k">Supervision provided</span>' +
          '<strong>' + esc(hm(st.provided)) + '</strong>' +
          '<small>' + (st.short
            ? esc(hm(st.short)) + ' short' + (open ? ' so far' : '')
            : 'Requirement met') + '</small></div>' +
        '</div>' +
        '<span class="tk-progress tk-progress-lg"><span class="tk-' + tone + '" style="width:' + st.pct + '%"></span></span>';

      if (st.short) {
        h += '<p class="tk-note tk-note-warn"><strong>' + esc(hm(st.short)) + ' short.</strong> ' +
          (open
            ? 'This month is still open — ' + esc(monthLabel(r.month)) + ' ends ' + esc(fmtDate(monthEnd(r.month))) + '.'
            : 'This month has closed.') + '</p>';
      }

      h += '<div class="tk-group"><h3>Supervision log <span>' + (r.sessions || []).length + '</span></h3>';
      if (!(r.sessions || []).length) {
        h += '<div class="tk-empty"><strong>No sessions logged.</strong> ' +
          'Add each supervision session as it happens, and the hours provided add up here.</div>';
      } else {
        h += '<div class="tk-tablewrap"><table class="tk-table tk-sup-log"><thead><tr>' +
          '<th>Supervisor</th><th>Date of service</th><th>Type</th>' +
          '<th>Start</th><th>End</th><th>Duration</th><th class="tk-actions-h"></th>' +
          '</tr></thead><tbody>';
        (r.sessions || []).slice().sort(function (a, b) {
          return String(a.date).localeCompare(String(b.date));
        }).forEach(function (s) {
          h += '<tr>' +
            '<td>' + esc(s.supervisor || '—') + '</td>' +
            '<td>' + esc(fmtDate(s.date)) + '</td>' +
            '<td>' + esc(s.code === 'Other' && s.codeOther ? s.codeOther : (s.code || '—')) + '</td>' +
            '<td>' + esc(fmtTime(s.start)) + '</td>' +
            '<td>' + esc(fmtTime(s.end)) + '</td>' +
            '<td>' + esc(hm(minsBetween(s.start, s.end))) + '</td>' +
            '<td class="tk-actions">' +
              '<button type="button" class="tk-mini" data-sesedit="' + esc(r.id + '|' + s.id) + '">Edit</button>' +
              '<button type="button" class="tk-mini tk-x" data-sesdel="' + esc(r.id + '|' + s.id) + '">Remove</button>' +
            '</td></tr>';
        });
        h += '</tbody></table></div>';
      }
      h += '</div>';

      if (r.notes) h += '<p class="tk-listnote">' + esc(r.notes) + '</p>';
      return h;
    }

    /* ---------------- the roster of months ---------------- */
    if (!rows.length) {
      var clients = Store.all('clients').length;
      return head + '<div class="tk-empty"><strong>Nothing logged yet.</strong> ' +
        (clients
          ? 'Add a month for a client and log each supervision session against it.'
          : 'Add clients on the <a href="#clients" data-jump="clients">Clients</a> tab first.') +
        '</div>';
    }

    /* ---------------- one client open: their months ---------------- */
    if (currentId) {
      var who = supName(currentId);
      var mine = rows.filter(function (x) { return (x.client || 'Unnamed client') === who; });

      // An older two-segment link (#clientsup:<recordId>) still resolves.
      if (!mine.length) {
        var legacy = Store.get('clientsup', currentId);
        if (legacy) { location.hash = supHash(legacy); return head; }
      }

      var roll = supRollup(mine);
      var h1 = '<a class="page-back" href="#clientsup" data-jump="clientsup">&larr; All clients</a>' +
        '<div class="tk-head"><div><h2>' + esc(who) + '</h2>' +
        '<p class="tk-sub">' + mine.length + ' month' + (mine.length === 1 ? '' : 's') +
        ' &middot; ' + esc(hm(roll.provided)) + ' provided of ' + esc(hm(roll.required)) + ' required' +
        (roll.closedShort ? ' &middot; ' + roll.closedShort + ' closed short' : '') +
        '</p></div><div class="tk-head-actions">' +
        '<button type="button" class="tk-btn" data-suppaste="' + esc(who) + '">Import sessions</button>' +
        '<button type="button" class="tk-btn tk-primary" data-supadd="' + esc(who) + '">+ Month</button>' +
        '</div></div>';

      if (!mine.length) {
        return h1 + '<div class="tk-empty"><strong>No supervision months for ' + esc(who) + ' yet.</strong> ' +
          'Add one, then log that month\u2019s sessions inside it.</div>';
      }

      h1 += '<div class="tk-filelist">';
      mine.forEach(function (r) { h1 += supMonthRow(r); });
      return h1 + '</div>';
    }

    /* ---------------- every client, exactly once ---------------- */
    var people = supClients();
    var short = supShortfalls().length;
    var h2 = head;
    if (short) {
      h2 += '<p class="tk-note tk-note-warn"><strong>' + short + ' closed month' +
        (short === 1 ? '' : 's') + ' ended short of the supervision requirement.</strong> ' +
        'Open the client to see which.</p>';
    }

    if (!people.length) {
      return h2 + '<div class="tk-empty"><strong>No clients yet.</strong> ' +
        'Add them on the <a href="#clients" data-jump="clients">Clients</a> tab, ' +
        'then give each one a supervision month.</div>';
    }

    /* One person listed twice, almost always because the roster and an export
     * spell them differently. Suggested, never applied automatically: two
     * names one letter apart can be two real children. */
    supDuplicates().forEach(function (d) {
      h2 += '<p class="tk-note tk-note-warn"><strong>' + esc(d.keep) + '</strong> and ' +
        '<strong>' + esc(d.drop) + '</strong> ' +
        (d.how === 'same'
          ? 'are the same name written two ways.'
          : 'are one small spelling difference apart, so they are listed separately.') +
        ' Supervision months are filed under the client&rsquo;s name, so a different spelling ' +
        'in an import makes a second entry.' +
        (d.bothOnRoster ? ' Both are on the client roster.' : '') +
        ' <button type="button" class="tk-mini" data-supmerge="' +
        esc(supKey(d.drop)) + '|' + esc(supKey(d.keep)) + '">Merge into ' + esc(d.keep) + '</button>' +
        ' <button type="button" class="tk-mini" data-supdistinct="' + esc(supKey(d.drop)) +
        '">They are different people</button></p>';
    });

    h2 += '<div class="tk-filelist">';
    people.forEach(function (c) {
      var roll = supRollup(c.rows);
      var tone = roll.closedShort ? 'over' : (roll.required && roll.pct < 100 ? 'soon' : 'ok');
      var note = !c.rows.length ? 'No supervision months yet'
        : c.rows.length + ' month' + (c.rows.length === 1 ? '' : 's') +
          (roll.closedShort ? ' \u00b7 ' + hm(roll.short) + ' short across ' + roll.closedShort + ' closed'
                            : ' \u00b7 requirement met');
      h2 += '<a class="tk-filerow" href="#clientsup:' + esc(supKey(c.name)) + '" ' +
        'data-jump="clientsup:' + esc(supKey(c.name)) + '">' +
        '<span class="tk-due-main"><strong>' + esc(c.name) + '</strong>' +
        '<small>' + esc(note) + '</small></span>' +
        '<span class="tk-progress"><span class="tk-' + tone + '" style="width:' + roll.pct + '%"></span></span>' +
        '<span class="tk-badge tk-' + tone + '">' +
        (c.rows.length ? esc(hm(roll.provided)) + ' / ' + esc(hm(roll.required)) : '\u2014') +
        '</span></a>';
    });
    return h2 + '</div>';
  }

  // One month row, used inside a client. Unchanged from the flat list it
  // replaced, except that the link now carries the client segment.
  function supMonthRow(r) {
    var st = supStats(r);
    var tone = supTone(r);
    var note = st.short
      ? hm(st.short) + ' short' + (supOpen(r) ? ' \u2014 month still open' : '')
      : 'Requirement met';
    return '<a class="tk-filerow" href="#' + esc(supHash(r)) + '" data-jump="' + esc(supHash(r)) + '">' +
      '<span class="tk-due-main"><strong>' + esc(monthLabel(r.month)) + '</strong>' +
      '<small>' + esc(note) + '</small></span>' +
      '<span class="tk-progress"><span class="tk-' + tone + '" style="width:' + st.pct + '%"></span></span>' +
      '<span class="tk-badge tk-' + tone + '">' + esc(hm(st.provided)) + ' / ' + esc(hm(st.required)) + '</span></a>';
  }

  /* ---- editors ---- */

  function openSupEditor(id, presetClient) {
    var rec = id ? Store.get('clientsup', id) : null;
    var clients = Store.all('clients').map(function (c) { return c.name; }).sort();
    var staff = Store.all('staff').map(function (s) { return s.name; }).sort();

    function sel(name, label, opts, val, req) {
      var s = '<div class="tk-f"><label for="f_' + name + '">' + esc(label) +
        (req ? ' <em>*</em>' : '') + '</label><select id="f_' + name + '" name="' + name + '"><option value="">—</option>';
      var list = opts.slice();
      if (val && list.indexOf(val) < 0) list.push(val);
      list.forEach(function (o) {
        s += '<option value="' + esc(o) + '"' + (String(val) === String(o) ? ' selected' : '') + '>' + esc(o) + '</option>';
      });
      return s + '</select></div>';
    }

    var d = rec ? Math.max(0, +rec.directMin || 0) : 0;
    var body = '<div class="tk-form-grid">' +
      sel('client', 'Client', clients, rec ? rec.client : (presetClient || ''), true) +
      '<div class="tk-f"><label for="f_month">Month <em>*</em></label>' +
        '<input type="month" id="f_month" name="month" required value="' +
        esc(rec ? rec.month : thisMonth()) + '"/></div>' +
      sel('qsp', 'Primary BCBA / QSP', staff, rec ? rec.qsp : '') +
      sel('location', 'Primary service location', SUP_LOCATIONS, rec ? rec.location : '') +
      '<div class="tk-f"><label for="f_locationOther">If other</label>' +
        '<input type="text" id="f_locationOther" name="locationOther" value="' +
        esc(rec ? rec.locationOther : '') + '"/></div>' +
      '<div class="tk-f"><label for="f_dh">Direct therapy hours</label>' +
        '<input type="number" id="f_dh" name="dh" min="0" step="1" value="' + Math.floor(d / 60) + '"/></div>' +
      '<div class="tk-f"><label for="f_dm">…and minutes</label>' +
        '<input type="number" id="f_dm" name="dm" min="0" max="59" step="1" value="' + (d % 60) + '"/></div>' +
      '<div class="tk-f tk-f-wide"><label for="f_notes">Notes</label>' +
        '<textarea id="f_notes" name="notes" rows="3">' + esc(rec ? rec.notes : '') + '</textarea></div>' +
      '</div>' +
      '<p class="tk-modal-note">Required supervision is calculated for you: 1 hour per ' + SUP_RATIO +
      ' hours of direct therapy.</p>';

    showModal((id ? 'Edit ' : 'Add ') + 'supervision month', body, function (form) {
      var client = form.elements.client.value.trim();
      var month = form.elements.month.value.trim();
      if (!client) return 'Please choose a client.';
      if (!/^\d{4}-\d{2}$/.test(month)) return 'Please choose a month.';

      // One record per client per month, so the totals cannot end up split
      // across two rows that each look compliant on their own.
      var clash = null;
      Store.all('clientsup').forEach(function (x) {
        if (x.client === client && x.month === month && x.id !== (rec && rec.id)) clash = x;
      });
      if (clash) return 'There is already a ' + monthLabel(month) + ' record for ' + client + '.';

      var next = rec ? Object.assign({}, rec) : { id: uid(), sessions: [] };
      next.client = client;
      next.month = month;
      next.qsp = form.elements.qsp.value.trim();
      next.location = form.elements.location.value.trim();
      next.locationOther = form.elements.locationOther.value.trim();
      next.notes = form.elements.notes.value.trim();
      next.directMin = Math.max(0, (+form.elements.dh.value || 0) * 60 + (+form.elements.dm.value || 0));
      Store.save('clientsup', next);
      flash('Supervision month saved.');
      if (!id) location.hash = supHash(next);
      return true;
    });
  }

  /* -------------------------------------------------------- bulk paste
   * A busy month is tedious one session at a time, so this takes a paste from
   * a spreadsheet, a CSV, or loose text. Nothing is written until the parsed
   * preview has been seen: rows that cannot be read, or that fall outside the
   * month, are shown as rejected rather than quietly dropped.
   */
  function pIsoFrom(y, m, d) {
    if (!(m >= 1 && m <= 12)) return '';
    var last = new Date(y, m, 0).getDate();
    if (!(d >= 1 && d <= last)) return '';
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  var P_MON = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

  function pDate(tok, month, allowBareDay) {
    tok = String(tok == null ? '' : tok).trim();
    if (!tok) return '';
    var mp = /^(\d{4})-(\d{2})$/.exec(month || '');
    var defY = mp ? +mp[1] : new Date().getFullYear();
    var defM = mp ? +mp[2] : new Date().getMonth() + 1;
    var m;
    if ((m = tok.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/))) return pIsoFrom(+m[1], +m[2], +m[3]);
    if ((m = tok.match(/^(\d{1,2})[-\/](\d{1,2})(?:[-\/](\d{2,4}))?$/))) {
      var y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : defY;
      return pIsoFrom(y, +m[1], +m[2]);
    }
    if ((m = tok.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?$/i))) {
      var mi = P_MON.indexOf(m[1].slice(0, 3).toLowerCase());
      if (mi >= 0) return pIsoFrom(m[3] ? +m[3] : defY, mi + 1, +m[2]);
    }
    if ((m = tok.match(/^(\d{1,2})\s+([a-z]{3,9})\.?(?:,?\s*(\d{4}))?$/i))) {
      var mj = P_MON.indexOf(m[2].slice(0, 3).toLowerCase());
      if (mj >= 0) return pIsoFrom(m[3] ? +m[3] : defY, mj + 1, +m[1]);
    }
    // A bare day number is only a date when a header said the column is one.
    if (allowBareDay && (m = tok.match(/^(\d{1,2})$/))) return pIsoFrom(defY, defM, +m[1]);
    return '';
  }

  // "9", "9:30", "9am", "2:30 PM" -> "HH:MM", matching <input type="time">.
  function pClock(tok) {
    var t = String(tok == null ? '' : tok).trim().toLowerCase().replace(/\s+/g, '').replace(/\./g, '');
    var m = t.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
    if (!m) return '';
    var h = +m[1], mm = m[2] ? +m[2] : 0;
    if (mm > 59) return '';
    if (m[3]) {
      if (h < 1 || h > 12) return '';
      if (m[3] === 'pm' && h !== 12) h += 12;
      if (m[3] === 'am' && h === 12) h = 0;
    } else if (h > 23) return '';
    return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }


  /* Reads a pasted supervision export. Two shapes are handled:
   *   - stacked: one field per line, which is what copying an HTML table
   *     gives you. Records are found by anchoring on the two adjacent date
   *     lines (start date / end date), so a row missing its optional city and
   *     address does not throw the rest of the paste out of alignment.
   *   - delimited: tab or comma separated, one record per line.
   * Rows are NOT restricted to a single month — each is filed by its own date.
   */
  function pDur(t) {
    return /^\s*\d+\s*h(\s*\d+\s*m)?\s*$|^\s*\d+\s*m(in)?s?\s*$/i.test(String(t || ''));
  }
  function pCode(t) {
    return /^\s*(h\d{4}|\d{5})\s*$/i.test(String(t || ''));
  }

  // client, team member, start date, end date, start time, end time, then a
  // variable tail: [duration] location [city] [address] [note] [billing code]

  /* A real CSV: quoted fields, embedded commas and newlines, doubled quotes.
   * The session exports quote the address, which contains commas, so a plain
   * split(",") silently shifts every column after it. */
  function csvSplit(text) {
    var rows = [], row = [], field = '', inQ = false, i = 0, c;
    text = String(text || '').replace(/\r\n?/g, '\n');
    for (; i < text.length; i++) {
      c = text.charAt(i);
      if (inQ) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.join('').trim(); });
  }

  function tsvSplit(text) {
    return String(text || '').split(/\r?\n/)
      .filter(function (l) { return l.trim(); })
      .map(function (l) { return l.split('\t'); });
  }

  // Column names differ between exports; match on meaning, not position.
  var HEAD_MAP = [
    ['client',    /^(client|client ?name|participant|recipient|patient)$/],
    ['supervisor',/^(team ?_?member|staff|provider|therapist|supervisor|clinician|rendering)/],
    ['note',      /^(session ?_?note ?_?name|note ?_?name|note|service|description)$/],
    ['date',      /^(session ?_?start ?_?date|start ?_?date|date ?of ?service|service ?date|date)$/],
    ['endDate',   /^(session ?_?end ?_?date|end ?_?date)$/],
    ['start',     /^(session ?_?start ?_?time|start ?_?time|start|time ?in)$/],
    ['end',       /^(session ?_?end ?_?time|end ?_?time|end|time ?out)$/],
    ['duration',  /^(session ?_?duration|duration|hours|length|units|total)$/],
    ['location',  /^(session ?_?location ?_?type|location ?_?type|location|place|setting)$/],
    ['city',      /^(session ?_?location ?_?city|location ?_?city|city)$/],
    ['address',   /^(location ?_?address|address|street)$/],
    ['code',      /^(billing ?_?code|billing ?code|code|cpt|procedure)$/]
  ];

  function mapHeader(cells) {
    var map = {}, hits = 0;
    cells.forEach(function (raw, i) {
      var h = String(raw || '').trim().toLowerCase().replace(/[_\s]+/g, ' ');
      for (var k = 0; k < HEAD_MAP.length; k++) {
        if (map[HEAD_MAP[k][0]] != null) continue;
        if (HEAD_MAP[k][1].test(h)) { map[HEAD_MAP[k][0]] = i; hits++; return; }
      }
    });
    // A header needs at least a date and one other known column to be trusted.
    return (map.date != null && hits >= 3) ? map : null;
  }

  // "9:07 AM (CST)" -> "09:07". The trailing zone is display only.
  function pClockLoose(t) {
    return pClock(String(t || '').replace(/\([^)]*\)/g, '').replace(/\b[A-Z]{2,4}T\b/g, ''));
  }

  // "8.00" or "7.82" decimal hours; "1h 15m"; "45m".
  function pDurMins(t) {
    var v = String(t == null ? '' : t).trim();
    if (!v) return 0;
    var m = v.match(/^(\d+)\s*h(?:\s*(\d+)\s*m)?$/i);
    if (m) return (+m[1]) * 60 + (m[2] ? +m[2] : 0);
    m = v.match(/^(\d+)\s*m(?:in)?s?$/i);
    if (m) return +m[1];
    m = v.match(/^(\d+(?:\.\d+)?)$/);
    if (m) return Math.round(parseFloat(m[1]) * 60);
    return 0;
  }

  function classify(row) {
    var code = String(row.code || '').trim().toUpperCase();
    // "Direct (97153)" carries the code too; the explicit column wins, but a
    // disagreement is worth surfacing rather than silently resolving.
    var inNote = (String(row.note || '').match(/\(([A-Z]?\d{4,5})\)/i) || [])[1];
    if (inNote) inNote = inNote.toUpperCase();
    if (!code && inNote) code = inNote;
    row.code = code;
    row.mismatch = !!(inNote && code && inNote !== code);

    if (!code) { row.kind = 'sup'; return; }          // hand-typed supervision paste
    if (SUP_CODES.indexOf(code) >= 0) { row.kind = 'sup'; return; }
    if (DIRECT_CODES.indexOf(code) >= 0) { row.kind = 'direct'; return; }
    row.kind = 'skip';
    row.why = 'code ' + code + ' is neither supervision nor direct therapy';
  }

  function finishRow(row) {
    if (!row.date) row.why = row.why || 'no date found';
    else if (row.start && row.end && !minsBetween(row.start, row.end)) row.why = row.why || 'end is not after start';
    else if (!row.start || !row.end) {
      // No usable clock: fall back to the declared duration.
      if (!row.declared) row.why = row.why || 'need a start and an end time';
    }
    row.mins = row.why ? 0
      : (row.start && row.end ? minsBetween(row.start, row.end) : row.declared);
    if (!row.why && !row.mins) row.why = 'zero length';
    row.ok = !row.why;
    row.month = row.date ? row.date.slice(0, 7) : '';
    if (row.code === 'Other' || (row.code && SUP_CODES.indexOf(row.code) < 0 && row.kind === 'sup')) {
      row.codeOther = row.note || row.code;
      row.code = 'Other';
    }
    return row;
  }

  function rowFromMap(cells, map) {
    var g = function (k) { return map[k] == null ? '' : String(cells[map[k]] || '').trim(); };
    var row = {
      client: g('client'), supervisor: g('supervisor'), note: g('note'),
      date: pDate(g('date'), '', false),
      start: pClockLoose(g('start')), end: pClockLoose(g('end')),
      declared: pDurMins(g('duration')),
      location: g('location'), city: g('city'), address: g('address'),
      code: g('code'), codeOther: '', why: ''
    };
    classify(row);
    return finishRow(row);
  }

  // Positional fallback: client, team member, start date, end date, start,
  // end, then a variable tail.
  function supRowFromFields(f) {
    var row = { client: f[0] || '', supervisor: f[1] || '', note: '',
                date: pDate(f[2], '', false), start: pClock(f[4]), end: pClock(f[5]),
                declared: 0, location: '', city: '', address: '', code: '', codeOther: '', why: '' };
    var tail = f.slice(6).filter(function (x) { return String(x || '').trim(); });
    if (tail.length && pDur(tail[0])) { row.declared = pDurMins(tail[0]); tail.shift(); }
    if (tail.length && pCode(tail[tail.length - 1])) row.code = tail.pop().trim().toUpperCase();
    if (tail.length) row.note = tail.pop().trim();
    if (tail.length) row.location = tail.shift().trim();
    if (tail.length) row.city = tail.shift().trim();
    if (tail.length) row.address = tail.join(', ').trim();
    classify(row);
    return finishRow(row);
  }

  function parseSupPaste(text) {
    var raw = String(text || '');
    if (!raw.trim()) return [];

    // 1. Delimited with a header we recognise — the most reliable shape.
    var grids = [];
    if (raw.indexOf('\t') >= 0) grids.push(tsvSplit(raw));
    if (raw.indexOf(',') >= 0) grids.push(csvSplit(raw));
    for (var g = 0; g < grids.length; g++) {
      var grid = grids[g];
      if (grid.length < 2) continue;
      var map = mapHeader(grid[0]);
      if (map) {
        return grid.slice(1)
          .filter(function (r) { return r.join('').trim(); })
          .map(function (r) { return rowFromMap(r, map); });
      }
    }

    // 2. Stacked: one field per line. Records are found by anchoring on the
    // two adjacent date lines, so a row missing optional fields does not push
    // everything after it out of alignment.
    var lines = raw.split(/\r?\n/)
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l; });
    var isD = function (l) { return !!pDate(l, '', false); };
    var starts = [];
    for (var i = 2; i + 1 < lines.length; i++) {
      if (isD(lines[i]) && isD(lines[i + 1])) starts.push(i - 2);
    }
    if (starts.length) {
      return starts.map(function (st, n) {
        var end = n + 1 < starts.length ? starts[n + 1] : lines.length;
        return supRowFromFields(lines.slice(st, end));
      });
    }

    // 3. Delimited without a usable header, read positionally.
    var flat = grids.length ? grids[grids.length - 1] : [];
    if (flat.length) {
      if (flat.length > 1 && !pDate(flat[0][2], '', false) && /date/i.test(flat[0].join(' '))) flat = flat.slice(1);
      return flat.map(function (r) { return supRowFromFields(r); });
    }
    return [];
  }


  function openSupPaste(presetClient) {
    var parsed = [];

    // Spellings corrected in the preview before importing. Held here rather
    // than rewritten into the pasted text, because the name can appear in
    // several columns and a blind find-and-replace would hit the wrong ones.
    var rename = {};
    function clientOf(r) {
      var nm = r.client || presetClient || '';
      return rename[nm] || nm;
    }

    var body = '<div class="tk-paste">' +
      '<p class="tk-modal-note">Paste or drop a session export \u2014 any number of clients, any ' +
      'number of months. Supervision (' + SUP_CODES.slice(0, 3).join(', ') + ') becomes sessions. ' +
      'Direct intervention (' + DIRECT_CODES.join(', ') + ') is totalled into each month\u2019s direct ' +
      'therapy hours, which is what sets the supervision requirement.</p>' +
      '<div class="tk-droprow">' +
      '<button type="button" class="tk-btn" id="tk-sup-pick">Choose a file\u2026</button>' +
      '<span class="tk-hint" id="tk-sup-fname">\u2026 or paste below, or drag a CSV onto the box.</span>' +
      '<input type="file" id="tk-sup-file" accept=".csv,.tsv,.txt,text/csv,text/plain" hidden/>' +
      '</div>' +
      '<textarea id="tk-sup-in" spellcheck="false" placeholder="Paste a CSV, a spreadsheet ' +
      'selection, or the table copied straight off the screen."></textarea>' +
      '<p class="tk-hint">Columns are matched by name when there is a header row, so column order ' +
      'does not matter. Quoted addresses containing commas are handled. Times may carry a zone, ' +
      'like 9:07 AM (CST). Length is taken from the clock, falling back to a duration column.</p>' +
      '<div id="tk-sup-preview"></div></div>';

    showModal('Import sessions', body, function () {
      var usable = parsed.filter(function (r) { return r.ok && (r.client || presetClient); });
      if (!usable.length) return 'Nothing to import yet \u2014 paste or choose a file above.';

      var groups = {}, order = [];
      usable.forEach(function (r) {
        var key = clientOf(r) + '\u0000' + r.month;
        if (!groups[key]) { groups[key] = []; order.push(key); }
        groups[key].push(r);
      });

      var added = 0, skipped = 0, created = 0, directMonths = 0;
      order.forEach(function (key) {
        var bits = key.split('\u0000'), client = bits[0], month = bits[1];
        var rows = groups[key];

        var rec = null;
        Store.all('clientsup').forEach(function (x) {
          if (x.client === client && x.month === month) rec = x;
        });
        var isNew = !rec;
        var next = rec ? Object.assign({}, rec)
                       : { id: uid(), client: client, month: month, sessions: [], directMin: 0 };
        next.sessions = (next.sessions || []).slice();
        next.directLog = (next.directLog || []).slice();

        // Re-importing an overlapping range must not double-count either side.
        var seenSes = {};
        next.sessions.forEach(function (x) { seenSes[x.date + '|' + x.start + '|' + x.end] = 1; });
        var seenDir = {};
        next.directLog.forEach(function (x) { seenDir[x.date + '|' + x.start + '|' + x.end] = 1; });

        var touchedDirect = false;
        rows.forEach(function (r) {
          var k = r.date + '|' + r.start + '|' + r.end;
          if (r.kind === 'direct') {
            if (seenDir[k]) { skipped++; return; }
            seenDir[k] = 1;
            next.directLog.push({ date: r.date, start: r.start, end: r.end,
                                  mins: r.mins, staff: r.supervisor });
            touchedDirect = true;
          } else {
            if (seenSes[k]) { skipped++; return; }
            seenSes[k] = 1;
            next.sessions.push({ id: uid(), supervisor: r.supervisor, date: r.date,
                                 code: r.code, codeOther: r.codeOther, start: r.start, end: r.end });
            added++;
          }
        });

        // Direct therapy is derived from the log, so it stays correct across
        // repeated imports. A month with no imported direct rows keeps
        // whatever was entered by hand.
        if (next.directLog.length) {
          next.directMin = next.directLog.reduce(function (n, x) { return n + (+x.mins || 0); }, 0);
          if (touchedDirect) directMonths++;
        }

        if (isNew) {
          created++;
          var tally = {}, best = '', bestN = 0;
          rows.forEach(function (r) {
            if (!r.location) return;
            tally[r.location] = (tally[r.location] || 0) + 1;
            if (tally[r.location] > bestN) { bestN = tally[r.location]; best = r.location; }
          });
          if (best) {
            if (SUP_LOCATIONS.indexOf(best) >= 0) next.location = best;
            else { next.location = 'Other'; next.locationOther = best; }
          }
          var sup = rows.filter(function (r) { return r.kind === 'sup' && r.supervisor; })[0];
          if (sup) next.qsp = sup.supervisor;
        }

        Store.save('clientsup', next);
      });

      flash('Imported ' + added + ' supervision session' + (added === 1 ? '' : 's') +
        (directMonths ? ' \u00b7 direct therapy set for ' + directMonths + ' month' + (directMonths === 1 ? '' : 's') : '') +
        (created ? ' \u00b7 ' + created + ' new month' + (created === 1 ? '' : 's') : '') +
        (skipped ? ' \u00b7 ' + skipped + ' already logged' : '') + '.');
      return true;
    }, 'Import');

    var ta = document.getElementById('tk-sup-in');
    var pv = document.getElementById('tk-sup-preview');
    var file = document.getElementById('tk-sup-file');
    var pick = document.getElementById('tk-sup-pick');
    var fname = document.getElementById('tk-sup-fname');
    var okBtn = modal.querySelector('.tk-ok');
    var roster = {};
    Store.all('clients').forEach(function (c) { roster[c.name] = 1; });

    function load(f) {
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        ta.value = String(fr.result || '');
        fname.textContent = f.name;
        refresh();
      };
      fr.onerror = function () { flash('That file could not be read.', true); };
      fr.readAsText(f);
    }

    pick.addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () { load(file.files && file.files[0]); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      ta.addEventListener(ev, function (e) { e.preventDefault(); ta.classList.add('drop'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      ta.addEventListener(ev, function (e) { e.preventDefault(); ta.classList.remove('drop'); });
    });
    ta.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) load(f);
    });

    function refresh() {
      parsed = parseSupPaste(ta.value);
      var usable = parsed.filter(function (r) { return r.ok; });
      var sup = usable.filter(function (r) { return r.kind === 'sup'; });
      var dir = usable.filter(function (r) { return r.kind === 'direct'; });
      okBtn.textContent = usable.length ? 'Import ' + usable.length : 'Import';
      if (!parsed.length) { pv.innerHTML = ''; return; }

      var order = [], byKey = {};
      usable.forEach(function (r) {
        var key = (clientOf(r) || '(no client)') + '\u0000' + r.month;
        if (!byKey[key]) { byKey[key] = []; order.push(key); }
        byKey[key].push(r);
      });
      order.sort();

      var h = '<div class="tk-preview"><table><thead><tr>' +
        '<th>Date</th><th>Who</th><th>Type</th><th>Time</th><th>Length</th></tr></thead><tbody>';

      order.forEach(function (key) {
        var bits = key.split('\u0000'), rows = byKey[key];
        var gs = rows.filter(function (r) { return r.kind === 'sup'; });
        var gd = rows.filter(function (r) { return r.kind === 'direct'; });
        var sMin = gs.reduce(function (n, r) { return n + r.mins; }, 0);
        var dMin = gd.reduce(function (n, r) { return n + r.mins; }, 0);
        var req = Math.round(dMin / SUP_RATIO);

        h += '<tr class="grp"><td colspan="5"><strong>' + esc(bits[0]) + '</strong> \u00b7 ' +
          esc(monthLabel(bits[1]));
        if (gd.length) {
          h += ' \u00b7 direct ' + esc(hm(dMin)) + ' (' + gd.length + ' session' +
               (gd.length === 1 ? '' : 's') + ') \u2192 requires ' + esc(hm(req));
        }
        if (gs.length) h += ' \u00b7 supervision ' + esc(hm(sMin));
        if (gs.length && gd.length) {
          h += req && sMin >= req ? ' \u2713' : ' \u2014 ' + esc(hm(Math.max(0, req - sMin))) + ' short';
        }
        h += '</td></tr>';

        // Supervision rows are few and worth checking one by one. Direct rows
        // run to hundreds, so they are summarised above instead.
        gs.sort(function (x, y) {
          return x.date.localeCompare(y.date) || String(x.start).localeCompare(String(y.start));
        });
        gs.forEach(function (r) {
          h += '<tr><td class="k">' + esc(fmtDate(r.date)) + '</td>' +
            '<td>' + esc(r.supervisor || '\u2014') + '</td>' +
            '<td>' + esc(r.code === 'Other' ? (r.codeOther || 'Other') : (r.code || '\u2014')) +
            (r.mismatch ? ' <strong>?</strong>' : '') + '</td>' +
            '<td>' + esc(fmtTime(r.start)) + '\u2013' + esc(fmtTime(r.end)) + '</td>' +
            '<td>' + esc(hm(r.mins)) + '</td></tr>';
        });
      });

      var bad = parsed.filter(function (r) { return !r.ok; });
      bad.slice(0, 8).forEach(function (r) {
        h += '<tr class="bad"><td colspan="5">' + esc(r.why) + ' \u2014 ' +
          esc(((r.client || '') + ' ' + (r.date || '')).trim().slice(0, 70)) + '</td></tr>';
      });
      h += '</tbody></table></div>';

      var months = {};
      usable.forEach(function (r) { months[r.month] = 1; });
      var nM = Object.keys(months).length;
      var unknown = {};
      usable.forEach(function (r) {
        var nm = clientOf(r);
        if (nm && !roster[nm]) unknown[nm] = 1;
      });
      var nU = Object.keys(unknown).length;
      var mism = usable.filter(function (r) { return r.mismatch; }).length;

      h += '<p class="tk-hint">' + sup.length + ' supervision session' + (sup.length === 1 ? '' : 's') +
        ' and ' + dir.length + ' direct session' + (dir.length === 1 ? '' : 's') +
        ' across ' + nM + ' month' + (nM === 1 ? '' : 's') + '.' +
        (bad.length > 8 ? ' ' + (bad.length - 8) + ' further row(s) could not be read.' : '') +
        (mism ? ' <strong>' + mism + '</strong> row(s) marked ? have a note name that disagrees with the' +
                ' billing code \u2014 the billing code is used.' : '') +
        (nU ? ' <strong>' + esc(Object.keys(unknown).join(', ')) + '</strong> ' +
              (nU === 1 ? 'is' : 'are') + ' not on the client roster yet \u2014 the months are still created.' : '') +
        '</p>';

      /* A name that is not on the roster but is one letter from someone who
       * is: that is where duplicate clients come from. Offer the roster
       * spelling BEFORE importing, since fixing it here costs a click and
       * fixing it afterwards means merging records. */
      var rosterNames = Object.keys(roster);
      var nudges = [];
      Object.keys(unknown).forEach(function (nm) {
        rosterNames.forEach(function (rn) {
          if (nameLikeness(nm, rn)) nudges.push({ from: nm, to: rn });
        });
      });
      if (nudges.length) {
        h += '<p class="tk-note tk-note-warn"><strong>Check these spellings first.</strong> ';
        nudges.forEach(function (n) {
          h += '<span class="tk-nudge">&ldquo;' + esc(n.from) + '&rdquo; is not on the roster but ' +
            '<strong>' + esc(n.to) + '</strong> is. ' +
            '<button type="button" class="tk-mini" data-supfix="' +
            esc(supKey(n.from)) + '|' + esc(supKey(n.to)) + '">Use ' + esc(n.to) + '</button></span> ';
        });
        h += 'Importing as-is creates a second client.</p>';
      }
      pv.innerHTML = h;
    }

    // The preview is rebuilt on every keystroke, so the spelling-fix buttons
    // are delegated rather than bound to each rendering.
    pv.addEventListener('click', function (e) {
      var b = e.target.closest('[data-supfix]');
      if (!b) return;
      var bits = b.dataset.supfix.split('|');
      rename[supName(bits[0])] = supName(bits[1]);
      refresh();
    });

    ta.addEventListener('input', refresh);
    ta.addEventListener('paste', function () { setTimeout(refresh, 0); });
  }


  function openSessionEditor(recId, sesId) {
    var rec = Store.get('clientsup', recId);
    if (!rec) return;
    var ses = (rec.sessions || []).filter(function (s) { return s.id === sesId; })[0] || null;
    var staff = Store.all('staff').map(function (s) { return s.name; }).sort();

    function sel(name, label, opts, val) {
      var s = '<div class="tk-f"><label for="f_' + name + '">' + esc(label) +
        '</label><select id="f_' + name + '" name="' + name + '"><option value="">—</option>';
      var list = opts.slice();
      if (val && list.indexOf(val) < 0) list.push(val);
      list.forEach(function (o) {
        s += '<option value="' + esc(o) + '"' + (String(val) === String(o) ? ' selected' : '') + '>' + esc(o) + '</option>';
      });
      return s + '</select></div>';
    }

    var body = '<div class="tk-form-grid">' +
      sel('supervisor', 'Supervisor', staff, ses ? ses.supervisor : (rec.qsp || '')) +
      '<div class="tk-f"><label for="f_date">Date of service <em>*</em></label>' +
        '<input type="date" id="f_date" name="date" required value="' + esc(ses ? ses.date : '') + '"/></div>' +
      sel('code', 'Supervision type', SUP_CODES, ses ? ses.code : '') +
      '<div class="tk-f"><label for="f_codeOther">If other</label>' +
        '<input type="text" id="f_codeOther" name="codeOther" value="' + esc(ses ? ses.codeOther : '') + '"/></div>' +
      '<div class="tk-f"><label for="f_start">Start time <em>*</em></label>' +
        '<input type="time" id="f_start" name="start" required value="' + esc(ses ? ses.start : '') + '"/></div>' +
      '<div class="tk-f"><label for="f_end">End time <em>*</em></label>' +
        '<input type="time" id="f_end" name="end" required value="' + esc(ses ? ses.end : '') + '"/></div>' +
      '</div>';

    showModal((ses ? 'Edit ' : 'Add ') + 'supervision session', body, function (form) {
      var date = form.elements.date.value.trim();
      var start = form.elements.start.value.trim();
      var end = form.elements.end.value.trim();
      if (!date) return 'Please enter the date of service.';
      if (!start || !end) return 'Please enter both a start and an end time.';
      if (!minsBetween(start, end)) return 'The end time needs to be after the start time.';

      // A session dated outside the month it is filed under would quietly
      // inflate that month's total.
      if (date < monthStart(rec.month) || date > monthEnd(rec.month)) {
        return 'That date falls outside ' + monthLabel(rec.month) + '.';
      }

      var next = Object.assign({}, rec);
      next.sessions = (rec.sessions || []).slice();
      var row = {
        id: ses ? ses.id : uid(),
        supervisor: form.elements.supervisor.value.trim(),
        date: date,
        code: form.elements.code.value.trim(),
        codeOther: form.elements.codeOther.value.trim(),
        start: start, end: end
      };
      var at = -1;
      next.sessions.forEach(function (s, i) { if (s.id === row.id) at = i; });
      if (at < 0) next.sessions.push(row); else next.sessions[at] = row;

      Store.save('clientsup', next);
      flash('Session saved.');
      return true;
    });
  }

  function removeSession(recId, sesId) {
    var rec = Store.get('clientsup', recId);
    if (!rec) return;
    confirmModal('Remove this session?',
      'The hours it contributed come off this month’s total.', 'Remove', function () {
        var next = Object.assign({}, rec);
        next.sessions = (rec.sessions || []).filter(function (s) { return s.id !== sesId; });
        Store.save('clientsup', next);
        flash('Session removed.');
        render();
      });
  }

  /* ------------------------------------------------------------ checklists */

  function renderChecklists() {
    var lists = Store.all('checklists').sort(function (a, b) {
      return String(a.name).localeCompare(String(b.name));
    });

    var h = '<div class="tk-head">' +
      '<div><h2>My Checklists</h2><p class="tk-sub">Reusable lists for anything you work through step by step. ' +
      'Any item, and the list itself, can carry a note.</p></div>' +
      '<div class="tk-head-actions">' + syncChip('checklists') +
      '<button type="button" class="tk-btn tk-primary" data-newlist="1">+ New checklist</button></div></div>';

    if (!lists.length) {
      return h + '<div class="tk-empty"><strong>No checklists yet.</strong> ' +
        'Make one for month-end close, a new-hire file, an audit prep — anything you repeat.</div>';
    }

    h += '<div class="tk-lists">';
    lists.forEach(function (c) {
      var items = c.items || [];
      var done = items.filter(function (i) { return i.done; }).length;
      var pct = items.length ? Math.round((done / items.length) * 100) : 0;

      h += '<section class="tk-list" data-list="' + esc(c.id) + '">' +
        '<header><h3>' + esc(c.name || 'Untitled') + '</h3>' +
        '<span class="tk-count">' + done + ' / ' + items.length + '</span>' +
        '<button type="button" class="tk-mini" data-listnote="' + esc(c.id) + '">Note</button>' +
        '<button type="button" class="tk-mini" data-reset="' + esc(c.id) + '">Reset</button>' +
        '<button type="button" class="tk-mini tk-danger" data-dellist="' + esc(c.id) + '">Delete</button>' +
        '<span class="tk-progress"><span style="width:' + pct + '%"></span></span>' +
        '</header>';

      if (c.note) h += '<p class="tk-listnote">' + esc(c.note) + '</p>';

      h += '<ul>';
      items.forEach(function (it) {
        h += '<li' + (it.done ? ' class="is-done"' : '') + '>' +
          '<label><input type="checkbox" data-check="' + esc(c.id) + '|' + esc(it.id) + '"' +
          (it.done ? ' checked' : '') + '/><span>' + esc(it.text) + '</span></label>' +
          (it.done && it.doneAt ? '<small>' + fmtDate(it.doneAt) + '</small>' : '') +
          '<button type="button" class="tk-x tk-notebtn' + (it.note ? ' has-note' : '') +
          '" data-itemnote="' + esc(c.id) + '|' + esc(it.id) + '" ' +
          'title="' + esc(it.note ? it.note : 'Add a note') + '" aria-label="Note">&#9998;</button>' +
          '<button type="button" class="tk-x" data-delitem="' + esc(c.id) + '|' + esc(it.id) + '" aria-label="Remove item">&times;</button>' +
          (it.note ? '<p class="tk-itemnote">' + esc(it.note) + '</p>' : '') +
          '</li>';
      });

      h += '</ul><form class="tk-additem" data-addto="' + esc(c.id) + '">' +
        '<input type="text" placeholder="Add an item…" aria-label="New checklist item"/>' +
        '<button type="submit" class="tk-mini">Add</button></form></section>';
    });

    return h + '</div>';
  }

  /* --------------------------------------------------------------- editing */

  var modal, modalForm, onSubmit;

  function fieldHTML(f, val) {
    var id = 'f_' + f.k;
    var lbl = '<label for="' + id + '">' + esc(f.label) + (f.required ? ' <em>*</em>' : '') + '</label>';

    if (f.type === 'check') {
      return '<div class="tk-f tk-f-check"><label><input type="checkbox" id="' + id + '" name="' + esc(f.k) + '"' +
        (val ? ' checked' : '') + '/> ' + esc(f.label) + '</label>' +
        (f.help ? '<small>' + esc(f.help) + '</small>' : '') + '</div>';
    }
    if (f.type === 'textarea') {
      return '<div class="tk-f tk-f-wide">' + lbl + '<textarea id="' + id + '" name="' + esc(f.k) + '" rows="3">' + esc(val) + '</textarea></div>';
    }
    if (f.type === 'select' || f.type === 'staff' || f.type === 'client') {
      var opts = (f.type === 'staff' || f.type === 'client')
        ? Store.all(f.type === 'staff' ? 'staff' : 'clients').map(function (s) { return s.name; }).sort()
        : f.options.slice();
      // roleLabel('') returns the em-dash placeholder, which would otherwise
      // get pushed in as a real selectable option on a brand-new record.
      var shown = f.valueMap ? (val ? roleLabel(val) : '') : val;
      var s = '<div class="tk-f">' + lbl + '<select id="' + id + '" name="' + esc(f.k) + '">' +
        '<option value="">—</option>';
      // Keep a value that is no longer in the list (a renamed staff member, say).
      if (shown && opts.indexOf(shown) < 0) opts.push(shown);
      opts.forEach(function (o) {
        s += '<option value="' + esc(o) + '"' + (String(shown) === String(o) ? ' selected' : '') + '>' + esc(o) + '</option>';
      });
      return s + '</select></div>';
    }
    var type = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text';
    return '<div class="tk-f">' + lbl + '<input type="' + type + '" id="' + id + '" name="' + esc(f.k) + '"' +
      (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') +
      (f.required ? ' required' : '') + ' value="' + esc(val) + '"/></div>';
  }

  function openEditor(mod, id) {
    var def = MODULES[mod];
    var rec = id ? Store.get(mod, id) : null;
    var body = '<div class="tk-form-grid">';
    def.fields.forEach(function (f) {
      var v = rec ? rec[f.k] : (f.default !== undefined ? f.default : '');
      body += fieldHTML(f, v == null ? '' : v);
    });
    body += '</div>';

    showModal((id ? 'Edit ' : 'Add ') + def.short, body, function (form) {
      var next = rec ? Object.assign({}, rec) : { id: uid() };
      var missing = [];
      def.fields.forEach(function (f) {
        var el = form.elements[f.k];
        if (!el) return;
        var v = f.type === 'check' ? el.checked : el.value.trim();
        if (f.valueMap) v = roleKey(v);
        if (f.required && (v === '' || v == null)) missing.push(f.label);
        next[f.k] = v;
      });
      if (missing.length) { return 'Please fill in: ' + missing.join(', '); }
      Store.save(mod, next);
      flash(def.short + ' saved.');
      return true;
    });
  }

  function openTrainingEditor(staffId, trainingId) {
    var s = Store.get('staff', staffId);
    var t = null;
    TRAININGS.forEach(function (x) { if (x.id === trainingId) t = x; });
    if (!s || !t) return;
    var st = trainingState(staffId, trainingId);
    var need = requirementFor(s, t);

    var body = '<p class="tk-modal-note"><strong>' + esc(t.name) + '</strong><br>' +
      esc(s.name) + ' · ' + esc(roleLabel(s.role)) + ' · ' +
      (need === 'req' ? 'Required' : 'Recommended') +
      (t.via ? ' · via ' + esc(t.via) : '') + '</p>' +
      '<div class="tk-form-grid">' +
      '<div class="tk-f"><label for="f_status">Status</label><select id="f_status" name="status">' +
        ['none', 'progress', 'done'].map(function (k) {
          return '<option value="' + k + '"' + (st.status === k ? ' selected' : '') + '>' + STATUS_LABEL[k] + '</option>';
        }).join('') +
      '</select></div>' +
      '<div class="tk-f"><label for="f_completedDate">Completed on</label>' +
      '<input type="date" id="f_completedDate" name="completedDate" value="' + esc(st.completedDate || '') + '"/></div>' +
      '<div class="tk-f tk-f-check"><label><input type="checkbox" name="certOnFile"' +
      (st.certOnFile ? ' checked' : '') + '/> Certificate of completion in the employee file</label></div>' +
      '</div>';

    showModal('Training record', body, function (form) {
      var next = {
        id: trainingRecId(staffId, trainingId),
        staffId: staffId, trainingId: trainingId,
        status: form.elements.status.value,
        completedDate: form.elements.completedDate.value,
        certOnFile: form.elements.certOnFile.checked
      };
      // Marking complete without a date is the common case — stamp today.
      if (next.status === 'done' && !next.completedDate) next.completedDate = toISO(today());
      Store.save('training', next);
      flash('Training updated.');
      return true;
    });
  }

  function openNote(title, subtitle, currentText, save) {
    showModal(title,
      (subtitle ? '<p class="tk-modal-note">' + esc(subtitle) + '</p>' : '') +
      '<div class="tk-form-grid"><div class="tk-f tk-f-wide">' +
      '<label for="f_note">Note</label>' +
      '<textarea id="f_note" name="note" rows="4">' + esc(currentText || '') + '</textarea>' +
      '</div></div>',
      function (form) {
        save(form.elements.note.value.trim());
        flash('Note saved.');
        return true;
      });
  }

  /* ---------------------------------------------------------------- modals */

  function ensureModal() {
    if (modal) return;
    modal = document.createElement('div');
    modal.className = 'tk-modal';
    modal.hidden = true;
    modal.innerHTML =
      '<div class="tk-modal-back" data-close="1"></div>' +
      '<form class="tk-modal-card" novalidate>' +
        '<h3 class="tk-modal-title"></h3>' +
        '<div class="tk-modal-body"></div>' +
        '<p class="tk-modal-err" hidden></p>' +
        '<div class="tk-modal-foot">' +
          '<button type="button" class="tk-btn" data-close="1">Cancel</button>' +
          '<button type="submit" class="tk-btn tk-primary tk-ok">Save</button>' +
        '</div>' +
      '</form>';
    document.body.appendChild(modal);
    modalForm = modal.querySelector('form');

    modal.addEventListener('click', function (e) {
      if (e.target.closest('[data-close]')) closeModal();
    });
    modalForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!onSubmit) return closeModal();
      var result = onSubmit(modalForm);
      if (result === true) return closeModal();
      var err = modal.querySelector('.tk-modal-err');
      err.textContent = typeof result === 'string' ? result : 'Could not save.';
      err.hidden = false;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !modal.hidden) closeModal();
    });
  }

  function showModal(title, body, submit, okLabel) {
    ensureModal();
    modal.querySelector('.tk-modal-title').textContent = title;
    modal.querySelector('.tk-modal-body').innerHTML = body;
    modal.querySelector('.tk-modal-err').hidden = true;
    modal.querySelector('.tk-ok').textContent = okLabel || 'Save';
    onSubmit = submit;
    modal.hidden = false;
    var first = modal.querySelector('input:not([type=checkbox]), select, textarea');
    if (first) setTimeout(function () { first.focus(); }, 30);
  }

  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    onSubmit = null;
  }

  function confirmModal(title, message, okLabel, done) {
    showModal(title, '<p class="tk-modal-note">' + message + '</p>', function () { done(); return true; }, okLabel);
  }

  var toastEl;
  function flash(msg, bad) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'tk-toast';
      toastEl.hidden = true;
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.className = 'tk-toast' + (bad ? ' bad' : '');
    toastEl.hidden = false;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.hidden = true; }, bad ? 6000 : 2600);
  }

  /* ------------------------------------------------------------ recurrence */

  function addDays(s, n) {
    var d = parseDate(s);
    if (!d) return '';
    d.setDate(d.getDate() + n);
    return toISO(d);
  }

  function nextOccurrence(rec, dueField) {
    var r = rec.repeat, d = rec[dueField || 'dueDate'];
    if (!d || !r || r === 'Does not repeat') return null;
    if (r === 'Weekly') return addDays(d, 7);
    if (r === 'Every 2 weeks') return addDays(d, 14);
    if (r === 'Monthly') return addMonths(d, 1);
    if (r === 'Quarterly') return addMonths(d, 3);
    if (r === 'Yearly') return addMonths(d, 12);
    if (r === 'Twice a month (1st & 15th)') {
      var x = parseDate(d);
      if (!x) return null;
      return x.getDate() < 15
        ? toISO(new Date(x.getFullYear(), x.getMonth(), 15))
        : toISO(new Date(x.getFullYear(), x.getMonth() + 1, 1));
    }
    return null;
  }

  function completeRecurring(mod, id) {
    var def = MODULES[mod], rec = Store.get(mod, id);
    if (!rec) return;
    var field = def.dueField;
    var next = nextOccurrence(rec, field);
    if (next) {
      var patch = { lastDone: toISO(today()) };
      patch[field] = next;
      Store.save(mod, Object.assign({}, rec, patch));
      flash('Logged — next one ' + fmtDate(next) + '.');
    } else {
      Store.remove(mod, id);
      flash('Completed and cleared.');
    }
  }

  /* -------------------------------------------------------------- settings */

  function renderSettings() {
    var h = '<div class="tk-head"><div><h2>Settings</h2>' +
      '<p class="tk-sub">Where each tab keeps its data, and how to back it up.</p></div>' +
      '<div class="tk-head-actions"><button type="button" class="tk-btn" data-syncall="1">Sync all now</button></div></div>';

    h += '<div class="tk-note tk-note-warn"><strong>Client information is different.</strong> ' +
      'Client names attached to authorizations or treatment plans are protected health information. ' +
      'Tabs holding client data are set to <em>this browser only</em> so that data is never sent to the ' +
      'server. Sharing them puts PHI in Netlify storage, which needs a signed business associate ' +
      'agreement first — check with whoever owns your HIPAA compliance before switching.</div>';

    h += '<div class="tk-scopes">';
    ALL_KEYS.forEach(function (m) {
      var def = defOf(m).label ? defOf(m)
        : { label: m === 'training' ? 'Staff EIDBI Training' : 'My Checklists', phi: false };
      var scope = Store.scope(m);
      h += '<div class="tk-scope-row">' +
        '<div><strong>' + esc(def.label) + '</strong>' +
        (def.phi ? '<span class="tk-tag-phi">contains client data</span>' : '') +
        '<small>' + (scope === 'shared'
          ? 'Shared — every staff browser sees the same records.'
          : 'This browser only — nothing leaves this device.') + '</small></div>' +
        '<div class="tk-head-actions">' +
        (def.phi && scope === 'local'
          ? '<button type="button" class="tk-btn tk-x" data-purge="' + esc(m) + '">Clear server copy</button>'
          : '') +
        '<button type="button" class="tk-btn tk-toggle" data-scope="' + esc(m) + '">' +
        (scope === 'shared' ? 'Make local' : 'Share with staff') + '</button></div></div>';
    });
    h += '</div>';

    /* Notifications. The client half of this panel is worth its length: what
     * leaves the browser, and what it is still capable of revealing, is not
     * guessable from the outside — and it is the kind of thing a compliance
     * review will ask about. */
    var beaconOff = false;
    try { beaconOff = localStorage.getItem(LS_BEACON) === 'off'; } catch (e) {}
    var pending = beaconOff ? 0 : clientAlerts().length;

    h += '<div class="tk-group"><h3>Notifications</h3>' +
      '<p class="tk-sub">A daily job emails whatever has just crossed a deadline — 60, 30, 14, 7, 3 ' +
      'and 1 day out, then overdue. Each step is announced once, so nothing repeats at you every ' +
      'morning until it is dealt with.</p>' +
      '<div class="tk-scopes">' +
        '<div class="tk-scope-row"><div><strong>Staff and agency</strong>' +
          '<small>Credentials, renewals, payroll &amp; billing reminders. These are stored on the ' +
          'server, so they are reported whether or not anyone opens this page.</small></div></div>' +
        '<div class="tk-scope-row"><div><strong>Clients — initials only</strong>' +
          '<span class="tk-tag-phi">contains client data</span>' +
          '<small>Client records never leave this browser, so it sends the notifier just the ' +
          'initials, one of three fixed reasons, and a date — never a name, note or record. ' +
          'Sent when someone opens the portal; between visits the notifier reuses the last ' +
          'picture and says how old it is.<br>' +
          '<strong>Initials attached to clinical status can still identify someone in a caseload ' +
          'this size.</strong> The email is confidential and should not be forwarded outside the ' +
          'agency.' +
          (beaconOff ? '' : ' Currently sending <strong>' + pending + '</strong> item' +
            (pending === 1 ? '' : 's') + '.') +
          '</small></div>' +
          '<div class="tk-head-actions">' +
            (beaconOff ? '' : '<button type="button" class="tk-btn tk-x" data-beaconwipe="1">Clear what was sent</button>') +
            '<button type="button" class="tk-btn tk-toggle" data-beacon="1">' +
            (beaconOff ? 'Turn on' : 'Turn off') + '</button>' +
          '</div></div>' +
      '</div>' +
      '<p class="tk-sub" style="margin-top:12px">Set up in Netlify under Site configuration &rarr; ' +
      'Environment variables: <code>NOTIFY_TO</code> and one of <code>RESEND_API_KEY</code> or ' +
      '<code>SENDGRID_API_KEY</code>. For a text message add <code>NOTIFY_SMS_TO</code> and the ' +
      'three <code>TWILIO_*</code> values. Without them the job runs and sends nothing.</p>' +
      '</div>';

    h += '<div class="tk-group"><h3>Backup</h3>' +
      '<p class="tk-sub">A backup file holds every tab on this browser, shared and local alike. ' +
      'Keep one before clearing your browser data, and use it to move local tabs to another device.</p>' +
      '<div class="tk-head-actions">' +
      '<button type="button" class="tk-btn tk-primary" data-export="1">Download backup</button>' +
      '<button type="button" class="tk-btn" data-import="1">Restore from backup</button>' +
      '<button type="button" class="tk-btn tk-danger" data-wipe="1">Clear this browser</button>' +
      '</div><input type="file" accept=".noortracker,.json,application/json" id="tk-file" hidden/></div>';

    return h;
  }

  function doExport() {
    var doc = Store.exportAll();
    var blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'noor-tracker-' + toISO(today()) + '.noortracker';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    flash('Backup downloaded.');
  }

  function doImport(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var n = Store.importAll(JSON.parse(fr.result));
        flash('Restored ' + n + ' records.');
        render();
      } catch (e) {
        flash(e.message || 'That file could not be read.', true);
      }
    };
    fr.readAsText(file);
  }

  /* ------------------------------------------------------------ tabs + app */

  /* Navigation is two levels.
   *
   * Fifteen peer tabs in one row gave no clue what belonged with what, and
   * carried names that only made sense next to each other — "Supervision"
   * meant staff observations while "Client Supervision" meant something else
   * entirely. Grouping by who the record is about lets the second level use
   * short labels, because the section already says whose roster or files these
   * are. Hash routing is unchanged: the section is derived from the tab, never
   * stored, so every existing #clientsup:id link still works.
   */
  var SECTIONS = [
    { k: 'home', label: 'Dashboard', tabs: [{ k: 'dashboard', label: 'Dashboard' }] },
    { k: 'clientarea', label: 'Clients', tabs: [
      { k: 'clients',     label: 'Roster' },
      { k: 'clientfiles', label: 'Files' },
      { k: 'clientsup',   label: 'Supervision' },
      { k: 'auths',       label: 'Authorizations' }
    ] },
    { k: 'staffarea', label: 'Staff', tabs: [
      { k: 'staff',       label: 'Roster' },
      { k: 'empfiles',    label: 'Files' },
      { k: 'training',    label: 'Training' },
      { k: 'credentials', label: 'Credentials' }
    ] },
    { k: 'agency', label: 'Agency', tabs: [
      { k: 'renewals',    label: 'Renewals' },
      { k: 'reminders',   label: 'Reminders' },
      { k: 'checklists',  label: 'Checklists' },
      { k: 'contacts',    label: 'Contacts' }
    ] },
    { k: 'setup', label: 'Settings', tabs: [{ k: 'settings', label: 'Settings' }] }
  ];

  // Flat list, in nav order — the routing table.
  var TABS = SECTIONS.reduce(function (all, s) { return all.concat(s.tabs); }, []);

  function sectionOf(tabKey) {
    for (var i = 0; i < SECTIONS.length; i++) {
      for (var j = 0; j < SECTIONS[i].tabs.length; j++) {
        if (SECTIONS[i].tabs[j].k === tabKey) return SECTIONS[i];
      }
    }
    return SECTIONS[0];
  }

  var root, current = 'dashboard', currentId = '', currentSub = '';

  /* Embedded mode.
   * The portal home page mounts the dashboard on its own, with no tab bar —
   * "what needs attention" is the first thing staff should see on landing,
   * without a detour through the tracker. In that mode the hash belongs to
   * the host page, so links leave for tracker.html instead of routing here. */
  var embedded = false;

  function currentTab() {
    var raw = (location.hash || '').replace(/^#/, '');
    var bits = raw.split(':');
    for (var i = 0; i < TABS.length; i++) {
      if (TABS[i].k === bits[0]) return { tab: bits[0], id: bits[1] || '', sub: bits[2] || '' };
    }
    return { tab: 'dashboard', id: '', sub: '' };
  }

  // Badge each tab with how many of its rows are overdue. One sweep, counted
  // per module — not one sweep per tab.
  function overdueByModule() {
    var counts = {};
    dueItems(0).forEach(function (i) {
      if (i.days < 0) counts[i.mod] = (counts[i.mod] || 0) + 1;
    });
    // Supervision deliberately does NOT badge. supShortfalls() only ever
    // returns months that have already closed, and no amount of red on the
    // nav makes last month's supervision happen. The shortfall is still shown
    // on the supervision rows themselves, where it is a record rather than a
    // demand.
    return counts;
  }

  function renderTabs() {
    var counts = overdueByModule();
    var here = sectionOf(current);

    // Level one: who the records are about.
    var h = '<nav class="tk-nav" aria-label="Sections">';
    SECTIONS.forEach(function (s) {
      var n = s.tabs.reduce(function (sum, t) { return sum + (counts[t.k] || 0); }, 0);
      h += '<a href="#' + s.tabs[0].k + '" class="' + (s === here ? 'active' : '') + '">' +
        esc(s.label) + (n ? '<span class="tk-dot">' + n + '</span>' : '') + '</a>';
    });
    h += '</nav>';

    // Level two, only where there is a choice to make.
    if (here.tabs.length > 1) {
      h += '<nav class="tk-tabs" role="tablist" aria-label="' + esc(here.label) + '">';
      here.tabs.forEach(function (t) {
        var n = counts[t.k] || 0;
        h += '<a role="tab" href="#' + t.k + '" class="' + (t.k === current ? 'active' : '') + '">' +
          esc(t.label) + (n ? '<span class="tk-dot">' + n + '</span>' : '') + '</a>';
      });
      h += '</nav>';
    }
    return h;
  }

  function renderBody() {
    if (current === 'dashboard') return renderDashboard();
    if (current === 'settings') return renderSettings();
    if (current === 'training') return renderTraining();
    if (current === 'checklists') return renderChecklists();
    if (FILES[current]) return renderFiles(current);
    if (SUPS[current]) return renderClientSup();
    return renderTable(current);
  }

  function render() {
    if (embedded) {
      current = 'dashboard';
      currentId = '';
      root.innerHTML = '<div class="tk-panel">' + renderDashboard() + '</div>';
      return;
    }

    var at = currentTab();
    current = at.tab;
    currentId = at.id;
    currentSub = at.sub;

    // A full re-render would drop the caret out of the filter box mid-typing.
    var active = document.activeElement;
    var keepFilter = active && active.dataset && active.dataset.filter;
    var caret = keepFilter ? active.selectionStart : null;

    root.innerHTML = renderTabs() + '<div class="tk-panel">' + renderBody() + '</div>';

    if (keepFilter) {
      var again = root.querySelector('[data-filter="' + keepFilter + '"]');
      if (again) {
        again.focus();
        try { again.setSelectionRange(caret, caret); } catch (e) {}
      }
    }
  }

  function scopeToggle(mod) {
    var def = defOf(mod);
    var next = Store.scope(mod) === 'shared' ? 'local' : 'shared';

    if (next === 'shared' && def.phi) {
      confirmModal('Share client data?',
        'This tab holds client names. Sharing uploads those records to Netlify storage so other staff ' +
        'can see them — that is protected health information leaving this device. Only do this if your ' +
        'agency has a business associate agreement covering it.',
        'Yes, share it', function () { Store.setScope(mod, 'shared'); flash('Now shared with staff.'); render(); });
      return;
    }
    if (next === 'local') {
      confirmModal('Stop sharing?',
        'New edits stay on this browser and other staff will no longer see them. Records already on the ' +
        'server stay there until you delete them.',
        'Make it local', function () { Store.setScope(mod, 'local'); flash('Now local to this browser.'); render(); });
      return;
    }
    Store.setScope(mod, 'shared');
    flash('Now shared with staff.');
    render();
  }

  function wire() {
    root.addEventListener('click', function (e) {
      var el;

      if ((el = e.target.closest('[data-add]'))) { openEditor(el.dataset.add); return; }
      if ((el = e.target.closest('[data-edit]'))) { openEditor(current, el.dataset.edit); return; }
      if ((el = e.target.closest('[data-done]'))) { completeRecurring(current, el.dataset.done); return; }
      if ((el = e.target.closest('[data-train]'))) {
        var p = el.dataset.train.split('|');
        openTrainingEditor(p[0], p[1]);
        return;
      }
      if ((el = e.target.closest('[data-supmerge]'))) {
        var mp = el.dataset.supmerge.split('|');
        var mFrom = supName(mp[0]), mTo = supName(mp[1]);
        var mRows = Store.all('clientsup').filter(function (r) { return r.client === mFrom; }).length;
        confirmModal('Merge ' + esc(mFrom) + ' into ' + esc(mTo) + '?',
          (mRows
            ? '<strong>' + mRows + ' supervision month' + (mRows === 1 ? '' : 's') + '</strong> move to ' +
              esc(mTo) + '. Where both hold the same month, the sessions are combined and the ' +
              'larger direct-therapy figure is kept.'
            : 'There are no supervision months to move.') +
          '<br><br>Do this only if they are the same person — it cannot be undone from here.',
          'Merge', function () {
            var res = supMergeNames(mFrom, mTo);
            flash('Merged into ' + mTo + ' — ' + res.moved + ' month' + (res.moved === 1 ? '' : 's') + ' moved' +
              (res.folded ? ', ' + res.folded + ' combined' : '') + '.');
            location.hash = 'clientsup';
            render();
          });
        return;
      }
      if ((el = e.target.closest('[data-supdistinct]'))) {
        // Answering "different people" has to stick, or the same question comes
        // back on every render and gets clicked through without being read.
        var dn = supName(el.dataset.supdistinct);
        var other = null;
        supDuplicates().forEach(function (d) { if (d.drop === dn) other = d.keep; });
        if (other) {
          dismissPair(dn, other);
          flash('Kept as two separate clients.');
          render();
        }
        return;
      }
      if ((el = e.target.closest('[data-beacon]'))) {
        var boff = false;
        try { boff = localStorage.getItem(LS_BEACON) === 'off'; } catch (e2) {}
        if (boff) {
          try { localStorage.removeItem(LS_BEACON); } catch (e2) {}
          sendBeacon();
          flash('Client items will be included, as initials.');
          render();
        } else {
          confirmModal('Stop sending client initials?',
            'Client items drop out of the email. Staff credentials, renewals and reminders carry on. ' +
            'Anything already sent stays on the server until you clear it.',
            'Turn off', function () {
              try { localStorage.setItem(LS_BEACON, 'off'); } catch (e2) {}
              flash('Client items will no longer be sent.');
              render();
            });
        }
        return;
      }
      if ((el = e.target.closest('[data-beaconwipe]'))) {
        confirmModal('Clear the initials already sent?',
          'Deletes what the notifier is holding, so the next email has no client items until ' +
          'someone opens the portal again. Your records here are untouched.',
          'Clear it', function () {
            fetch('/api/client-alerts', { method: 'DELETE' })
              .then(function () { flash('Cleared.'); })
              .catch(function () { flash('Could not reach the server.', true); });
          });
        return;
      }
      if ((el = e.target.closest('[data-purge]'))) {
        var pm = el.dataset.purge, pl = defOf(pm).label || pm;
        confirmModal('Clear the server copy of ' + esc(pl) + '?',
          'Records uploaded to Netlify storage before this tab was made local are deleted there. ' +
          'What is on this browser is untouched, and stays the working copy.',
          'Clear it', function () {
            Store.purgeServer(pm)
              .then(function () { flash('Server copy of ' + pl + ' cleared.'); render(); })
              .catch(function (err) { flash(err.message || 'Could not clear it.', true); });
          });
        return;
      }
      if ((el = e.target.closest('[data-supadd]'))) { openSupEditor('', el.dataset.supadd || ''); return; }
      if ((el = e.target.closest('[data-supedit]'))) { openSupEditor(el.dataset.supedit); return; }
      if ((el = e.target.closest('[data-supprint]'))) { window.print(); return; }
      if ((el = e.target.closest('[data-sesadd]'))) { openSessionEditor(el.dataset.sesadd, ''); return; }
      if ((el = e.target.closest('[data-suppaste]'))) { openSupPaste(el.dataset.suppaste || ''); return; }
      if ((el = e.target.closest('[data-sesedit]'))) {
        var se = el.dataset.sesedit.split('|');
        openSessionEditor(se[0], se[1]);
        return;
      }
      if ((el = e.target.closest('[data-sesdel]'))) {
        var sd = el.dataset.sesdel.split('|');
        removeSession(sd[0], sd[1]);
        return;
      }
      if ((el = e.target.closest('[data-supdel]'))) {
        var sdi = el.dataset.supdel, sdr = Store.get('clientsup', sdi);
        confirmModal('Delete this supervision month?',
          '<strong>' + esc(sdr ? supTitle(sdr) : '') + '</strong><br>' +
          'Its session log goes with it. This cannot be undone.',
          'Delete', function () {
            Store.remove('clientsup', sdi);
            flash('Deleted.');
            location.hash = 'clientsup';
          });
        return;
      }
      if ((el = e.target.closest('[data-del]'))) {
        var mod = current, id = el.dataset.del, def = MODULES[mod];
        confirmModal('Delete this record?',
          '<strong>' + esc(def.titleOf(Store.get(mod, id) || {})) + '</strong><br>This cannot be undone.',
          'Delete', function () { Store.remove(mod, id); flash('Deleted.'); });
        return;
      }
      if ((el = e.target.closest('[data-jump]'))) {
        e.preventDefault();
        // On the home page the hash is not ours to steer; go to the tracker.
        if (embedded) location.href = 'tracker.html#' + el.dataset.jump;
        else location.hash = el.dataset.jump;
        return;
      }
      if ((el = e.target.closest('[data-scope]'))) { scopeToggle(el.dataset.scope); return; }

      if (e.target.closest('[data-syncall]')) { Store.pullAll().then(function () { flash('Synced.'); render(); }); return; }
      if (e.target.closest('[data-export]')) { doExport(); return; }
      if (e.target.closest('[data-import]')) { document.getElementById('tk-file').click(); return; }
      if (e.target.closest('[data-wipe]')) {
        confirmModal('Clear this browser?',
          'Every tracker record stored on this browser is removed, including local-only tabs. ' +
          'Shared tabs will come back from the server; local ones are gone unless you have a backup.',
          'Clear it', function () {
            ALL_KEYS.forEach(function (m) { try { localStorage.removeItem(LS_PREFIX + m); } catch (e) {} });
            location.reload();
          });
        return;
      }

      // --- file checklists ---
      if ((el = e.target.closest('[data-cycle]'))) {
        var cy = el.dataset.cycle.split('|');
        var order = ['none', 'yes', 'na'];
        var now = docState(cy[0], cy[1], cy[2]).status;
        var nextStatus = order[(order.indexOf(now) + 1) % order.length];
        var patch = { status: nextStatus };
        // Marking something on file without a date is the common case.
        if (nextStatus === 'yes' && !docState(cy[0], cy[1], cy[2]).date) patch.date = toISO(today());
        docSet(cy[0], cy[1], cy[2], patch);
        return;
      }
      if ((el = e.target.closest('[data-docnote]'))) {
        var dn = el.dataset.docnote.split('|');
        var ent = Store.get(FILES[dn[0]].entity, dn[1]);
        openNote('Document note', (ent && ent.name) || '', docState(dn[0], dn[1], dn[2]).note,
          function (v) { docSet(dn[0], dn[1], dn[2], { note: v }); });
        return;
      }

      // --- notes on checklists and their items ---
      if ((el = e.target.closest('[data-listnote]'))) {
        var lid = el.dataset.listnote;
        var lc = Store.get('checklists', lid);
        if (!lc) return;
        openNote('Checklist note', lc.name, lc.note, function (v) {
          Store.save('checklists', Object.assign({}, lc, { note: v }));
        });
        return;
      }
      if ((el = e.target.closest('[data-itemnote]'))) {
        var inq = el.dataset.itemnote.split('|');
        var ic = Store.get('checklists', inq[0]);
        if (!ic) return;
        var item = (ic.items || []).filter(function (x) { return x.id === inq[1]; })[0];
        if (!item) return;
        openNote('Item note', item.text, item.note, function (v) {
          Store.save('checklists', Object.assign({}, ic, {
            items: ic.items.map(function (x) { return x.id === inq[1] ? Object.assign({}, x, { note: v }) : x; })
          }));
        });
        return;
      }

      // --- checklists ---
      if (e.target.closest('[data-newlist]')) {
        showModal('New checklist',
          '<div class="tk-form-grid"><div class="tk-f tk-f-wide"><label for="f_name">Name</label>' +
          '<input type="text" id="f_name" name="name" placeholder="Month-end close, new-hire file…"/></div></div>',
          function (form) {
            var name = form.elements.name.value.trim();
            if (!name) return 'Give the checklist a name.';
            Store.save('checklists', { id: uid(), name: name, items: [] });
            flash('Checklist created.');
            return true;
          });
        return;
      }
      if ((el = e.target.closest('[data-reset]'))) {
        var c = Store.get('checklists', el.dataset.reset);
        if (!c) return;
        Store.save('checklists', Object.assign({}, c, {
          items: (c.items || []).map(function (i) { return Object.assign({}, i, { done: false, doneAt: '' }); })
        }));
        flash('Checklist reset.');
        return;
      }
      if ((el = e.target.closest('[data-dellist]'))) {
        var id2 = el.dataset.dellist;
        var list = Store.get('checklists', id2);
        confirmModal('Delete this checklist?',
          '<strong>' + esc((list && list.name) || 'Untitled') + '</strong><br>This cannot be undone.',
          'Delete', function () { Store.remove('checklists', id2); flash('Deleted.'); });
        return;
      }
      if ((el = e.target.closest('[data-delitem]'))) {
        var q = el.dataset.delitem.split('|');
        var cl = Store.get('checklists', q[0]);
        if (!cl) return;
        Store.save('checklists', Object.assign({}, cl, {
          items: (cl.items || []).filter(function (i) { return i.id !== q[1]; })
        }));
        return;
      }
    });

    root.addEventListener('change', function (e) {
      var dd = e.target.closest('[data-docdate]');
      if (dd) {
        var q = dd.dataset.docdate.split('|');
        var patch = { date: dd.value };
        // Setting a date implies the document is in hand.
        if (dd.value && docState(q[0], q[1], q[2]).status === 'none') patch.status = 'yes';
        docSet(q[0], q[1], q[2], patch);
        return;
      }
      var box = e.target.closest('[data-check]');
      if (box) {
        var q = box.dataset.check.split('|');
        var c = Store.get('checklists', q[0]);
        if (!c) return;
        Store.save('checklists', Object.assign({}, c, {
          items: (c.items || []).map(function (i) {
            return i.id === q[1] ? Object.assign({}, i, { done: box.checked, doneAt: box.checked ? toISO(today()) : '' }) : i;
          })
        }));
      }
    });

    root.addEventListener('input', function (e) {
      var f = e.target.closest('[data-filter]');
      if (f) { filters[f.dataset.filter] = f.value; render(); }
    });

    root.addEventListener('submit', function (e) {
      var form = e.target.closest('[data-addto]');
      if (!form) return;
      e.preventDefault();
      var input = form.querySelector('input');
      var text = input.value.trim();
      if (!text) return;
      var c = Store.get('checklists', form.dataset.addto);
      if (!c) return;
      Store.save('checklists', Object.assign({}, c, {
        items: (c.items || []).concat([{ id: uid(), text: text, done: false, doneAt: '' }])
      }));
      input.value = '';
    });

    document.addEventListener('change', function (e) {
      if (e.target.id === 'tk-file' && e.target.files && e.target.files[0]) {
        doImport(e.target.files[0]);
        e.target.value = '';
      }
    });

    window.addEventListener('hashchange', render);
  }

  /* ------------------------------------------------------------------ boot */

  /* ------------------------------------------------------ client beacon
   *
   * Client records never leave this browser, so the daily notifier cannot see
   * that an authorization is about to lapse. This sends it the little it needs
   * to say so: the client's INITIALS, a fixed reason code, and the date.
   *
   * The full name is reduced to initials HERE, before anything is sent — so
   * the server never holds a client name to abbreviate later. Nothing else
   * goes: no notes, no service codes, no record ids that could be looked up.
   * /api/client-alerts independently drops anything that is not this shape.
   *
   * It fires when someone opens the portal, which is the only moment this data
   * is readable. If nobody opens it for three weeks, the notifier keeps using
   * the last picture it was given and says how old that is.
   */
  function initialsOf(name) {
    var parts = String(name || '').trim().split(/[\s,]+/).filter(Boolean);
    if (!parts.length) return '';
    var letters = parts.slice(0, 2).map(function (p) {
      var m = /[A-Za-z]/.exec(p);
      return m ? m[0].toUpperCase() : '';
    }).filter(Boolean);
    if (!letters.length) return '';
    return letters.join('.') + '.';
  }

  function clientAlerts() {
    var out = [];
    var seen = {};
    function push(id, initials, reason, due) {
      if (!initials) return;
      var key = reason.replace(/\s+/g, '') + ':' + id + ':' + (due || '');
      if (seen[key]) return;
      seen[key] = 1;
      out.push({ key: key, initials: initials, reason: reason, due: due || '' });
    }

    // Authorizations coming to an end.
    var authDef = MODULES.auths;
    Store.all('auths').forEach(function (r) {
      var due = r[authDef.dueField];
      var days = daysUntil(due);
      if (days == null || days > (authDef.warnAt || 45)) return;
      push(r.id, initialsOf(r.client), 'Authorization ends', due);
    });

    // Supervision shortfalls are deliberately NOT alerted. They only exist for
    // months that have already closed, so a daily reminder asks for something
    // nobody can do. The shortfall stays visible on the supervision rows.

    // Client files still missing paperwork.
    Store.all('clients').forEach(function (c) {
      if (c.active === false) return;
      var st = fileStats('clientfiles', c.id);
      if (!st.total || !st.missing.length) return;
      push(c.id, initialsOf(c.name), 'File incomplete', '');
    });

    return out;
  }

  function sendBeacon() {
    if (embedded) return;                       // one sender per visit
    var off = false;
    try { off = localStorage.getItem(LS_BEACON) === 'off'; } catch (e) {}
    if (off) return;

    var items = clientAlerts();
    fetch('/api/client-alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items })
      // Silent on failure: this is a courtesy to the notifier, not something
      // the person using the tracker should be interrupted about.
    }).catch(function () {});
  }

  /* Apply anything the fillable forms left behind.
   *
   * A form cannot write to /api/tracker itself — this file owns the sync
   * rules, and a second writer would have to reimplement all of them. So the
   * forms append to an inbox in localStorage (see /packet.js) and it is
   * drained here, through the same Store as every other edit. Entries are
   * removed before they are applied: a malformed one should be dropped, not
   * retried on every load forever.
   */
  function drainInbox() {
    if (!root || typeof NoorPacket === 'undefined') return 0;
    var queued;
    try { queued = NoorPacket.drain(); } catch (e) { return 0; }
    if (!queued || !queued.length) return 0;

    var applied = 0;
    queued.forEach(function (e) {
      try {
        if (e.t === 'upsert' && e.rec && e.rec.id && ALL_KEYS.indexOf(e.mod) >= 0) {
          // Do not clobber a record the tracker already knows better.
          var have = Store.get(e.mod, e.rec.id);
          if (!have) { Store.save(e.mod, e.rec); applied++; }
        } else if (e.t === 'doc' && FILES[e.key] && e.entityId && e.docId) {
          docSet(e.key, e.entityId, e.docId, {
            status: e.status || 'yes',
            date: e.date || toISO(today()),
            note: e.note || '',
            file: e.file || undefined
          });
          applied++;
        }
      } catch (err) { /* one bad entry should not stop the rest */ }
    });
    return applied;
  }

  function start() {
    root = document.getElementById('tracker');
    if (!root) {
      root = document.getElementById('tracker-dashboard');
      if (!root) return;
      embedded = true;
    }
    Store.init();
    Store.sweepRetired();
    var fromForms = drainInbox();
    wire();
    render();
    if (fromForms) {
      flash(fromForms + ' update' + (fromForms === 1 ? '' : 's') + ' from completed forms applied.');
    }

    var pending = null;
    Store.onChange(function () {
      // Several records can save at once; repaint once when the dust settles.
      clearTimeout(pending);
      pending = setTimeout(render, 40);
    });

    // Send after the first sync, so the picture includes other people's edits
    // rather than only what this browser happened to have cached.
    Store.pullAll().then(sendBeacon);

    // Pick up other people's edits while the tab is open.
    setInterval(function () { if (!document.hidden) Store.pullAll(); }, 60000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) Store.pullAll(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
