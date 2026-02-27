/**
 * Note frequencies for octave 4 (middle octave), based on A4 = 440 Hz.
 * Used when the metronome plays pitched tones instead of clicks.
 */
const NOTE_FREQUENCIES: Record<string, number> = {
  'C': 261.63, 'C#': 277.18, 'Db': 277.18,
  'D': 293.66, 'D#': 311.13, 'Eb': 311.13,
  'E': 329.63,
  'F': 349.23, 'F#': 369.99, 'Gb': 369.99,
  'G': 392.00, 'G#': 415.30, 'Ab': 415.30,
  'A': 440.00, 'A#': 466.16, 'Bb': 466.16,
  'B': 493.88,
};

/** All selectable note names (no duplicate enharmonics) */
export const METRONOME_NOTES = [
  'C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B',
] as const;

export type MetronomeNote = typeof METRONOME_NOTES[number];

export function noteToFrequency(note: string): number {
  return NOTE_FREQUENCIES[note] ?? 440;
}

export class Metronome {
  private audioCtx: AudioContext | null = null;
  private timerId: number | null = null;
  private nextTickTime = 0;
  private currentBeat = 0;
  private _running = false;

  bpm = 120;
  beatsPerBar = 4;
  /** When set, the metronome plays this pitched note instead of a generic click */
  note: MetronomeNote | null = null;
  onTick: ((beat: number) => void) | null = null;

  get running() {
    return this._running;
  }

  start() {
    if (this._running) return;
    this.audioCtx = new AudioContext();
    this._running = true;
    this.currentBeat = 0;
    this.nextTickTime = this.audioCtx.currentTime + 0.05;
    this.schedule();
  }

  stop() {
    this._running = false;
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
  }

  private schedule() {
    if (!this._running || !this.audioCtx) return;

    const lookAhead = 0.1; // schedule 100ms ahead
    while (this.nextTickTime < this.audioCtx.currentTime + lookAhead) {
      this.playClick(this.nextTickTime, this.currentBeat === 0);
      this.onTick?.(this.currentBeat);
      this.currentBeat = (this.currentBeat + 1) % this.beatsPerBar;
      this.nextTickTime += 60 / this.bpm;
    }

    this.timerId = window.setTimeout(() => this.schedule(), 25);
  }

  private playClick(time: number, isDownbeat: boolean) {
    if (!this.audioCtx) return;

    const osc = this.audioCtx.createOscillator();
    const gain = this.audioCtx.createGain();

    osc.connect(gain);
    gain.connect(this.audioCtx.destination);

    if (this.note) {
      // Pitched note mode: play the selected note as a musical tone
      const baseFreq = noteToFrequency(this.note);
      // Downbeat plays the root, off-beats play one octave higher
      osc.frequency.value = isDownbeat ? baseFreq : baseFreq * 2;
      osc.type = 'triangle'; // warmer tone for pitched notes

      const level = isDownbeat ? 0.45 : 0.25;
      const duration = 0.12; // longer sustain so the pitch is audible
      gain.gain.setValueAtTime(level, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + duration);

      osc.start(time);
      osc.stop(time + duration);
    } else {
      // Default click mode
      osc.frequency.value = isDownbeat ? 1000 : 800;
      osc.type = 'sine';

      const level = isDownbeat ? 0.5 : 0.3;
      gain.gain.setValueAtTime(level, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

      osc.start(time);
      osc.stop(time + 0.05);
    }
  }

  /** Run a count-in (1 bar) and return a promise that resolves when it finishes */
  countIn(): Promise<void> {
    return new Promise((resolve) => {
      if (this.audioCtx) {
        this.audioCtx.close();
      }
      this.audioCtx = new AudioContext();
      let beat = 0;
      const interval = 60 / this.bpm;
      let nextTime = this.audioCtx.currentTime + 0.05;

      const tick = () => {
        if (!this.audioCtx) { resolve(); return; }
        if (beat >= this.beatsPerBar) {
          resolve();
          return;
        }
        this.playClick(nextTime, beat === 0);
        this.onTick?.(beat);
        beat++;
        nextTime += interval;
        setTimeout(tick, interval * 1000 - 10);
      };
      tick();
    });
  }
}
