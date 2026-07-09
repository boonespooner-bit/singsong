/**
 * Audio quantization modeled on Pro Tools' Beat Detective / Elastic Audio:
 *
 * 1. ANALYSIS - detect transients and place a marker at each ATTACK START
 *    (like Pro Tools' beat triggers). Candidates come from energy-flux
 *    peak-picking, then are gated by a real energy rise over the preceding
 *    trough (kills false triggers from vibrato/sustain ripple), backtracked
 *    to the start of the rise, and refined to near-sample precision on a
 *    fine 1ms envelope.
 *
 * 2. CONFORM - move each marker to the nearest grid line (scaled by
 *    strength) and warp the audio BETWEEN markers. Cuts are made a few ms
 *    BEFORE each marker (Pro Tools' "trigger pad") and the attack region is
 *    copied unstretched, so the transient shape - and its visual peak -
 *    lands exactly on the grid; only the sustain absorbs the stretch.
 *
 * 3. SMOOTHING - short crossfades at every cut, placed in the quiet
 *    pre-attack pad like Beat Detective's edit smoothing, so joins never
 *    click and never touch the attack itself.
 */

export type QuantizeResolution = 4 | 8 | 16 | 32;

interface Onset {
  time: number;
  sample: number;
}

// --- FFT for spectral analysis (iterative radix-2) ---
const FFT_SIZE = 1024;
const HOP_SIZE = 256;

