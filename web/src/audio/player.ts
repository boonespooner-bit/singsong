import type { Track } from '../db/models';

export interface TrackNode {
  trackId: number;
  source: AudioBufferSourceNode;
  gain: GainNode;
  eqLow: BiquadFilterNode;
  eqMid: BiquadFilterNode;
  eqHigh: BiquadFilterNode;
  compressor: DynamicsCompressorNode;
  reverbSend: GainNode;
  delaySend: GainNode;
  delayNode: DelayNode;
  delayFeedback: GainNode;
  chorusSend: GainNode;
  chorusDelay: DelayNode;
  chorusLfo: OscillatorNode;
}

function generateImpulseResponse(ctx: AudioContext, duration = 2.5, decay = 2.5): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * duration);
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
}

export class MultitrackPlayer {
  private audioContext: AudioContext | null = null;
  private trackNodes: TrackNode[] = [];
  private _playing = false;
  private startTime = 0;
  private pauseOffset = 0;
  private reverbConvolver: ConvolverNode | null = null;

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

    // Shared reverb convolver
    this.reverbConvolver = this.audioContext.createConvolver();
    this.reverbConvolver.buffer = generateImpulseResponse(this.audioContext);
    this.reverbConvolver.connect(this.audioContext.destination);

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

      const gain = this.audioContext.createGain();
      gain.gain.value = track.volume;

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

      // Reverb send
      const reverbSend = this.audioContext.createGain();
      reverbSend.gain.value = track.reverbMix ?? 0;
      compressor.connect(reverbSend);
      reverbSend.connect(this.reverbConvolver!);

      // Delay send with feedback
      const delaySend = this.audioContext.createGain();
      delaySend.gain.value = track.delayMix ?? 0;
      const delayNode = this.audioContext.createDelay(2);
      delayNode.delayTime.value = track.delayTime ?? 0.3;
      const delayFeedback = this.audioContext.createGain();
      delayFeedback.gain.value = 0.35;
      compressor.connect(delaySend);
      delaySend.connect(delayNode);
      delayNode.connect(delayFeedback);
      delayFeedback.connect(delayNode);
      delayNode.connect(this.audioContext.destination);

      // Chorus send (modulated short delay)
      const chorusSend = this.audioContext.createGain();
      chorusSend.gain.value = track.chorusMix ?? 0;
      const chorusDelay = this.audioContext.createDelay(0.1);
      chorusDelay.delayTime.value = 0.015;
      const chorusLfo = this.audioContext.createOscillator();
      chorusLfo.frequency.value = 1.5;
      const lfoGain = this.audioContext.createGain();
      lfoGain.gain.value = 0.005;
      chorusLfo.connect(lfoGain);
      lfoGain.connect(chorusDelay.delayTime);
      chorusLfo.start();
      compressor.connect(chorusSend);
      chorusSend.connect(chorusDelay);
      chorusDelay.connect(this.audioContext.destination);

