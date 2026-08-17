const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const JSZip = require('jszip');
const { createWorker } = require('tesseract.js');

// Local Tesseract traineddata folder, bundled with the app.
// In dev builds it sits next to this file; in packaged builds it is copied
// to process.resourcesPath/tessdata via the "extraResources" build config.
function resolveTessdataDir() {
    const local = path.join(__dirname, 'tessdata');
    if (fs.existsSync(local)) return local;
    const bundled = path.join(process.resourcesPath || '', 'tessdata');
    if (fs.existsSync(bundled)) return bundled;
    return local;
}
const TESSDATA_DIR = resolveTessdataDir();

// ─────────────────────────────────────────────
// TEXT CLEANING / MARKUP HELPERS
// ─────────────────────────────────────────────

// Strip HTML/XML tags and decode common entities into plain text.
function stripMarkup(text) {
    if (!text) return '';
    return text
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ' '; } })
        .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return ' '; } })
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Best-effort RTF text extraction (strips control words / group braces).
function extractRtf(text) {
    if (!text) return '';
    return text
        .replace(/\\'[0-9a-fA-F]{2}/g, '')          // hex-escaped bytes (kept raw — often UTF-8)
        .replace(/\\[a-zA-Z]+-?\d* ?/g, ' ')       // control words incl. \uN unicode escapes
        .replace(/[{}]/g, '')                         // group braces
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Cap the stored per-page breakdown: keep the first MAX pages, fold the rest
// into the last kept page so very long books/reports don't bloat the database.
// (fullText always keeps the complete text for search.)
const MAX_STORED_PAGES = 300;
function capPages(pages) {
    if (!pages || pages.length <= MAX_STORED_PAGES) return pages;
    const kept = pages.slice(0, MAX_STORED_PAGES - 1);
    const tail = pages.slice(MAX_STORED_PAGES - 1);
    kept.push({
        pageNumber: kept.length + 1,
        text: tail.map(p => p.text || '').join('\n\n')
    });
    return kept;
}

// ─────────────────────────────────────────────
// ZIP-BASED OFFICE FORMATS (pptx / xlsx / odt / epub)
// ─────────────────────────────────────────────
// All four are ZIP containers of XML. jszip (already in node_modules) lets us
// read them without any native dependencies, so they work on every platform.

async function extractPptx(zip) {
    const slides = Object.keys(zip.files)
        .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => {
            const na = parseInt(a.match(/slide(\d+)/)[1], 10);
            const nb = parseInt(b.match(/slide(\d+)/)[1], 10);
            return na - nb;
        });
    const pages = [];
    for (const name of slides) {
        const xml = await zip.file(name).async('string');
        const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m => m[1]);
        const text = runs.join(' ').replace(/[ \t]+/g, ' ').trim();
        pages.push({ pageNumber: pages.length + 1, text: text || '(empty slide)' });
    }
    return pages;
}

async function extractXlsx(zip) {
    // Shared strings table (cell text is stored once and referenced by index)
    const shared = [];
    const ss = zip.file('xl/sharedStrings.xml');
    if (ss) {
        const xml = await ss.async('string');
        for (const m of xml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)) {
            const runs = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(r => r[1]);
            shared.push(runs.join(''));
        }
    }

    const sheets = Object.keys(zip.files)
        .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
        .sort((a, b) => {
            const na = parseInt(a.match(/sheet(\d+)/)[1], 10);
            const nb = parseInt(b.match(/sheet(\d+)/)[1], 10);
            return na - nb;
        });

    const pages = [];
    for (const name of sheets) {
        const xml = await zip.file(name).async('string');
        const lines = [];
        for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
            const cells = [...rm[1].matchAll(/<c[^>]*>([\s\S]*?)<\/c>/g)];
            const cellTexts = cells.map(cm => {
                const cell = cm[0];
                const t = (cell.match(/\st="([^"]*)"/) || [])[1];
                const v = (cell.match(/<v>([^<]*)<\/v>/) || [])[1];
                if (t === 'inlineStr') {
                    // Inline strings carry their text inside <is><t>…</t></is> (no <v>)
                    const runs = [...cell.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(r => r[1]);
                    return runs.join('');
                }
                if (v == null) return '';
                if (t === 's') {
                    const idx = parseInt(v, 10);
                    return shared[idx] != null ? shared[idx] : '';
                }
                return v.trim();
            });
            const line = cellTexts.filter(Boolean).join('\t').replace(/[ \t]+/g, ' ').trim();
            if (line) lines.push(line);
        }
        pages.push({ pageNumber: pages.length + 1, text: lines.join('\n') || '(empty sheet)' });
    }
    return pages;
}

