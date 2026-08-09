const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const Database = require('./database');

let mainWindow;
let db;
let settingsPath;
let userSettings = {
    fuzzySearch: true,
    autoIndex: true,
    maxSnippetLen: 250,
    ocrEnabled: true,
    theme: 'dark',
    language: 'en'
};

const ROOT_STORAGE = path.join(app.getPath('documents'), 'TriDoc_Storage');

function loadSettings() {
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
    if (fs.existsSync(settingsPath)) {
        try {
            const data = fs.readFileSync(settingsPath, 'utf8');
            const parsed = JSON.parse(data);
            const { storageFolder, ...rest } = parsed;
            userSettings = { ...userSettings, ...rest };
        } catch (err) {
            console.error('Failed to load settings.json:', err);
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
        console.error('Failed to save settings:', err);
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 700,
        backgroundColor: '#1e1e1e',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
    loadSettings();
    db = new Database(app.getPath('userData'));
    db.init();
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// --- IPC ---

ipcMain.handle('get-initial-data', () => {
    return {
        documents: db.getDocuments(1, 100),
        stats: db.getStats(),
        users: db.getUsers(),
        logs: db.getLogs(),
        settings: userSettings,
        rootStorage: ROOT_STORAGE
    };
});

ipcMain.handle('get-translations', (event, lang) => {
    const localePath = path.join(__dirname, 'locales', `${lang}.json`);
    if (fs.existsSync(localePath)) {
        const data = fs.readFileSync(localePath, 'utf8');
        return JSON.parse(data);
    }
    return {};
});

ipcMain.handle('upload-files', async (event, filePaths) => {
    const results = [];
    const total = filePaths.length;
    for (let i = 0; i < total; i++) {
        const filePath = filePaths[i];
        try {
            if (!fs.existsSync(filePath)) continue;
            const filename = path.basename(filePath);
            const stats = fs.statSync(filePath);
            const ext = path.extname(filename).substring(1).toLowerCase();
            
            const existing = db.getDocumentByNameAndSize(filename, stats.size);
            if (existing) {
                results.push({ filename, status: 'duplicate', id: existing.id });
                continue;
            }

            const destPath = path.join(ROOT_STORAGE, `${Date.now()}_${filename}`);
            fs.copyFileSync(filePath, destPath);

            const extractionResult = await runExtractionWorker(destPath, ext, userSettings.ocrEnabled);

            const docRecord = {
                id: 'doc_' + Math.random().toString(36).substring(2, 11),
                filename: filename,
                filepath: destPath,
                fileType: ext.toUpperCase(),
                size: stats.size,
                uploadDate: new Date().toISOString(),
                category: extractionResult.category || 'Reports',
                pages: extractionResult.pages || [],
                fullText: extractionResult.fullText || ''
            };

            db.insertDocument(docRecord);
            db.logActivity('DOCUMENT_UPLOAD', `Ingested file: ${filename} (${stats.size} bytes)`, 'fa-solid fa-cloud-arrow-up', 'text-brand-400');
            results.push({ filename, status: 'success', document: docRecord });
            event.sender.send('upload-progress', { current: i+1, total, filename });
        } catch (err) {
            console.error(`Error processing ${filePath}:`, err);
            results.push({ filename: path.basename(filePath), status: 'error', message: err.message });
        }
    }
    return results;
});

ipcMain.handle('search-documents', (event, query, page = 1, limit = 25) => {
    return db.searchDocuments(query, page, limit);
});

ipcMain.handle('open-file', (event, filePath) => {
    if (fs.existsSync(filePath)) {
        shell.openPath(filePath);
        db.logActivity('FILE_OPENED', `Opened physical file: ${path.basename(filePath)}`, 'fa-solid fa-arrow-up-right-from-square', 'text-emerald-400');
        return true;
    }
    return false;
});

ipcMain.handle('delete-document', (event, id) => {
    const doc = db.getDocumentById(id);
    if (doc) {
        if (fs.existsSync(doc.filepath)) {
            try { fs.unlinkSync(doc.filepath); } catch(e) {}
        }
        db.deleteDocument(id);
        db.logActivity('DOCUMENT_DELETED', `Permanently purged document: ${doc.filename}`, 'fa-solid fa-trash-can', 'text-red-400');
        return true;
    }
    return false;
});

ipcMain.handle('save-user', (event, userData) => {
    const result = db.saveUser(userData);
    db.logActivity('USER_SAVED', `Updated/Created user account: ${userData.name} (${userData.role})`, 'fa-solid fa-user-pen', 'text-purple-400');
    return result;
});

ipcMain.handle('delete-user', (event, userId) => {
    db.deleteUser(userId);
    db.logActivity('USER_DELETED', `Deleted user ID: ${userId}`, 'fa-solid fa-user-slash', 'text-red-400');
    return db.getUsers();
});

ipcMain.handle('save-settings', (event, newSettings) => {
    userSettings = { ...userSettings, ...newSettings };
    saveSettings();
    db.logActivity('SETTINGS_UPDATED', 'Modified TriDoc system configuration parameters.', 'fa-solid fa-gear', 'text-blue-400');
    return userSettings;
});

ipcMain.handle('clear-cache', () => {
    db.clearAllDocuments();
    db.logActivity('CACHE_CLEARED', 'Purged all SQLite documents and search indices.', 'fa-solid fa-broom', 'text-yellow-400');
    return true;
});

function runExtractionWorker(filePath, ext, ocrEnabled) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'search-worker.js'), {
            workerData: { filePath, ext, ocrEnabled }
        });
        worker.on('message', (result) => {
            if (result.error) reject(new Error(result.error));
            else resolve(result);
        });
        worker.on('error', reject);
        worker.on('exit', (code) => {
            if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
        });
    });
}