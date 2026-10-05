/* =============================================================================
   PidiFie – Signature Module
   Handles the signature drawing canvas (modal), saves/loads from IndexedDB,
   and coordinates with Annotations.placeSignature().
   ============================================================================= */

const Signature = (() => {
  let _canvas     = null;   // raw <canvas> element
  let _ctx        = null;   // 2D context
  let _drawing    = false;
  let _hasStrokes = false;
  let _savedDataUrl = null; // cached saved signature

  // ── Init the drawing canvas ───────────────────────────────────────────────
  function init() {
    _canvas = document.getElementById('sig-canvas');
    if (!_canvas) return;
    _ctx = _canvas.getContext('2d');

    // Set up drawing listeners
    _canvas.addEventListener('mousedown',  _onStart);
    _canvas.addEventListener('mousemove',  _onMove);
    _canvas.addEventListener('mouseup',    _onEnd);
    _canvas.addEventListener('mouseleave', _onEnd);

    // Touch support
    _canvas.addEventListener('touchstart',  _onTouchStart,  { passive: false });
    _canvas.addEventListener('touchmove',   _onTouchMove,   { passive: false });
    _canvas.addEventListener('touchend',    _onEnd);

    _styleCtx();
  }

  function _styleCtx() {
    if (!_ctx) return;
    _ctx.lineWidth   = 2.5;
    _ctx.lineCap     = 'round';
    _ctx.lineJoin    = 'round';
    _ctx.strokeStyle = '#1a1a2e';
  }

  // ── Drawing handlers ──────────────────────────────────────────────────────
  function _getPos(e) {
    const rect = _canvas.getBoundingClientRect();
    // Scale mouse coords to canvas resolution
    const scaleX = _canvas.width  / rect.width;
    const scaleY = _canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top)  * scaleY,
    };
  }

  function _onStart(e) {
    e.preventDefault();
    _drawing = true;
    _hasStrokes = true;
    const { x, y } = _getPos(e);
    _ctx.beginPath();
    _ctx.moveTo(x, y);
  }

  function _onMove(e) {
    if (!_drawing) return;
    e.preventDefault();
    const { x, y } = _getPos(e);
    _ctx.lineTo(x, y);
    _ctx.stroke();
  }

  function _onEnd(e) {
    _drawing = false;
    _ctx.beginPath(); // reset path so next stroke is independent
  }

  function _onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 0) return;
    _onStart({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY, preventDefault: () => {} });
  }

  function _onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 0) return;
    _onMove({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY, preventDefault: () => {} });
  }

  // ── Clear canvas ──────────────────────────────────────────────────────────
  function clear() {
    if (!_canvas || !_ctx) return;
    _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
    _hasStrokes = false;
  }

  // ── Open the signature modal ──────────────────────────────────────────────
  async function openModal() {
    const modal = document.getElementById('modal-signature');
    if (!modal) return;

    modal.style.display = 'flex';
    clear();

    // Pre-fill with saved signature if it exists
    _savedDataUrl = await Storage.loadSignature();
    if (_savedDataUrl) {
      const img = new Image();
      img.onload = () => {
        _ctx.drawImage(img, 0, 0, _canvas.width, _canvas.height);
        _hasStrokes = true;
      };
      img.src = _savedDataUrl;
    }

    // Focus modal for accessibility
    document.getElementById('sig-place').focus();
  }

  function closeModal() {
    const modal = document.getElementById('modal-signature');
    if (modal) modal.style.display = 'none';
    clear();
  }

  // ── Place signature ───────────────────────────────────────────────────────
  /**
   * Export the canvas as PNG, optionally save to IndexedDB, then dispatch
   * to Annotations module for placement on the page.
   */
  async function place() {
    if (!_canvas || !_hasStrokes) {
      App.showToast('Please draw your signature first', 'error');
      return;
    }

    // Trim whitespace from signature for a tighter crop
    const dataUrl = _trimCanvas();

    // Save if checkbox is checked
    const saveCheckbox = document.getElementById('sig-save');
    if (saveCheckbox && saveCheckbox.checked) {
      await Storage.saveSignature(dataUrl);
      _savedDataUrl = dataUrl;
    }

    closeModal();
    Annotations.placeSignature(dataUrl);
  }

  /**
   * Crop the canvas to just the drawn content (removes whitespace margins).
   * Returns a data URL of the trimmed image.
   */
  function _trimCanvas() {
    const pixels = _ctx.getImageData(0, 0, _canvas.width, _canvas.height);
    const data   = pixels.data;
    let top = _canvas.height, left = _canvas.width, right = 0, bottom = 0;

    for (let y = 0; y < _canvas.height; y++) {
      for (let x = 0; x < _canvas.width; x++) {
        const alpha = data[(y * _canvas.width + x) * 4 + 3];
        if (alpha > 0) {
          if (x < left)   left   = x;
          if (x > right)  right  = x;
          if (y < top)    top    = y;
          if (y > bottom) bottom = y;
        }
      }
    }

    if (right < left || bottom < top) {
      // Nothing drawn — return full canvas
      return _canvas.toDataURL('image/png');
    }

    const pad = 8;
    const trimLeft   = Math.max(0, left   - pad);
    const trimTop    = Math.max(0, top    - pad);
    const trimWidth  = Math.min(_canvas.width,  right  + pad) - trimLeft;
    const trimHeight = Math.min(_canvas.height, bottom + pad) - trimTop;

    const tmpCanvas     = document.createElement('canvas');
    tmpCanvas.width     = trimWidth;
    tmpCanvas.height    = trimHeight;
    const tmpCtx        = tmpCanvas.getContext('2d');
    tmpCtx.drawImage(_canvas, trimLeft, trimTop, trimWidth, trimHeight, 0, 0, trimWidth, trimHeight);
    return tmpCanvas.toDataURL('image/png');
  }

  // ── Load saved signature directly (no modal) ──────────────────────────────
  async function placeFromSaved() {
    const dataUrl = await Storage.loadSignature();
    if (dataUrl) {
      Annotations.placeSignature(dataUrl);
    } else {
      openModal();
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return { init, openModal, closeModal, place, clear, placeFromSaved };
})();
