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
  var API = '/api/tracker';

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

    supervision: {
      label: 'Supervision & Observation', short: 'Supervision', color: 'purple', phi: false,
      blurb: 'QSP observation and direction. Logging a session rolls the record to its next due date.',
      dueField: 'nextDue', dueLabel: 'Next observation', warnAt: 14, recurring: true,
      titleOf: function (r) { return (r.staff || 'Unnamed') + ' \u2014 observation'; },
      sub: function (r) { return r.supervisor ? 'Supervisor ' + r.supervisor : ''; },
      fields: [
        { k: 'staff', label: 'Staff member', type: 'staff', required: true },
        { k: 'supervisor', label: 'Supervising QSP', type: 'staff' },
        { k: 'repeat', label: 'Required frequency', type: 'select', required: true,
          options: ['Weekly', 'Every 2 weeks', 'Twice a month (1st & 15th)', 'Monthly', 'Quarterly'] },
        { k: 'nextDue', label: 'Next observation due', type: 'date', required: true },
        { k: 'hours', label: 'Supervised hours to date', type: 'number' },
        { k: 'notes', label: 'Notes', type: 'textarea' }
      ],
      columns: [
        { k: 'staff', label: 'Staff', wide: true },
        { k: 'supervisor', label: 'Supervisor' },
        { k: 'repeat', label: 'Frequency' },
        { k: 'lastDone', label: 'Last observed', type: 'date' },
        { k: 'nextDue', label: 'Next due', type: 'date' },
        { k: '_status', label: 'Status', type: 'status' }
      ]
    },

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
  var ALL_KEYS = Object.keys(MODULES).concat(['training', 'checklists', 'empfiles', 'clientfiles']);

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
      var def = MODULES[mod];
      // Client-identifying modules stay on this device unless told otherwise.
      return def && def.phi ? 'local' : 'shared';
    }

    function loadScopes() {
      var saved = {};
      try { saved = JSON.parse(localStorage.getItem(LS_SCOPE) || '{}') || {}; } catch (e) {}
      ALL_KEYS.forEach(function (m) {
        scopes[m] = saved[m] === 'local' || saved[m] === 'shared' ? saved[m] : defaultScope(m);
      });
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

    h += '<div class="tk-stats">' +
      statTile('Overdue', over.length, over.length ? 'over' : 'ok') +
      statTile('Next 14 days', soon.length, soon.length ? 'soon' : 'ok') +
      statTile('Open checklist items', openItems, openItems ? 'soon' : 'ok') +
      statTile('Files incomplete', files.length, files.length ? 'over' : 'ok') +
      '</div>';

    h += group('Overdue', over) + group('Next 14 days', soon);

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
      if (def.recurring) h += '<button type="button" class="tk-mini" data-done="' + esc(r.id) + '">' +
        (mod === 'supervision' ? 'Log' : 'Done') + '</button>';
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
            '<button type="button" class="tk-mini tk-notebtn' + (ds.note ? ' has-note' : '') + '" ' +
              'data-docnote="' + ref + '">' + (ds.note ? 'Note' : '+ Note') + '</button>' +
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
      var def = MODULES[m] || FILES[m] ||
        { label: m === 'training' ? 'Staff EIDBI Training' : 'My Checklists', phi: false };
      var scope = Store.scope(m);
      h += '<div class="tk-scope-row">' +
        '<div><strong>' + esc(def.label) + '</strong>' +
        (def.phi ? '<span class="tk-tag-phi">contains client data</span>' : '') +
        '<small>' + (scope === 'shared'
          ? 'Shared — every staff browser sees the same records.'
          : 'This browser only — nothing leaves this device.') + '</small></div>' +
        '<button type="button" class="tk-btn tk-toggle" data-scope="' + esc(m) + '">' +
        (scope === 'shared' ? 'Make local' : 'Share with staff') + '</button></div>';
    });
    h += '</div>';

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

  var TABS = [
    { k: 'dashboard',   label: 'Dashboard' },
    { k: 'checklists',  label: 'Checklists' },
    { k: 'reminders',   label: 'Reminders' },
    { k: 'clients',     label: 'Clients', sep: true },
    { k: 'clientfiles', label: 'Client Files' },
    { k: 'auths',       label: 'Authorizations' },
    { k: 'staff',       label: 'Staff', sep: true },
    { k: 'empfiles',    label: 'Employee Files' },
    { k: 'training',    label: 'Training' },
    { k: 'supervision', label: 'Supervision' },
    { k: 'credentials', label: 'Credentials' },
    { k: 'renewals',    label: 'Renewals', sep: true },
    { k: 'contacts',    label: 'Contacts' },
    { k: 'settings',    label: 'Settings' }
  ];

  var root, current = 'dashboard', currentId = '';

  function currentTab() {
    var raw = (location.hash || '').replace(/^#/, '');
    var bits = raw.split(':');
    for (var i = 0; i < TABS.length; i++) {
      if (TABS[i].k === bits[0]) return { tab: bits[0], id: bits[1] || '' };
    }
    return { tab: 'dashboard', id: '' };
  }

  // Badge each tab with how many of its rows are overdue. One sweep, counted
  // per module — not one sweep per tab.
  function overdueByModule() {
    var counts = {};
    dueItems(0).forEach(function (i) {
      if (i.days < 0) counts[i.mod] = (counts[i.mod] || 0) + 1;
    });
    return counts;
  }

  function renderTabs() {
    var counts = overdueByModule();
    var h = '<nav class="tk-tabs" role="tablist">';
    TABS.forEach(function (t) {
      var n = counts[t.k] || 0;
      h += '<a role="tab" href="#' + t.k + '" class="' + (t.k === current ? 'active' : '') +
        (t.sep ? ' tk-sep' : '') + '">' +
        esc(t.label) + (n ? '<span class="tk-dot">' + n + '</span>' : '') + '</a>';
    });
    return h + '</nav>';
  }

  function renderBody() {
    if (current === 'dashboard') return renderDashboard();
    if (current === 'settings') return renderSettings();
    if (current === 'training') return renderTraining();
    if (current === 'checklists') return renderChecklists();
    if (FILES[current]) return renderFiles(current);
    return renderTable(current);
  }

  function render() {
    var at = currentTab();
    current = at.tab;
    currentId = at.id;

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
    var def = MODULES[mod] || {};
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
      if ((el = e.target.closest('[data-del]'))) {
        var mod = current, id = el.dataset.del, def = MODULES[mod];
        confirmModal('Delete this record?',
          '<strong>' + esc(def.titleOf(Store.get(mod, id) || {})) + '</strong><br>This cannot be undone.',
          'Delete', function () { Store.remove(mod, id); flash('Deleted.'); });
        return;
      }
      if ((el = e.target.closest('[data-jump]'))) { e.preventDefault(); location.hash = el.dataset.jump; return; }
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

  function start() {
    root = document.getElementById('tracker');
    if (!root) return;
    Store.init();
    wire();
    render();

    var pending = null;
    Store.onChange(function () {
      // Several records can save at once; repaint once when the dust settles.
      clearTimeout(pending);
      pending = setTimeout(render, 40);
    });

    Store.pullAll();

    // Pick up other people's edits while the tab is open.
    setInterval(function () { if (!document.hidden) Store.pullAll(); }, 60000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) Store.pullAll(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
