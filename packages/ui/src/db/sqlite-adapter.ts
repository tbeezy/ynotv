import Database from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';

// Type definitions for our tables
// We use 'any' for row data because we are mimicking a generic DB wrapper
// but in practice usage will be typed by the consumer (db/index.ts)

type ChangeType = 'add' | 'update' | 'delete' | 'clear';

interface DbEvent {
    tableName: string;
    type: ChangeType;
    keys?: any[];
}

type Listener = (event: DbEvent) => void;

// Simple Event Emitter for Live Queries
class DbEvents {
    private listeners: Listener[] = [];

    subscribe(listener: Listener) {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter(l => l !== listener);
        };
    }

    notify(tableName: string, type: ChangeType, keys?: any[]) {
        const event: DbEvent = { tableName, type, keys };
        this.listeners.forEach(l => l(event));
    }
}

export const dbEvents = new DbEvents();

// Helper to convert SQLite values to proper JavaScript types
// SQLite stores BOOLEAN as 0/1 integers, but Tauri plugin may return them as strings

// ─── Shared field-type maps (single source of truth) ─────────────────────────
// Boolean fields that are stored as 0/1 in SQLite but should be JS booleans
const BOOLEAN_FIELDS: Record<string, string[]> = {
    'channels': ['is_favorite', 'enabled'],
    'categories': ['enabled'],
    'vodCategories': ['enabled'],
    'watchlist': ['reminder_enabled', 'autoswitch_enabled', 'reminder_shown', 'autoswitch_triggered'],
};

// JSON fields that are stored as serialized strings but should be parsed objects
const JSON_FIELDS: Record<string, string[]> = {
    'categories': ['filter_words'],
    'channels': ['category_ids'],
    'vodMovies': ['category_ids'],
    'vodSeries': ['category_ids'],
};
// ─────────────────────────────────────────────────────────────────────────────

function normalizeRow(row: any, tableName: string): any {
    if (!row || typeof row !== 'object') return row;

    const normalized = { ...row };

    const fields = BOOLEAN_FIELDS[tableName];
    if (fields) {
        for (const field of fields) {
            if (field in normalized) {
                const val = normalized[field];
                if (typeof val === 'string') {
                    // Convert string "0"/"1" or "false"/"true" to boolean
                    normalized[field] = val === '1' || val === 'true';
                } else if (typeof val === 'number') {
                    // Convert 0/1 to boolean
                    normalized[field] = val === 1;
                }
            }
        }
    }

    // Parse JSON fields
    const jsonFieldList = JSON_FIELDS[tableName];
    if (jsonFieldList) {
        for (const field of jsonFieldList) {
            if (field in normalized && normalized[field] !== null && normalized[field] !== undefined) {
                const val = normalized[field];
                if (typeof val === 'string') {
                    try {
                        normalized[field] = JSON.parse(val);
                    } catch {
                        // If parsing fails, keep as string
                    }
                }
            }
        }
    }

    // Parse date fields
    const dateFields: Record<string, string[]> = {
        'programs': ['start', 'end'],
        'channelMetadata': ['last_updated'],
    };

    const dateFieldList = dateFields[tableName];
    if (dateFieldList) {
        for (const field of dateFieldList) {
            if (field in normalized && normalized[field] !== null && normalized[field] !== undefined) {
                const val = normalized[field];
                if (typeof val === 'string') {
                    const parsed = new Date(val);
                    if (!isNaN(parsed.getTime())) {
                        normalized[field] = parsed;
                    }
                }
            }
        }
    }

    return normalized;
}

// Simple Mutex for serializing writes to avoid SQLITE_BUSY
class Mutex {
    private _queue: Promise<void> = Promise.resolve();

    run<T>(fn: () => Promise<T>): Promise<T> {
        const task = this._queue.then(() => fn());
        // Configure queue to continue even if task fails - cast to void since we don't care about return
        this._queue = task.catch(() => { }) as Promise<void>;
        return task;
    }
}
// Export Mutex for external use (e.g. in sync.ts)
export { Mutex };

