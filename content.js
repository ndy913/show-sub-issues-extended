// Collapses sub-issues under their parent in Linear list views ("Nested sub-issues" display option),
// and tints issue rows by depth. Linear has neither natively.
//
// Hiding the rows in the DOM is not enough: the list is virtualized and keeps rendering from its
// own idea of each row's position, which leaves a blank area under a collapsed parent. So we act
// on the list's data instead, read from the React fiber of the virtualized list component:
// - its `items` prop is a tree: group -> group -> issue -> sub-issues (`subItems`), and each item
//   `key` is the `data-list-key` attribute of its row;
// - its `nestedHeights` prop caches the height of each subtree, by item key, and is filled lazily.
// Collapsing a parent empties its `subItems` (the original array is kept aside) and drops the cached
// heights of the parent and its ancestors so Linear recomputes them; then the list is made to
// render again (see rerender). Linear rebuilds the tree when data changes; the MutationObserver
// re-applies.
//
// Runs in the page's MAIN world (see manifest), since React fibers are not visible from an
// isolated content script. The options set in the popup reach this script through attributes that
// bridge.js puts on <html>: data-lsc-collapse and data-lsc-colors ("on" / "off").

(() => {
  const STORAGE_KEY = 'lsc:collapsed';
  const ROW_SELECTOR = 'a[data-list-row]';
  const ROOT = document.documentElement;
  const LEVELS = 5; // palette levels, as in options.js (not loaded in this world)
  // Same triangle as Linear's group headers, pointing right; rotated down when expanded.
  const CHEVRON_PATH =
    'M6.75194 10.6239C6.41861 10.8183 6 10.5779 6 10.192V5.80802C6 5.42212 6.41861 5.18169 6.75194 5.37613L10.5096 7.56811C10.8404 7.76105 10.8404 8.23895 10.5096 8.43189L6.75194 10.6239Z';

  // Collapsed rows, by item key; a bare issue id is the older format and collapses every row of
  // that issue. Shared by all Linear tabs through localStorage.
  let collapsed = new Set(loadCollapsed());
  const originalSubItems = new WeakMap(); // item -> its sub-items, while collapsed

  const isEnabled = (option) => ROOT.dataset[option] !== 'off';

  function loadCollapsed() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch {
      return [];
    }
  }

  function saveCollapsed() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]));
    } catch {
      // storage unavailable: state stays in memory for this tab
    }
  }

  // Another Linear tab changed the collapsed rows.
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    collapsed = new Set(loadCollapsed());
    schedule();
  });

  // --- Reading the list from React --------------------------------------------------------------

  function fiberOf(node) {
    const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
    return key ? node[key] : null;
  }

  const isListProps = (p) => p && Array.isArray(p.items) && p.nestedHeights && typeof p.nestedHeights === 'object';

  // The outermost fiber of the virtualized list that holds the item tree and the height cache.
  function listFiberOf(row) {
    let found = null;
    for (let fiber = fiberOf(row); fiber; fiber = fiber.return) {
      if (isListProps(fiber.memoizedProps)) found = fiber;
    }
    return found;
  }

  // A DOM node keeps the fiber it was created with, which may be the stale half of React's
  // current/alternate pair. Both halves are patched, so the tree Linear renders next is patched
  // whichever it is.
  function listPropsOf(fiber) {
    const props = [fiber?.memoizedProps, fiber?.alternate?.memoizedProps].filter(isListProps);
    return props.filter((p, i) => props.findIndex((q) => q.items === p.items) === i);
  }

  // Linear rebuilds `items` when data or display options change. React keeps the list fiber's
  // previous props on the other half of the pair until the list renders again, so right after a
  // rebuild the two halves hold two different trees, and only the newest one is on screen. Each
  // `items` array gets a number the first time it is seen: the current tree is the one with the
  // highest number. Two arrays first seen together cannot be told apart (null): the list is then
  // made to render, which leaves both halves with the same tree.
  const itemsSeen = new WeakMap(); // items array -> when it was first seen
  let seenCount = 0;
  const gaveUp = new WeakSet(); // containers whose list never re-rendered: no way to tell halves apart

  function currentPropsOf(propsList, container) {
    const stamp = ++seenCount;
    for (const props of propsList) if (!itemsSeen.has(props.items)) itemsSeen.set(props.items, stamp);
    if (propsList.length < 2) return propsList[0] || null;
    const [a, b] = propsList;
    const seenA = itemsSeen.get(a.items);
    const seenB = itemsSeen.get(b.items);
    if (seenA === seenB) return gaveUp.has(container) ? a : null;
    return seenA > seenB ? a : b;
  }

  // An issue's identifier, like "ENG-123". Other lists use the same item shape with other
  // identifiers (cycles are numbered: 35, 34...), which must not pass for issues.
  const ISSUE_ID = /^[A-Z][A-Z0-9]*-\d+$/;
  function identifierOf(item) {
    const id = item?.data?.type === 'item' ? item.data.value?.identifier : undefined;
    return typeof id === 'string' && ISSUE_ID.test(id) ? id : undefined;
  }

  const childrenOf = (item) => originalSubItems.get(item) || item.subItems || [];

  function scrollContainerOf(row) {
    for (let el = row.parentElement; el; el = el.parentElement) {
      if (['auto', 'scroll', 'overlay'].includes(getComputedStyle(el).overflowY)) return el;
    }
    return null;
  }

  // The lists on screen, by scroll container: their rows and their list fiber (null for lists
  // that are not nested issue lists, such as projects or the inbox).
  function findLists() {
    const lists = new Map();
    const seen = new Set();
    for (const row of document.querySelectorAll(ROW_SELECTOR)) {
      if (seen.has(row)) continue;
      const container = scrollContainerOf(row);
      if (!container) {
        seen.add(row);
        continue;
      }
      const rows = [...container.querySelectorAll(ROW_SELECTOR)];
      for (const r of rows) seen.add(r);
      lists.set(container, { rows, fiber: listFiberOf(row) });
    }
    return lists;
  }

  // Walks one item tree: applies the collapsed state and records, by item key, the depth of each
  // issue (0 for an issue directly under a group) and which issues are parents.
  function patchTree(props, rowInfo) {
    const collapseOn = isEnabled('lscCollapse');
    let changed = false;

    const visit = (items, ancestors, depth) => {
      for (const item of items) {
        const id = identifierOf(item);
        const stashed = originalSubItems.get(item);
        const wantCollapsed = Boolean(collapseOn && id && (collapsed.has(item.key) || collapsed.has(id)));

        if (id) {
          // Direct sub-issues shown in this view, so after the view's filters.
          const childCount = childrenOf(item).filter((sub) => identifierOf(sub)).length;
          rowInfo.set(item.key, { id, key: item.key, depth, childCount, isParent: childCount > 0, isCollapsed: wantCollapsed });
        }

        if (wantCollapsed && !stashed && item.subItems?.length) {
          originalSubItems.set(item, item.subItems);
          item.subItems = [];
          forgetHeights(props.nestedHeights, item, ancestors);
          changed = true;
        } else if (stashed && !wantCollapsed) {
          item.subItems = stashed;
          originalSubItems.delete(item);
          forgetHeights(props.nestedHeights, item, ancestors);
          changed = true;
        }

        if (item.subItems?.length) visit(item.subItems, [...ancestors, item], id ? depth + 1 : depth);
      }
    };

    visit(props.items, [], 0);
    return changed;
  }

  function forgetHeights(nestedHeights, item, ancestors) {
    delete nestedHeights[item.key];
    for (const ancestor of ancestors) delete nestedHeights[ancestor.key];
  }

  // --- Keeping the clicked row where it was -------------------------------------------------
  // Before a collapse or expand we note where the clicked row sits on screen (the anchor). Once the
  // list has re-rendered, we scroll so that this row is back at the same place, under the mouse.
  // When rows below vanish near the end of the list, there is not enough content left to scroll
  // that far: a blank spacer at the bottom of the list makes up the difference, and shrinks back
  // as the user scrolls up.

  let pendingAnchor = null; // { key, top } of the row to keep in place, until a list takes it
  const anchors = new WeakMap(); // container -> anchor for its next re-render

  function captureAnchor(row) {
    if (!row) {
      // No clicked row (popup buttons): keep in place the first issue on screen that is not a
      // sub-issue, since collapsing hides sub-issues.
      const visible = [...document.querySelectorAll(ROW_SELECTOR)].filter((r) => {
        const container = scrollContainerOf(r);
        return container && r.getBoundingClientRect().top >= container.getBoundingClientRect().top;
      });
      row = visible.find((r) => lastRowInfo.get(r.getAttribute('data-list-key'))?.depth === 0) || visible[0];
    }
    pendingAnchor = row ? { key: row.getAttribute('data-list-key'), top: row.getBoundingClientRect().top } : null;
  }

  const rowByKey = (scope, key) => scope.querySelector(`${ROW_SELECTOR}[data-list-key="${CSS.escape(key)}"]`);

  function spacerOf(container) {
    let spacer = container.querySelector(':scope > .lsc-spacer');
    if (!spacer) {
      spacer = document.createElement('div');
      spacer.className = 'lsc-spacer';
      spacer.style.cssText = 'height: 0px; flex: none; pointer-events: none;';
      container.append(spacer);
      container.addEventListener('scroll', () => shrinkSpacer(container), { passive: true });
    }
    return spacer;
  }

  // Makes the list tall enough to scroll to `scrollTop`.
  function ensureScrollable(container, scrollTop) {
    const spacer = spacerOf(container);
    const current = spacer.offsetHeight;
    const contentHeight = container.scrollHeight - current;
    const needed = Math.max(0, Math.ceil(scrollTop + container.clientHeight - contentHeight));
    if (needed > current) spacer.style.height = `${needed}px`;
  }

  // Keeps only the part of the spacer that is still on screen.
  function shrinkSpacer(container) {
    const spacer = container.querySelector(':scope > .lsc-spacer');
    const current = spacer?.offsetHeight || 0;
    if (!current) return;
    const contentHeight = container.scrollHeight - current;
    const needed = Math.max(0, Math.ceil(container.scrollTop + container.clientHeight - contentHeight));
    if (needed < current) spacer.style.height = `${needed}px`;
  }

  function restoreAnchor(container, anchor) {
    if (!anchor) return;
    const row = rowByKey(container, anchor.key);
    if (!row) return;
    const delta = row.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) < 1) return;
    const target = container.scrollTop + delta;
    ensureScrollable(container, target);
    container.scrollTop = target;
  }

  // --- Making the list render the patched tree ------------------------------------------------
  // The list only re-renders on its own state changes, and reads its scroll position on scroll
  // events. So for a moment the container reports a fake scroll position, a fraction of a pixel
  // off, and we send it a scroll event: the list re-renders without anything moving on screen.
  // The re-render is seen when the list's props carry that fake value. Then the real value comes
  // back and the anchor row is put back in place, before the browser paints.
  // A container stays "dirty" from the patch until that re-render is seen; if it is not seen within
  // a few frames, the next apply tries again with another value (React skips a render when the
  // value does not change, and Linear may round it). A scroll by the user also re-renders the list,
  // so a wheel, touch or key gesture ends the wait too (without putting the row back, since the
  // user moved). Scroll events alone do not: the browser fires one when the list gets shorter and
  // pulls the scroll position back, which is exactly when the row must be put back in place.

  const SCROLL_TOP = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  const FAKE_OFFSETS = [0.5, 1, 1.5, 2];
  const MAX_FRAMES = 6; // frames to wait for the re-render before trying again
  const dirty = new WeakSet(); // containers whose tree was patched but not rendered yet
  const nudging = new WeakSet(); // containers waiting for a re-render
  const attempts = new WeakMap(); // container -> failed attempts for the current patch
  const lastFakeTop = new WeakMap(); // container -> last value reported to the list

  function rerender(container) {
    const attempt = attempts.get(container) || 0;
    if (attempt >= FAKE_OFFSETS.length) {
      // Linear never re-rendered: give up rather than loop. The next click starts over.
      dirty.delete(container);
      attempts.delete(container);
      anchors.delete(container);
      gaveUp.add(container);
      return;
    }
    attempts.set(container, attempt + 1);

    const anchor = anchors.get(container);
    anchors.delete(container);
    const real = SCROLL_TOP.get.call(container);
    let fake = real + FAKE_OFFSETS[attempt];
    if (fake === lastFakeTop.get(container)) fake += 0.25; // the list may still hold it
    lastFakeTop.set(container, fake);

    const rendered = () => {
      const row = container.querySelector(ROW_SELECTOR);
      const fiber = row && listFiberOf(row);
      return [fiber?.memoizedProps, fiber?.alternate?.memoizedProps].some((p) => p?.scrollTop === fake);
    };

    let done = false;
    let frames = 0;
    const finish = (seen, restore) => {
      if (done) return;
      done = true;
      watcher.disconnect();
      for (const type of USER_GESTURES) window.removeEventListener(type, onUserScroll, true);
      delete container.scrollTop; // back to the real one
      nudging.delete(container);
      if (seen) {
        dirty.delete(container);
        attempts.delete(container);
        gaveUp.delete(container);
        if (restore) restoreAnchor(container, anchor);
        // The render often adds no node, so no pass would follow: rows need one to show the
        // tree now on screen.
        schedule();
      } else {
        if (anchor) anchors.set(container, anchor);
        schedule(); // try again
      }
    };
    const onUserScroll = () => finish(true, false);
    const USER_GESTURES = ['wheel', 'touchmove', 'keydown'];
    const poll = () => {
      if (done) return;
      if (rendered()) finish(true, true);
      else if (++frames >= MAX_FRAMES) finish(false, false);
      else requestAnimationFrame(poll);
    };

    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => fake,
      set: (value) => SCROLL_TOP.set.call(container, value),
    });
    nudging.add(container);
    // Runs right after Linear's update, before the browser paints it.
    const watcher = new MutationObserver(() => {
      if (rendered()) finish(true, true);
    });
    watcher.observe(container, { childList: true, subtree: true });
    for (const type of USER_GESTURES) window.addEventListener(type, onUserScroll, { capture: true, passive: true });
    requestAnimationFrame(poll);

    container.dispatchEvent(new Event('scroll'));
  }

  // --- Rows: chevron, count, depth --------------------------------------------------------------

  function createToggle() {
    const toggle = document.createElement('span');
    toggle.className = 'lsc-toggle';
    toggle.setAttribute('role', 'button');
    toggle.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="${CHEVRON_PATH}"></path></svg>`;
    toggle.addEventListener('pointerdown', swallow, true);
    toggle.addEventListener('mousedown', swallow, true);
    toggle.addEventListener('click', onToggleClick, true);
    return toggle;
  }

  // Writes only when the value changes: every write to an attribute that CSS selects on makes the
  // browser recompute the layout at the next read.
  function setData(el, name, value) {
    if (value === null) {
      if (name in el.dataset) delete el.dataset[name];
    } else if (el.dataset[name] !== value) {
      el.dataset[name] = value;
    }
  }

  // Reads everything a row needs before anything is written (see apply).
  // The status cell (the round status icon) and the title cell are marked with data-lsc-cell, an
  // attribute React leaves alone (it rewrites `className`). With the collapse option on, CSS shifts
  // both 16px to the right on every row of a nested issue list, which leaves a free slot just
  // before the status icon, as in Linear's group headers: the chevron goes there.
  function readRow(row, info) {
    const plan = { row, info, grid: [...row.children].find((child) => !child.classList.contains('lsc-toggle')) };
    if (!plan.grid) return plan;

    if (info && isEnabled('lscCollapse')) {
      const cells = [...plan.grid.children];
      // The title cell is the widest one; the status cell sits right before it.
      const widths = cells.map((cell) => cell.getBoundingClientRect().width);
      plan.titleCell = cells[widths.indexOf(Math.max(...widths))];
      plan.statusCell = plan.titleCell?.previousElementSibling;
      if (plan.statusCell && info.isParent) {
        const icon = plan.statusCell.querySelector('svg') || plan.statusCell;
        const shifted = plan.statusCell.dataset.lscCell === 'status' ? 0 : 16; // not shifted yet
        plan.toggleLeft = `${Math.round(icon.getBoundingClientRect().left - row.getBoundingClientRect().left + shifted - 17)}px`;
        // The title text is the first text-only span of the cell (Linear truncates it with an
        // ellipsis); the pill goes right after it, not at the end of the cell, which spans the row.
        plan.titleText = [...plan.titleCell.querySelectorAll('span')].find(
          (span) => !span.classList.contains('lsc-count') && span.childElementCount === 0 && span.textContent.trim(),
        );
      }
    }

    // The tree line does not move for a given row element and depth: measured once. Top-level
    // issues have no tree line, their tint covers the whole row.
    if (info && row.dataset.lscStartDepth !== String(info.depth)) {
      plan.start = info.depth > 0 ? `${treeLineOffset(row, info.depth)}px` : '0px';
    }
    return plan;
  }

  function writeRow({ row, info, grid, titleCell, statusCell, toggleLeft, titleText, start }) {
    if (grid) {
      for (const cell of grid.children) {
        setData(cell, 'lscCell', cell === statusCell ? 'status' : cell === titleCell && statusCell ? 'title' : null);
      }
    }

    let toggle = row.querySelector(':scope > .lsc-toggle');
    if (toggleLeft) {
      if (!toggle) {
        toggle = createToggle();
        row.append(toggle);
      }
      setData(toggle, 'issueId', info.id);
      setData(toggle, 'rowKey', info.key);
      setData(toggle, 'collapsed', String(info.isCollapsed));
      const title = info.isCollapsed
        ? 'Afficher les sous-tickets (Alt+clic : tous les parents)'
        : 'Masquer les sous-tickets (Alt+clic : tous les parents)';
      if (toggle.title !== title) toggle.title = title;
      if (toggle.style.left !== toggleLeft) toggle.style.left = toggleLeft;
    } else {
      toggle?.remove();
    }
    writeCount(row, info, toggleLeft ? titleText : null);

    // Depth 0 to 4 take palette levels 1 to 5 (content.css), deeper rows keep level 5. Rows without
    // tree info (a list that does not draw the sub-issue tree) stay plain.
    setData(row, 'lscDepth', info ? String(Math.min(info.depth, LEVELS - 1)) : null);
    if (start) {
      row.style.setProperty('--lsc-start', start);
      setData(row, 'lscStartDepth', String(info.depth));
    }
  }

  // Pill after the title with the number of direct sub-issues: text in the title color, background
  // in the color of the level they sit at, stronger and bold once the parent is collapsed
  // ("N masqués").
  function writeCount(row, info, titleText) {
    let pill = row.querySelector('.lsc-count');
    if (!titleText) {
      pill?.remove();
      return;
    }
    if (!pill || pill.previousElementSibling !== titleText) {
      pill?.remove();
      pill = document.createElement('span');
      pill.className = 'lsc-count';
      titleText.after(pill);
    }
    const hidden = info.childCount > 1 ? 'masqués' : 'masqué';
    const text = info.isCollapsed ? `${info.childCount} ${hidden}` : String(info.childCount);
    if (pill.textContent !== text) pill.textContent = text;
    setData(pill, 'collapsed', String(info.isCollapsed));
    // The sub-issues sit at depth + 1, which is palette level depth + 2.
    setData(pill, 'level', String(Math.min(info.depth + 2, LEVELS)));
    const title = `${info.childCount} sous-tickets dans cette vue`;
    if (pill.title !== title) pill.title = title;
  }

  // Horizontal offset, from the row's left edge, of the vertical tree line that leads to this row:
  // the rightmost 1px-wide line coming from the top of the row, before the identifier. Lines that
  // only start low in the row lead to its own sub-issues and are skipped. The depth tint starts
  // there, so each level starts a bit further right. Falls back to Linear's current layout
  // (50px, then 24px a level).
  function treeLineOffset(row, depth) {
    const rowBox = row.getBoundingClientRect();
    let offset = -1;
    for (const el of row.querySelectorAll('div, span')) {
      const box = el.getBoundingClientRect();
      const left = box.left - rowBox.left;
      const fromTop = box.top <= rowBox.top + rowBox.height / 4;
      if (box.width > 0 && box.width <= 2 && box.height > 4 && fromTop && left < 200) {
        offset = Math.max(offset, left);
      }
    }
    return Math.round(offset >= 0 ? offset : 50 + 24 * (depth - 1));
  }

  // --- Collapsing and expanding ---------------------------------------------------------------

  function swallow(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  // Alt+click acts on every parent of the lists on screen, rendered or not.
  function onToggleClick(event) {
    swallow(event);
    const toggle = event.currentTarget;
    const row = toggle.closest(ROW_SELECTOR);
    const value = toggle.dataset.collapsed !== 'true';
    if (event.altKey) {
      if (value) setCollapsed(allParentRows(), true, row);
      else setCollapsed(allParentRows(), false, row);
    } else {
      setCollapsed([{ key: toggle.dataset.rowKey, id: toggle.dataset.issueId }], value, row);
    }
  }

  // Applies a change to the collapsed rows. The stored set is read again first, so that a change
  // made meanwhile in another tab is kept.
  // `anchorRow`: the row clicked, kept at the same place on screen (first row on screen if none).
  function updateCollapsed(change, anchorRow) {
    captureAnchor(anchorRow);
    const fresh = new Set(loadCollapsed());
    change(fresh);
    collapsed = fresh;
    saveCollapsed();
    schedule();
  }

  // Collapses or expands rows, given as { key, id }: the row's item key and its issue identifier.
  // Collapsing records the row only, so another row of the same issue (in another group) stays
  // as it is. Expanding also drops the issue id, in case it was collapsed in the older format.
  function setCollapsed(rows, value, anchorRow) {
    updateCollapsed((set) => {
      for (const { key, id } of rows) {
        if (value) {
          set.add(key);
        } else {
          set.delete(key);
          set.delete(id);
        }
      }
    }, anchorRow);
  }

  // Every parent of the lists on screen, rendered rows or not, including the parents that sit
  // under a collapsed parent.
  function allParentRows() {
    const rows = new Map(); // key -> { key, id }
    const visit = (items) => {
      for (const item of items) {
        const id = identifierOf(item);
        const children = childrenOf(item);
        if (id && children.length) rows.set(item.key, { key: item.key, id });
        if (children.length) visit(children);
      }
    };
    for (const [container, { fiber }] of findLists()) {
      const propsList = listPropsOf(fiber);
      const current = currentPropsOf(propsList, container);
      for (const props of current ? [current] : propsList) visit(props.items);
    }
    return [...rows.values()];
  }

  // "Tout replier" / "Tout déplier" (the lists on screen) and "Activer « Show sub-issues »", from
  // the popup through bridge.js.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'lsc-bridge') return;
    // Ignored while the collapse option is off (also off with the main switch): the popup buttons
    // are greyed out, but a keyboard can still reach them.
    const collapseOn = isEnabled('lscCollapse');
    if (event.data.action === 'collapse-all' && collapseOn) setCollapsed(allParentRows(), true);
    if (event.data.action === 'expand-all' && collapseOn) setCollapsed(allParentRows(), false);
    if (event.data.action === 'enable-sub-issues') enableSubIssues().catch((error) => console.warn('[linear-subissue-collapse]', error));
  });

  // --- Linear's "Show sub-issues" display option ---------------------------------------------
  // The extension works on top of two options of Linear's Display options panel (Shift+V):
  // "Show sub-issues" on, and "Nested sub-issues" not set to "Hide" (that is what draws the tree).
  // The popup button « Afficher les sous-tickets en arbre » sets both on the current view, by
  // driving the panel the way a user would. Labels are Linear's English ones.

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const labelElement = (text) =>
    [...document.querySelectorAll('span, div, label')].find((el) => el.childElementCount === 0 && el.textContent.trim() === text);

  // The control on the same line as a label.
  function controlNear(label, selector) {
    let box = label;
    for (let i = 0; box && i < 5; i++, box = box.parentElement) {
      const control = box.querySelector(selector);
      if (control) return control;
    }
    return null;
  }

  async function waitFor(find, timeout = 1500) {
    for (let waited = 0; waited < timeout; waited += 50) {
      const found = find();
      if (found) return found;
      await sleep(50);
    }
    return null;
  }

  async function enableSubIssues() {
    if (ROOT.dataset.lscNested === 'on') return;
    const button = document.querySelector('button[aria-label="Display options"]');
    if (!button) return; // not a list view
    const wasOpen = Boolean(labelElement('Show sub-issues'));
    if (!wasOpen) {
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      button.click();
    }
    const showLabel = await waitFor(() => labelElement('Show sub-issues'));
    if (!showLabel) {
      // Not a panel with this option (a board, another language): close it as it was.
      if (!wasOpen) {
        button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        button.click();
      }
      return;
    }

    const toggle = controlNear(showLabel, 'input[type="checkbox"]');
    const turnedOn = Boolean(toggle && !toggle.checked);
    if (turnedOn) {
      toggle.click();
      await sleep(150);
    }

    const nestedLabel = await waitFor(() => labelElement('Nested sub-issues'));
    const nested = nestedLabel && controlNear(nestedLabel, '[role="combobox"], button');
    if (!nestedLabel && turnedOn) {
      // No "Nested sub-issues" line (a board): the tree cannot show here, so put the view back as
      // it was. A line whose control is not found is still a list view: leave the option on.
      toggle.click();
      await sleep(150);
    }
    if (nested?.textContent.trim() === 'Hide') {
      nested.click();
      const option = await waitFor(() =>
        [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.trim().startsWith('Show matching')),
      );
      option?.click();
      await sleep(150);
    }

    // Close the panel the way it was opened: a click on its button. Escape is not safe here: once
    // the focus has left the panel, Linear reads it as "go back" and leaves the view.
    if (!wasOpen && labelElement('Show sub-issues')) {
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      button.click();
    }
  }

  // Whether a list draws the sub-issue tree, that is "Show sub-issues" on and "Nested sub-issues"
  // not on "Hide". Then Linear gives every issue a `subItems` array, empty when it has no
  // sub-issues; with either option off, issues have no `subItems` at all.
  // Elsewhere the extension leaves the rows untouched.
  function hasNestedSubIssues(propsList) {
    const visit = (items) =>
      items.some((item) =>
        identifierOf(item)
          ? Array.isArray(item.subItems) || originalSubItems.has(item)
          : Boolean(item.subItems?.length && visit(item.subItems)),
      );
    return propsList.some((props) => visit(props.items));
  }

  // --- Linear's right-click menu on an issue -------------------------------------------------
  // The menu is a fixed-height dialog whose items are absolutely positioned, so instead of slipping
  // an item into its list we add a block above the list, built from a clone of one of its items,
  // and let the dialog grow (see content.css).

  let lastContextMenu = null; // { key, at } of the row last right-clicked
  let lastRowInfo = new Map();

  document.addEventListener(
    'contextmenu',
    (event) => {
      const row = event.target.closest?.(ROW_SELECTOR);
      lastContextMenu = row ? { key: row.getAttribute('data-list-key'), at: Date.now() } : null;
    },
    true,
  );
  // Any key or click after the right-click means its menu is gone or was never detected: the next
  // dialog (status picker, command palette...) must not get the item.
  for (const type of ['keydown', 'pointerdown']) {
    document.addEventListener(type, () => (lastContextMenu = null), true);
  }

  function enhanceContextMenu() {
    if (!lastContextMenu || Date.now() - lastContextMenu.at > 3000 || !isEnabled('lscCollapse')) return;
    const rowKey = lastContextMenu.key;
    const info = lastRowInfo.get(rowKey);

    // The newest menu: dialogs open later come later in the document.
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((d) =>
      d.querySelector('[role="listbox"] li[role="option"]'),
    );
    const dialog = dialogs[dialogs.length - 1];
    if (!info?.isParent) return clearMenu(dialog);
    if (!dialog) return;
    // A dialog Linear reuses keeps the block of the previous right-click: replace it.
    const previous = dialog.querySelector('.lsc-menu');
    if (previous?.dataset.rowKey === rowKey && previous.dataset.collapsed === String(info.isCollapsed)) return;
    clearMenu(dialog);

    const listbox = dialog.querySelector('[role="listbox"]');
    const options = [...listbox.querySelectorAll('li[role="option"]')];
    // A plain item to copy the look from: no submenu arrow.
    const sample = options.find((li) => !li.hasAttribute('aria-expanded')) || options[0];
    const separator = listbox.querySelector('[role="separator"]');
    if (!sample) return;
    lastContextMenu = null;

    const item = sample.cloneNode(true);
    for (const attr of [...item.attributes]) {
      if (attr.name !== 'class') item.removeAttribute(attr.name);
    }
    item.className += ' lsc-menu-item';
    item.dataset.focused = 'false';
    const label = [...item.querySelectorAll('span, div')].find(
      (el) => el.childElementCount === 0 && el.textContent.trim(),
    );
    if (label) {
      label.textContent = info.isCollapsed ? 'Déplier les sous-tickets' : 'Replier les sous-tickets';
      // Drop what follows the label (keyboard shortcut, submenu arrow).
      let labelBox = label;
      while (labelBox.parentElement && labelBox.parentElement.childElementCount === 1) labelBox = labelBox.parentElement;
      while (labelBox.nextElementSibling) labelBox.nextElementSibling.remove();
    }
    const icon = item.querySelector('svg');
    if (icon) {
      icon.outerHTML = `<svg class="lsc-menu-icon" data-collapsed="${info.isCollapsed}" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="${CHEVRON_PATH}"></path></svg>`;
    }

    item.addEventListener('mouseenter', () => (item.dataset.focused = 'true'));
    item.addEventListener('mouseleave', () => (item.dataset.focused = 'false'));
    item.addEventListener('pointerdown', swallow, true);
    item.addEventListener('mousedown', swallow, true);
    item.addEventListener('click', (event) => {
      swallow(event);
      setCollapsed([{ key: rowKey, id: info.id }], !info.isCollapsed, rowByKey(document, rowKey));
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    });

    const block = document.createElement('div');
    block.className = 'lsc-menu';
    block.dataset.rowKey = rowKey;
    block.dataset.collapsed = String(info.isCollapsed);
    block.append(item);
    if (separator) {
      const line = separator.cloneNode(true);
      line.removeAttribute('style');
      line.className += ' lsc-menu-separator';
      block.append(line);
    }
    listbox.before(block);
    fitMenu(dialog);
  }

  // The menu is taller with our block: move it up just enough to keep its last items on screen.
  // Measured from Linear's own position, without a shift left by an earlier right-click.
  function fitMenu(dialog) {
    dialog.style.translate = '';
    const box = dialog.getBoundingClientRect();
    const overflow = box.bottom - (window.innerHeight - 8);
    if (overflow > 0) dialog.style.translate = `0 ${-Math.min(overflow, Math.max(0, box.top - 8))}px`;
  }

  // Removes our block (and its shift) from a menu: right-click on a row that is not a parent.
  function clearMenu(dialog) {
    if (!dialog?.querySelector('.lsc-menu')) return;
    dialog.querySelector('.lsc-menu').remove();
    dialog.style.translate = '';
  }

  // --- What the popup shows ---------------------------------------------------------------------
  // data-lsc-nested on <html>, read by bridge.js for the popup: "on" when a list shows the
  // sub-issue tree, "off" when the issue lists on screen do not (options off), "none" when the page
  // has no issue list. A list whose tree is not known yet (null) keeps the previous value.

  // State of one list: 'on' / 'off' for an issue list with / without the tree, null when its tree
  // is not known yet, undefined when it is not an issue list (the cycles page lists cycles).
  function listState(propsList, current) {
    if (!propsList.length) return undefined;
    if (!current) return null;
    const hasIssues = (items) => items.some((item) => identifierOf(item) || (item.subItems?.length && hasIssues(item.subItems)));
    if (!hasIssues(current.items)) return undefined;
    return hasNestedSubIssues([current]) ? 'on' : 'off';
  }

  // A list view whose issues are all sub-issues shows no row at all once "Show sub-issues" is off:
  // no issue list is found, but the page still has Linear's Display options button, so it is a
  // list view with the option off rather than a page without list.
  function writeNestedState(states) {
    const values = [...states.values()];
    if (values.includes('on')) return setData(ROOT, 'lscNested', 'on');
    if (values.includes(null)) return;
    // Only when no list was found: a list of projects or cycles also has that button, and must
    // read as "no issue list". An empty one (all rows filtered out) still reads as "off", since
    // nothing tells it apart from an issue view emptied by the option.
    const listView = states.size === 0 && Boolean(document.querySelector('button[aria-label="Display options"]'));
    setData(ROOT, 'lscNested', values.includes('off') || listView ? 'off' : 'none');
  }

  // bridge.js fires this right before answering the popup: the page may have changed without any
  // pass (a view left for an issue page, an option turned off with no row added).
  document.addEventListener('lsc-ping', () => {
    const states = new Map();
    for (const [container, { fiber }] of findLists()) {
      const propsList = listPropsOf(fiber);
      states.set(container, listState(propsList, currentPropsOf(propsList, container)));
    }
    writeNestedState(states);
  });

  // --- Main pass -------------------------------------------------------------------------------

  function apply() {
    const lists = findLists();

    const rowInfo = new Map(); // item key -> { id, key, depth, childCount, isParent, isCollapsed }
    const states = new Map(); // container -> 'on' | 'off' | null (tree unknown yet)
    for (const [container, { fiber }] of lists) {
      setData(container, 'lscList', ''); // lets the observer tell list changes from the rest
      const propsList = listPropsOf(fiber);
      const current = currentPropsOf(propsList, container);
      // Both trees are patched, so the next render is patched whichever half React uses; the row
      // information only comes from the tree on screen.
      let changed = false;
      for (const props of propsList) changed = patchTree(props, props === current ? rowInfo : new Map()) || changed;
      if (changed) {
        dirty.add(container);
        attempts.delete(container);
      } else if (propsList.length && !current) {
        dirty.add(container); // two trees, none known as current: a render settles it
      }
      states.set(container, listState(propsList, current));
    }
    writeNestedState(states);

    // All the reads first, then all the writes, so the layout is computed once. A list whose tree
    // is not known yet keeps its rows as they are until its next render.
    const plans = [];
    for (const [container, { rows }] of lists) {
      const state = states.get(container);
      if (state === null) continue;
      for (const row of rows) plans.push(readRow(row, state === 'on' ? rowInfo.get(row.getAttribute('data-list-key')) : undefined));
    }
    for (const plan of plans) writeRow(plan);
    lastRowInfo = rowInfo;
    enhanceContextMenu();

    // Hand the anchor to the list that holds the anchor row.
    if (pendingAnchor) {
      for (const container of lists.keys()) {
        if (dirty.has(container) && rowByKey(container, pendingAnchor.key)) anchors.set(container, pendingAnchor);
      }
      pendingAnchor = null;
    }

    // Last, so that our own DOM changes above are not taken for Linear's update.
    for (const container of lists.keys()) {
      if (dirty.has(container) && !nudging.has(container)) rerender(container);
    }
  }

  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      observer.disconnect();
      try {
        apply();
      } catch (error) {
        console.warn('[linear-subissue-collapse]', error);
      } finally {
        observe();
      }
    });
  }

  // Only changes that can matter trigger a pass: inside a list, rows or menus appearing, and the
  // options on <html>. Typing in an issue, for instance, does not.
  const isOurs = (node) => node.nodeType === 1 && [...node.classList].some((c) => c.startsWith('lsc-'));
  const bringsRowsOrMenu = (node) =>
    node.nodeType === 1 &&
    (node.matches(`${ROW_SELECTOR}, [role="dialog"]`) || node.querySelector(`${ROW_SELECTOR}, [role="dialog"]`));

  function isRelevant(record) {
    if (record.target === ROOT) return true;
    const nodes = [...record.addedNodes, ...record.removedNodes];
    if (nodes.length && nodes.every(isOurs)) return false;
    const el = record.target.nodeType === 1 ? record.target : record.target.parentElement;
    if (el?.closest('[data-lsc-list]')) return true;
    // The right-click menu fills its items after the dialog itself appears.
    if (lastContextMenu && el?.closest('[role="dialog"]')) return true;
    return [...record.addedNodes].some(bringsRowsOrMenu);
  }

  const observer = new MutationObserver((records) => {
    if (records.some(isRelevant)) schedule();
  });
  function observe() {
    observer.observe(document.body, { childList: true, subtree: true });
    observer.observe(ROOT, { attributes: true, attributeFilter: ['data-lsc-collapse'] });
  }
  observe();
  schedule();
})();
