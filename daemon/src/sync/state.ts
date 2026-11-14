// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * What every synced item looked like on both sides after it was last synced.
 * Comparing the current local and remote state with this "base" tells which
 * side changed. Stored in SQLite so sync resumes after a restart.
 */
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type EntryType = 'file' | 'folder';

export type BaseEntry = {
    /** Path relative to the sync root, e.g. "/Documents/a.pdf". */
    path: string;
    type: EntryType;
    /** Local size and modification time (ms) after the last sync; files only. */
    localSize: number | null;
    localMtime: number | null;
    remoteUid: string;
    /** Active revision UID; files only. */
    remoteRevision: string | null;
    remoteSha1: string | null;
    /** Inode and birth time (ms) of the local item, to recognise it after a rename or move; null when not recorded yet. */
    localIno?: number | null;
    localBtime?: number | null;
};

type Row = {
    path: string;
    type: EntryType;
    local_size: number | null;
    local_mtime: number | null;
    remote_uid: string;
    remote_revision: string | null;
    remote_sha1: string | null;
    local_ino: number | null;
    local_btime: number | null;
};

export function parentOf(path: string): string {
    const index = path.lastIndexOf('/');
    return index <= 0 ? '/' : path.slice(0, index);
}

export function nameOf(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

export function childPath(parent: string, name: string): string {
    return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

export class SyncState {
    private readonly db: Database;

    constructor(file: string) {
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        this.db = new Database(file, { create: true });
        // Deleted rows are overwritten, so signing out leaves no paths in the file.
        this.db.run('PRAGMA secure_delete = ON');
        this.db.run('PRAGMA journal_mode = WAL');
        this.db.run('PRAGMA synchronous = NORMAL');
        this.db.run(`CREATE TABLE IF NOT EXISTS entries (
            path TEXT PRIMARY KEY,
            parent TEXT NOT NULL,
            type TEXT NOT NULL,
            local_size INTEGER,
            local_mtime REAL,
            remote_uid TEXT NOT NULL,
            remote_revision TEXT,
            remote_sha1 TEXT
        )`);
        const columns = new Set(
            this.db
                .query<{ name: string }, []>('PRAGMA table_info(entries)')
                .all()
                .map((column) => column.name),
        );
        if (!columns.has('local_ino')) {
            this.db.run('ALTER TABLE entries ADD COLUMN local_ino INTEGER');
        }
        if (!columns.has('local_btime')) {
            this.db.run('ALTER TABLE entries ADD COLUMN local_btime REAL');
        }
        this.db.run('CREATE INDEX IF NOT EXISTS entries_local_ino ON entries (local_ino)');
        this.db.run('CREATE INDEX IF NOT EXISTS entries_parent ON entries (parent)');
        this.db.run('CREATE INDEX IF NOT EXISTS entries_remote_uid ON entries (remote_uid)');
        this.db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        // Folders with remote changes not yet synced; survives restarts.
        this.db.run('CREATE TABLE IF NOT EXISTS pending (path TEXT PRIMARY KEY)');
        // The WAL files exist from here on. SQLite gives new files the umask's mode.
        for (const name of [file, `${file}-wal`, `${file}-shm`]) {
            try {
                chmodSync(name, 0o600);
            } catch {}
        }
    }

    get(path: string): BaseEntry | undefined {
        const row = this.db.query<Row, [string]>('SELECT * FROM entries WHERE path = ?').get(path);
        return row ? fromRow(row) : undefined;
    }

    children(parent: string): Map<string, BaseEntry> {
        const rows = this.db.query<Row, [string]>('SELECT * FROM entries WHERE parent = ?').all(parent);
        return new Map(rows.map((row) => [nameOf(row.path), fromRow(row)]));
    }

    byRemoteUid(uid: string): BaseEntry | undefined {
        const row = this.db.query<Row, [string]>('SELECT * FROM entries WHERE remote_uid = ?').get(uid);
        return row ? fromRow(row) : undefined;
    }

    /** Synced items with this inode: normally one, more with hard links or after an inode was reused. */
    byLocalIno(ino: number): BaseEntry[] {
        return this.db.query<Row, [number]>('SELECT * FROM entries WHERE local_ino = ?').all(ino).map(fromRow);
    }

    setLocalIdentity(path: string, ino: number, btime: number): void {
        this.db.query('UPDATE entries SET local_ino = ?, local_btime = ? WHERE path = ?').run(ino, btime, path);
    }

    /** Moves an entry and everything below it to another path, replacing whatever was recorded there. */
    moveTree(from: string, to: string): void {
        const prefix = `${from}/`;
        this.db.transaction(() => {
            this.removeTree(to);
            const rows = this.db
                .query<{ path: string }, [string, string, string]>(
                    'SELECT path FROM entries WHERE path = ? OR substr(path, 1, length(?)) = ?',
                )
                .all(from, prefix, prefix);
            const update = this.db.query('UPDATE entries SET path = ?, parent = ? WHERE path = ?');
            for (const row of rows) {
                const moved = to + row.path.slice(from.length);
                update.run(moved, parentOf(moved), row.path);
            }
            const pending = this.db
                .query<{ path: string }, [string, string, string]>(
                    'SELECT path FROM pending WHERE path = ? OR substr(path, 1, length(?)) = ?',
                )
                .all(from, prefix, prefix);
            for (const row of pending) {
                this.removePending(row.path);
                this.addPending(to + row.path.slice(from.length));
            }
        })();
    }

    put(entry: BaseEntry): void {
        this.db
            .query(
                `INSERT OR REPLACE INTO entries (path, parent, type, local_size, local_mtime, remote_uid, remote_revision, remote_sha1, local_ino, local_btime)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                entry.path,
                parentOf(entry.path),
                entry.type,
                entry.localSize,
                entry.localMtime,
                entry.remoteUid,
                entry.remoteRevision,
                entry.remoteSha1,
                entry.localIno ?? null,
                entry.localBtime ?? null,
            );
    }

    /** Removes an entry and everything below it. */
    removeTree(path: string): void {
        const prefix = path === '/' ? '/' : `${path}/`;
        this.db.query('DELETE FROM entries WHERE path = ? OR substr(path, 1, length(?)) = ?').run(path, prefix, prefix);
    }

    /** Whether any entry exists (i.e. something was synced before). */
    isEmpty(): boolean {
        return !this.db.query('SELECT 1 FROM entries LIMIT 1').get();
    }

    count(): number {
        return this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM entries').get()?.n ?? 0;
    }

    getMeta(key: string): string | undefined {
        return this.db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(key)?.value;
    }

    setMeta(key: string, value: string | undefined): void {
        if (value === undefined) {
            this.db.query('DELETE FROM meta WHERE key = ?').run(key);
        } else {
            this.db.query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
        }
    }

    addPending(path: string): void {
        this.db.query('INSERT OR IGNORE INTO pending (path) VALUES (?)').run(path);
    }

    removePending(path: string): void {
        this.db.query('DELETE FROM pending WHERE path = ?').run(path);
    }

    pending(): string[] {
        return this.db
            .query<{ path: string }, []>('SELECT path FROM pending')
            .all()
            .map((row) => row.path);
    }

    /**
     * Deletes everything but the metadata keys in `keep`, then compacts the files
     * so no deleted row stays in them. Returns false if compacting failed (for
     * example on a full disk); the deletion itself is done either way.
     */
    clear(keep: string[] = []): boolean {
        this.db.transaction(() => {
            this.db.run('DELETE FROM entries');
            this.db.run('DELETE FROM pending');
            const placeholders = keep.map(() => '?').join(', ');
            this.db.query(`DELETE FROM meta WHERE key NOT IN (${placeholders})`).run(...keep);
        })();
        try {
            this.db.run('VACUUM');
            this.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
            return true;
        } catch {
            return false;
        }
    }

    close(): void {
        this.db.close();
    }
}

function fromRow(row: Row): BaseEntry {
    return {
        path: row.path,
        type: row.type,
        localSize: row.local_size,
        localMtime: row.local_mtime,
        remoteUid: row.remote_uid,
        remoteRevision: row.remote_revision,
        remoteSha1: row.remote_sha1,
        localIno: row.local_ino,
        localBtime: row.local_btime,
    };
}
