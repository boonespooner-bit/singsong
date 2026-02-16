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

const ROLE_ICONS: Record<TrackRole, string> = {
  vocals: '\u{1F3A4}',
  guitar: '\u{1F3B8}',
  bass: '\u{1F3B5}',
  drums: '\u{1FA98}',
  piano: '\u{1F3B9}',
  synth: '\u{1F39B}\uFE0F',
  strings: '\u{1F3BB}',
  other: '\u{1F3B6}',
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
      {ROLE_ICONS[role]} {role}
    </span>
  );
}