      this.trackNodes.push({
        trackId: track.id,
        source, gain, eqLow, eqMid, eqHigh, compressor,
        reverbSend, delaySend, delayNode, delayFeedback,
        chorusSend, chorusDelay, chorusLfo,
      });
    }

    if (this.trackNodes.length === 0) return;

    this.startTime = this.audioContext.currentTime;
    this._looping = false;
    for (const node of this.trackNodes) {
      node.source.start(0, this.pauseOffset);
      node.source.onended = () => {
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

  private _looping = false;
  private _loopStart = 0;
  private _loopEnd = 0;

  get looping(): boolean { return this._looping; }
  get loopStart(): number { return this._loopStart; }
  get loopEnd(): number { return this._loopEnd; }

  async playLooped(
    tracks: Track[],
    getAudioBlob: (trackId: number) => Promise<Blob | undefined>,
    loopStart: number,
    loopEnd: number
  ): Promise<void> {
    if (this._playing) {
      this.stop();
      return;
    }

    this._loopStart = loopStart;
    this._loopEnd = loopEnd;
    this._looping = true;

    this.audioContext = new AudioContext();
    this.trackNodes = [];

    this.reverbConvolver = this.audioContext.createConvolver();
    this.reverbConvolver.buffer = generateImpulseResponse(this.audioContext);
    this.reverbConvolver.connect(this.audioContext.destination);

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
      source.loop = true;
      source.loopStart = loopStart;
      source.loopEnd = Math.min(loopEnd, audioBuffer.duration);

      const gain = this.audioContext.createGain();
      gain.gain.value = track.volume;

      const eqLow = this.audioContext.createBiquadFilter();
      eqLow.type = 'lowshelf'; eqLow.frequency.value = 320;
      eqLow.gain.value = (track.eqBass - 0.5) * 24;

      const eqMid = this.audioContext.createBiquadFilter();
      eqMid.type = 'peaking'; eqMid.frequency.value = 1000; eqMid.Q.value = 0.5;
      eqMid.gain.value = (track.eqMids - 0.5) * 24;

      const eqHigh = this.audioContext.createBiquadFilter();
      eqHigh.type = 'highshelf'; eqHigh.frequency.value = 3200;
      eqHigh.gain.value = (track.eqTreble - 0.5) * 24;

      const compressor = this.audioContext.createDynamicsCompressor();
      compressor.threshold.value = track.compressorEnabled ? -24 : 0;
      compressor.ratio.value = track.compressorEnabled ? 4 : 1;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;

      source.connect(gain);
      gain.connect(eqLow);
      eqLow.connect(eqMid);
      eqMid.connect(eqHigh);
      eqHigh.connect(compressor);
      compressor.connect(this.audioContext.destination);

      const reverbSend = this.audioContext.createGain();
      reverbSend.gain.value = track.reverbMix ?? 0;
      compressor.connect(reverbSend);
      reverbSend.connect(this.reverbConvolver!);

      const delaySend = this.audioContext.createGain();
      delaySend.gain.value = track.delayMix ?? 0;
      const delayNode = this.audioContext.createDelay(2);
      delayNode.delayTime.value = track.delayTime ?? 0.3;
      const delayFeedback = this.audioContext.createGain();
      delayFeedback.gain.value = 0.35;
      compressor.connect(delaySend);
      delaySend.connect(delayNode);
      delayNode.connect(delayFeedback);
      delayFeedback.connect(delayNode);
      delayNode.connect(this.audioContext.destination);

      const chorusSend = this.audioContext.createGain();
      chorusSend.gain.value = track.chorusMix ?? 0;
      const chorusDelay = this.audioContext.createDelay(0.1);
      chorusDelay.delayTime.value = 0.015;
      const chorusLfo = this.audioContext.createOscillator();
      chorusLfo.frequency.value = 1.5;
      const lfoGain = this.audioContext.createGain();
      lfoGain.gain.value = 0.005;
      chorusLfo.connect(lfoGain);
      lfoGain.connect(chorusDelay.delayTime);
      chorusLfo.start();
      compressor.connect(chorusSend);
      chorusSend.connect(chorusDelay);
      chorusDelay.connect(this.audioContext.destination);

      this.trackNodes.push({
        trackId: track.id,
        source, gain, eqLow, eqMid, eqHigh, compressor,
        reverbSend, delaySend, delayNode, delayFeedback,
        chorusSend, chorusDelay, chorusLfo,
      });
    }

    if (this.trackNodes.length === 0) { this._looping = false; return; }

    this.startTime = this.audioContext.currentTime;
    for (const node of this.trackNodes) {
      node.source.start(0, loopStart);
    }

    this._playing = true;
  }

  stop(): void {
    if (this.audioContext) {
      this.pauseOffset += this.audioContext.currentTime - this.startTime;
    }
    for (const node of this.trackNodes) {
      try { node.source.stop(); } catch { /* Already stopped */ }
      try { node.chorusLfo.stop(); } catch { /* Already stopped */ }
    }
    this.trackNodes = [];
    this.reverbConvolver = null;
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this._playing = false;
    this._looping = false;
    this.pauseOffset = 0;
  }

  updateTrackVolume(trackId: number, volume: number): void {
    const node = this.trackNodes.find((n) => n.trackId === trackId);
    if (node) node.gain.gain.value = volume;
  }

  updateTrackEQ(trackId: number, bass: number, mids: number, treble: number): void {
    const node = this.trackNodes.find((n) => n.trackId === trackId);
    if (!node) return;
    node.eqLow.gain.value = (bass - 0.5) * 24;
    node.eqMid.gain.value = (mids - 0.5) * 24;
    node.eqHigh.gain.value = (treble - 0.5) * 24;
  }

  updateTrackEffects(trackId: number, reverbMix: number, delayMix: number, delayTime: number, chorusMix: number): void {
    const node = this.trackNodes.find((n) => n.trackId === trackId);
    if (!node) return;
    node.reverbSend.gain.value = reverbMix;
    node.delaySend.gain.value = delayMix;
    node.delayNode.delayTime.value = delayTime;
    node.chorusSend.gain.value = chorusMix;
  }
}
