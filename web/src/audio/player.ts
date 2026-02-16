import type { Track } from '../db/models';

export interface TrackNode {
  trackId: number;
  source: AudioBufferSourceNode;
  gain: GainNode;
  eqLow: BiquadFilterNode;
  eqMid: BiquadFilterNode;
  eqHigh: BiquadFilterNode;
  compressor: DynamicsCompressorNode;
}

export class MultitrackPlayer {
  private audioContext: AudioContext | null = null;
  private trackNodes: TrackNode[] = [];
  private _playing = false;
  private startTime = 0;
  private pauseOffset = 0;

  get playing(): boolean {
    return this._playing;
  }

  async play(
    tracks: Track[],
    getAudioBlob: (trackId: number) => Promise<Blob | undefined>
  ): Promise<void> {
    if (this._playing) {
      this.stop();
      return;
    }

    this.audioContext = new AudioContext();
    this.trackNodes = [];

    for (const track of tracks) {
      if (track.id === undefined) continue;
      const blob = await getAudioBlob(track.id);
      if (!blob || blob.size === 0) continue;

      const arrayBuffer = await blob.arrayBuffer();
      let audioBuffer: AudioBuffer;
      try {
        audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
      } catch {
        console.warn(`Could not decode audio for track ${track.id}`);
        continue;
      }

      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;

      // Gain (volume)
      const gain = this.audioContext.createGain();
      gain.gain.value = track.volume;

      // 3-band EQ
      const eqLow = this.audioContext.createBiquadFilter();
      eqLow.type = 'lowshelf';
      eqLow.frequency.value = 320;
      eqLow.gain.value = (track.eqBass - 0.5) * 24;

      const eqMid = this.audioContext.createBiquadFilter();
      eqMid.type = 'peaking';
      eqMid.frequency.value = 1000;
      eqMid.Q.value = 0.5;
      eqMid.gain.value = (track.eqMids - 0.5) * 24;

      const eqHigh = this.audioContext.createBiquadFilter();
      eqHigh.type = 'highshelf';
      eqHigh.frequency.value = 3200;
      eqHigh.gain.value = (track.eqTreble - 0.5) * 24;

      // Compressor
      const compressor = this.audioContext.createDynamicsCompressor();
      compressor.threshold.value = track.compressorEnabled ? -24 : 0;
      compressor.ratio.value = track.compressorEnabled ? 4 : 1;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;

      // Chain: source → gain → eqLow → eqMid → eqHigh → compressor → destination
      source.connect(gain);
      gain.connect(eqLow);
      eqLow.connect(eqMid);
      eqMid.connect(eqHigh);
      eqHigh.connect(compressor);
      compressor.connect(this.audioContext.destination);

      this.trackNodes.push({
        trackId: track.id,
        source,
        gain,
        eqLow,
        eqMid,
        eqHigh,
        compressor,
      });
    }

    if (this.trackNodes.length === 0) return;

    // Start all sources simultaneously
    this.startTime = this.audioContext.currentTime;
    for (const node of this.trackNodes) {
      node.source.start(0, this.pauseOffset);
      node.source.onended = () => {
        // Check if all sources have ended
        const allEnded = this.trackNodes.every(
          (n) => n.source.buffer === null || n.source.context.currentTime >= this.startTime + (n.source.buffer?.duration ?? 0)
        );
        if (allEnded) {
          this._playing = false;
          this.pauseOffset = 0;
        }
      };
    }

    this._playing = true;
  }

  stop(): void {
    if (this.audioContext) {
      this.pauseOffset += this.audioContext.currentTime - this.startTime;
    }
    for (const node of this.trackNodes) {
      try {
        node.source.stop();
      } catch {
        // Already stopped
      }
    }
    this.trackNodes = [];
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this._playing = false;
    this.pauseOffset = 0;
  }

  updateTrackVolume(trackId: number, volume: number): void {
    const node = this.trackNodes.find((n) => n.trackId === trackId);
    if (node) node.gain.gain.value = volume;
  }

  updateTrackEQ(
    trackId: number,
    bass: number,
    mids: number,
    treble: number
  ): void {
    const node = this.trackNodes.find((n) => n.trackId === trackId);
    if (!node) return;
    node.eqLow.gain.value = (bass - 0.5) * 24;
    node.eqMid.gain.value = (mids - 0.5) * 24;
    node.eqHigh.gain.value = (treble - 0.5) * 24;
  }
}
