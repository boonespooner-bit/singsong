import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { TRACK_ROLES } from '../db/models';
import type { Song, Track, TrackRole } from '../db/models';
import {
  getSong,
  getTracksBySong,
  createTrack,
  updateTrack,
  deleteTrack,
  saveAudioBlob,
  getAudioBlob,
  updateSong,
} from '../db/database';
import { AudioRecorder } from '../audio/recorder';
import { MultitrackPlayer } from '../audio/player';
import { transformAudio } from '../audio/kitsai';
import { Metronome } from '../audio/metronome';
import { mixdownToWav } from '../audio/mixdown';
import { Dialog } from '../components/Dialog';
import { RoleBadge } from '../components/RoleBadge';
import { LevelMeter } from '../components/LevelMeter';

const ROLE_COLORS: Record<TrackRole, string> = {
  vocals: '#e91e63', guitar: '#ff5722', bass: '#ff9800', drums: '#ffc107',
  piano: '#4caf50', synth: '#00bcd4', strings: '#9c27b0', other: '#607d8b',
};

// --- Waveform peak computation ---
async function computePeaks(blob: Blob, numBins: number): Promise<Float32Array> {
  const ctx = new AudioContext();
  const ab = await blob.arrayBuffer();
  let buf: AudioBuffer;
  try { buf = await ctx.decodeAudioData(ab); } catch { ctx.close(); return new Float32Array(numBins); }
  ctx.close();
  const channel = buf.getChannelData(0);
  const peaks = new Float32Array(numBins);
  const samplesPerBin = Math.floor(channel.length / numBins) || 1;
  for (let i = 0; i < numBins; i++) {
    let max = 0;
    const start = i * samplesPerBin;
    for (let j = start; j < start + samplesPerBin && j < channel.length; j++) {
      const v = Math.abs(channel[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  return peaks;
}

async function getTrackDuration(blob: Blob): Promise<number> {
  const ctx = new AudioContext();
  const ab = await blob.arrayBuffer();
  try {
    const buf = await ctx.decodeAudioData(ab);
    ctx.close();
    return buf.duration;
  } catch { ctx.close(); return 0; }
}

export function SongEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const songId = Number(id);

  const [song, setSong] = useState<Song | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  // Waveform data per track
  const [trackPeaks, setTrackPeaks] = useState<Record<number, Float32Array>>({});
  const [trackDurations, setTrackDurations] = useState<Record<number, number>>({});

  // Recording
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTrackId, setRecordingTrackId] = useState<number | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [liveWaveform, setLiveWaveform] = useState<Float32Array | null>(null);

  // Playback
  const [isPlaying, setIsPlaying] = useState(false);
  const [playPos, setPlayPos] = useState(0);
  const playStartRef = useRef(0);
  const playAnimRef = useRef(0);

  // AI processing
  const [aiProcessingTrackId, setAiProcessingTrackId] = useState<number | null>(null);
  const [aiStatus, setAiStatus] = useState('');

  // Mixer: local mute/solo state
  const [mutedTracks, setMutedTracks] = useState<Set<number>>(new Set());
  const [soloTracks, setSoloTracks] = useState<Set<number>>(new Set());

  // Metronome
  const [metronomeEnabled, setMetronomeEnabled] = useState(false);
  const [bpm, setBpm] = useState(120);
  const [currentBeat, setCurrentBeat] = useState(-1);
  const [countInEnabled, setCountInEnabled] = useState(true);

  // Dialogs
  const [showNewTrack, setShowNewTrack] = useState(false);
  const [newTrackName, setNewTrackName] = useState('');
  const [newTrackRole, setNewTrackRole] = useState<TrackRole>('vocals');
  const [showEQ, setShowEQ] = useState<Track | null>(null);

  // Delete confirmation
  const [deleteConfirmTrackId, setDeleteConfirmTrackId] = useState<number | null>(null);

  // Mix download
  const [mixingDown, setMixingDown] = useState(false);

  const recorderRef = useRef(new AudioRecorder());
  const playerRef = useRef(new MultitrackPlayer());
  const metronomeRef = useRef(new Metronome());

  // --- Data loading ---
  const loadData = useCallback(async () => {
    const [s, t] = await Promise.all([getSong(songId), getTracksBySong(songId)]);
    if (s) setSong(s);
    setTracks(t);
  }, [songId]);

  useEffect(() => { loadData(); }, [loadData]);

  // Load waveform peaks when tracks change
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const newPeaks: Record<number, Float32Array> = {};
      const newDurations: Record<number, number> = {};
      for (const track of tracks) {
        if (track.id === undefined) continue;
        if (trackPeaks[track.id]) {
          newPeaks[track.id] = trackPeaks[track.id];
          newDurations[track.id] = trackDurations[track.id] ?? 0;
          continue;
        }
        const blob = await getAudioBlob(track.id);
        if (blob && blob.size > 0) {
          newPeaks[track.id] = await computePeaks(blob, 800);
          newDurations[track.id] = await getTrackDuration(blob);
        }
      }
      if (!cancelled) {
        setTrackPeaks(newPeaks);
        setTrackDurations(newDurations);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks]);

  const maxDuration = Math.max(10, ...Object.values(trackDurations), 0);

  // --- Title editing ---
  const startEditTitle = () => {
    if (song) { setTitleDraft(song.name); setEditingTitle(true); }
  };
  const saveTitle = async () => {
    if (song && titleDraft.trim()) {
      const updated = { ...song, name: titleDraft.trim() };
      await updateSong(updated);
      setSong(updated);
    }
    setEditingTitle(false);
  };

  // --- Recording ---
  const handleAddTrack = async () => {
    const name = newTrackName.trim();
    if (!name) return;
    const trackId = await createTrack({
      songId, name, role: newTrackRole, volume: 0.8,
      eqBass: 0.5, eqMids: 0.5, eqTreble: 0.5,
      compressorEnabled: false, aiProcessed: false, createdAt: Date.now(),
    });
    setNewTrackName('');
    setNewTrackRole('vocals');
    setShowNewTrack(false);
    await loadData();

    // Count-in if metronome is on
    if (metronomeEnabled && countInEnabled) {
      const met = metronomeRef.current;
      met.bpm = bpm;
      met.onTick = setCurrentBeat;
      await met.countIn();
      setCurrentBeat(-1);
    }

    setRecordingTrackId(trackId);
    setIsRecording(true);
    await recorderRef.current.start(setAudioLevel, setLiveWaveform);
    if (metronomeEnabled) {
      const met = metronomeRef.current;
      met.bpm = bpm;
      met.onTick = setCurrentBeat;
      met.start();
    }
  };

  const handleStopRecording = async () => {
    const blob = await recorderRef.current.stop();
    metronomeRef.current.stop();
    setCurrentBeat(-1);
    setIsRecording(false);
    setAudioLevel(0);
    setLiveWaveform(null);

    if (!recordingTrackId || blob.size === 0) {
      setRecordingTrackId(null);
      await loadData();
      return;
    }

    const trackId = recordingTrackId;
    const track = tracks.find((t) => t.id === trackId);
    setRecordingTrackId(null);

    if (track && track.role !== 'vocals' && track.role !== 'other') {
      setAiProcessingTrackId(trackId);
      try {
        const converted = await transformAudio(blob, track.role, setAiStatus);
        await saveAudioBlob(trackId, converted);
        await updateTrack({ ...track, aiProcessed: true });
      } catch (err) {
        console.error('AI transform failed, saving raw audio:', err);
        await saveAudioBlob(trackId, blob);
      } finally {
        setAiProcessingTrackId(null);
        setAiStatus('');
      }
    } else {
      await saveAudioBlob(trackId, blob);
    }
    await loadData();
  };

  // --- Playback ---
  const handlePlay = async () => {
    if (isPlaying) {
      playerRef.current.stop();
      metronomeRef.current.stop();
      setCurrentBeat(-1);
      setIsPlaying(false);
      cancelAnimationFrame(playAnimRef.current);
      return;
    }
    setIsPlaying(true);
    await playerRef.current.play(tracks, getAudioBlob);

    if (metronomeEnabled) {
      const met = metronomeRef.current;
      met.bpm = bpm;
      met.onTick = setCurrentBeat;
      met.start();
    }

    playStartRef.current = performance.now() / 1000;
    const animate = () => {
      if (!playerRef.current.playing) {
        setIsPlaying(false);
        setPlayPos(0);
        metronomeRef.current.stop();
        setCurrentBeat(-1);
        return;
      }
      setPlayPos(performance.now() / 1000 - playStartRef.current);
      playAnimRef.current = requestAnimationFrame(animate);
    };
    animate();
  };

  const handleStop = () => {
    playerRef.current.stop();
    metronomeRef.current.stop();
    setCurrentBeat(-1);
    setIsPlaying(false);
    setPlayPos(0);
    cancelAnimationFrame(playAnimRef.current);
  };

  // --- Mixer ---
  const handleVolumeChange = async (track: Track, volume: number) => {
    const updated = { ...track, volume };
    await updateTrack(updated);
    playerRef.current.updateTrackVolume(track.id!, volume);
    setTracks((prev) => prev.map((t) => (t.id === track.id ? updated : t)));
  };

  // Apply effective volumes to the audio player based on mute/solo state
  const applyMixVolumes = useCallback((muted: Set<number>, solo: Set<number>) => {
    const hasSolo = solo.size > 0;
    for (const track of tracks) {
      if (track.id === undefined) continue;
      const audible = hasSolo ? solo.has(track.id) : !muted.has(track.id);
      playerRef.current.updateTrackVolume(track.id, audible ? track.volume : 0);
    }
  }, [tracks]);

  const toggleMute = (id: number) => {
    setMutedTracks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      applyMixVolumes(next, soloTracks);
      return next;
    });
  };

  const toggleSolo = (id: number) => {
    setSoloTracks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      applyMixVolumes(mutedTracks, next);
      return next;
    });
  };

  const handleEQSave = async (track: Track, bass: number, mids: number, treble: number) => {
    const updated = { ...track, eqBass: bass, eqMids: mids, eqTreble: treble };
    await updateTrack(updated);
    playerRef.current.updateTrackEQ(track.id!, bass, mids, treble);
    setTracks((prev) => prev.map((t) => (t.id === track.id ? updated : t)));
  };

  const handleToggleCompressor = async (track: Track) => {
    const updated = { ...track, compressorEnabled: !track.compressorEnabled };
    await updateTrack(updated);
    setTracks((prev) => prev.map((t) => (t.id === track.id ? updated : t)));
  };

  const handleDeleteTrack = (trackId: number) => {
    setDeleteConfirmTrackId(trackId);
  };

  const confirmDeleteTrack = async () => {
    if (deleteConfirmTrackId === null) return;
    await deleteTrack(deleteConfirmTrackId, songId);
    setDeleteConfirmTrackId(null);
    loadData();
  };

  // --- Mix download ---
  const handleDownloadMix = async () => {
    setMixingDown(true);
    try {
      const wavBlob = await mixdownToWav(tracks, getAudioBlob);
      const url = URL.createObjectURL(wavBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${song?.name || 'mix'}.wav`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Mixdown failed:', e);
    } finally {
      setMixingDown(false);
    }
  };

  if (!song) {
    return <div style={{ padding: 24, textAlign: 'center', color: '#888' }}>Loading...</div>;
  }

  const busy = aiProcessingTrackId !== null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0d0d0d' }}>
      {/* ===== HEADER ===== */}
      <header style={{
        padding: '8px 16px', background: '#1a1a1a', borderBottom: '1px solid #2a2a2a',
        display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
      }}>
        <button onClick={() => { playerRef.current.stop(); navigate('/'); }}
          style={{ background: 'none', color: '#aaa', fontSize: 18, padding: '4px 8px' }}>{'\u2190'}</button>
        {editingTitle ? (
          <input value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={saveTitle} onKeyDown={(e) => e.key === 'Enter' && saveTitle()} autoFocus
            style={{
              flex: 1, background: '#2a2a2a', border: '1px solid #bb86fc', borderRadius: 4,
              color: '#fff', padding: '4px 8px', fontSize: 16, fontWeight: 600, outline: 'none',
            }} />
        ) : (
          <h2 onClick={startEditTitle} style={{
            flex: 1, fontSize: 16, fontWeight: 600, cursor: 'pointer',
            color: '#fff', padding: '4px 0',
          }} title="Click to edit title">{song.name}</h2>
        )}
        <button onClick={handleDownloadMix} disabled={tracks.length === 0 || mixingDown}
          style={{
            padding: '6px 12px', background: '#2a2a2a', color: tracks.length ? '#ccc' : '#555',
            borderRadius: 4, fontSize: 12, fontWeight: 500,
          }}>{mixingDown ? 'Mixing...' : 'Download Mix'}</button>
      </header>

      {/* ===== TRANSPORT BAR ===== */}
      <div style={{
        padding: '6px 16px', background: '#1e1e1e', borderBottom: '1px solid #2a2a2a',
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap',
      }}>
        <button onClick={handleStop} style={transportBtnStyle} title="Stop">{'\u23F9'}</button>
        <button onClick={handlePlay} disabled={tracks.length === 0 || busy}
          style={{ ...transportBtnStyle, color: isPlaying ? '#4caf50' : '#ccc' }}
          title={isPlaying ? 'Pause' : 'Play'}>{isPlaying ? '\u23F8' : '\u25B6'}</button>
        <button onClick={isRecording ? handleStopRecording : () => setShowNewTrack(true)}
          disabled={busy && !isRecording}
          style={{ ...transportBtnStyle, color: isRecording ? '#f44336' : '#ccc', fontSize: 16 }}
          title={isRecording ? 'Stop Recording' : 'Record'}>{'\u23FA'}</button>

        <div style={{ width: 1, height: 24, background: '#333', margin: '0 4px' }} />

        <div style={{
          fontFamily: 'monospace', fontSize: 14, color: '#4caf50', background: '#0a0a0a',
          padding: '4px 12px', borderRadius: 4, minWidth: 80, textAlign: 'center',
        }}>{formatTime(playPos)}</div>

        <div style={{ width: 1, height: 24, background: '#333', margin: '0 4px' }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 11, color: '#888' }}>BPM</span>
          <input type="number" value={bpm} min={40} max={300}
            onChange={(e) => setBpm(Number(e.target.value) || 120)}
            style={{
              width: 48, background: '#0a0a0a', border: '1px solid #333', borderRadius: 4,
              color: '#fff', textAlign: 'center', fontSize: 13, padding: '3px 4px',
            }} />
        </div>

        <button onClick={() => setMetronomeEnabled(!metronomeEnabled)}
          style={{
            ...transportBtnStyle, fontSize: 11, fontWeight: 600, padding: '4px 8px', borderRadius: 4,
            background: metronomeEnabled ? '#bb86fc33' : 'transparent',
            color: metronomeEnabled ? '#bb86fc' : '#888',
          }} title="Toggle metronome">{'\u{266A}'} Metro</button>

        {metronomeEnabled && (
          <button onClick={() => setCountInEnabled(!countInEnabled)}
            style={{
              ...transportBtnStyle, fontSize: 11, padding: '4px 8px', borderRadius: 4,
              background: countInEnabled ? '#ff980033' : 'transparent',
              color: countInEnabled ? '#ff9800' : '#888',
            }} title="Count-in before recording">Count-in</button>
        )}

        {metronomeEnabled && (
          <div style={{ display: 'flex', gap: 4, marginLeft: 4 }}>
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} style={{
                width: 10, height: 10, borderRadius: '50%',
                background: currentBeat === i ? (i === 0 ? '#ff9800' : '#bb86fc') : '#333',
                transition: 'background 0.05s',
              }} />
            ))}
          </div>
        )}

        {busy && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%', background: '#bb86fc',
              animation: 'pulse 1s infinite',
            }} />
            <span style={{ fontSize: 11, color: '#bb86fc' }}>{aiStatus || 'AI Processing...'}</span>
          </div>
        )}
      </div>

      {/* ===== RECORDING LEVEL ===== */}
      {isRecording && (
        <div style={{ padding: '4px 16px', background: '#1a0a0a', borderBottom: '1px solid #331111', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#f44336', animation: 'pulse 1s infinite' }} />
            <span style={{ fontSize: 12, color: '#f44336', fontWeight: 600 }}>REC</span>
          </div>
          <LevelMeter level={audioLevel} />
        </div>
      )}

      {/* ===== TRACK ARRANGEMENT (DAW-style) ===== */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
        {/* Timeline ruler */}
        <div style={{ display: 'flex', borderBottom: '1px solid #2a2a2a', flexShrink: 0 }}>
          <div style={{ width: 180, minWidth: 180, background: '#1a1a1a', borderRight: '1px solid #2a2a2a', height: 24 }} />
          <div style={{ flex: 1, position: 'relative', height: 24, background: '#111', overflow: 'hidden' }}>
            <TimelineRuler duration={maxDuration} />
            {isPlaying && (
              <div style={{
                position: 'absolute', top: 0, bottom: 0, width: 1, background: '#4caf50',
                left: `${(playPos / maxDuration) * 100}%`, zIndex: 2,
              }} />
            )}
          </div>
        </div>

        {/* Track lanes */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {tracks.length === 0 && !isRecording ? (
            <div style={{ textAlign: 'center', padding: 60, color: '#555' }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>{'\u{1F3A4}'}</div>
              <p>No tracks yet. Click the record button to add a track.</p>
            </div>
          ) : (
            tracks.map((track) => {
              const peaks = track.id !== undefined ? trackPeaks[track.id] : undefined;
              const duration = track.id !== undefined ? (trackDurations[track.id] ?? 0) : 0;
              const isMuted = track.id !== undefined && mutedTracks.has(track.id);
              const isSolo = track.id !== undefined && soloTracks.has(track.id);
              const hasSoloActive = soloTracks.size > 0;
              const audible = hasSoloActive ? isSolo : !isMuted;

              return (
                <div key={track.id} style={{
                  display: 'flex', borderBottom: '1px solid #1a1a1a',
                  opacity: audible ? 1 : 0.4,
                }}>
                  {/* Track header */}
                  <div style={{
                    width: 180, minWidth: 180, padding: '8px 12px', background: '#1a1a1a',
                    borderRight: '1px solid #2a2a2a', display: 'flex', flexDirection: 'column', gap: 4,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <RoleBadge role={track.role} />
                      {track.aiProcessed && (
                        <span style={{
                          fontSize: 9, padding: '1px 5px', borderRadius: 4,
                          background: '#bb86fc33', color: '#bb86fc', fontWeight: 700,
                        }}>AI</span>
                      )}
                    </div>
                    <span style={{ fontSize: 12, color: '#ccc', fontWeight: 500 }}>{track.name}</span>
                    <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                      <button onClick={() => track.id !== undefined && toggleMute(track.id)}
                        style={{ ...smallBtnStyle, background: isMuted ? '#f44336' : '#2a2a2a', color: isMuted ? '#fff' : '#888' }}>M</button>
                      <button onClick={() => track.id !== undefined && toggleSolo(track.id)}
                        style={{ ...smallBtnStyle, background: isSolo ? '#ffc107' : '#2a2a2a', color: isSolo ? '#000' : '#888' }}>S</button>
                      <button onClick={() => track.id !== undefined && handleDeleteTrack(track.id)}
                        style={{ ...smallBtnStyle, color: '#666', marginLeft: 'auto' }}>{'\u2715'}</button>
                    </div>
                  </div>

                  {/* Track waveform lane */}
                  <div style={{ flex: 1, height: 80, background: '#111', position: 'relative', overflow: 'hidden' }}>
                    {peaks && duration > 0 && (
                      <TrackWaveformCanvas peaks={peaks} duration={duration}
                        maxDuration={maxDuration} color={ROLE_COLORS[track.role]} />
                    )}
                    {recordingTrackId === track.id && liveWaveform && (
                      <LiveWaveformCanvas data={liveWaveform} color="#f44336" />
                    )}
                    {isPlaying && (
                      <div style={{
                        position: 'absolute', top: 0, bottom: 0, width: 1, background: '#4caf50',
                        left: `${(playPos / maxDuration) * 100}%`, zIndex: 2,
                      }} />
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ===== MIXER PANEL ===== */}
      <div style={{
        height: 220, minHeight: 220, background: '#151515', borderTop: '2px solid #2a2a2a',
        display: 'flex', overflow: 'auto', padding: '8px 0', flexShrink: 0,
      }}>
        {tracks.map((track) => (
          <MixerStrip key={track.id} track={track}
            isMuted={track.id !== undefined && mutedTracks.has(track.id)}
            isSolo={track.id !== undefined && soloTracks.has(track.id)}
            onVolumeChange={(v) => handleVolumeChange(track, v)}
            onToggleMute={() => track.id !== undefined && toggleMute(track.id)}
            onToggleSolo={() => track.id !== undefined && toggleSolo(track.id)}
            onEQ={() => setShowEQ(track)}
            onToggleCompressor={() => handleToggleCompressor(track)}
          />
        ))}
        <div style={{ minWidth: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px' }}>
          <button onClick={() => setShowNewTrack(true)} disabled={busy}
            style={{
              width: 44, height: 44, borderRadius: '50%', fontSize: 20,
              background: busy ? '#333' : '#bb86fc33', color: busy ? '#555' : '#bb86fc',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>+</button>
        </div>
      </div>

      {/* ===== DIALOGS ===== */}
      <Dialog open={showNewTrack} onClose={() => setShowNewTrack(false)} title="New Track">
        <input type="text" placeholder="Track name" value={newTrackName}
          onChange={(e) => setNewTrackName(e.target.value)} autoFocus style={dialogInputStyle} />
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: '#888', display: 'block', marginBottom: 6 }}>Instrument</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {TRACK_ROLES.map((role) => (
              <button key={role} onClick={() => setNewTrackRole(role)}
                style={{
                  padding: '6px 12px', borderRadius: 20, fontSize: 12,
                  background: newTrackRole === role ? '#bb86fc' : '#2a2a2a',
                  color: newTrackRole === role ? '#000' : '#aaa',
                  fontWeight: newTrackRole === role ? 600 : 400, textTransform: 'capitalize',
                }}>{role}</button>
            ))}
          </div>
        </div>
        {newTrackRole !== 'vocals' && newTrackRole !== 'other' && (
          <p style={{ fontSize: 12, color: '#bb86fc', marginBottom: 12, lineHeight: 1.4 }}>
            AI will transform your recording to sound like {newTrackRole} using KITS.AI
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={() => setShowNewTrack(false)}
            style={{ padding: '8px 16px', background: 'none', color: '#888', borderRadius: 4 }}>Cancel</button>
          <button onClick={handleAddTrack}
            style={{ padding: '8px 20px', background: '#bb86fc', color: '#000', borderRadius: 4, fontWeight: 600 }}>Record</button>
        </div>
      </Dialog>

      <Dialog open={showEQ !== null} onClose={() => setShowEQ(null)} title="Equalizer">
        {showEQ && <EQControls track={showEQ} onSave={handleEQSave} onClose={() => setShowEQ(null)} />}
      </Dialog>

      <Dialog open={deleteConfirmTrackId !== null} onClose={() => setDeleteConfirmTrackId(null)} title="Delete Track">
        <p style={{ color: '#ccc', marginBottom: 16, fontSize: 14 }}>
          Are you sure you want to delete "<strong>{tracks.find(t => t.id === deleteConfirmTrackId)?.name}</strong>"? This cannot be undone.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={() => setDeleteConfirmTrackId(null)}
            style={{ padding: '8px 16px', background: 'none', color: '#888', borderRadius: 4 }}>Cancel</button>
          <button onClick={confirmDeleteTrack}
            style={{ padding: '8px 20px', background: '#f44336', color: '#fff', borderRadius: 4, fontWeight: 600 }}>Delete</button>
        </div>
      </Dialog>

      <style>{`
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
        input[type=range] { accent-color: #bb86fc; }
      `}</style>
    </div>
  );
}

// --- Sub-components ---

function TimelineRuler({ duration }: { duration: number }) {
  const ticks: number[] = [];
  const step = duration <= 30 ? 1 : duration <= 120 ? 5 : 10;
  for (let t = 0; t <= duration; t += step) ticks.push(t);

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      {ticks.map((t) => (
        <div key={t} style={{
          position: 'absolute', left: `${(t / duration) * 100}%`, top: 0, bottom: 0,
          borderLeft: '1px solid #333',
        }}>
          <span style={{ position: 'absolute', top: 2, left: 4, fontSize: 9, color: '#666', whiteSpace: 'nowrap' }}>
            {formatTime(t)}
          </span>
        </div>
      ))}
    </div>
  );
}

function TrackWaveformCanvas({ peaks, duration, maxDuration, color }: {
  peaks: Float32Array; duration: number; maxDuration: number; color: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const parent = canvas.parentElement!;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const trackWidth = (duration / maxDuration) * w;
    const midY = h / 2;

    ctx.fillStyle = color + '15';
    ctx.fillRect(0, 0, trackWidth, h);

    ctx.strokeStyle = color + '33';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(trackWidth, midY); ctx.stroke();

    const binsToShow = Math.floor(peaks.length * (trackWidth / w)) || 1;
    const barW = trackWidth / binsToShow;
    ctx.fillStyle = color + 'cc';
    for (let i = 0; i < binsToShow && i < peaks.length; i++) {
      const x = i * barW;
      const amp = peaks[i] * midY * 0.9;
      ctx.fillRect(x, midY - amp, Math.max(barW - 0.5, 0.5), amp * 2);
    }
  }, [peaks, duration, maxDuration, color]);

  return <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />;
}

function LiveWaveformCanvas({ data, color }: { data: Float32Array; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const parent = canvas.parentElement!;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const midY = h / 2;
    const step = Math.max(1, Math.floor(data.length / w));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < w; i++) {
      const idx = i * step;
      const val = idx < data.length ? data[idx] : 0;
      const y = midY + val * midY;
      if (i === 0) ctx.moveTo(i, y); else ctx.lineTo(i, y);
    }
    ctx.stroke();
  }, [data, color]);

  return <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />;
}

function MixerStrip({ track, isMuted, isSolo, onVolumeChange, onToggleMute, onToggleSolo, onEQ, onToggleCompressor }: {
  track: Track; isMuted: boolean; isSolo: boolean;
  onVolumeChange: (v: number) => void; onToggleMute: () => void;
  onToggleSolo: () => void; onEQ: () => void; onToggleCompressor: () => void;
}) {
  const volDb = track.volume > 0 ? (20 * Math.log10(track.volume)).toFixed(1) : '-inf';

  return (
    <div style={{
      minWidth: 72, width: 72, display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '8px 4px', borderRight: '1px solid #2a2a2a', gap: 4,
    }}>
      <span style={{ fontSize: 10, color: '#aaa', fontWeight: 600, textAlign: 'center', lineHeight: 1.2 }}>
        {track.name.length > 8 ? track.name.slice(0, 7) + '\u2026' : track.name}
      </span>
      <RoleBadge role={track.role} />

      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', width: '100%',
      }}>
        <input type="range" min={0} max={100} value={Math.round(track.volume * 100)}
          onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
          className="vertical-fader"
          style={{
            writingMode: 'vertical-lr' as React.CSSProperties['writingMode'],
            direction: 'rtl' as React.CSSProperties['direction'],
            height: 80, width: 24,
            accentColor: ROLE_COLORS[track.role],
          }} />
        <span style={{ fontSize: 9, color: '#888', marginTop: 2 }}>{volDb} dB</span>
      </div>

      <div style={{ display: 'flex', gap: 3 }}>
        <button onClick={onToggleMute} style={{
          ...mixBtnStyle, background: isMuted ? '#f44336' : '#2a2a2a', color: isMuted ? '#fff' : '#888',
        }}>M</button>
        <button onClick={onToggleSolo} style={{
          ...mixBtnStyle, background: isSolo ? '#ffc107' : '#2a2a2a', color: isSolo ? '#000' : '#888',
        }}>S</button>
      </div>
      <div style={{ display: 'flex', gap: 3 }}>
        <button onClick={onEQ} style={mixBtnStyle}>EQ</button>
        <button onClick={onToggleCompressor} style={{
          ...mixBtnStyle, background: track.compressorEnabled ? '#4caf50' : '#2a2a2a',
          color: track.compressorEnabled ? '#fff' : '#888',
        }}>C</button>
      </div>
    </div>
  );
}

function EQControls({ track, onSave, onClose }: {
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
        { label: 'Bass (320 Hz)', value: bass, set: setBass },
        { label: 'Mids (1 kHz)', value: mids, set: setMids },
        { label: 'Treble (3.2 kHz)', value: treble, set: setTreble },
      ].map(({ label, value, set }) => (
        <div key={label} style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
            <span>{label}</span>
            <span style={{ color: '#888' }}>{dbDisplay(value)}</span>
          </div>
          <input type="range" min={0} max={100} value={Math.round(value * 100)}
            onChange={(e) => set(Number(e.target.value) / 100)} style={{ width: '100%' }} />
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose}
          style={{ padding: '8px 16px', background: 'none', color: '#888', borderRadius: 4 }}>Cancel</button>
        <button onClick={() => { onSave(track, bass, mids, treble); onClose(); }}
          style={{ padding: '8px 20px', background: '#bb86fc', color: '#000', borderRadius: 4, fontWeight: 600 }}>Apply</button>
      </div>
    </div>
  );
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 10);
  return `${m}:${s.toString().padStart(2, '0')}.${ms}`;
}

const transportBtnStyle: React.CSSProperties = {
  background: 'none', color: '#ccc', fontSize: 14, padding: '4px 8px',
  borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
};

const smallBtnStyle: React.CSSProperties = {
  padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 700,
  background: '#2a2a2a', color: '#888', border: 'none', cursor: 'pointer',
};

const mixBtnStyle: React.CSSProperties = {
  padding: '3px 6px', borderRadius: 3, fontSize: 9, fontWeight: 700,
  background: '#2a2a2a', color: '#888', border: 'none', cursor: 'pointer',
};

const dialogInputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 14px', background: '#1e1e1e',
  border: '1px solid #333', borderRadius: 4, color: '#fff', fontSize: 16,
  marginBottom: 12, outline: 'none',
};
