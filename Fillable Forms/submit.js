/* ============================================================
   Noor Therapy Center — form submission
   Adds a "Submit form" bar at the bottom of every fillable form.
   On submit it renders the COMPLETED form to a real PDF in the
   browser and posts it to Netlify Forms (form name:
   "form-submissions"), where email notifications can be enabled.
   Works for both doc-page HTML forms and PDF-overlay forms.
   ============================================================ */
(function () {
  'use strict';

  var JSPDF_SRC = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
  var H2C_SRC = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
  var PAGE_W = 612, PAGE_H = 792; // letter, pt

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  function loadScript(src) {
    return new Promise(function (res, rej) {
      if (document.querySelector('script[src="' + src + '"]')) return res();
      var s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = function () { rej(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  /* ---------------- UI ---------------- */
  var css =
    '.submit-bar{max-width:850px;margin:10px auto 60px;padding:18px 22px;display:flex;flex-wrap:wrap;align-items:center;gap:14px;' +
      'background:#fff;border:1.5px solid #e6e0cc;border-radius:14px;font-family:"DM Sans",system-ui,sans-serif}' +
    '.submit-bar .sb-note{flex:1;min-width:220px;font-size:12.5px;line-height:1.5;color:#6b7561}' +
    '.submit-bar .sb-note strong{color:#1f2e1a}' +
    '.submit-bar .sb-btn{font-family:inherit;font-size:13.5px;font-weight:800;color:#fff;background:#2aa63a;border:none;' +
      'border-radius:999px;padding:12px 26px;cursor:pointer;white-space:nowrap}' +
    '.submit-bar .sb-btn:hover{background:#1f8a2e}' +
    '.submit-bar .sb-btn[disabled]{opacity:.6;cursor:default}' +
    '.submit-bar .sb-status{flex-basis:100%;font-size:12.5px;font-weight:700;color:#6b7561;display:none}' +
    '.submit-bar .sb-status.ok{display:block;color:#1f8a2e}' +
    '.submit-bar .sb-status.err{display:block;color:#b0483f}' +
    '#pf-pages~.submit-bar{margin-top:0}' +
    '@media screen{' +
      'html[data-theme="dark"] .submit-bar{background:#1d2316;border-color:#2f3826}' +
      'html[data-theme="dark"] .submit-bar .sb-note{color:#a6b099}' +
      'html[data-theme="dark"] .submit-bar .sb-note strong{color:#e9ecdd}' +
    '}' +
    '@media print{.submit-bar{display:none!important}}' +
    /* submitted overlay */
    '.sb-done{position:fixed;inset:0;z-index:9999;background:#fdfaf3;display:grid;place-items:center;padding:24px;font-family:"DM Sans",system-ui,sans-serif}' +
    '.sb-done .sd-card{width:100%;max-width:440px;background:#fff;border:1.5px solid #e6e0cc;border-radius:20px;padding:44px 38px 38px;text-align:center;box-shadow:0 24px 60px -30px rgba(31,46,26,.25)}' +
    '.sb-done .sd-check{width:64px;height:64px;border-radius:999px;background:#eef7ea;display:grid;place-items:center;margin:0 auto 18px}' +
    '.sb-done .sd-check svg{width:30px;height:30px;color:#1f8a2e}' +
    '.sb-done img{height:44px;margin-bottom:16px}' +
    '.sb-done h1{font-size:24px;font-weight:800;letter-spacing:-0.02em;color:#1f2e1a;margin:0 0 8px}' +
    '.sb-done p{font-size:13.5px;line-height:1.6;color:#6b7561;margin:0 0 24px}' +
    '.sb-done .sd-btn{display:inline-block;font-family:inherit;font-size:14px;font-weight:800;color:#fff;background:#2aa63a;border:none;border-radius:999px;padding:13px 28px;cursor:pointer}' +
    '.sb-done .sd-btn:hover{background:#1f8a2e}' +
    '.sb-done .sd-stay{display:block;margin-top:14px;font-size:12.5px;font-weight:700;color:#6b7561;background:none;border:none;cursor:pointer;font-family:inherit;text-decoration:underline;margin-left:auto;margin-right:auto}' +
    '.sb-done .sd-stay:hover{color:#1f2e1a}' +
    '@media screen{html[data-theme="dark"] .sb-done{background:#14180f}' +
    'html[data-theme="dark"] .sb-done .sd-card{background:#1d2316;border-color:#2f3826}' +
    'html[data-theme="dark"] .sb-done h1{color:#e9ecdd}' +
    'html[data-theme="dark"] .sb-done .sd-check{background:rgba(76,194,91,.16)}}' +
    '@media print{.sb-done{display:none!important}}' +
    /* capture wrapper: hide screen-only affordances, kill fill tints */
    '.pdf-capture [data-fill]{background:transparent!important;box-shadow:none!important}' +
    '.pdf-capture .row-del,.pdf-capture .row-grip,.pdf-capture .row-del-col,.pdf-capture .add-row{display:none!important}';

  ready(function () {
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);

    var bar = document.createElement('div');
    bar.className = 'submit-bar no-print';
    bar.innerHTML =
      '<div class="sb-note"><strong>Done filling it out?</strong> Submit sends a PDF copy of this completed form to the office.</div>' +
      '<button type="button" class="sb-btn">Submit form</button>' +
      '<span class="sb-status"></span>';
    document.body.appendChild(bar);

    var btn = bar.querySelector('.sb-btn');
    var status = bar.querySelector('.sb-status');

    function say(msg, cls) {
      status.textContent = msg;
      status.className = 'sb-status' + (cls ? ' ' + cls : '');
      if (msg) status.style.display = 'block';
    }

    btn.addEventListener('click', function () {
      btn.disabled = true;
      say('Preparing PDF\u2026');
      buildPdf().then(function (blob) {
        say('Sending\u2026');
        return send(blob);
      }).then(function () {
        say('', '');
        showDone();
      }).catch(function (err) {
        say((err && err.message) || 'Something went wrong \u2014 please try again or print the form instead.', 'err');
      }).then(function () {
        btn.disabled = false;
      });
    });
  });

  /* ---------------- Submitted screen ---------------- */
  function showDone() {
    var ov = document.createElement('div');
    ov.className = 'sb-done no-print';
    ov.setAttribute('data-screen-label', 'Form submitted screen');
    ov.innerHTML =
      '<div class="sd-card">' +
        '<img src="noor-logo.png" alt="Noor Therapy Center"/>' +
        '<div class="sd-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"></path></svg></div>' +
        '<h1>Submitted \u2014 thank you!</h1>' +
        '<p>Your completed form has been sent to the Noor Therapy Center office. You can safely leave this page.</p>' +
        '<button type="button" class="sd-btn">Back to previous page</button>' +
        '<button type="button" class="sd-stay">Stay on this form</button>' +
      '</div>';
    document.body.appendChild(ov);
    ov.querySelector('.sd-btn').addEventListener('click', function () {
      if (window.history.length > 1) history.back();
      else location.href = '../index.html';
    });
    ov.querySelector('.sd-stay').addEventListener('click', function () {
      ov.remove();
    });
  }

  /* ---------------- Netlify submission ---------------- */
  function send(blob) {
    var title = (document.title || 'Form').replace(/\s*[\u2014\u00b7|].*$/, '').trim();
    var name = title.replace(/[^\w\- ]+/g, '').replace(/\s+/g, ' ').trim() || 'form';
    var fd = new FormData();
    fd.append('form-name', 'form-submissions');
    fd.append('form-title', title);
    fd.append('submitted-at', new Date().toLocaleString());
    fd.append('page', location.pathname);
    fd.append('completed-pdf', new File([blob], name + '.pdf', { type: 'application/pdf' }));
    return fetch('/', { method: 'POST', body: fd }).then(function (r) {
      if (!r.ok) throw new Error('Submission failed (' + r.status + '). It only works on the live website.');
    });
  }

  /* ---------------- PDF building ---------------- */
  function buildPdf() {
    if (document.querySelector('#pf-pages .pf-page canvas')) return pdfFromPfPages();
    if (document.querySelector('doc-page')) return pdfFromDocPage();
    return Promise.reject(new Error('Nothing to submit on this page.'));
  }

  /* PDF-overlay forms: existing canvases + typed values drawn on top */
  function pdfFromPfPages() {
    return loadScript(JSPDF_SRC).then(function () {
      var pdf = new window.jspdf.jsPDF({ unit: 'pt', format: 'letter' });
      var pages = Array.prototype.slice.call(document.querySelectorAll('#pf-pages .pf-page'));
      if (!pages.length) throw new Error('The form has not finished loading yet.');
      pages.forEach(function (pg, i) {
        var src = pg.querySelector('canvas');
        var tmp = document.createElement('canvas');
        tmp.width = src.width; tmp.height = src.height;
        var ctx = tmp.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, tmp.width, tmp.height);
        ctx.drawImage(src, 0, 0);

        var pgRect = pg.getBoundingClientRect();
        var k = src.width / pgRect.width; // css px -> canvas px

        pg.querySelectorAll('.pf-field').forEach(function (f) {
          var t = f.textContent.replace(/\u00a0/g, ' ');
          if (!t.trim()) return;
          var r = f.getBoundingClientRect();
          var cs = getComputedStyle(f);
          var fs = parseFloat(cs.fontSize) * k;
          ctx.font = (cs.fontWeight || 400) + ' ' + fs + 'px ' + cs.fontFamily;
          ctx.fillStyle = cs.color;
          var x = (r.left - pgRect.left + 2) * k;
          if (f.classList.contains('pf-ml')) {
            ctx.textBaseline = 'top';
            wrapText(ctx, t, x, (r.top - pgRect.top + 2) * k, (r.width - 4) * k, fs * 1.25);
          } else {
            ctx.textBaseline = 'middle';
            ctx.fillText(t, x, (r.top - pgRect.top + r.height / 2) * k);
          }
        });

        pg.querySelectorAll('.pf-check.checked').forEach(function (c) {
          var r = c.getBoundingClientRect();
          var h = r.height * k;
          ctx.font = '800 ' + (h * 0.9) + 'px "DM Sans", sans-serif';
          ctx.fillStyle = '#0b2e63';
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'center';
          ctx.fillText('\u2713', (r.left - pgRect.left + r.width / 2) * k, (r.top - pgRect.top + r.height / 2) * k);
          ctx.textAlign = 'left';
        });

        if (i > 0) pdf.addPage();
        pdf.addImage(tmp.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, PAGE_W, PAGE_H);
      });
      return pdf.output('blob');
    });
  }

  function wrapText(ctx, text, x, y, maxW, lineH) {
    var words = text.split(/\s+/), line = '';
    words.forEach(function (w) {
      var probe = line ? line + ' ' + w : w;
      if (ctx.measureText(probe).width > maxW && line) {
        ctx.fillText(line, x, y);
        y += lineH;
        line = w;
      } else line = probe;
    });
    if (line) ctx.fillText(line, x, y);
  }

  /* doc-page HTML forms: clone the sheet content into a plain letter-width
     wrapper (shadow DOM can't be rasterized directly), rasterize, slice */
  function pdfFromDocPage() {
    return Promise.all([loadScript(JSPDF_SRC), loadScript(H2C_SRC)]).then(function () {
      var dp = document.querySelector('doc-page');
      var marginAttr = parseFloat(dp.getAttribute('margin')) || 0.75;
      var pad = Math.round(marginAttr * 96);

      var wasPhone = document.body.classList.contains('fill-phone');
      if (wasPhone) document.body.classList.remove('fill-phone');

      var wrap = document.createElement('div');
      wrap.className = 'pdf-capture';
      wrap.style.cssText = 'position:absolute;left:-10000px;top:0;width:816px;box-sizing:border-box;' +
        'background:#fff;padding:' + pad + 'px;font-family:"DM Sans",system-ui,sans-serif;filter:none';
      Array.prototype.forEach.call(dp.children, function (child) {
        if (child.getAttribute && child.getAttribute('slot')) return; // skip running header/footer
        wrap.appendChild(child.cloneNode(true));
      });
      document.body.appendChild(wrap);

      // Safe cut lines: the top of each block we must never slice through.
      var wrapRect = wrap.getBoundingClientRect();
      var cutsCss = [];
      wrap.querySelectorAll('.section, .form-title, .form-masthead, .callout, .office-use, .sign-row, .field, .checks, .fineprint, .writein, table.form-table tr, h3, p').forEach(function (el) {
        var r = el.getBoundingClientRect();
        var top = r.top - wrapRect.top;
        // Never cut right after a section header — keep the header attached
        // to its first block of content.
        var sec = el.closest('.section');
        if (sec && sec !== el) {
          var st = sec.getBoundingClientRect().top - wrapRect.top;
          if (top - st < 90) return;
        }
        cutsCss.push(top - 3); // cut a hair above the block so borders survive
      });

      return window.html2canvas(wrap, { scale: 2, backgroundColor: '#ffffff', logging: false })
        .then(function (canvas) {
          document.body.removeChild(wrap);
          if (wasPhone) document.body.classList.add('fill-phone');

          var k = canvas.width / wrapRect.width; // css px -> canvas px
          var cuts = cutsCss.map(function (c) { return Math.round(c * k); });

          var pdf = new window.jspdf.jsPDF({ unit: 'pt', format: 'letter' });
          var pageHpx = Math.floor(canvas.width * (PAGE_H / PAGE_W));
          var y = 0, first = true;
          while (y < canvas.height - 2) {
            var limit = y + pageHpx;
            var cut = Math.min(limit, canvas.height);
            if (limit < canvas.height) {
              // prefer breaking just above a block instead of through it
              var best = -1;
              cuts.forEach(function (c) {
                if (c > y + pageHpx * 0.35 && c <= limit && c > best) best = c;
              });
              if (best > 0) cut = best;
            }
            var slice = document.createElement('canvas');
            slice.width = canvas.width;
            slice.height = cut - y;
            var ctx = slice.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, slice.width, slice.height);
            ctx.drawImage(canvas, 0, y, canvas.width, slice.height, 0, 0, canvas.width, slice.height);
            if (!first) pdf.addPage();
            first = false;
            pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, PAGE_W, slice.height * (PAGE_W / canvas.width));
            y = cut;
          }
          return pdf.output('blob');
        })
        .catch(function (err) {
          if (wrap.parentNode) document.body.removeChild(wrap);
          if (wasPhone) document.body.classList.add('fill-phone');
          throw err;
        });
    });
  }
})();
