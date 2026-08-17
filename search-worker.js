const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
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
            category = 'Employees';
        } else if (['jpg', 'jpeg', 'png', 'tiff', 'bmp', 'gif'].includes(ext)) {
            if (ocrEnabled) {
                fullText = await ocrFile(filePath, ocrLanguages);
                if (!fullText) fullText = '[No text extracted – OCR returned no content]';
            } else {
                fullText = '[Image file - OCR disabled]';
            }
            pages.push({ pageNumber: 1, text: fullText });
            totalPages = 1;
            category = 'Scanned';
        } else if (['txt', 'csv', 'log', 'md'].includes(ext)) {
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

        parentPort.postMessage({ fullText, pages, category, totalPages });
    } catch (err) {
        parentPort.postMessage({ error: err.message || 'Unknown extraction error' });
    }
}

extract();
