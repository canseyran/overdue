.pragma library
.import QtQuick.LocalStorage 2.0 as Sql

// SQLite storage for Overdue through Qt's LocalStorage. Qt picks the file:
// <offlineStoragePath>/Databases/<md5 of DB_NAME>.sqlite, next to an .ini
// that names it. `omarchy-shell canseyran.overdue exportJson` dumps
// everything as JSON.
//
// Only Service.qml calls into this file; the widgets read the service.


var DB_NAME = "canseyran.overdue"
var SCHEMA_VERSION = 4

var DAY_MS = 86400000

var _db = null

var MIGRATIONS = [
  // 0 -> 1
  function(tx) {
    tx.executeSql("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    tx.executeSql(
      "CREATE TABLE IF NOT EXISTS tasks (" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT," +
      " title TEXT NOT NULL," +
      " due_at INTEGER," +
      " recur TEXT DEFAULT ''," +
      " tags TEXT DEFAULT ''," +
      " priority INTEGER NOT NULL DEFAULT 0," +
      " nag_every_min INTEGER NOT NULL DEFAULT 0," +
      " nag_enabled INTEGER NOT NULL DEFAULT 1," +
      " snoozed_until INTEGER NOT NULL DEFAULT 0," +
      " nag_count INTEGER NOT NULL DEFAULT 0," +
      " last_nag_at INTEGER NOT NULL DEFAULT 0," +
      " created_at INTEGER NOT NULL," +
      " done_at INTEGER)")
    tx.executeSql("CREATE INDEX IF NOT EXISTS tasks_open ON tasks (done_at, due_at)")
  },
  // 1 -> 2: the Archived list
  function(tx) {
    tx.executeSql("ALTER TABLE tasks ADD COLUMN archived_at INTEGER")
  },
  // 2 -> 3: optional descriptions
  function(tx) {
    tx.executeSql("ALTER TABLE tasks ADD COLUMN description TEXT")
  },
  // 3 -> 4: drop per-task snoozing and per-task reminder intervals (snooze
  // is app-wide, kept in meta; the interval is a setting)
  function(tx) {
    tx.executeSql("ALTER TABLE tasks DROP COLUMN snoozed_until")
    tx.executeSql("ALTER TABLE tasks DROP COLUMN nag_every_min")
    tx.executeSql("ALTER TABLE tasks DROP COLUMN nag_enabled")
  }
]

function db() {
  if (_db) return _db
  _db = Sql.LocalStorage.openDatabaseSync(DB_NAME, "", "Overdue tasks", 5 * 1024 * 1024)
  migrate(_db)
  return _db
}

function migrate(database) {
  database.transaction(function(tx) {
    tx.executeSql("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    var rs = tx.executeSql("SELECT value FROM meta WHERE key = 'schema_version'")
    var version = rs.rows.length > 0 ? parseInt(rs.rows.item(0).value, 10) || 0 : 0
    for (var from = version; from < SCHEMA_VERSION && from < MIGRATIONS.length; from++) MIGRATIONS[from](tx)
    tx.executeSql("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)])
  })
}

// ----------------------------------------------------------------- mapping

var COLUMNS = {
  title: "title", dueAt: "due_at", recur: "recur", tags: "tags", priority: "priority",
  nagCount: "nag_count", lastNagAt: "last_nag_at", createdAt: "created_at", doneAt: "done_at",
  archivedAt: "archived_at", description: "description"
}

function fromRow(row) {
  return {
    id: Number(row.id),
    title: String(row.title || ""),
    dueAt: row.due_at === null || row.due_at === undefined ? null : Number(row.due_at),
    recur: String(row.recur || ""),
    tags: row.tags ? String(row.tags).split(" ").filter(function(tag) { return tag !== "" }) : [],
    priority: Number(row.priority) || 0,
    nagCount: Number(row.nag_count) || 0,
    lastNagAt: Number(row.last_nag_at) || 0,
    createdAt: Number(row.created_at) || 0,
    doneAt: row.done_at === null || row.done_at === undefined ? null : Number(row.done_at),
    archivedAt: row.archived_at === null || row.archived_at === undefined ? null : Number(row.archived_at),
    description: String(row.description || "")
  }
}

function toValue(key, value) {
  if (key === "tags") return (value || []).join(" ")
  if (key === "dueAt" || key === "doneAt" || key === "archivedAt") return value === null || value === undefined ? null : Math.round(Number(value))
  if (key === "title" || key === "recur" || key === "description") return String(value || "")
  return Math.round(Number(value) || 0)
}

// ------------------------------------------------------------------ queries

// The task lifecycle, run whenever tasks are loaded: completed tasks move to
// Archived after `doneDays` days (0 = never), and archived tasks are deleted
// after `archivedDays` days (0 = never).
function maintain(now, doneDays, archivedDays) {
  db().transaction(function(tx) {
    if (doneDays > 0)
      tx.executeSql("UPDATE tasks SET archived_at = ? WHERE done_at IS NOT NULL AND archived_at IS NULL AND done_at < ?",
        [now, now - doneDays * DAY_MS])
    if (archivedDays > 0)
      tx.executeSql("DELETE FROM tasks WHERE archived_at IS NOT NULL AND archived_at < ?", [now - archivedDays * DAY_MS])
  })
}

function all() {
  var out = []
  db().readTransaction(function(tx) {
    var rs = tx.executeSql("SELECT * FROM tasks ORDER BY id")
    for (var i = 0; i < rs.rows.length; i++) out.push(fromRow(rs.rows.item(i)))
  })
  return out
}

function get(id) {
  var task = null
  db().readTransaction(function(tx) {
    var rs = tx.executeSql("SELECT * FROM tasks WHERE id = ?", [Number(id)])
    if (rs.rows.length > 0) task = fromRow(rs.rows.item(0))
  })
  return task
}

function insert(fields) {
  var id = 0
  var keys = []
  var values = []
  for (var key in COLUMNS) {
    if (fields[key] === undefined) continue
    keys.push(COLUMNS[key])
    values.push(toValue(key, fields[key]))
  }
  var marks = keys.map(function() { return "?" }).join(", ")
  db().transaction(function(tx) {
    var rs = tx.executeSql("INSERT INTO tasks (" + keys.join(", ") + ") VALUES (" + marks + ")", values)
    id = Number(rs.insertId)
  })
  return id
}

// Only known columns are written; keys come from COLUMNS, never from input.
function update(id, fields) {
  var sets = []
  var values = []
  for (var key in fields) {
    if (!COLUMNS[key]) continue
    sets.push(COLUMNS[key] + " = ?")
    values.push(toValue(key, fields[key]))
  }
  if (sets.length === 0) return false
  values.push(Number(id))
  var changed = 0
  db().transaction(function(tx) {
    changed = tx.executeSql("UPDATE tasks SET " + sets.join(", ") + " WHERE id = ?", values).rowsAffected
  })
  return changed > 0
}

function remove(id) {
  var changed = 0
  db().transaction(function(tx) {
    changed = tx.executeSql("DELETE FROM tasks WHERE id = ?", [Number(id)]).rowsAffected
  })
  return changed > 0
}

// ---------------------------------------------------------------- settings

function getMeta(key, fallback) {
  var value = fallback
  db().readTransaction(function(tx) {
    var rs = tx.executeSql("SELECT value FROM meta WHERE key = ?", [String(key)])
    if (rs.rows.length > 0) value = rs.rows.item(0).value
  })
  return value
}

function setMeta(key, value) {
  db().transaction(function(tx) {
    tx.executeSql("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [String(key), String(value)])
  })
}
