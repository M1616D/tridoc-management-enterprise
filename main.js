const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const Database = require('./database');
const { autoUpdater } = require('electron-updater');

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

// ------------------------------------------------------------
// AUTO-UPDATER
// ------------------------------------------------------------
function setupAutoUpdater() {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
        console.log('Checking for updates...');
    });

    autoUpdater.on('update-available', (info) => {
        console.log('Update available:', info);
        dialog.showMessageBox({
            type: 'info',
            title: 'Update Available',
            message: `A new version (${info.version}) is available.`,
            detail: 'Do you want to download it now?',
            buttons: ['Download', 'Remind Later']
        }).then(({ response }) => {
            if (response === 0) {
                autoUpdater.downloadUpdate();
            }
        });
    });

    autoUpdater.on('update-not-available', () => {
        console.log('No updates available.');
    });

    autoUpdater.on('error', (err) => {
        console.error('Update error:', err);
        dialog.showErrorBox('Update Error', err.message);
    });

    autoUpdater.on('download-progress', (progressObj) => {
        if (mainWindow) {
            mainWindow.webContents.send('update-progress', progressObj);
        }
        console.log(`Downloaded ${progressObj.percent}%`);
    });

    autoUpdater.on('update-downloaded', () => {
        dialog.showMessageBox({
            type: 'info',
            title: 'Update Ready',
            message: 'The update has been downloaded. It will be installed when you restart the application.',
            buttons: ['Restart Now', 'Later']
        }).then(({ response }) => {
            if (response === 0) {
                autoUpdater.quitAndInstall();
            }
        });
    });

    autoUpdater.checkForUpdates();
    setInterval(() => {
        autoUpdater.checkForUpdates();
    }, 2 * 60 * 60 * 1000);
}

// ------------------------------------------------------------
// APP SETUP
// ------------------------------------------------------------
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
    // mainWindow.webContents.openDevTools(); // uncomment for debugging
}

app.whenReady().then(() => {
    loadSettings();
    db = new Database(app.getPath('userData'));
    db.init();
    createWindow();
    setupAutoUpdater();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// ------------------------------------------------------------
// IPC HANDLERS
// ------------------------------------------------------------
ipcMain.handle('get-initial-data', () => {
    try {
        return {
            documents: db.getDocuments(1, 100),
            stats: db.getStats(),
            users: db.getUsers(),
            logs: db.getLogs(),
            settings: userSettings,
            rootStorage: ROOT_STORAGE
        };
    } catch (err) {
        console.error('get-initial-data error:', err);
        return {
            documents: [],
            stats: { totalDocs: 0, totalSize: 0 },
            users: [],
            logs: [],
            settings: userSettings,
            rootStorage: ROOT_STORAGE
        };
    }
});

ipcMain.handle('get-translations', (event, lang) => {
    const localePath = path.join(__dirname, 'locales', `${lang}.json`);
    if (fs.existsSync(localePath)) {
        try {
            const data = fs.readFileSync(localePath, 'utf8');
            return JSON.parse(data);
        } catch (err) {
            console.error('Failed to parse translations:', err);
            return {};
        }
    }
    return {};
});

ipcMain.handle('upload-files', async (event, filePaths) => {
    const results = [];
    const total = filePaths.length;

    for (let i = 0; i < total; i++) {
        const filePath = filePaths[i];
        try {
            if (!fs.existsSync(filePath)) {
                results.push({ filename: path.basename(filePath), status: 'error', message: 'File does not exist' });
                continue;
            }

            const filename = path.basename(filePath);
            const stats = fs.statSync(filePath);
            const ext = path.extname(filename).substring(1).toLowerCase();

            // Supported extensions
            const supportedExts = ['pdf', 'docx', 'doc', 'txt', 'csv', 'log', 'md', 'jpg', 'jpeg', 'png', 'tiff', 'bmp', 'gif'];
            if (!supportedExts.includes(ext) && ext !== '') {
                results.push({ filename, status: 'error', message: `Unsupported file type: .${ext}` });
                continue;
            }

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
                fileType: ext.toUpperCase() || 'UNKNOWN',
                size: stats.size,
                uploadDate: new Date().toISOString(),
                category: extractionResult.category || 'Uncategorized',
                pages: extractionResult.pages || [],
                fullText: extractionResult.fullText || ''
            };

            db.insertDocument(docRecord);
            db.logActivity('DOCUMENT_UPLOAD', `Ingested file: ${filename} (${stats.size} bytes)`, 'fa-solid fa-cloud-arrow-up', 'text-brand-400');
            results.push({ filename, status: 'success', document: docRecord });
            event.sender.send('upload-progress', { current: i + 1, total, filename });
        } catch (err) {
            console.error(`Error processing ${filePath}:`, err);
            results.push({ filename: path.basename(filePath), status: 'error', message: err.message || 'Processing failed' });
        }
    }
    return results;
});

ipcMain.handle('search-documents', (event, query, page = 1, limit = 25) => {
    try {
        return db.searchDocuments(query, page, limit);
    } catch (err) {
        console.error('Search error:', err);
        return [];
    }
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
            try { fs.unlinkSync(doc.filepath); } catch (e) { console.error('Failed to delete file:', e); }
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

// ------------------------------------------------------------
// WORKER
// ------------------------------------------------------------
function runExtractionWorker(filePath, ext, ocrEnabled) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'search-worker.js'), {
            workerData: { filePath, ext, ocrEnabled }
        });
        worker.on('message', (result) => {
            if (result.error) {
                reject(new Error(result.error));
            } else {
                resolve(result);
            }
        });
        worker.on('error', (err) => {
            reject(new Error(`Worker error: ${err.message}`));
        });
        worker.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`Worker stopped with exit code ${code}`));
            }
        });
    });
}