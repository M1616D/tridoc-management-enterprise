const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const Database = require('./database');
const { autoUpdater } = require('electron-updater');

// ─────────────────────────────────────────────
// SINGLE INSTANCE + OS-LEVEL COMPATIBILITY
// ─────────────────────────────────────────────
// Only one TriDoc window at a time (two instances would fight over the DB).
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

// Windows taskbar grouping / notification identity
app.setAppUserModelId('com.triverse.tridoc');

// Old GPUs / drivers / VMs can render blank or frozen windows.
// --disable-gpu forces software rendering for stability on those machines.
if (process.argv.includes('--disable-gpu')) {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
}

// If the GPU process crashes at runtime, restart with software rendering
// instead of showing a frozen window.
app.on('child-process-gone', (event, details) => {
    const reason = String((details && details.reason) || '');
    if (details && (details.type === 'GPU' || /gpu/i.test(reason))) {
        log('GPU process crashed — relaunching with software rendering.');
        app.relaunch({ args: process.argv.slice(1).concat(['--disable-gpu']) });
        app.exit(0);
    }
});

function generateId(prefix = '') {
    return prefix + crypto.randomUUID();
}

// ─────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────
const LOG_FILE = path.join(app.getPath('temp'), 'tridoc-error.log');
function log(msg, data = '') {
    const entry = `[${new Date().toISOString()}] ${msg} ${data}\n`;
    try { fs.appendFileSync(LOG_FILE, entry, 'utf8'); } catch (e) { /* */ }
    console.log(msg, data);
}
log('========================================');
log('TriDoc Enterprise started');
log('App version:', app.getVersion());

process.on('uncaughtException', (err) => {
    log('UNCAUGHT EXCEPTION:', err.stack);
    dialog.showErrorBox('Fatal Error', `An unexpected error occurred:\n${err.message}\n\nPlease report this to support.\nLog: ${LOG_FILE}`);
    app.quit();
});

let mainWindow;
let db;
let settingsPath;
let userSettings = {
    fuzzySearch: true,
    autoIndex: true,
    maxSnippetLen: 250,
    ocrEnabled: true,
    ocrLanguages: ['en'],
    theme: 'dark',
    language: 'en'
};

const ROOT_STORAGE = path.join(app.getPath('documents'), 'TriDoc_Storage');

// Every file type the app can ingest and index. Adding a format here makes it
// uploadable, auto-indexable and searchable (content extraction lives in
// search-worker.js).
const SUPPORTED_EXTS = [
    // Documents
    'pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'epub', 'rtf',
    // Plain text / markup / data
    'txt', 'csv', 'log', 'md', 'html', 'htm', 'xml', 'json', 'yml', 'yaml', 'ini', 'svg',
    // Images (OCR)
    'jpg', 'jpeg', 'png', 'webp', 'tiff', 'bmp', 'gif'
];

// ─────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────
function loadSettings() {
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
    if (fs.existsSync(settingsPath)) {
        try {
            const data = fs.readFileSync(settingsPath, 'utf8');
            const parsed = JSON.parse(data);
            const { storageFolder, ...rest } = parsed;
            userSettings = { ...userSettings, ...rest };
        } catch (err) {
            log('Failed to load settings.json:', err);
        }
    } else {
        saveSettings();
    }
    if (!fs.existsSync(ROOT_STORAGE)) {
        fs.mkdirSync(ROOT_STORAGE, { recursive: true });
    }
}

function saveSettings() {
    try {
        const { storageFolder, ...toSave } = userSettings;
        fs.writeFileSync(settingsPath, JSON.stringify(toSave, null, 2), 'utf8');
    } catch (err) {
        log('Failed to save settings:', err);
    }
}

