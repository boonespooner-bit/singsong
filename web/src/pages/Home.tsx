import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Song, Invitation } from '../db/models';
import { getAllSongs, createSong, deleteSong, updateSong, importSongData } from '../db/database';
import { useAuth } from '../auth/AuthContext';
import { Dialog } from '../components/Dialog';
import { getMyInvitations, acceptInvitation, declineInvitation, setBranchId } from '../collab/collabApi';

export function Home() {
  const { user, isDemo, logout } = useAuth();
  const [songs, setSongs] = useState<Song[]>([]);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [newSongName, setNewSongName] = useState('');
  const [editingSongId, setEditingSongId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [contextMenu, setContextMenu] = useState<{
    songId: number;
    x: number;
    y: number;
  } | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const navigate = useNavigate();

  const loadSongs = useCallback(async () => {
    const allSongs = await getAllSongs();
    setSongs(allSongs);
  }, []);

  const loadInvitations = useCallback(async () => {
    if (!user) return;
    try {
      const invs = await getMyInvitations();
      setInvitations(invs);
    } catch { /* ignore if not authenticated */ }
  }, [user]);

  useEffect(() => {
    loadSongs();
    loadInvitations();
  }, [loadSongs, loadInvitations]);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  const handleCreate = async () => {
    const name = newSongName.trim();
    if (!name) return;
    const id = await createSong(name);
    setNewSongName('');
    setShowNewDialog(false);
    navigate(`/song/${id}`);
  };

  const handleDelete = async (id: number) => {
    await deleteSong(id);
    setContextMenu(null);
    loadSongs();
  };

  const startRename = (song: Song) => {
    setContextMenu(null);
    if (song.id !== undefined) {
      setEditingSongId(song.id);
      setEditingName(song.name);
    }
  };

  const saveRename = async () => {
    if (editingSongId === null) return;
    const song = songs.find((s) => s.id === editingSongId);
    if (song && editingName.trim()) {
      await updateSong({ ...song, name: editingName.trim() });
      loadSongs();
    }
    setEditingSongId(null);
  };

  const handleAcceptInvite = async (inv: Invitation) => {
    setAcceptingId(inv.id);
    try {
      const { branchId, data } = await acceptInvitation(inv.id);
      // Import the song data into local IndexedDB
      const localSongId = await importSongData(data);
      // Link local song to server branch
      setBranchId(localSongId, branchId);
      await loadSongs();
      setInvitations((prev) => prev.filter((i) => i.id !== inv.id));
      navigate(`/song/${localSongId}`);
    } catch (err) {
      alert('Failed to accept invitation: ' + (err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setAcceptingId(null);
    }
  };

  const handleDeclineInvite = async (inv: Invitation) => {
    try {
      await declineInvitation(inv.id);
      setInvitations((prev) => prev.filter((i) => i.id !== inv.id));
    } catch { /* ignore */ }
  };

  const formatDate = (ts: number) => {
    return new Date(ts).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <header
        style={{
          padding: '16px 24px',
          background: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 28 }}>{'\u{1F3B5}'}</span>
          <h1 style={{ fontSize: 24, fontWeight: 700 }}>SingSong</h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {user && (
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{user.name}</span>
          )}
          {isDemo && (
            <span style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 4,
              background: '#ff980033', color: '#ff9800', fontWeight: 600,
            }}>DEMO</span>
          )}
          <button onClick={logout} style={{
            padding: '6px 12px', background: 'var(--bg-elevated)',
            color: 'var(--text-secondary)', borderRadius: 'var(--radius-sm)', fontSize: 13,
          }}>{user ? 'Sign Out' : 'Sign In'}</button>
        </div>
      </header>

      {/* Demo banner */}
      {isDemo && (
        <div style={{
          padding: '8px 24px', background: '#ff980015', borderBottom: '1px solid #ff980033',
          fontSize: 13, color: '#ff9800', textAlign: 'center',
        }}>
          Demo mode: songs are stored locally only. Sign in to save your work.
        </div>
      )}

      {/* Pending invitations */}
      {invitations.length > 0 && (
        <div style={{ maxWidth: 720, width: '100%', margin: '0 auto', padding: '16px 24px 0' }}>
          <h3 style={{ fontSize: 14, color: '#bb86fc', marginBottom: 8, fontWeight: 600 }}>
            Collaboration Invitations
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {invitations.map((inv) => (
              <div key={inv.id} style={{
                background: '#bb86fc15', border: '1px solid #bb86fc33', borderRadius: 8,
                padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{inv.songName}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                    From <strong style={{ color: '#bb86fc' }}>{inv.fromUserName}</strong> ({inv.fromUserEmail})
                  </div>
                </div>
                <button onClick={() => handleAcceptInvite(inv)} disabled={acceptingId === inv.id}
                  style={{
                    padding: '6px 14px', background: '#bb86fc', color: '#000', borderRadius: 6,
                    fontSize: 12, fontWeight: 600, opacity: acceptingId === inv.id ? 0.5 : 1,
                  }}>{acceptingId === inv.id ? 'Joining...' : 'Accept'}</button>
                <button onClick={() => handleDeclineInvite(inv)}
                  style={{
                    padding: '6px 14px', background: 'none', color: '#888', borderRadius: 6, fontSize: 12,
                  }}>Decline</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Content */}
      <main
        style={{
          flex: 1,
          maxWidth: 720,
          width: '100%',
          margin: '0 auto',
          padding: 24,
        }}
      >
        {songs.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              marginTop: 120,
              color: 'var(--text-muted)',
            }}
          >
            <div style={{ fontSize: 64, marginBottom: 16 }}>{'\u{1F3B6}'}</div>
            <p style={{ fontSize: 18, marginBottom: 8 }}>No songs yet</p>
            <p style={{ fontSize: 14 }}>
              Tap the button below to create your first song
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {songs.map((song) => (
              <div
                key={song.id}
                onClick={() => {
                  if (editingSongId !== song.id) navigate(`/song/${song.id}`);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (song.id !== undefined) {
                    setContextMenu({ songId: song.id, x: e.clientX, y: e.clientY });
                  }
                }}
                style={{
                  background: 'var(--bg-card)',
                  borderRadius: 'var(--radius)',
                  padding: '16px 20px',
                  cursor: editingSongId === song.id ? 'default' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  transition: 'background 150ms',
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = 'var(--bg-elevated)')
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = 'var(--bg-card)')
                }
              >
                <div style={{ flex: 1 }}>
                  {editingSongId === song.id ? (
                    <input
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onBlur={saveRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveRename();
                        if (e.key === 'Escape') setEditingSongId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                      style={{
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--accent)',
                        borderRadius: 4,
                        color: 'var(--text-primary)',
                        padding: '4px 8px',
                        fontSize: 16,
                        fontWeight: 600,
                        width: '100%',
                        outline: 'none',
                      }}
                    />
                  ) : (
                    <div style={{ fontSize: 16, fontWeight: 600 }}>{song.name}</div>
                  )}
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--text-muted)',
                      marginTop: 4,
                    }}
                  >
                    {formatDate(song.updatedAt)}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (song.id !== undefined) {
                      setContextMenu({ songId: song.id, x: e.clientX, y: e.clientY });
                    }
                  }}
                  style={{
                    background: 'none',
                    color: 'var(--text-muted)',
                    fontSize: 20,
                    padding: '4px 8px',
                  }}
                >
                  {'\u22EE'}
                </button>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* FAB */}
      <button
        onClick={() => setShowNewDialog(true)}
        style={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          width: 56,
          height: 56,
          borderRadius: 16,
          background: 'var(--accent)',
          color: '#000',
          fontSize: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 4px 16px rgba(187, 134, 252, 0.4)',
        }}
      >
        +
      </button>

      {/* Context menu */}
      {contextMenu && (
        <div
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            background: 'var(--bg-elevated)',
            borderRadius: 'var(--radius-sm)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            zIndex: 999,
            overflow: 'hidden',
          }}
        >
          <button
            onClick={() => {
              const song = songs.find((s) => s.id === contextMenu.songId);
              if (song) startRename(song);
            }}
            style={{
              display: 'block',
              width: '100%',
              padding: '10px 20px',
              background: 'none',
              color: 'var(--text-primary)',
              textAlign: 'left',
              fontSize: 14,
            }}
          >
            Rename
          </button>
          <button
            onClick={() => handleDelete(contextMenu.songId)}
            style={{
              display: 'block',
              width: '100%',
              padding: '10px 20px',
              background: 'none',
              color: 'var(--error)',
              textAlign: 'left',
              fontSize: 14,
            }}
          >
            Delete Song
          </button>
        </div>
      )}

      {/* New song dialog */}
      <Dialog
        open={showNewDialog}
        onClose={() => setShowNewDialog(false)}
        title="Create New Song"
      >
        <input
          type="text"
          placeholder="Song name"
          value={newSongName}
          onChange={(e) => setNewSongName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          autoFocus
          style={{
            width: '100%',
            padding: '10px 14px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            fontSize: 16,
            marginBottom: 16,
            outline: 'none',
          }}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={() => setShowNewDialog(false)}
            style={{
              padding: '8px 16px',
              background: 'none',
              color: 'var(--text-secondary)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            style={{
              padding: '8px 20px',
              background: 'var(--accent)',
              color: '#000',
              borderRadius: 'var(--radius-sm)',
              fontWeight: 600,
            }}
          >
            Create
          </button>
        </div>
      </Dialog>
    </div>
  );
}