async function extractOdt(zip) {
    const content = zip.file('content.xml');
    if (!content) return [];
    const xml = await content.async('string');
    // Paragraph ends become line breaks, then strip all tags
    const text = xml
        .replace(/<\/text:p>/gi, '\n')
        .replace(/<\/text:h>/gi, '\n')
        .replace(/<\/text:tab>/gi, '\t');
    return [{ pageNumber: 1, text: stripMarkup(text) }];
}

async function extractEpub(zip) {
    const chapters = Object.keys(zip.files)
        .filter(n => /\.(xhtml|html|htm)$/i.test(n) && !/toc|nav/i.test(n) && !zip.files[n].dir)
        .sort();
    const pages = [];
    for (const name of chapters) {
        const raw = await zip.file(name).async('string');
        const text = stripMarkup(raw);
        if (text) pages.push({ pageNumber: pages.length + 1, text });
    }
    return pages;
}

// Generic ZIP text extractor by format kind
async function extractZipText(filePath, kind) {
    const data = fs.readFileSync(filePath);
    const zip = await JSZip.loadAsync(data);
    if (kind === 'pptx') return extractPptx(zip);
    if (kind === 'xlsx') return extractXlsx(zip);
    if (kind === 'odt') return extractOdt(zip);
    if (kind === 'epub') return extractEpub(zip);
    return [];
}

// Supported OCR languages mapped to Tesseract codes
const LANG_MAP = {
    'en': 'eng',
    'am': 'amh',
    'om': 'orm',
    'ar': 'ara',
    'fr': 'fra',
    'es': 'spa',
    'de': 'deu',
    'zh': 'chi_sim',
    'ja': 'jpn',
    'ko': 'kor',
    'hi': 'hin',
    'pt': 'por',
    'ru': 'rus',
    'sw': 'swh',
    'tr': 'tur',
    'it': 'ita',
    'nl': 'nld',
    'pl': 'pol',
    'th': 'tha',
    'vi': 'vie',
    'id': 'ind'
};

function buildLangString(ocrLanguages) {
    const langs = (ocrLanguages && ocrLanguages.length > 0) ? ocrLanguages : ['en'];
    const tessLangs = langs.map(l => LANG_MAP[l] || l).filter(Boolean);
    return tessLangs.length > 0 ? tessLangs.join('+') : 'eng';
}

// Detect a broken/low-quality text layer. When a PDF creator tool cannot map
// non-Latin glyphs (e.g. Amharic) it often replaces every character with the
// same fallback glyph — usually "•" (U+2022) — so the text layer contains
// "words" made of bullets. Normal documents use single bullets as list
// markers, so 2+ bullet-words (or replacement chars / NULs) is the signature
// of a damaged text layer.
function detectBrokenTextLayer(text) {
    if (!text) return false;
    const bulletWords = (text.match(/(?:^|\s)[\u2022\u2023\u25AA\u25CF\u25E6]{2,}(?=\s|$)/g) || []).length;
    const replacementChars = (text.match(/[\uFFFD\u0000]/g) || []).length;
    return bulletWords >= 2 || replacementChars > 0;
}

