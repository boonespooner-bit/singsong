export class Metronome {
  private audioCtx: AudioContext | null = null;
  private timerId: number | null = null;
  private nextTickTime = 0;
  private currentBeat = 0;
  private _running = false;

  bpm = 120;
  beatsPerBar = 4;
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

    // Higher pitch and louder on beat 1
    osc.frequency.value = isDownbeat ? 1000 : 800;
    osc.type = 'sine';
    gain.gain.value = isDownbeat ? 0.5 : 0.3;
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

    osc.start(time);
    osc.stop(time + 0.05);
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
