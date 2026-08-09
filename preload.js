const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getInitialData: () => ipcRenderer.invoke('get-initial-data'),
    getTranslations: (lang) => ipcRenderer.invoke('get-translations', lang),
    uploadFiles: (filePaths) => ipcRenderer.invoke('upload-files', filePaths),
    searchDocuments: (query, page, limit) => ipcRenderer.invoke('search-documents', query, page, limit),
    openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
    deleteDocument: (id) => ipcRenderer.invoke('delete-document', id),
    saveUser: (userData) => ipcRenderer.invoke('save-user', userData),
    deleteUser: (userId) => ipcRenderer.invoke('delete-user', userId),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    clearCache: () => ipcRenderer.invoke('clear-cache'),
    onUploadProgress: (callback) => ipcRenderer.on('upload-progress', (event, data) => callback(data)),
    onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (event, data) => callback(data))
});