import { useRef, useEffect } from 'react';

interface WaveformProps {
  data: Float32Array | null;
  width?: number;
  height?: number;
  color?: string;
}

export function Waveform({
  data,
  width = 400,
  height = 80,
  color = '#bb86fc',
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, width, height);

    if (!data || data.length === 0) {
      // Draw center line
      ctx.strokeStyle = '#444';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();
      return;
    }

    const step = Math.max(1, Math.floor(data.length / width));
    const midY = height / 2;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    for (let i = 0; i < width; i++) {
      const idx = i * step;
      const val = idx < data.length ? data[idx] : 0;
      const y = midY + val * midY;
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.stroke();

    // Mirror
    ctx.strokeStyle = color + '66';
    ctx.beginPath();
    for (let i = 0; i < width; i++) {
      const idx = i * step;
      const val = idx < data.length ? data[idx] : 0;
      const y = midY - val * midY;
      if (i === 0) ctx.moveTo(i, y);
      else ctx.lineTo(i, y);
    }
    ctx.stroke();
  }, [data, width, height, color]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: '100%',
        height: `${height}px`,
        borderRadius: 'var(--radius-sm)',
        display: 'block',
      }}
    />
  );
}
