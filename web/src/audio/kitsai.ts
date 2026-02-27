import type { TrackRole } from '../db/models';

const ROLE_KEYWORDS: Partial<Record<TrackRole, string[]>> = {
  guitar: ['guitar'],
  bass: ['bass'],
  drums: ['drum', 'percussion'],
  piano: ['piano', 'keys'],
  synth: ['synth', 'synthesizer'],
  strings: ['string', 'violin', 'cello'],
};

export interface VoiceModel {
  id: number;
  title: string;
  tags?: string[];
}

export interface TransformOptions {
  voiceModelId: number;
  conversionStrength?: number; // 0-1, default 0.5
  modelVolumeMix?: number;    // 0-1, default 0.5
  pitchShift?: number;        // -24 to 24 semitones
}

let cachedModels: Map<TrackRole, number> | null = null;
let cachedAllModels: VoiceModel[] | null = null;

async function fetchInstrumentModels(): Promise<Map<TrackRole, number>> {
  const models = await fetchAllModels();
  const roleMap = new Map<TrackRole, number>();

  for (const model of models) {
    const searchText = [
      model.title?.toLowerCase() ?? '',
      ...(model.tags?.map((t) => t.toLowerCase()) ?? []),
    ].join(' ');

    for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
      if (roleMap.has(role as TrackRole)) continue;
      if (role === 'bass' && searchText.includes('bassoon')) continue;
      if (keywords!.some((kw) => searchText.includes(kw))) {
        roleMap.set(role as TrackRole, model.id);
      }
    }
    if (roleMap.size >= Object.keys(ROLE_KEYWORDS).length) break;
  }

  return roleMap;
}

/** Fetch all available instrument voice models from Kits.AI */
export async function fetchAllModels(): Promise<VoiceModel[]> {
  if (cachedAllModels) return cachedAllModels;
  const resp = await fetch('/api/kits/models');
  if (!resp.ok) throw new Error(`Failed to fetch models: ${resp.status}`);
  cachedAllModels = await resp.json();
  return cachedAllModels!;
}

async function getModelId(role: TrackRole): Promise<number | null> {
  if (!cachedModels) {
    cachedModels = await fetchInstrumentModels();
  }
  return cachedModels.get(role) ?? null;
}

/** Convert browser audio blob (webm/ogg) to WAV for the KITS API */
async function blobToWav(blob: Blob): Promise<Blob> {
  const audioCtx = new AudioContext();
  const arrayBuffer = await blob.arrayBuffer();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  const numCh = audioBuffer.numberOfChannels;
  const rate = audioBuffer.sampleRate;
  const length = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = length * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);

  // RIFF header
  writeStr(v, 0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  writeStr(v, 8, 'WAVE');
  // fmt chunk
  writeStr(v, 12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, numCh, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, 16, true);
  // data chunk
  writeStr(v, 36, 'data');
  v.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numCh; ch++) {
    channels.push(audioBuffer.getChannelData(ch));
  }

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      v.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }

  audioCtx.close();
  return new Blob([buf], { type: 'audio/wav' });
}

