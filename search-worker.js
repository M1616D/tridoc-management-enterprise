const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { createWorker } = require('tesseract.js');

async function extract() {
    const { filePath, ext, ocrEnabled } = workerData;
    let fullText = '';
    let pages = [];
    let category = 'Reports';

    try {
        if (ext === 'pdf') {
            try {
                const dataBuffer = fs.readFileSync(filePath);
                const pdfData = await pdfParse(dataBuffer);
                fullText = pdfData.text || '';
                pages.push({ pageNumber: 1, text: fullText });
                category = 'Contracts';
            } catch (pdfErr) {
                // If pdf-parse fails, we try to read as text (if possible) or return error
                throw new Error(`PDF parsing failed: ${pdfErr.message}`);
            }
        } else if (ext === 'docx') {
            const dataBuffer = fs.readFileSync(filePath);
            const result = await mammoth.extractRawText({ buffer: dataBuffer });
            fullText = result.value || '';
            pages.push({ pageNumber: 1, text: fullText });
            category = 'Employees';
        } else if (['jpg', 'jpeg', 'png', 'tiff', 'bmp'].includes(ext)) {
            if (ocrEnabled) {
                const worker = await createWorker('eng');
                const ret = await worker.recognize(filePath);
                fullText = ret.data.text || '';
                await worker.terminate();
            } else {
                fullText = '[Image file - OCR disabled]';
            }
            pages.push({ pageNumber: 1, text: fullText });
            category = 'Scanned';
        } else if (['txt', 'csv', 'log', 'md'].includes(ext)) {
            fullText = fs.readFileSync(filePath, 'utf8');
            pages.push({ pageNumber: 1, text: fullText });
            category = 'Text';
        } else {
            // Fallback for other text-like files
            try {
                fullText = fs.readFileSync(filePath, 'utf8');
                pages.push({ pageNumber: 1, text: fullText });
                category = 'Other';
            } catch (e) {
                fullText = '[Unsupported file format]';
                pages.push({ pageNumber: 1, text: fullText });
                category = 'Unsupported';
            }
        }

        parentPort.postMessage({ fullText, pages, category });
    } catch (err) {
        // Send a clean error message back to main process
        parentPort.postMessage({ error: err.message || 'Unknown extraction error' });
    }
}

extract();