// ============================================================
// TriDoc Enterprise — Renderer
// ============================================================

// --- i18n ---
let currentLanguage = 'en';
let translations = {};
let currentTheme = 'dark';

const LOCALE_MAP = { 'en': 'en-US', 'am': 'am-ET', 'om': 'om-ET' };

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
    if (STATE.currentView) UI.renderCurrentView();
}

function setTheme(theme) {
    currentTheme = theme;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    const checkbox = document.getElementById('theme-toggle-checkbox');
    if (checkbox) checkbox.checked = (theme === 'dark');
    const icon = document.getElementById('theme-icon');
    if (icon) icon.className = theme === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
}

// --- Helpers ---
const formatBytes = (bytes) => {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024, sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatDate = (dateStr) => {
    try {
        const locale = LOCALE_MAP[currentLanguage] || 'en-US';
        return new Date(dateStr).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) {
        return dateStr || '';
    }
};

// --- State ---
let STATE = {};

document.addEventListener('DOMContentLoaded', async () => {
    STATE = {
        documents: [],
        totalDocumentCount: 0,
        stats: { totalDocs: 0, totalSize: 0, totalPages: 0, formatDist: [], activityByDay: [], activityByHour: [], categoryDist: [] },
        storageInfo: { totalSize: 0, fileCount: 0, diskTotal: 0, diskFree: 0 },
        users: [],
        logs: [],
        tags: [],
        searchHistory: [],
        settings: {},
        rootStorage: '',
        currentView: 'dashboard',
        activityChart: null,
        formatChart: null,
        docPage: 1,
        docLimit: 25,
        selectedDocs: new Set()
    };

    try {
        const initial = await window.electronAPI.getInitialData();
        Object.assign(STATE, {
            documents: initial.documents || [],
            totalDocumentCount: initial.totalDocumentCount || 0,
            stats: initial.stats || STATE.stats,
            storageInfo: initial.storageInfo || STATE.storageInfo,
            users: initial.users || [],
            logs: initial.logs || [],
            tags: initial.tags || [],
            searchHistory: initial.searchHistory || [],
            settings: initial.settings || {},
            rootStorage: initial.rootStorage || ''
        });

        currentLanguage = STATE.settings.language || 'en';
        await loadTranslations(currentLanguage);
        document.getElementById('lang-select').value = currentLanguage;
        setTheme(STATE.settings.theme || 'dark');
        UI.init();
    } catch (err) {
        console.error('Init error:', err);
        UI.init();
    }
});

// ============================================================
// UI Object
// ============================================================
const UI = {
    init() {
        this.updateDashboardStats();
        this.renderDocumentsList();
        this.renderUsers();
        this.renderSecurityLogs();
        this.setupEventListeners();
        this.setupSettings();
        applyTranslations();
    },

    renderCurrentView() {
        const view = STATE.currentView;
        if (view === 'dashboard') this.updateDashboardStats();
        else if (view === 'documents') this.renderDocumentsList();
        else if (view === 'users') this.renderUsers();
        else if (view === 'security') this.renderSecurityLogs();
        else if (view === 'search') {
            const query = document.getElementById('deep-search-input');
            if (query && query.value) App.search(query.value);
        } else if (view === 'history') this.renderSearchHistory();
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
        this.renderCurrentView();
    },

    showToast(msg, type = 'success') {
        Swal.fire({
            toast: true, position: 'top-end', icon: type, title: msg,
            showConfirmButton: false, timer: 3000,
            background: '#2a2a2a', color: '#f8fafc'
        });
    },

    openUploadModal() { document.getElementById('upload-modal').classList.remove('hidden'); },
    closeUploadModal() { document.getElementById('upload-modal').classList.add('hidden'); },

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
    closeUserModal() { document.getElementById('user-modal').classList.add('hidden'); },

    // ─────────────────────────────────────────────
    // DASHBOARD — real data
    // ─────────────────────────────────────────────
    updateDashboardStats() {
        document.getElementById('kpi-total-docs').textContent = STATE.stats.totalDocs || 0;
        document.getElementById('kpi-total-storage').textContent = formatBytes(STATE.stats.totalSize || 0);
        document.getElementById('kpi-processed-pages').textContent = STATE.stats.totalPages || 0;

        // Real storage percentage
        const storageInfo = STATE.storageInfo;
        const usedPct = storageInfo.diskTotal > 0
            ? Math.min(100, ((storageInfo.diskTotal - storageInfo.diskFree) / storageInfo.diskTotal) * 100)
            : 0;
        document.getElementById('storage-used-label').textContent = formatBytes(STATE.storageInfo.totalSize || STATE.stats.totalSize || 0);
        document.getElementById('storage-progress-bar').style.width = `${usedPct.toFixed(1)}%`;
        document.getElementById('kpi-avg-latency').textContent = '< 10ms';

        this.renderCharts();
    },

    renderCharts() {
        // Activity chart — real data from last 7 days
        const ctxActivity = document.getElementById('activityChart');
        if (!ctxActivity) return;
        if (STATE.activityChart) STATE.activityChart.destroy();

        const dayLabels = [];
        const dayData = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dayStr = d.toISOString().slice(0, 10);
            dayLabels.push(d.toLocaleDateString(LOCALE_MAP[currentLanguage] || 'en-US', { weekday: 'short' }));
            const found = (STATE.stats.activityByDay || []).find(a => a.day === dayStr);
            dayData.push(found ? found.count : 0);
        }

        STATE.activityChart = new Chart(ctxActivity.getContext('2d'), {
            type: 'line',
            data: {
                labels: dayLabels,
                datasets: [{
                    label: 'Uploaded Files',
                    data: dayData,
                    borderColor: '#9eff2f',
                    backgroundColor: 'rgba(158, 255, 47, 0.1)',
                    fill: true, tension: 0.4, pointRadius: 4, pointBackgroundColor: '#9eff2f'
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { color: '#333' }, ticks: { color: '#9ca3af' } },
                    y: { grid: { color: '#333' }, ticks: { color: '#9ca3af', stepSize: 1 }, beginAtZero: true }
                }
            }
        });

        // Format distribution — real data
        const ctxFormat = document.getElementById('formatChart');
        if (!ctxFormat) return;
        if (STATE.formatChart) STATE.formatChart.destroy();

        const fmtDist = STATE.stats.formatDist || [];
        const fmtLabels = fmtDist.map(f => f.fileType || 'Unknown');
        const fmtData = fmtDist.map(f => f.count);
        const fmtColors = ['#9eff2f', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899'];

        STATE.formatChart = new Chart(ctxFormat.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: fmtLabels.length > 0 ? fmtLabels : ['No Data'],
                datasets: [{ data: fmtData.length > 0 ? fmtData : [1], backgroundColor: fmtColors.slice(0, fmtLabels.length || 1), borderWidth: 0 }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom', labels: { color: '#9ca3af', padding: 12 } } }
            }
        });
    },

    // ─────────────────────────────────────────────
    // DOCUMENTS — paginated, with batch select
    // ─────────────────────────────────────────────
    renderDocumentsList() {
        const tbody = document.getElementById('documents-table-body');
        if (!tbody) return;
        tbody.innerHTML = '';
        STATE.selectedDocs.clear();
        this.updateBatchBar();

        if (!STATE.documents || STATE.documents.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-12 text-center text-gray-400">${t('noDocuments')}</td></tr>`;
            document.getElementById('doc-count-badge').textContent = '0 files';
            this.renderDocPagination();
            return;
        }

        STATE.documents.forEach(doc => {
            const isUnreadable = doc.category === 'Unreadable PDF';
            const iconClass = isUnreadable ? 'fa-solid fa-triangle-exclamation text-yellow-400' : 'fa-solid fa-file-lines text-brand';
            const tags = (doc.tags || []).map(tagId => {
                const tag = STATE.tags.find(tg => tg.id === tagId);
                return tag ? `<span class="inline-block px-1.5 py-0.5 rounded text-xs font-medium mr-1" style="background:${tag.color}22;color:${tag.color};border:1px solid ${tag.color}44">${tag.name}</span>` : '';
            }).join('');

            tbody.innerHTML += `
                <tr class="hover:bg-dark-700/50 transition-colors duration-200" data-doc-id="${doc.id}">
                    <td class="px-3 py-3">
                        <input type="checkbox" class="doc-select rounded border-dark-600 text-brand focus:ring-brand bg-dark-900" data-id="${doc.id}" onchange="UI.toggleDocSelect('${doc.id}', this.checked)">
                    </td>
                    <td class="px-4 py-3 font-medium text-white flex items-center gap-3">
                        <i class="${iconClass}"></i>
                        <span class="cursor-pointer hover:text-brand transition" onclick="App.previewDocument('${doc.id}')">${doc.filename || 'Unknown'}</span>
                        ${isUnreadable ? '<span class="text-xs text-yellow-400 ml-1">(No text)</span>' : ''}
                    </td>
                    <td class="px-4 py-3"><span class="px-2.5 py-1 rounded-lg bg-dark-700 text-xs font-semibold text-gray-300">${doc.category || 'Uncategorized'}</span></td>
                    <td class="px-4 py-3 text-gray-400 text-sm">${tags || '<span class="text-gray-600 text-xs">—</span>'}</td>
                    <td class="px-4 py-3 text-gray-400 text-sm">${formatBytes(doc.size || 0)}</td>
                    <td class="px-4 py-3 text-gray-400 text-sm">${formatDate(doc.uploadDate || Date.now())}</td>
                    <td class="px-4 py-3 text-right">
                        <button onclick="UI.openOriginalFile('${(doc.filepath || '').replace(/\\/g, '\\\\')}')" class="p-2 bg-dark-700 hover:bg-dark-600 text-gray-300 hover:text-brand rounded-lg transition mr-1" title="Open"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
                        <button onclick="App.openTagModal('${doc.id}')" class="p-2 bg-dark-700 hover:bg-dark-600 text-gray-300 hover:text-purple-400 rounded-lg transition mr-1" title="Tags"><i class="fa-solid fa-tags"></i></button>
                        <button onclick="App.deleteDocument('${doc.id}')" class="p-2 bg-dark-700 hover:bg-red-900/30 text-gray-300 hover:text-red-400 rounded-lg transition" title="Delete"><i class="fa-solid fa-trash"></i></button>
                    </td>
                </tr>`;
        });

        document.getElementById('doc-count-badge').textContent = `${STATE.totalDocumentCount} total`;
        this.renderDocPagination();
    },

    renderDocPagination() {
        const container = document.getElementById('doc-pagination');
        if (!container) return;
        const totalPages = Math.max(1, Math.ceil(STATE.totalDocumentCount / STATE.docLimit));
        const current = STATE.docPage;

        let html = '<div class="flex items-center justify-between pt-4">';
        html += `<span class="text-xs text-gray-400">Page ${current} of ${totalPages} (${STATE.totalDocumentCount} docs)</span>`;
        html += '<div class="flex gap-1">';
        if (current > 1) html += `<button onclick="App.goToDocPage(${current - 1})" class="px-3 py-1.5 bg-dark-700 hover:bg-dark-600 text-gray-300 rounded-lg text-xs font-medium transition"><i class="fa-solid fa-chevron-left mr-1"></i>Prev</button>`;
        if (current < totalPages) html += `<button onclick="App.goToDocPage(${current + 1})" class="px-3 py-1.5 bg-dark-700 hover:bg-dark-600 text-gray-300 rounded-lg text-xs font-medium transition">Next<i class="fa-solid fa-chevron-right ml-1"></i></button>`;
        html += '</div></div>';
        container.innerHTML = html;
    },

    toggleDocSelect(id, checked) {
        if (checked) STATE.selectedDocs.add(id);
        else STATE.selectedDocs.delete(id);
        this.updateBatchBar();
    },

    toggleSelectAll(checked) {
        const checkboxes = document.querySelectorAll('.doc-select');
        checkboxes.forEach(cb => {
            cb.checked = checked;
            const id = cb.dataset.id;
            if (checked) STATE.selectedDocs.add(id);
            else STATE.selectedDocs.delete(id);
        });
        this.updateBatchBar();
    },

    updateBatchBar() {
        const bar = document.getElementById('batch-delete-bar');
        if (!bar) return;
        const count = STATE.selectedDocs.size;
        if (count > 0) {
            bar.classList.remove('hidden');
            document.getElementById('batch-delete-count').textContent = count;
        } else {
            bar.classList.add('hidden');
        }
    },

    // ─────────────────────────────────────────────
    // FILE PREVIEW
    // ─────────────────────────────────────────────
    async openPreview(docId) {
        const doc = STATE.documents.find(d => d.id === docId);
        if (!doc) return;

        const modal = document.getElementById('preview-modal');
        const content = document.getElementById('preview-content');
        const title = document.getElementById('preview-title');
        title.textContent = doc.filename;

        // Show text content first
        let html = '';
        const ext = (doc.fileType || '').toLowerCase();

        if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff'].includes(ext)) {
            // Image — try to load from file
            try {
                const fileData = await window.electronAPI.getFileBuffer(doc.filepath);
                if (fileData) {
                    html = `<img src="data:${fileData.mime};base64,${fileData.buffer}" class="max-w-full max-h-[70vh] rounded-lg mx-auto" alt="${doc.filename}">`;
                } else {
                    html = `<p class="text-gray-400">Image preview not available</p>`;
                }
            } catch (e) {
                html = `<p class="text-gray-400">Image preview not available</p>`;
            }
        } else if (ext === 'pdf') {
            // PDF — show first page text + link to open
            html = `<div class="bg-dark-900 rounded-xl p-4 border border-dark-700 max-h-[60vh] overflow-y-auto">`;
            if (doc.pages && doc.pages.length > 0) {
                doc.pages.slice(0, 5).forEach(p => {
                    html += `<div class="mb-4"><span class="text-xs text-gray-500 font-semibold">Page ${p.pageNumber}</span><pre class="text-sm text-gray-300 whitespace-pre-wrap mt-1">${escapeHtml(p.text || '(empty)')}</pre></div>`;
                });
                if (doc.pages.length > 5) html += `<p class="text-xs text-gray-500">... and ${doc.pages.length - 5} more pages</p>`;
            } else {
                html += `<p class="text-gray-400">No text content extracted from PDF</p>`;
            }
            html += `</div>`;
        } else {
            // Text-based
            html = `<div class="bg-dark-900 rounded-xl p-4 border border-dark-700 max-h-[60vh] overflow-y-auto"><pre class="text-sm text-gray-300 whitespace-pre-wrap">${escapeHtml((doc.pages && doc.pages[0] ? doc.pages[0].text : doc.fullText) || '(no content)')}</pre></div>`;
        }

        html += `<div class="flex justify-between items-center mt-4 pt-4 border-t border-dark-700">
            <span class="text-xs text-gray-500">${doc.fileType} • ${formatBytes(doc.size)} • ${formatDate(doc.uploadDate)}</span>
            <button onclick="UI.openOriginalFile('${(doc.filepath || '').replace(/\\/g, '\\\\')}')" class="px-4 py-2 bg-brand hover:bg-brand-hover text-dark-900 rounded-xl text-xs font-bold shadow-glow transition">${t('open')}</button>
        </div>`;

        content.innerHTML = html;
        modal.classList.remove('hidden');
    },

    closePreview() {
        document.getElementById('preview-modal').classList.add('hidden');
    },

    // ─────────────────────────────────────────────
    // TAG MODAL
    // ─────────────────────────────────────────────
    openTagModal(docId) {
        const doc = STATE.documents.find(d => d.id === docId);
        if (!doc) return;
        const modal = document.getElementById('tag-modal');
        document.getElementById('tag-modal-doc-id').value = docId;
        const container = document.getElementById('tag-checkboxes');
        container.innerHTML = '';
        STATE.tags.forEach(tag => {
            const checked = (doc.tags || []).includes(tag.id);
            container.innerHTML += `
                <label class="flex items-center gap-2 p-2 rounded-lg hover:bg-dark-700/50 cursor-pointer transition">
                    <input type="checkbox" value="${tag.id}" class="tag-checkbox rounded border-dark-600 bg-dark-900 text-brand focus:ring-brand" ${checked ? 'checked' : ''}>
                    <span class="w-3 h-3 rounded-full" style="background:${tag.color}"></span>
                    <span class="text-sm text-gray-300">${tag.name}</span>
                </label>`;
        });
        modal.classList.remove('hidden');
    },

    closeTagModal() { document.getElementById('tag-modal').classList.add('hidden'); },

    // ─────────────────────────────────────────────
    // SEARCH HISTORY
    // ─────────────────────────────────────────────
    renderSearchHistory() {
        const container = document.getElementById('search-history-list');
        if (!container) return;
        container.innerHTML = '';
        if (!STATE.searchHistory || STATE.searchHistory.length === 0) {
            container.innerHTML = `<p class="text-gray-500 text-center py-8">No search history</p>`;
            return;
        }
        STATE.searchHistory.forEach(s => {
            container.innerHTML += `
                <div class="flex items-center justify-between p-3 hover:bg-dark-700/50 rounded-xl cursor-pointer transition border-b border-dark-700/30" onclick="App.search('${s.query.replace(/'/g, "\\'")}')">
                    <div class="flex items-center gap-3">
                        <i class="fa-solid fa-clock-rotate-left text-gray-500 text-sm"></i>
                        <span class="text-sm text-gray-300">${escapeHtml(s.query)}</span>
                    </div>
                    <div class="flex items-center gap-3">
                        <span class="text-xs text-gray-500">${s.resultCount} results</span>
                        <span class="text-xs text-gray-600">${formatDate(s.timestamp)}</span>
                    </div>
                </div>`;
        });
    },

    // ─────────────────────────────────────────────
    // USERS
    // ─────────────────────────────────────────────
    renderUsers() {
        const tbody = document.getElementById('users-list-body');
        if (!tbody) return;
        tbody.innerHTML = '';
        STATE.users.forEach(user => {
            tbody.innerHTML += `
                <tr class="hover:bg-dark-700/50 transition-colors duration-200">
                    <td class="px-4 py-3 flex items-center gap-3">
                        <div class="w-9 h-9 rounded-lg bg-brand/20 text-brand flex items-center justify-center font-bold text-xs">${(user.name || '?').charAt(0).toUpperCase()}</div>
                        <div><div class="font-semibold text-white">${user.name}</div><div class="text-xs text-gray-400">${user.email}</div></div>
                    </td>
                    <td class="px-4 py-3"><span class="px-2.5 py-1 rounded border border-brand/30 text-brand bg-brand/10 text-xs font-semibold">${user.role}</span></td>
                    <td class="px-4 py-3 text-gray-400">${user.lastLogin}</td>
                    <td class="px-4 py-3 text-center"><span class="px-2 py-1 rounded-full text-xs font-semibold bg-green-500/20 text-green-400">${t('active')}</span></td>
                    <td class="px-4 py-3 text-right">
                        <button onclick="UI.openUserModal('${user.id}')" class="p-2 bg-dark-700 hover:bg-dark-600 text-gray-300 hover:text-white rounded-lg transition mr-1"><i class="fa-solid fa-pen"></i></button>
                        <button onclick="App.deleteUser('${user.id}')" class="p-2 bg-dark-700 hover:bg-red-900/30 text-gray-300 hover:text-red-400 rounded-lg transition"><i class="fa-solid fa-trash"></i></button>
                    </td>
                </tr>`;
        });
    },

    // ─────────────────────────────────────────────
    // SECURITY LOGS
    // ─────────────────────────────────────────────
    renderSecurityLogs() {
        const container = document.getElementById('security-logs-container');
        if (!container) return;
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
                        <p class="text-sm text-gray-400 mb-1">${escapeHtml(log.details)}</p>
                    </div>
                </div>`;
        });
    },

    // ─────────────────────────────────────────────
    // SEARCH RESULTS
    // ─────────────────────────────────────────────
    renderSearchResults(results, query) {
        const container = document.getElementById('search-results-container');
        container.innerHTML = '';
        if (!query || !query.trim() || !results || results.length === 0) {
            container.innerHTML = `<div class="p-12 text-center text-gray-400 bg-dark-800 rounded-2xl border border-dark-700">${t('noDocuments')}</div>`;
            return;
        }
        results.forEach(res => {
            const snippet = res.snippet || (res.fullText ? res.fullText.substring(0, 200) : 'No content');
            container.innerHTML += `
                <div class="bg-dark-800 border border-dark-700 p-6 rounded-2xl shadow-card hover:shadow-glow transition-shadow duration-200">
                    <div class="flex justify-between items-start">
                        <div class="flex items-center gap-3">
                            <div class="w-10 h-10 rounded-xl bg-brand/10 text-brand flex items-center justify-center font-bold"><i class="fa-solid fa-file-lines"></i></div>
                            <div>
                                <h4 class="font-bold text-white text-base cursor-pointer hover:text-brand transition" onclick="App.previewDocument('${res.id}')">${res.filename}</h4>
                                <div class="text-xs text-gray-400">${res.category} • ${formatBytes(res.size)} • ${formatDate(res.uploadDate)}</div>
                            </div>
                        </div>
                        <button onclick="UI.openOriginalFile('${(res.filepath || '').replace(/\\/g, '\\\\')}')" class="px-4 py-2 bg-brand hover:bg-brand-hover text-dark-900 rounded-xl text-xs font-bold shadow-glow transition">${t('open')}</button>
                    </div>
                    <p class="text-sm text-gray-300 font-mono bg-dark-900 p-3 rounded-xl border border-dark-700 mt-3">...${snippet}...</p>
                </div>`;
        });
    },

    // ─────────────────────────────────────────────
    // SETTINGS
    // ─────────────────────────────────────────────
    setupSettings() {
        const s = STATE.settings;
        document.getElementById('setting-fuzzy').checked = s.fuzzySearch !== false;
        document.getElementById('setting-autocommit').checked = s.autoIndex !== false;
        document.getElementById('setting-snippet-len').value = s.maxSnippetLen || 250;
        document.getElementById('setting-ocr').checked = s.ocrEnabled !== false;
        document.getElementById('lang-select').value = s.language || 'en';
        document.getElementById('theme-toggle-checkbox').checked = (s.theme === 'dark');

        // OCR language checkboxes
        const ocrLangs = s.ocrLanguages || ['en'];
        document.querySelectorAll('.ocr-lang-cb').forEach(cb => {
            cb.checked = ocrLangs.includes(cb.value);
        });

        document.getElementById('setting-storage-dir').value = STATE.rootStorage || '';
    },

    // ─────────────────────────────────────────────
    // EVENT LISTENERS
    // ─────────────────────────────────────────────
    setupEventListeners() {
        // Drag & drop
        const dropzone = document.getElementById('dropzone');
        if (dropzone) {
            dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('border-brand'); });
            dropzone.addEventListener('dragleave', () => dropzone.classList.remove('border-brand'));
            dropzone.addEventListener('drop', async (e) => {
                e.preventDefault();
                dropzone.classList.remove('border-brand');
                const paths = Array.from(e.dataTransfer.files).map(f => f.path);
                await App.handleFiles(paths);
            });
        }

        // Global search
        const globalSearch = document.getElementById('global-search-input');
        if (globalSearch) {
            let searchTimeout;
            globalSearch.addEventListener('input', (e) => {
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => App.search(e.target.value), 300);
            });
        }

        // Settings toggles
        ['setting-fuzzy', 'setting-autocommit', 'setting-ocr'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', App.saveSettings);
        });

        const settingSnippet = document.getElementById('setting-snippet-len');
        if (settingSnippet) settingSnippet.addEventListener('change', App.saveSettings);

        // OCR language checkboxes
        document.querySelectorAll('.ocr-lang-cb').forEach(cb => {
            cb.addEventListener('change', App.saveSettings);
        });

        // Theme toggle
        const themeToggle = document.getElementById('theme-toggle-checkbox');
        if (themeToggle) {
            themeToggle.addEventListener('change', (e) => {
                setTheme(e.target.checked ? 'dark' : 'light');
                App.saveSettings();
            });
        }

        // Language selector
        const langSelect = document.getElementById('lang-select');
        if (langSelect) {
            langSelect.addEventListener('change', async (e) => {
                await loadTranslations(e.target.value);
                App.saveSettings();
                UI.renderCurrentView();
            });
        }

        // Keyboard shortcut: Ctrl+K for search
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                UI.navigate('search');
                document.getElementById('deep-search-input')?.focus();
            }
        });

        // Upload progress
        window.electronAPI.onUploadProgress((data) => {
            UI.showToast(`Uploading ${data.filename} (${data.current}/${data.total})`, 'info');
        });
    }
};

// ============================================================
// APP Actions
// ============================================================
const App = {
    async refreshData() {
        const fresh = await window.electronAPI.getInitialData();
        Object.assign(STATE, {
            documents: fresh.documents || [],
            totalDocumentCount: fresh.totalDocumentCount || 0,
            stats: fresh.stats || STATE.stats,
            storageInfo: fresh.storageInfo || STATE.storageInfo,
            users: fresh.users || [],
            logs: fresh.logs || [],
            tags: fresh.tags || [],
            searchHistory: fresh.searchHistory || [],
        });
    },

    async handleFiles(filePaths) {
        if (!filePaths || filePaths.length === 0) {
            UI.showToast('No files selected.', 'warning');
            return;
        }
        UI.showToast('Processing files...', 'info');
        UI.closeUploadModal();
        try {
            const results = await window.electronAPI.uploadFiles(filePaths);
            await App.refreshData();
            UI.updateDashboardStats();
            UI.renderDocumentsList();

            const errors = results.filter(r => r.status === 'error');
            const successes = results.filter(r => r.status === 'success');
            const duplicates = results.filter(r => r.status === 'duplicate');

            if (errors.length > 0) {
                Swal.fire({
                    title: `${errors.length} file(s) failed`,
                    html: errors.map(e => `<div class="text-sm text-left"><b>${e.filename}</b>: ${e.message}</div>`).join(''),
                    icon: 'warning', background: '#2a2a2a', color: '#f8fafc', confirmButtonColor: '#9eff2f'
                });
            } else {
                let msg = `${successes.length} file(s) uploaded`;
                if (duplicates.length > 0) msg += `, ${duplicates.length} duplicate(s) skipped`;
                UI.showToast(msg + '!', 'success');
            }
        } catch (err) {
            UI.showToast('Upload failed: ' + err.message, 'error');
        }
    },

    async search(query) {
        if (!query || !query.trim()) return;
        if (STATE.currentView !== 'search') UI.navigate('search');
        const input = document.getElementById('deep-search-input');
        if (input) input.value = query;
        try {
            const results = await window.electronAPI.searchDocuments(query, 1, 50);
            UI.renderSearchResults(results || [], query);
            // Refresh search history
            STATE.searchHistory = await window.electronAPI.getSearchHistory();
        } catch (err) {
            UI.showToast('Search failed: ' + err.message, 'error');
        }
    },

    async previewDocument(docId) {
        await UI.openPreview(docId);
    },

    async goToDocPage(page) {
        STATE.docPage = page;
        try {
            const result = await window.electronAPI.getDocuments(page, STATE.docLimit);
            STATE.documents = result.documents || [];
            STATE.totalDocumentCount = result.totalCount || 0;
            UI.renderDocumentsList();
        } catch (err) {
            UI.showToast('Failed to load page', 'error');
        }
    },

    async deleteDocument(id) {
        if (!id) return;
        const confirmed = await Swal.fire({
            title: t('confirmDelete'), icon: 'warning',
            showCancelButton: true, confirmButtonColor: '#ef4444', cancelButtonColor: '#6b7280',
            background: '#2a2a2a', color: '#f8fafc'
        });
        if (!confirmed.isConfirmed) return;
        try {
            await window.electronAPI.deleteDocument(id);
            await App.refreshData();
            UI.updateDashboardStats();
            UI.renderDocumentsList();
            UI.showToast('Document deleted.', 'success');
        } catch (err) {
            UI.showToast('Delete failed: ' + err.message, 'error');
        }
    },

    async batchDelete() {
        const ids = Array.from(STATE.selectedDocs);
        if (ids.length === 0) return;
        const confirmed = await Swal.fire({
            title: `Delete ${ids.length} documents?`, text: 'This action cannot be undone.', icon: 'warning',
            showCancelButton: true, confirmButtonColor: '#ef4444', cancelButtonColor: '#6b7280',
            background: '#2a2a2a', color: '#f8fafc'
        });
        if (!confirmed.isConfirmed) return;
        try {
            await window.electronAPI.batchDeleteDocuments(ids);
            await App.refreshData();
            UI.updateDashboardStats();
            UI.renderDocumentsList();
            UI.showToast(`${ids.length} documents deleted.`, 'success');
        } catch (err) {
            UI.showToast('Batch delete failed: ' + err.message, 'error');
        }
    },

    async openTagModal(docId) {
        UI.openTagModal(docId);
    },

    async saveDocTags() {
        const docId = document.getElementById('tag-modal-doc-id').value;
        const checked = Array.from(document.querySelectorAll('.tag-checkbox:checked')).map(cb => cb.value);
        await window.electronAPI.updateDocumentTags(docId, checked);
        await App.refreshData();
        UI.renderDocumentsList();
        UI.closeTagModal();
        UI.showToast('Tags updated.', 'success');
    },

    async createNewTag() {
        const name = document.getElementById('new-tag-name').value.trim();
        const color = document.getElementById('new-tag-color').value;
        if (!name) return;
        STATE.tags = await window.electronAPI.createTag(name, color);
        document.getElementById('new-tag-name').value = '';
        UI.openTagModal(document.getElementById('tag-modal-doc-id').value);
        UI.showToast('Tag created.', 'success');
    },

    async clearSearchHistory() {
        await window.electronAPI.clearSearchHistory();
        STATE.searchHistory = [];
        UI.renderSearchHistory();
        UI.showToast('Search history cleared.', 'success');
    },

    async saveUser() {
        const id = document.getElementById('user-edit-id').value;
        const name = document.getElementById('user-form-name').value;
        const email = document.getElementById('user-form-email').value;
        const role = document.getElementById('user-form-role').value;
        if (!name || !email) { UI.showToast('Name and email are required.', 'warning'); return; }
        try {
            STATE.users = await window.electronAPI.saveUser({ id, name, email, role });
            UI.closeUserModal();
            UI.renderUsers();
            UI.showToast('User saved.', 'success');
        } catch (err) {
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
            UI.showToast('Delete user failed: ' + err.message, 'error');
        }
    },

    async saveSettings() {
        try {
            const ocrLangs = Array.from(document.querySelectorAll('.ocr-lang-cb:checked')).map(cb => cb.value);
            STATE.settings = await window.electronAPI.saveSettings({
                fuzzySearch: document.getElementById('setting-fuzzy').checked,
                autoIndex: document.getElementById('setting-autocommit').checked,
                ocrEnabled: document.getElementById('setting-ocr').checked,
                maxSnippetLen: parseInt(document.getElementById('setting-snippet-len').value) || 250,
                theme: currentTheme,
                language: currentLanguage,
                ocrLanguages: ocrLangs
            });
            UI.showToast('Settings saved.', 'success');
        } catch (err) {
            UI.showToast('Save settings failed: ' + err.message, 'error');
        }
    },

    async clearCache() {
        const confirmed = await Swal.fire({
            title: 'Purge All Documents?', text: 'This will permanently delete all indexed documents.',
            icon: 'warning', showCancelButton: true, confirmButtonColor: '#ef4444',
            background: '#2a2a2a', color: '#f8fafc'
        });
        if (!confirmed.isConfirmed) return;
        try {
            await window.electronAPI.clearCache();
            await App.refreshData();
            UI.updateDashboardStats();
            UI.renderDocumentsList();
            UI.showToast('Database purged.', 'success');
        } catch (err) {
            UI.showToast('Clear cache failed: ' + err.message, 'error');
        }
    },

    async backupDatabase() {
        try {
            const result = await window.electronAPI.backupDatabase();
            if (result && result.success) {
                UI.showToast('Database backed up successfully!', 'success');
            }
        } catch (err) {
            UI.showToast('Backup failed: ' + err.message, 'error');
        }
    }
};

// HTML escape utility
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

window.UI = UI;
window.App = App;
