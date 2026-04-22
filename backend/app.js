import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'study_planner.json');
const SECRET_KEY = process.env.SECRET_KEY || 'dev-secret-key-12345';

const adapter = new JSONFile(DB_PATH);
const db = new Low(adapter);

async function start() {
  try {
    await db.read();
    if (!db.data) {
      db.data = {
        users: [],
        study_plans: [],
        user_progress: [],
        study_notes: [],
        study_sessions: [],
      };
    }

    await seedDemoUser();

    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
      console.log(`Backend running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}


function getNextId(collection) {
  const items = db.data[collection] || [];
  return items.length > 0 ? Math.max(...items.map((item) => item.id)) + 1 : 1;
}

async function saveDb() {
  await db.write();
}

function createToken(userId) {
  return jwt.sign({ user_id: userId }, SECRET_KEY, { expiresIn: '7d' });
}

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token missing' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, SECRET_KEY);
    req.userId = payload.user_id;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function seedDemoUser() {
  const demoUser = db.data.users.find((user) => user.username === 'demo');
  if (!demoUser) {
    db.data.users.push({
      id: getNextId('users'),
      username: 'demo',
      email: 'demo@example.com',
      password: bcrypt.hashSync('123456', 10),
      created_at: new Date().toISOString(),
    });
    await saveDb();
  }
}

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body || {};

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const existingUsername = db.data.users.find((user) => user.username === username);
  if (existingUsername) {
    return res.status(400).json({ error: 'Username already exists' });
  }

  const existingEmail = db.data.users.find((user) => user.email === email);
  if (existingEmail) {
    return res.status(400).json({ error: 'Email already exists' });
  }

  const newUser = {
    id: getNextId('users'),
    username,
    email,
    password: bcrypt.hashSync(password, 10),
    created_at: new Date().toISOString(),
  };

  db.data.users.push(newUser);
  await saveDb();

  const token = createToken(newUser.id);
  return res.status(201).json({
    message: 'User created successfully',
    token,
    user: { id: newUser.id, username: newUser.username },
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.data.users.find(
    (item) => item.username === username || item.email === username
  );

  if (!user || !bcrypt.compareSync(password || '', user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = createToken(user.id);
  return res.status(200).json({
    message: 'Login successful',
    token,
    user: { id: user.id, username: user.username },
  });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'healthy', message: 'Backend is running' });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', message: 'Backend is running' });
});

app.get('/api/plans', authenticate, (req, res) => {
  const plans = db.data.study_plans
    .filter((plan) => plan.user_id === req.userId)
    .map((plan) => ({
      id: plan.id,
      subject: plan.subject,
      level: plan.level,
      days: plan.days,
      hours_per_day: plan.hours_per_day,
      completion_percentage: plan.completion_percentage,
      created_at: plan.created_at,
    }));

  return res.json(plans);
});

app.post('/api/generate-plan', async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const data = req.body || {};
  const subject = data.subject || 'DSA';
  const days = Number(data.days || 7);
  const hours = Number(data.hours || 2);
  const level = data.level || 'Beginner';

  const planData = Array.from({ length: days }, (_, i) => ({
    day: i + 1,
    topics: Array.from({ length: 2 }, (_, j) => ({
      name: `Topic ${j + 1}`,
      completed: false,
      hours,
    })),
  }));

  const now = new Date().toISOString();
  const newPlan = {
    id: getNextId('study_plans'),
    user_id: userId,
    subject,
    level,
    days,
    hours_per_day: hours,
    plan_data: planData,
    completion_percentage: 0,
    created_at: now,
    updated_at: now,
  };

  db.data.study_plans.push(newPlan);
  await saveDb();

  return res.status(201).json({
    id: newPlan.id,
    subject,
    level,
    days,
    plan: planData,
    total_hours: days * hours,
  });
});

app.post('/api/plans/:plan_id/progress', authenticate, async (req, res) => {
  const planId = Number(req.params.plan_id);
  const plan = db.data.study_plans.find(
    (item) => item.id === planId && item.user_id === req.userId
  );

  if (!plan) {
    return res.status(404).json({ error: 'Plan not found' });
  }

  const data = req.body || {};
  const day = Number(data.day);
  const topic = data.topic || '';
  const completed = data.completed ? 1 : 0;
  const timeSpent = Number(data.time_spent || 0);

  db.data.user_progress.push({
    id: getNextId('user_progress'),
    plan_id: planId,
    day,
    topic,
    completed,
    time_spent: timeSpent,
    created_at: new Date().toISOString(),
  });

  const totalTopics = plan.plan_data.reduce(
    (sum, row) => sum + (row.topics?.length || 0),
    0
  );
  const completedTopics = db.data.user_progress.filter(
    (entry) => entry.plan_id === planId && entry.completed === 1
  ).length;

  plan.completion_percentage = totalTopics > 0 ? (completedTopics / totalTopics) * 100 : 0;
  plan.updated_at = new Date().toISOString();
  await saveDb();

  return res.json({
    message: 'Progress updated',
    completion_percentage: plan.completion_percentage,
  });
});

start();