// OCR a file (image or PDF page rendered to an image).
// NOTE: in Node, tesseract.js cannot read PDFs directly ("Pdf reading is not
// supported") — only images — so PDFs must be rasterized to images first.
// Languages are loaded from the bundled tessdata folder via cachePath with
// cacheMethod 'read' — this reads the .traineddata files straight from disk
// and works offline. (A plain langPath doesn't work in Electron: tesseract.js
// treats Electron as a browser and tries to fetch() the local path.)
// Languages not bundled locally fall back to the tesseract.js CDN, and if the
// whole language set fails to load we retry with English so extraction still
// produces content instead of failing the whole upload.
async function ocrFile(filePath, ocrLanguages) {
    const langs = (ocrLanguages && ocrLanguages.length > 0) ? ocrLanguages : ['en'];
    const attempts = [buildLangString(langs)];
    if (!langs.includes('en')) attempts.push('eng');

    for (const langStr of attempts) {
        try {
            console.log(`[OCR] Using languages: ${langStr} (cachePath: ${TESSDATA_DIR})`);
            const worker = await createWorker(langStr, 1, {
                cachePath: TESSDATA_DIR,
                cacheMethod: 'read'
            });
            try {
                const ret = await worker.recognize(filePath);
                return (ret.data && ret.data.text) ? ret.data.text : '';
            } finally {
                await worker.terminate();
            }
        } catch (err) {
            console.warn(`[OCR] Failed with language(s) "${langStr}":`, err.message);
        }
    }
    return '';
}

