/* Noor Therapy Center — drag to reorder.
 *
 * Shared by the tracker's checklists and the portal home cards, because both
 * want the same thing: put the one that matters most at the top.
 *
 * Delegated, not bound per element. The tracker rebuilds its whole panel on
 * every save, so anything attached directly to a card would be thrown away
 * the first time a checkbox was ticked. Handlers live on a container that
 * survives, and the items are found at event time.
 *
 * Dragging starts from a grip, not the card. A card is full of checkboxes,
 * buttons and text you need to be able to select; making the whole thing
 * draggable breaks all of that. The grip flips `draggable` on just long enough
 * for the drag to begin, so the browser still shows the whole card as the drag
 * image rather than a lone handle.
 *
 * Keyboard works too: focus a grip and use the arrow keys. Drag-and-drop is
 * unusable without a pointer, and "put the important one first" should not
 * require one.
 */
(function (root) {
  'use strict';

  var GRIP_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<circle cx="6" cy="3.5" r="1.3"/><circle cx="10" cy="3.5" r="1.3"/>' +
    '<circle cx="6" cy="8" r="1.3"/><circle cx="10" cy="8" r="1.3"/>' +
    '<circle cx="6" cy="12.5" r="1.3"/><circle cx="10" cy="12.5" r="1.3"/></svg>';

  function grip(label) {
    return '<button type="button" class="nr-grip" data-nr-grip="1" ' +
      'aria-label="' + (label || 'Reorder') + ' — drag, or use the arrow keys" ' +
      'title="Drag to reorder, or use the arrow keys">' + GRIP_SVG + '</button>';
  }

  function itemsIn(container, group) {
    var all = container.querySelectorAll('[data-nr]');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-nr-group') === group) out.push(all[i]);
    }
    return out;
  }

  function idsOf(list) {
    return list.map(function (el) { return el.getAttribute('data-nr'); });
  }

  /* Move `id` so it sits before `beforeId`, or last when beforeId is null.
   *
   * Anchoring an item to itself means "leave it where it is" — without this
   * the filter removes it, the anchor is then not found, and it lands at the
   * end. A drop on the item being dragged is exactly that case. */
  function reorderIds(ids, id, beforeId) {
    if (beforeId === id) return ids.slice();
    var next = ids.filter(function (x) { return x !== id; });
    var at = beforeId == null ? next.length : next.indexOf(beforeId);
    if (at < 0) at = next.length;
    next.splice(at, 0, id);
    return next;
  }

  function delegate(container, opts) {
    if (!container || container.__nrWired) return;
    container.__nrWired = true;

    var onReorder = opts && opts.onReorder;
    var dragging = null;      // { id, group, el }

    function clearHints() {
      var marked = container.querySelectorAll('.nr-over-before, .nr-over-after, .nr-dragging');
      for (var i = 0; i < marked.length; i++) {
        marked[i].classList.remove('nr-over-before', 'nr-over-after', 'nr-dragging');
      }
    }

    // Arm the card only while the grip is held, so text stays selectable and
    // the buttons inside keep working.
    container.addEventListener('mousedown', function (e) {
      var g = e.target.closest('[data-nr-grip]');
      if (!g) return;
      var item = g.closest('[data-nr]');
      if (item) item.setAttribute('draggable', 'true');
    });
    function disarm() {
      var armed = container.querySelectorAll('[data-nr][draggable="true"]');
      for (var i = 0; i < armed.length; i++) armed[i].removeAttribute('draggable');
    }
    container.addEventListener('mouseup', disarm);

    /* Two interaction models, because two kinds of card need different ones.
     * A checklist is full of checkboxes and text, so it only moves from its
     * grip. A navigation card is a link, which the browser already makes
     * draggable, and giving it a grip would mean a button inside an anchor —
     * so those are dragged from anywhere and `anywhere: true` says so. */
    container.addEventListener('dragstart', function (e) {
      var item = e.target.closest && e.target.closest('[data-nr]');
      if (!item) return;
      if (!(opts && opts.anywhere) && item.getAttribute('draggable') !== 'true') return;
      dragging = {
        id: item.getAttribute('data-nr'),
        group: item.getAttribute('data-nr-group'),
        el: item
      };
      item.classList.add('nr-dragging');
      try {
        e.dataTransfer.effectAllowed = 'move';
        // Firefox will not start a drag without some payload.
        e.dataTransfer.setData('text/plain', dragging.id);
      } catch (x) {}
    });

    container.addEventListener('dragover', function (e) {
      if (!dragging) return;
      var over = e.target.closest && e.target.closest('[data-nr]');
      if (!over || over.getAttribute('data-nr-group') !== dragging.group) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (x) {}
      if (over === dragging.el) return;

      // Which half of the card the pointer is over decides which side of it
      // the dragged card would land.
      var box = over.getBoundingClientRect();
      var horizontal = opts && opts.horizontal;
      var before = horizontal
        ? (e.clientX < box.left + box.width / 2)
        : (e.clientY < box.top + box.height / 2);
      over.classList.toggle('nr-over-before', before);
      over.classList.toggle('nr-over-after', !before);
    });

    container.addEventListener('dragleave', function (e) {
      var over = e.target.closest && e.target.closest('[data-nr]');
      if (over) over.classList.remove('nr-over-before', 'nr-over-after');
    });

    container.addEventListener('drop', function (e) {
      if (!dragging) return;
      var over = e.target.closest && e.target.closest('[data-nr]');
      if (!over || over.getAttribute('data-nr-group') !== dragging.group) return;
      e.preventDefault();
      if (over === dragging.el) { clearHints(); disarm(); dragging = null; return; }

      var before = over.classList.contains('nr-over-before');
      var ids = idsOf(itemsIn(container, dragging.group));
      var overId = over.getAttribute('data-nr');
      var anchor = before ? overId : ids[ids.indexOf(overId) + 1] || null;
      var next = reorderIds(ids, dragging.id, anchor);

      var group = dragging.group;
      clearHints();
      disarm();
      dragging = null;
      if (onReorder) onReorder(group, next);
    });

    container.addEventListener('dragend', function () {
      clearHints();
      disarm();
      dragging = null;
    });

    /* Keyboard: the same move, without a pointer. From a grip the arrows are
     * unambiguous. A navigation card has no grip and is a link, where bare
     * arrows belong to the page, so those take Alt+Arrow. */
    container.addEventListener('keydown', function (e) {
      var back = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
      var fwd = e.key === 'ArrowDown' || e.key === 'ArrowRight';
      if (!back && !fwd) return;
      var g = e.target.closest && e.target.closest('[data-nr-grip]');
      var item = g ? g.closest('[data-nr]')
        : (opts && opts.anywhere && e.altKey
            ? (e.target.closest && e.target.closest('[data-nr]')) : null);
      if (!item) return;
      e.preventDefault();

      var group = item.getAttribute('data-nr-group');
      var ids = idsOf(itemsIn(container, group));
      var id = item.getAttribute('data-nr');
      var at = ids.indexOf(id);
      var to = at + (back ? -1 : 1);
      if (to < 0 || to >= ids.length) return;

      var next = ids.slice();
      next.splice(at, 1);
      next.splice(to, 0, id);
      if (onReorder) onReorder(group, next, { keyboard: true, id: id });
    });
  }

  root.NoorReorder = { delegate: delegate, grip: grip, reorderIds: reorderIds };
})(window);
