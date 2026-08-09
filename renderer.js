// --- i18n ---
let currentLanguage = 'en';
let translations = {};
let currentTheme = 'dark';

async function loadTranslations(lang) {
    try {
        translations = await window.electronAPI.getTranslations(lang);
        currentLanguage = lang;
        applyTranslations();
    } catch (e) {
        console.warn('Failed to load translations', e);
        translations = {};
    }
}

function t(key) {
    return translations[key] || key;
}

function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = t(el.dataset.i18n);
    });
    const deepSearch = document.getElementById('deep-search-input');
    if (deepSearch) deepSearch.placeholder = t('searchPlaceholder');
    if (STATE.currentView) {
        UI.renderCurrentView();
    }
}

function setTheme(theme) {
    currentTheme = theme;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    const checkbox = document.getElementById('theme-toggle-checkbox');
    if (checkbox) checkbox.checked = (theme === 'dark');
    const icon = document.getElementById('theme-icon');
    if (icon) {
        icon.className = theme === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
    }
}

// --- State ---
document.addEventListener('DOMContentLoaded', async () => {
    window.STATE = {
        documents: [],
        stats: { totalDocs: 0, totalSize: 0 },
        users: [],
        logs: [],
        settings: {},
        rootStorage: '',
        currentView: 'dashboard',
        activityChart: null,
        formatChart: null
    };

    const initial = await window.electronAPI.getInitialData();
    STATE.documents = initial.documents || [];
    STATE.stats = initial.stats || { totalDocs: 0, totalSize: 0 };
    STATE.users = initial.users || [];
    STATE.logs = initial.logs || [];
    STATE.settings = initial.settings || {};
    STATE.rootStorage = initial.rootStorage || '';

    currentLanguage = initial.settings.language || 'en';
    await loadTranslations(currentLanguage);
    document.getElementById('lang-select').value = currentLanguage;
    setTheme(initial.settings.theme || 'dark');

    UI.init();
});

const formatBytes = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024, sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatDate = (dateStr) => new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

