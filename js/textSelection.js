/* =============================================================================
   PDFy – Text Selection & Markup Module
   Provides:
     - PDF.js text layer rendering (real selectable text on each page)
     - Floating toolbar on text selection (Highlight, Underline, Strikethrough,
       Copy, Add Note)
     - Text-aware markup stored as PDF.js quads, rendered as clean overlays
     - Undo/redo for text markups
     - Scanned-page detection (pages with no text items → show scan notice)
     - Search result highlights on the text layer
   ============================================================================= */

const TextSelection = (() => {
  // ── State ──────────────────────────────────────────────────────────────────
  let _pdfDoc        = null;
  let _getScale      = null;
  let _getWrapper    = null;

  // Markup storage: { pageIndex: [ { type, color, rects:[{x,y,w,h}] } ] }
  const _markups     = {};
  // Undo/redo stacks: { pageIndex: { undo:[], redo:[] } }
  const _history     = {};
  // Text content cache: { pageIndex: textContent }
  const _textCache   = {};

  // Toolbar DOM (shared, moved to wherever needed)
  let _toolbar       = null;
  let _currentColor  = '#FFEB3B';

  // ── Init ───────────────────────────────────────────────────────────────────
  function init({ pdfDoc, getScale, getWrapper }) {
    _pdfDoc   = pdfDoc;
    _getScale = getScale;
    _getWrapper = getWrapper;
    _createToolbar();
    // Install document-level selection listeners (idempotent)
    if (!init._selListenerAttached) {
      document.addEventListener('selectionchange', _onGlobalSelectionChange);
      document.addEventListener('mouseup', () => {
        setTimeout(_onGlobalSelectionChange, 10);
      });
      init._selListenerAttached = true;
    }
  }

  // ── Render text layer for one page ────────────────────────────────────────
  /**
   * Build (or rebuild) the PDF.js text layer for a page.
   * Must be called after the pdf-canvas has been rendered so we know the
   * correct viewport dimensions.
   */
  async function renderTextLayer(pageIndex, wrapper, viewport) {
    if (!_pdfDoc) return;

    // Remove any old text layer
    const old = wrapper.querySelector('.textLayer');
    if (old) old.remove();

    const pageNum = pageIndex + 1;
    const page    = await _pdfDoc.getPage(pageNum);
    const content = await page.getTextContent();

    // Cache for search
    _textCache[pageIndex] = content;

    // Detect scanned page (no meaningful text items)
    const hasText = content.items.some(it => it.str && it.str.trim().length > 0);
    _setScanNotice(wrapper, !hasText);

    if (!hasText) return;

    // Create text layer container
    const textDiv = document.createElement('div');
    textDiv.className = 'textLayer';
    textDiv.style.width  = viewport.width  + 'px';
    textDiv.style.height = viewport.height + 'px';
    textDiv.style.setProperty('--scale-factor', viewport.scale);
    wrapper.appendChild(textDiv);

    // Render using PDF.js renderTextLayer
    if (pdfjsLib.renderTextLayer) {
      const task = pdfjsLib.renderTextLayer({
        textContentSource: content,
        container:   textDiv,
        viewport:    viewport,
        textDivs:    [],
      });
      try { await task.promise; } catch (e) { /* ignore cancel */ }
    }

    // Re-draw markups on top
    _renderMarkupLayer(pageIndex, wrapper);

    // Selection events for the floating toolbar
    _attachSelectionEvents(pageIndex, wrapper);
  }

  // ── Scanned-page notice ───────────────────────────────────────────────────
  function _setScanNotice(wrapper, isScanned) {
    let notice = wrapper.querySelector('.scan-notice');
    if (isScanned) {
      if (!notice) {
        notice = document.createElement('div');
        notice.className = 'scan-notice';
        notice.textContent = '📷 This page is a scan — text cannot be selected.';
        wrapper.appendChild(notice);
      }
    } else {
      if (notice) notice.remove();
    }
  }

  // ── Selection events & floating toolbar ───────────────────────────────────
  function _attachSelectionEvents(pageIndex, wrapper) {
    // Selection is handled globally by _onGlobalSelectionChange (set up in init).
  }

  function _onGlobalSelectionChange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim() || !sel.rangeCount) {
      setTimeout(() => {
        const s2 = window.getSelection();
        if (!s2 || s2.isCollapsed || !s2.toString().trim()) _hideToolbar();
      }, 150);
      return;
    }

    // Find which page-wrapper the selection anchor or focus lives in
    const anchor = sel.anchorNode;
    const focus  = sel.focusNode;
    const node   = anchor || focus;
    if (!node) return;

    const wrappers = document.querySelectorAll('.page-wrapper');
    for (const wrapper of wrappers) {
      const textDiv = wrapper.querySelector('.textLayer');
      if (textDiv && (textDiv.contains(anchor) || textDiv.contains(focus))) {
        const pageIndex = parseInt(wrapper.dataset.pageIndex);
        if (!isNaN(pageIndex)) {
          _showToolbar(sel, pageIndex, wrapper);
        }
        return;
      }
    }
    // Selection not inside any text layer – hide toolbar
    _hideToolbar();
  }

  // ── Floating toolbar ──────────────────────────────────────────────────────
  function _createToolbar() {
    if (_toolbar) return;
    _toolbar = document.createElement('div');
    _toolbar.className = 'text-sel-toolbar';
    _toolbar.innerHTML = `
      <button data-action="highlight"      title="Highlight">🖊 Highlight</button>
      <button data-action="underline"      title="Underline">U̲ Underline</button>
      <button data-action="strikethrough"  title="Strikethrough"><s>S</s> Strike</button>
      <div class="text-sel-toolbar__sep"></div>
      <button data-action="copy"           title="Copy (Ctrl+C)">⎘ Copy</button>
      <button data-action="note"           title="Add Note">📌 Note</button>
    `;
    document.body.appendChild(_toolbar);

    _toolbar.addEventListener('mousedown', e => e.preventDefault()); // keep selection alive

    _toolbar.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const sel = window.getSelection();
        if (action === 'copy') {
          _copySelection(sel);
        } else if (action === 'note') {
          _requestNote(sel);
          _hideToolbar();
        } else {
          _applyMarkup(action, sel);
          _hideToolbar();
        }
      });
    });

    // Hide when clicking elsewhere
    document.addEventListener('mousedown', e => {
      if (_toolbar && !_toolbar.contains(e.target)) {
        setTimeout(_hideToolbar, 50);
      }
    });
  }

  function _showToolbar(sel, pageIndex, wrapper) {
    if (!_toolbar) return;
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const rect  = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;

    _toolbar.dataset.pageIndex = pageIndex;

    const toolbarW = 340;
    const toolbarH = 38;

    // Center horizontally over the selection range, clamped within screen bounds
    let x = rect.left + rect.width / 2;
    x = Math.max(toolbarW / 2 + 12, Math.min(window.innerWidth - toolbarW / 2 - 12, x));

    // Position above the selection if room, otherwise below
    const topBarHeight = 100; // top main + annotation toolbar
    let y = rect.top - 10;
    if (y - toolbarH < topBarHeight) {
      // Not enough room above, position right below selection
      y = rect.bottom + 10;
      _toolbar.style.transform = 'translateX(-50%) translateY(0)';
    } else {
      _toolbar.style.transform = 'translateX(-50%) translateY(-100%)';
    }

    _toolbar.style.left    = x + 'px';
    _toolbar.style.top     = y + 'px';
    _toolbar.style.display = 'flex';
    _toolbar.style.opacity = '1';
  }

  function _hideToolbar() {
    if (_toolbar) {
      _toolbar.style.display = 'none';
    }
  }

  // ── Apply markup to selected text ─────────────────────────────────────────
  function _applyMarkup(type, sel) {
    if (!sel || sel.isCollapsed) return;
    const pageIndex = parseInt(_toolbar?.dataset.pageIndex ?? '-1');
    if (pageIndex < 0) return;

    const wrapper = _getWrapper(pageIndex);
    if (!wrapper) return;

    const scale = (_getScale ? _getScale() : 1) || 1;

    // Collect bounding rects for each line of the selection (normalized to scale 1.0)
    const range  = sel.getRangeAt(0);
    const rects  = _getLineRects(range, wrapper, scale);
    if (!rects.length) return;

    const markup = { type, color: _currentColor, rects };

    if (!_markups[pageIndex]) _markups[pageIndex] = [];
    _markups[pageIndex].push(markup);
    _saveHistory(pageIndex);

    _renderMarkupLayer(pageIndex, wrapper);

    sel.removeAllRanges();
  }

  /**
   * Convert a DOM Range to an array of {x,y,w,h} rects relative to the
   * page wrapper (normalized by scale), one per visual line.
   */
  function _getLineRects(range, wrapper, scale = 1) {
    const wrapRect = wrapper.getBoundingClientRect();
    const clientRects = Array.from(range.getClientRects());
    const out = [];
    for (const cr of clientRects) {
      if (cr.width < 1 || cr.height < 1) continue;
      out.push({
        x: (cr.left - wrapRect.left) / scale,
        y: (cr.top  - wrapRect.top)  / scale,
        w: cr.width  / scale,
        h: cr.height / scale,
      });
    }
    return _mergeAdjacentRects(out);
  }

  /** Merge rects on the same visual line (same y ± tolerance). */
  function _mergeAdjacentRects(rects) {
    if (!rects.length) return rects;
    rects.sort((a, b) => a.y - b.y || a.x - b.x);
    const merged = [{ ...rects[0] }];
    for (let i = 1; i < rects.length; i++) {
      const prev = merged[merged.length - 1];
      const cur  = rects[i];
      const tol  = prev.h * 0.4;
      if (Math.abs(cur.y - prev.y) < tol && Math.abs(cur.h - prev.h) < tol) {
        // Same line – extend
        const right = Math.max(prev.x + prev.w, cur.x + cur.w);
        prev.x = Math.min(prev.x, cur.x);
        prev.w = right - prev.x;
      } else {
        merged.push({ ...cur });
      }
    }
    return merged;
  }

  // ── Markup rendering layer ─────────────────────────────────────────────────
  function _renderMarkupLayer(pageIndex, wrapper) {
    // Remove old markup overlay
    let layer = wrapper.querySelector('.markup-layer');
    if (layer) layer.remove();

    const markups = _markups[pageIndex];
    if (!markups || !markups.length) return;

    const scale = (_getScale ? _getScale() : 1) || 1;

    layer = document.createElement('div');
    layer.className = 'markup-layer';
    layer.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:3;overflow:hidden;';

    for (const m of markups) {
      for (const r of m.rects) {
        const div = document.createElement('div');
        div.className = 'markup-rect markup-rect--' + m.type;
        const rgba = _hexToRgba(m.color,
          m.type === 'highlight' ? 0.35
          : m.type === 'underline' ? 0.9
          : 0.7
        );

        const x = r.x * scale;
        const y = r.y * scale;
        const w = r.w * scale;
        const h = r.h * scale;

        if (m.type === 'highlight') {
          div.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${rgba};`;
        } else if (m.type === 'underline') {
          div.style.cssText = `left:${x}px;top:${y + h - 2}px;width:${w}px;height:2px;background:${rgba};`;
        } else if (m.type === 'strikethrough') {
          div.style.cssText = `left:${x}px;top:${y + h * 0.5 - 1}px;width:${w}px;height:2px;background:${rgba};`;
        }
        layer.appendChild(div);
      }
    }

    // Insert before the annotation canvas / container (z-index 3 < 4)
    const annCanvas = wrapper.querySelector('.canvas-container') || wrapper.querySelector('.annotation-canvas');
    if (annCanvas && annCanvas.parentNode === wrapper) {
      wrapper.insertBefore(layer, annCanvas);
    } else {
      wrapper.appendChild(layer);
    }
  }

  // ── Copy ──────────────────────────────────────────────────────────────────
  function _copySelection(sel) {
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString();
    navigator.clipboard.writeText(text).catch(() => {
      // Fallback
      document.execCommand('copy');
    });
    _hideToolbar();
  }

  // ── Note (delegates to app modal) ─────────────────────────────────────────
  function _requestNote(sel) {
    document.dispatchEvent(new CustomEvent('pdfy:request-note'));
  }

  // ── Undo / Redo ───────────────────────────────────────────────────────────
  function _saveHistory(pageIndex) {
    if (!_history[pageIndex]) _history[pageIndex] = { undo: [], redo: [] };
    const h = _history[pageIndex];
    h.undo.push(JSON.stringify(_markups[pageIndex] || []));
    h.redo = [];
    if (h.undo.length > 50) h.undo.shift();
  }

  function undo(pageIndex) {
    const h = _history[pageIndex];
    if (!h || h.undo.length <= 1) return;
    h.redo.push(h.undo.pop());
    _markups[pageIndex] = JSON.parse(h.undo[h.undo.length - 1]);
    const w = _getWrapper(pageIndex);
    if (w) _renderMarkupLayer(pageIndex, w);
  }

  function redo(pageIndex) {
    const h = _history[pageIndex];
    if (!h || !h.redo.length) return;
    const state = h.redo.pop();
    h.undo.push(state);
    _markups[pageIndex] = JSON.parse(state);
    const w = _getWrapper(pageIndex);
    if (w) _renderMarkupLayer(pageIndex, w);
  }

  // ── Keyboard shortcut (Ctrl+C) ────────────────────────────────────────────
  function handleKeydown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        // Let the browser handle it natively (it works in text layers)
      }
    }
  }

  function _hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // ── Color setter (mirrors annotation toolbar color) ───────────────────────
  function setColor(color) { _currentColor = color; }

  // ── Serialization (for save/restore) ─────────────────────────────────────
  function serialize() {
    // Deep copy markups
    const out = {};
    Object.keys(_markups).forEach(pi => {
      out[pi] = JSON.parse(JSON.stringify(_markups[pi]));
    });
    return out;
  }

  function deserialize(data) {
    if (!data) return;
    Object.keys(data).forEach(pi => {
      const idx = parseInt(pi);
      _markups[idx] = data[pi];
      const w = _getWrapper ? _getWrapper(idx) : null;
      if (w) _renderMarkupLayer(idx, w);
    });
  }

  function disposeAll() {
    Object.keys(_markups).forEach(k => delete _markups[k]);
    Object.keys(_history).forEach(k => delete _history[k]);
    Object.keys(_textCache).forEach(k => delete _textCache[k]);
    _hideToolbar();
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    init, renderTextLayer,
    setColor,
    undo, redo,
    handleKeydown,
    serialize, deserialize, disposeAll,
  };
})();
