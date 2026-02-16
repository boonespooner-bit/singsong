import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { TRACK_ROLES } from '../db/models';
import type { Song, Track, TrackRole, Collaborator } from '../db/models';
import {
  getSong,
  getTracksBySong,
  createTrack,
  updateTrack,
  deleteTrack,
  saveAudioBlob,
  getAudioBlob,
  getCollaborators,
  addCollaborator,
  removeCollaborator,
} from '../db/database';
import { AudioRecorder } from '../audio/recorder';
import { MultitrackPlayer } from '../audio/player';
import { Waveform } from '../components/Waveform';
import { LevelMeter } from '../components/LevelMeter';
import { RoleBadge } from '../components/RoleBadge';
import { Dialog } from '../components/Dialog';

export function SongEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const songId = Number(id);

  const [song, setSong] = useState<Song | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [collabs, setCollabs] = useState<Collaborator[]>([]);

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTrackId, setRecordingTrackId] = useState<number | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [waveformData, setWaveformData] = useState<Float32Array | null>(null);

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false);

  // Dialogs
  const [showNewTrack, setShowNewTrack] = useState(false);
  const [newTrackName, setNewTrackName] = useState('');
  const [newTrackRole, setNewTrackRole] = useState<TrackRole>('vocals');
  const [showEQ, setShowEQ] = useState<Track | null>(null);
  const [showCollab, setShowCollab] = useState(false);
  const [collabName, setCollabName] = useState('');
  const [collabEmail, setCollabEmail] = useState('');

  const recorderRef = useRef(new AudioRecorder());
  const playerRef = useRef(new MultitrackPlayer());

  const loadData = useCallback(async () => {
    const [s, t, c] = await Promise.all([
      getSong(songId),
      getTracksBySong(songId),
      getCollaborators(songId),
    ]);
    if (s) setSong(s);
    setTracks(t);
    setCollabs(c);
  }, [songId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleAddTrack = async () => {
    const name = newTrackName.trim();
    if (!name) return;

    const trackId = await createTrack({
      songId,
      name,
      role: newTrackRole,
      volume: 0.8,
      eqBass: 0.5,
      eqMids: 0.5,
      eqTreble: 0.5,
      compressorEnabled: false,
      aiProcessed: false,
      createdAt: Date.now(),
    });

    setNewTrackName('');
    setNewTrackRole('vocals');
    setShowNewTrack(false);

    // Start recording immediately
    setRecordingTrackId(trackId);
    setIsRecording(true);
    await recorderRef.current.start(setAudioLevel, setWaveformData);
    await loadData();
  };

  const handleStopRecording = async () => {
    const blob = await recorderRef.current.stop();
    setIsRecording(false);
    setAudioLevel(0);
    setWaveformData(null);

    if (recordingTrackId && blob.size > 0) {
      await saveAudioBlob(recordingTrackId, blob);
    }
    setRecordingTrackId(null);
    await loadData();
  };

  const handlePlay = async () => {
    if (isPlaying) {
      playerRef.current.stop();
      setIsPlaying(false);
      return;
    }
    setIsPlaying(true);
    await playerRef.current.play(tracks, getAudioBlob);
    // Poll for playback end
    const check = setInterval(() => {
      if (!playerRef.current.playing) {
        setIsPlaying(false);
        clearInterval(check);
      }
    }, 200);
  };

  const handleDeleteTrack = async (trackId: number) => {
    await deleteTrack(trackId, songId);
    loadData();
  };

  const handleVolumeChange = async (track: Track, volume: number) => {
    const updated = { ...track, volume };
    await updateTrack(updated);
    playerRef.current.updateTrackVolume(track.id!, volume);
    setTracks((prev) =>
      prev.map((t) => (t.id === track.id ? updated : t))
    );
  };

  const handleToggleCompressor = async (track: Track) => {
    const updated = { ...track, compressorEnabled: !track.compressorEnabled };
    await updateTrack(updated);
    setTracks((prev) =>
      prev.map((t) => (t.id === track.id ? updated : t))
    );
  };

  const handleEQSave = async (
    track: Track,
    bass: number,
    mids: number,
    treble: number
  ) => {
    const updated = { ...track, eqBass: bass, eqMids: mids, eqTreble: treble };
    await updateTrack(updated);
    playerRef.current.updateTrackEQ(track.id!, bass, mids, treble);
    setTracks((prev) =>
      prev.map((t) => (t.id === track.id ? updated : t))
    );
  };

  const handleAddCollab = async () => {
    const name = collabName.trim();
    const email = collabEmail.trim();
    if (!name || !email) return;
    await addCollaborator({
      songId,
      name,
      email,
      invitedAt: Date.now(),
      accepted: false,
    });
    setCollabName('');
    setCollabEmail('');
    setShowCollab(false);
    loadData();
  };

  if (!song) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
        Loading...
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <header
        style={{
          padding: '12px 16px',
          background: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <button
          onClick={() => {
            playerRef.current.stop();
            navigate('/');
          }}
          style={{
            background: 'none',
            color: 'var(--text-primary)',
            fontSize: 20,
            padding: '4px 8px',
          }}
        >
          {'\u2190'}
        </button>
        <h2 style={{ flex: 1, fontSize: 18, fontWeight: 600 }}>{song.name}</h2>
        <button
          onClick={() => setShowCollab(true)}
          style={{
            background: 'var(--bg-elevated)',
            color: 'var(--text-secondary)',
            padding: '6px 12px',
            borderRadius: 'var(--radius-sm)',
            fontSize: 13,
          }}
        >
          + Invite
        </button>
      </header>

      {/* Recording indicator */}
      {isRecording && (
        <div
          style={{
            padding: '12px 20px',
            background: '#f4433620',
            borderBottom: '1px solid #f4433644',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 8,
            }}
          >
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: '#f44336',
                animation: 'pulse 1s infinite',
              }}
            />
            <span style={{ fontSize: 14, color: '#f44336', fontWeight: 600 }}>
              Recording
            </span>
          </div>
          <LevelMeter level={audioLevel} />
          <div style={{ marginTop: 8 }}>
            <Waveform data={waveformData} height={60} color="#f44336" />
          </div>
        </div>
      )}

      {/* Tracks list */}
      <main
        style={{
          flex: 1,
          overflow: 'auto',
          padding: 16,
        }}
      >
        {tracks.length === 0 && !isRecording ? (
          <div
            style={{
              textAlign: 'center',
              marginTop: 80,
              color: 'var(--text-muted)',
            }}
          >
            <div style={{ fontSize: 48, marginBottom: 12 }}>{'\u{1F3A4}'}</div>
            <p>No tracks yet. Tap + to add a track and start recording.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {tracks.map((track) => (
              <div
                key={track.id}
                style={{
                  background: 'var(--bg-card)',
                  borderRadius: 'var(--radius)',
                  padding: 16,
                }}
              >
                {/* Track header */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 12,
                  }}
                >
                  <RoleBadge role={track.role} />
                  <span style={{ flex: 1, fontWeight: 500, fontSize: 14 }}>
                    {track.name}
                  </span>
                  {track.aiProcessed && (
                    <span
                      style={{
                        fontSize: 10,
                        padding: '2px 6px',
                        borderRadius: 6,
                        background: '#bb86fc33',
                        color: 'var(--accent)',
                        fontWeight: 700,
                      }}
                    >
                      AI
                    </span>
                  )}
                  <button
                    onClick={() => handleDeleteTrack(track.id!)}
                    style={{
                      background: 'none',
                      color: 'var(--text-muted)',
                      fontSize: 16,
                      padding: '2px 6px',
                    }}
                  >
                    {'\u2715'}
                  </button>
                </div>

                {/* Volume slider */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      color: 'var(--text-muted)',
                      width: 32,
                    }}
                  >
                    Vol
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(track.volume * 100)}
                    onChange={(e) =>
                      handleVolumeChange(track, Number(e.target.value) / 100)
                    }
                    style={{ flex: 1, accentColor: 'var(--accent)' }}
                  />
                  <span
                    style={{
                      fontSize: 12,
                      color: 'var(--text-muted)',
                      width: 32,
                      textAlign: 'right',
                    }}
                  >
                    {Math.round(track.volume * 100)}%
                  </span>
                </div>

                {/* Controls row */}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => setShowEQ(track)}
                    style={{
                      padding: '4px 12px',
                      background: 'var(--bg-elevated)',
                      color: 'var(--text-secondary)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 12,
                    }}
                  >
                    EQ
                  </button>
                  <button
                    onClick={() => handleToggleCompressor(track)}
                    style={{
                      padding: '4px 12px',
                      background: track.compressorEnabled
                        ? 'var(--accent-dark)'
                        : 'var(--bg-elevated)',
                      color: track.compressorEnabled
                        ? '#fff'
                        : 'var(--text-secondary)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 12,
                    }}
                  >
                    Comp
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Collaborators */}
        {collabs.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <h4
              style={{
                fontSize: 14,
                color: 'var(--text-muted)',
                marginBottom: 8,
              }}
            >
              Collaborators
            </h4>
            {collabs.map((c) => (
              <div
                key={c.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  background: 'var(--bg-card)',
                  borderRadius: 'var(--radius-sm)',
                  marginBottom: 6,
                }}
              >
                <span style={{ flex: 1, fontSize: 14 }}>{c.name}</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {c.email}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: c.accepted
                      ? 'var(--success)'
                      : 'var(--warning)',
                  }}
                >
                  {c.accepted ? 'Accepted' : 'Pending'}
                </span>
                <button
                  onClick={() => {
                    if (c.id !== undefined) {
                      removeCollaborator(c.id);
                      loadData();
                    }
                  }}
                  style={{
                    background: 'none',
                    color: 'var(--text-muted)',
                    fontSize: 14,
                    padding: '2px 6px',
                  }}
                >
                  {'\u2715'}
                </button>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Bottom controls */}
      <div
        style={{
          padding: '12px 24px',
          background: 'var(--bg-secondary)',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 20,
        }}
      >
        {/* Play/Pause */}
        <button
          onClick={handlePlay}
          disabled={tracks.length === 0}
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            background:
              tracks.length === 0
                ? 'var(--bg-elevated)'
                : 'var(--bg-card)',
            color:
              tracks.length === 0
                ? 'var(--text-muted)'
                : 'var(--text-primary)',
            fontSize: 18,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {isPlaying ? '\u23F8' : '\u25B6'}
        </button>

        {/* Record / Stop */}
        <button
          onClick={isRecording ? handleStopRecording : () => setShowNewTrack(true)}
          style={{
            width: 60,
            height: 60,
            borderRadius: '50%',
            background: isRecording ? '#f44336' : 'var(--accent)',
            color: isRecording ? '#fff' : '#000',
            fontSize: 14,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: isRecording
              ? '0 0 20px rgba(244,67,54,0.5)'
              : '0 0 20px rgba(187,134,252,0.3)',
          }}
        >
          {isRecording ? '\u23F9' : '\u{1F3A4}'}
        </button>

        {/* Spacer for symmetry */}
        <div style={{ width: 44 }} />
      </div>

      {/* New track dialog */}
      <Dialog
        open={showNewTrack}
        onClose={() => setShowNewTrack(false)}
        title="New Track"
      >
        <input
          type="text"
          placeholder="Track name"
          value={newTrackName}
          onChange={(e) => setNewTrackName(e.target.value)}
          autoFocus
          style={{
            width: '100%',
            padding: '10px 14px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            fontSize: 16,
            marginBottom: 12,
            outline: 'none',
          }}
        />
        <div style={{ marginBottom: 16 }}>
          <label
            style={{
              fontSize: 13,
              color: 'var(--text-muted)',
              display: 'block',
              marginBottom: 6,
            }}
          >
            Instrument
          </label>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
            }}
          >
            {TRACK_ROLES.map((role) => (
              <button
                key={role}
                onClick={() => setNewTrackRole(role)}
                style={{
                  padding: '6px 12px',
                  borderRadius: 20,
                  fontSize: 12,
                  background:
                    newTrackRole === role
                      ? 'var(--accent)'
                      : 'var(--bg-elevated)',
                  color: newTrackRole === role ? '#000' : 'var(--text-secondary)',
                  fontWeight: newTrackRole === role ? 600 : 400,
                  textTransform: 'capitalize',
                }}
              >
                {role}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={() => setShowNewTrack(false)}
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
            onClick={handleAddTrack}
            style={{
              padding: '8px 20px',
              background: 'var(--accent)',
              color: '#000',
              borderRadius: 'var(--radius-sm)',
              fontWeight: 600,
            }}
          >
            Record
          </button>
        </div>
      </Dialog>

      {/* EQ dialog */}
      <Dialog
        open={showEQ !== null}
        onClose={() => setShowEQ(null)}
        title="Equalizer"
      >
        {showEQ && <EQControls track={showEQ} onSave={handleEQSave} onClose={() => setShowEQ(null)} />}
      </Dialog>

      {/* Collab dialog */}
      <Dialog
        open={showCollab}
        onClose={() => setShowCollab(false)}
        title="Invite Collaborator"
      >
        <input
          type="text"
          placeholder="Name"
          value={collabName}
          onChange={(e) => setCollabName(e.target.value)}
          autoFocus
          style={{
            width: '100%',
            padding: '10px 14px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            fontSize: 16,
            marginBottom: 8,
            outline: 'none',
          }}
        />
        <input
          type="email"
          placeholder="Email"
          value={collabEmail}
          onChange={(e) => setCollabEmail(e.target.value)}
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
            onClick={() => setShowCollab(false)}
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
            onClick={handleAddCollab}
            style={{
              padding: '8px 20px',
              background: 'var(--accent)',
              color: '#000',
              borderRadius: 'var(--radius-sm)',
              fontWeight: 600,
            }}
          >
            Send Invite
          </button>
        </div>
      </Dialog>

      {/* Pulse animation */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}

// EQ Controls sub-component
function EQControls({
  track,
  onSave,
  onClose,
}: {
  track: Track;
  onSave: (track: Track, bass: number, mids: number, treble: number) => void;
  onClose: () => void;
}) {
  const [bass, setBass] = useState(track.eqBass);
  const [mids, setMids] = useState(track.eqMids);
  const [treble, setTreble] = useState(track.eqTreble);

  const dbDisplay = (val: number) => {
    const db = (val - 0.5) * 24;
    return db >= 0 ? `+${db.toFixed(0)} dB` : `${db.toFixed(0)} dB`;
  };

  return (
    <div>
      {[
        { label: 'Bass', value: bass, set: setBass },
        { label: 'Mids', value: mids, set: setMids },
        { label: 'Treble', value: treble, set: setTreble },
      ].map(({ label, value, set }) => (
        <div key={label} style={{ marginBottom: 16 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 13,
              marginBottom: 4,
            }}
          >
            <span>{label}</span>
            <span style={{ color: 'var(--text-muted)' }}>{dbDisplay(value)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(value * 100)}
            onChange={(e) => set(Number(e.target.value) / 100)}
            style={{ width: '100%', accentColor: 'var(--accent)' }}
          />
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          onClick={onClose}
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
          onClick={() => {
            onSave(track, bass, mids, treble);
            onClose();
          }}
          style={{
            padding: '8px 20px',
            background: 'var(--accent)',
            color: '#000',
            borderRadius: 'var(--radius-sm)',
            fontWeight: 600,
          }}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
