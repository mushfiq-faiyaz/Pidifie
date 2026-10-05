/* =============================================================================
   PDFy – PDF Viewer Module
   Renders a PDF document using PDF.js. Responsibilities:
     - Loading PDF bytes and rendering pages to <canvas> elements
     - Managing zoom (fit-width, fit-page, percentage)
     - Generating thumbnail previews in the sidebar
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

    // Update total pages display
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
    // capturedGen is optional (not provided when called from setZoom where we
    // always want to render the current document).
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

    // Set wrapper size in CSS (logical) pixels
    wrapper.style.width  = cssW + 'px';
    wrapper.style.height = cssH + 'px';

    // Remove existing pdf canvas if re-rendering (zoom etc.)
    const existingCanvas = wrapper.querySelector('.pdf-canvas');
    if (existingCanvas) existingCanvas.remove();

    // Create HiDPI canvas
    const canvas     = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.width     = Math.round(cssW * dpr);   // physical pixels
    canvas.height    = Math.round(cssH * dpr);
    canvas.style.width  = cssW + 'px';           // CSS display size
    canvas.style.height = cssH + 'px';

    // Insert before any existing annotation canvas.
    // IMPORTANT: querySelector can return a node that was detached from
    // wrapper between the call and insertBefore (e.g. if Fabric disposed the
    // canvas or a concurrent cleanup ran).  Always verify it is still a
    // direct child before using it.
    const annCanvas = wrapper.querySelector('.annotation-canvas');
    if (annCanvas && annCanvas.parentNode === wrapper) {
      wrapper.insertBefore(canvas, annCanvas);
    } else {
      wrapper.appendChild(canvas);
    }

    // Scale context for HiDPI before rendering
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Render at the logical scale – ctx.scale handles physical pixel density
    const renderTask = page.render({ canvasContext: ctx, viewport });
    _renderTasks[pageNum] = renderTask;

    try {
      await renderTask.promise;
    } catch (e) {
      if (e.name !== 'RenderingCancelledException') console.error('Render error:', e);
      return; // don't call initPage if the render was cancelled
    }

    // Bail out if a newer load started while we were awaiting the render.
    if (checkGen()) return;

    // Build/update annotation layer for this page
    Annotations.initPage(pageNum - 1, wrapper, cssW, cssH);

    // Build/update selectable text layer for this page
    if (typeof TextSelection !== 'undefined') {
      TextSelection.renderTextLayer(pageNum - 1, wrapper, viewport);
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
  /**
   * Set zoom and re-render all pages.
   * @param {number|'fit-width'|'fit-page'} zoom
   */
  async function setZoom(zoom) {
    if (!_pdfDoc) return;

    if (zoom === 'fit-width') {
      const viewer      = _viewer();
      const page        = await _pdfDoc.getPage(1);
      const baseVp      = page.getViewport({ scale: 1 });
      const padding     = 48; // viewer padding × 2
      _scale = (viewer.clientWidth - padding) / baseVp.width;
    } else if (zoom === 'fit-page') {
      const viewer  = _viewer();
      const page    = await _pdfDoc.getPage(1);
      const baseVp  = page.getViewport({ scale: 1 });
      const padding = 48;
      const scaleX  = (viewer.clientWidth  - padding) / baseVp.width;
      const scaleY  = (viewer.clientHeight - padding) / baseVp.height;
      _scale        = Math.min(scaleX, scaleY);
    } else {
      _scale = parseFloat(zoom);
    }

    _scale = Math.max(0.1, Math.min(_scale, 5.0));

    // Wait for any background renders still in flight from loadDocument to
    // finish before we kick off our own re-render pass.  Without this,
    // setZoom's _renderPage calls race with the background renders and can
    // trigger the insertBefore crash.
    while (_pendingRenders > 0) {
      await new Promise(r => setTimeout(r, 5));
    }

    if (!_pdfDoc) return; // guard: file may have been closed while draining

    // Re-render all pages at the new scale (no capturedGen — these are
    // intentional re-renders for the current document).
    const total = _pdfDoc.numPages;
    const rerenders = [];
    for (let i = 1; i <= total; i++) rerenders.push(_renderPage(i));
    await Promise.all(rerenders);

    // Update label
    const zoomLabel = document.getElementById('zoom-label');
    if (zoomLabel) zoomLabel.textContent = Math.round(_scale * 100) + '%';
  }

  function zoomIn() {
    const steps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
    const next  = steps.find(s => s > _scale + 0.01);
    setZoom(next || 5);
  }

  function zoomOut() {
    const steps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
    const prev  = [...steps].reverse().find(s => s < _scale - 0.01);
    setZoom(prev || 0.25);
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

    // Update input
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
    setZoom, zoomIn, zoomOut,
    goToPage, nextPage, prevPage,
    getPdfDoc, getPdfBytes, getScale, getFileName,
    getCurrentPage, getTotalPages, getPageWrapper,
    setPageChangeCallback,
  };
})();
