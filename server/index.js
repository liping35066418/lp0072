const express = require('express');
const cors = require('cors');
const dayjs = require('dayjs');
const db = require('./db');

const app = express();
const PORT = 8802;

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: '陶土工坊烧制调度服务运行中', time: new Date().toISOString() });
});

app.get('/api/kilns', (req, res) => {
  const kilns = db.prepare('SELECT * FROM kilns ORDER BY id').all();
  const result = kilns.map(kiln => {
    const count = db.prepare(`
      SELECT COUNT(*) as count FROM clay_bodies 
      WHERE kiln_id = ? AND status IN ('scheduled', 'firing')
    `).get(kiln.id).count;
    return { ...kiln, current_count: count, remaining: kiln.capacity - count };
  });
  res.json(result);
});

app.post('/api/kilns', (req, res) => {
  const { name, capacity } = req.body;
  if (!name || !capacity) {
    return res.status(400).json({ error: '窑炉名称和容量不能为空' });
  }
  const info = db.prepare('INSERT INTO kilns (name, capacity, status) VALUES (?, ?, ?)').run(name, capacity, 'idle');
  res.json({ id: info.lastInsertRowid, name, capacity, status: 'idle' });
});

app.put('/api/kilns/:id', (req, res) => {
  const { id } = req.params;
  const { name, capacity, status } = req.body;
  const kiln = db.prepare('SELECT * FROM kilns WHERE id = ?').get(id);
  if (!kiln) return res.status(404).json({ error: '窑炉不存在' });
  db.prepare('UPDATE kilns SET name = ?, capacity = ?, status = ? WHERE id = ?').run(
    name || kiln.name, capacity || kiln.capacity, status || kiln.status, id
  );
  res.json(db.prepare('SELECT * FROM kilns WHERE id = ?').get(id));
});

app.delete('/api/kilns/:id', (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM kilns WHERE id = ?').run(id);
  res.json({ success: true });
});

app.get('/api/bodies', (req, res) => {
  const { status, schedule_date, kiln_id } = req.query;
  let sql = 'SELECT * FROM clay_bodies WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (schedule_date) { sql += ' AND schedule_date = ?'; params.push(schedule_date); }
  if (kiln_id) { sql += ' AND kiln_id = ?'; params.push(kiln_id); }
  sql += ' ORDER BY COALESCE(kiln_order, 9999), id DESC';
  const bodies = db.prepare(sql).all(...params);
  res.json(bodies);
});

