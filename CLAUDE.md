# Project notes

- The user deploys the site via GitHub Desktop (repo: noortherapycenter/NTC-Website → Netlify). Do NOT present a project ZIP after changes unless the user explicitly asks for one. When they ask, one full-project ZIP is the preferred format.
- Fillable form text color: body/label/check text uses the gray-green (--ink-soft); only the form title (h1) and section titles (.section-head h2) are black (--ink). Keep new forms consistent with this.
- The staff portal is protected by a Netlify edge function (netlify/edge-functions/staff-auth.js):
  server-side username + password, 1-hour session cookie, progressive lockout after 5 wrong tries
  (which then refuses even correct credentials until the wait expires). Credentials and the cookie
  signing key are read from Netlify environment variables `STAFF_USER`, `STAFF_PASSWORD` and
  `STAFF_COOKIE_SECRET` — never hardcode them, this repo is public. Both edge functions fail closed
  if the variables are unset. `tracker-data.js` verifies the same cookie with the same key.
  Username matching is case-insensitive; the password is case-sensitive; both are compared in
  constant time. Do NOT reuse the guest WiFi password shown on the waiting-room TV slideshow.
- Admin Tracker (`staff-portal/tracker.html` + `tracker.js` + `tracker.css`). Interactive record-keeping
  for dated work: client authorizations, CMDE/ITP due dates, staff roster, EIDBI training, credentials,
  agency renewals, recurring payroll/billing reminders, and checklists. Tabs are hash-routed (`#staff`).
  - Storage is per module, chosen in the Tracker's Settings tab. "Shared" modules sync through the
    `/api/tracker` edge function (`netlify/edge-functions/tracker-data.js`, Netlify Blobs) so every
    staff browser sees the same records; "local" modules never leave the browser.
  - Modules flagged `phi: true` in `tracker.js` (client authorizations, CMDE/ITP) default to LOCAL,
    because client names attached to services are protected health information. Do not change that
    default without a business associate agreement covering the storage.
  - Sync merges per record, not per module: each record carries `id` + `updatedAt`, so two people
    editing different rows never overwrite each other. Deletes are tombstones, pruned after 90 days.
  - The EIDBI training catalog in `tracker.js` (`TRAININGS`, `ROLES`) is copied from the onboarding
    packets, and required trainings are due six months after the hire date. If the onboarding pages
    change, update `TRAININGS` to match — they are the same source of truth.
  - File checklists (`FILES`, `EMPLOYEE_DOCS`, `CLIENT_DOCS`) are copied verbatim from
    `Fillable Forms/Employee File Checklist.html` and `Fillable Forms/Client File Checklist.html`.
    Keep them in step. A file is stored as ONE record per person keyed by the roster id:
    `{ id: <entityId>, docs: { <docId>: { status, date, note } } }`, status being yes/na/none.
    "Not applicable" is excluded from the denominator, so a file can read 100% with items marked n/a.
  - Rosters: `staff` drives training, employee files and credentials; `clients` drives
    client files and the authorization picker. Both are plain modules — `clients` is PHI, so local
    by default like `auths`.
  - Sign out is real: `/staff-portal/logout` is handled by staff-auth.js and expires the cookie
    server-side. portal.js turns the old Lock button into that control on every portal page.
  - Removed: the CMDE/ITP due-date module. CMDE and ITP still appear as documents inside the client
    file checklist.
- Completed forms no longer post to Netlify Forms. `Fillable Forms/submit.js` used to render every
  completed form to a PDF and POST it to the `form-submissions` Netlify form — across 43 forms,
  including Client Intake, Medical Information, DHS-7120A CMDE, Form I-9 and Direct Deposit. That
  path is retired and its hidden registration removed from `index.html`. Submissions collected
  under it before this change still sit in the Netlify Forms dashboard and must be cleared there.
  - `/packet.js` (site root, loaded by both the portal and the forms) holds the active onboarding
    packet — which staff member or client the current run is for — plus `FORMS`, the map from a
    form's filename to the checklist item it satisfies. Keep `FORMS` in step with `EMPLOYEE_DOCS`
    and `CLIENT_DOCS` in `tracker.js`; a form that is not listed still files, it just ticks nothing.
  - Staff forms: the PDF is POSTed to `/api/documents`
    (`netlify/edge-functions/documents.js`, Netlify Blobs, same staff cookie) and filed against the
    employee's profile; the checklist item is ticked and gains a "PDF" link.
  - Client forms: NOTHING is uploaded. The checklist item is ticked and the PDF is downloaded to
    whoever filled it in. `documents.js` refuses a non-staff upload server-side — the rule is
    enforced there, not in the interface, so a UI bug cannot put PHI in Blob storage.
  - Forms never call `/api/tracker` directly. `tracker.js` owns the sync rules, so a form appends to
    an inbox in localStorage and `drainInbox()` applies it on the tracker's next load. This is also
    what makes submitting work with no network.
  - `forms/` (the PUBLIC client-facing forms — apply, intake, deposit) is a SEPARATE flow that still
    posts to Netlify Forms under its own form names. It was left alone: those are filled in by
    clients who cannot authenticate. `online-intake` in particular collects client PHI.
