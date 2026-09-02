const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

function init(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  const initSql = fs.readFileSync(path.join(__dirname, 'init_db.sql'), 'utf8');
  db.exec(initSql);
  return db;
}

module.exports = { init };