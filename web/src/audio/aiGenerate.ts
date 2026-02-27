import type { TrackRole } from '../db/models';

export interface AiGenerateOptions {
  instrument: TrackRole;
  bpm: number;
  key?: string;
  scale?: string;
  durationSeconds: number;
  /** Base64-encoded WAV of existing tracks mixed together */
  existingTracksAudio?: string;
}

/**
 * Calls the server to generate a single-instrument AI track
 * using Gemini (analysis) + Lyria RealTime (generation).
 *
 * Returns the generated audio as a Blob.
 */
export async function generateAiTrack(
  options: AiGenerateOptions,
  onStatus?: (msg: string) => void,
  signal?: AbortSignal
): Promise<Blob> {
  signal?.throwIfAborted();

  onStatus?.('Sending to AI...');

  const resp = await fetch('/api/ai/generate-track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instrument: options.instrument,
      bpm: options.bpm,
      key: options.key,
      scale: options.scale,
      durationSeconds: options.durationSeconds,
      existingTracksAudio: options.existingTracksAudio,
    }),
    signal,
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || `AI generation failed: ${resp.status}`);
  }

  onStatus?.('Receiving generated audio...');
  return await resp.blob();
}

/**
 * Mix existing track blobs into a single WAV and return as base64.
 * Uses OfflineAudioContext to render a mixdown of all tracks.
 */
export async function mixTracksToBase64(
  trackBlobs: Blob[],
  onStatus?: (msg: string) => void
): Promise<{ base64: string; duration: number }> {
  onStatus?.('Preparing existing tracks for AI analysis...');

  const ctx = new AudioContext();
  const decoded: AudioBuffer[] = [];

  for (const blob of trackBlobs) {
    if (blob.size === 0) continue;
    try {
      const ab = await blob.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab);
      decoded.push(buf);
    } catch {
      // Skip undecodable tracks
    }
  }
  ctx.close();

  if (decoded.length === 0) {
    return { base64: '', duration: 30 };
  }

  const sampleRate = decoded[0].sampleRate;
  const maxDuration = Math.max(...decoded.map(b => b.duration));
  const totalFrames = Math.ceil(maxDuration * sampleRate);

  const offline = new OfflineAudioContext(2, totalFrames, sampleRate);
  for (const buf of decoded) {
    const source = offline.createBufferSource();
    source.buffer = buf;
    source.connect(offline.destination);
    source.start(0);
  }

  const rendered = await offline.startRendering();

  // Encode to WAV, then base64
  const wavBlob = encodeWav(rendered);
  const arrayBuffer = await wavBlob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  return { base64, duration: maxDuration };
}

function encodeWav(buffer: AudioBuffer): Blob {
  const numCh = buffer.numberOfChannels;
  const rate = buffer.sampleRate;
  const length = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = length * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) v.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, numCh, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, 16, true);
  writeStr(36, 'data');
  v.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numCh; ch++) channels.push(buffer.getChannelData(ch));

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      v.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buf], { type: 'audio/wav' });
}