app.get('/api/bodies/:id', (req, res) => {
  const body = db.prepare('SELECT * FROM clay_bodies WHERE id = ?').get(req.params.id);
  if (!body) return res.status(404).json({ error: '坯体不存在' });
  const defects = db.prepare('SELECT * FROM defects WHERE body_id = ? ORDER BY created_at DESC').all(req.params.id);
  const notifications = db.prepare('SELECT * FROM notifications WHERE body_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ ...body, defects, notifications });
});

app.post('/api/bodies', (req, res) => {
  const { customer_name, customer_phone, body_name, glaze_color, weight, notes, schedule_date } = req.body;
  if (!customer_name || !customer_phone || !body_name || !glaze_color) {
    return res.status(400).json({ error: '顾客姓名、电话、坯体名称、釉色为必填项' });
  }
  const info = db.prepare(`
    INSERT INTO clay_bodies (customer_name, customer_phone, body_name, glaze_color, weight, notes, status, schedule_date)
    VALUES (?, ?, ?, ?, ?, ?, 'registered', ?)
  `).run(customer_name, customer_phone, body_name, glaze_color, weight || 0, notes || '', schedule_date || dayjs().format('YYYY-MM-DD'));
  res.json({ id: info.lastInsertRowid, ...req.body, status: 'registered' });
});

app.put('/api/bodies/:id', (req, res) => {
  const { id } = req.params;
  const body = db.prepare('SELECT * FROM clay_bodies WHERE id = ?').get(id);
  if (!body) return res.status(404).json({ error: '坯体不存在' });
  const { customer_name, customer_phone, body_name, glaze_color, weight, notes, status, schedule_date, kiln_id, kiln_order, fired_at, claimed_at } = req.body;
  db.prepare(`
    UPDATE clay_bodies SET 
      customer_name = ?, customer_phone = ?, body_name = ?, glaze_color = ?, 
      weight = ?, notes = ?, status = ?, schedule_date = ?, kiln_id = ?, kiln_order = ?,
      fired_at = ?, claimed_at = ?
    WHERE id = ?
  `).run(
    customer_name || body.customer_name, customer_phone || body.customer_phone,
    body_name || body.body_name, glaze_color || body.glaze_color,
    weight != null ? weight : body.weight, notes != null ? notes : body.notes,
    status || body.status, schedule_date || body.schedule_date,
    kiln_id != null ? kiln_id : body.kiln_id, kiln_order != null ? kiln_order : body.kiln_order,
    fired_at || body.fired_at, claimed_at || body.claimed_at, id
  );
  res.json(db.prepare('SELECT * FROM clay_bodies WHERE id = ?').get(id));
});

app.delete('/api/bodies/:id', (req, res) => {
  db.prepare('DELETE FROM clay_bodies WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/bodies/assign', (req, res) => {
  const { body_ids, kiln_id, schedule_date } = req.body;
  if (!body_ids || !Array.isArray(body_ids) || body_ids.length === 0 || !kiln_id) {
    return res.status(400).json({ error: '参数错误' });
  }
  const kiln = db.prepare('SELECT * FROM kilns WHERE id = ?').get(kiln_id);
  if (!kiln) return res.status(404).json({ error: '窑炉不存在' });
  const currentCount = db.prepare(`
    SELECT COUNT(*) as count FROM clay_bodies 
    WHERE kiln_id = ? AND status IN ('scheduled', 'firing') AND id NOT IN (${body_ids.map(() => '?').join(',')})
  `).get(kiln_id, ...body_ids).count;
  if (currentCount + body_ids.length > kiln.capacity) {
    return res.status(400).json({ 
      error: '窑炉容量不足', 
      current: currentCount, 
      adding: body_ids.length, 
      capacity: kiln.capacity 
    });
  }
  const tx = db.transaction(() => {
    let order = currentCount + 1;
    const updateStmt = db.prepare(`
      UPDATE clay_bodies SET kiln_id = ?, kiln_order = ?, status = 'scheduled', schedule_date = ? WHERE id = ?
    `);
    body_ids.forEach(bid => {
      updateStmt.run(kiln_id, order++, schedule_date || dayjs().format('YYYY-MM-DD'), bid);
    });
  });
  tx();
  res.json({ success: true, message: `成功分配 ${body_ids.length} 件坯体` });
});

app.post('/api/bodies/reorder', (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: '参数错误' });
  }
  const tx = db.transaction(() => {
    const updateStmt = db.prepare('UPDATE clay_bodies SET kiln_id = ?, kiln_order = ? WHERE id = ?');
    items.forEach(item => {
      updateStmt.run(item.kiln_id, item.order, item.id);
    });
  });
  tx();
  res.json({ success: true });
});

app.post('/api/bodies/remove-kiln/:id', (req, res) => {
  db.prepare('UPDATE clay_bodies SET kiln_id = NULL, kiln_order = NULL, status = ? WHERE id = ?').run('registered', req.params.id);
  res.json({ success: true });
});

app.get('/api/kilns/:id/bodies', (req, res) => {
  const bodies = db.prepare(`
    SELECT * FROM clay_bodies 
    WHERE kiln_id = ? AND status IN ('scheduled', 'firing')
    ORDER BY kiln_order ASC, id
  `).all(req.params.id);
  res.json(bodies);
});

