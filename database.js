const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class DocDatabase {
    constructor(userDataPath) {
        const dbDir = path.join(userDataPath, 'database');
        if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
        this.dbPath = path.join(dbDir, 'tridoc_enterprise.db');
        this.db = null;
    }

    init() {
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');

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
                fullText TEXT NOT NULL
            );
        `);

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

        const userCount = this.db.prepare('SELECT COUNT(*) as count FROM users').get().count;
        if (userCount === 0) {
            this.db.prepare(`
                INSERT INTO users (id, name, email, role, avatar, active, lastLogin)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run('usr_1', 'Zack Foster', 'zack.admin@hotel.com', 'System Admin', '10b981', 1, 'Just now');

            this.db.prepare(`
                INSERT INTO users (id, name, email, role, avatar, active, lastLogin)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run('usr_2', 'Sarah Jenkins', 's.jenkins@hotel.com', 'Manager', '3b82f6', 1, '2 hours ago');
        }
    }

    getDocuments(page = 1, limit = 100) {
        const offset = (page - 1) * limit;
        const rows = this.db.prepare('SELECT id, filename, filepath, fileType, size, uploadDate, category, pages FROM documents ORDER BY uploadDate DESC LIMIT ? OFFSET ?').all(limit, offset);
        return rows.map(r => ({ ...r, pages: JSON.parse(r.pages) }));
    }

    getDocumentById(id) {
        const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
        if (row) row.pages = JSON.parse(row.pages);
        return row;
    }

    getDocumentByNameAndSize(filename, size) {
        return this.db.prepare('SELECT id, filename FROM documents WHERE filename = ? AND size = ?').get(filename, size);
    }

    insertDocument(doc) {
        const stmt = this.db.prepare(`
            INSERT INTO documents (id, filename, filepath, fileType, size, uploadDate, category, pages, fullText)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(doc.id, doc.filename, doc.filepath, doc.fileType, doc.size, doc.uploadDate, doc.category, JSON.stringify(doc.pages), doc.fullText);
    }

    deleteDocument(id) {
        this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
    }

    clearAllDocuments() {
        this.db.exec('DELETE FROM documents;');
    }

    searchDocuments(query, page = 1, limit = 25) {
        const offset = (page - 1) * limit;
        const cleanQuery = query.trim().replace(/["']/g, '').replace(/\s+/g, ' ');
        const ftsQuery = cleanQuery.split(/\s+/).map(term => `"${term}"*`).join(' OR ');

        try {
            const stmt = this.db.prepare(`
                SELECT d.id, d.filename, d.filepath, d.fileType, d.size, d.uploadDate, d.category, d.pages,
                snippet(documents_fts, 3, '<mark>', '</mark>', '...', 32) as snippet
                FROM documents_fts
                JOIN documents d ON documents_fts.id = d.id
                WHERE documents_fts MATCH ?
                ORDER BY rank
                LIMIT ? OFFSET ?
            `);
            const rows = stmt.all(ftsQuery, limit, offset);
            return rows.map(r => ({ ...r, pages: JSON.parse(r.pages) }));
        } catch (err) {
            const stmt = this.db.prepare(`
                SELECT id, filename, filepath, fileType, size, uploadDate, category, pages, fullText
                FROM documents
                WHERE fullText LIKE ? OR filename LIKE ?
                LIMIT ? OFFSET ?
            `);
            const wildcard = `%${cleanQuery}%`;
            const rows = stmt.all(wildcard, wildcard, limit, offset);
            return rows.map(r => ({ ...r, pages: JSON.parse(r.pages), snippet: r.fullText.substring(0, 200) }));
        }
    }

    getStats() {
        const totalDocs = this.db.prepare('SELECT COUNT(*) as count FROM documents').get().count;
        const totalSize = this.db.prepare('SELECT SUM(size) as sum FROM documents').get().sum || 0;
        return { totalDocs, totalSize };
    }

    getUsers() {
        return this.db.prepare('SELECT * FROM users').all();
    }

    saveUser(u) {
        const existing = this.db.prepare('SELECT id FROM users WHERE id = ?').get(u.id);
        if (existing) {
            this.db.prepare('UPDATE users SET name = ?, email = ?, role = ? WHERE id = ?').run(u.name, u.email, u.role, u.id);
        } else {
            const id = 'usr_' + Math.random().toString(36).substring(2, 11);
            this.db.prepare(`
                INSERT INTO users (id, name, email, role, avatar, active, lastLogin)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(id, u.name, u.email, u.role, Math.floor(Math.random()*16777215).toString(16), 1, 'Just now');
        }
        return this.getUsers();
    }

    deleteUser(id) {
        this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }

    logActivity(action, details, icon, color) {
        const id = 'log_' + Math.random().toString(36).substring(2, 11);
        const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute:'2-digit', second:'2-digit' });
        const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        this.db.prepare(`
            INSERT INTO audit_logs (id, time, date, user, action, details, icon, color, ip)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, time, date, 'Zack Foster', action, details, icon, color, '127.0.0.1');
    }

    getLogs() {
        return this.db.prepare('SELECT * FROM audit_logs ORDER BY rowid DESC LIMIT 100').all();
    }
}

module.exports = DocDatabase;