const writeLock = new Mutex();

// Helper class for client-side filtering and chaining (Dexie Compatibility)

// Helper class for client-side filtering and chaining (Dexie Compatibility)
class SqliteCollection<T, TKey> {
    private fetcher: () => Promise<T[]>;
    private table: SqliteTable<T, TKey>;
    private _limit: number | null = null;
    private _offset: number | null = null;
    private _reverse: boolean = false;
    private _sorter: ((a: T, b: T) => number) | null = null;

    constructor(table: SqliteTable<T, TKey>, fetcher: () => Promise<T[]>) {
        this.table = table;
        this.fetcher = fetcher;
    }

    private async execute(): Promise<T[]> {
        let results = await this.fetcher();

        if (this._sorter) {
            results.sort(this._sorter);
        }

        if (this._reverse) {
            results.reverse();
        }

        if (this._offset !== null) {
            results = results.slice(this._offset);
        }

        if (this._limit !== null) {
            results = results.slice(0, this._limit);
        }

        return results;
    }

    async toArray(): Promise<T[]> {
        return await this.execute();
    }

    async count(): Promise<number> {
        const res = await this.execute();
        return res.length;
    }

    async first(): Promise<T | undefined> {
        const res = await this.limit(1).execute();
        return res[0];
    }

    // Chainable methods
    limit(n: number): SqliteCollection<T, TKey> {
        this._limit = n;
        return this;
    }

    offset(n: number): SqliteCollection<T, TKey> {
        this._offset = n;
        return this;
    }

    reverse(): SqliteCollection<T, TKey> {
        this._reverse = !this._reverse; // Toggle
        return this;
    }

    sortBy(prop: string): Promise<T[]> {
        // Dexie's sortBy returns a Promise<Array>, not a Collection
        this._sorter = (a: any, b: any) => {
            if (a[prop] < b[prop]) return -1;
            if (a[prop] > b[prop]) return 1;
            return 0;
        };
        return this.execute();
    }

    // Deletion based on the filtered results
    // Note: This loads all rows first - for large deletes use SqliteQuery.delete() instead
    // Example: db.table.where('field').equals(value).delete() - uses SqliteQuery (fast)
    // Example: db.table.filter(fn).delete() - uses SqliteCollection (slow, loads all rows)
    async delete(): Promise<void> {
        const items = await this.execute();
        const primaryKey = (this.table as any).primaryKey;
        const keys = items.map((item: any) => item[primaryKey]);
        await this.table.bulkDelete(keys);
    }
}

export class SqliteTable<T, TKey> {
    private db: Database | null = null;
    private dbPromise: Promise<Database>;
    private tableName: string;
    private primaryKey: string;

    constructor(tableName: string, primaryKey: string, dbPromise: Promise<Database>) {
        this.tableName = tableName;
        this.primaryKey = primaryKey;
        this.dbPromise = dbPromise;
        dbPromise.then(db => { this.db = db; });
    }

    // Update the dbPromise after construction (used for schema initialization chaining)
    updateDbPromise(dbPromise: Promise<Database>) {
        this.dbPromise = dbPromise;
        this.db = null; // Reset cached db
        dbPromise.then(db => { this.db = db; });
    }

    private async getDb(): Promise<Database> {
        if (this.db) return this.db;
        this.db = await this.dbPromise;
        return this.db;
    }


    async toArray(): Promise<T[]> {
        const db = await this.getDb();
        const results = await db.select<T[]>(`SELECT * FROM ${this.tableName}`);
        return results.map(row => normalizeRow(row, this.tableName));
    }

    async get(key: TKey): Promise<T | undefined> {
        const db = await this.getDb();
        const results = await db.select<T[]>(`SELECT * FROM ${this.tableName} WHERE ${this.primaryKey} = $1`, [key]);
        return results[0] ? normalizeRow(results[0], this.tableName) : undefined;
    }