app.post('/api/kilns/:id/start-firing', (req, res) => {
  const { id } = req.params;
  const kiln = db.prepare('SELECT * FROM kilns WHERE id = ?').get(id);
  if (!kiln) return res.status(404).json({ error: '窑炉不存在' });
  const bodies = db.prepare(`SELECT * FROM clay_bodies WHERE kiln_id = ? AND status = 'scheduled'`).all(id);
  if (bodies.length === 0) return res.status(400).json({ error: '该窑炉没有待烧制的坯体' });
  const tx = db.transaction(() => {
    db.prepare('UPDATE kilns SET status = ? WHERE id = ?').run('firing', id);
    const firingInfo = db.prepare(`
      INSERT INTO firings (kiln_id, start_date, status, temperature)
      VALUES (?, ?, 'firing', ?)
    `).run(id, dayjs().format('YYYY-MM-DD'), req.body.temperature || 1280);
    const insertFB = db.prepare('INSERT INTO firing_bodies (firing_id, body_id, position) VALUES (?, ?, ?)');
    bodies.forEach((b, idx) => {
      insertFB.run(firingInfo.lastInsertRowid, b.id, idx + 1);
      db.prepare("UPDATE clay_bodies SET status = 'firing', fired_at = ? WHERE id = ?").run(dayjs().format('YYYY-MM-DD HH:mm:ss'), b.id);
    });
  });
  tx();
  res.json({ success: true, message: `窑炉 ${kiln.name} 开始烧制` });
});

app.post('/api/kilns/:id/finish-firing', (req, res) => {
  const { id } = req.params;
  const kiln = db.prepare('SELECT * FROM kilns WHERE id = ?').get(id);
  if (!kiln) return res.status(404).json({ error: '窑炉不存在' });
  const tx = db.transaction(() => {
    db.prepare('UPDATE kilns SET status = ? WHERE id = ?').run('idle', id);
    db.prepare(`UPDATE firings SET status = 'completed', end_date = ? WHERE kiln_id = ? AND status = 'firing'`).run(dayjs().format('YYYY-MM-DD'), id);
    const bodies = db.prepare(`SELECT * FROM clay_bodies WHERE kiln_id = ? AND status = 'firing'`).all(id);
    const notifStmt = db.prepare(`INSERT INTO notifications (body_id, type, message) VALUES (?, 'claim', ?)`);
    bodies.forEach(b => {
      db.prepare("UPDATE clay_bodies SET status = 'ready' WHERE id = ?").run(b.id);
      notifStmt.run(b.id, `您的「${b.body_name}」已烧制完成，请到工坊认领！`);
    });
  });
  tx();
  res.json({ success: true, message: `窑炉 ${kiln.name} 烧制完成，已发送认领提醒` });
});

app.post('/api/bodies/:id/claim', (req, res) => {
  db.prepare("UPDATE clay_bodies SET status = 'claimed', claimed_at = ? WHERE id = ?").run(dayjs().format('YYYY-MM-DD HH:mm:ss'), req.params.id);
  res.json({ success: true });
});

app.get('/api/defects', (req, res) => {
  const defects = db.prepare(`
    SELECT d.*, b.body_name, b.customer_name, b.glaze_color 
    FROM defects d JOIN clay_bodies b ON d.body_id = b.id 
    ORDER BY d.created_at DESC
  `).all();
  res.json(defects);
});

