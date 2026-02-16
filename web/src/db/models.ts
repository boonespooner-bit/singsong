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
