/* ============================================================
   Noor Therapy Center — fillable-mode behavior
   Type-on-screen forms with a Computer / Phone layout, on-screen
   zoom, share, print and PDF. No data is stored — the form starts
   blank on every load. All zoom / phone styling is screen-only, so
   the downloaded PDF always uses the fixed Letter layout.
   ============================================================ */
(function () {
  'use strict';

  // Stop iOS/Safari from auto-styling typed dates, phone numbers and
  // addresses (this was making the Date of Birth render differently).
  if (!document.querySelector('meta[name="format-detection"]')) {
    var fd = document.createElement('meta');
    fd.name = 'format-detection';
    fd.content = 'telephone=no,date=no,address=no,email=no';
    document.head.appendChild(fd);
  }

  var SINGLE = '.field .line, .sign-field .sig-line, .boxfield, .charboxes .cb, .blank';
  var MULTI  = '.writein';
  var CHECK  = '.check .box, .cbox';

  var ZOOM_MIN = 0.6, ZOOM_MAX = 2, ZOOM_STEP = 0.1;
  var zoom = 1;

  /* ---------------- Dark mode (screen only; print/PDF always light) ---------------- */
  var THEME_KEY = 'noor-portal-theme';
  function applyTheme() {
    var dark = false;
    try { dark = localStorage.getItem(THEME_KEY) === 'dark'; } catch (e) {}
    if (dark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    var b = document.querySelector('[data-act="theme"]');
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

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  function makeEditable(el, multiline) {
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('data-fill', '');
    el.setAttribute('spellcheck', 'false');
    if (!multiline) {
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') e.preventDefault();
      });
    }
  }

  function hydrate() {
    document.querySelectorAll(SINGLE).forEach(function (el) { makeEditable(el, false); });
    document.querySelectorAll(MULTI).forEach(function (el) { makeEditable(el, true); });

    document.querySelectorAll(CHECK).forEach(function (el) {
      el.setAttribute('data-check', '');
      el.addEventListener('click', function () { el.classList.toggle('checked'); });
    });

    markSignatures();

    // Empty ruled table cells become type-in cells; labeled/checkbox cells stay put.
    document.querySelectorAll('table.form-table td').forEach(function (td) {
      if (td.querySelector('.cbox, .box')) return;
      if (td.children.length === 0 && td.textContent.trim() === '') {
        makeEditable(td, false);
      }
    });

    // Wrap wide tables so they can scroll sideways in phone layout.
    document.querySelectorAll('table.form-table').forEach(function (t) {
      if (t.parentElement && t.parentElement.classList.contains('table-scroll')) return;
      var wrap = document.createElement('div');
      wrap.className = 'table-scroll';
      t.parentNode.insertBefore(wrap, t);
      wrap.appendChild(t);
    });

    enableAddRows();
  }

  function upgrade() {
    hydrate();
    buildToolbar();
    autoDevice();
    injectPortalTabs();
  }

  /* ---------------- Admin-portal tabs (only when unlocked) ---------------- */
  function injectPortalTabs() {
    var authed = false;
    try { authed = sessionStorage.getItem('noor-admin-auth') === '1'; } catch (e) {}
    if (!authed || document.querySelector('.portal-tabs')) return;
    var base = '../staff-portal/';
    var css = document.createElement('style');
    css.textContent =
      ".portal-tabs{position:sticky;top:0;z-index:9998;display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:rgba(253,250,243,.96);backdrop-filter:blur(8px);border-bottom:1.5px solid #e6e0cc;padding:10px 18px;font-family:'DM Sans',system-ui,sans-serif}" +
      '.portal-tabs .pt-brand{display:inline-flex;align-items:center;gap:9px;font-size:13px;font-weight:800;color:#1f2e1a;text-decoration:none}' +
      '.portal-tabs .pt-brand img{height:26px}' +
      '.portal-tabs nav{display:flex;gap:4px;margin-left:auto;flex-wrap:wrap}' +
      '.portal-tabs nav a{font-size:12.5px;font-weight:700;color:#4a5545;text-decoration:none;padding:7px 12px;border-radius:999px}' +
      '.portal-tabs nav a:hover{background:#f3eddd;color:#1f2e1a}' +
      '.portal-tabs nav a.active{background:#2aa63a;color:#fff}' +
      '@media (min-width:761px){body.has-portal-tabs .fill-back{top:74px}body.has-portal-tabs .fill-toolbar{top:74px}}' +
      '@media (max-width:760px){body.has-portal-tabs .fill-back{top:64px}}' +
      '@media print{.portal-tabs{display:none!important}}';
    document.head.appendChild(css);
    var bar = document.createElement('div');
    bar.className = 'portal-tabs no-print';
    bar.innerHTML =
      '<a class="pt-brand" href="' + base + 'index.html"><img src="' + base + 'noor-mark.png" alt=""/>Noor Therapy Center \u2014 Admin Portal</a>' +
      '<nav>' +
        '<a href="' + base + 'index.html">Home</a>' +
        '<a href="' + base + 'forms.html" class="active">Forms</a>' +
        '<a href="' + base + 'policies.html">Policies</a>' +
        '<a href="' + base + 'handbook.html">Handbook</a>' +
        '<a href="' + base + 'onboarding.html">Onboarding</a>' +
      '</nav>';
    document.body.insertBefore(bar, document.body.firstChild);
    document.body.classList.add('has-portal-tabs');
  }

  /* ---------------- Toolbar ---------------- */
  function buildToolbar() {
    if (document.querySelector('.fill-toolbar')) return;
    var bar = document.createElement('div');
    bar.className = 'fill-toolbar no-print';
    bar.innerHTML =
      '<div class="ft-group ft-zoom">' +
        '<button type="button" class="zoom" data-act="zoom-out" title="Zoom out" aria-label="Zoom out">\u2212</button>' +
        '<button type="button" class="ft-zoom-val" data-act="zoom-reset" title="Reset zoom">100%</button>' +
        '<button type="button" class="zoom" data-act="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>' +
      '</div>' +
      '<div class="ft-group ft-view">' +
        '<button type="button" class="seg active" data-view="computer">Computer</button>' +
        '<button type="button" class="seg" data-view="phone">Phone</button>' +
      '</div>' +
      '<span class="ft-sep"></span>' +
      '<button type="button" data-act="share">Share</button>' +
      '<button type="button" data-act="pdf" title="Choose &quot;Save as PDF&quot; as the destination">Download PDF</button>' +
      '<button type="button" data-act="print" title="Send to a printer">Print</button>' +
      '<button type="button" data-act="theme" class="ghost" title="Switch to dark mode">\u263E</button>' +
      '<button type="button" data-act="clear" class="ghost">Clear</button>';
    document.body.appendChild(bar);
    applyTheme();

    // hidden file input used by "Open"
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.noorform,.json,application/json';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) openProgress(fileInput.files[0]);
      fileInput.value = '';
    });
    document.body.appendChild(fileInput);
    bar._fileInput = fileInput;

    // Save / Open — rarely used, so it lives quietly at the end of the page
    if (!document.querySelector('.fill-savebar')) {
      var sb = document.createElement('div');
      sb.className = 'fill-savebar no-print';
      sb.innerHTML =
        '<span class="fs-note">Working on this over multiple sittings?</span>' +
        '<button type="button" data-act="save" title="Save an editable copy you can reopen later">Save my progress</button>' +
        '<button type="button" data-act="open" title="Open a saved copy to keep working">Open a saved copy</button>';
      sb.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        if (b.getAttribute('data-act') === 'save') saveProgress();
        else fileInput.click();
      });
      document.body.appendChild(sb);
    }

    // Back-to-library button, pinned to the LEFT (separate from the toolbar)
    if (!document.querySelector('.fill-back')) {
      var back = document.createElement('button');
      back.type = 'button';
      back.className = 'fill-back no-print';
      back.setAttribute('data-act', 'back');
      back.title = 'Back to all forms';
      back.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>Back';
      back.addEventListener('click', goBack);
      document.body.appendChild(back);
    }

    bar.addEventListener('click', function (e) {
      var view = e.target.closest('[data-view]');
      if (view) { setDevice(view.getAttribute('data-view')); return; }
      var b = e.target.closest('button');
      if (!b) return;
      switch (b.getAttribute('data-act')) {
        case 'zoom-in':    setZoom(zoom + ZOOM_STEP); break;
        case 'zoom-out':   setZoom(zoom - ZOOM_STEP); break;
        case 'zoom-reset': setZoom(1); break;
        case 'share':      shareForm(); break;
        case 'theme':
          try {
            var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            localStorage.setItem(THEME_KEY, isDark ? 'light' : 'dark');
          } catch (err) {}
          applyTheme();
          break;
        case 'pdf':
        case 'print':      window.print(); break;
        case 'clear':      clearAll(); break;
      }
    });
  }

  /* ---------------- Add / delete rows on checklists ---------------- */
  function upgradeRow(row) {
    row.querySelectorAll('[data-fill]').forEach(function (el) {
      if (!el.classList.contains('writein')) {
        el.addEventListener('keydown', function (e) { if (e.key === 'Enter') e.preventDefault(); });
      }
    });
    row.querySelectorAll('.cbox, .box').forEach(function (el) {
      el.setAttribute('data-check', '');
      el.classList.remove('checked');
      el.addEventListener('click', function () { el.classList.toggle('checked'); });
    });
  }

  function delBtn() {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'row-del no-print';
    b.title = 'Delete this row';
    b.setAttribute('aria-label', 'Delete row');
    b.innerHTML = '\u00d7';
    return b;
  }

  function gripEl() {
    var g = document.createElement('span');
    g.className = 'row-grip no-print';
    g.title = 'Drag to reorder';
    g.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="6" cy="4" r="1.35"/><circle cx="10" cy="4" r="1.35"/><circle cx="6" cy="8" r="1.35"/><circle cx="10" cy="8" r="1.35"/><circle cx="6" cy="12" r="1.35"/><circle cx="10" cy="12" r="1.35"/></svg>';
    return g;
  }

  // Pointer-based reorder within a container (tbody rows or task list)
  function makeSortable(container, itemSelector) {
    if (container.dataset.sortable) return;
    container.dataset.sortable = '1';
    var dragEl = null;
    container.addEventListener('pointerdown', function (e) {
      if (!e.isPrimary || e.button !== 0) return;
      var handle = e.target.closest('.row-grip');
      if (!handle || !container.contains(handle)) return;
      var item = handle.closest(itemSelector);
      if (!item) return;
      e.preventDefault();
      dragEl = item;
      dragEl.classList.add('row-dragging');
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    });
    function onMove(e) {
      if (!dragEl) return;
      var parent = dragEl.parentNode;
      var y = e.clientY;
      var sibs = Array.prototype.filter.call(parent.children, function (el) {
        return el !== dragEl && el.matches && el.matches(itemSelector);
      });
      var next = null;
      for (var i = 0; i < sibs.length; i++) {
        var r = sibs[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) { next = sibs[i]; break; }
      }
      parent.insertBefore(dragEl, next);
    }
    function onUp(e) {
      if (dragEl) {
        dragEl.classList.remove('row-dragging');
        dragEl = null;
      }
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    }
  }

  function addBtn(label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'add-row no-print';
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>' + label;
    return b;
  }

  function enableAddRows() {
    document.querySelectorAll('table.form-table.chk, table.form-table[data-addrows]').forEach(setupTable);
    document.querySelectorAll('.task-list').forEach(setupTaskList);
  }

  function setupTable(t) {
    var tbody = t.querySelector('tbody');
    if (!tbody || t.dataset.rowsReady) return;
    t.dataset.rowsReady = '1';

    // add a screen-only delete column
    var headRow = t.querySelector('thead tr');
    if (headRow) {
      var th = document.createElement('th');
      th.className = 'row-del-col no-print';
      headRow.appendChild(th);
    }
    tbody.querySelectorAll('tr').forEach(function (tr) {
      var td = document.createElement('td');
      td.className = 'row-del-col no-print';
      td.appendChild(gripEl());
      td.appendChild(delBtn());
      tr.appendChild(td);
    });

    makeSortable(tbody, 'tr');

    // delete via delegation (keep at least one row)
    tbody.addEventListener('click', function (e) {
      var d = e.target.closest('.row-del');
      if (!d) return;
      if (tbody.querySelectorAll('tr').length > 1) d.closest('tr').remove();
    });

    var anchor = t.closest('.table-scroll') || t;
    if (anchor.nextElementSibling && anchor.nextElementSibling.classList.contains('add-row')) return;
    var btn = addBtn('Add row');
    btn.addEventListener('click', function () {
      var rows = tbody.querySelectorAll('tr');
      if (!rows.length) return;
      var row = rows[rows.length - 1].cloneNode(true);
      Array.prototype.forEach.call(row.children, function (td) {
        if (td.classList.contains('row-del-col')) return;         // keep the delete button
        if (td.querySelector('.cbox, .box')) {
          td.querySelectorAll('.cbox, .box').forEach(function (el) { el.classList.remove('checked'); });
        } else {
          td.textContent = '';
          td.setAttribute('contenteditable', 'true');
          td.setAttribute('data-fill', '');
          td.setAttribute('spellcheck', 'false');
        }
      });
      tbody.appendChild(row);
      upgradeRow(row);
    });
    anchor.parentNode.insertBefore(btn, anchor.nextSibling);
  }

  function setupTaskList(list) {
    if (list.dataset.rowsReady) return;
    list.dataset.rowsReady = '1';

    function fitTask(task) {
      if (task.querySelector('.row-del')) return;
      // make the label text editable so new / existing tasks can be renamed
      var span = task.querySelector('span:not(.cbox)');
      if (span) {
        span.setAttribute('contenteditable', 'true');
        span.setAttribute('data-fill', '');
        span.setAttribute('spellcheck', 'false');
      }
      task.insertBefore(gripEl(), task.firstChild);
      task.appendChild(delBtn());
    }
    list.querySelectorAll('.task').forEach(fitTask);
    makeSortable(list, '.task');

    list.addEventListener('click', function (e) {
      var d = e.target.closest('.row-del');
      if (!d) return;
      if (list.querySelectorAll('.task').length > 1) d.closest('.task').remove();
    });

    var btn = addBtn('Add task');
    btn.addEventListener('click', function () {
      var task = document.createElement('div');
      task.className = 'task';
      task.innerHTML = '<span class="cbox"></span><span></span>';
      fitTask(task);
      list.appendChild(task);
      upgradeRow(task);
      var span = task.querySelector('span[contenteditable]');
      if (span) span.focus();
    });
    list.parentNode.insertBefore(btn, list.nextSibling);
  }

  /* ---------------- Signature fields render in cursive ---------------- */
  function markSignatures() {
    // Labeled signature lines (skip the adjacent Date fields)
    document.querySelectorAll('.sign-field').forEach(function (f) {
      var label = f.querySelector('label');
      var line = f.querySelector('.sig-line');
      if (label && line && /signature/i.test(label.textContent)) {
        line.classList.add('is-signature');
      }
    });
    // Signature columns inside grid tables (e.g. Visitor Sign-In Sheet)
    document.querySelectorAll('table.form-table').forEach(function (t) {
      var head = t.querySelector('thead tr');
      if (!head) return;
      var cols = [];
      Array.prototype.forEach.call(head.children, function (th, i) {
        if (/signature/i.test(th.textContent)) cols.push(i);
      });
      if (!cols.length) return;
      t.querySelectorAll('tbody tr').forEach(function (tr) {
        cols.forEach(function (i) {
          var td = tr.children[i];
          if (td) td.classList.add('is-signature');
        });
      });
    });
  }

  /* ---------------- Back to the page you came from ---------------- */
  function goBack() {
    var ref = document.referrer;
    if (ref && history.length > 1) {
      try {
        var r = new URL(ref);
        if (r.origin === location.origin) { history.back(); return; }
      } catch (e) {}
    }
    // no in-site history — fall back to the portal forms library
    var authed = false;
    try { authed = sessionStorage.getItem('noor-admin-auth') === '1'; } catch (e) {}
    location.href = authed ? '../staff-portal/forms.html' : 'Forms.html';
  }

  /* ---------------- Save / open editable copy ---------------- */
  function currentFile() { return location.pathname.split('/').pop(); }

  function saveProgress() {
    var page = document.querySelector('doc-page');
    if (!page) { toast('Nothing to save'); return; }
    var clone = page.cloneNode(true);
    // strip everything the script injects, so the file is template + your values
    clone.querySelectorAll('.row-del-col').forEach(function (n) { n.remove(); });
    clone.querySelectorAll('.row-grip, .row-del, .add-row').forEach(function (n) { n.remove(); });
    clone.querySelectorAll('[contenteditable]').forEach(function (el) {
      el.removeAttribute('contenteditable');
      el.removeAttribute('spellcheck');
      el.removeAttribute('data-fill');
    });
    clone.querySelectorAll('[data-check]').forEach(function (el) { el.removeAttribute('data-check'); });
    // clear init flags so the reopened copy re-wires controls
    clone.querySelectorAll('[data-rows-ready]').forEach(function (el) { el.removeAttribute('data-rows-ready'); });
    clone.querySelectorAll('[data-sortable]').forEach(function (el) { el.removeAttribute('data-sortable'); });

    var data = {
      app: 'noor-forms', v: 1,
      title: document.title,
      file: currentFile(),
      savedAt: new Date().toISOString(),
      html: clone.innerHTML
    };
    var blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    var base = (document.title || 'Form').replace(/\s*[\u2014\-].*$/, '').trim() || 'Form';
    a.download = base + ' (saved).noorform';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 200);
    toast('Saved an editable copy to your device');
  }

  function openProgress(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(reader.result); }
      catch (e) { toast('That file could not be opened'); return; }
      if (!data || data.app !== 'noor-forms' || typeof data.html !== 'string') {
        toast('That is not a saved Noor form file'); return;
      }
      if (data.file && data.file !== currentFile()) {
        if (!window.confirm('This saved file is for "' + (data.title || 'another form') +
          '". Open it on this page anyway?')) return;
      }
      restoreHtml(data.html);
      toast('Loaded your saved copy \u2014 keep working');
    };
    reader.readAsText(file);
  }

  function restoreHtml(html) {
    var page = document.querySelector('doc-page');
    if (!page) return;
    page.innerHTML = html;
    hydrate();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---------------- Zoom (screen only) ---------------- */
  function setZoom(z) {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
    document.documentElement.style.setProperty('--fill-zoom', zoom);
    var val = document.querySelector('.ft-zoom-val');
    if (val) val.textContent = Math.round(zoom * 100) + '%';
  }

  /* ---------------- Computer / Phone layout ---------------- */
  function setDevice(mode) {
    var phone = mode === 'phone';
    document.body.classList.toggle('fill-phone', phone);
    if (phone) setZoom(1);
    document.querySelectorAll('.ft-view .seg').forEach(function (s) {
      s.classList.toggle('active', s.getAttribute('data-view') === mode);
    });
  }
  function autoDevice() {
    var small = window.matchMedia('(max-width: 760px)').matches;
    var coarse = window.matchMedia('(pointer: coarse)').matches;
    setDevice(small || coarse ? 'phone' : 'computer');
  }

  /* ---------------- Share ---------------- */
  function shareForm() {
    var url = location.href.split('#')[0];
    var title = document.title || 'Noor Therapy Center form';
    if (navigator.share) {
      navigator.share({
        title: title,
        text: 'Please complete this form for Noor Therapy Center:',
        url: url
      }).catch(function () {});
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

  /* ---------------- Toast ---------------- */
  var toastTimer;
  function toast(msg) {
    var el = document.querySelector('.fill-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'fill-toast no-print';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    requestAnimationFrame(function () { el.classList.add('show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  /* ---------------- Clear ---------------- */
  function clearAll() {
    if (!window.confirm('Clear everything you have typed on this form?')) return;
    document.querySelectorAll('[data-fill]').forEach(function (el) { el.textContent = ''; });
    document.querySelectorAll('[data-check]').forEach(function (el) { el.classList.remove('checked'); });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  ready(upgrade);
})();