    select(columns: string[]) {
        const q = new SqliteQuery(this, this.primaryKey);
        q.isAll = true;
        q.selectedColumns = columns;
        return q;
    }

    whereRaw(clause: string, params: any[] = []) {
        const q = new SqliteQuery(this, this.primaryKey);
        q.isRaw = true;
        q.rawClause = clause;
        q.rawParams = params;
        return q;
    }

    async add(item: T): Promise<TKey> {
        return writeLock.run(async () => {
            const db = await this.getDb();
            const keys = Object.keys(item as any);
            const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
            const values = Object.values(item as any);
            const columns = keys.join(',');

            await db.execute(
                `INSERT INTO ${this.tableName} (${columns}) VALUES (${placeholders})`,
                values
            );

            // Get the auto-generated ID
            const result = await db.select('SELECT last_insert_rowid() as id') as Array<{ id: number }>;
            const newId = result[0]?.id as TKey;

            dbEvents.notify(this.tableName, 'add');
            return newId;
        });
    }

    async put(item: T): Promise<TKey> {
        return writeLock.run(async () => {
            // Upsert is dialect specific. SQLite supports INSERT OR REPLACE
            const db = await this.getDb();
            const keys = Object.keys(item as any);
            const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
            const values = Object.values(item as any);
            const columns = keys.join(',');

            await db.execute(
                `INSERT OR REPLACE INTO ${this.tableName} (${columns}) VALUES (${placeholders})`,
                values
            );

            dbEvents.notify(this.tableName, 'update');
            return (item as any)[this.primaryKey] as TKey;
        });
    }

    async bulkAdd(items: T[]): Promise<void> {
        if (items.length === 0) return;

        const executeBulkAdd = async () => {
            // Process in chunks to avoid memory pressure
            // Each chunk goes through native bulk insert
            const MEMORY_BATCH_SIZE = 2000; // Process 2000 items at a time to control memory

            for (let i = 0; i < items.length; i += MEMORY_BATCH_SIZE) {
                const chunk = items.slice(i, i + MEMORY_BATCH_SIZE);

                if (chunk.length >= 100) {
                    // Use native bulk insert for this chunk
                    try {
                        await this.nativeBulkInsert(chunk, 'insert');
                    } catch (e) {
                        console.warn(`[SqliteAdapter] Native bulk insert failed for chunk, using plugin:`, e);
                        await this.pluginBulkAdd(chunk);
                    }
                } else {
                    // Small chunk - use plugin method
                    await this.pluginBulkAdd(chunk);
                }

                // Allow GC to collect processed items
                if (i % (MEMORY_BATCH_SIZE * 5) === 0) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }

            dbEvents.notify(this.tableName, 'add');
        };

        await writeLock.run(executeBulkAdd);
    }

    private async pluginBulkAdd(items: T[]): Promise<void> {
        const db = await this.getDb();
        // Get all unique keys from ALL items, not just the first one
        const keysSet = new Set<string>();
        for (const item of items) {
            Object.keys(item as any).forEach(key => keysSet.add(key));
        }
        const keys = Array.from(keysSet);
        const columns = keys.join(',');
        const MAX_PARAMS = 32766;
        const BATCH_SIZE = Math.floor(MAX_PARAMS / keys.length);

        const tableJsonFields = JSON_FIELDS[this.tableName] || [];

        // Boolean fields that need to be converted to 0/1
        const tableBooleanFields = BOOLEAN_FIELDS[this.tableName] || [];

        for (let i = 0; i < items.length; i += BATCH_SIZE) {
            const chunk = items.slice(i, i + BATCH_SIZE);
            if (chunk.length === 0) continue;

            const rowPlaceholders: string[] = [];
            const allValues: any[] = [];

            let paramIndex = 1;
            for (const item of chunk) {
                const placeholders = keys.map(() => `$${paramIndex++}`).join(',');
                rowPlaceholders.push(`(${placeholders})`);
                for (const key of keys) {
                    // Use null for missing keys to ensure consistent column count
                    let val = (item as any)[key] ?? null;
                    // Stringify JSON fields
                    if (tableJsonFields.includes(key) && (Array.isArray(val) || typeof val === 'object') && val !== null) {
                        val = JSON.stringify(val);
                    }
                    // Convert boolean fields to 0/1
                    if (tableBooleanFields.includes(key) && typeof val === 'boolean') {
                        val = val ? 1 : 0;
                    }
                    allValues.push(val);
                }
            }

            const sql = `INSERT INTO ${this.tableName} (${columns}) VALUES ${rowPlaceholders.join(',')}`;
            await db.execute(sql, allValues);
        }
    }

