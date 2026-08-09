const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { createWorker } = require('tesseract.js');
const { fromPath } = require('pdf2pic');
const sharp = require('sharp');

async function extract() {
    const { filePath, ext, ocrEnabled } = workerData;
    let fullText = '';
    let pages = [];
    let category = 'Reports';

    try {
        if (ext === 'pdf') {
            const dataBuffer = fs.readFileSync(filePath);
            const pdfData = await pdfParse(dataBuffer);
            fullText = pdfData.text || '';
            
            if (fullText.trim().length < 20 && ocrEnabled) {
                const tempDir = path.dirname(filePath);
                const options = {
                    density: 100,
                    saveFilename: "temp_page",
                    savePath: tempDir,
                    format: "png",
                    width: 1024,
                    height: 768
                };
                const convert = fromPath(filePath, options);
                try {
                    const pagesImages = await convert.bulk(-1, { responseType: 'image' });
                    const worker = await createWorker('eng');
                    let ocrText = '';
                    for (let page of pagesImages) {
                        if (page && page.path && fs.existsSync(page.path)) {
                            const ret = await worker.recognize(page.path);
                            ocrText += ret.data.text + ' ';
                            try { fs.unlinkSync(page.path); } catch(e) {}
                        }
                    }
                    await worker.terminate();
                    fullText = ocrText || fullText;
                } catch (ocrErr) {
                    console.warn('PDF OCR failed:', ocrErr.message);
                }
            }
            pages.push({ pageNumber: 1, text: fullText });
            category = 'Contracts';
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
        } else {
            fullText = fs.readFileSync(filePath, 'utf8');
            pages.push({ pageNumber: 1, text: fullText });
            category = 'Finance';
        }

        parentPort.postMessage({ fullText, pages, category });
    } catch (err) {
        parentPort.postMessage({ error: err.message });
    }
}

extract();