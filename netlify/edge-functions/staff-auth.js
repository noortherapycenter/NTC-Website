// Noor Therapy Center — server-side PIN lock for the admin area.
// Shows a styled 4-digit unlock screen; the code is checked HERE on the
// server, never in the browser. A signed cookie keeps the portal unlocked
// for 1 hour, then it asks again.

// The PIN and the cookie signing key come from Netlify environment
// variables — never from this file, which is in a git repo. Set both under
// Netlify -> Site configuration -> Environment variables:
//   STAFF_PIN             the 6-digit staff code
//   STAFF_COOKIE_SECRET   a long random string that signs the unlock cookie
// If either is missing the portal stays locked for everyone (fail closed).
const HOURS = 1;                    // how long an unlock lasts

function env(name) {
  try { if (typeof Netlify !== "undefined" && Netlify.env) return Netlify.env.get(name); } catch (e) {}
  try { if (typeof Deno !== "undefined" && Deno.env) return Deno.env.get(name); } catch (e) {}
  return "";
}

// Progressive lockout: after 5 wrong tries from the same address,
// require a 30-second wait before the next attempt. Best-effort,
// in-memory per edge node — resets on redeploy.
const fails = new Map();
const MAX_TRIES = 5;
const LOCK_MS = 30 * 1000;

const enc = new TextEncoder();

async function sign(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function loginPage(error) {
  const msg = error || "";
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex, nofollow"/>
<title>Staff Access — Noor Therapy Center</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,700;9..40,800&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family:'DM Sans',system-ui,sans-serif; background:#fdfaf3; color:#1f2e1a;
         min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
  a { color:#2aa63a; } a:hover { color:#1f8a2e; }
  .card { width:100%; max-width:400px; background:#fff; border:1.5px solid #e6e0cc; border-radius:20px;
          padding:40px 36px 34px; text-align:center; box-shadow:0 24px 60px -30px rgba(31,46,26,.25); }
  .card img { height:56px; margin-bottom:18px; }
  h1 { font-size:22px; font-weight:800; letter-spacing:-0.02em; margin:0 0 6px; }
  .sub { color:#4a5545; font-size:13.5px; margin:0 0 26px; line-height:1.5; }
  .code { display:flex; justify-content:center; gap:8px; margin-bottom:22px; }
  .code input { width:44px; height:56px; border:1.8px solid #e6e0cc; border-radius:12px; font-family:inherit;
                font-size:24px; font-weight:800; text-align:center; color:#1f2e1a; background:#fdfaf3; outline:none; }
  .code input:focus { border-color:#2aa63a; background:#fff; box-shadow:0 0 0 3px rgba(42,166,58,.15); }
  .msg { min-height:18px; font-size:12.5px; font-weight:700; color:#d64545; margin-bottom:14px; }
  button { width:100%; font-family:inherit; font-size:14.5px; font-weight:700; color:#fff; background:#2aa63a;
           border:0; border-radius:12px; padding:14px; cursor:pointer; }
  button:hover { background:#23902f; }
  .back { display:inline-block; margin-top:20px; font-size:13px; font-weight:600; text-decoration:none; }
</style>
</head>
<body>
  <div class="card">
    <img src="/assets/noor-logo-mark.png" alt="Noor Therapy Center"/>
    <h1>Staff Access</h1>
    <p class="sub">Enter the 6-digit staff code to open the admin portal.</p>
    <form method="post">
      <div class="code">
        <input type="password" inputmode="numeric" maxlength="1" aria-label="Digit 1"/>
        <input type="password" inputmode="numeric" maxlength="1" aria-label="Digit 2"/>
        <input type="password" inputmode="numeric" maxlength="1" aria-label="Digit 3"/>
        <input type="password" inputmode="numeric" maxlength="1" aria-label="Digit 4"/>
        <input type="password" inputmode="numeric" maxlength="1" aria-label="Digit 5"/>
        <input type="password" inputmode="numeric" maxlength="1" aria-label="Digit 6"/>
      </div>
      <input type="hidden" name="pin"/>
      <div class="msg">${msg}</div>
      <button type="submit">Unlock</button>
    </form>
    <a class="back" href="/index.html">&larr; Back to website</a>
  </div>
<script>
(function () {
  var inputs = Array.prototype.slice.call(document.querySelectorAll('.code input'));
  var form = document.querySelector('form');
  var pin = document.querySelector('input[name="pin"]');
  inputs[0].focus();
  inputs.forEach(function (inp, i) {
    inp.addEventListener('input', function () {
      inp.value = inp.value.replace(/\\D/g, '').slice(-1);
      if (inp.value && i < inputs.length - 1) inputs[i + 1].focus();
      if (inputs.every(function (x) { return x.value; })) submit();
    });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && !inp.value && i > 0) inputs[i - 1].focus();
    });
  });
  form.addEventListener('submit', function () { collect(); });
  function collect() { pin.value = inputs.map(function (x) { return x.value; }).join(''); }
  function submit() { collect(); form.submit(); }
})();
</script>
</body>
</html>`, {
    status: 401,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export default async (request, context) => {
  const url = new URL(request.url);
  const PIN = env("STAFF_PIN");
  const SECRET = env("STAFF_COOKIE_SECRET");

  // Missing configuration must lock the door, not open it.
  if (!PIN || !SECRET) {
    return new Response(
      "<!doctype html><meta charset=utf-8><title>Portal unavailable</title>" +
      "<body style=\"font-family:system-ui;background:#fdfaf3;color:#1f2e1a;padding:40px\">" +
      "<h1>Portal unavailable</h1><p>The staff code is not configured. Set " +
      "<code>STAFF_PIN</code> and <code>STAFF_COOKIE_SECRET</code> in the Netlify " +
      "environment variables, then redeploy.</p>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
    );
  }

  // Already unlocked? Check the signed cookie.
  const cookies = request.headers.get("cookie") || "";
  const m = cookies.match(/ntc_staff=([^;]+)/);
  if (m) {
    const parts = m[1].split(".");
    if (parts.length === 2 && Date.now() < Number(parts[0]) && parts[1] === (await sign(parts[0], SECRET))) {
      return context.next();
    }
  }

  // PIN submitted?
  if (request.method === "POST") {
    const ip = context.ip || request.headers.get("x-nf-client-connection-ip") || "unknown";
    const rec = fails.get(ip);
    if (rec && rec.count >= MAX_TRIES && Date.now() < rec.until) {
      const secs = Math.ceil((rec.until - Date.now()) / 1000);
      return loginPage("Too many attempts — wait " + secs + " seconds and try again");
    }
    let entered = "";
    try { entered = String((await request.formData()).get("pin") || ""); } catch (e) {}
    if (entered === PIN) {
      fails.delete(ip);
      const exp = String(Date.now() + HOURS * 3600 * 1000);
      const cookie = `ntc_staff=${exp}.${await sign(exp, SECRET)}; Path=/; Max-Age=${HOURS * 3600}; HttpOnly; Secure; SameSite=Lax`;
      return new Response(null, {
        status: 303,
        headers: { Location: url.pathname, "Set-Cookie": cookie, "Cache-Control": "no-store" },
      });
    }
    // Wrong code: count it, slow down guessing, then re-show the form.
    const next = { count: (rec && Date.now() < rec.until + LOCK_MS ? rec.count : 0) + 1, until: Date.now() + LOCK_MS };
    fails.set(ip, next);
    await new Promise((r) => setTimeout(r, 1500));
    return loginPage(next.count >= MAX_TRIES ? "Too many attempts — wait 30 seconds and try again" : "Incorrect code — try again");
  }

  return loginPage(false);
};
