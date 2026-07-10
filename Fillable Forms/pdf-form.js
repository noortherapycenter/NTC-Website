/* ============================================================
   Noor Therapy Center — PDF overlay forms
   Renders the ORIGINAL government PDF (unchanged) onto canvases
   and overlays fillable fields exactly where the PDF's own form
   fields sit. Typed signatures render in cursive. Nothing is stored:
   the form starts blank on every load — use “Save my progress” to
   keep a copy. Print = the real document with your answers.
   Requires: pdfjs-dist 3.11 UMD loaded as window.pdfjsLib, and
   window.PDF_FORM = { key, title, pdf, extra?:[
     {p,l,tp,w,h,sig?,ml?} ] } set before this script runs.
   ============================================================ */
(function () {
  'use strict';
  var CFG = window.PDF_FORM;
  if (!CFG || !window.pdfjsLib) return;
  var pdfjs = window.pdfjsLib;

  // classic worker via blob (CDN workers can't be spawned directly)
  try {
    var wb = new Blob(["importScripts('https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js');"], { type: 'text/javascript' });
    pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(wb);
  } catch (e) {}

  var LS_KEY = 'noor-pdf-' + CFG.key;
  var store = {};
  // No auto-persistence: the form starts blank every visit. Also clear any
  // data an older version of this page left in localStorage.
  try { localStorage.removeItem(LS_KEY); } catch (e) {}
  var saveTimer, savedEl;

  /* ---- Dark mode (screen only; print/PDF always light) ---- */
  var THEME_KEY = 'noor-portal-theme';
  function applyTheme() {
    var dark = false;
    try { dark = localStorage.getItem(THEME_KEY) === 'dark'; } catch (e) {}
    if (dark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    var b = document.querySelector('.pf-theme');
    if (b) {
      b.textContent = dark ? '\u2600' : '\u263E';
      b.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    }
  }
  applyTheme();
  window.addEventListener('storage', applyTheme);
  window.addEventListener('pageshow', applyTheme);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) applyTheme();
  });

  function persist() {
    // intentionally no storage — entries live only on this page view;
    // “Save my progress” writes an explicit file instead
  }

  /* ---------- zoom / device (screen only) ---------- */
  var ZOOM_MIN = 0.6, ZOOM_MAX = 2, ZOOM_STEP = 0.1;
  var zoom = 1;
  function setZoom(z) {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
    document.documentElement.style.setProperty('--pf-zoom', zoom);
    var val = document.querySelector('.pf-zoom-val');
    if (val) val.textContent = Math.round(zoom * 100) + '%';
    requestAnimationFrame(fitFonts);
  }
  function setDevice(mode) {
    var phone = mode === 'phone';
    document.body.classList.toggle('pf-phone', phone);
    if (phone) setZoom(1);
    document.querySelectorAll('.pf-view .seg').forEach(function (s) {
      s.classList.toggle('active', s.getAttribute('data-view') === mode);
    });
    requestAnimationFrame(fitFonts);
  }
  function autoDevice() {
    var small = window.matchMedia('(max-width: 760px)').matches;
    var coarse = window.matchMedia('(pointer: coarse)').matches;
    setDevice(small || coarse ? 'phone' : 'computer');
  }

  /* ---------- share ---------- */
  function shareForm() {
    var url = location.href.split('#')[0];
    var title = CFG.title || document.title || 'Noor Therapy Center form';
    if (navigator.share) {
      navigator.share({ title: title, text: 'Please complete this form for Noor Therapy Center:', url: url }).catch(function () {});
      return;
    }
    openSharePopover(url, title);
  }
  function openSharePopover(url, title) {
    closeSharePopover();
    var pop = document.createElement('div');
    pop.className = 'share-pop no-print';
    pop.innerHTML =
      '<button class="close" data-act="x" aria-label="Close">\u00d7</button>' +
      '<h4>Share this form</h4>' +
      '<p>Send the link so anyone can fill it out on their phone or computer.</p>' +
      '<input class="url" readonly value="' + url.replace(/"/g, '&quot;') + '"/>' +
      '<div class="row">' +
        '<button data-act="copy">Copy link</button>' +
        '<button class="alt" data-act="email">Email</button>' +
      '</div>';
    document.body.appendChild(pop);
    var input = pop.querySelector('.url');
    input.addEventListener('focus', function () { input.select(); });
    pop.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      var act = b.getAttribute('data-act');
      if (act === 'x') { closeSharePopover(); }
      else if (act === 'copy') { copyText(url); toast('Link copied to clipboard'); closeSharePopover(); }
      else if (act === 'email') {
        window.location.href = 'mailto:?subject=' + encodeURIComponent(title) +
          '&body=' + encodeURIComponent('Please complete this form for Noor Therapy Center:\n\n' + url);
        closeSharePopover();
      }
    });
    setTimeout(function () { document.addEventListener('click', outsideShare, true); }, 0);
  }
  function outsideShare(e) {
    if (e.target.closest('.share-pop') || e.target.closest('[data-act="share"]')) return;
    closeSharePopover();
  }
  function closeSharePopover() {
    var p = document.querySelector('.share-pop');
    if (p) p.remove();
    document.removeEventListener('click', outsideShare, true);
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { legacyCopy(text); });
    } else { legacyCopy(text); }
  }
  function legacyCopy(text) {
    var t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.focus(); t.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(t);
  }
  var toastTimer;
  function toast(msg) {
    var el = document.querySelector('.pf-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'pf-toast no-print';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    requestAnimationFrame(function () { el.classList.add('show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  /* ---------- chrome ---------- */
  function buildChrome() {
    var bar = document.createElement('div');
    bar.className = 'pf-toolbar no-print';
    bar.innerHTML =
      '<button type="button" class="pf-back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>Back</button>' +
      '<span class="pf-title"></span>' +
      '<div class="pf-group pf-zoomg">' +
        '<button type="button" class="zoom" data-act="zoom-out" title="Zoom out" aria-label="Zoom out">\u2212</button>' +
        '<button type="button" class="pf-zoom-val" data-act="zoom-reset" title="Reset zoom">100%</button>' +
        '<button type="button" class="zoom" data-act="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>' +
      '</div>' +
      '<div class="pf-group pf-view">' +
        '<button type="button" class="seg active" data-view="computer">Computer</button>' +
        '<button type="button" class="seg" data-view="phone">Phone</button>' +
      '</div>' +
      '<button type="button" class="pf-share" data-act="share">Share</button>' +
      '<button type="button" class="pf-pdf" title="Choose &quot;Save as PDF&quot; as the destination">Download PDF</button>' +
      '<button type="button" class="pf-print" title="Send to a printer">Print</button>' +
      '<button type="button" class="pf-theme" title="Switch to dark mode">\u263E</button>' +
      '<button type="button" class="pf-clear">Clear</button>';
    document.body.insertBefore(bar, document.body.firstChild);
    bar.querySelector('.pf-title').textContent = CFG.title || document.title;

    bar.querySelector('.pf-back').addEventListener('click', function () {
      var ref = document.referrer;
      if (ref && history.length > 1) {
        try { if (new URL(ref).origin === location.origin) { history.back(); return; } } catch (e) {}
      }
      location.href = '../staff-portal/forms.html';
    });
    bar.querySelector('.pf-pdf').addEventListener('click', function () { window.print(); });
    bar.querySelector('.pf-print').addEventListener('click', function () { window.print(); });
    bar.querySelector('.pf-share').addEventListener('click', shareForm);
    bar.addEventListener('click', function (e) {
      var view = e.target.closest('[data-view]');
      if (view) { setDevice(view.getAttribute('data-view')); return; }
      var b = e.target.closest('button[data-act]');
      if (!b) return;
      switch (b.getAttribute('data-act')) {
        case 'zoom-in':    setZoom(zoom + ZOOM_STEP); break;
        case 'zoom-out':   setZoom(zoom - ZOOM_STEP); break;
        case 'zoom-reset': setZoom(1); break;
      }
    });
    autoDevice();

    // Save / open progress (same affordance as the HTML forms)
    var sb = document.createElement('div');
    sb.className = 'pf-savebar no-print';
    sb.innerHTML =
      '<span class="fs-note">Working on this over multiple sittings?</span>' +
      '<button type="button" data-act="save" title="Save your answers as a file you can reopen later">Save my progress</button>' +
      '<button type="button" data-act="open" title="Open a saved copy to keep working">Open a saved copy</button>';
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.noorform,.json,application/json';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) openProgress(fileInput.files[0]);
      fileInput.value = '';
    });
    sb.appendChild(fileInput);
    sb.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.getAttribute('data-act') === 'save') saveProgress();
      else if (b.getAttribute('data-act') === 'open') fileInput.click();
    });
    document.body.appendChild(sb);

    bar.querySelector('.pf-theme').addEventListener('click', function () {
      try {
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        localStorage.setItem(THEME_KEY, isDark ? 'light' : 'dark');
      } catch (err) {}
      applyTheme();
    });
    applyTheme();
    bar.querySelector('.pf-clear').addEventListener('click', function () {
      if (!window.confirm('Clear everything you have typed on this form?')) return;
      store = {};
      document.querySelectorAll('.pf-field[contenteditable]').forEach(function (el) { el.textContent = ''; });
      document.querySelectorAll('.pf-check.checked').forEach(function (el) { el.classList.remove('checked'); });
    });

    // admin-portal tabs when unlocked
    var authed = false;
    try { authed = sessionStorage.getItem('noor-admin-auth') === '1'; } catch (e) {}
    if (authed) {
      var base = '../staff-portal/';
      var tabs = document.createElement('div');
      tabs.className = 'portal-tabs no-print';
      tabs.innerHTML =
        '<a class="pt-brand" href="' + base + 'index.html"><img src="' + base + 'noor-mark.png" alt=""/>Noor Therapy Center — Admin Portal</a>' +
        '<nav><a href="' + base + 'index.html">Home</a><a href="' + base + 'forms.html" class="active">Forms</a><a href="' + base + 'policies.html">Policies</a><a href="' + base + 'handbook.html">Handbook</a><a href="' + base + 'onboarding.html">Onboarding</a></nav>';
      document.body.insertBefore(tabs, document.body.firstChild);
    }
  }

  /* ---------- field overlays ---------- */
  var fieldCounts = {};
  function fid(name) {
    var n = name || 'f';
    fieldCounts[n] = (fieldCounts[n] || 0) + 1;
    return n + '#' + fieldCounts[n];
  }

  /* ---- Save / open progress as a file ---- */
  function saveProgress() {
    var data = { app: 'noor-pdf-forms', v: 1, key: CFG.key, title: CFG.title || document.title, saved: new Date().toISOString(), store: store };
    var name = (CFG.title || 'form').replace(/[^\w\- ]+/g, '').replace(/\s+/g, ' ').trim() + ' — in progress.noorform';
    var blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function openProgress(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!data || data.app !== 'noor-pdf-forms' || !data.store) throw new Error('bad');
        if (data.key !== CFG.key && !window.confirm('This saved copy is from a different form (“' + (data.title || data.key) + '”). Load it here anyway?')) return;
        store = data.store;
        // fill fields that are already on screen; pages still rendering
        // pick their values up from the store as they are built
        document.querySelectorAll('.pf-field[contenteditable]').forEach(function (el) {
          var v = store[el.getAttribute('data-id')];
          el.textContent = v || '';
        });
        document.querySelectorAll('.pf-check').forEach(function (el) {
          el.classList.toggle('checked', !!store[el.getAttribute('data-id')]);
        });
      } catch (e) {
        window.alert('That file is not a saved copy of a Noor form.');
      }
    };
    reader.readAsText(file);
  }

  function isSig(f) {
    if (f.t === 'Sig' || f.sig) return true;
    // Only look at the field's own name (last segment), not its parent
    // group path — e.g. "sfSignature[0].QSPApplicantName[0]" is a NAME
    // field that merely lives inside a signature section.
    var n = (f.name || '').toLowerCase().split('.').pop();
    return /sign/.test(n) && !/date|print|title|designee|assign|name/.test(n);
  }

  function addField(layer, f) {
    var id = fid(f.name);
    var el;
    if (f.t === 'Btn' && !f.push) {
      el = document.createElement('div');
      el.className = 'pf-check';
      el.setAttribute('role', 'checkbox');
      if (store[id]) el.classList.add('checked');
      el.addEventListener('click', function () {
        if (f.radio && !el.classList.contains('checked')) {
          // exclusive within same name group
          document.querySelectorAll('[data-group="' + (f.name || '') + '"]').forEach(function (o) {
            o.classList.remove('checked');
            delete store[o.getAttribute('data-id')];
          });
        }
        el.classList.toggle('checked');
        if (el.classList.contains('checked')) store[id] = 1; else delete store[id];
        persist();
      });
      el.setAttribute('data-group', f.name || '');
    } else {
      el = document.createElement('div');
      el.className = 'pf-field' + (isSig(f) ? ' pf-sig' : '') + (f.ml ? ' pf-ml' : '');
      el.setAttribute('contenteditable', 'true');
      el.setAttribute('spellcheck', 'false');
      if (store[id]) el.textContent = store[id];
      if (!f.ml) {
        el.addEventListener('keydown', function (e) { if (e.key === 'Enter') e.preventDefault(); });
      }
      el.addEventListener('input', function () {
        var v = el.textContent;
        if (v) store[id] = v; else delete store[id];
        // sync same-name fields (e.g. provider name repeated per page)
        if (f.name) {
          document.querySelectorAll('.pf-field[data-name="' + CSS.escape(f.name) + '"]').forEach(function (o) {
            if (o !== el && o.textContent !== v) {
              o.textContent = v;
              store[o.getAttribute('data-id')] = v;
              if (!v) delete store[o.getAttribute('data-id')];
            }
          });
        }
        persist();
      });
      el.setAttribute('data-name', f.name || '');
    }
    el.setAttribute('data-id', id);
    el.style.left = f.l + '%';
    el.style.top = f.tp + '%';
    el.style.width = f.w + '%';
    el.style.height = f.h + '%';
    layer.appendChild(el);
  }

  function fitFonts() {
    document.querySelectorAll('.pf-page').forEach(function (pg) {
      var w = pg.clientWidth;
      pg.querySelectorAll('.pf-field').forEach(function (el) {
        var h = el.clientHeight;
        var fs = el.classList.contains('pf-sig') ? Math.min(h * 0.78, w * 0.03) : Math.min(h * 0.62, w * 0.018);
        el.style.fontSize = Math.max(8, fs) + 'px';
        if (!el.classList.contains('pf-ml')) el.style.lineHeight = h + 'px';
      });
      pg.querySelectorAll('.pf-check').forEach(function (el) {
        el.style.fontSize = (el.clientHeight * 0.9) + 'px';
      });
    });
  }

  /* ---------- render ---------- */
  async function main() {
    buildChrome();
    var mount = document.getElementById('pf-pages') || (function () {
      var m = document.createElement('main');
      m.id = 'pf-pages';
      document.body.appendChild(m);
      return m;
    })();

    var loadNote = document.createElement('div');
    loadNote.className = 'pf-loading no-print';
    loadNote.textContent = 'Loading the official document…';
    mount.appendChild(loadNote);

    try {
      var doc = await pdfjs.getDocument({
        url: CFG.pdf,
        standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/standard_fonts/',
        cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
        cMapPacked: true
      }).promise;
    } catch (e) {
      loadNote.textContent = 'Could not load the document. Check your connection and reload.';
      return;
    }

    loadNote.remove();
    var SCALE = Math.min(2, (window.devicePixelRatio || 1) * 1.4);
    if (SCALE < 1.5) SCALE = 1.5;

    for (var p = 1; p <= doc.numPages; p++) {
      var page = await doc.getPage(p);
      var vp1 = page.getViewport({ scale: 1 });
      var vp = page.getViewport({ scale: SCALE });
      var wrap = document.createElement('div');
      wrap.className = 'pf-page';
      wrap.style.aspectRatio = (vp1.width / vp1.height).toFixed(4);
      var canvas = document.createElement('canvas');
      canvas.width = vp.width; canvas.height = vp.height;
      wrap.appendChild(canvas);
      var layer = document.createElement('div');
      layer.className = 'pf-layer';
      wrap.appendChild(layer);
      mount.appendChild(wrap);

      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, annotationMode: 0 }).promise;

      var anns = await page.getAnnotations();
      for (var i = 0; i < anns.length; i++) {
        var a = anns[i];
        if (a.subtype !== 'Widget' || a.hidden) continue;
        if (a.fieldType === 'Btn' && a.pushButton) continue;
        var r = a.rect;
        addField(layer, {
          name: a.fieldName || '',
          t: a.fieldType,
          ml: !!a.multiLine,
          radio: !!a.radioButton,
          l: r[0] / vp1.width * 100,
          tp: (vp1.height - r[3]) / vp1.height * 100,
          w: (r[2] - r[0]) / vp1.width * 100,
          h: (r[3] - r[1]) / vp1.height * 100
        });
      }
      // manual extra fields (e.g. W-4 signature line, which is not an AcroForm field)
      (CFG.extra || []).filter(function (f) { return f.p === p; }).forEach(function (f) {
        addField(layer, f);
      });
    }
    fitFonts();
    window.addEventListener('resize', fitFonts);
  }

  if (document.readyState !== 'loading') main();
  else document.addEventListener('DOMContentLoaded', main);
})();
