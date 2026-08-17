const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Data
    getInitialData: () => ipcRenderer.invoke('get-initial-data'),
    getTranslations: (lang) => ipcRenderer.invoke('get-translations', lang),
    getDocuments: (page, limit) => ipcRenderer.invoke('get-documents', page, limit),

    // Upload
    uploadFiles: (filePaths) => ipcRenderer.invoke('upload-files', filePaths),

    // Search
    searchDocuments: (query, page, limit) => ipcRenderer.invoke('search-documents', query, page, limit),

    // Files
    openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
    getFileBuffer: (filePath) => ipcRenderer.invoke('get-file-buffer', filePath),

    // Documents
    deleteDocument: (id) => ipcRenderer.invoke('delete-document', id),
    batchDeleteDocuments: (ids) => ipcRenderer.invoke('batch-delete-documents', ids),

    // Tags
    getTags: () => ipcRenderer.invoke('get-tags'),
    createTag: (name, color) => ipcRenderer.invoke('create-tag', name, color),
    deleteTag: (id) => ipcRenderer.invoke('delete-tag', id),
    updateDocumentTags: (docId, tags) => ipcRenderer.invoke('update-document-tags', docId, tags),

    // Search History
    getSearchHistory: () => ipcRenderer.invoke('get-search-history'),
    clearSearchHistory: () => ipcRenderer.invoke('clear-search-history'),

    // Users
    saveUser: (userData) => ipcRenderer.invoke('save-user', userData),
    deleteUser: (userId) => ipcRenderer.invoke('delete-user', userId),

    // Settings
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    clearCache: () => ipcRenderer.invoke('clear-cache'),

    // Backup
    backupDatabase: () => ipcRenderer.invoke('backup-database'),
    rebuildFTS: () => ipcRenderer.invoke('rebuild-fts'),

    // Events
    onUploadProgress: (callback) => ipcRenderer.on('upload-progress', (event, data) => callback(data)),
    onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (event, data) => callback(data))
});
