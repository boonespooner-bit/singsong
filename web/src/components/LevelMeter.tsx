import { useMemo } from 'react';

interface LevelMeterProps {
  level: number; // 0-1
  bars?: number;
}

export function LevelMeter({ level, bars = 30 }: LevelMeterProps) {
  const activeBars = Math.round(level * bars);

  const barElements = useMemo(() => {
    return Array.from({ length: bars }, (_, i) => {
      const isActive = i < activeBars;
      const ratio = i / bars;
      let color: string;
      if (ratio < 0.6) color = '#4caf50';
      else if (ratio < 0.85) color = '#ff9800';
      else color = '#f44336';

      return (
        <div
          key={i}
          style={{
            flex: 1,
            height: '100%',
            background: isActive ? color : '#333',
            borderRadius: 2,
            transition: 'background 50ms',
          }}
        />
      );
    });
  }, [activeBars, bars]);

  return (
    <div
      style={{
        display: 'flex',
        gap: 2,
        height: 12,
        width: '100%',
        padding: '0 4px',
      }}
    >
      {barElements}
    </div>
  );
}
