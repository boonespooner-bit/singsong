import type { Track } from '../db/models';

/**
 * Renders all tracks into a single WAV file using OfflineAudioContext.
 */
export async function mixdownToWav(
  tracks: Track[],
  getAudioBlob: (trackId: number) => Promise<Blob | undefined>,
  onProgress?: (msg: string) => void
): Promise<Blob> {
  onProgress?.('Decoding audio tracks...');

  // Decode all track audio
  const tempCtx = new AudioContext();
  const decoded: { track: Track; buffer: AudioBuffer }[] = [];

  for (const track of tracks) {
    if (track.id === undefined) continue;
    const blob = await getAudioBlob(track.id);
    if (!blob || blob.size === 0) continue;
    try {
      const ab = await blob.arrayBuffer();
      const buffer = await tempCtx.decodeAudioData(ab);
      decoded.push({ track, buffer });
    } catch {
      console.warn(`Could not decode track ${track.id}`);
    }
  }
  tempCtx.close();

  if (decoded.length === 0) throw new Error('No audio tracks to mix');

  // Determine mix parameters
  const sampleRate = decoded[0].buffer.sampleRate;
  const maxDuration = Math.max(...decoded.map((d) => d.buffer.duration));
  const totalFrames = Math.ceil(maxDuration * sampleRate);
  const numChannels = Math.max(...decoded.map((d) => d.buffer.numberOfChannels));

  onProgress?.('Mixing tracks...');

  // Create offline context and render
  const offline = new OfflineAudioContext(numChannels, totalFrames, sampleRate);

  for (const { track, buffer } of decoded) {
    const source = offline.createBufferSource();
    source.buffer = buffer;

    const gain = offline.createGain();
    gain.gain.value = track.volume;

    // EQ
    const eqLow = offline.createBiquadFilter();
    eqLow.type = 'lowshelf';
    eqLow.frequency.value = 320;
    eqLow.gain.value = (track.eqBass - 0.5) * 24;

    const eqMid = offline.createBiquadFilter();
    eqMid.type = 'peaking';
    eqMid.frequency.value = 1000;
    eqMid.Q.value = 0.5;
    eqMid.gain.value = (track.eqMids - 0.5) * 24;

    const eqHigh = offline.createBiquadFilter();
    eqHigh.type = 'highshelf';
    eqHigh.frequency.value = 3200;
    eqHigh.gain.value = (track.eqTreble - 0.5) * 24;

    // Compressor
    const comp = offline.createDynamicsCompressor();
    comp.threshold.value = track.compressorEnabled ? -24 : 0;
    comp.ratio.value = track.compressorEnabled ? 4 : 1;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;

    source.connect(gain);
    gain.connect(eqLow);
    eqLow.connect(eqMid);
    eqMid.connect(eqHigh);
    eqHigh.connect(comp);
    comp.connect(offline.destination);

    source.start(0);
  }

  const rendered = await offline.startRendering();

  onProgress?.('Encoding WAV...');
  return encodeWav(rendered);
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