const UI = {
    init() {
        this.updateDashboardStats();
        this.renderDocumentsList();
        this.renderUsers();
        this.renderSecurityLogs();
        this.setupEventListeners();
        this.setupSettings();
        document.getElementById('sidebar-user-name').textContent = 'Zack Foster';
        document.getElementById('sidebar-user-role').textContent = 'System Admin';
        document.getElementById('sidebar-user-avatar').src = 'https://ui-avatars.com/api/?name=Zack+Foster&background=9eff2f&color=1e1e1e';
        window.electronAPI.onUploadProgress((data) => {
            UI.showToast(`Uploading ${data.filename} (${data.current}/${data.total})`, 'info');
        });
        applyTranslations();
    },
    renderCurrentView() {
        const view = STATE.currentView;
        if (view === 'dashboard') this.updateDashboardStats();
        else if (view === 'documents') this.renderDocumentsList();
        else if (view === 'users') this.renderUsers();
        else if (view === 'security') this.renderSecurityLogs();
        else if (view === 'search') {
            const query = document.getElementById('deep-search-input').value;
            if (query) App.search(query);
        }
    },
    navigate(viewId) {
        STATE.currentView = viewId;
        document.querySelectorAll('.nav-item').forEach(el => {
            el.classList.remove('bg-brand/20', 'text-brand', 'font-semibold', 'nav-item-glow');
            el.classList.add('text-gray-400', 'hover:text-white', 'hover:bg-dark-700');
        });
        const activeNav = document.getElementById(`nav-${viewId}`);
        if (activeNav) {
            activeNav.classList.add('bg-brand/20', 'text-brand', 'font-semibold', 'nav-item-glow');
            activeNav.classList.remove('text-gray-400', 'hover:text-white', 'hover:bg-dark-700');
        }

        document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));
        const activeView = document.getElementById(`view-${viewId}`);
        if (activeView) activeView.classList.remove('hidden');

        if (viewId === 'dashboard') this.updateDashboardStats();
        if (viewId === 'documents') this.renderDocumentsList();
        if (viewId === 'users') this.renderUsers();
        if (viewId === 'security') this.renderSecurityLogs();
    },
    toggleMobileSidebar() {
        document.getElementById('sidebar').classList.toggle('hidden');
    },
    showToast(msg, type = 'success') {
        Swal.fire({
            toast: true,
            position: 'top-end',
            icon: type,
            title: msg,
            showConfirmButton: false,
            timer: 3000,
            background: '#2a2a2a',
            color: '#f8fafc'
        });
    },
    openUploadModal() {
        document.getElementById('upload-modal').classList.remove('hidden');
    },
    closeUploadModal() {
        document.getElementById('upload-modal').classList.add('hidden');
    },
    openUserModal(userId = null) {
        document.getElementById('user-edit-id').value = '';
        document.getElementById('user-form-name').value = '';
        document.getElementById('user-form-email').value = '';
        document.getElementById('user-form-role').value = 'Staff User';
        document.getElementById('user-modal-title').textContent = t('addUser');

        if (userId) {
            const u = STATE.users.find(x => x.id === userId);
            if (u) {
                document.getElementById('user-edit-id').value = u.id;
                document.getElementById('user-form-name').value = u.name;
                document.getElementById('user-form-email').value = u.email;
                document.getElementById('user-form-role').value = u.role;
                document.getElementById('user-modal-title').textContent = t('editUser');
            }
        }
        document.getElementById('user-modal').classList.remove('hidden');
    },
    closeUserModal() {
        document.getElementById('user-modal').classList.add('hidden');
    },
    async openOriginalFile(filePath) {
        await window.electronAPI.openFile(filePath);
    },

    // --- DASHBOARD ---
    updateDashboardStats() {
        document.getElementById('kpi-total-docs').textContent = STATE.stats.totalDocs || 0;
        document.getElementById('kpi-total-storage').textContent = formatBytes(STATE.stats.totalSize || 0);
        document.getElementById('kpi-processed-pages').textContent = (STATE.stats.totalDocs || 0) * 3;
        document.getElementById('storage-used-label').textContent = formatBytes(STATE.stats.totalSize || 0);
        document.getElementById('storage-progress-bar').style.width = '15%';
        this.renderCharts();
    },
    renderCharts() {
        const ctxActivity = document.getElementById('activityChart').getContext('2d');
        if (STATE.activityChart) STATE.activityChart.destroy();
        STATE.activityChart = new Chart(ctxActivity, {
            type: 'line',
            data: {
                labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
                datasets: [{
                    label: 'Indexed Files',
                    data: [12, 19, 15, 25, 32, 28, (STATE.stats.totalDocs || 0) + 10],
                    borderColor: '#9eff2f',
                    backgroundColor: 'rgba(158, 255, 47, 0.1)',
                    fill: true,
                    tension: 0.4
                }]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { color: '#333' } }, y: { grid: { color: '#333' } } } }
        });

        const ctxFormat = document.getElementById('formatChart').getContext('2d');
        if (STATE.formatChart) STATE.formatChart.destroy();
        STATE.formatChart = new Chart(ctxFormat, {
            type: 'doughnut',
            data: {
                labels: ['PDF', 'DOCX', 'TXT/Images'],
                datasets: [{
                    data: [Math.max(STATE.stats.totalDocs || 0, 1), 2, 1],
                    backgroundColor: ['#9eff2f', '#3b82f6', '#8b5cf6'],
                    borderWidth: 0
                }]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: '#9ca3af' } } } }
        });
    },

    // --- DOCUMENTS LIST ---
    renderDocumentsList() {
        const tbody = document.getElementById('documents-table-body');
        if (!tbody) return;
        tbody.innerHTML = '';
        if (!STATE.documents || STATE.documents.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-12 text-center text-gray-400">${t('noDocuments')}</td></tr>`;
            return;
        }
        STATE.documents.forEach(doc => {
            tbody.innerHTML += `
                <tr class="hover:bg-dark-700/50 transition-colors duration-200">
                    <td class="px-4 py-3 font-medium text-white flex items-center gap-3">
                        <i class="fa-solid fa-file-lines text-brand"></i> ${doc.filename || 'Unknown'}
                    </td>
                    <td class="px-4 py-3"><span class="px-2.5 py-1 rounded-lg bg-dark-700 text-xs font-semibold text-gray-300">${doc.category || 'Uncategorized'}</span></td>
                    <td class="px-4 py-3 text-gray-400">${formatBytes(doc.size || 0)}</td>
                    <td class="px-4 py-3 text-gray-400">${formatDate(doc.uploadDate || Date.now())}</td>
                    <td class="px-4 py-3 text-right">
                        <button onclick="UI.openOriginalFile('${(doc.filepath || '').replace(/\\/g, '\\\\')}')" class="p-2 bg-dark-700 hover:bg-dark-600 text-gray-300 hover:text-brand rounded-lg transition mr-1" title="Open"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
                        <button onclick="App.deleteDocument('${doc.id}')" class="p-2 bg-dark-700 hover:bg-red-900/30 text-gray-300 hover:text-red-400 rounded-lg transition" title="Delete"><i class="fa-solid fa-trash"></i></button>
                    </td>
                </tr>
            `;
        });
        document.getElementById('doc-count-badge').textContent = STATE.documents.length;
    },

    // --- USERS ---
    renderUsers() {
        const tbody = document.getElementById('users-list-body');
        tbody.innerHTML = '';
        STATE.users.forEach(user => {
            tbody.innerHTML += `
                <tr class="hover:bg-dark-700/50 transition-colors duration-200">
                    <td class="px-4 py-3 flex items-center gap-3">
                        <div class="w-9 h-9 rounded-lg bg-brand/20 text-brand flex items-center justify-center font-bold text-xs">${user.name.charAt(0)}</div>
                        <div><div class="font-semibold text-white">${user.name}</div><div class="text-xs text-gray-400">${user.email}</div></div>
                    </td>
                    <td class="px-4 py-3"><span class="px-2.5 py-1 rounded border border-brand/30 text-brand bg-brand/10 text-xs font-semibold">${user.role}</span></td>
                    <td class="px-4 py-3 text-gray-400">${user.lastLogin}</td>
                    <td class="px-4 py-3 text-center"><span class="px-2 py-1 rounded-full text-xs font-semibold bg-green-500/20 text-green-400">${t('active')}</span></td>
                    <td class="px-4 py-3 text-right">
                        <button onclick="UI.openUserModal('${user.id}')" class="p-2 bg-dark-700 hover:bg-dark-600 text-gray-300 hover:text-white rounded-lg transition mr-1"><i class="fa-solid fa-pen"></i></button>
                        <button onclick="App.deleteUser('${user.id}')" class="p-2 bg-dark-700 hover:bg-red-900/30 text-gray-300 hover:text-red-400 rounded-lg transition"><i class="fa-solid fa-trash"></i></button>
                    </td>
                </tr>
            `;
        });
    },

    // --- SECURITY LOGS ---
    renderSecurityLogs() {
        const container = document.getElementById('security-logs-container');
        container.innerHTML = '';
        document.getElementById('audit-count-label').textContent = `${STATE.logs.length} Events Logged`;
        STATE.logs.forEach(log => {
            container.innerHTML += `
                <div class="flex items-start gap-4 p-4 hover:bg-dark-700/30 rounded-xl transition-colors border-b border-dark-700/50">
                    <div class="mt-1 w-8 h-8 rounded-full bg-dark-700 flex items-center justify-center shrink-0">
                        <i class="${log.icon} ${log.color} text-sm"></i>
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="flex justify-between items-start mb-1">
                            <h4 class="text-sm font-bold text-white">${log.action}</h4>
                            <span class="text-xs text-gray-500">${log.date} • ${log.time}</span>
                        </div>
                        <p class="text-sm text-gray-400 mb-1">${log.details}</p>
                    </div>
                </div>
            `;
        });
    },

    // --- SEARCH ---
    renderSearchResults(results, query) {
        const container = document.getElementById('search-results-container');
        container.innerHTML = '';
        if (!query.trim() || !results || results.length === 0) {
            container.innerHTML = `<div class="p-12 text-center text-gray-400 bg-dark-800 rounded-2xl border border-dark-700">${t('noDocuments')}</div>`;
            return;
        }
        results.forEach(res => {
            container.innerHTML += `
                <div class="bg-dark-800 border border-dark-700 p-6 rounded-2xl shadow-card hover:shadow-glow transition-shadow duration-200">
                    <div class="flex justify-between items-start">
                        <div class="flex items-center gap-3">
                            <div class="w-10 h-10 rounded-xl bg-brand/10 text-brand flex items-center justify-center font-bold"><i class="fa-solid fa-file-lines"></i></div>
                            <div>
                                <h4 class="font-bold text-white text-base">${res.filename}</h4>
                                <div class="text-xs text-gray-400">Category: <span class="text-brand">${res.category}</span> • Size: ${formatBytes(res.size)}</div>
                            </div>
                        </div>
                        <button onclick="UI.openOriginalFile('${res.filepath.replace(/\\/g, '\\\\')}')" class="px-4 py-2 bg-brand hover:bg-brand-hover text-dark-900 rounded-xl text-xs font-bold shadow-glow transition">${t('open') || 'Open'}</button>
                    </div>
                    <p class="text-sm text-gray-300 font-mono bg-dark-900 p-3 rounded-xl border border-dark-700 mt-3">...${res.snippet || (res.fullText ? res.fullText.substring(0, 200) : 'No content')}...</p>
                </div>
            `;
        });
    },

    // --- SETTINGS ---
    setupSettings() {
        const settings = STATE.settings;
        document.getElementById('setting-fuzzy').checked = settings.fuzzySearch !== false;
        document.getElementById('setting-autocommit').checked = settings.autoIndex !== false;
        document.getElementById('setting-snippet-len').value = settings.maxSnippetLen || 250;
        document.getElementById('setting-ocr').checked = settings.ocrEnabled !== false;
        document.getElementById('lang-select').value = settings.language || 'en';
        document.getElementById('theme-toggle-checkbox').checked = (settings.theme === 'dark');
        document.getElementById('setting-storage-limit').value = STATE.rootStorage || 'C:\\Users\\HP\\Documents\\TriDoc_Storage';
        const icon = document.getElementById('theme-icon');
        if (icon) {
            icon.className = settings.theme === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
        }
    },

    // --- EVENT LISTENERS ---
    setupEventListeners() {
        const dropzone = document.getElementById('dropzone');
        if (dropzone) {
            dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('border-brand'); });
            dropzone.addEventListener('dragleave', () => { dropzone.classList.remove('border-brand'); });
            dropzone.addEventListener('drop', async (e) => {
                e.preventDefault();
                dropzone.classList.remove('border-brand');
                const paths = Array.from(e.dataTransfer.files).map(f => f.path);
                await App.handleFiles(paths);
            });
        }

        const globalSearch = document.getElementById('global-search-input');
        if (globalSearch) {
            globalSearch.addEventListener('input', (e) => {
                App.search(e.target.value);
            });
        }

        const settingFuzzy = document.getElementById('setting-fuzzy');
        if (settingFuzzy) settingFuzzy.addEventListener('change', App.saveSettings);
        const settingAutocommit = document.getElementById('setting-autocommit');
        if (settingAutocommit) settingAutocommit.addEventListener('change', App.saveSettings);
        const settingOcr = document.getElementById('setting-ocr');
        if (settingOcr) settingOcr.addEventListener('change', App.saveSettings);
        const settingSnippet = document.getElementById('setting-snippet-len');
        if (settingSnippet) settingSnippet.addEventListener('change', App.saveSettings);

        const themeToggle = document.getElementById('theme-toggle-checkbox');
        if (themeToggle) {
            themeToggle.addEventListener('change', (e) => {
                const theme = e.target.checked ? 'dark' : 'light';
                setTheme(theme);
                App.saveSettings();
            });
        }

        const langSelect = document.getElementById('lang-select');
        if (langSelect) {
            langSelect.addEventListener('change', async (e) => {
                const lang = e.target.value;
                await loadTranslations(lang);
                currentLanguage = lang;
                App.saveSettings();
                UI.renderCurrentView();
            });
        }
    }
};