- Client Supervision tracker tab (`clientsup` in `tracker.js`, registered in `SUPS`). One record per
  client per month, replacing the Passage Health clinical supervision report: direct therapy hours
  drive the hours required, the session log (supervisor, date, H0032/97155, start, end) drives the
  hours provided, and a closed month that came up short badges the tab and the dashboard.
  Required = direct / `SUP_RATIO`, i.e. 1 hour per 16 — confirmed against the June 2026 report,
  where 177h58m of direct therapy required 11h07m. PHI, so local by default. Prints as the report.
- `defOf(key)` resolves a module definition across `MODULES`, `FILES` and `SUPS`. Use it for anything
  scope-related. Reading `MODULES[key]` alone was a bug: file checklists live in `FILES`, so
  `clientfiles` (phi: true) fell through to the non-PHI default, silently SHARED its client data to
  the server and skipped the PHI confirmation. A one-time repair (`LS_PHI_FIX`) pulls PHI modules
  back to local and says so on the dashboard; Settings gained "Clear server copy" for them, which
  DELETEs the blob rather than tombstoning it (tombstones would out-rank and destroy local records
  if the module were ever shared again).
- The portal home page (`staff-portal/index.html`) renders the tracker dashboard itself. `tracker.js`
  mounts on `#tracker-dashboard` in embedded mode: no tab bar, and `data-jump` links leave for
  `tracker.html` because the hash belongs to the host page.
- Tracker navigation is two levels (`SECTIONS` in `tracker.js`): Dashboard / Clients / Staff / Agency /
  Settings on top, and the views within a section below it — so the sub-labels can be short
  ("Roster", "Files") because the section already says whose they are. Sections are derived from the
  tab via `sectionOf()` and never appear in the hash, so `#clientsup:id` style links keep working.
  Section keys are deliberately distinct from tab keys (`clientarea`, not `clients`) to avoid a
  routing collision. Add a new tab by putting it in a section — `TABS` is derived from `SECTIONS`.
- Removed: the staff "Supervision & Observation" module. The note-taking software already tracks QSP
  observation of staff, and a second record of it is a second thing to keep in step. `RETIRED_KEYS`
  in `tracker.js` clears what it left behind — localStorage and the server blob — once per browser,
  guarded by `LS_RETIRED`. `"supervision"` stays in the edge function's allowlist ONLY so that
  DELETE can reach it. Client Supervision (`clientsup`) is a different thing and stays.
- Expiration notifications: `netlify/functions/notify.mjs`, a Netlify SCHEDULED function (daily
  13:00 UTC). This is the only reason the repo has a `package.json` — the site itself still has no
  build step, but a Node function needs `@netlify/blobs` installed to read the tracker's blobs.
  - It can only notify on SHARED, non-PHI modules: staff credentials, agency renewals, and payroll
    & billing reminders. Client authorizations, client supervision and client files are local to a
    browser by design, so a server-side job cannot see them and an email can never carry a client
    name. This is the trade, not a gap — do not "fix" it by sharing a PHI module.
  - Escalation, not repetition: an item is announced when it crosses 60/30/14/7/3/1 days and then
    overdue, each step once, tracked in the `ntc-notify` blob store keyed `mod:id:dueDate` (so
    rescheduling an item legitimately re-announces it). State is only written if a channel actually
    delivered — a bad API key must not silently swallow a cycle.
  - Delivery is whatever is configured: `RESEND_API_KEY` or `SENDGRID_API_KEY` with `NOTIFY_TO` for
    email, `TWILIO_*` with `NOTIFY_SMS_TO` for a text nudge, `NOTIFY_WEBHOOK` for anything else.
    All optional; with none set the job runs and reports that it sent nothing.
  - Manual runs need `NOTIFY_TEST_KEY`: `?key=…&dry=1` previews the digest as JSON without sending,
    `&force=1` ignores the escalation state. A bare POST is treated as the schedule and can only do
    the ordinary thing; `force` and `dry` always require the key so the URL cannot be used as a
    mail loop.
