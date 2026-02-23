/**
 * Audio buffer manipulation utilities for region editing operations.
 * Supports decode, encode (WAV), delete, copy, and insert operations.
 */

export async function decodeBlob(blob: Blob): Promise<AudioBuffer | null> {
  const ctx = new AudioContext();
  try {
    const ab = await blob.arrayBuffer();
    const buf = await ctx.decodeAudioData(ab);
    ctx.close();
    return buf;
  } catch {
    ctx.close();
    return null;
  }
}

export function encodeToWav(buffer: AudioBuffer): Blob {
  const numCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = len * blockAlign;
  const headerSize = 44;
  const arrayBuf = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(arrayBuf);

  writeStr(view, 0, 'RIFF');
  view.setUint32(4, headerSize + dataSize - 8, true);
  writeStr(view, 8, 'WAVE');
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numCh; ch++) channels.push(buffer.getChannelData(ch));

  let offset = headerSize;
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, s * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuf], { type: 'audio/wav' });
}

function writeStr(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

/** Default crossfade duration in seconds at edit points */
const CROSSFADE_DURATION = 0.01; // 10ms

export function deleteRegion(buffer: AudioBuffer, startTime: number, endTime: number): AudioBuffer {
  const sr = buffer.sampleRate;
  const s0 = Math.max(0, Math.floor(startTime * sr));
  const s1 = Math.min(buffer.length, Math.floor(endTime * sr));
  const cutLen = s1 - s0;
  if (cutLen <= 0) return buffer;

  const newLen = Math.max(1, buffer.length - cutLen);
  const out = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: newLen, sampleRate: sr });

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < s0; i++) dst[i] = src[i];
    for (let i = s1; i < buffer.length; i++) dst[i - cutLen] = src[i];
  }

  // Apply crossfade at the edit point to prevent clicks
  applyCrossfadeAt(out, s0, CROSSFADE_DURATION);

  return out;
}

/**
 * Apply a short equal-power crossfade at a sample position to eliminate clicks.
 * Fades out samples before the point and fades in samples after.
 */
function applyCrossfadeAt(buffer: AudioBuffer, samplePos: number, durationSec: number): void {
  const fadeLen = Math.min(
    Math.floor(durationSec * buffer.sampleRate),
    samplePos,
    buffer.length - samplePos
  );
  if (fadeLen <= 0) return;

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < fadeLen; i++) {
      const t = i / fadeLen;
      // Equal-power: fade out before, fade in after
      data[samplePos - fadeLen + i] *= Math.cos(t * Math.PI * 0.5);
      data[samplePos + i] *= Math.sin(t * Math.PI * 0.5);
    }
  }
}

export function copyRegion(buffer: AudioBuffer, startTime: number, endTime: number): AudioBuffer {
  const sr = buffer.sampleRate;
  const s0 = Math.max(0, Math.floor(startTime * sr));
  const s1 = Math.min(buffer.length, Math.floor(endTime * sr));
  const len = Math.max(1, s1 - s0);

  const out = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: len, sampleRate: sr });

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < len && s0 + i < buffer.length; i++) dst[i] = src[s0 + i];
  }

  return out;
}

export function insertRegion(buffer: AudioBuffer, insert: AudioBuffer, atTime: number): AudioBuffer {
  const sr = buffer.sampleRate;
  const at = Math.max(0, Math.min(buffer.length, Math.floor(atTime * sr)));
  const newLen = buffer.length + insert.length;
  const numCh = buffer.numberOfChannels;

  const out = new AudioBuffer({ numberOfChannels: numCh, length: newLen, sampleRate: sr });

  for (let ch = 0; ch < numCh; ch++) {
    const src = buffer.getChannelData(ch);
    const ins = ch < insert.numberOfChannels ? insert.getChannelData(ch) : new Float32Array(insert.length);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < at; i++) dst[i] = src[i];
    for (let i = 0; i < insert.length; i++) dst[at + i] = ins[i];
    for (let i = at; i < buffer.length; i++) dst[i + insert.length] = src[i];
  }

  // Crossfade at both splice points to prevent clicks
  applyCrossfadeAt(out, at, CROSSFADE_DURATION);
  applyCrossfadeAt(out, at + insert.length, CROSSFADE_DURATION);

  return out;
}