// --- App actions ---
const App = {
    async handleFiles(filePaths) {
        if (!filePaths || filePaths.length === 0) {
            UI.showToast('No files selected.', 'warning');
            return;
        }
        UI.showToast('Processing files...', 'info');
        UI.closeUploadModal();

        try {
            const results = await window.electronAPI.uploadFiles(filePaths);

            // Refresh data from backend
            const fresh = await window.electronAPI.getInitialData();
            STATE.documents = fresh.documents || [];
            STATE.stats = fresh.stats || { totalDocs: 0, totalSize: 0 };
            STATE.logs = fresh.logs || [];

            // Update all UI components
            UI.updateDashboardStats();
            UI.renderDocumentsList();

            // Check for errors and show detailed messages
            const errors = results.filter(r => r.status === 'error');
            if (errors.length > 0) {
                // Build a detailed message
                const errorMsg = errors.map(e => `${e.filename}: ${e.message}`).join('\n');
                console.error('Upload errors:', errors);
                // Show a more detailed alert
                Swal.fire({
                    title: `${errors.length} file(s) failed to upload`,
                    text: errorMsg,
                    icon: 'warning',
                    background: '#2a2a2a',
                    color: '#f8fafc',
                    confirmButtonColor: '#9eff2f'
                });
                UI.showToast(`${results.length - errors.length} file(s) uploaded, ${errors.length} failed.`, 'warning');
            } else {
                const duplicates = results.filter(r => r.status === 'duplicate');
                if (duplicates.length > 0) {
                    UI.showToast(`${results.length - duplicates.length} file(s) uploaded, ${duplicates.length} duplicate(s) skipped.`, 'info');
                } else {
                    UI.showToast(`${results.length} file(s) uploaded and indexed successfully!`, 'success');
                }
            }
        } catch (err) {
            console.error('Upload failed:', err);
            UI.showToast('Upload failed: ' + err.message, 'error');
        }
    },
    async search(query) {
        if (!query || !query.trim()) return;
        if (STATE.currentView !== 'search') UI.navigate('search');
        document.getElementById('deep-search-input').value = query;
        try {
            const results = await window.electronAPI.searchDocuments(query, 1, 25);
            UI.renderSearchResults(results || [], query);
        } catch (err) {
            console.error('Search failed:', err);
            UI.showToast('Search failed: ' + err.message, 'error');
        }
    },
    async deleteDocument(id) {
        if (!id) return;
        try {
            await window.electronAPI.deleteDocument(id);
            const fresh = await window.electronAPI.getInitialData();
            STATE.documents = fresh.documents || [];
            STATE.stats = fresh.stats || { totalDocs: 0, totalSize: 0 };
            UI.updateDashboardStats();
            UI.renderDocumentsList();
            UI.showToast('Document deleted.', 'success');
        } catch (err) {
            console.error('Delete failed:', err);
            UI.showToast('Delete failed: ' + err.message, 'error');
        }
    },
    async saveUser() {
        const id = document.getElementById('user-edit-id').value;
        const name = document.getElementById('user-form-name').value;
        const email = document.getElementById('user-form-email').value;
        const role = document.getElementById('user-form-role').value;
        if (!name || !email) {
            UI.showToast('Name and email are required.', 'warning');
            return;
        }
        try {
            STATE.users = await window.electronAPI.saveUser({ id, name, email, role });
            UI.closeUserModal();
            UI.renderUsers();
            UI.showToast('User saved.', 'success');
        } catch (err) {
            console.error('Save user failed:', err);
            UI.showToast('Save user failed: ' + err.message, 'error');
        }
    },
    async deleteUser(userId) {
        if (!userId) return;
        try {
            STATE.users = await window.electronAPI.deleteUser(userId);
            UI.renderUsers();
            UI.showToast('User deleted.', 'success');
        } catch (err) {
            console.error('Delete user failed:', err);
            UI.showToast('Delete user failed: ' + err.message, 'error');
        }
    },
    async saveSettings() {
        try {
            const fuzzySearch = document.getElementById('setting-fuzzy').checked;
            const autoIndex = document.getElementById('setting-autocommit').checked;
            const ocrEnabled = document.getElementById('setting-ocr').checked;
            const maxSnippetLen = parseInt(document.getElementById('setting-snippet-len').value) || 250;
            const theme = currentTheme;
            const language = currentLanguage;
            STATE.settings = await window.electronAPI.saveSettings({
                fuzzySearch,
                autoIndex,
                ocrEnabled,
                maxSnippetLen,
                theme,
                language
            });
            UI.showToast('Settings saved.', 'success');
        } catch (err) {
            console.error('Save settings failed:', err);
            UI.showToast('Save settings failed: ' + err.message, 'error');
        }
    },
    async clearCache() {
        try {
            await window.electronAPI.clearCache();
            const fresh = await window.electronAPI.getInitialData();
            STATE.documents = fresh.documents || [];
            STATE.stats = fresh.stats || { totalDocs: 0, totalSize: 0 };
            UI.updateDashboardStats();
            UI.renderDocumentsList();
            UI.showToast('Database cleared.', 'success');
        } catch (err) {
            console.error('Clear cache failed:', err);
            UI.showToast('Clear cache failed: ' + err.message, 'error');
        }
    },
    toggleTheme() {
        const checkbox = document.getElementById('theme-toggle-checkbox');
        const theme = checkbox.checked ? 'dark' : 'light';
        setTheme(theme);
        App.saveSettings();
    },
    async changeLanguage(lang) {
        await loadTranslations(lang);
        currentLanguage = lang;
        applyTranslations();
        App.saveSettings();
    }
};

window.UI = UI;
window.App = App;