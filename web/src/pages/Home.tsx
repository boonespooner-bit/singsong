import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Song } from '../db/models';
import { getAllSongs, createSong, deleteSong } from '../db/database';
import { Dialog } from '../components/Dialog';

export function Home() {
  const [songs, setSongs] = useState<Song[]>([]);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [newSongName, setNewSongName] = useState('');
  const [contextMenu, setContextMenu] = useState<{
    songId: number;
    x: number;
    y: number;
  } | null>(null);
  const navigate = useNavigate();

  const loadSongs = useCallback(async () => {
    const allSongs = await getAllSongs();
    setSongs(allSongs);
  }, []);

  useEffect(() => {
    loadSongs();
  }, [loadSongs]);

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
      </header>

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
                onClick={() => navigate(`/song/${song.id}`)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (song.id !== undefined) {
                    setContextMenu({
                      songId: song.id,
                      x: e.clientX,
                      y: e.clientY,
                    });
                  }
                }}
                style={{
                  background: 'var(--bg-card)',
                  borderRadius: 'var(--radius)',
                  padding: '16px 20px',
                  cursor: 'pointer',
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
                <div>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>
                    {song.name}
                  </div>
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
                      setContextMenu({
                        songId: song.id,
                        x: e.clientX,
                        y: e.clientY,
                      });
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