    private async nativeBulkInsert(items: T[], operation: 'insert' | 'replace'): Promise<void> {
        // Get all unique keys from ALL items, not just the first one
        const keysSet = new Set<string>();
        for (const item of items) {
            Object.keys(item as any).forEach(key => keysSet.add(key));
        }
        const keys = Array.from(keysSet);

        const tableJsonFields = JSON_FIELDS[this.tableName] || [];

        // Boolean fields that need to be converted to 0/1
        const tableBooleanFields = BOOLEAN_FIELDS[this.tableName] || [];

        const rows = items.map(item => keys.map(key => {
            let val = (item as any)[key] ?? null;
            // Stringify JSON fields
            if (tableJsonFields.includes(key) && (Array.isArray(val) || typeof val === 'object') && val !== null) {
                val = JSON.stringify(val);
            }
            // Convert boolean fields to 0/1
            if (tableBooleanFields.includes(key) && typeof val === 'boolean') {
                val = val ? 1 : 0;
            }
            return val;
        }));

        await invoke('bulk_insert', {
            request: {
                table: this.tableName,
                columns: keys,
                rows,
                operation
            }
        });
    }

    async bulkPut(items: T[]): Promise<void> {
        if (items.length === 0) return;

        const executeBulkPut = async () => {
            // Process in chunks to avoid memory pressure
            const MEMORY_BATCH_SIZE = 2000;

            for (let i = 0; i < items.length; i += MEMORY_BATCH_SIZE) {
                const chunk = items.slice(i, i + MEMORY_BATCH_SIZE);

                if (chunk.length >= 100) {
                    try {
                        await this.nativeBulkInsert(chunk, 'replace');
                    } catch (e) {
                        console.warn(`[SqliteAdapter] Native bulk insert failed for chunk, using plugin:`, e);
                        await this.pluginBulkPut(chunk);
                    }
                } else {
                    await this.pluginBulkPut(chunk);
                }

                // Allow GC to collect processed items
                if (i % (MEMORY_BATCH_SIZE * 5) === 0) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }

            dbEvents.notify(this.tableName, 'update');
        };

        await writeLock.run(executeBulkPut);
    }

    private async pluginBulkPut(items: T[]): Promise<void> {
        const db = await this.getDb();
        const keys = Object.keys(items[0] as any);
        const columns = keys.join(',');
        const MAX_PARAMS = 32766;
        const BATCH_SIZE = Math.floor(MAX_PARAMS / keys.length);

        const tableJsonFields = JSON_FIELDS[this.tableName] || [];

        for (let i = 0; i < items.length; i += BATCH_SIZE) {
            const chunk = items.slice(i, i + BATCH_SIZE);
            if (chunk.length === 0) continue;

            const rowPlaceholders: string[] = [];
            const allValues: any[] = [];

            let paramIndex = 1;
            for (const item of chunk) {
                const placeholders = keys.map(() => `$${paramIndex++}`).join(',');
                rowPlaceholders.push(`(${placeholders})`);
                for (const key of keys) {
                    let val = (item as any)[key];
                    // Stringify JSON fields
                    if (tableJsonFields.includes(key) && (Array.isArray(val) || typeof val === 'object') && val !== null) {
                        val = JSON.stringify(val);
                    }
                    allValues.push(val);
                }
            }

            const sql = `INSERT OR REPLACE INTO ${this.tableName} (${columns}) VALUES ${rowPlaceholders.join(',')}`;
            await db.execute(sql, allValues);
        }
    }

