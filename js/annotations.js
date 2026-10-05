/* =============================================================================
   PDFy – Annotations Module
   Manages Fabric.js canvas overlays per page for all annotation types:
     - Highlight, underline, strikethrough (drag-drawn colored rectangles)
     - Freehand pen drawing
     - Text boxes (editable IText)
     - Sticky notes (draggable HTML overlay)
     - Signature placement (image object)
   Includes full undo/redo stack and serialization for save/restore.
   ============================================================================= */

const Annotations = (() => {
  // Per-page state
  const _canvases    = {};  // { pageIndex: fabric.Canvas }
  const _stickyNotes = {};  // { pageIndex: [HTMLElement] }
  const _history     = {};  // { pageIndex: { undo: [], redo: [] } }

  // Current settings
  let _currentTool  = 'select';
  let _currentColor = '#FFEB3B';
  let _penSize      = 3;
  let _fontSize     = 16;

  // Callback
  let _onSelectionChange = null;

  // ── Init a page's Fabric canvas ───────────────────────────────────────────
  /**
   * Create and attach a Fabric.js canvas for one page.
   * @param {number}      pageIndex  0-based page index
   * @param {HTMLElement} wrapper    The .page-wrapper div
   * @param {number}      width      Canvas width in CSS px
   * @param {number}      height     Canvas height in CSS px
   */
  function initPage(pageIndex, wrapper, width, height) {
    // Dispose any existing Fabric canvas for this page (but keep the DOM
    // element if it is still in the wrapper so we can reuse it).
    if (_canvases[pageIndex]) {
      try { _canvases[pageIndex].dispose(); } catch (e) {}
      delete _canvases[pageIndex];
    }

    // Reuse an existing annotation-canvas element if one is already in the
    // wrapper; otherwise create a fresh one.  This prevents a second canvas
    // from being appended on zoom / re-render, which was the other half of
    // the insertBefore crash.
    let canvasEl = wrapper.querySelector('.annotation-canvas');
    if (!canvasEl) {
      canvasEl = document.createElement('canvas');
      canvasEl.className = 'annotation-canvas';
      wrapper.appendChild(canvasEl);
    }

    // Always sync dimensions to the new viewport size.
    canvasEl.width        = width;
    canvasEl.height       = height;
    canvasEl.style.width  = width  + 'px';
    canvasEl.style.height = height + 'px';

    const fc = new fabric.Canvas(canvasEl, {
      selection:              true,
      preserveObjectStacking: true,
      enableRetinaScaling:    false,
    });

    if (fc.wrapperEl) {
      fc.wrapperEl.classList.add('canvas-container');
      fc.wrapperEl.style.position = 'absolute';
      fc.wrapperEl.style.top = '0';
      fc.wrapperEl.style.left = '0';
    }

    _canvases[pageIndex] = fc;
    _history[pageIndex]  = { undo: [], redo: [] };

    // Apply the currently active tool to this canvas
    _applyTool(pageIndex);

    // Selection events
    fc.on('selection:created', () => _onSelectionChange && _onSelectionChange(true));
    fc.on('selection:updated', () => _onSelectionChange && _onSelectionChange(true));
    fc.on('selection:cleared', () => _onSelectionChange && _onSelectionChange(false));

    // History events – save state after any change
    fc.on('object:added',    () => _saveHistoryState(pageIndex));
    fc.on('object:modified', () => _saveHistoryState(pageIndex));
    fc.on('object:removed',  () => _saveHistoryState(pageIndex));

    // Mouse events for annotation drawing
    fc.on('mouse:down', e => _handleMouseDown(pageIndex, e));

    return fc;
  }

  // ── Tool management ───────────────────────────────────────────────────────
  function setTool(tool) {
    _currentTool = tool;
    Object.keys(_canvases).forEach(pi => _applyTool(parseInt(pi)));
    document.querySelectorAll('.page-wrapper').forEach(w => {
      w.dataset.tool = tool;
    });
  }

  function setColor(color)   { _currentColor = color; }
  function setPenSize(size)  { _penSize = size; }
  function setFontSize(size) { _fontSize = size; }

  function _applyTool(pageIndex) {
    const fc = _canvases[pageIndex];
    if (!fc) return;

    const isSelect = (_currentTool === 'select');

    // Pointer events on Fabric wrapper & upper canvas
    if (fc.wrapperEl) {
      fc.wrapperEl.style.pointerEvents = isSelect ? 'none' : 'auto';
    }
    if (fc.upperCanvasEl) {
      fc.upperCanvasEl.style.pointerEvents = isSelect ? 'none' : 'auto';
    }

    // Reset to defaults
    fc.isDrawingMode = false;
    fc.selection     = !isSelect;
    fc.defaultCursor = 'default';

    switch (_currentTool) {
      case 'pen':
        fc.isDrawingMode              = true;
        fc.freeDrawingBrush.color     = _currentColor;
        fc.freeDrawingBrush.width     = _penSize;
        fc.defaultCursor              = 'crosshair';
        break;

      case 'highlight':
      case 'underline':
      case 'strikethrough':
        fc.selection     = false;
        fc.defaultCursor = 'crosshair';
        break;

      case 'text':
        fc.selection     = false;
        fc.defaultCursor = 'text';
        break;

      case 'note':
      case 'sign':
        fc.selection     = false;
        fc.defaultCursor = 'copy';
        break;

      case 'select':
      default:
        fc.selection = false;
        break;
    }
  }

  // ── Mouse handler ─────────────────────────────────────────────────────────
  function _handleMouseDown(pageIndex, e) {
    const fc = _canvases[pageIndex];
    if (!fc) return;
    const pointer = fc.getPointer(e.e);

    switch (_currentTool) {
      case 'highlight':
      case 'underline':
      case 'strikethrough':
        _startDragAnnotation(pageIndex, pointer);
        break;

      case 'text':
        if (!e.target) _addTextBox(pageIndex, pointer);
        break;

      case 'note':
        if (!e.target) _triggerStickyNote(pageIndex, pointer);
        break;

      case 'sign':
        if (!e.target) _triggerSignaturePlacement(pageIndex, pointer);
        break;
    }
  }

  // ── Drag-drawn annotation (highlight / underline / strikethrough) ─────────
  function _startDragAnnotation(pageIndex, startPointer) {
    const fc = _canvases[pageIndex];
    if (!fc) return;

    let rect = null;

    const onMouseMove = opt => {
      const ptr    = fc.getPointer(opt.e);
      const left   = Math.min(startPointer.x, ptr.x);
      const top    = Math.min(startPointer.y, ptr.y);
      const width  = Math.abs(ptr.x - startPointer.x);
      const height = Math.abs(ptr.y - startPointer.y);

      if (!rect) {
        const isLine = _currentTool === 'underline' || _currentTool === 'strikethrough';
        rect = new fabric.Rect({
          left,
          top: isLine ? startPointer.y - (_currentTool === 'strikethrough' ? 8 : 2) : top,
          width,
          height: isLine ? 3 : Math.max(height, 4),
          fill:        isLine ? _currentColor : hexToRgba(_currentColor, 0.35),
          stroke:      'transparent',
          strokeWidth: 0,
          selectable:  true,
          evented:     true,
          data:        { tool: _currentTool, color: _currentColor },
        });
        fc.add(rect);
      } else {
        if (_currentTool === 'underline') {
          rect.set({ left, width });
        } else if (_currentTool === 'strikethrough') {
          rect.set({ left, width });
        } else {
          rect.set({ left, top, width, height: Math.max(height, 4) });
        }
        fc.renderAll();
      }
    };

    const onMouseUp = () => {
      fc.off('mouse:move', onMouseMove);
      fc.off('mouse:up',   onMouseUp);
      if (rect) {
        rect.setCoords();
        fc.setActiveObject(rect);
        fc.renderAll();
      }
    };

    fc.on('mouse:move', onMouseMove);
    fc.on('mouse:up',   onMouseUp);
  }

  // ── Text box ──────────────────────────────────────────────────────────────
  function _addTextBox(pageIndex, pointer) {
    const fc = _canvases[pageIndex];
    if (!fc) return;

    const text = new fabric.IText('Text', {
      left:      pointer.x,
      top:       pointer.y,
      fontSize:  _fontSize,
      fill:      _currentColor,
      editable:  true,
      data:      { tool: 'text' },
    });

    fc.add(text);
    fc.setActiveObject(text);
    text.enterEditing();
    text.selectAll();
    fc.renderAll();
  }

  // ── Sticky note ───────────────────────────────────────────────────────────
  let _pendingNotePageIndex = -1;
  let _pendingNotePointer   = null;

  function _triggerStickyNote(pageIndex, pointer) {
    _pendingNotePageIndex = pageIndex;
    _pendingNotePointer   = pointer;
    document.dispatchEvent(new CustomEvent('pdfy:request-note'));
  }

  /** Called by app.js after user types note text in the modal. */
  function placeNote(text) {
    if (_pendingNotePageIndex < 0 || !_pendingNotePointer) return;
    const pageIndex = _pendingNotePageIndex;
    const pointer   = _pendingNotePointer;
    const fc        = _canvases[pageIndex];
    if (!fc) return;

    const wrapper = fc.getElement().parentElement;
    _addStickyNoteEl(pageIndex, wrapper, text, pointer.x, pointer.y);

    _pendingNotePageIndex = -1;
    _pendingNotePointer   = null;
  }

  function _addStickyNoteEl(pageIndex, wrapper, text, x, y) {
    const el = document.createElement('div');
    el.className  = 'sticky-note';
    el.style.left = x + 'px';
    el.style.top  = y + 'px';
    el.innerHTML  = `
      <div class="sticky-note__header">
        📌 Note
        <button class="sticky-note__close" title="Remove note">&times;</button>
      </div>
      <div class="sticky-note__body">${escapeHtml(text)}</div>
    `;

    _makeNoteDraggable(el);

    el.querySelector('.sticky-note__close').addEventListener('click', () => {
      el.remove();
      if (_stickyNotes[pageIndex]) {
        _stickyNotes[pageIndex] = _stickyNotes[pageIndex].filter(n => n !== el);
      }
    });

    wrapper.appendChild(el);
    if (!_stickyNotes[pageIndex]) _stickyNotes[pageIndex] = [];
    _stickyNotes[pageIndex].push(el);
  }

  function _makeNoteDraggable(el) {
    let startX, startY, origLeft, origTop;
    const header = el.querySelector('.sticky-note__header');

    header.addEventListener('mousedown', e => {
      if (e.target.classList.contains('sticky-note__close')) return;
      startX   = e.clientX;
      startY   = e.clientY;
      origLeft = parseInt(el.style.left) || 0;
      origTop  = parseInt(el.style.top)  || 0;
      e.preventDefault();

      const onMove = e => {
        el.style.left = (origLeft + e.clientX - startX) + 'px';
        el.style.top  = (origTop  + e.clientY - startY) + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  }

  // ── Signature placement ───────────────────────────────────────────────────
  let _pendingSigPageIndex = -1;
  let _pendingSigPointer   = null;

  function _triggerSignaturePlacement(pageIndex, pointer) {
    _pendingSigPageIndex = pageIndex;
    _pendingSigPointer   = pointer;
    document.dispatchEvent(new CustomEvent('pdfy:request-signature'));
  }

  /** Called by signature.js after user draws/selects a signature. */
  function placeSignature(dataUrl) {
    if (_pendingSigPageIndex < 0) return;
    const pageIndex = _pendingSigPageIndex;
    const pointer   = _pendingSigPointer || { x: 50, y: 50 };
    const fc        = _canvases[pageIndex];
    if (!fc) return;

    fabric.Image.fromURL(dataUrl, img => {
      img.set({
        left:   pointer.x,
        top:    pointer.y,
        scaleX: 0.5,
        scaleY: 0.5,
        data:   { tool: 'signature' },
      });
      fc.add(img);
      fc.setActiveObject(img);
      fc.renderAll();

      // Switch back to select tool after placing
      setTool('select');
      document.dispatchEvent(new CustomEvent('pdfy:tool-changed', { detail: 'select' }));
    });

    _pendingSigPageIndex = -1;
    _pendingSigPointer   = null;
  }

  // ── Undo / Redo ───────────────────────────────────────────────────────────
  function _saveHistoryState(pageIndex) {
    const fc = _canvases[pageIndex];
    if (!fc) return;
    const h = _history[pageIndex];
    h.undo.push(JSON.stringify(fc.toJSON(['data'])));
    h.redo = [];                        // clear redo branch on new action
    if (h.undo.length > 50) h.undo.shift();  // cap history at 50 states
  }

  function undo(pageIndex) {
    const fc = _canvases[pageIndex];
    const h  = _history[pageIndex];
    if (!fc || !h || h.undo.length <= 1) return;
    h.redo.push(h.undo.pop());
    _loadState(fc, h.undo[h.undo.length - 1]);
  }

  function redo(pageIndex) {
    const fc = _canvases[pageIndex];
    const h  = _history[pageIndex];
    if (!fc || !h || h.redo.length === 0) return;
    const state = h.redo.pop();
    h.undo.push(state);
    _loadState(fc, state);
  }

  function _loadState(fc, jsonStr) {
    fc.loadFromJSON(jsonStr, () => fc.renderAll());
  }

  // ── Selection ─────────────────────────────────────────────────────────────
  function deleteSelected(pageIndex) {
    const fc = _canvases[pageIndex];
    if (!fc) return;
    const active = fc.getActiveObjects();
    if (!active.length) return;
    active.forEach(obj => fc.remove(obj));
    fc.discardActiveObject();
    fc.renderAll();
  }

  function setSelectionCallback(cb) { _onSelectionChange = cb; }

  // ── Serialization for saving ──────────────────────────────────────────────
  /**
   * Render each annotated page's Fabric canvas to a PNG data URL.
   * Used when baking annotations into the exported PDF.
   * @returns {Object}  { pageIndex: dataUrlString }
   */
  function getAnnotationImages() {
    const result = {};
    Object.keys(_canvases).forEach(pi => {
      const fc = _canvases[parseInt(pi)];
      if (!fc || fc.getObjects().length === 0) return;
      result[parseInt(pi)] = fc.toDataURL({ format: 'png', multiplier: 1 });
    });
    return result;
  }

  /** Serialize all canvas states to JSON (for IndexedDB persistence). */
  function serialize() {
    const result = {};
    Object.keys(_canvases).forEach(pi => {
      const fc = _canvases[parseInt(pi)];
      if (!fc) return;
      result[parseInt(pi)] = fc.toJSON(['data']);
    });
    return result;
  }

  /** Restore canvases from serialized JSON (loaded from IndexedDB). */
  function deserialize(data) {
    if (!data) return;
    Object.keys(data).forEach(pi => {
      const fc = _canvases[parseInt(pi)];
      if (!fc) return;
      fc.loadFromJSON(data[pi], () => fc.renderAll());
    });
  }

  /** Dispose all canvases – call when closing a file. */
  function disposeAll() {
    Object.keys(_canvases).forEach(pi => {
      try { _canvases[pi].dispose(); } catch (e) {}
      delete _canvases[pi];
    });
    Object.keys(_stickyNotes).forEach(pi => {
      (_stickyNotes[pi] || []).forEach(el => el.remove());
      delete _stickyNotes[pi];
    });
    Object.keys(_history).forEach(pi => delete _history[pi]);
  }

  // ── Utilities ─────────────────────────────────────────────────────────────
  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;');
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    initPage,
    setTool, setColor, setPenSize, setFontSize,
    placeNote, placeSignature,
    undo, redo, deleteSelected,
    setSelectionCallback,
    getAnnotationImages,
    serialize, deserialize, disposeAll,
    get currentTool() { return _currentTool; },
  };
})();
