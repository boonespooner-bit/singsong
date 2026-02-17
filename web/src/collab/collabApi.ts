import type { SongExport, Invitation, BranchSummary, BranchDetail } from '../db/models';

const TOKEN_KEY = 'singsong_token';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(TOKEN_KEY);
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Publish (or re-publish) a song to the server for collaboration */
export async function publishSong(localSongId: number, data: SongExport): Promise<string> {
  // Check if already published
  const existing = getShareId(localSongId);
  const url = existing ? `/api/collab/publish?shareId=${existing}` : '/api/collab/publish';
  const r = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error((await r.json()).error || 'Publish failed');
  const { shareId } = await r.json();
  setShareId(localSongId, shareId);
  return shareId;
}

/** Invite a collaborator by email */
export async function inviteCollaborator(shareId: string, email: string): Promise<void> {
  const r = await fetch(`/api/collab/${shareId}/invite`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ email }),
  });
  if (!r.ok) throw new Error((await r.json()).error || 'Invite failed');
}

/** Get pending invitations for the current user */
export async function getMyInvitations(): Promise<Invitation[]> {
  const r = await fetch('/api/collab/invitations', { headers: authHeaders() });
  if (!r.ok) return [];
  return r.json();
}

/** Accept an invitation — returns the song data to import locally */
export async function acceptInvitation(inviteId: string): Promise<{ branchId: string; shareId: string; data: SongExport }> {
  const r = await fetch(`/api/collab/invitations/${inviteId}/accept`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!r.ok) throw new Error((await r.json()).error || 'Accept failed');
  return r.json();
}

/** Decline an invitation */
export async function declineInvitation(inviteId: string): Promise<void> {
  const r = await fetch(`/api/collab/invitations/${inviteId}/decline`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!r.ok) throw new Error((await r.json()).error || 'Decline failed');
}

/** Sync (re-upload) a branch with latest local changes */
export async function syncBranch(branchId: string, data: SongExport): Promise<void> {
  const r = await fetch(`/api/collab/branches/${branchId}/sync`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error((await r.json()).error || 'Sync failed');
}

/** Get all branches for a shared song (owner view) */
export async function getBranches(shareId: string): Promise<BranchSummary[]> {
  const r = await fetch(`/api/collab/${shareId}/branches`, { headers: authHeaders() });
  if (!r.ok) return [];
  return r.json();
}

/** Get full branch detail including tracks and audio */
export async function getBranchDetail(branchId: string): Promise<BranchDetail | null> {
  const r = await fetch(`/api/collab/branches/${branchId}`, { headers: authHeaders() });
  if (!r.ok) return null;
  return r.json();
}

/** Get collaborators (invitations) for a shared song */
export async function getCollaborators(shareId: string): Promise<Invitation[]> {
  const r = await fetch(`/api/collab/${shareId}/collaborators`, { headers: authHeaders() });
  if (!r.ok) return [];
  return r.json();
}

// --- Local share/branch mapping (localStorage) ---

interface CollabMappings {
  shares: Record<number, string>;    // localSongId -> shareId
  branches: Record<number, string>;  // localSongId -> branchId
}

const COLLAB_KEY = 'singsong_collab';

function getMappings(): CollabMappings {
  try {
    return JSON.parse(localStorage.getItem(COLLAB_KEY) || '{}');
  } catch {
    return { shares: {}, branches: {} };
  }
}

function saveMappings(m: CollabMappings) {
  localStorage.setItem(COLLAB_KEY, JSON.stringify(m));
}

export function getShareId(localSongId: number): string | undefined {
  return getMappings().shares?.[localSongId];
}

export function setShareId(localSongId: number, shareId: string) {
  const m = getMappings();
  if (!m.shares) m.shares = {};
  m.shares[localSongId] = shareId;
  saveMappings(m);
}

export function getBranchId(localSongId: number): string | undefined {
  return getMappings().branches?.[localSongId];
}

export function setBranchId(localSongId: number, branchId: string) {
  const m = getMappings();
  if (!m.branches) m.branches = {};
  m.branches[localSongId] = branchId;
  saveMappings(m);
}
