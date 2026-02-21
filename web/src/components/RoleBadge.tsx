import type { TrackRole } from '../db/models';

const ROLE_COLORS: Record<TrackRole, string> = {
  vocals: '#e91e63',
  guitar: '#ff5722',
  bass: '#ff9800',
  drums: '#ffc107',
  piano: '#4caf50',
  synth: '#00bcd4',
  strings: '#9c27b0',
  other: '#607d8b',
};

interface RoleBadgeProps {
  role: TrackRole;
}

export function RoleBadge({ role }: RoleBadgeProps) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 12,
        background: ROLE_COLORS[role] + '33',
        color: ROLE_COLORS[role],
        fontSize: 12,
        fontWeight: 600,
        textTransform: 'uppercase',
      }}
    >
      {role}
    </span>
  );
}
