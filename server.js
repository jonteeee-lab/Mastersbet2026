const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const { getDb, run, all, get } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'masters-pool-secret-2026';

app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth middleware ──
function auth(req, res, next) {
  const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Ej inloggad' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Ogiltig session' });
  }
}

function adminAuth(req, res, next) {
  auth(req, res, () => {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Endast admin' });
    next();
  });
}

// ── Auth routes ──
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Alla fält krävs' });

  const existing = get('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) return res.status(400).json({ error: 'E-postadressen är redan registrerad' });

  const hash = bcrypt.hashSync(password, 10);
  const isFirstUser = !get('SELECT id FROM users LIMIT 1');
  run('INSERT INTO users (name, email, password_hash, is_admin) VALUES (?, ?, ?, ?)',
    [name, email, hash, isFirstUser ? 1 : 0]);

  const user = get('SELECT id, name, email, is_admin FROM users WHERE email = ?', [email]);
  const token = jwt.sign({ id: user.id, name: user.name, email: user.email, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
  res.json({ user, token });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Fel e-post eller lösenord' });
  }
  const payload = { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
  res.json({ user: payload, token });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/auth/me', auth, (req, res) => {
  res.json({ user: req.user });
});

// ── Settings ──
app.get('/api/settings', async (req, res) => {
  const rows = all('SELECT key, value FROM settings');
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

// ── Questions (public) ──
app.get('/api/questions', auth, async (req, res) => {
  const questions = all('SELECT id, text, type, options, points, category, sort_order FROM questions ORDER BY sort_order, id');
  questions.forEach(q => {
    if (q.options) q.options = JSON.parse(q.options);
  });
  res.json(questions);
});

// ── Answers ──
app.get('/api/answers', auth, async (req, res) => {
  const answers = all('SELECT question_id, answer FROM answers WHERE user_id = ?', [req.user.id]);
  res.json(answers);
});

app.post('/api/answers', auth, async (req, res) => {
  // Check deadline
  const settings = {};
  all('SELECT key, value FROM settings').forEach(r => { settings[r.key] = r.value; });

  if (settings.locked === '1') return res.status(403).json({ error: 'Poolen är låst' });
  if (new Date(settings.deadline) < new Date()) return res.status(403).json({ error: 'Deadline har passerat' });

  const { answers } = req.body; // [{ question_id, answer }]
  if (!Array.isArray(answers)) return res.status(400).json({ error: 'Ogiltigt format' });

  for (const a of answers) {
    const existing = get('SELECT id FROM answers WHERE user_id = ? AND question_id = ?', [req.user.id, a.question_id]);
    if (existing) {
      run('UPDATE answers SET answer = ?, submitted_at = datetime("now") WHERE user_id = ? AND question_id = ?',
        [a.answer, req.user.id, a.question_id]);
    } else {
      run('INSERT INTO answers (user_id, question_id, answer) VALUES (?, ?, ?)',
        [req.user.id, a.question_id, a.answer]);
    }
  }
  res.json({ ok: true });
});

// ── Results (my answers vs correct) ──
app.get('/api/results', auth, async (req, res) => {
  const rows = all(`
    SELECT q.id, q.text, q.type, q.options, q.points, q.correct_answer, q.category,
           a.answer as my_answer
    FROM questions q
    LEFT JOIN answers a ON a.question_id = q.id AND a.user_id = ?
    ORDER BY q.sort_order, q.id
  `, [req.user.id]);

  let totalPoints = 0;
  let earnedPoints = 0;

  const results = rows.map(r => {
    if (r.options) r.options = JSON.parse(r.options);
    totalPoints += r.points;
    let correct = null;
    if (r.correct_answer !== null) {
      correct = r.my_answer === r.correct_answer;
      if (correct) earnedPoints += r.points;
    }
    return { ...r, correct };
  });

  res.json({ results, totalPoints, earnedPoints });
});

// ── Leaderboard ──
app.get('/api/leaderboard', async (req, res) => {
  const users = all('SELECT id, name FROM users WHERE is_admin = 0 OR (SELECT COUNT(*) FROM answers WHERE user_id = users.id) > 0');
  const questions = all('SELECT id, points, correct_answer FROM questions');

  const board = users.map(u => {
    const answers = all('SELECT question_id, answer FROM answers WHERE user_id = ?', [u.id]);
    let earned = 0;
    let answered = answers.length;
    let correctCount = 0;

    answers.forEach(a => {
      const q = questions.find(q => q.id === a.question_id);
      if (q && q.correct_answer !== null && a.answer === q.correct_answer) {
        earned += q.points;
        correctCount++;
      }
    });

    return { name: u.name, points: earned, answered, correctCount };
  });

  board.sort((a, b) => b.points - a.points);
  res.json(board);
});

// ══════════════════════════════════
// ── Admin routes ──
// ══════════════════════════════════

app.get('/api/admin/questions', adminAuth, async (req, res) => {
  const questions = all('SELECT * FROM questions ORDER BY sort_order, id');
  questions.forEach(q => {
    if (q.options) q.options = JSON.parse(q.options);
  });
  res.json(questions);
});

app.post('/api/admin/questions', adminAuth, async (req, res) => {
  const { text, type, options, points, category, sort_order } = req.body;
  if (!text || !type) return res.status(400).json({ error: 'Text och typ krävs' });
  run('INSERT INTO questions (text, type, options, points, category, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    [text, type, options ? JSON.stringify(options) : null, points || 1, category || null, sort_order || 0]);
  res.json({ ok: true });
});

app.put('/api/admin/questions/:id', adminAuth, async (req, res) => {
  const { text, type, options, points, correct_answer, category, sort_order } = req.body;
  const q = get('SELECT id FROM questions WHERE id = ?', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Frågan hittades inte' });

  run(`UPDATE questions SET text = ?, type = ?, options = ?, points = ?, correct_answer = ?, category = ?, sort_order = ? WHERE id = ?`,
    [text, type, options ? JSON.stringify(options) : null, points || 1, correct_answer || null, category || null, sort_order || 0, req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/admin/questions/:id', adminAuth, async (req, res) => {
  run('DELETE FROM answers WHERE question_id = ?', [req.params.id]);
  run('DELETE FROM questions WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

app.put('/api/admin/settings', adminAuth, async (req, res) => {
  const { pool_name, deadline, locked } = req.body;
  if (pool_name !== undefined) run("INSERT OR REPLACE INTO settings (key, value) VALUES ('pool_name', ?)", [pool_name]);
  if (deadline !== undefined) run("INSERT OR REPLACE INTO settings (key, value) VALUES ('deadline', ?)", [deadline]);
  if (locked !== undefined) run("INSERT OR REPLACE INTO settings (key, value) VALUES ('locked', ?)", [locked ? '1' : '0']);
  res.json({ ok: true });
});

app.get('/api/admin/users', adminAuth, async (req, res) => {
  const users = all('SELECT id, name, email, is_admin, created_at FROM users ORDER BY created_at');
  res.json(users);
});

app.put('/api/admin/users/:id/toggle-admin', adminAuth, async (req, res) => {
  const user = get('SELECT id, is_admin FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Användare hittades inte' });
  run('UPDATE users SET is_admin = ? WHERE id = ?', [user.is_admin ? 0 : 1, req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', adminAuth, async (req, res) => {
  if (req.params.id == req.user.id) return res.status(400).json({ error: 'Du kan inte ta bort dig själv' });
  run('DELETE FROM answers WHERE user_id = ?', [req.params.id]);
  run('DELETE FROM users WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ── SPA fallback ──
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──
(async () => {
  await getDb();
  app.listen(PORT, () => {
    console.log(`Masters Pool running on http://localhost:${PORT}`);
  });
})();
