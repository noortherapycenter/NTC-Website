# Project notes

- The user deploys the site via GitHub Desktop (repo: noortherapycenter/NTC-Website → Netlify). Do NOT present a project ZIP after changes unless the user explicitly asks for one. When they ask, one full-project ZIP is the preferred format.
- Fillable form text color: body/label/check text uses the gray-green (--ink-soft); only the form title (h1) and section titles (.section-head h2) are black (--ink). Keep new forms consistent with this.
- The staff portal is protected by a Netlify edge function (netlify/edge-functions/staff-auth.js): server-side 4-digit PIN (1538), 1-hour unlock cookie.