// ─────────────────────────────────────────────
// AUTO-UPDATER
// ─────────────────────────────────────────────
function setupAutoUpdater() {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => log('Checking for updates...'));
    autoUpdater.on('update-available', (info) => {
        log('Update available:', info);
        dialog.showMessageBox({
            type: 'info',
            title: 'Update Available',
            message: `A new version (${info.version}) is available.`,
            detail: 'Do you want to download it now?',
            buttons: ['Download', 'Remind Later']
        }).then(({ response }) => {
            if (response === 0) autoUpdater.downloadUpdate();
        });
    });
    autoUpdater.on('update-not-available', () => log('No updates available.'));
    autoUpdater.on('error', (err) => {
        log('Update error:', err);
    });
    autoUpdater.on('download-progress', (progressObj) => {
        if (mainWindow) mainWindow.webContents.send('update-progress', progressObj);
    });
    autoUpdater.on('update-downloaded', () => {
        dialog.showMessageBox({
            type: 'info',
            title: 'Update Ready',
            message: 'Update downloaded. Restart now to install.',
            buttons: ['Restart Now', 'Later']
        }).then(({ response }) => {
            if (response === 0) autoUpdater.quitAndInstall();
        });
    });

    autoUpdater.checkForUpdates();
    setInterval(() => autoUpdater.checkForUpdates(), 2 * 60 * 60 * 1000);
}

// ─────────────────────────────────────────────
// AUTO-INDEXING (watches the storage folder)
// ─────────────────────────────────────────────
let autoIndexTimer = null;

function startAutoIndexing() {
    if (autoIndexTimer) { clearInterval(autoIndexTimer); autoIndexTimer = null; }
    if (!userSettings.autoIndex) { log('Auto-indexing disabled.'); return; }
    log('Auto-indexing enabled — scanning storage folder every 60s.');

    const scan = async () => {
        try {
            const indexed = await indexNewFilesFromStorage();
            if (indexed > 0) log(`Auto-indexed ${indexed} new file(s) from storage folder.`);
        } catch (err) { log('Auto-index scan error:', err); }
    };
    setTimeout(scan, 5000); // first scan shortly after startup
    autoIndexTimer = setInterval(scan, 60000);
}

async function indexNewFilesFromStorage() {
    if (!fs.existsSync(ROOT_STORAGE)) return 0;
    let count = 0;
    for (const f of fs.readdirSync(ROOT_STORAGE)) {
        const fullPath = path.join(ROOT_STORAGE, f);
        try {
            const stat = fs.statSync(fullPath);
            if (!stat.isFile()) continue;
            const ext = path.extname(f).substring(1).toLowerCase();
            if (!SUPPORTED_EXTS.includes(ext)) continue;
            if (db.getDocumentByNameAndSize(f, stat.size)) continue;
            if (db.getDocumentByPath(fullPath)) continue;

            const extractionResult = await runExtractionWorker(fullPath, ext, userSettings.ocrEnabled, userSettings.ocrLanguages || ['en']);
            db.insertDocument({
                id: generateId('doc_'),
                filename: f,
                filepath: fullPath,
                fileType: ext.toUpperCase() || 'UNKNOWN',
                size: stat.size,
                uploadDate: new Date().toISOString(),
                category: extractionResult.category || 'Uncategorized',
                pages: extractionResult.pages || [],
                fullText: extractionResult.fullText || '',
                totalPages: extractionResult.totalPages || 1,
                tags: []
            });
            db.logActivity('AUTO_INDEX', `Auto-indexed file from storage folder: ${f}`, 'fa-solid fa-rotate', 'text-cyan-400');
            count++;
        } catch (err) {
            log(`Auto-index error for ${f}:`, err.message);
        }
    }
    return count;
}

// ─────────────────────────────────────────────
// WINDOW CREATION
// ─────────────────────────────────────────────
function createWindow() {
    try {
        log('Creating main window...');
        const webPreferences = {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        };

        mainWindow = new BrowserWindow({
            width: 1440,
            height: 900,
            minWidth: 960,
            minHeight: 640,
            backgroundColor: '#1e1e1e',
            show: false,
            autoHideMenuBar: true,
            webPreferences
        });

        mainWindow.loadFile('index.html');

        // Never open new windows; open external http(s) links in the default browser
        mainWindow.webContents.setWindowOpenHandler(({ url }) => {
            if (/^https?:/i.test(url)) shell.openExternal(url);
            return { action: 'deny' };
        });
        mainWindow.webContents.on('will-navigate', (e, url) => {
            if (/^https?:/i.test(url)) {
                e.preventDefault();
                shell.openExternal(url);
            }
        });

        mainWindow.once('ready-to-show', () => {
            mainWindow.show();
        });

        setTimeout(() => {
            if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
        }, 10000);

        mainWindow.webContents.on('crashed', () => {
            dialog.showErrorBox('Application Error', 'The application crashed. Please restart.');
            app.quit();
        });

        mainWindow.webContents.on('unresponsive', () => {
            dialog.showMessageBox({
                type: 'warning',
                title: 'Application Not Responding',
                message: 'The application is not responding.',
                buttons: ['Wait', 'Close']
            }).then(({ response }) => { if (response === 1) app.quit(); });
        });

        mainWindow.on('closed', () => { mainWindow = null; });
    } catch (err) {
        log('createWindow error:', err);
        dialog.showErrorBox('Startup Error', `Failed to create window: ${err.message}`);
        app.quit();
    }
}

