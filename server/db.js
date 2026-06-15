const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'pottery.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kilns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 20,
      status TEXT NOT NULL DEFAULT 'idle',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS clay_bodies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      body_name TEXT NOT NULL,
      glaze_color TEXT NOT NULL,
      weight REAL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'registered',
      kiln_id INTEGER,
      kiln_order INTEGER,
      schedule_date DATE,
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      fired_at DATETIME,
      claimed_at DATETIME,
      FOREIGN KEY (kiln_id) REFERENCES kilns(id)
    );

    CREATE TABLE IF NOT EXISTS firings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kiln_id INTEGER NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE,
      status TEXT NOT NULL DEFAULT 'scheduled',
      temperature REAL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (kiln_id) REFERENCES kilns(id)
    );

    CREATE TABLE IF NOT EXISTS firing_bodies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      firing_id INTEGER NOT NULL,
      body_id INTEGER NOT NULL,
      position INTEGER,
      FOREIGN KEY (firing_id) REFERENCES firings(id) ON DELETE CASCADE,
      FOREIGN KEY (body_id) REFERENCES clay_bodies(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS defects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body_id INTEGER NOT NULL,
      defect_type TEXT NOT NULL,
      description TEXT,
      severity TEXT NOT NULL DEFAULT 'minor',
      needs_refire INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (body_id) REFERENCES clay_bodies(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (body_id) REFERENCES clay_bodies(id) ON DELETE CASCADE
    );
  `);

  const kilnCount = db.prepare('SELECT COUNT(*) as count FROM kilns').get().count;
  if (kilnCount === 0) {
    const insertKiln = db.prepare('INSERT INTO kilns (name, capacity, status) VALUES (?, ?, ?)');
    insertKiln.run('1号窑炉', 25, 'idle');
    insertKiln.run('2号窑炉', 30, 'idle');
    insertKiln.run('3号窑炉', 20, 'idle');
  }

  const bodyCount = db.prepare('SELECT COUNT(*) as count FROM clay_bodies').get().count;
  if (bodyCount === 0) {
    const insertBody = db.prepare(`
      INSERT INTO clay_bodies 
      (customer_name, customer_phone, body_name, glaze_color, weight, notes, status, schedule_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const nextWeek = new Date(today);
    nextWeek.setDate(nextWeek.getDate() + 7);
    
    const formatDate = (d) => d.toISOString().split('T')[0];
    
    insertBody.run('张三', '13800138001', '茶杯', '青瓷', 0.35, '手工拉坯', 'registered', formatDate(today));
    insertBody.run('李四', '13800138002', '花瓶', '钧瓷', 1.2, '注浆成型', 'registered', formatDate(today));
    insertBody.run('王五', '13800138003', '碗', '汝瓷', 0.5, '', 'registered', formatDate(tomorrow));
    insertBody.run('赵六', '13800138004', '盘子', '青花瓷', 0.8, '画花装饰', 'registered', formatDate(tomorrow));
    insertBody.run('钱七', '13800138005', '陶罐', '黑陶', 1.5, '素烧后施釉', 'registered', formatDate(nextWeek));
  }
}

initDatabase();

module.exports = db;
