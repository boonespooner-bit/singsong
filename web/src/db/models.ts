export type TrackRole =
  | 'vocals'
  | 'guitar'
  | 'bass'
  | 'drums'
  | 'piano'
  | 'synth'
  | 'strings'
  | 'other';

export const TRACK_ROLES: TrackRole[] = [
  'vocals',
  'guitar',
  'bass',
  'drums',
  'piano',
  'synth',
  'strings',
  'other',
];

export interface Song {
  id?: number;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface Track {
  id?: number;
  songId: number;
  name: string;
  role: TrackRole;
  volume: number;
  eqBass: number;
  eqMids: number;
  eqTreble: number;
  compressorEnabled: boolean;
  aiProcessed: boolean;
  createdAt: number;
  // Pan: -1 (left) to 1 (right), default 0 (center)
  pan?: number;
  // Audio effects (optional, default 0 = off)
  reverbMix?: number;
  delayMix?: number;
  delayTime?: number;
  chorusMix?: number;
  // Harmonizer: adds a pitch-shifted harmony voice
  harmonizerMix?: number;         // 0-1, wet/dry mix
  harmonizerInterval?: 3 | 5;    // musical interval: 3rd or 5th
  harmonizerDirection?: 'above' | 'below';
}

export interface AudioBlob {
  trackId: number;
  blob: Blob;
}

export interface Collaborator {
  id?: number;
  songId: number;
  name: string;
  email: string;
  invitedAt: number;
  accepted: boolean;
}

// --- Collaboration types (server-side data shapes) ---

export interface SongExport {
  song: { name: string };
  tracks: Omit<Track, 'id' | 'songId'>[];
  audioBase64: Record<number, string>; // original track index -> base64 audio
}

export interface Invitation {
  id: string;
  shareId: string;
  songName: string;
  fromUserName: string;
  fromUserEmail: string;
  toEmail: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: number;
}

export interface BranchSummary {
  id: string;
  shareId: string;
  userName: string;
  userEmail: string;
  trackCount: number;
  updatedAt: number;
}

export interface BranchDetail extends BranchSummary {
  songName: string;
  tracks: (Omit<Track, 'id' | 'songId'> & { index: number })[];
  audioBase64: Record<number, string>; // track index -> base64 audio
}