function fftMagnitudes(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

/**
 * Detect transient onsets and return their positions at the attack START,
 * the way Pro Tools places beat triggers.
 *
 * Uses log-compressed SPECTRAL flux (like Pro Tools' Elastic Audio
 * analysis) rather than plain energy flux: a new note changes the
 * spectrum even when overall loudness barely moves (legato), while
 * vibrato/beating inside a held note redistributes little spectral
 * energy and is ignored.
 */
export function detectOnsets(mono: Float32Array, sr: number, sensitivity: number): Onset[] {
  const numFrames = Math.floor((mono.length - FFT_SIZE) / HOP_SIZE);
  if (numFrames < 4) return [];

  // Hann window (precomputed)
  const hann = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));

  const numBins = FFT_SIZE / 2;
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);

  // SuperFlux-style detection: each bin is compared against the MAX of a
  // +-2-bin neighborhood over the previous ~35ms of frames. This suppresses
  // spectral-leakage phase ripple, vibrato, and slow beating between
  // overlapping notes, while genuine new notes - energy in bins that had
  // none recently - pass.
  const HISTORY = 6;
  const magHistory: Float32Array[] = [];
  for (let h = 0; h < HISTORY; h++) magHistory.push(new Float32Array(numBins));
  let curMag: Float32Array = new Float32Array(numBins);

  // Spectral flux per frame + coarse RMS energy for refinement
  const flux = new Float32Array(numFrames);
  const energy = new Float32Array(numFrames);

  for (let f = 0; f < numFrames; f++) {
    const start = f * HOP_SIZE;
    let esum = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const s = mono[start + i];
      re[i] = s * hann[i];
      im[i] = 0;
      esum += s * s;
    }
    energy[f] = Math.sqrt(esum / FFT_SIZE);
    fftMagnitudes(re, im);

    let fsum = 0;
    for (let b = 0; b < numBins; b++) {
      // Log compression stabilizes level differences (loud vs quiet parts)
      curMag[b] = Math.log1p(10 * Math.sqrt(re[b] * re[b] + im[b] * im[b]));
    }
    if (f >= HISTORY) {
      for (let b = 0; b < numBins; b++) {
        // Reference: max over +-2 bins across the last HISTORY frames
        let ref = 0;
        const bLo = Math.max(0, b - 2);
        const bHi = Math.min(numBins - 1, b + 2);
        for (let h = 0; h < HISTORY; h++) {
          const hist = magHistory[h];
          for (let k = bLo; k <= bHi; k++) {
            if (hist[k] > ref) ref = hist[k];
          }
        }
        const d = curMag[b] - ref;
        if (d > 0) fsum += d;
      }
    }
    flux[f] = fsum;
    // Rotate history: oldest slot becomes the new current
    const oldest = magHistory.shift()!;
    magHistory.push(curMag);
    curMag = oldest;
  }

  // Absolute floors derived from the whole signal: without them, near-zero
  // local means during silence make any numerical ripple a "peak".
  const sortedE = Array.from(energy).sort((a, b) => a - b);
  const maxE = sortedE[sortedE.length - 1];
  const noiseFloor = Math.max(1e-4, sortedE[Math.floor(sortedE.length * 0.2)] * 1.5, maxE * 0.02);
  const sortedF = Array.from(flux).sort((a, b) => a - b);
  const fluxFloor = sortedF[Math.floor(sortedF.length * 0.95)] * 0.1;

  const threshWin = Math.max(1, Math.round((0.1 * sr) / HOP_SIZE)); // ~100ms context
  const minGapFrames = Math.max(1, Math.round((0.05 * sr) / HOP_SIZE)); // 50ms min gap
  const minGapSamples = minGapFrames * HOP_SIZE;
  const troughLookback = Math.max(1, Math.round((0.08 * sr) / HOP_SIZE)); // 80ms
  // Sensitivity: low -> only strong clean attacks pass
  const fluxScale = 2.4 - sensitivity * 1.8; // 2.4x..0.6x local mean

  const onsets: Onset[] = [];
  let lastOnsetF = -minGapFrames;

  for (let f = 2; f < numFrames - 1; f++) {
    if (f - lastOnsetF < minGapFrames) continue;

    // Local-mean adaptive threshold
    const lo = Math.max(0, f - threshWin);
    const hi = Math.min(numFrames, f + threshWin);
    let mean = 0;
    for (let i = lo; i < hi; i++) mean += flux[i];
    mean /= hi - lo;

    if (flux[f] <= Math.max(mean * fluxScale, fluxFloor)) continue;
    // Local maximum of flux
    if (flux[f] < flux[f - 1] || flux[f] < flux[f + 1]) continue;
    // Must be audible: post-onset energy above the noise floor
    const peakAfter = Math.max(
      energy[f],
      energy[Math.min(numFrames - 1, f + 1)],
      energy[Math.min(numFrames - 1, f + 2)],
    );
    if (peakAfter < noiseFloor) continue;

    // Find the preceding energy trough, then backtrack from the flux peak
    // to the start of the energy rise.
    let troughE = Infinity;
    let troughF = f;
    for (let k = Math.max(0, f - troughLookback); k < f; k++) {
      if (energy[k] < troughE) {
        troughE = energy[k];
        troughF = k;
      }
    }
    let startF = f;
    while (startF > troughF && energy[startF - 1] < energy[startF]) startF--;

    let onsetSample: number;
    if (troughE < 0.3 * peakAfter) {
      // Clear energy rise (percussive / gapped material): refine on a 1ms
      // envelope - find where it first crosses 20% of trough-to-peak.
      const fineWin = Math.max(8, Math.round(sr * 0.001));
      const regionStart = Math.max(0, startF * HOP_SIZE - fineWin);
      const regionEnd = Math.min(mono.length, (f + 2) * HOP_SIZE + FFT_SIZE);
      onsetSample = startF * HOP_SIZE;
      const crossLevel = troughE + 0.2 * (peakAfter - troughE);
      for (let s = regionStart; s + fineWin <= regionEnd; s += fineWin) {
        let sum = 0;
        for (let i = 0; i < fineWin; i++) {
          const v = mono[s + i];
          sum += v * v;
        }
        if (Math.sqrt(sum / fineWin) >= crossLevel) {
          onsetSample = s;
          break;
        }
      }
    } else {
      // Legato: the previous note is still sounding, so the energy envelope
      // carries no onset information. Anchor on the spectral event: the
      // Hann window is center-weighted, so peak flux occurs when the new
      // note's attack sits at the analysis window's center.
      onsetSample = Math.min(mono.length - 1, f * HOP_SIZE + FFT_SIZE / 2);
    }

    // Dedupe: refinement backtracks toward the rise start, so two nearby
    // flux peaks can resolve to the same attack - keep only the first.
    const last = onsets[onsets.length - 1];
    if (last && onsetSample - last.sample < minGapSamples) {
      lastOnsetF = f;
      continue;
    }

    onsets.push({ time: onsetSample / sr, sample: onsetSample });
    lastOnsetF = f;
  }

  return onsets;
}

/**
 * Warp channel data so each onset (attack start) lands exactly on its
 * target sample. Cuts are placed `pad` before each onset; the pad plus the
 * first ~30ms of attack are copied UNSTRETCHED so transients keep their
 * exact shape and grid position; crossfades live inside the quiet pad.
 */
