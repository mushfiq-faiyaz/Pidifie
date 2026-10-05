/* =============================================================================
   PDFy – App Controller
   The main application coordinator. Wires together all modules:
     PdfViewer, Annotations, Signature, PageTools, Search, Storage.
   Also manages:
     - File open (button + drag & drop)
     - Theme toggle
     - Toolbar event handlers
     - Keyboard shortcuts
     - PWA service worker registration
     - Toast notifications
   ============================================================================= */

const App = (() => {
  // ── State ─────────────────────────────────────────────────────────────────
  let _theme        = 'dark';
  let _sidebarOpen  = true;
  let _searchOpen   = false;

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const el = id => document.getElementById(id);

  // ── Boot ──────────────────────────────────────────────────────────────────
  async function init() {
    // Register PWA service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(err =>
        console.warn('SW registration failed:', err)
      );
    }

    // Restore theme preference
    _theme = await Storage.getPref('theme', 'dark');
    _applyTheme(_theme);

    // Restore sidebar preference
    _sidebarOpen = (await Storage.getPref('sidebar', 'open')) === 'open';
    _setSidebar(_sidebarOpen);

    // Init signature module
    Signature.init();

    // Load recent files on welcome screen
    await _loadRecentFiles();

    // Wire up all event listeners
    _bindFileOpen();
    _bindDragDrop();
    _bindToolbar();
    _bindAnnotationToolbar();
    _bindModals();
    _bindKeyboard();
    _bindColorPicker();
    _bindSearchBar();
    _bindPageTools();
    _bindAnnotationEvents();
  }

  // ── File open ─────────────────────────────────────────────────────────────
  function _bindFileOpen() {
    // Button in toolbar
    el('btn-open').addEventListener('click', () => el('file-input').click());
    el('btn-open-welcome').addEventListener('click', () => el('file-input').click());

    // File input change
    el('file-input').addEventListener('change', e => {
      if (e.target.files.length > 0) _openFile(e.target.files[0]);
      e.target.value = ''; // reset so same file can be reopened
    });

    // Close file button
    el('btn-close-file').addEventListener('click', _closeFile);
  }

  async function _openFile(file) {
    if (!file || file.type !== 'application/pdf') {
      showToast('Please open a valid PDF file', 'error');
      return;
    }

    try {
      showToast('Opening ' + file.name + '…');

      const bytes = new Uint8Array(await file.arrayBuffer());

      // Check if we have a saved page position for this file
      const recent = await Storage.getRecentFiles();
      const prev   = recent.find(r => r.name === file.name);
      const startPage = prev ? prev.lastPage : 1;

      // Show app shell, hide welcome
      el('welcome-screen').style.display = 'none';
      el('app').style.display            = 'flex';

      // Load PDF
      await PdfViewer.loadDocument(bytes, file.name, startPage);

      // Restore annotations
      const savedAnnotations = await Storage.loadAnnotations(file.name);
      if (savedAnnotations) {
        Annotations.deserialize(savedAnnotations);
      }

      // Restore zoom
      const savedZoom = await Storage.getPref('zoom-' + file.name, 1);
      await PdfViewer.setZoom(savedZoom);

      // Update page change tracking
      PdfViewer.setPageChangeCallback((pageNum, total) => {
        _onPageChange(pageNum, total, file.name);
      });

      // Update window title
      document.title = file.name + ' – PDFy';

      // Record in recent files
      await Storage.touchRecentFile(file.name, startPage, PdfViewer.getTotalPages());

      if (prev) {
        showToast(`Resumed at page ${startPage}`, 'success');
      } else {
        showToast('Opened successfully', 'success');
      }
    } catch (err) {
      console.error('Failed to open PDF:', err);
      showToast('Failed to open PDF: ' + (err.message || 'Unknown error'), 'error');
    }
  }

  function _closeFile() {
    el('app').style.display            = 'none';
    el('welcome-screen').style.display = 'flex';
    document.title = 'PDFy – PDF Reader & Editor';
    _loadRecentFiles();
  }

  // ── Page change callback ───────────────────────────────────────────────────
  let _saveTimer = null;
  function _onPageChange(pageNum, total, fileName) {
    // Update toolbar page input
    const input = el('page-num-input');
    if (input) input.value = pageNum;

    // Debounce: save progress every 2 seconds
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(async () => {
      await Storage.touchRecentFile(fileName, pageNum, total);
      await Storage.saveAnnotations(fileName, Annotations.serialize());
    }, 2000);
  }

  // ── Drag & drop ───────────────────────────────────────────────────────────
  function _bindDragDrop() {
    const overlay = el('drop-overlay');
    let dragCounter = 0;

    document.addEventListener('dragenter', e => {
      if ([...e.dataTransfer.types].includes('Files')) {
        dragCounter++;
        overlay.classList.add('active');
        e.preventDefault();
      }
    });

    document.addEventListener('dragleave', () => {
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) overlay.classList.remove('active');
    });

    document.addEventListener('dragover', e => e.preventDefault());

    document.addEventListener('drop', e => {
      e.preventDefault();
      dragCounter = 0;
      overlay.classList.remove('active');
      const file = e.dataTransfer.files[0];
      if (file) _openFile(file);
    });
  }

  // ── Top toolbar ───────────────────────────────────────────────────────────
  function _bindToolbar() {
    // Navigation
    el('btn-prev').addEventListener('click', () => PdfViewer.prevPage());
    el('btn-next').addEventListener('click', () => PdfViewer.nextPage());

    el('page-num-input').addEventListener('change', e => {
      PdfViewer.goToPage(parseInt(e.target.value));
    });
    el('page-num-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') PdfViewer.goToPage(parseInt(e.target.value));
    });

    // Zoom
    el('btn-zoom-in').addEventListener('click',  () => PdfViewer.zoomIn());
    el('btn-zoom-out').addEventListener('click', () => PdfViewer.zoomOut());

    // Zoom dropdown
    _bindDropdown('btn-zoom-level', 'zoom-menu');
    el('zoom-menu').querySelectorAll('[data-zoom]').forEach(item => {
      item.addEventListener('click', () => {
        PdfViewer.setZoom(item.dataset.zoom);
        _closeDropdown('zoom-menu');
      });
    });

    // Save
    el('btn-save').addEventListener('click', _savePdf);

    // Print
    el('btn-print').addEventListener('click', () => window.print());

    // Sidebar toggle
    el('btn-sidebar').addEventListener('click', () => {
      _sidebarOpen = !_sidebarOpen;
      _setSidebar(_sidebarOpen);
      Storage.setPref('sidebar', _sidebarOpen ? 'open' : 'closed');
    });

    // Theme toggle
    el('btn-theme').addEventListener('click', () => {
      _theme = _theme === 'dark' ? 'light' : 'dark';
      _applyTheme(_theme);
      Storage.setPref('theme', _theme);
    });
  }

  // ── Annotation toolbar ────────────────────────────────────────────────────
  function _bindAnnotationToolbar() {
    // Tool buttons
    const toolBtns = document.querySelectorAll('.ann-btn[data-tool]');
    toolBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = btn.dataset.tool;

        if (tool === 'sign') {
          // Check if we have a saved signature; if so give choice
          _handleSignatureTool();
          return;
        }

        // If there is live text selected AND the tool is a text-markup type,
        // apply it directly via TextSelection (text-aware, line-accurate).
        const textMarkupTools = ['highlight', 'underline', 'strikethrough'];
        if (textMarkupTools.includes(tool) && typeof TextSelection !== 'undefined') {
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed && sel.toString().trim()) {
            // Inject pageIndex by finding which wrapper the selection is in
            const anchor = sel.anchorNode;
            const wrappers = document.querySelectorAll('.page-wrapper');
            for (const w of wrappers) {
              if (w.contains(anchor)) {
                const pi = parseInt(w.dataset.pageIndex);
                if (!isNaN(pi)) {
                  // Temporarily set the toolbar's data-page-index so applyMarkup knows
                  const tbEl = document.querySelector('.text-sel-toolbar');
                  if (tbEl) tbEl.dataset.pageIndex = pi;
                }
                break;
              }
            }
            // Dispatch a synthetic toolbar click
            const tbBtn = document.querySelector(`.text-sel-toolbar [data-action="${tool}"]`);
            if (tbBtn) { tbBtn.click(); return; }
          }
        }

        _setActiveTool(tool);
        Annotations.setTool(tool);
      });
    });

    // Undo / Redo
    el('btn-undo').addEventListener('click', () => {
      Annotations.undo(PdfViewer.getCurrentPage() - 1);
      if (typeof TextSelection !== 'undefined') TextSelection.undo(PdfViewer.getCurrentPage() - 1);
    });
    el('btn-redo').addEventListener('click', () => {
      Annotations.redo(PdfViewer.getCurrentPage() - 1);
      if (typeof TextSelection !== 'undefined') TextSelection.redo(PdfViewer.getCurrentPage() - 1);
    });

    // Delete selection
    el('btn-delete-selection').addEventListener('click', () => {
      Annotations.deleteSelected(PdfViewer.getCurrentPage() - 1);
    });

    // Pen size slider
    el('pen-size').addEventListener('input', e => {
      const size = parseInt(e.target.value);
      el('pen-size-label').textContent = size + 'px';
      Annotations.setPenSize(size);
    });

    // Font size select
    el('font-size').addEventListener('change', e => {
      Annotations.setFontSize(parseInt(e.target.value));
    });

    // Selection callback → show/hide delete button
    Annotations.setSelectionCallback(hasSelection => {
      el('btn-delete-selection').style.display = hasSelection ? 'flex' : 'none';
    });
  }

  function _setActiveTool(tool) {
    document.querySelectorAll('.ann-btn[data-tool]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    });

    // Show/hide contextual options
    el('pen-options').style.display  = tool === 'pen'  ? 'flex' : 'none';
    el('font-options').style.display = tool === 'text' ? 'flex' : 'none';
  }

  // Listen for tool changes dispatched by other modules (e.g. after placing signature)
  function _bindAnnotationEvents() {
    document.addEventListener('pdfy:tool-changed', e => {
      _setActiveTool(e.detail);
    });
    document.addEventListener('pdfy:request-note', () => {
      _openNoteModal();
    });
    document.addEventListener('pdfy:request-signature', () => {
      Signature.openModal();
    });
  }

  // ── Signature tool ────────────────────────────────────────────────────────
  async function _handleSignatureTool() {
    _setActiveTool('sign');
    Annotations.setTool('sign');

    const saved = await Storage.loadSignature();
    if (saved) {
      // Ask user: place saved or draw new
      // For simplicity: if they click Sign tool with existing sig, use saved one
      // They can clear from modal later
      showToast('Click on the page to place your signature');
    } else {
      Signature.openModal();
    }
  }

  // ── Color picker ──────────────────────────────────────────────────────────
  function _bindColorPicker() {
    document.querySelectorAll('.color-swatch').forEach(swatch => {
      swatch.addEventListener('click', () => {
        document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
        Annotations.setColor(swatch.dataset.color);
        if (typeof TextSelection !== 'undefined') TextSelection.setColor(swatch.dataset.color);
      });
    });

    el('custom-color').addEventListener('input', e => {
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      Annotations.setColor(e.target.value);
      if (typeof TextSelection !== 'undefined') TextSelection.setColor(e.target.value);
    });
  }

  // ── Search bar ────────────────────────────────────────────────────────────
  function _bindSearchBar() {
    el('btn-search-open').addEventListener('click', _openSearch);
    el('btn-search-close').addEventListener('click', _closeSearch);

    let searchDebounce = null;
    el('search-input').addEventListener('input', e => {
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(async () => {
        const { total, current } = await Search.search(e.target.value);
        _updateSearchCount(current, total);
      }, 300);
    });

    el('search-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const { total, current } = Search.next();
        _updateSearchCount(current, total);
      } else if (e.key === 'Escape') {
        _closeSearch();
      }
    });

    el('btn-search-prev').addEventListener('click', () => {
      const { total, current } = Search.prev();
      _updateSearchCount(current, total);
    });

    el('btn-search-next').addEventListener('click', () => {
      const { total, current } = Search.next();
      _updateSearchCount(current, total);
    });
  }

  function _openSearch() {
    _searchOpen = true;
    el('search-bar').classList.add('open');
    el('btn-search-open').style.display = 'none';
    el('search-input').focus();
  }

  function _closeSearch() {
    _searchOpen = false;
    el('search-bar').classList.remove('open');
    el('btn-search-open').style.display = '';
    el('search-input').value = '';
    Search.clear();
    _updateSearchCount(0, 0);
  }

  function _updateSearchCount(current, total) {
    const countEl = el('search-count');
    if (!countEl) return;
    countEl.textContent = total > 0 ? `${current}/${total}` : (el('search-input').value ? 'Not found' : '');
  }

  // ── Page tools ────────────────────────────────────────────────────────────
  function _bindPageTools() {
    _bindDropdown('btn-page-tools', 'page-tools-menu');

    el('btn-rotate-cw').addEventListener('click',  () => _rotatePage('cw'));
    el('btn-rotate-ccw').addEventListener('click', () => _rotatePage('ccw'));
    el('btn-delete-page').addEventListener('click', _deletePage);
    el('btn-merge-pdf').addEventListener('click',  () => el('merge-input').click());
    el('btn-split-pdf').addEventListener('click',  _openSplitModal);

    el('merge-input').addEventListener('change', async e => {
      const files = [...e.target.files];
      if (!files.length) return;
      e.target.value = '';
      await _mergePdfs(files);
    });
  }

  async function _rotatePage(direction) {
    _closeDropdown('page-tools-menu');
    const bytes    = PdfViewer.getPdfBytes();
    const pageIdx  = PdfViewer.getCurrentPage() - 1;
    if (!bytes) return;
    try {
      showToast('Rotating page…');
      const newBytes = await PageTools.rotatePage(bytes, pageIdx, direction);
      await PdfViewer.updateBytes(newBytes, PdfViewer.getCurrentPage());
      showToast('Page rotated', 'success');
    } catch (e) {
      showToast('Error: ' + e.message, 'error');
    }
  }

  async function _deletePage() {
    _closeDropdown('page-tools-menu');
    const bytes   = PdfViewer.getPdfBytes();
    const pageIdx = PdfViewer.getCurrentPage() - 1;
    const total   = PdfViewer.getTotalPages();
    if (!bytes) return;
    if (!confirm(`Delete page ${pageIdx + 1} of ${total}? This cannot be undone.`)) return;
    try {
      const newBytes = await PageTools.deletePage(bytes, pageIdx);
      const newPage  = Math.min(pageIdx + 1, total - 1);
      await PdfViewer.updateBytes(newBytes, newPage);
      showToast('Page deleted', 'success');
    } catch (e) {
      showToast('Error: ' + e.message, 'error');
    }
  }

  async function _mergePdfs(files) {
    try {
      showToast('Merging PDFs…');
      const currentBytes = PdfViewer.getPdfBytes();
      const byteArrays   = [currentBytes];

      for (const file of files) {
        byteArrays.push(new Uint8Array(await file.arrayBuffer()));
      }

      const merged = await PageTools.mergePdfs(byteArrays);
      await PdfViewer.updateBytes(merged, 1);
      showToast('PDFs merged successfully', 'success');
    } catch (e) {
      showToast('Merge failed: ' + e.message, 'error');
    }
  }

  function _openSplitModal() {
    _closeDropdown('page-tools-menu');
    const modal = el('modal-split');
    el('split-range').value = '';
    modal.style.display = 'flex';
    el('split-range').focus();
  }

  async function _extractPages() {
    const rangeStr = el('split-range').value.trim();
    if (!rangeStr) { showToast('Please enter page numbers', 'error'); return; }

    const bytes   = PdfViewer.getPdfBytes();
    const total   = PdfViewer.getTotalPages();
    const indices = PageTools.parsePageRange(rangeStr, total);

    if (!indices.length) {
      showToast('No valid pages in that range', 'error');
      return;
    }

    try {
      showToast('Extracting pages…');
      const extracted  = await PageTools.extractPages(bytes, indices);
      const baseName   = PdfViewer.getFileName().replace(/\.pdf$/i, '');
      PageTools.downloadPdf(extracted, `${baseName}_pages_${rangeStr.replace(/\s/g,'')}.pdf`);
      el('modal-split').style.display = 'none';
      showToast('Pages extracted and downloaded', 'success');
    } catch (e) {
      showToast('Error: ' + e.message, 'error');
    }
  }

  /** Called by PdfViewer when user drags thumbnails to reorder */
  async function reorderPages(newOrder) {
    const bytes = PdfViewer.getPdfBytes();
    if (!bytes) return;
    try {
      showToast('Reordering pages…');
      const newBytes = await PageTools.reorderPages(bytes, newOrder);
      await PdfViewer.updateBytes(newBytes, 1);
      showToast('Pages reordered', 'success');
    } catch (e) {
      showToast('Error: ' + e.message, 'error');
    }
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function _savePdf() {
    const bytes    = PdfViewer.getPdfBytes();
    const fileName = PdfViewer.getFileName();
    if (!bytes || !fileName) return;

    try {
      showToast('Saving…');

      // Bake annotations into PDF
      const annotationImages = Annotations.getAnnotationImages();
      let finalBytes = bytes;

      if (Object.keys(annotationImages).length > 0) {
        finalBytes = await PageTools.bakeAnnotations(bytes, annotationImages);
      }

      // Also persist annotation state to IndexedDB
      await Storage.saveAnnotations(fileName, Annotations.serialize());
      await Storage.touchRecentFile(fileName, PdfViewer.getCurrentPage(), PdfViewer.getTotalPages());

      // Download
      PageTools.downloadPdf(finalBytes, fileName);
      showToast('Saved – check your downloads', 'success');
    } catch (e) {
      console.error('Save error:', e);
      showToast('Save failed: ' + e.message, 'error');
    }
  }

  // ── Modals ────────────────────────────────────────────────────────────────
  function _bindModals() {
    // Signature modal
    el('sig-modal-close').addEventListener('click', Signature.closeModal);
    el('sig-clear').addEventListener('click', Signature.clear);
    el('sig-place').addEventListener('click', Signature.place);

    // Note modal
    el('note-modal-close').addEventListener('click', () => el('modal-note').style.display = 'none');
    el('note-cancel').addEventListener('click',      () => el('modal-note').style.display = 'none');
    el('note-ok').addEventListener('click', () => {
      const text = el('note-text').value.trim();
      if (!text) return;
      el('modal-note').style.display = 'none';
      Annotations.placeNote(text);
    });

    // Split modal
    el('split-modal-close').addEventListener('click', () => el('modal-split').style.display = 'none');
    el('split-cancel').addEventListener('click',      () => el('modal-split').style.display = 'none');
    el('split-ok').addEventListener('click', _extractPages);

    // Close modals on backdrop click
    document.querySelectorAll('.modal').forEach(modal => {
      modal.querySelector('.modal__backdrop').addEventListener('click', () => {
        modal.style.display = 'none';
      });
    });
  }

  function _openNoteModal() {
    const modal = el('modal-note');
    el('note-text').value = '';
    modal.style.display = 'flex';
    el('note-text').focus();
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  function _bindKeyboard() {
    document.addEventListener('keydown', e => {
      const ctrl    = e.ctrlKey || e.metaKey;
      const inInput = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName);

      // Don't hijack typing in text fields
      if (inInput && !ctrl) return;

      switch (true) {
        case ctrl && e.key === 'o': e.preventDefault(); el('file-input').click(); break;
        case ctrl && e.key === 's': e.preventDefault(); _savePdf(); break;
        case ctrl && e.key === 'p': e.preventDefault(); window.print(); break;
        case ctrl && e.key === 'f': e.preventDefault(); _openSearch(); break;
        case ctrl && e.key === 'z':
          e.preventDefault();
          Annotations.undo(PdfViewer.getCurrentPage() - 1);
          if (typeof TextSelection !== 'undefined') TextSelection.undo(PdfViewer.getCurrentPage() - 1);
          break;
        case ctrl && e.shiftKey && e.key.toLowerCase() === 'z':
          e.preventDefault();
          Annotations.redo(PdfViewer.getCurrentPage() - 1);
          if (typeof TextSelection !== 'undefined') TextSelection.redo(PdfViewer.getCurrentPage() - 1);
          break;
        case ctrl && e.key === 'y':
          e.preventDefault();
          Annotations.redo(PdfViewer.getCurrentPage() - 1);
          if (typeof TextSelection !== 'undefined') TextSelection.redo(PdfViewer.getCurrentPage() - 1);
          break;
        case ctrl && e.key === '=':
        case ctrl && e.key === '+': e.preventDefault(); PdfViewer.zoomIn(); break;
        case ctrl && e.key === '-': e.preventDefault(); PdfViewer.zoomOut(); break;
        case ctrl && e.key === '0': e.preventDefault(); PdfViewer.setZoom(1); break;
        case !ctrl && e.key === 'ArrowRight':
        case !ctrl && e.key === 'ArrowDown': PdfViewer.nextPage(); break;
        case !ctrl && e.key === 'ArrowLeft':
        case !ctrl && e.key === 'ArrowUp': PdfViewer.prevPage(); break;
        case !ctrl && e.key === 'Home': PdfViewer.goToPage(1); break;
        case !ctrl && e.key === 'End': PdfViewer.goToPage(PdfViewer.getTotalPages()); break;
        case !ctrl && e.key.toLowerCase() === 'v': _setActiveTool('select'); Annotations.setTool('select'); break;
        case !ctrl && e.key.toLowerCase() === 'h': _setActiveTool('highlight'); Annotations.setTool('highlight'); break;
        case !ctrl && e.key.toLowerCase() === 'u': _setActiveTool('underline'); Annotations.setTool('underline'); break;
        case !ctrl && e.key.toLowerCase() === 's': _setActiveTool('strikethrough'); Annotations.setTool('strikethrough'); break;
        case !ctrl && e.key.toLowerCase() === 'p': _setActiveTool('pen'); Annotations.setTool('pen'); break;
        case !ctrl && e.key.toLowerCase() === 't': _setActiveTool('text'); Annotations.setTool('text'); break;
        case !ctrl && e.key.toLowerCase() === 'n': _setActiveTool('note'); Annotations.setTool('note'); break;
        case !ctrl && e.key.toLowerCase() === 'g': _handleSignatureTool(); break;
        case !ctrl && e.key === 'Delete':
        case !ctrl && e.key === 'Backspace':
          if (!inInput) Annotations.deleteSelected(PdfViewer.getCurrentPage() - 1);
          break;
        case !ctrl && e.key === 'Escape': _closeSearch(); break;
      }
    });

    // Mouse wheel zoom (Ctrl + scroll)
    document.getElementById('viewer').addEventListener('wheel', e => {
      if (e.ctrlKey) {
        e.preventDefault();
        if (e.deltaY < 0) PdfViewer.zoomIn();
        else              PdfViewer.zoomOut();
      }
    }, { passive: false });
  }

  // ── Dropdown helpers ──────────────────────────────────────────────────────
  function _bindDropdown(btnId, menuId) {
    const btn  = el(btnId);
    const menu = el(menuId);
    if (!btn || !menu) return;

    btn.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = menu.classList.contains('open');
      // Close all open dropdowns
      document.querySelectorAll('.tb-dropdown__menu.open').forEach(m => m.classList.remove('open'));
      if (!isOpen) menu.classList.add('open');
    });
  }

  function _closeDropdown(menuId) {
    const menu = el(menuId);
    if (menu) menu.classList.remove('open');
  }

  // Close all dropdowns when clicking outside
  document.addEventListener('click', () => {
    document.querySelectorAll('.tb-dropdown__menu.open').forEach(m => m.classList.remove('open'));
  });

  // ── Theme ─────────────────────────────────────────────────────────────────
  function _applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    el('icon-moon').style.display = theme === 'dark'  ? '' : 'none';
    el('icon-sun').style.display  = theme === 'light' ? '' : 'none';
    el('btn-theme').title         = theme === 'dark'
      ? 'Switch to light mode'
      : 'Switch to dark mode';
  }

  // ── Sidebar ───────────────────────────────────────────────────────────────
  function _setSidebar(open) {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.toggle('collapsed', !open);
    const btn = el('btn-sidebar');
    if (btn) btn.setAttribute('aria-pressed', open ? 'true' : 'false');
  }

  // ── Recent files ──────────────────────────────────────────────────────────
  async function _loadRecentFiles() {
    const recent  = await Storage.getRecentFiles();
    const section = el('recent-files-section');
    const list    = el('recent-files-list');
    if (!section || !list) return;

    if (recent.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    list.innerHTML = '';

    recent.forEach(file => {
      const li   = document.createElement('li');
      li.className = 'recent-files__item';
      const date = new Date(file.openedAt).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric'
      });
      li.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <span class="recent-files__name" title="${file.name}">${file.name}</span>
        <span class="recent-files__date">${date}</span>
        <span class="recent-files__page">p.${file.lastPage}</span>
      `;
      // Clicking a recent file entry opens the file picker
      // (we can't re-open the file directly without the File API)
      li.title = 'Click Open PDF to open this file and resume at page ' + file.lastPage;
      li.addEventListener('click', () => {
        el('file-input').click();
        showToast(`Open "${file.name}" to resume at page ${file.lastPage}`);
      });
      list.appendChild(li);
    });
  }

  // ── Toast ─────────────────────────────────────────────────────────────────
  let _toastTimer = null;

  function showToast(message, type = '') {
    const toast = el('toast');
    if (!toast) return;
    toast.textContent  = message;
    toast.className    = 'toast show' + (type ? ' toast--' + type : '');

    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      toast.className = 'toast';
    }, 2800);
  }

  // ── DOMContentLoaded ──────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);

  // ── Public API ────────────────────────────────────────────────────────────
  return { showToast, reorderPages };
})();
