import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;

const KITS_API = 'https://arpeggi.io/api/kits/v1';
const KITS_KEY = process.env.KITS_API_KEY || 'Q-Vgzw2B.mCWit1ka3N8IGb6S5q0dKYRj';

// --- KITS.AI API Proxy ---

// Fetch instrument voice models
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

// Create a voice conversion job — accepts raw WAV body, voiceModelId in query
app.post(
  '/api/kits/convert',
  express.raw({ type: '*/*', limit: '100mb' }),
  async (req, res) => {
    try {
      const { voiceModelId } = req.query;
      if (!voiceModelId || !req.body?.length) {
        return res
          .status(400)
          .json({ error: 'voiceModelId and audio body required' });
      }
      const form = new FormData();
      form.append('voiceModelId', String(voiceModelId));
      form.append(
        'soundFile',
        new Blob([req.body], { type: 'audio/wav' }),
        'recording.wav'
      );
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

// Poll voice conversion job status
app.get('/api/kits/convert/:id', async (req, res) => {
  try {
    const r = await fetch(
      `${KITS_API}/voice-conversions/${req.params.id}`,
      { headers: { Authorization: `Bearer ${KITS_KEY}` } }
    );
    const json = await r.json();
    res.status(r.status).json(json);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy download of converted audio (avoids CORS issues)
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
