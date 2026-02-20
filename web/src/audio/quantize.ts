/**
 * Audio quantization: detects transient onsets in audio and aligns them
 * to the nearest beat grid positions based on BPM and note resolution.
 *
 * Uses energy-based onset detection with adaptive thresholding,
 * then time-warps segments between onsets via linear interpolation
 * to align transients to the grid.
 */

export type QuantizeResolution = 4 | 8 | 16 | 32;

interface Onset {
  time: number;
  sample: number;
}

/**
 * Detect transient onsets using spectral flux (energy rise).
 * Returns an array of onset positions in the audio.
 */
function detectOnsets(buffer: AudioBuffer, sensitivity: number): Onset[] {
  // Mix to mono for analysis
  const sr = buffer.sampleRate;
  const mono = buffer.getChannelData(0);

  // ~10ms analysis window, 50% overlap
  const windowSize = Math.floor(sr * 0.01);
  const hopSize = Math.floor(windowSize / 2);
  const numWindows = Math.floor((mono.length - windowSize) / hopSize);
  if (numWindows < 2) return [];

  // RMS energy per window
  const energy = new Float32Array(numWindows);
  for (let w = 0; w < numWindows; w++) {
    const start = w * hopSize;
    let sum = 0;
    for (let i = 0; i < windowSize; i++) {
      const s = mono[start + i];
      sum += s * s;
    }
    energy[w] = Math.sqrt(sum / windowSize);
  }

  // Spectral flux: positive differences only (energy rises = transients)
  const flux = new Float32Array(numWindows);
  for (let w = 1; w < numWindows; w++) {
    flux[w] = Math.max(0, energy[w] - energy[w - 1]);
  }

  // Adaptive threshold with running median + sensitivity scaling
  const threshWin = Math.max(1, Math.floor(0.1 * sr / hopSize)); // ~100ms context
  const minGapWindows = Math.max(1, Math.floor(0.05 * sr / hopSize)); // 50ms min gap

  const onsets: Onset[] = [];
  let lastOnsetW = -minGapWindows;

  for (let w = 1; w < numWindows; w++) {
    // Local mean of flux for adaptive threshold
    const lo = Math.max(0, w - threshWin);
    const hi = Math.min(numWindows, w + threshWin);
    let mean = 0;
    for (let i = lo; i < hi; i++) mean += flux[i];
    mean /= (hi - lo);

    // Threshold: lower sensitivity = higher threshold = fewer onsets
    const thresh = mean * (2.5 - sensitivity * 2.0);

    if (
      flux[w] > thresh &&
      flux[w] > 0.002 &&
      w - lastOnsetW >= minGapWindows
    ) {
      // Local maximum check
      if (flux[w] >= flux[w - 1] && (w + 1 >= numWindows || flux[w] >= flux[w + 1])) {
        const sampleIdx = w * hopSize;
        onsets.push({ time: sampleIdx / sr, sample: sampleIdx });
        lastOnsetW = w;
      }
    }
  }

  return onsets;
}

/**
 * Quantize audio by aligning detected onsets to beat grid positions.
 *
 * @param buffer - Source AudioBuffer to quantize
 * @param bpm - Tempo in beats per minute
 * @param resolution - Grid resolution (4=quarter, 8=eighth, 16=sixteenth, 32=thirty-second)
 * @param strength - How much to quantize (0=none, 1=fully on grid)
 * @param sensitivity - Onset detection sensitivity (0=few onsets, 1=many onsets)
 * @returns New quantized AudioBuffer
 */
export function quantizeAudio(
  buffer: AudioBuffer,
  bpm: number,
  resolution: QuantizeResolution,
  strength: number,
  sensitivity: number,
): AudioBuffer {
  if (strength <= 0 || buffer.length === 0) return buffer;

  const sr = buffer.sampleRate;
  const gridInterval = (60 / bpm) * (4 / resolution);

  const onsets = detectOnsets(buffer, sensitivity);
  if (onsets.length === 0) return buffer;

  // Calculate target position for each onset
  const targets = onsets.map((o) => {
    const nearestGrid = Math.round(o.time / gridInterval) * gridInterval;
    const targetTime = o.time + (nearestGrid - o.time) * strength;
    return {
      originalSample: o.sample,
      targetSample: Math.max(0, Math.round(targetTime * sr)),
    };
  });

  // Build segment boundaries: [0, onset1, onset2, ..., end]
  // Each segment goes from midpoint-before-onset to midpoint-after-onset
  const srcBounds: number[] = [0];
  const dstBounds: number[] = [0];

  for (let i = 0; i < onsets.length; i++) {
    srcBounds.push(onsets[i].sample);
    dstBounds.push(targets[i].targetSample);
  }

  srcBounds.push(buffer.length);
  dstBounds.push(buffer.length);

  // Ensure destination bounds are monotonically increasing
  for (let i = 1; i < dstBounds.length; i++) {
    if (dstBounds[i] <= dstBounds[i - 1]) {
      dstBounds[i] = dstBounds[i - 1] + 1;
    }
  }

  // Build output: resample each segment to fit its new duration
  const numCh = buffer.numberOfChannels;
  const output = new AudioBuffer({ numberOfChannels: numCh, length: buffer.length, sampleRate: sr });

  for (let ch = 0; ch < numCh; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = output.getChannelData(ch);

    for (let seg = 0; seg < srcBounds.length - 1; seg++) {
      const srcStart = srcBounds[seg];
      const srcEnd = srcBounds[seg + 1];
      const srcLen = srcEnd - srcStart;

      const dstStart = dstBounds[seg];
      const dstEnd = Math.min(dstBounds[seg + 1], buffer.length);
      const dstLen = dstEnd - dstStart;

      if (srcLen <= 0 || dstLen <= 0) continue;

      // Linear interpolation resample
      const ratio = srcLen / dstLen;
      for (let j = 0; j < dstLen; j++) {
        const outIdx = dstStart + j;
        if (outIdx >= dst.length) break;

        const srcPos = srcStart + j * ratio;
        const srcIdx = Math.floor(srcPos);
        const frac = srcPos - srcIdx;

        if (srcIdx + 1 < src.length) {
          dst[outIdx] = src[srcIdx] * (1 - frac) + src[srcIdx + 1] * frac;
        } else if (srcIdx < src.length) {
          dst[outIdx] = src[srcIdx];
        }
      }
    }
  }

  return output;
}
