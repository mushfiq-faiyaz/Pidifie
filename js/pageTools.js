/* =============================================================================
   PDFy – Page Tools Module
   Handles structural PDF operations using pdf-lib:
     - Rotate page (CW / CCW)
     - Delete page
     - Merge multiple PDFs
     - Split / extract page ranges
   These operations work on a copy of the raw PDF bytes, not on the viewer
   display. After any structural change the viewer reloads the modified PDF.
   ============================================================================= */

const PageTools = (() => {
  // ── Rotate ────────────────────────────────────────────────────────────────
  /**
   * Rotate the current page by ±90°.
   * @param {Uint8Array} pdfBytes  Raw PDF bytes
   * @param {number}     pageIndex 0-based
   * @param {'cw'|'ccw'} direction
   * @returns {Promise<Uint8Array>} New PDF bytes
   */
  async function rotatePage(pdfBytes, pageIndex, direction) {
    const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes);
    const pages  = pdfDoc.getPages();

    if (pageIndex < 0 || pageIndex >= pages.length) {
      throw new Error(`Page index ${pageIndex} out of range`);
    }

    const page       = pages[pageIndex];
    const currentRot = page.getRotation().angle;
    const delta      = direction === 'cw' ? 90 : -90;
    const newRot     = ((currentRot + delta) % 360 + 360) % 360;
    page.setRotation(PDFLib.degrees(newRot));

    return pdfDoc.save();
  }

  // ── Delete page ───────────────────────────────────────────────────────────
  /**
   * Remove a page from the PDF.
   * @param {Uint8Array} pdfBytes
   * @param {number}     pageIndex 0-based
   * @returns {Promise<Uint8Array>}
   */
  async function deletePage(pdfBytes, pageIndex) {
    const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes);

    if (pdfDoc.getPageCount() <= 1) {
      throw new Error('Cannot delete the only page in a document.');
    }
    if (pageIndex < 0 || pageIndex >= pdfDoc.getPageCount()) {
      throw new Error(`Page index ${pageIndex} out of range`);
    }

    pdfDoc.removePage(pageIndex);
    return pdfDoc.save();
  }

  // ── Reorder pages ─────────────────────────────────────────────────────────
  /**
   * Reorder pages according to a new order array.
   * @param {Uint8Array} pdfBytes
   * @param {number[]}   newOrder  Array of 0-based page indices in desired order
   * @returns {Promise<Uint8Array>}
   */
  async function reorderPages(pdfBytes, newOrder) {
    const srcDoc  = await PDFLib.PDFDocument.load(pdfBytes);
    const dstDoc  = await PDFLib.PDFDocument.create();

    const copied = await dstDoc.copyPages(srcDoc, newOrder);
    copied.forEach(page => dstDoc.addPage(page));

    return dstDoc.save();
  }

  // ── Merge PDFs ────────────────────────────────────────────────────────────
  /**
   * Merge an array of PDF byte arrays into a single PDF.
   * @param {Uint8Array[]} byteArrays
   * @returns {Promise<Uint8Array>}
   */
  async function mergePdfs(byteArrays) {
    const mergedDoc = await PDFLib.PDFDocument.create();

    for (const bytes of byteArrays) {
      const doc       = await PDFLib.PDFDocument.load(bytes);
      const pageCount = doc.getPageCount();
      const indices   = Array.from({ length: pageCount }, (_, i) => i);
      const pages     = await mergedDoc.copyPages(doc, indices);
      pages.forEach(p => mergedDoc.addPage(p));
    }

    return mergedDoc.save();
  }

  // ── Split / Extract pages ─────────────────────────────────────────────────
  /**
   * Extract specified pages into a new PDF.
   * @param {Uint8Array} pdfBytes
   * @param {number[]}   pageIndices  0-based indices to extract
   * @returns {Promise<Uint8Array>}
   */
  async function extractPages(pdfBytes, pageIndices) {
    const srcDoc = await PDFLib.PDFDocument.load(pdfBytes);
    const dstDoc = await PDFLib.PDFDocument.create();

    // Validate indices
    const total = srcDoc.getPageCount();
    const valid = pageIndices.filter(i => i >= 0 && i < total);
    if (valid.length === 0) throw new Error('No valid page indices provided.');

    const pages = await dstDoc.copyPages(srcDoc, valid);
    pages.forEach(p => dstDoc.addPage(p));

    return dstDoc.save();
  }

  // ── Bake annotations into PDF ─────────────────────────────────────────────
  /**
   * Embed annotation images (from Annotations.getAnnotationImages()) onto
   * each respective page in the PDF, then return the new PDF bytes.
   * This is called when saving the PDF.
   *
   * @param {Uint8Array} pdfBytes
   * @param {Object}     annotationImages  { pageIndex: pngDataUrl }
   * @returns {Promise<Uint8Array>}
   */
  async function bakeAnnotations(pdfBytes, annotationImages) {
    const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes);
    const pages  = pdfDoc.getPages();

    for (const [piStr, dataUrl] of Object.entries(annotationImages)) {
      const pageIndex = parseInt(piStr);
      if (pageIndex < 0 || pageIndex >= pages.length) continue;

      // Convert data URL to Uint8Array
      const base64 = dataUrl.split(',')[1];
      const binary  = atob(base64);
      const bytes   = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      // Embed PNG
      const pngImage = await pdfDoc.embedPng(bytes);
      const page     = pages[pageIndex];
      const { width, height } = page.getSize();

      // Draw annotation layer at full page size, transparent where empty
      page.drawImage(pngImage, {
        x:      0,
        y:      0,
        width:  width,
        height: height,
        opacity: 1,
      });
    }

    return pdfDoc.save();
  }

  // ── Parse page range string ───────────────────────────────────────────────
  /**
   * Parse a user-entered range string like "1,3,5-8" into 0-based indices.
   * @param {string} rangeStr  e.g. "1-3, 5, 7-9"
   * @param {number} totalPages
   * @returns {number[]} sorted unique 0-based indices
   */
  function parsePageRange(rangeStr, totalPages) {
    const indices = new Set();
    const parts   = rangeStr.split(',').map(s => s.trim()).filter(Boolean);

    for (const part of parts) {
      if (part.includes('-')) {
        const [a, b] = part.split('-').map(s => parseInt(s.trim(), 10));
        if (isNaN(a) || isNaN(b)) continue;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        for (let i = lo; i <= hi; i++) {
          if (i >= 1 && i <= totalPages) indices.add(i - 1); // convert to 0-based
        }
      } else {
        const n = parseInt(part, 10);
        if (!isNaN(n) && n >= 1 && n <= totalPages) indices.add(n - 1);
      }
    }
    return [...indices].sort((a, b) => a - b);
  }

  // ── Trigger file download ─────────────────────────────────────────────────
  /**
   * Trigger a browser download of PDF bytes.
   * @param {Uint8Array} bytes
   * @param {string}     filename
   */
  function downloadPdf(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    rotatePage,
    deletePage,
    reorderPages,
    mergePdfs,
    extractPages,
    bakeAnnotations,
    parsePageRange,
    downloadPdf,
  };
})();
