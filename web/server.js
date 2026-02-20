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

// In-memory collaboration stores
const sharedSongs = new Map();  // shareId -> { shareId, ownerId, ownerName, ownerEmail, data }
const invitations = new Map();  // inviteId -> { id, shareId, songName, fromUserId, fromUserName, fromUserEmail, toEmail, status, createdAt }
const branches = new Map();     // branchId -> { id, shareId, userId, userName, userEmail, data, createdAt, updatedAt }
let nextShareId = 1;
let nextInviteId = 1;
let nextBranchId = 1;

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

// Pitch correction / auto-tune via Kits.AI voice conversion
// Uses the first available vocal model with pitchShift and optional pitch correction params
app.post(
  '/api/kits/pitch-correct',
  express.raw({ type: '*/*', limit: '100mb' }),
  async (req, res) => {
    try {
      if (!req.body?.length) {
        return res.status(400).json({ error: 'Audio body required' });
      }

      // Find a vocal model to use for pitch correction pass-through
      let voiceModelId;
      try {
        const modelsResp = await fetch(
          `${KITS_API}/voice-models?page=1&perPage=10`,
          { headers: { Authorization: `Bearer ${KITS_KEY}` } }
        );
        const modelsJson = await modelsResp.json();
        const models = Array.isArray(modelsJson) ? modelsJson : modelsJson.data ?? [];
        // Prefer a vocal model, otherwise use the first available
        const vocalModel = models.find(m => {
          const t = (m.title || '').toLowerCase();
          return t.includes('vocal') || t.includes('voice') || t.includes('sing');
        });
        voiceModelId = vocalModel?.id || models[0]?.id;
      } catch {
        return res.status(500).json({ error: 'Failed to fetch voice models' });
      }

      if (!voiceModelId) {
        return res.status(500).json({ error: 'No voice models available' });
      }

      const form = new FormData();
      form.append('voiceModelId', String(voiceModelId));
      form.append('soundFile', new Blob([req.body], { type: 'audio/wav' }), 'recording.wav');

      // Set low conversion strength to preserve original voice character
      form.append('conversionStrength', '0.1');
      form.append('modelVolumeMix', '0.2');

      // Pitch shift
      const pitchShift = req.query.pitchShift;
      if (pitchShift && pitchShift !== '0') {
        form.append('pitchShift', String(pitchShift));
      }

      // Pitch correction (key/scale-based auto-tune)
      // The Kits API may accept this as a JSON string in the pitchCorrection field
      const pitchCorrection = req.query.pitchCorrection;
      if (pitchCorrection) {
        try {
          const pc = JSON.parse(String(pitchCorrection));
          // Try the structured form field approach
          form.append('pitchCorrection[key]', pc.key || 'C');
          form.append('pitchCorrection[scale]', pc.scale || 'major');
          form.append('pitchCorrection[strength]', String(pc.strength ?? 0.8));
        } catch {
          // If JSON parse fails, skip pitch correction
        }
      }

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

// --- Collaboration API ---

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
    const user = users.get(payload.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = sanitizeUser(user);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

app.use('/api/collab', express.json({ limit: '200mb' }));

// Publish a song for collaboration (owner uploads song data to server)
app.post('/api/collab/publish', authenticateToken, (req, res) => {
  try {
    const { song, tracks, audioBase64 } = req.body;
    if (!song || !tracks) return res.status(400).json({ error: 'Song data required' });

    // Re-publish to existing share or create new
    const existingShareId = req.query.shareId;
    if (existingShareId && sharedSongs.has(existingShareId)) {
      const existing = sharedSongs.get(existingShareId);
      if (existing.ownerId !== req.user.id) {
        return res.status(403).json({ error: 'Not the owner of this shared song' });
      }
      existing.data = { song, tracks, audioBase64: audioBase64 || {} };
      existing.updatedAt = Date.now();
      return res.json({ shareId: existingShareId });
    }

    const shareId = `share_${nextShareId++}`;
    sharedSongs.set(shareId, {
      shareId,
      ownerId: req.user.id,
      ownerName: req.user.name,
      ownerEmail: req.user.email,
      data: { song, tracks, audioBase64: audioBase64 || {} },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    res.json({ shareId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Invite a collaborator by email
app.post('/api/collab/:shareId/invite', authenticateToken, (req, res) => {
  try {
    const shared = sharedSongs.get(req.params.shareId);
    if (!shared) return res.status(404).json({ error: 'Shared song not found' });
    if (shared.ownerId !== req.user.id) return res.status(403).json({ error: 'Only the owner can invite' });

    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    if (email === req.user.email) return res.status(400).json({ error: 'Cannot invite yourself' });

    // Check for duplicate invitation
    const existing = [...invitations.values()].find(
      (inv) => inv.shareId === req.params.shareId && inv.toEmail === email && inv.status !== 'declined'
    );
    if (existing) return res.status(409).json({ error: 'Invitation already sent to this email' });

    const id = `inv_${nextInviteId++}`;
    invitations.set(id, {
      id,
      shareId: req.params.shareId,
      songName: shared.data.song.name,
      fromUserId: req.user.id,
      fromUserName: req.user.name,
      fromUserEmail: req.user.email,
      toEmail: email,
      status: 'pending',
      createdAt: Date.now(),
    });

    res.json({ id, message: `Invitation sent to ${email}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get collaborators/invitations for a shared song (owner view)
app.get('/api/collab/:shareId/collaborators', authenticateToken, (req, res) => {
  try {
    const shared = sharedSongs.get(req.params.shareId);
    if (!shared) return res.status(404).json({ error: 'Not found' });
    if (shared.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const collabs = [...invitations.values()].filter((inv) => inv.shareId === req.params.shareId);
    res.json(collabs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get my pending invitations (invitee view)
app.get('/api/collab/invitations', authenticateToken, (req, res) => {
  try {
    const mine = [...invitations.values()].filter(
      (inv) => inv.toEmail === req.user.email && inv.status === 'pending'
    );
    res.json(mine);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Accept an invitation
app.post('/api/collab/invitations/:id/accept', authenticateToken, (req, res) => {
  try {
    const inv = invitations.get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invitation not found' });
    if (inv.toEmail !== req.user.email) return res.status(403).json({ error: 'Not your invitation' });
    if (inv.status !== 'pending') return res.status(400).json({ error: 'Invitation already ' + inv.status });

    inv.status = 'accepted';

    const shared = sharedSongs.get(inv.shareId);
    if (!shared) return res.status(404).json({ error: 'Shared song no longer exists' });

    // Create a branch for this collaborator (copy of current song data)
    const branchId = `branch_${nextBranchId++}`;
    branches.set(branchId, {
      id: branchId,
      shareId: inv.shareId,
      userId: req.user.id,
      userName: req.user.name,
      userEmail: req.user.email,
      data: JSON.parse(JSON.stringify(shared.data)), // deep copy
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    res.json({ branchId, shareId: inv.shareId, data: shared.data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Decline an invitation
app.post('/api/collab/invitations/:id/decline', authenticateToken, (req, res) => {
  try {
    const inv = invitations.get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invitation not found' });
    if (inv.toEmail !== req.user.email) return res.status(403).json({ error: 'Not your invitation' });

    inv.status = 'declined';
    res.json({ message: 'Invitation declined' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sync a branch (collaborator uploads their latest changes)
app.post('/api/collab/branches/:branchId/sync', authenticateToken, (req, res) => {
  try {
    const branch = branches.get(req.params.branchId);
    if (!branch) return res.status(404).json({ error: 'Branch not found' });
    if (branch.userId !== req.user.id) return res.status(403).json({ error: 'Not your branch' });

    const { song, tracks, audioBase64 } = req.body;
    if (!song || !tracks) return res.status(400).json({ error: 'Song data required' });

    branch.data = { song, tracks, audioBase64: audioBase64 || {} };
    branch.updatedAt = Date.now();
    res.json({ message: 'Branch synced' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List branches for a shared song (owner view)
app.get('/api/collab/:shareId/branches', authenticateToken, (req, res) => {
  try {
    const shared = sharedSongs.get(req.params.shareId);
    if (!shared) return res.status(404).json({ error: 'Not found' });
    if (shared.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const songBranches = [...branches.values()]
      .filter((b) => b.shareId === req.params.shareId)
      .map((b) => ({
        id: b.id,
        shareId: b.shareId,
        userName: b.userName,
        userEmail: b.userEmail,
        trackCount: b.data.tracks?.length ?? 0,
        updatedAt: b.updatedAt,
      }));
    res.json(songBranches);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get full branch detail (owner view)
app.get('/api/collab/branches/:branchId', authenticateToken, (req, res) => {
  try {
    const branch = branches.get(req.params.branchId);
    if (!branch) return res.status(404).json({ error: 'Branch not found' });

    // Allow owner of shared song or branch owner to view
    const shared = sharedSongs.get(branch.shareId);
    if (!shared) return res.status(404).json({ error: 'Shared song not found' });
    if (shared.ownerId !== req.user.id && branch.userId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const tracks = (branch.data.tracks || []).map((t, i) => ({ ...t, index: i }));
    res.json({
      id: branch.id,
      shareId: branch.shareId,
      userName: branch.userName,
      userEmail: branch.userEmail,
      songName: branch.data.song?.name || 'Untitled',
      tracks,
      audioBase64: branch.data.audioBase64 || {},
      trackCount: tracks.length,
      updatedAt: branch.updatedAt,
    });
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