app.post('/api/bodies/:id/defects', (req, res) => {
  const { id } = req.params;
  const { defect_type, description, severity, needs_refire } = req.body;
  if (!defect_type) return res.status(400).json({ error: '瑕疵类型不能为空' });
  const info = db.prepare(`
    INSERT INTO defects (body_id, defect_type, description, severity, needs_refire)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, defect_type, description || '', severity || 'minor', needs_refire ? 1 : 0);
  if (needs_refire) {
    db.prepare("UPDATE clay_bodies SET status = 'refire_needed', kiln_id = NULL, kiln_order = NULL WHERE id = ?").run(id);
  }
  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/defects/:id', (req, res) => {
  db.prepare('DELETE FROM defects WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/notifications', (req, res) => {
  const { unread } = req.query;
  let sql = `SELECT n.*, b.body_name, b.customer_name, b.customer_phone 
             FROM notifications n JOIN clay_bodies b ON n.body_id = b.id`;
  const params = [];
  if (unread === 'true') { sql += ' WHERE n.is_read = 0'; }
  sql += ' ORDER BY n.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/notifications/:id/read', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/notifications/read-all', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1').run();
  res.json({ success: true });
});

app.get('/api/stats/glaze-count', (req, res) => {
  const { start_date, end_date } = req.query;
  let sql = `SELECT glaze_color, COUNT(*) as count, 
             SUM(CASE WHEN status IN ('fired','ready','claimed') THEN 1 ELSE 0 END) as fired_count
             FROM clay_bodies WHERE 1=1`;
  const params = [];
  if (start_date) { sql += ' AND registered_at >= ?'; params.push(start_date); }
  if (end_date) { sql += ' AND registered_at <= ?'; params.push(end_date + ' 23:59:59'); }
  sql += ' GROUP BY glaze_color ORDER BY count DESC';
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/stats/overview', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as count FROM clay_bodies').get().count;
  const registered = db.prepare("SELECT COUNT(*) as count FROM clay_bodies WHERE status = 'registered'").get().count;
  const scheduled = db.prepare("SELECT COUNT(*) as count FROM clay_bodies WHERE status = 'scheduled'").get().count;
  const firing = db.prepare("SELECT COUNT(*) as count FROM clay_bodies WHERE status = 'firing'").get().count;
  const ready = db.prepare("SELECT COUNT(*) as count FROM clay_bodies WHERE status = 'ready'").get().count;
  const claimed = db.prepare("SELECT COUNT(*) as count FROM clay_bodies WHERE status = 'claimed'").get().count;
  const defectCount = db.prepare('SELECT COUNT(*) as count FROM defects').get().count;
  const refire = db.prepare("SELECT COUNT(*) as count FROM clay_bodies WHERE status = 'refire_needed'").get().count;
  const kilns = db.prepare('SELECT * FROM kilns').all();
  const kilnUtilization = kilns.map(k => {
    const used = db.prepare(`SELECT COUNT(*) as count FROM clay_bodies WHERE kiln_id = ? AND status IN ('scheduled','firing')`).get(k.id).count;
    return { id: k.id, name: k.name, used, capacity: k.capacity, rate: k.capacity > 0 ? (used / k.capacity * 100).toFixed(1) : 0, status: k.status };
  });
  res.json({ total, registered, scheduled, firing, ready, claimed, defectCount, refire, kilnUtilization });
});

app.get('/api/calendar', (req, res) => {
  const { start, end } = req.query;
  let sql = `SELECT schedule_date as date, kiln_id, status, COUNT(*) as count
             FROM clay_bodies 
             WHERE schedule_date IS NOT NULL`;
  const params = [];
  if (start) { sql += ' AND schedule_date >= ?'; params.push(start); }
  if (end) { sql += ' AND schedule_date <= ?'; params.push(end); }
  sql += ' GROUP BY schedule_date, kiln_id, status';
  const events = db.prepare(sql).all(...params);
  const details = db.prepare(`
    SELECT id, body_name, customer_name, glaze_color, schedule_date, kiln_id, status
    FROM clay_bodies WHERE schedule_date IS NOT NULL
  `).all();
  res.json({ summary: events, details });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 陶土工坊烧制调度后端服务已启动`);
  console.log(`📡 服务地址: http://localhost:${PORT}`);
  console.log(`🔗 健康检查: http://localhost:${PORT}/api/health\n`);
});