function writeStr(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

const POLL_INTERVAL = 3000;
const MAX_POLLS = 60;

/**
 * Transforms audio using KITS.AI voice conversion.
 * Converts browser audio to WAV, uploads it, polls for completion,
 * and returns the converted audio as a Blob.
 */
export async function transformAudio(
  audioBlob: Blob,
  role: TrackRole,
  onStatus?: (msg: string) => void,
  signal?: AbortSignal
): Promise<Blob> {
  if (role === 'vocals' || role === 'other') return audioBlob;

  signal?.throwIfAborted();

  onStatus?.('Finding instrument model...');
  const modelId = await getModelId(role);
  if (modelId === null) {
    console.warn(`No voice model for ${role}, using raw audio`);
    return audioBlob;
  }

  signal?.throwIfAborted();

  onStatus?.('Preparing audio...');
  const wavBlob = await blobToWav(audioBlob);

  signal?.throwIfAborted();

  onStatus?.('Uploading audio...');
  const createResp = await fetch(
    `/api/kits/convert?voiceModelId=${modelId}`,
    { method: 'POST', body: wavBlob, signal }
  );
  if (!createResp.ok) {
    throw new Error(`Conversion request failed: ${await createResp.text()}`);
  }

  const job = await createResp.json();
  const jobId = job.id;
  if (!jobId) throw new Error('No job ID returned');

  onStatus?.('AI is transforming your audio...');

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => {
      const timer = setTimeout(r, POLL_INTERVAL);
      signal?.addEventListener('abort', () => { clearTimeout(timer); r(undefined); }, { once: true });
    });

    signal?.throwIfAborted();

    const pollResp = await fetch(`/api/kits/convert/${jobId}`, { signal });
    if (!pollResp.ok) continue;

    const data = await pollResp.json();

    if (data.status === 'completed' || data.status === 'success') {
      const outputUrl = data.outputFileUrl || data.outputUrl;
      if (!outputUrl) throw new Error('No output URL in completed job');

      onStatus?.('Downloading converted audio...');
      const dlResp = await fetch(
        `/api/kits/download?url=${encodeURIComponent(outputUrl)}`,
        { signal }
      );
      if (!dlResp.ok) throw new Error('Failed to download converted audio');
      return await dlResp.blob();
    }

    if (data.status === 'failed' || data.status === 'error') {
      throw new Error(`Conversion failed: ${data.error || 'Unknown error'}`);
    }
  }

  throw new Error('Conversion timed out');
}

/**
 * Re-transform audio with user-specified options (model, strength, volume mix, pitch).
 */
export async function reTransformAudio(
  audioBlob: Blob,
  options: TransformOptions,
  onStatus?: (msg: string) => void,
  signal?: AbortSignal
): Promise<Blob> {
  signal?.throwIfAborted();

  onStatus?.('Preparing audio...');
  const wavBlob = await blobToWav(audioBlob);

  signal?.throwIfAborted();

  const params = new URLSearchParams();
  params.set('voiceModelId', String(options.voiceModelId));
  if (options.conversionStrength !== undefined) params.set('conversionStrength', String(options.conversionStrength));
  if (options.modelVolumeMix !== undefined) params.set('modelVolumeMix', String(options.modelVolumeMix));
  if (options.pitchShift !== undefined && options.pitchShift !== 0) params.set('pitchShift', String(options.pitchShift));

  onStatus?.('Uploading audio...');
  const createResp = await fetch(`/api/kits/convert?${params.toString()}`, {
    method: 'POST',
    body: wavBlob,
    signal,
  });
  if (!createResp.ok) {
    throw new Error(`Conversion request failed: ${await createResp.text()}`);
  }

  const job = await createResp.json();
  const jobId = job.id;
  if (!jobId) throw new Error('No job ID returned');

  onStatus?.('AI is transforming your audio...');

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => {
      const timer = setTimeout(r, POLL_INTERVAL);
      signal?.addEventListener('abort', () => { clearTimeout(timer); r(undefined); }, { once: true });
    });

    signal?.throwIfAborted();

    const pollResp = await fetch(`/api/kits/convert/${jobId}`, { signal });
    if (!pollResp.ok) continue;

    const data = await pollResp.json();

    if (data.status === 'completed' || data.status === 'success') {
      const outputUrl = data.outputFileUrl || data.outputUrl;
      if (!outputUrl) throw new Error('No output URL in completed job');

      onStatus?.('Downloading converted audio...');
      const dlResp = await fetch(
        `/api/kits/download?url=${encodeURIComponent(outputUrl)}`,
        { signal }
      );
      if (!dlResp.ok) throw new Error('Failed to download converted audio');
      return await dlResp.blob();
    }

    if (data.status === 'failed' || data.status === 'error') {
      throw new Error(`Conversion failed: ${data.error || 'Unknown error'}`);
    }
  }

  throw new Error('Conversion timed out');
}