export function warpChannels(
  channels: Float32Array[],
  srcMarks: number[],
  dstMarks: number[],
  sr: number,
): Float32Array[] {
  const length = channels[0].length;
  const pad = Math.round(sr * 0.005); // 5ms trigger pad before the attack
  const guardLen = Math.round(sr * 0.03) + pad; // pad + 30ms unstretched
  const xf = Math.max(2, Math.round(sr * 0.003)); // 3ms crossfade inside the pad

  // Cut positions: same shift subtracted on both sides keeps the mark's
  // mapping exact (srcMark - s0 === dstMark - d0).
  const src: number[] = [0];
  const dst: number[] = [0];
  for (let i = 0; i < srcMarks.length; i++) {
    const shift = Math.min(pad, srcMarks[i], dstMarks[i]);
    src.push(srcMarks[i] - shift);
    dst.push(dstMarks[i] - shift);
  }
  src.push(length);
  dst.push(length);

  // Monotonic destinations with a minimum segment length so two onsets
  // rounding to the same grid line can't collapse into degenerate segments.
  const minSeg = Math.round(sr * 0.01);
  for (let i = 1; i < dst.length - 1; i++) {
    if (dst[i] < dst[i - 1] + minSeg) dst[i] = Math.min(length, dst[i - 1] + minSeg);
  }
  if (dst[dst.length - 1] < dst[dst.length - 2]) dst[dst.length - 1] = dst[dst.length - 2];

  return channels.map((srcData) => {
    const out = new Float32Array(length);

    for (let seg = 0; seg < src.length - 1; seg++) {
      const s0 = src[seg];
      const s1 = src[seg + 1];
      const d0 = dst[seg];
      const d1 = Math.min(dst[seg + 1], length);
      const srcLen = s1 - s0;
      const dstLen = d1 - d0;
      if (srcLen <= 0 || dstLen <= 0) continue;

      // Unstretched attack region (segment 0 has no onset at its start)
      const guard = seg === 0 ? 0 : Math.min(guardLen, Math.floor(srcLen / 2), Math.floor(dstLen / 2));
      const fadeIn = seg === 0 ? 0 : Math.min(xf, Math.max(guard, 1));

      for (let j = 0; j < guard; j++) {
        const oi = d0 + j;
        if (oi >= length) break;
        const v = srcData[s0 + j];
        if (j < fadeIn) {
          // Crossfade with the previous segment's fade-out tail (additive)
          const t = (j + 1) / (fadeIn + 1);
          out[oi] += v * Math.sin((t * Math.PI) / 2);
        } else {
          out[oi] = v;
        }
      }

      // Stretch the sustain to fill the remainder of the segment
      const rs0 = s0 + guard;
      const rd0 = d0 + guard;
      const rSrcLen = s1 - rs0;
      const rDstLen = d1 - rd0;
      if (rSrcLen <= 0 || rDstLen <= 0) continue;
      const ratio = rSrcLen / rDstLen;

      // Fade-out tail past d1 for the next segment's fade-in to overlap
      const tail = seg < src.length - 2 ? Math.min(xf, length - d1) : 0;

      for (let j = 0; j < rDstLen + tail; j++) {
        const oi = rd0 + j;
        if (oi >= length) break;
        const srcPos = rs0 + j * ratio;
        const si = Math.floor(srcPos);
        const frac = srcPos - si;
        let v: number;
        if (si + 1 < srcData.length) v = srcData[si] * (1 - frac) + srcData[si + 1] * frac;
        else if (si < srcData.length) v = srcData[si];
        else break;

        if (j >= rDstLen) {
          const t = (j - rDstLen + 1) / (tail + 1);
          out[oi] += v * Math.cos((t * Math.PI) / 2);
        } else if (seg > 0 && guard === 0 && j < xf) {
          const t = (j + 1) / (xf + 1);
          out[oi] += v * Math.sin((t * Math.PI) / 2);
        } else {
          out[oi] = v;
        }
      }
    }

    return out;
  });
}

/**
 * Quantize audio by aligning detected attack starts to beat grid positions.
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

  const onsets = detectOnsets(buffer.getChannelData(0), sr, sensitivity);
  if (onsets.length === 0) return buffer;

  const srcMarks: number[] = [];
  const dstMarks: number[] = [];
  for (const o of onsets) {
    const nearestGrid = Math.round(o.time / gridInterval) * gridInterval;
    const targetTime = o.time + (nearestGrid - o.time) * strength;
    srcMarks.push(o.sample);
    dstMarks.push(Math.max(0, Math.round(targetTime * sr)));
  }

  const numCh = buffer.numberOfChannels;
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numCh; ch++) channels.push(buffer.getChannelData(ch));

  const warped = warpChannels(channels, srcMarks, dstMarks, sr);

  const output = new AudioBuffer({ numberOfChannels: numCh, length: buffer.length, sampleRate: sr });
  for (let ch = 0; ch < numCh; ch++) output.getChannelData(ch).set(warped[ch]);
  return output;
}
