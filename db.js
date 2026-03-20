const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'pool.db');

let db;

async function getDb() {
  if (db) return db;

  const SQL = await initSqlJs();

  // Ensure data directory exists
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // Load existing DB or create new
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Enable WAL-like behavior & foreign keys
  db.run('PRAGMA foreign_keys = ON');

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('multiple_choice', 'yes_no', 'over_under', 'exact_value')),
      options TEXT,
      points INTEGER DEFAULT 1,
      correct_answer TEXT,
      category TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      answer TEXT NOT NULL,
      submitted_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (question_id) REFERENCES questions(id),
      UNIQUE(user_id, question_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Default settings
  const existing = db.exec("SELECT COUNT(*) as c FROM settings WHERE key = 'pool_name'");
  if (existing[0].values[0][0] === 0) {
    db.run("INSERT INTO settings (key, value) VALUES ('pool_name', 'Masters Prop Bet Pool 2026')");
    db.run("INSERT INTO settings (key, value) VALUES ('deadline', '2026-04-10T12:00:00')");
    db.run("INSERT INTO settings (key, value) VALUES ('locked', '0')");
  }

  save();
  return db;
}

function save() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// Helper: run query and return changes
function run(sql, params = []) {
  db.run(sql, params);
  save();
}

// Helper: get all rows
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// Helper: get one row
function get(sql, params = []) {
  const rows = all(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

module.exports = { getDb, run, all, get, save };
