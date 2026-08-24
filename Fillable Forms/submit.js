/* ============================================================
   Noor Therapy Center — form submission
   Adds a bar at the bottom of every fillable form: Save PDF,
   Print, and — when the form is linked to someone — Submit.
   Submit renders the COMPLETED form to a real PDF in the browser
   and files it against that person. Works for both doc-page HTML
   forms and PDF-overlay forms.

   Print and Save PDF never depend on the network, which is the
   point: the paper path has to keep working when nothing else does.

   Where a submission goes is decided by who it is for — see file()
   below. This replaced a Netlify Forms POST that mailed a PDF of
   every completed form, client paperwork included, to one inbox.
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

  /* ---------------- Packet context ----------------
   * Which staff member or client this form belongs to. Loaded lazily so the
   * 43 form pages do not each need a second script tag.
   */
  var P = null;

  function loadPacket() {
    if (window.NoorPacket) { P = window.NoorPacket; return Promise.resolve(); }
    return loadScript('/packet.js')
      .then(function () { P = window.NoorPacket || null; })
      .catch(function () { P = null; });
  }

  function formTitle() {
    return (document.title || 'Form').replace(/\s*[\u2014\u00b7|].*$/, '').trim();
  }

  // What this form is, and who it is for. `kind` comes from the form's own
  // catalog entry when it has one, so a client form filed while a staff packet
  // is open is caught rather than silently misfiled.
  function context() {
    var packet = P ? P.get() : null;
    var info = P ? P.formInfo() : null;
    var kind = info ? info.kind : (packet ? packet.kind : null);
    return {
      packet: packet,
      info: info,
      kind: kind,
      docId: info ? info.doc : '',
      mismatch: !!(packet && info && info.kind !== packet.kind)
    };
  }

  ready(function () {
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);

    var bar = document.createElement('div');
    bar.className = 'submit-bar no-print';
    document.body.appendChild(bar);

    var btn, altBtn, printBtn, status;

    function say(msg, cls) {
      if (!status) return;
      status.textContent = msg;
      status.className = 'sb-status' + (cls ? ' ' + cls : '');
      if (msg) status.style.display = 'block';
    }

    function note() {
      var c = context();
      if (!P) {
        return '<strong>Print or save this form.</strong> Filing it against a person needs the ' +
          'staff portal, which this page could not reach.';
      }
      if (c.mismatch) {
        return '<strong>This is a ' + c.info.kind + ' form, but the open packet is a ' +
          c.packet.kind + '.</strong> Switch the packet in ' +
          '<a href="/staff-portal/onboarding.html">Onboarding</a> before submitting.';
      }
      if (!c.packet) {
        return '<strong>Not linked to anyone yet.</strong> Choose a person in ' +
          '<a href="/staff-portal/onboarding.html">Onboarding</a> and this form files itself against ' +
          'them. You can still print or save a copy now.';
      }
      if (c.kind === 'client') {
        return '<strong>For ' + escapeHtml(c.packet.name) + '.</strong> Submitting records this form ' +
          'as completed on their file checklist and saves you a PDF copy. The document itself is not ' +
          'uploaded \u2014 client paperwork stays with the record system and the printed file.';
      }
      return '<strong>For ' + escapeHtml(c.packet.name) + '.</strong> Submitting files a PDF of this ' +
        'completed form against their employee file.';
    }

    function paint() {
      var c = context();
      var blocked = !P || c.mismatch || !c.packet;
      bar.innerHTML =
        '<div class="sb-note">' + note() + '</div>' +
        '<button type="button" class="sb-btn sb-alt-btn">Save PDF</button>' +
        '<button type="button" class="sb-btn sb-print-btn">Print</button>' +
        (blocked ? '' : '<button type="button" class="sb-btn">Submit form</button>') +
        '<span class="sb-status"></span>';
      btn = bar.querySelector('.sb-btn:not(.sb-alt-btn):not(.sb-print-btn)');
      altBtn = bar.querySelector('.sb-alt-btn');
      printBtn = bar.querySelector('.sb-print-btn');
      status = bar.querySelector('.sb-status');

      printBtn.addEventListener('click', function () { window.print(); });

      altBtn.addEventListener('click', function () {
        altBtn.disabled = true;
        say('Preparing PDF\u2026');
        buildPdf().then(function (blob) {
          download(blob);
          say('Saved to your downloads.', 'ok');
        }).catch(function (err) {
          say(errText(err), 'err');
        }).then(function () { altBtn.disabled = false; });
      });

      if (!btn) return;
      btn.addEventListener('click', function () {
        var ctx = context();
        btn.disabled = true;
        say('Preparing PDF\u2026');
        buildPdf().then(function (blob) {
          say(ctx.kind === 'client' ? 'Recording\u2026' : 'Filing\u2026');
          return file(blob, ctx);
        }).then(function (result) {
          say('', '');
          showDone(result);
        }).catch(function (err) {
          say(errText(err), 'err');
        }).then(function () { btn.disabled = false; });
      });
    }

    loadPacket().then(paint);
  });

  function errText(err) {
    return (err && err.message) ||
      'Something went wrong \u2014 please try again, or print the form instead.';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function safeName() {
    return formTitle().replace(/[^\w\- ]+/g, '').replace(/\s+/g, ' ').trim() || 'form';
  }

  function download(blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = safeName() + '.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  /* ---------------- Submitted screen ---------------- */
  function showDone(result) {
    var who = escapeHtml((result && result.name) || 'this person');
    var body = (result && result.kind === 'client')
      ? 'Recorded as completed on ' + who + '\u2019s file checklist, and a PDF copy has been saved to ' +
        'your downloads. Keep that copy with the client file \u2014 it is not stored on this site.'
      : 'Filed against ' + who + '\u2019s employee file. You can reopen it any time from the tracker.';
    if (result && result.ticked === false) {
      body += ' This form does not map to a checklist item, so nothing was ticked off.';
    }

    var ov = document.createElement('div');
    ov.className = 'sb-done no-print';
    ov.setAttribute('data-screen-label', 'Form submitted screen');
    ov.innerHTML =
      '<div class="sd-card">' +
        '<img src="noor-logo.png" alt="Noor Therapy Center"/>' +
        '<div class="sd-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"></path></svg></div>' +
        '<h1>Done \u2014 thank you!</h1>' +
        '<p>' + body + '</p>' +
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

  /* ---------------- Filing a completed form ----------------
   *
   * This replaces the old Netlify Forms POST, which mailed a PDF of EVERY
   * completed form \u2014 client intakes, medical information, I-9s and direct
   * deposit details among them \u2014 into the Netlify Forms inbox. Two different
   * destinations now, decided by who the form is for:
   *
   *   staff  -> the PDF is stored against their employee file (/api/documents,
   *             behind the staff cookie) and the matching checklist item is
   *             ticked.
   *   client -> NOTHING is uploaded. The checklist item is ticked and the PDF
   *             is handed to the person filling it in. Client paperwork is PHI
   *             and this storage carries no business associate agreement, so
   *             the document stays with the record system and the paper file.
   *
   * Either way the checklist update goes through the inbox in /packet.js, so
   * it survives a failed network and is applied once by the tracker.
   */
  function file(blob, ctx) {
    if (!P) return Promise.reject(new Error('The staff portal script is not loaded.'));
    if (!ctx.packet) return Promise.reject(new Error('This form is not linked to anyone yet.'));
    if (ctx.mismatch) return Promise.reject(new Error('The open packet is for a ' + ctx.packet.kind + '.'));

    var title = formTitle();

    if (ctx.kind === 'client') {
      // Hand over the copy first: if the download is blocked, the person still
      // needs to know before the form is marked done.
      download(blob);
      if (ctx.docId) {
        P.markDoc('client', ctx.packet.id, ctx.docId, {
          note: title + ' completed ' + new Date().toLocaleDateString()
        });
      }
      return Promise.resolve({ kind: 'client', name: ctx.packet.name, ticked: !!ctx.docId });
    }

    var q = '?kind=staff' +
      '&entityId=' + encodeURIComponent(ctx.packet.id) +
      '&entityName=' + encodeURIComponent(ctx.packet.name || '') +
      '&docId=' + encodeURIComponent(ctx.docId || '') +
      '&name=' + encodeURIComponent(title);

    return fetch('/api/documents' + q, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: blob
    }).then(function (r) {
      return r.json().catch(function () {
        throw new Error('The server sent back something unreadable.');
      }).then(function (body) {
        if (r.status === 401) {
          throw new Error('Your staff session has expired \u2014 reload and sign in, then submit again.');
        }
        if (!r.ok || !body.ok) throw new Error((body && body.error) || 'Could not file this form.');
        return body;
      });
    }).then(function (body) {
      if (ctx.docId) {
        P.markDoc('staff', ctx.packet.id, ctx.docId, {
          note: title + ' filed ' + new Date().toLocaleDateString(),
          file: { id: body.id, name: title }
        });
      }
      return { kind: 'staff', name: ctx.packet.name, ticked: !!ctx.docId };
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
