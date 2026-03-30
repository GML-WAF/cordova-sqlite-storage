const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const Database = require('better-sqlite3');

// dbConnections: open db connections
const dbConnections = new Map(); // key = dbName → { db, filePath }

/**
 * Determine persistent file paths in userdata/Databases.
 * @param {string} name
 * @return {*}
 */
function resolveDbPathFromName(name) {
    if (!name || typeof name !== 'string') {
        throw new Error('Invalid database name');
    }

    const baseDir = path.join(app.getPath('userData'), 'Databases');
    fs.mkdirSync(baseDir, { recursive: true });

    return path.join(baseDir, path.basename(name));
}

/**
 * Get db from dbConnections.
 * @param {string} dbName
 * @return {*}
 */
function getDb(dbName) {
    const entry = dbConnections.get(dbName);
    if (!entry || !entry.db) {
        throw new Error(`Database not open: ${dbName}`);
    }

    return entry.db;
}

/**
 * Action open: Opens database
 * @param {Object[]} args "[{name: 'my.db', location: 'default', ...}]"
 * @return {Promise<boolean>}
 */
async function open(args) {
    const [openArgs] = args || [];
    const dbName = openArgs && (openArgs.name || openArgs.dbname || openArgs.path);
    if (!dbName) {
        throw new Error('Missing database name');
    }

    if (dbConnections.has(dbName)) {
        // already opened -> ok
        return true;
    }

    const filePath = resolveDbPathFromName(dbName);
    const db = new Database(filePath);

    try {
        // use delete journal and not wal (write ahead log)
        db.pragma('journal_mode = DELETE');
    } catch (err) {
        console.error(err);
    }

    dbConnections.set(dbName, { db, filePath });

    return true;
}

/**
 * Action close: Closes a given database.
 * @param {Object[]} args "[{path: 'my.db'}]"
 * @return {Promise<boolean>}
 */
async function close(args) {
    const [{ path: dbName } = {}] = args || [];
    if (!dbName) {
        throw new Error('Missing database name');
    }

    const entry = dbConnections.get(dbName);
    if (!entry) {
        return true; // idempotent
    }

    try {
        entry.db.close();
    } catch (err) {
        console.error(err);
    }

    dbConnections.delete(dbName);

    return true;
}

/**
 * Action delete: deletes a database.
 * @param {Object[]} args "[{ path: 'my.db'}]"
 * @return {Promise<boolean>}
 * @private
 */
async function _delete(args) {
    const [{ path: dbName } = {}] = args || [];
    if (!dbName) {
        throw new Error('Missing database name');
    }

    const entry = dbConnections.get(dbName);
    if (entry) {
        try {
            entry.db.close();
        } catch (err) {
            console.error(err);
        }
        dbConnections.delete(dbName);
    }

    const filePath = resolveDbPathFromName(dbName);
    try {
        fs.unlinkSync(filePath);
    } catch (err) {
        console.error(err);
        if (err.code !== 'ENOENT') {
            throw err;
        }
    }

    return true;
}

/**
 * Action executeSqlBatch: executes sql query
 * @param {Object[]} args "[{dbargs: {dbname: 'my.db'}, executes: [{ sql: "...", params: [...] }, ...]}]"
 * @return {Promise<*[]>}
 */
async function executeSqlBatch(args) {
    const [payload] = args || [];
    if (!payload || !payload.dbargs || !payload.executes) {
        throw new Error('Bad arguments for executeSqlBatch');
    }

    const dbName = payload.dbargs.dbname || payload.dbargs.name || payload.dbargs.path;
    const db = getDb(dbName);

    const results = [];

    for (const op of payload.executes) {
        const sql = op && op.sql;
        const params = (op && Array.isArray(op.params)) ? op.params : [];

        if (typeof sql !== 'string') {
            results.push({
                type: 'error',
                result: { message: 'Invalid SQL', code: 0 }
            });
            continue;
        }

        try {
            const isSelect = isSelectQuery(sql);

            if (isSelect) {
                const stmt = db.prepare(sql);
                const rows = stmt.all(...params);
                results.push({
                    type: 'success',
                    result: {
                        rows,          // Array of row objects (JS-Layer builds rows.item())
                        rowsAffected: 0
                    }
                });
            } else {
                const stmt = db.prepare(sql);
                const info = stmt.run(...params);
                results.push({
                    type: 'success',
                    result: {
                        rowsAffected: info.changes || 0,
                        insertId: info.lastInsertRowid || undefined
                    }
                });
            }
        } catch (ex) {
            results.push({
                type: 'error',
                result: { message: ex.message, code: 0 }
            });
        }
    }

    return results;
}

/* -----------------------------------------------------------
   ACTION: backgroundExecuteSqlBatch
   (Alias, wird von älteren JS-Versionen genutzt)
------------------------------------------------------------ */
/**
 * Action backgroundExecuteSqlBatch: executes sql batch (used from plugin, alias for executeSqlBatch)
 * @param {Object[]} args see args in executeSqlBatch
 * @return {Promise<*[]>}
 */
async function backgroundExecuteSqlBatch(args) {
    return executeSqlBatch(args);
}


/* -----------------------------------------------------------
   ACTION: echoStringValue
   Wird vom Plugin-Selbsttest genutzt
------------------------------------------------------------ */
/**
 * Action echoStringValue: used by plugin for self test
 * @param {Object[]} args "[{value: 'string'}]"
 * @return {string|string}
 */
function echoStringValue(args) {
    const [argv] = args || [];

    return (argv == null) ? '' : String(argv.value);
}

/**
 * Determines if query is a select query or other.
 * Supports WITH CTE queries and determines if it's a select or other query type.
 * @param {string} sqlRaw Query string
 * @return {boolean}
 */
function isSelectQuery(sqlRaw) {
    if (!sqlRaw) {
        return false;
    }

    // 1) remove leading comments
    function stripLeadingComments(s) {
        const commentRegex = /^(\s*(--.*?$|\/\*[\s\S]*?\*\/))+/m;
        let out = s;
        while (true) {
            const before = out;
            out = out.replace(commentRegex, '').trimStart();
            if (out === before) break;
        }
        return out;
    }

    let sql = stripLeadingComments(sqlRaw).trimStart();

    // 2) get first tokens of string
    const tokens = sql
        .split(/\s+/)
        .map(t => t.replace(/^[()]+|[()]+$/g, ''))
        .map(t => t.toUpperCase());

    if (tokens.length === 0){
        return false;
    }

    let i = 0;

    // 3) check WITH / WITH RECURSIVE
    if (tokens[i] === 'WITH') {
        i++;
        if (tokens[i] === 'RECURSIVE'){
            i++;
        }

        // SELECT/INSERT/UPDATE/DELETE comes after the first CTE name
        // check if first word of remaining string tokens is select and return result
        const rest = tokens.slice(i);
        const j = rest.indexOf('SELECT');

        return j !== -1;
    }

    // 4) normal query: first relevant keyword
    return tokens[i] === 'SELECT';
}


/* -----------------------------------------------------------
   EXPORT: Alle Actions für cordova.exec(ServiceName="SQLitePlugin")
------------------------------------------------------------ */
module.exports = {
    open,
    close,
    delete: _delete,
    executeSqlBatch,
    backgroundExecuteSqlBatch,
    echoStringValue
};