async function extract() {
    const { filePath, ext, ocrEnabled, ocrLanguages } = workerData;
    let fullText = '';
    let pages = [];
    let category = 'Reports';
    let totalPages = 0;

    try {
        if (ext === 'pdf') {
            try {
                const dataBuffer = fs.readFileSync(filePath);
                const pdfData = await pdfParse(dataBuffer);
                fullText = (pdfData.text || '').trim();
                totalPages = pdfData.numpages || 1;

                if (fullText.length > 0) {
                    // Text-based PDF — preserve page structure
                    const approxCharsPerPage = Math.ceil(fullText.length / totalPages);
                    for (let i = 0; i < totalPages; i++) {
                        const start = i * approxCharsPerPage;
                        const end = Math.min((i + 1) * approxCharsPerPage, fullText.length);
                        pages.push({ pageNumber: i + 1, text: fullText.substring(start, end) });
                    }
                    if (detectBrokenTextLayer(fullText)) {
                        // The text layer contains fallback glyphs (e.g. "•" replacing
                        // Amharic characters). Keep the text so the readable part still
                        // searches, but flag the document so the UI can tell the user
                        // the non-Latin content was lost when the PDF was created.
                        console.warn(`[EXTRACT] Broken text layer detected in ${path.basename(filePath)} — non-Latin text may have been replaced by fallback glyphs ("•") at PDF creation time.`);
                        category = 'Broken Text Layer';
                    } else {
                        category = 'Contracts';
                    }
                } else if (ocrEnabled) {
                    // Scanned/image PDF — OCR fallback
                    fullText = (await ocrFile(filePath, ocrLanguages)).trim();
                    if (!fullText) {
                        fullText = '[No text extracted – PDF may be corrupted or scanned]';
                        pages = [{ pageNumber: 1, text: fullText }];
                        category = 'Unreadable PDF';
                    } else {
                        pages = [{ pageNumber: 1, text: fullText }];
                        category = 'Scanned';
                    }
                } else {
                    fullText = '[No text extracted – scanned PDF, OCR disabled]';
                    pages = [{ pageNumber: 1, text: fullText }];
                    category = 'Unreadable PDF';
                }
            } catch (pdfErr) {
                // pdf-parse failed entirely — try OCR on the raw file
                console.warn(`PDF parsing failed for ${path.basename(filePath)}:`, pdfErr.message);
                if (ocrEnabled) {
                    try {
                        fullText = (await ocrFile(filePath, ocrLanguages)).trim();
                    } catch (ocrErr) {
                        console.warn(`PDF OCR failed for ${path.basename(filePath)}:`, ocrErr.message);
                        fullText = '';
                    }
                }
                if (!fullText) {
                    fullText = '[No text extracted – PDF may be corrupted or scanned]';
                    category = 'Unreadable PDF';
                } else {
                    category = 'Scanned';
                }
                pages = [{ pageNumber: 1, text: fullText }];
                totalPages = 1;
            }
        } else if (ext === 'docx') {
            const dataBuffer = fs.readFileSync(filePath);
            const result = await mammoth.extractRawText({ buffer: dataBuffer });
            fullText = result.value || '';
            pages.push({ pageNumber: 1, text: fullText });
            totalPages = 1;
            category = 'Word';
        } else if (ext === 'pptx') {
            pages = await extractZipText(filePath, 'pptx');
            fullText = pages.map(p => p.text).join('\n');
            totalPages = pages.length;
            category = 'Presentation';
        } else if (ext === 'xlsx') {
            pages = await extractZipText(filePath, 'xlsx');
            fullText = pages.map(p => p.text).join('\n');
            totalPages = pages.length;
            category = 'Spreadsheet';
        } else if (ext === 'odt') {
            pages = await extractZipText(filePath, 'odt');
            fullText = pages.map(p => p.text).join('\n');
            totalPages = pages.length;
            category = 'Word';
        } else if (ext === 'epub') {
            pages = await extractZipText(filePath, 'epub');
            fullText = pages.map(p => p.text).join('\n');
            totalPages = pages.length;
            category = 'eBook';
        } else if (['doc', 'xls', 'ppt'].includes(ext)) {
            // Legacy binary Office formats — the content can't be parsed without
            // Office itself, but the file is preserved and searchable by name.
            fullText = `[Legacy ${ext.toUpperCase()} format — contents cannot be extracted. Open the file to view it.]`;
            pages.push({ pageNumber: 1, text: fullText });
            totalPages = 1;
            category = 'Legacy Office';
        } else if (['jpg', 'jpeg', 'png', 'webp', 'tiff', 'bmp', 'gif'].includes(ext)) {
            if (ocrEnabled) {
                fullText = await ocrFile(filePath, ocrLanguages);
                if (!fullText) fullText = '[No text extracted – OCR returned no content]';
            } else {
                fullText = '[Image file - OCR disabled]';
            }
            pages.push({ pageNumber: 1, text: fullText });
            totalPages = 1;
            category = 'Scanned';
        } else if (['txt', 'csv', 'log', 'md', 'json', 'yml', 'yaml', 'ini'].includes(ext)) {
            fullText = fs.readFileSync(filePath, 'utf8');
            // Estimate pages from lines (~50 lines per page)
            const lines = fullText.split('\n');
            totalPages = Math.max(1, Math.ceil(lines.length / 50));
            if (totalPages === 1) {
                pages.push({ pageNumber: 1, text: fullText });
            } else {
                const linesPerPage = Math.ceil(lines.length / totalPages);
                for (let i = 0; i < totalPages; i++) {
                    const start = i * linesPerPage;
                    const end = Math.min((i + 1) * linesPerPage, lines.length);
                    pages.push({ pageNumber: i + 1, text: lines.slice(start, end).join('\n') });
                }
            }
            category = 'Text';
        } else if (ext === 'rtf') {
            fullText = extractRtf(fs.readFileSync(filePath, 'utf8'));
            pages.push({ pageNumber: 1, text: fullText });
            totalPages = 1;
            category = 'Text';
        } else if (['html', 'htm', 'xml', 'svg'].includes(ext)) {
            fullText = stripMarkup(fs.readFileSync(filePath, 'utf8'));
            pages.push({ pageNumber: 1, text: fullText });
            totalPages = 1;
            category = ext === 'svg' ? 'Image' : 'Web';
        } else {
            try {
                fullText = fs.readFileSync(filePath, 'utf8');
                pages.push({ pageNumber: 1, text: fullText });
                totalPages = 1;
                category = 'Other';
            } catch (e) {
                fullText = '[Unsupported file format]';
                pages.push({ pageNumber: 1, text: fullText });
                totalPages = 1;
                category = 'Unsupported';
            }
        }

        pages = capPages(pages || []);
        parentPort.postMessage({ fullText, pages, category, totalPages });
    } catch (err) {
        parentPort.postMessage({ error: err.message || 'Unknown extraction error' });
    }
}

extract();