    async delete(key: TKey): Promise<void> {
        return writeLock.run(async () => {
            const db = await this.getDb();
            await db.execute(`DELETE FROM ${this.tableName} WHERE ${this.primaryKey} = $1`, [key]);
            dbEvents.notify(this.tableName, 'delete');
        });
    }

    async clear(): Promise<void> {
        return writeLock.run(async () => {
            const db = await this.getDb();
            await db.execute(`DELETE FROM ${this.tableName}`);
            dbEvents.notify(this.tableName, 'clear');
        });
    }

    async count(): Promise<number> {
        const db = await this.getDb();
        // plugin-sql select returns array
        const res = await db.select(`SELECT COUNT(*) as count FROM ${this.tableName}`) as { count: number }[];
        return res[0]?.count || 0;
    }

    // Native SQL count with WHERE clause - much faster than loading all rows
    async countWhere(whereClause: string, params: any[] = []): Promise<number> {
        const db = await this.getDb();
        const res = await db.select(
            `SELECT COUNT(*) as count FROM ${this.tableName} WHERE ${whereClause}`,
            params
        ) as { count: number }[];
        return res[0]?.count || 0;
    }

    // Dexie Compatibility: bulkDelete
    async bulkDelete(keys: TKey[]): Promise<void> {
        if (keys.length === 0) return;
        return writeLock.run(async () => {
            const db = await this.getDb();
            // Use IN clause
            const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
            await db.execute(`DELETE FROM ${this.tableName} WHERE ${this.primaryKey} IN (${placeholders})`, keys);
            dbEvents.notify(this.tableName, 'delete');
        });
    }

    // Dexie Compatibility: update
    async update(key: TKey, changes: Partial<T>): Promise<number> {
        return writeLock.run(async () => {
            const db = await this.getDb();
            const keys = Object.keys(changes);
            if (keys.length === 0) return 0;

            const tableJsonFields = JSON_FIELDS[this.tableName] || [];

            // Boolean fields that need to be converted to 0/1
            const tableBooleanFields = BOOLEAN_FIELDS[this.tableName] || [];

            const processedChanges: Record<string, any> = { ...changes };

            // Convert JSON fields
            for (const field of tableJsonFields) {
                if (field in processedChanges && processedChanges[field] !== null && processedChanges[field] !== undefined) {
                    const val = processedChanges[field];
                    if (Array.isArray(val) || typeof val === 'object') {
                        processedChanges[field] = JSON.stringify(val);
                    }
                }
            }

            // Convert boolean fields to 0/1
            for (const field of tableBooleanFields) {
                if (field in processedChanges && processedChanges[field] !== null && processedChanges[field] !== undefined) {
                    const val = processedChanges[field];
                    if (typeof val === 'boolean') {
                        processedChanges[field] = val ? 1 : 0;
                    }
                }
            }

            const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
            const values = Object.values(processedChanges);

            // Add key to values
            values.push(key);

            const result = await db.execute(
                `UPDATE ${this.tableName} SET ${setClause} WHERE ${this.primaryKey} = $${keys.length + 1}`,
                values
            );

            dbEvents.notify(this.tableName, 'update');
            return result.rowsAffected;
        });
    }

    // Basic query builder facade
    where(indexOrPrimKey: string) {
        return new SqliteQuery(this, indexOrPrimKey);
    }

