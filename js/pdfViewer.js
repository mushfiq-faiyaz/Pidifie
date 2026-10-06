/* =============================================================================
   PidiFie – PDF Viewer Module
   Renders a PDF document using PDF.js. Responsibilities:
     - Loading PDF bytes and rendering pages to <canvas> elements
     - Managing zoom (fit-width, fit-page, percentage)
     - Generating thumbnail previews in the side panel
     - Document bookmarks outline rendering
     - Smooth scrolling / page navigation
     - Exposing the visible page index for annotations and history
   ============================================================================= */

const PdfViewer = (() => {
  // PDF.js config – use the same CDN version as the script tag
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let _pdfDoc        = null;   // PDFDocumentProxy
  let _pdfBytes      = null;   // raw Uint8Array (kept for save/export)
  let _scale         = 1.0;
  let _currentPage   = 1;      // 1-based
  let _renderTasks   = {};     // { pageNum: RenderTask } (for cancellation)
  let _pageWrappers  = {};     // { pageIndex: HTMLElement }
  let _thumbnailCanvases = {}; // { pageIndex: HTMLCanvasElement }
  let _fileName      = '';
  let _onPageChange  = null;   // callback: (pageNum, totalPages) => void

  // Generation counter – incremented on every load/cleanup so in-flight
  // background renders from a previous load can detect they are stale and
  // abort before touching the DOM.
  let _generation    = 0;
  // Track how many background renders are still running for the current load.
  let _pendingRenders = 0;

  // When > 0, the scroll listener must not update _currentPage (we are
  // programmatically setting scroll as part of a zoom operation).
  let _suppressScrollDetect = 0;

  // DOM refs
  const _container    = () => document.getElementById('pages-container');
  const _thumbContainer = () => document.getElementById('thumbnail-container');
  const _viewer       = () => document.getElementById('viewer');

  // ── Load document ─────────────────────────────────────────────────────────
  /**
   * Load a PDF from a raw Uint8Array.
   * @param {Uint8Array} bytes
   * @param {string}     fileName
   * @param {number}     startPage  1-based page to restore position to
   */
  async function loadDocument(bytes, fileName, startPage = 1) {
    // Clean up previous document
    _cleanup();

    _pdfBytes = bytes;
    _fileName = fileName;

    const loadingTask = pdfjsLib.getDocument({ data: bytes });
    _pdfDoc = await loadingTask.promise;

    const total = _pdfDoc.numPages;

    // Update sidebar count
    const countEl = document.getElementById('sidebar-page-count');
    if (countEl) countEl.textContent = total;

    // Update total pages display in topbar
    const totalEl = document.getElementById('total-pages');
    if (totalEl) totalEl.textContent = total;

    // Update page number input max
    const pageInput = document.getElementById('page-num-input');
    if (pageInput) pageInput.max = total;

    // Init Search module
    Search.init({
      pdfDoc:         _pdfDoc,
      onJumpToPage:   (idx) => goToPage(idx + 1),
      getPageScale:   () => _scale,
      getPageWrapper: (idx) => _pageWrappers[idx],
    });

    // Init TextSelection module
    if (typeof TextSelection !== 'undefined') {
      TextSelection.init({
        pdfDoc:     _pdfDoc,
        getScale:   () => _scale,
        getWrapper: (idx) => _pageWrappers[idx],
      });
    }

    // Render all pages
    await _renderAllPages();

    // Render thumbnails
    _renderThumbnails();

    // Render bookmarks outline
    _renderBookmarks();

    // Jump to saved page
    const clampedPage = Math.min(Math.max(startPage, 1), total);
    if (clampedPage > 1) {
      setTimeout(() => goToPage(clampedPage), 100);
    }

    // Init annotations for all pages
    _initAnnotationLayers();

    return _pdfDoc;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  function _cleanup() {
    // Invalidate all in-flight background renders from the previous load.
    _generation++;
    _pendingRenders = 0;

    // Cancel any in-progress render tasks
    Object.values(_renderTasks).forEach(task => { try { task.cancel(); } catch (e) {} });
    _renderTasks = {};

    // Dispose annotation canvases
    Annotations.disposeAll();

    // Dispose text selection state
    if (typeof TextSelection !== 'undefined') {
      TextSelection.disposeAll();
    }

    // Clear DOM
    const c = _container();
    if (c) c.innerHTML = '';
    const t = _thumbContainer();
    if (t) t.innerHTML = '';

    _pageWrappers      = {};
    _thumbnailCanvases = {};

    if (_pdfDoc) {
      _pdfDoc.destroy().catch(() => {});
      _pdfDoc = null;
    }
    _pdfBytes    = null;
    _currentPage = 1;
  }

  // ── Render all pages ──────────────────────────────────────────────────────
  async function _renderAllPages() {
    if (!_pdfDoc) return;
    const total = _pdfDoc.numPages;

    // Capture the generation that belongs to *this* load call.  Any render
    // that finds its capturedGen !== _generation when it wakes up knows the
    // user already opened a different file and should exit without touching
    // the DOM.
    const capturedGen = _generation;

    // Build page wrappers first (so the layout is stable during rendering)
    for (let pageNum = 1; pageNum <= total; pageNum++) {
      const wrapper = _buildPageWrapper(pageNum);
      _pageWrappers[pageNum - 1] = wrapper;
      _container().appendChild(wrapper);
    }

    // Render pages progressively (first 3 immediately, rest lazily).
    // We wrap every _renderPage call so it bails out if stale.
    const safeRenderPage = async (pageNum) => {
      if (_generation !== capturedGen) return; // stale – abort
      _pendingRenders++;
      try {
        await _renderPage(pageNum, capturedGen);
      } finally {
        _pendingRenders--;
      }
    };

    // Render first 3 pages immediately for quick start
    const immediate = Math.min(3, total);
    for (let i = 1; i <= immediate; i++) await safeRenderPage(i);

    // Render remaining in background – do NOT await them here so the caller
    // gets control back quickly, but each render self-guards via capturedGen.
    for (let i = immediate + 1; i <= total; i++) {
      safeRenderPage(i); // intentionally not awaited
    }
  }

  function _buildPageWrapper(pageNum) {
    const wrapper = document.createElement('div');
    wrapper.className      = 'page-wrapper';
    wrapper.dataset.page   = pageNum;
    wrapper.dataset.pageIndex = pageNum - 1;

    // Placeholder for size before render
    wrapper.style.width  = '600px';
    wrapper.style.height = '800px';

    return wrapper;
  }

  async function _renderPage(pageNum, capturedGen) {
    // capturedGen is optional (not provided for zoom re-renders, which always
    // target the current document).
    const checkGen = () => capturedGen !== undefined && _generation !== capturedGen;

    if (!_pdfDoc) return;
    const wrapper = _pageWrappers[pageNum - 1];
    if (!wrapper) return;

    const page     = await _pdfDoc.getPage(pageNum);
    // Use devicePixelRatio so the canvas is physically sharp on HiDPI / Retina screens.
    const dpr      = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: _scale });

    // Bail out if a newer load has started while we were awaiting getPage.
    if (checkGen()) return;

    // CSS size = logical pixels; canvas size = physical pixels for sharpness.
    const cssW = viewport.width;
    const cssH = viewport.height;

    // ── NO-FLASH STRATEGY ─────────────────────────────────────────────────
    // Keep any existing pdf-canvas visible until the new render is complete.
    // Only after the new canvas is fully rendered do we remove the old one and
    // swap it in.  This eliminates the white-flash during zoom re-renders.
    const oldCanvas = wrapper.querySelector('.pdf-canvas');

    // Create new HiDPI canvas — NOT yet inserted into the DOM.
    const canvas     = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.width     = Math.round(cssW * dpr);   // physical pixels
    canvas.height    = Math.round(cssH * dpr);
    canvas.style.width  = cssW + 'px';           // CSS display size
    canvas.style.height = cssH + 'px';

    // Scale context for HiDPI before rendering.
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Render at the logical scale – ctx.scale handles physical pixel density.
    const renderTask = page.render({ canvasContext: ctx, viewport });
    _renderTasks[pageNum] = renderTask;

    try {
      await renderTask.promise;
    } catch (e) {
      if (e.name !== 'RenderingCancelledException') console.error('Render error:', e);
      return; // don't swap canvases if render was cancelled
    }

    // Bail out if a newer load started while we were awaiting the render.
    if (checkGen()) return;

    // ── UPDATE WRAPPER SIZE then ATOMIC CANVAS SWAP ───────────────────────
    // Set wrapper size to final rendered size.
    wrapper.style.width  = cssW + 'px';
    wrapper.style.height = cssH + 'px';
    wrapper.style.setProperty('--scale-factor', _scale);
    // Record rendered scale + CSS dimensions so _cssScaleWrappers can
    // compute the exact ratio on the next gesture without reading stale values.
    wrapper.dataset.renderedScale  = String(_scale);
    canvas.dataset.renderedCssW    = String(cssW);
    canvas.dataset.renderedCssH    = String(cssH);

    // Insert new canvas before any annotation canvas, then remove the old one.
    // The old canvas stays in the DOM until now, preventing the blank flash.
    const annCanvas = wrapper.querySelector('.annotation-canvas');
    if (annCanvas && annCanvas.parentNode === wrapper) {
      wrapper.insertBefore(canvas, annCanvas);
    } else {
      wrapper.appendChild(canvas);
    }
    if (oldCanvas && oldCanvas.parentNode === wrapper) {
      oldCanvas.remove();
    }

    // Build/update annotation layer for this page.
    Annotations.initPage(pageNum - 1, wrapper, cssW, cssH);

    // Build/update selectable text layer for this page.
    if (typeof TextSelection !== 'undefined') {
      await TextSelection.renderTextLayer(pageNum - 1, wrapper, viewport);
    }
  }

  // ── Thumbnails ────────────────────────────────────────────────────────────
  function _renderThumbnails() {
    if (!_pdfDoc) return;
    const container = _thumbContainer();
    if (!container) return;
    container.innerHTML = '';
    _thumbnailCanvases  = {};

    const total = _pdfDoc.numPages;
    for (let pageNum = 1; pageNum <= total; pageNum++) {
      _renderThumbnail(pageNum, container, total);
    }
  }

  async function _renderThumbnail(pageNum, container, total) {
    const thumbWrapper = document.createElement('div');
    thumbWrapper.className       = 'thumbnail';
    thumbWrapper.dataset.page    = pageNum;
    thumbWrapper.title           = `Page ${pageNum}`;
    thumbWrapper.draggable       = true;
    if (pageNum === _currentPage) thumbWrapper.classList.add('active');

    const canvas  = document.createElement('canvas');
    const numEl   = document.createElement('div');
    numEl.className = 'thumbnail__num';
    numEl.textContent = pageNum;

    thumbWrapper.appendChild(canvas);
    thumbWrapper.appendChild(numEl);
    container.appendChild(thumbWrapper);

    _thumbnailCanvases[pageNum - 1] = canvas;

    // Click to navigate
    thumbWrapper.addEventListener('click', () => goToPage(pageNum));

    // Drag-to-reorder
    _setupThumbnailDrag(thumbWrapper, pageNum - 1, total);

    // Render thumbnail at low scale
    const page     = await _pdfDoc.getPage(pageNum);
    const scale    = 140 / page.getViewport({ scale: 1 }).width; // fit 140px wide
    const viewport = page.getViewport({ scale });

    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width  = '100%';
    canvas.style.height = 'auto';

    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
  }

  // ── Thumbnail drag-to-reorder ─────────────────────────────────────────────
  let _dragSrcIndex = -1;

  function _setupThumbnailDrag(thumbEl, pageIndex, total) {
    thumbEl.addEventListener('dragstart', e => {
      _dragSrcIndex = pageIndex;
      thumbEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    thumbEl.addEventListener('dragend', () => {
      thumbEl.classList.remove('dragging');
      document.querySelectorAll('.thumbnail').forEach(el => {
        el.classList.remove('drag-over');
      });
    });

    thumbEl.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // Clear other highlights
      document.querySelectorAll('.thumbnail').forEach(el => el.classList.remove('drag-over'));
      thumbEl.classList.add('drag-over');
    });

    thumbEl.addEventListener('drop', async e => {
      e.preventDefault();
      thumbEl.classList.remove('drag-over');
      const destIndex = pageIndex;
      if (_dragSrcIndex < 0 || _dragSrcIndex === destIndex) return;

      // Build new order: remove src, insert at dest
      const order = Array.from({ length: total }, (_, i) => i);
      const [removed] = order.splice(_dragSrcIndex, 1);
      order.splice(destIndex, 0, removed);

      await App.reorderPages(order);
    });
  }

  // ── Annotation layer init ─────────────────────────────────────────────────
  function _initAnnotationLayers() {
    // Canvases are initialized in _renderPage as pages complete rendering.
    // This no-op is a hook for future deferred init.
  }

  // ── Zoom ──────────────────────────────────────────────────────────────────
  //
  // DESIGN: All zoom paths funnel into _performZoom(newScale, anchorX, anchorY).
  //
  // The anchor is expressed in VIEWER-RELATIVE pixels (the point on screen that
  // should stay fixed).  Before changing the scale we convert it into
  // PAGE-SPACE coordinates:  { pageIndex, fracX, fracY }  where fracX/fracY
  // are fractions of that page's current CSS size (0..1).  After every scale
  // or scroll change we can always recompute:
  //   new scrollTop = pageWrapper.offsetTop + fracY * pageWrapper.offsetHeight - anchorY
  // This is immune to gaps, padding, and layout reflows.
  //
  // During a fast wheel/pinch gesture:
  //   – We CSS-stretch pages immediately for instant visual response.
  //   – We set scrollTop immediately using the anchor formula.
  //   – We debounce a full PDF.js re-render (~200 ms after last wheel event).
  //
  // After the re-render completes we apply the anchor formula one more time
  // to correct any sub-pixel drift introduced by the re-render layout pass.
  //
  // We suppress _detectCurrentPage() (the scroll listener) during the entire
  // zoom operation so _currentPage never flickers.

  let _zoomDebounceTimer = null;
  let _zoomCommitGen     = 0;   // incremented on each new commit so stale ones abort

  // The last-known anchor in page-space. Cleared after commit restores scroll.
  let _zoomAnchor = null; // { pageIndex, fracX, fracY, viewerAX, viewerAY }

  /**
   * Convert a viewer-relative point (ax, ay) into page-space coordinates.
   * Returns null if no page is found at that point.
   */
  function _toPageSpace(ax, ay) {
    const viewer = _viewer();
    // Absolute position in the scrollable content
    const absX = viewer.scrollLeft + ax;
    const absY = viewer.scrollTop  + ay;

    // Find which page wrapper the point falls on (or nearest one).
    let best = null;
    let bestDist = Infinity;

    Object.entries(_pageWrappers).forEach(([idxStr, wrapper]) => {
      const top    = wrapper.offsetTop;
      const left   = wrapper.offsetLeft;
      const width  = wrapper.offsetWidth;
      const height = wrapper.offsetHeight;
      const bottom = top + height;
      const right  = left + width;

      // Vertical distance from this page (0 if the point is inside the page)
      const dy = absY < top ? top - absY : absY > bottom ? absY - bottom : 0;
      const dx = absX < left ? left - absX : absX > right ? absX - right : 0;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < bestDist) {
        bestDist = dist;
        best = {
          pageIndex: parseInt(idxStr),
          fracX: width  > 0 ? (absX - left)   / width  : 0,
          fracY: height > 0 ? (absY - top)     / height : 0,
        };
      }
    });

    return best;
  }

  /**
   * Given a saved page-space anchor, compute the scrollTop that places
   * viewerAY at the same visual spot.
   */
  function _scrollTopFromAnchor(anchor) {
    const wrapper = _pageWrappers[anchor.pageIndex];
    if (!wrapper) return null;
    const top    = wrapper.offsetTop;
    const height = wrapper.offsetHeight;
    return top + anchor.fracY * height - anchor.viewerAY;
  }

  function _scrollLeftFromAnchor(anchor) {
    const wrapper = _pageWrappers[anchor.pageIndex];
    if (!wrapper) return null;
    const left  = wrapper.offsetLeft;
    const width = wrapper.offsetWidth;
    return left + anchor.fracX * width - anchor.viewerAX;
  }

  /**
   * CSS-scale every page wrapper to reflect the current _scale, WITHOUT
   * triggering a PDF.js re-render.  Gives instant visual feedback during a
   * gesture.  Uses the wrapper's last-rendered scale (stamped at render time)
   * to compute the correct ratio, so it is safe to call many times rapidly.
   */
  function _cssScaleWrappers() {
    Object.values(_pageWrappers).forEach(wrapper => {
      const canvas = wrapper.querySelector('.pdf-canvas');
      if (!canvas) return;

      // renderedScale: the PDF.js scale at which this canvas was last rendered.
      const renderedScale = parseFloat(wrapper.dataset.renderedScale);
      if (!renderedScale) return; // page not rendered yet — skip

      // renderedCssW/H: the exact CSS size the canvas was rendered at.
      // These are stamped by _renderPage immediately after each render, so
      // they always reflect the true last-rendered dimensions regardless of
      // any intermediate CSS-scaling that happened during prior gestures.
      const renderedW = parseFloat(canvas.dataset.renderedCssW);
      const renderedH = parseFloat(canvas.dataset.renderedCssH);
      if (!renderedW || !renderedH) return;

      const ratio = _scale / renderedScale;
      const newW  = renderedW * ratio;
      const newH  = renderedH * ratio;

      wrapper.style.width  = newW + 'px';
      wrapper.style.height = newH + 'px';
      wrapper.style.setProperty('--scale-factor', _scale);

      canvas.style.width  = newW + 'px';
      canvas.style.height = newH + 'px';

      const annCanvas = wrapper.querySelector('.annotation-canvas');
      if (annCanvas) {
        annCanvas.style.width  = newW + 'px';
        annCanvas.style.height = newH + 'px';
      }
    });
  }

  /**
   * Central zoom entry point.
   *
   * @param {number} newScale     Target scale (will be clamped to 0.1..5.0)
   * @param {number} [viewerAX]   Viewer-relative X of the point to keep fixed
   * @param {number} [viewerAY]   Viewer-relative Y of the point to keep fixed
   */
  function _performZoom(newScale, viewerAX, viewerAY) {
    if (!_pdfDoc) return;

    newScale = Math.max(0.1, Math.min(5.0, newScale));
    if (Math.abs(newScale - _scale) < 1e-6) return;

    const viewer = _viewer();

    // Default anchor: centre of the viewport
    const ax = (viewerAX !== undefined) ? viewerAX : viewer.clientWidth  / 2;
    const ay = (viewerAY !== undefined) ? viewerAY : viewer.clientHeight / 2;

    // Capture anchor in page-space BEFORE changing any sizes.
    const anchor = _toPageSpace(ax, ay);
    if (!anchor) return; // no pages rendered yet

    anchor.viewerAX = ax;
    anchor.viewerAY = ay;
    _zoomAnchor = anchor;

    // Change the scale.
    _scale = newScale;

    // Instantly CSS-scale all wrappers so there's no blank flash.
    _cssScaleWrappers();

    // Immediately restore scroll using the anchor formula on the scaled layout.
    // Because _cssScaleWrappers updated offsetWidth/Height synchronously (the
    // browser does a partial layout after style changes in the same frame), we
    // can compute the correct scrollTop right now.
    _suppressScrollDetect++;
    const st = _scrollTopFromAnchor(anchor);
    const sl = _scrollLeftFromAnchor(anchor);
    if (st !== null) viewer.scrollTop  = Math.max(0, st);
    if (sl !== null) viewer.scrollLeft = Math.max(0, sl);
    // Release suppress after the scroll event that our assignment fires.
    requestAnimationFrame(() => { _suppressScrollDetect = Math.max(0, _suppressScrollDetect - 1); });

    // Update zoom label immediately.
    const zoomLabel = document.getElementById('zoom-label');
    if (zoomLabel) zoomLabel.textContent = Math.round(_scale * 100) + '%';

    // Debounce the expensive PDF.js re-render.
    if (_zoomDebounceTimer) clearTimeout(_zoomDebounceTimer);
    _zoomDebounceTimer = setTimeout(_commitZoom, 200);
  }

  /**
   * Full re-render at the current _scale, then restore scroll precisely.
   */
  async function _commitZoom() {
    _zoomDebounceTimer = null;
    if (!_pdfDoc) return;

    // Take a generation token so a newer zoom can abort this commit.
    const myGen = ++_zoomCommitGen;

    // Freeze page-detection for the whole commit.
    _suppressScrollDetect++;

    const viewer  = _viewer();
    const anchor  = _zoomAnchor; // may be null for setZoom calls

    // If we have an anchor, capture the current expected scrollTop so that
    // even if layout shifts during async rendering we can correct afterwards.
    // We also save the scroll position right now as a fallback.
    const savedScrollTop  = viewer.scrollTop;
    const savedScrollLeft = viewer.scrollLeft;

    try {
      // Wait for any background load renders (initial load) to finish.
      while (_pendingRenders > 0) {
        await new Promise(r => setTimeout(r, 5));
      }
      if (myGen !== _zoomCommitGen || !_pdfDoc) return;

      // Re-render every page at crisp resolution.
      // _renderPage handles the no-flash swap internally.
      const total = _pdfDoc.numPages;
      const renders = [];
      for (let i = 1; i <= total; i++) renders.push(_renderPage(i));
      await Promise.all(renders);

      if (myGen !== _zoomCommitGen || !_pdfDoc) return;

      // After all wrappers have their final offsetTop/Height, restore scroll.
      if (anchor) {
        const st = _scrollTopFromAnchor(anchor);
        const sl = _scrollLeftFromAnchor(anchor);
        if (st !== null) viewer.scrollTop  = Math.max(0, st);
        if (sl !== null) viewer.scrollLeft = Math.max(0, sl);
      } else {
        // No anchor (e.g., initial load zoom restore) — keep saved position.
        viewer.scrollTop  = savedScrollTop;
        viewer.scrollLeft = savedScrollLeft;
      }

      _zoomAnchor = null;

    } finally {
      // Always release the suppress guard.
      _suppressScrollDetect = Math.max(0, _suppressScrollDetect - 1);
      // Snap current page to whatever is now centred.
      _detectCurrentPage();
    }
  }

  // ── Public zoom API ───────────────────────────────────────────────────────

  /**
   * Set an exact zoom level (number, 'fit-width', or 'fit-page').
   * Anchors to the viewport centre (no cursor involved).
   */
  async function setZoom(zoom) {
    if (!_pdfDoc) return;

    let newScale;
    if (zoom === 'fit-width') {
      const viewer  = _viewer();
      const page    = await _pdfDoc.getPage(1);
      const baseVp  = page.getViewport({ scale: 1 });
      const padding = 48;
      newScale = (viewer.clientWidth - padding) / baseVp.width;
    } else if (zoom === 'fit-page') {
      const viewer  = _viewer();
      const page    = await _pdfDoc.getPage(1);
      const baseVp  = page.getViewport({ scale: 1 });
      const padding = 48;
      const scaleX  = (viewer.clientWidth  - padding) / baseVp.width;
      const scaleY  = (viewer.clientHeight - padding) / baseVp.height;
      newScale      = Math.min(scaleX, scaleY);
    } else {
      newScale = parseFloat(zoom);
    }

    newScale = Math.max(0.1, Math.min(5.0, newScale));
    if (Math.abs(newScale - _scale) < 1e-6) return;

    // Capture viewport-centre anchor before changing scale.
    const viewer = _viewer();
    const ax = viewer.clientWidth  / 2;
    const ay = viewer.clientHeight / 2;
    const anchor = _toPageSpace(ax, ay);
    if (anchor) {
      anchor.viewerAX = ax;
      anchor.viewerAY = ay;
      _zoomAnchor = anchor;
    }

    _scale = newScale;

    // Update zoom label.
    const zoomLabel = document.getElementById('zoom-label');
    if (zoomLabel) zoomLabel.textContent = Math.round(_scale * 100) + '%';

    // Cancel any pending debounced commit and commit immediately (crisp render).
    if (_zoomDebounceTimer) { clearTimeout(_zoomDebounceTimer); _zoomDebounceTimer = null; }
    await _commitZoom();
  }

  /** Step zoom in to next preset level (buttons / keyboard). */
  function zoomIn() {
    const steps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
    const next  = steps.find(s => s > _scale + 0.01);
    setZoom(next || 5);
  }

  /** Step zoom out to previous preset level (buttons / keyboard). */
  function zoomOut() {
    const steps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
    const prev  = [...steps].reverse().find(s => s < _scale - 0.01);
    setZoom(prev || 0.25);
  }

  /**
   * Continuous zoom driven by Ctrl+wheel or trackpad pinch.
   * @param {number} delta    Raw deltaY (positive = scroll down = zoom out)
   * @param {number} viewerAX Viewer-relative X of the pointer
   * @param {number} viewerAY Viewer-relative Y of the pointer
   */
  function zoomByDelta(delta, viewerAX, viewerAY) {
    // Logarithmic factor: 0.999^delta makes the zoom feel linear perceptually.
    const factor = Math.pow(0.999, delta);
    _performZoom(_scale * factor, viewerAX, viewerAY);
  }

  // ── Bookmarks ─────────────────────────────────────────────────────────────
  async function _renderBookmarks() {
    const container = document.getElementById('bookmarks-container');
    if (!container || !_pdfDoc) return;
    try {
      const outline = await _pdfDoc.getOutline();
      if (!outline || outline.length === 0) {
        container.innerHTML = '<p class="panel-empty-hint">No bookmarks in this document.</p>';
        return;
      }
      container.innerHTML = '';
      for (const item of outline) {
        const bEl = document.createElement('div');
        bEl.className = 'bookmark-item';
        bEl.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
          <span>${item.title}</span>
        `;
        bEl.addEventListener('click', async () => {
          try {
            let dest = item.dest;
            if (typeof dest === 'string') {
              dest = await _pdfDoc.getDestination(dest);
            }
            if (dest && Array.isArray(dest)) {
              const pageIndex = await _pdfDoc.getPageIndex(dest[0]);
              goToPage(pageIndex + 1);
            }
          } catch (err) {
            console.warn('Could not jump to bookmark destination:', err);
          }
        });
        container.appendChild(bEl);
      }
    } catch (e) {
      container.innerHTML = '<p class="panel-empty-hint">No bookmarks in this document.</p>';
    }
  }

  // ── Navigation ────────────────────────────────────────────────────────────
  function goToPage(pageNum) {
    if (!_pdfDoc) return;
    const total   = _pdfDoc.numPages;
    const clamped = Math.min(Math.max(pageNum, 1), total);

    const wrapper = _pageWrappers[clamped - 1];
    if (wrapper) {
      wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    _updateCurrentPage(clamped);
  }

  function nextPage() { goToPage(_currentPage + 1); }
  function prevPage() { goToPage(_currentPage - 1); }

  function _updateCurrentPage(pageNum) {
    _currentPage = pageNum;

    // Update topbar input
    const input = document.getElementById('page-num-input');
    if (input) input.value = pageNum;

    // Update thumbnail highlight
    document.querySelectorAll('.thumbnail').forEach(el => {
      el.classList.toggle('active', parseInt(el.dataset.page) === pageNum);
    });

    // Fire callback
    if (_onPageChange) _onPageChange(pageNum, _pdfDoc ? _pdfDoc.numPages : 0);
  }

  // Listen to scroll position to auto-update current page indicator
  function _setupScrollListener() {
    const viewer = _viewer();
    if (!viewer) return;

    let scrollTimer = null;
    viewer.addEventListener('scroll', () => {
      if (_suppressScrollDetect > 0) return; // zoom is in progress – skip
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        _detectCurrentPage();
      }, 100);
    });
  }

  function _detectCurrentPage() {
    if (!_pdfDoc) return;
    const viewer     = _viewer();
    const viewerTop  = viewer.scrollTop;
    const viewerMid  = viewerTop + viewer.clientHeight / 2;

    let closestPage  = 1;
    let closestDist  = Infinity;

    Object.entries(_pageWrappers).forEach(([idx, wrapper]) => {
      const pageTop    = wrapper.offsetTop;
      const pageCenter = pageTop + wrapper.offsetHeight / 2;
      const dist       = Math.abs(pageCenter - viewerMid);
      if (dist < closestDist) {
        closestDist = dist;
        closestPage = parseInt(idx) + 1;
      }
    });

    if (closestPage !== _currentPage) {
      _updateCurrentPage(closestPage);
    }
  }

  // ── Accessors ─────────────────────────────────────────────────────────────
  function getPdfDoc()      { return _pdfDoc; }
  function getPdfBytes()    { return _pdfBytes; }
  function getScale()       { return _scale; }
  function getFileName()    { return _fileName; }
  function getCurrentPage() { return _currentPage; }
  function getTotalPages()  { return _pdfDoc ? _pdfDoc.numPages : 0; }
  function getPageWrapper(idx) { return _pageWrappers[idx] || null; }

  /** Update the raw bytes (after save/merge/split) without full reload */
  async function updateBytes(bytes, jumpToPage) {
    const curPage = jumpToPage || _currentPage;
    await loadDocument(bytes, _fileName, curPage);
  }

  function setPageChangeCallback(cb) { _onPageChange = cb; }

  // ── Init scroll listener when module loads ────────────────────────────────
  document.addEventListener('DOMContentLoaded', _setupScrollListener);

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    loadDocument, updateBytes,
    setZoom, zoomIn, zoomOut, zoomByDelta,
    goToPage, nextPage, prevPage,
    getPdfDoc, getPdfBytes, getScale, getFileName,
    getCurrentPage, getTotalPages, getPageWrapper,
    setPageChangeCallback,
  };
})();
