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
