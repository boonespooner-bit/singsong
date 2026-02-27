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
  const [createMode, setCreateMode] = useState<'creator' | 'ai'>('creator');
  const [aiKey, setAiKey] = useState('C');
  const [aiScale, setAiScale] = useState<'major' | 'minor'>('major');
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
    const id = await createSong(name, createMode === 'ai' ? { aiMode: true, aiKey, aiScale } : undefined);
    setNewSongName('');
    setShowNewDialog(false);
    setCreateMode('creator');
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
                    <div style={{ fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                      {song.name}
                      {song.aiMode && (
                        <span style={{
                          fontSize: 9, padding: '2px 6px', borderRadius: 3, fontWeight: 700,
                          background: '#e91e6322', color: '#e91e63', letterSpacing: 0.5,
                        }}>AI</span>
                      )}
                    </div>
                  )}
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--text-muted)',
                      marginTop: 4,
                    }}
                  >
                    {formatDate(song.updatedAt)}{song.aiMode ? ` \u00B7 ${song.aiKey ?? 'C'} ${song.aiScale ?? 'major'}` : ''}
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
          onKeyDown={(e) => e.key === 'Enter' && (createMode === 'creator' || aiKey) && handleCreate()}
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

        {/* Mode selection */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {([
            { mode: 'creator' as const, label: 'Creator Mode', desc: 'Full manual control over each track', color: 'var(--accent)' },
            { mode: 'ai' as const, label: 'AI Mode', desc: 'Auto-tune & auto-quantize every track', color: '#e91e63' },
          ]).map(({ mode, label, desc, color }) => (
            <button key={mode} onClick={() => setCreateMode(mode)} style={{
              flex: 1, padding: '14px 12px', borderRadius: 8, textAlign: 'left',
              background: createMode === mode ? (mode === 'ai' ? '#e91e6318' : 'var(--accent-dim, rgba(187,134,252,0.1))') : 'var(--bg-secondary)',
              border: `2px solid ${createMode === mode ? color : 'var(--border)'}`,
              cursor: 'pointer', transition: 'all 0.15s',
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: createMode === mode ? color : 'var(--text-primary)', marginBottom: 4 }}>
                {label}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>{desc}</div>
            </button>
          ))}
        </div>

        {/* AI Mode: key selection */}
        {createMode === 'ai' && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, color: '#e91e63', marginBottom: 8, fontWeight: 600 }}>Song Key</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
              {['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'].map((k) => (
                <button key={k} onClick={() => setAiKey(k)} style={{
                  padding: '6px 10px', borderRadius: 4, fontSize: 13, fontWeight: 600, minWidth: 36,
                  background: aiKey === k ? '#e91e63' : 'var(--bg-secondary)',
                  color: aiKey === k ? '#fff' : 'var(--text-muted)',
                  border: `1px solid ${aiKey === k ? '#e91e63' : 'var(--border)'}`,
                  cursor: 'pointer', transition: 'all 0.1s',
                }}>{k}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['major', 'minor'] as const).map((s) => (
                <button key={s} onClick={() => setAiScale(s)} style={{
                  flex: 1, padding: '8px 0', borderRadius: 4, fontSize: 13, fontWeight: 600,
                  background: aiScale === s ? '#e91e63' : 'var(--bg-secondary)',
                  color: aiScale === s ? '#fff' : 'var(--text-muted)',
                  border: `1px solid ${aiScale === s ? '#e91e63' : 'var(--border)'}`,
                  cursor: 'pointer', textTransform: 'capitalize',
                }}>{s}</button>
              ))}
            </div>
            <div style={{
              marginTop: 12, padding: '10px 12px', borderRadius: 6,
              background: '#e91e6310', border: '1px solid #e91e6322', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5,
            }}>
              Every track you record will be automatically tuned to <strong style={{ color: '#e91e63' }}>{aiKey} {aiScale}</strong> and
              quantized to the tempo. Just sing or play — AI keeps everything in time and in tune.
            </div>
          </div>
        )}

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
              background: createMode === 'ai' ? '#e91e63' : 'var(--accent)',
              color: createMode === 'ai' ? '#fff' : '#000',
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
