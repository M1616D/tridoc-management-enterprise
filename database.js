const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function generateId(prefix = '') {
    return prefix + crypto.randomUUID();
}

class DocDatabase {
    constructor(userDataPath) {
        this.userDataPath = userDataPath;
        const dbDir = path.join(userDataPath, 'database');
        if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
        this.dbPath = path.join(dbDir, 'tridoc_enterprise.db');
        this.db = null;
    }

    init() {
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');

        // Documents table with totalPages
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                filepath TEXT NOT NULL,
                fileType TEXT NOT NULL,
                size INTEGER NOT NULL,
                uploadDate TEXT NOT NULL,
                category TEXT NOT NULL,
                pages TEXT NOT NULL,
                fullText TEXT NOT NULL,
                totalPages INTEGER DEFAULT 1,
                tags TEXT DEFAULT '[]'
            );
        `);

        // Migrate: add totalPages column if missing
        try {
            this.db.exec(`ALTER TABLE documents ADD COLUMN totalPages INTEGER DEFAULT 1`);
        } catch (e) { /* column already exists */ }
        try {
            this.db.exec(`ALTER TABLE documents ADD COLUMN tags TEXT DEFAULT '[]'`);
        } catch (e) { /* column already exists */ }

        // FTS5 index
        this.db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
                id UNINDEXED,
                filename,
                category,
                fullText,
                content='documents',
                content_rowid='rowid'
            );
        `);

        // FTS triggers
        this.db.exec(`
            CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
                INSERT INTO documents_fts(rowid, id, filename, category, fullText)
                VALUES (new.rowid, new.id, new.filename, new.category, new.fullText);
            END;

            CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
                INSERT INTO documents_fts(documents_fts, rowid, id, filename, category, fullText)
                VALUES('delete', old.rowid, old.id, old.filename, old.category, old.fullText);
            END;
        `);

        // Users table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL,
                role TEXT NOT NULL,
                avatar TEXT NOT NULL,
                active INTEGER NOT NULL,
                lastLogin TEXT NOT NULL
            );
        `);

        // Audit logs
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id TEXT PRIMARY KEY,
                time TEXT NOT NULL,
                date TEXT NOT NULL,
                user TEXT NOT NULL,
                action TEXT NOT NULL,
                details TEXT NOT NULL,
                icon TEXT NOT NULL,
                color TEXT NOT NULL,
                ip TEXT NOT NULL
            );
        `);

        // Tags table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                color TEXT NOT NULL DEFAULT '#9eff2f'
            );
        `);

        // Search history
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS search_history (
                id TEXT PRIMARY KEY,
                query TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                resultCount INTEGER DEFAULT 0
            );
        `);

        // Seed default users if empty
        const userCount = this.db.prepare('SELECT COUNT(*) as count FROM users').get().count;
        if (userCount === 0) {
            this.db.prepare(`
                INSERT INTO users (id, name, email, role, avatar, active, lastLogin)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(generateId('usr_'), 'Zack Foster', 'zack.admin@hotel.com', 'System Admin', '10b981', 1, 'Just now');
            this.db.prepare(`
                INSERT INTO users (id, name, email, role, avatar, active, lastLogin)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(generateId('usr_'), 'Sarah Jenkins', 's.jenkins@hotel.com', 'Manager', '3b82f6', 1, '2 hours ago');
        }

        // Seed default tags if empty
        const tagCount = this.db.prepare('SELECT COUNT(*) as count FROM tags').get().count;
        if (tagCount === 0) {
            const defaultTags = [
                { name: 'Important', color: '#ef4444' },
                { name: 'Confidential', color: '#f59e0b' },
                { name: 'Archived', color: '#6b7280' },
                { name: 'Pending Review', color: '#3b82f6' },
                { name: 'Approved', color: '#22c55e' }
            ];
            for (const tag of defaultTags) {
                this.db.prepare('INSERT INTO tags (id, name, color) VALUES (?, ?, ?)').run(
                    generateId('tag_'), tag.name, tag.color
                );
            }
        }
    }

    // ─────────────────────────────────────────────
    // DOCUMENTS
    // ─────────────────────────────────────────────
    getDocuments(page = 1, limit = 25) {
        const offset = (page - 1) * limit;
        const rows = this.db.prepare(
            'SELECT id, filename, filepath, fileType, size, uploadDate, category, pages, totalPages, tags FROM documents ORDER BY uploadDate DESC LIMIT ? OFFSET ?'
        ).all(limit, offset);
        return rows.map(r => ({
            ...r,
            pages: JSON.parse(r.pages || '[]'),
            tags: JSON.parse(r.tags || '[]')
        }));
    }

    getDocumentsCount() {
        return this.db.prepare('SELECT COUNT(*) as count FROM documents').get().count;
    }

    getDocumentById(id) {
        const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
        if (row) {
            row.pages = JSON.parse(row.pages || '[]');
            row.tags = JSON.parse(row.tags || '[]');
        }
        return row;
    }

    getDocumentByNameAndSize(filename, size) {
        return this.db.prepare('SELECT id, filename FROM documents WHERE filename = ? AND size = ?').get(filename, size);
    }

    getDocumentByPath(filepath) {
        return this.db.prepare('SELECT id FROM documents WHERE filepath = ?').get(filepath);
    }

    insertDocument(doc) {
        this.db.prepare(`
            INSERT INTO documents (id, filename, filepath, fileType, size, uploadDate, category, pages, fullText, totalPages, tags)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            doc.id, doc.filename, doc.filepath, doc.fileType, doc.size,
            doc.uploadDate, doc.category, JSON.stringify(doc.pages),
            doc.fullText, doc.totalPages || 1, JSON.stringify(doc.tags || [])
        );
    }

    updateDocumentTags(id, tags) {
        this.db.prepare('UPDATE documents SET tags = ? WHERE id = ?').run(JSON.stringify(tags), id);
    }

    deleteDocument(id) {
        this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    }

    batchDeleteDocuments(ids) {
        const placeholders = ids.map(() => '?').join(',');
        this.db.prepare(`DELETE FROM documents WHERE id IN (${placeholders})`).run(...ids);
    }

    clearAllDocuments() {
        this.db.exec('DELETE FROM documents;');
    }

    // ─────────────────────────────────────────────
    // SEARCH
    // ─────────────────────────────────────────────
    searchDocuments(query, page = 1, limit = 25) {
        const offset = (page - 1) * limit;
        const cleanQuery = query.trim().replace(/["']/g, '').replace(/\s+/g, ' ');
        const ftsQuery = cleanQuery.split(/\s+/).map(term => `"${term}"*`).join(' OR ');

        try {
            const stmt = this.db.prepare(`
                SELECT d.id, d.filename, d.filepath, d.fileType, d.size, d.uploadDate, d.category, d.pages, d.totalPages, d.tags,
                snippet(documents_fts, 3, '<mark>', '</mark>', '...', 32) as snippet
                FROM documents_fts
                JOIN documents d ON documents_fts.id = d.id
                WHERE documents_fts MATCH ?
                ORDER BY rank
                LIMIT ? OFFSET ?
            `);
            const rows = stmt.all(ftsQuery, limit, offset);
            return rows.map(r => ({
                ...r,
                pages: JSON.parse(r.pages || '[]'),
                tags: JSON.parse(r.tags || '[]')
            }));
        } catch (err) {
            const stmt = this.db.prepare(`
                SELECT id, filename, filepath, fileType, size, uploadDate, category, pages, totalPages, tags, fullText
                FROM documents
                WHERE fullText LIKE ? OR filename LIKE ?
                LIMIT ? OFFSET ?
            `);
            const wildcard = `%${cleanQuery}%`;
            const rows = stmt.all(wildcard, wildcard, limit, offset);
            return rows.map(r => ({
                ...r,
                pages: JSON.parse(r.pages || '[]'),
                tags: JSON.parse(r.tags || '[]'),
                snippet: (r.fullText || '').substring(0, 200)
            }));
        }
    }

    // ─────────────────────────────────────────────
    // STATS — real analytics
    // ─────────────────────────────────────────────
    getStats() {
        const totalDocs = this.db.prepare('SELECT COUNT(*) as count FROM documents').get().count;
        const totalSize = this.db.prepare('SELECT COALESCE(SUM(size), 0) as sum FROM documents').get().sum;
        const totalPages = this.db.prepare('SELECT COALESCE(SUM(totalPages), 0) as sum FROM documents').get().sum;

        // Format distribution
        const formatDist = this.db.prepare(`
            SELECT fileType, COUNT(*) as count FROM documents GROUP BY fileType ORDER BY count DESC
        `).all();

        // Upload activity by day (last 7 days)
        const activityByDay = this.db.prepare(`
            SELECT date(uploadDate) as day, COUNT(*) as count
            FROM documents
            WHERE uploadDate >= date('now', '-7 days')
            GROUP BY date(uploadDate)
            ORDER BY day ASC
        `).all();

        // Upload activity by hour (last 24h)
        const activityByHour = this.db.prepare(`
            SELECT strftime('%H', uploadDate) as hour, COUNT(*) as count
            FROM documents
            WHERE uploadDate >= datetime('now', '-24 hours')
            GROUP BY strftime('%H', uploadDate)
            ORDER BY hour ASC
        `).all();

        // Category distribution
        const categoryDist = this.db.prepare(`
            SELECT category, COUNT(*) as count FROM documents GROUP BY category ORDER BY count DESC
        `).all();

        return {
            totalDocs,
            totalSize,
            totalPages,
            formatDist,
            activityByDay,
            activityByHour,
            categoryDist
        };
    }

    getStorageInfo(storagePath) {
        let totalSize = 0;
        let fileCount = 0;
        if (fs.existsSync(storagePath)) {
            const files = fs.readdirSync(storagePath);
            fileCount = files.length;
            for (const f of files) {
                try {
                    const stat = fs.statSync(path.join(storagePath, f));
                    if (stat.isFile()) totalSize += stat.size;
                } catch (e) { /* skip */ }
            }
        }
        // Get total disk space (approximate)
        let diskTotal = 0;
        let diskFree = 0;
        try {
            const stats = fs.statfsSync ? fs.statfsSync(storagePath) : null;
            if (stats) {
                diskTotal = stats.blocks * stats.bsize;
                diskFree = stats.bfree * stats.bsize;
            }
        } catch (e) {
            // Fallback: estimate from drive
            try { diskTotal = 500 * 1024 * 1024 * 1024; diskFree = 400 * 1024 * 1024 * 1024; } catch (e2) { /* */ }
        }
        return { totalSize, fileCount, diskTotal, diskFree };
    }

    // ─────────────────────────────────────────────
    // TAGS
    // ─────────────────────────────────────────────
    getTags() {
        return this.db.prepare('SELECT * FROM tags ORDER BY name').all();
    }

    createTag(name, color = '#9eff2f') {
        const id = generateId('tag_');
        this.db.prepare('INSERT INTO tags (id, name, color) VALUES (?, ?, ?)').run(id, name, color);
        return this.getTags();
    }

    deleteTag(id) {
        this.db.prepare('DELETE FROM tags WHERE id = ?').run(id);
        return this.getTags();
    }

    // ─────────────────────────────────────────────
    // SEARCH HISTORY
    // ─────────────────────────────────────────────
    logSearch(query, resultCount = 0) {
        // Don't log empty or duplicate consecutive queries
        if (!query || !query.trim()) return;
        const last = this.db.prepare('SELECT query FROM search_history ORDER BY rowid DESC LIMIT 1').get();
        if (last && last.query === query.trim()) return;

        this.db.prepare('INSERT INTO search_history (id, query, timestamp, resultCount) VALUES (?, ?, ?, ?)').run(
            generateId('srch_'),
            query.trim(),
            new Date().toISOString(),
            resultCount
        );
        // Keep only last 50 searches
        this.db.exec(`
            DELETE FROM search_history WHERE id NOT IN (
                SELECT id FROM search_history ORDER BY rowid DESC LIMIT 50
            )
        `);
    }

    getSearchHistory() {
        return this.db.prepare('SELECT * FROM search_history ORDER BY rowid DESC LIMIT 50').all();
    }

    clearSearchHistory() {
        this.db.exec('DELETE FROM search_history');
    }

    // ─────────────────────────────────────────────
    // USERS
    // ─────────────────────────────────────────────
    getUsers() {
        return this.db.prepare('SELECT * FROM users').all();
    }

    saveUser(u) {
        const existing = this.db.prepare('SELECT id FROM users WHERE id = ?').get(u.id);
        if (existing) {
            this.db.prepare('UPDATE users SET name = ?, email = ?, role = ? WHERE id = ?').run(u.name, u.email, u.role, u.id);
        } else {
            const id = generateId('usr_');
            this.db.prepare(`
                INSERT INTO users (id, name, email, role, avatar, active, lastLogin)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(id, u.name, u.email, u.role, Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'), 1, 'Just now');
        }
        return this.getUsers();
    }

    deleteUser(id) {
        this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }

    // ─────────────────────────────────────────────
    // AUDIT LOGS
    // ─────────────────────────────────────────────
    logActivity(action, details, icon, color, user = 'System') {
        const id = generateId('log_');
        const now = new Date();
        const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        const date = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        this.db.prepare(`
            INSERT INTO audit_logs (id, time, date, user, action, details, icon, color, ip)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, time, date, user, action, details, icon, color, '127.0.0.1');
    }

    getLogs() {
        return this.db.prepare('SELECT * FROM audit_logs ORDER BY rowid DESC LIMIT 200').all();
    }

    // ─────────────────────────────────────────────
    // BACKUP / RESTORE
    // ─────────────────────────────────────────────
    backupDatabase(backupPath) {
        // Use SQLite's backup API via VACUUM INTO
        this.db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
        return { success: true, path: backupPath };
    }

    getDatabasePath() {
        return this.dbPath;
    }

    // ─────────────────────────────────────────────
    // REBUILD FTS INDEX
    // ─────────────────────────────────────────────
    rebuildFTS() {
        this.db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('rebuild')`);
    }
}

module.exports = DocDatabase;