// ─────────────────────────────────────────────
// APP LIFECYCLE
// ─────────────────────────────────────────────
app.whenReady().then(() => {
    loadSettings();
    try {
        db = new Database(app.getPath('userData'));
        db.init();
        log('Database initialized.');
    } catch (err) {
        log('Database init error:', err);
        dialog.showErrorBox('Database Error', `Failed to initialize database: ${err.message}`);
        app.quit();
        return;
    }
    createWindow();
    setupAutoUpdater();
    startAutoIndexing();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// ─────────────────────────────────────────────
// IPC HANDLERS
// ─────────────────────────────────────────────

// INITIAL DATA
ipcMain.handle('get-initial-data', () => {
    try {
        const stats = db.getStats();
        const storageInfo = db.getStorageInfo(ROOT_STORAGE);
        return {
            documents: db.getDocuments(1, 25),
            totalDocumentCount: db.getDocumentsCount(),
            stats,
            storageInfo,
            users: db.getUsers(),
            logs: db.getLogs(),
            tags: db.getTags(),
            searchHistory: db.getSearchHistory(),
            settings: userSettings,
            rootStorage: ROOT_STORAGE
        };
    } catch (err) {
        log('get-initial-data error:', err);
        return {
            documents: [],
            totalDocumentCount: 0,
            stats: { totalDocs: 0, totalSize: 0, totalPages: 0, formatDist: [], activityByDay: [], activityByHour: [], categoryDist: [] },
            storageInfo: { totalSize: 0, fileCount: 0, diskTotal: 0, diskFree: 0 },
            users: [],
            logs: [],
            tags: [],
            searchHistory: [],
            settings: userSettings,
            rootStorage: ROOT_STORAGE
        };
    }
});

// TRANSLATIONS
ipcMain.handle('get-translations', (event, lang) => {
    const localePath = path.join(__dirname, 'locales', `${lang}.json`);
    if (fs.existsSync(localePath)) {
        try {
            return JSON.parse(fs.readFileSync(localePath, 'utf8'));
        } catch (err) {
            log('Failed to parse translations:', err);
            return {};
        }
    }
    return {};
});

// UPLOAD FILES
// Files are processed with a small concurrency pool (3 at a time) so a batch of
// many/large files gets through quickly without overwhelming the CPU with OCR.
ipcMain.handle('upload-files', async (event, filePaths) => {
    const total = filePaths.length;
    const results = new Array(total);
    let completed = 0;
    const CONCURRENCY = 3;

    const processOne = async (index) => {
        const filePath = filePaths[index];
        const filename = path.basename(filePath);
        try {
            if (!fs.existsSync(filePath)) {
                results[index] = { filename, status: 'error', message: 'File does not exist' };
                return;
            }

            const stats = fs.statSync(filePath);
            const ext = path.extname(filename).substring(1).toLowerCase();

            if (!SUPPORTED_EXTS.includes(ext) && ext !== '') {
                results[index] = { filename, status: 'error', message: `Unsupported file type: .${ext}` };
                return;
            }

            const existing = db.getDocumentByNameAndSize(filename, stats.size);
            if (existing) {
                results[index] = { filename, status: 'duplicate', id: existing.id };
                return;
            }

            const destPath = path.join(ROOT_STORAGE, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${filename}`);
            fs.copyFileSync(filePath, destPath);

            const extractionResult = await runExtractionWorker(destPath, ext, userSettings.ocrEnabled, userSettings.ocrLanguages || ['en']);

            const docRecord = {
                id: generateId('doc_'),
                filename: filename,
                filepath: destPath,
                fileType: ext.toUpperCase() || 'UNKNOWN',
                size: stats.size,
                uploadDate: new Date().toISOString(),
                category: extractionResult.category || 'Uncategorized',
                pages: extractionResult.pages || [],
                fullText: extractionResult.fullText || '',
                totalPages: extractionResult.totalPages || 1,
                tags: []
            };

            db.insertDocument(docRecord);
            db.logActivity('DOCUMENT_UPLOAD', `Ingested file: ${filename} (${(stats.size / 1024).toFixed(1)} KB)`, 'fa-solid fa-cloud-arrow-up', 'text-brand-400');
            results[index] = { filename, status: 'success', document: docRecord };
        } catch (err) {
            log(`Error processing ${filePath}:`, err);
            results[index] = { filename, status: 'error', message: err.message || 'Processing failed' };
        } finally {
            completed++;
            event.sender.send('upload-progress', { current: completed, total, filename });
        }
    };

    // Bounded-concurrency pool
    let next = 0;
    const poolWorker = async () => {
        while (next < total) {
            const i = next++;
            await processOne(i);
        }
    };
    const poolSize = Math.min(CONCURRENCY, total);
    await Promise.all(Array.from({ length: poolSize }, () => poolWorker()));
    return results;
});

// SEARCH DOCUMENTS
ipcMain.handle('search-documents', (event, query, page = 1, limit = 25) => {
    try {
        const results = db.searchDocuments(query, page, limit);
        db.logSearch(query, results.length);
        return results;
    } catch (err) {
        log('Search error:', err);
        return [];
    }
});

// GET DOCUMENTS (paginated)
ipcMain.handle('get-documents', (event, page = 1, limit = 25) => {
    try {
        return {
            documents: db.getDocuments(page, limit),
            totalCount: db.getDocumentsCount(),
            page,
            limit
        };
    } catch (err) {
        log('get-documents error:', err);
        return { documents: [], totalCount: 0, page, limit };
    }
});

// OPEN FILE
ipcMain.handle('open-file', (event, filePath) => {
    if (!fs.existsSync(filePath)) {
        dialog.showErrorBox('File Not Found', `The file no longer exists at:\n${filePath}`);
        return false;
    }
    try {
        const err = shell.openPath(filePath);
        if (err) {
            log('openPath error:', err);
            return false;
        }
        db.logActivity('FILE_OPENED', `Opened: ${path.basename(filePath)}`, 'fa-solid fa-arrow-up-right-from-square', 'text-emerald-400');
        return true;
    } catch (err) {
        log('Open file error:', err);
        return false;
    }
});

// GET FILE BUFFER (for preview)
ipcMain.handle('get-file-buffer', (event, filePath) => {
    if (!fs.existsSync(filePath)) return null;
    try {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(filePath).substring(1).toLowerCase();
        const mimeMap = {
            'pdf': 'application/pdf',
            'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'doc': 'application/msword',
            'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'xls': 'application/vnd.ms-excel',
            'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'ppt': 'application/vnd.ms-powerpoint',
            'odt': 'application/vnd.oasis.opendocument.text',
            'epub': 'application/epub+zip',
            'rtf': 'application/rtf',
            'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
            'png': 'image/png', 'gif': 'image/gif',
            'bmp': 'image/bmp', 'tiff': 'image/tiff', 'webp': 'image/webp',
            'svg': 'image/svg+xml',
            'txt': 'text/plain', 'csv': 'text/csv',
            'log': 'text/plain', 'md': 'text/markdown',
            'html': 'text/html', 'htm': 'text/html',
            'xml': 'text/xml', 'json': 'application/json',
            'yml': 'text/yaml', 'yaml': 'text/yaml', 'ini': 'text/plain'
        };
        return {
            buffer: data.toString('base64'),
            mime: mimeMap[ext] || 'application/octet-stream',
            filename: path.basename(filePath),
            ext
        };
    } catch (err) {
        log('get-file-buffer error:', err);
        return null;
    }
});

// DELETE DOCUMENT
ipcMain.handle('delete-document', (event, id) => {
    const doc = db.getDocumentById(id);
    if (doc) {
        if (fs.existsSync(doc.filepath)) {
            try { fs.unlinkSync(doc.filepath); } catch (e) { log('Failed to delete file:', e); }
        }
        db.deleteDocument(id);
        db.logActivity('DOCUMENT_DELETED', `Deleted: ${doc.filename}`, 'fa-solid fa-trash-can', 'text-red-400');
        return true;
    }
    return false;
});

// BATCH DELETE
ipcMain.handle('batch-delete-documents', (event, ids) => {
    try {
        for (const id of ids) {
            const doc = db.getDocumentById(id);
            if (doc && fs.existsSync(doc.filepath)) {
                try { fs.unlinkSync(doc.filepath); } catch (e) { /* */ }
            }
        }
        db.batchDeleteDocuments(ids);
        db.logActivity('BATCH_DELETE', `Batch deleted ${ids.length} documents`, 'fa-solid fa-trash-can', 'text-red-400');
        return true;
    } catch (err) {
        log('batch-delete error:', err);
        return false;
    }
});

// TAGS
ipcMain.handle('get-tags', () => db.getTags());

ipcMain.handle('create-tag', (event, name, color) => {
    return db.createTag(name, color);
});

ipcMain.handle('delete-tag', (event, id) => {
    return db.deleteTag(id);
});

ipcMain.handle('update-document-tags', (event, docId, tags) => {
    db.updateDocumentTags(docId, tags);
    return true;
});

// SEARCH HISTORY
ipcMain.handle('get-search-history', () => db.getSearchHistory());

ipcMain.handle('clear-search-history', () => {
    db.clearSearchHistory();
    return true;
});

// USERS
ipcMain.handle('save-user', (event, userData) => {
    const result = db.saveUser(userData);
    db.logActivity('USER_SAVED', `Updated user: ${userData.name} (${userData.role})`, 'fa-solid fa-user-pen', 'text-purple-400');
    return result;
});

ipcMain.handle('delete-user', (event, userId) => {
    db.deleteUser(userId);
    db.logActivity('USER_DELETED', `Deleted user: ${userId}`, 'fa-solid fa-user-slash', 'text-red-400');
    return db.getUsers();
});

// SETTINGS
ipcMain.handle('save-settings', (event, newSettings) => {
    userSettings = { ...userSettings, ...newSettings };
    saveSettings();
    if (typeof newSettings.autoIndex === 'boolean') startAutoIndexing();
    db.logActivity('SETTINGS_UPDATED', 'Modified system configuration', 'fa-solid fa-gear', 'text-blue-400');
    return userSettings;
});

// CLEAR CACHE
ipcMain.handle('clear-cache', () => {
    db.clearAllDocuments();
    db.rebuildFTS();
    db.logActivity('CACHE_CLEARED', 'Purged all documents and search indices', 'fa-solid fa-broom', 'text-yellow-400');
    return true;
});

// BACKUP
ipcMain.handle('backup-database', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Backup Database',
        defaultPath: `tridoc_backup_${new Date().toISOString().slice(0, 10)}.db`,
        filters: [{ name: 'SQLite Database', extensions: ['db'] }]
    });
    if (result.canceled) return null;
    try {
        db.backupDatabase(result.filePath);
        db.logActivity('BACKUP', `Database backed up to: ${result.filePath}`, 'fa-solid fa-download', 'text-blue-400');
        return { success: true, path: result.filePath };
    } catch (err) {
        log('Backup error:', err);
        return { success: false, error: err.message };
    }
});

// REBUILD FTS
ipcMain.handle('rebuild-fts', () => {
    try {
        db.rebuildFTS();
        return true;
    } catch (err) {
        log('Rebuild FTS error:', err);
        return false;
    }
});

// ─────────────────────────────────────────────
// WORKER
// ─────────────────────────────────────────────
// Extraction runs in a worker_thread so the UI never freezes. A hard timeout
// protects against corrupt files or pathological documents that never finish.
const EXTRACTION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes (OCR-heavy files)

function runExtractionWorker(filePath, ext, ocrEnabled, ocrLanguages = ['en']) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'search-worker.js'), {
            workerData: { filePath, ext, ocrEnabled, ocrLanguages }
        });
        const timer = setTimeout(() => {
            log('Extraction timed out, terminating worker for:', path.basename(filePath));
            worker.terminate();
            reject(new Error('Extraction timed out — file may be too large or corrupted'));
        }, EXTRACTION_TIMEOUT_MS);
        const done = () => clearTimeout(timer);
        worker.on('message', (result) => {
            done();
            if (result.error) reject(new Error(result.error));
            else resolve(result);
        });
        worker.on('error', (err) => { done(); reject(err); });
        worker.on('exit', (code) => {
            done();
            if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
        });
    });
}
