export type RecorderState = 'idle' | 'recording';

export class AudioRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private audioContext: AudioContext | null = null;
  private chunks: Blob[] = [];
  private _state: RecorderState = 'idle';

  get state(): RecorderState {
    return this._state;
  }

  async start(
    onLevel?: (level: number) => void,
    onWaveform?: (data: Float32Array) => void
  ): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(this.stream);

    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    source.connect(this.analyser);

    this.mediaRecorder = new MediaRecorder(this.stream, {
      mimeType: this.getSupportedMimeType(),
    });

    this.chunks = [];
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };

    this.mediaRecorder.start(100);
    this._state = 'recording';

    if (onLevel || onWaveform) {
      this.pollAnalyser(onLevel, onWaveform);
    }
  }

  private getSupportedMimeType(): string {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  }

  private pollAnalyser(
    onLevel?: (level: number) => void,
    onWaveform?: (data: Float32Array) => void
  ) {
    if (!this.analyser || this._state !== 'recording') return;

    const bufferLength = this.analyser.fftSize;
    const dataArray = new Float32Array(bufferLength);
    this.analyser.getFloatTimeDomainData(dataArray);

    if (onLevel) {
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i] * dataArray[i];
      }
      const rms = Math.sqrt(sum / bufferLength);
      const db = 20 * Math.log10(Math.max(rms, 1e-10));
      const normalized = Math.max(0, Math.min(1, (db + 60) / 60));
      onLevel(normalized);
    }

    if (onWaveform) {
      onWaveform(dataArray.slice());
    }

    requestAnimationFrame(() => this.pollAnalyser(onLevel, onWaveform));
  }

  async stop(): Promise<Blob> {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        this._state = 'idle';
        resolve(new Blob());
        return;
      }

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.chunks, {
          type: this.mediaRecorder?.mimeType || 'audio/webm',
        });
        this.cleanup();
        resolve(blob);
      };

      this.mediaRecorder.stop();
      this._state = 'idle';
    });
  }

  private cleanup() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.analyser = null;
    this.mediaRecorder = null;
    this.chunks = [];
  }
}
