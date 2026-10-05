/* =============================================================================
   PidiFie – Search Module
   Text search within a rendered PDF using PDF.js text content.
   Highlights all matches; allows prev/next navigation.
   ============================================================================= */

const Search = (() => {
  let _pdfDoc         = null;
  let _query          = '';
  let _results        = [];   // [{ pageIndex, rects:[{x,y,w,h}] }]
  let _currentIndex   = -1;
  let _highlightEls   = [];
  let _onJumpToPage   = null;
  let _getPageScale   = null;
  let _getPageWrapper = null;

  // ── Init ──────────────────────────────────────────────────────────────────
  function init({ pdfDoc, onJumpToPage, getPageScale, getPageWrapper }) {
    _pdfDoc         = pdfDoc;
    _onJumpToPage   = onJumpToPage;
    _getPageScale   = getPageScale;
    _getPageWrapper = getPageWrapper;
    _results        = [];
    _currentIndex   = -1;
    clearHighlights();
  }

  // ── Search ────────────────────────────────────────────────────────────────
  async function search(query) {
    _query        = query.trim().toLowerCase();
    _results      = [];
    _currentIndex = -1;
    clearHighlights();

    if (!_pdfDoc || !_query) return { total: 0, current: 0 };

    const numPages    = _pdfDoc.numPages;
    const pagePromises = [];
    for (let i = 1; i <= numPages; i++) pagePromises.push(_searchPage(i));

    const allMatches = await Promise.all(pagePromises);
    allMatches.forEach(matches => matches.forEach(m => _results.push(m)));

    if (_results.length > 0) {
      _currentIndex = 0;
      _renderHighlights();
      _scrollToCurrentResult();
    }
    return { total: _results.length, current: _results.length > 0 ? 1 : 0 };
  }

  async function _searchPage(pageNum) {
    const page      = await _pdfDoc.getPage(pageNum);
    const content   = await page.getTextContent();
    const scale     = _getPageScale ? _getPageScale() : 1;
    const viewport  = page.getViewport({ scale });

    const matches   = [];
    const fullText  = content.items.map(i => i.str).join(' ');
    const lowerText = fullText.toLowerCase();

    let searchFrom = 0;
    let idx;
    while ((idx = lowerText.indexOf(_query, searchFrom)) !== -1) {
      const rects = _charsToRects(content.items, idx, _query.length, viewport);
      if (rects.length > 0) matches.push({ pageIndex: pageNum - 1, rects });
      searchFrom = idx + 1;
    }
    return matches;
  }

  function _charsToRects(items, charStart, charLen, viewport) {
    const rects = [];
    let pos = 0;
    for (const item of items) {
      const itemLen      = item.str.length;
      const itemEnd      = pos + itemLen;
      const overlapStart = Math.max(charStart, pos);
      const overlapEnd   = Math.min(charStart + charLen, itemEnd);

      if (overlapStart < overlapEnd && item.transform) {
        const tx = item.transform;
        const x  = tx[4], y = tx[5], h = Math.abs(tx[3]);
        const w  = item.width
          ? (item.width * (overlapEnd - overlapStart) / Math.max(itemLen, 1))
          : 50;

        const pt1 = viewport.convertToViewportPoint(x,     y);
        const pt2 = viewport.convertToViewportPoint(x + w, y - h);
        rects.push({
          x: Math.min(pt1[0], pt2[0]),
          y: Math.min(pt1[1], pt2[1]),
          w: Math.abs(pt2[0] - pt1[0]),
          h: Math.abs(pt2[1] - pt1[1]),
        });
      }
      pos = itemEnd + 1;
      if (pos > charStart + charLen) break;
    }
    return rects;
  }

  // ── Navigation ────────────────────────────────────────────────────────────
  function next() {
    if (!_results.length) return { total: 0, current: 0 };
    _currentIndex = (_currentIndex + 1) % _results.length;
    _renderHighlights();
    _scrollToCurrentResult();
    return { total: _results.length, current: _currentIndex + 1 };
  }

  function prev() {
    if (!_results.length) return { total: 0, current: 0 };
    _currentIndex = (_currentIndex - 1 + _results.length) % _results.length;
    _renderHighlights();
    _scrollToCurrentResult();
    return { total: _results.length, current: _currentIndex + 1 };
  }

  // ── Highlight rendering ───────────────────────────────────────────────────
  function _renderHighlights() {
    clearHighlights();
    _results.forEach((result, ri) => {
      const wrapper = _getPageWrapper(result.pageIndex);
      if (!wrapper) return;
      result.rects.forEach(rect => {
        const el = document.createElement('div');
        el.className = 'search-highlight' + (ri === _currentIndex ? ' current' : '');
        el.style.cssText =
          `left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px;`;
        wrapper.appendChild(el);
        _highlightEls.push(el);
      });
    });
  }

  function clearHighlights() {
    _highlightEls.forEach(el => el.remove());
    _highlightEls = [];
  }

  function _scrollToCurrentResult() {
    if (_currentIndex < 0 || !_results[_currentIndex]) return;
    const result = _results[_currentIndex];
    if (_onJumpToPage) _onJumpToPage(result.pageIndex);
    setTimeout(() => {
      const wrapper = _getPageWrapper(result.pageIndex);
      if (!wrapper) return;
      const el = wrapper.querySelector('.search-highlight.current');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
  }

  function clear() {
    _query = ''; _results = []; _currentIndex = -1;
    clearHighlights();
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return { init, search, next, prev, clear, clearHighlights };
})();