    limit(n: number) {
        // Return a query with no WHERE but with LIMIT
        // In Dexie, table.limit(n) is valid
        const q = new SqliteQuery(this, this.primaryKey); // effectively 'all'
        q.isAll = true; // Flag to indicate we aren't filtering by primary key yet
        return q.limit(n);
    }

    toCollection() {
        const q = new SqliteQuery(this, this.primaryKey);
        q.isAll = true;
        return q;
    }

    filter(fn: (x: T) => boolean) {
        // Client side filter shim
        return new SqliteCollection(this, async () => {
            const results = await this.toArray();
            return results.filter(fn);
        });
    }

    orderBy(prop: string) {
        // Dexie's orderBy returns a Collection
        const q = new SqliteQuery(this, prop);
        q.isAll = true; // No WHERE, just ORDER BY
        return q;
    }
}

class SqliteQuery<T> {
    private table: SqliteTable<T, any>;
    private field: string;
    private op: string = '=';
    private value: any = null;
    public isAll: boolean = false; // If true, ignore field/op/value and select all (subject to limit/offset)

    private _limit: number | null = null;
    private _offset: number | null = null;
    private _reverse: boolean = false;
    private _orderBy: string | null = null;

    private constraints: string[] = [];
    private params: any[] = [];
    public selectedColumns: string[] | null = null;
    public isRaw: boolean = false;
    public rawClause: string = '';
    public rawParams: any[] = [];

    constructor(table: SqliteTable<T, any>, field: string) {
        this.table = table;
        this.field = field;
    }

    // Dexie Compatibility
    toCollection() {
        return this;
    }

    select(columns: string[]) {
        this.selectedColumns = columns;
        return this;
    }

    equals(val: any) {
        this.op = '=';
        this.value = val;
        this.isAll = false;
        // Immediate execution simulation or chain?
        // Dexie: where('foo').equals('bar') returns Collection
        return this;
    }

    // Shim for anyOf (IN clause)
    anyOf(values: any[]) {
        this.op = 'IN';
        this.value = values;
        this.isAll = false;
        return this;
    }

    limit(n: number) {
        this._limit = n;
        return this;
    }

    offset(n: number) {
        this._offset = n;
        return this;
    }

    reverse() {
        this._reverse = true;
        return this;
    }

    async toArray(): Promise<T[]> {
        // Construct SQL
        const db = await (this.table as any).getDb();
        const tableName = (this.table as any).tableName;



        const cols = this.selectedColumns ? this.selectedColumns.join(',') : '*';
        let query = `SELECT ${cols} FROM ${tableName}`;
        let params: any[] = [];

        if (this.isRaw) {
            query += ` WHERE ${this.rawClause}`;
            params = this.rawParams;
        } else if (!this.isAll) {
            // Special handling for category_ids (stored as JSON array string like '["cat1","cat2"]')
            // Use JSON-style matching with quotes to avoid substring matches (e.g., "cat1" matching "cat10")
            if (this.field === 'category_ids' && this.op === '=' && typeof this.value === 'string') {
                query += ` WHERE ${this.field} LIKE $1`;
                // Match the category ID wrapped in JSON quotes: "cat_id"
                // This prevents "cat1" from matching "cat10" or "xcat1x"
                params = [`%"${this.value}"%`];
            } else {
                query += ` WHERE ${this.field}`;
                if (this.op === 'IN' && Array.isArray(this.value)) {
                    // Fix for IN clause: explicitly map placeholders
                    const placeholders = this.value.map((_, i) => `$${i + 1}`).join(',');
                    query += ` IN (${placeholders})`;
                    params = this.value;
                } else {
                    query += ` = $1`;
                    params = [this.value];
                }
            }
            // query += ` ORDER BY ${this.field} ASC`; // Optional, usually default
        }

        if (this._limit !== null) {
            query += ` LIMIT ${this._limit}`;
        }

        if (this._offset !== null) {
            query += ` OFFSET ${this._offset}`;
        }

        const results = await db.select(query, params);
        return results.map((row: any) => normalizeRow(row, tableName));
    }

