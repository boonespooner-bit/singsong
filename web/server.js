import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;

const KITS_API = 'https://arpeggi.io/api/kits/v1';
const KITS_KEY = process.env.KITS_API_KEY || 'Q-Vgzw2B.mCWit1ka3N8IGb6S5q0dKYRj';
const JWT_SECRET = process.env.JWT_SECRET || 'singsong-jwt-secret-change-in-prod';
const GOOGLE_CLIENT_ID = '214965469628-3ijidrc12jl600m8d13nk73k8502fvvr.apps.googleusercontent.com';

// In-memory user store (use a real DB in production)
const users = new Map();
let nextUserId = 1;

// --- Auth helpers ---
function generateToken(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
}

function sanitizeUser(user) {
  return { id: user.id, email: user.email, name: user.name };
}

// --- Auth endpoints ---
app.use('/api/auth', express.json());

// Google Sign-In: verify Google ID token and create/login user
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Missing credential' });

    // Verify with Google's tokeninfo endpoint
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    if (!r.ok) return res.status(401).json({ error: 'Invalid Google token' });

    const payload = await r.json();
    if (payload.aud !== GOOGLE_CLIENT_ID) {
      return res.status(401).json({ error: 'Token audience mismatch' });
    }

    const googleId = payload.sub;
    const email = payload.email;
    const name = payload.name || payload.email;

    // Find or create user
    let user = [...users.values()].find((u) => u.googleId === googleId || u.email === email);
    if (!user) {
      user = { id: nextUserId++, email, name, googleId, passwordHash: null };
      users.set(user.id, user);
    } else if (!user.googleId) {
      user.googleId = googleId;
    }

    const token = generateToken(user);
    res.json({ token, user: sanitizeUser(user) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Email/password registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = [...users.values()].find((u) => u.email === email);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const user = { id: nextUserId++, email, name, googleId: null, passwordHash };
    users.set(user.id, user);

    const token = generateToken(user);
    res.json({ token, user: sanitizeUser(user) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Email/password login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = [...users.values()].find((u) => u.email === email);
    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!bcrypt.compareSync(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = generateToken(user);
    res.json({ token, user: sanitizeUser(user) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get current user from token
app.get('/api/auth/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token' });
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
    const user = users.get(payload.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({ user: sanitizeUser(user) });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// --- KITS.AI API Proxy ---

app.get('/api/kits/models', async (_req, res) => {
  try {
    const allModels = [];
    for (let page = 1; page <= 5; page++) {
      const r = await fetch(
        `${KITS_API}/voice-models?page=${page}&perPage=50&instruments=true`,
        { headers: { Authorization: `Bearer ${KITS_KEY}` } }
      );
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      const json = await r.json();
      const data = Array.isArray(json) ? json : json.data ?? [];
      if (data.length === 0) break;
      allModels.push(...data);
    }
    res.json(allModels);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post(
  '/api/kits/convert',
  express.raw({ type: '*/*', limit: '100mb' }),
  async (req, res) => {
    try {
      const { voiceModelId } = req.query;
      if (!voiceModelId || !req.body?.length) {
        return res.status(400).json({ error: 'voiceModelId and audio body required' });
      }
      const form = new FormData();
      form.append('voiceModelId', String(voiceModelId));
      form.append('soundFile', new Blob([req.body], { type: 'audio/wav' }), 'recording.wav');
      form.append('conversionStrength', '0.5');
      form.append('modelVolumeMix', '0.5');

      const r = await fetch(`${KITS_API}/voice-conversions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KITS_KEY}` },
        body: form,
      });
      const json = await r.json();
      res.status(r.status).json(json);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

app.get('/api/kits/convert/:id', async (req, res) => {
  try {
    const r = await fetch(`${KITS_API}/voice-conversions/${req.params.id}`, {
      headers: { Authorization: `Bearer ${KITS_KEY}` },
    });
    const json = await r.json();
    res.status(r.status).json(json);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/kits/download', async (req, res) => {
  try {
    const url = String(req.query.url || '');
    if (!url) return res.status(400).json({ error: 'url parameter required' });
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).json({ error: 'Download failed' });
    res.set('Content-Type', r.headers.get('content-type') || 'audio/wav');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Static files + SPA fallback ---
app.use(express.static(join(__dirname, 'dist')));

app.get('/{*splat}', (_req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

app.listen(port, () => {
  console.log(`SingSong running on port ${port}`);
});