    async first(): Promise<T | undefined> {
        this._limit = 1;
        const results = await this.toArray();
        return results[0];
    }

    async count(): Promise<number> {
        const db = await (this.table as any).getDb();
        const tableName = (this.table as any).tableName;
        let query = `SELECT COUNT(*) as count FROM ${tableName}`;
        let params: any[] = [];

        if (!this.isAll) {
            // Special handling for category_ids (stored as JSON array string)
            if (this.field === 'category_ids' && this.op === '=' && typeof this.value === 'string') {
                query += ` WHERE ${this.field} LIKE $1`;
                params = [`%${this.value}%`];
            } else {
                query += ` WHERE ${this.field}`;
                if (this.op === 'IN' && Array.isArray(this.value)) {
                    const placeholders = this.value.map((_, i) => `$${i + 1}`).join(',');
                    query += ` IN (${placeholders})`;
                    params = this.value;
                } else {
                    query += ` = $1`;
                    params = [this.value];
                }
            }
        }

        const res = await db.select(query, params) as { count: number }[];
        return res[0]?.count || 0;
    }

    async delete(): Promise<void> {
        return writeLock.run(async () => {
            const db = await (this.table as any).getDb();
            const tableName = (this.table as any).tableName;
            let query = `DELETE FROM ${tableName}`;
            let params: any[] = [];

            if (this.isRaw) {
                query += ` WHERE ${this.rawClause}`;
                params = this.rawParams;
            } else if (!this.isAll) {
                // Special handling for category_ids (stored as JSON array string)
                if (this.field === 'category_ids' && this.op === '=' && typeof this.value === 'string') {
                    query += ` WHERE ${this.field} LIKE $1`;
                    params = [`%${this.value}%`];
                } else {
                    query += ` WHERE ${this.field}`;
                    if (this.op === 'IN' && Array.isArray(this.value)) {
                        const placeholders = this.value.map((_, i) => `$${i + 1}`).join(',');
                        query += ` IN (${placeholders})`;
                        params = this.value;
                    } else {
                        query += ` = $1`;
                        params = [this.value];
                    }
                }
            }

            await db.execute(query, params);
            dbEvents.notify(tableName, 'delete');
        });
    }

    // For chaining filter() after where()
    filter(fn: (x: T) => boolean) {
        return new SqliteCollection(this.table, async () => {
            const results = await this.toArray();
            return results.filter(fn);
        });
    }

    sortBy(prop: string): Promise<T[]> {
        // Dexie's sortBy on a Collection returns Promise<Array>
        return this.toArray().then(all => {
            return all.sort((a: any, b: any) => {
                if (a[prop] < b[prop]) return -1;
                if (a[prop] > b[prop]) return 1;
                return 0;
            });
        });
    }
}

export class SqliteDatabase {
    protected dbPromise: Promise<Database>;

    constructor(dbName: string) {
        // Initialize connection
        this.dbPromise = Database.load(`sqlite:${dbName}.db`).then(async (db) => {
            // Enable WAL mode for better concurrency
            await db.execute('PRAGMA journal_mode=WAL;');
            await db.execute('PRAGMA synchronous=NORMAL;');
            // Set busy timeout to 5 seconds
            await db.execute('PRAGMA busy_timeout = 5000;');
            // Tuning
            await db.execute('PRAGMA cache_size = -64000;'); // 64MB cache
            await db.execute('PRAGMA temp_store = MEMORY;'); // Use RAM for internals
            return db;
        });
    }

    // Transaction helper
    // Dexie: transaction('rw', [tables], cb)
    async transaction(mode: string, tables: any[], cb: () => Promise<void>) {
        // For now, simple wrapper. 
        // Real implementation might need to handle locking if we were rigorous, but SQLite
        // serializes writes anyway.
        // We can wrap callback in a try/catch if we wanted to be safe
        return await cb();
    }
}

