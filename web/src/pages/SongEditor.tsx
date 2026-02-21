import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { TRACK_ROLES } from '../db/models';
import type { Song, Track, TrackRole, BranchSummary, BranchDetail, Invitation } from '../db/models';
import {
  getSong,
  getTracksBySong,
  createTrack,
  updateTrack,
  deleteTrack,
  saveAudioBlob,
  getAudioBlob,
  updateSong,
  exportSongData,
  importTrackToSong,
} from '../db/database';
import { AudioRecorder } from '../audio/recorder';
import { MultitrackPlayer } from '../audio/player';
import { transformAudio } from '../audio/kitsai';
import { Metronome } from '../audio/metronome';
import { mixdownToWav } from '../audio/mixdown';
import { decodeBlob, encodeToWav, deleteRegion, copyRegion, insertRegion } from '../audio/bufferOps';
import { quantizeAudio, type QuantizeResolution } from '../audio/quantize';
import { Dialog } from '../components/Dialog';
import { RoleBadge } from '../components/RoleBadge';
import { LevelMeter } from '../components/LevelMeter';
import { useAuth } from '../auth/AuthContext';
import {
  publishSong,
  inviteCollaborator,
  getBranches,
  getBranchDetail,
  getCollaborators as fetchCollaborators,
  syncBranch,
  getShareId,
  getBranchId,
} from '../collab/collabApi';

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
  const [recordArmedTrackId, setRecordArmedTrackId] = useState<number | null>(null);

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

  // Waveform selection & editing
  const [selection, setSelection] = useState<{ trackId: number; startTime: number; endTime: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [clipboard, setClipboard] = useState<AudioBuffer | null>(null);
  const [editMode, setEditMode] = useState<'snap' | 'freeform'>('snap');

  // Effects dialog
  const [showEffects, setShowEffects] = useState<Track | null>(null);

  // Quantize dialog
  const [showQuantize, setShowQuantize] = useState<Track | null>(null);

  // Pitch correction / auto-tune dialog
  const [showPitchCorrect, setShowPitchCorrect] = useState<Track | null>(null);

  // Mix download
  const [mixingDown, setMixingDown] = useState(false);

  // Collaboration
  const { user } = useAuth();
  const [showCollab, setShowCollab] = useState(false);
  const [collabStatus, setCollabStatus] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [collabInvitations, setCollabInvitations] = useState<Invitation[]>([]);
  const [collabBranches, setCollabBranches] = useState<BranchSummary[]>([]);
  const [viewingBranch, setViewingBranch] = useState<BranchDetail | null>(null);
  const [importingTrackIdx, setImportingTrackIdx] = useState<number | null>(null);
  const shareId = getShareId(songId);
  const branchId = getBranchId(songId);

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
  const toggleRecordArm = (trackId: number) => {
    setRecordArmedTrackId((prev) => (prev === trackId ? null : trackId));
  };

  const handlePunchIn = async () => {
    if (recordArmedTrackId === null) return;
    const trackId = recordArmedTrackId;

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

    // Play back all other tracks while recording
    const otherTracks = tracks.filter((t) => t.id !== trackId);
    if (otherTracks.length > 0) {
      setIsPlaying(true);
      await playerRef.current.play(otherTracks, getAudioBlob);
      playStartRef.current = performance.now() / 1000;
      const animate = () => {
        if (!playerRef.current.playing) {
          setPlayPos(0);
          return;
        }
        setPlayPos(performance.now() / 1000 - playStartRef.current);
        playAnimRef.current = requestAnimationFrame(animate);
      };
      animate();
    }

    await recorderRef.current.start(setAudioLevel, setLiveWaveform);
    if (metronomeEnabled) {
      const met = metronomeRef.current;
      met.bpm = bpm;
      met.onTick = setCurrentBeat;
      met.start();
    }
  };

  const handleRecordButton = () => {
    if (isRecording) {
      handleStopRecording();
    } else if (recordArmedTrackId !== null) {
      handlePunchIn();
    } else {
      setShowNewTrack(true);
    }
  };

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

    // Stop playback if it was running during punch-in
    if (isPlaying) {
      playerRef.current.stop();
      setIsPlaying(false);
      setPlayPos(0);
      cancelAnimationFrame(playAnimRef.current);
    }

    if (!recordingTrackId || blob.size === 0) {
      setRecordingTrackId(null);
      await loadData();
      return;
    }

    const trackId = recordingTrackId;
    const track = tracks.find((t) => t.id === trackId);
    const wasPunchIn = recordArmedTrackId === trackId;
    setRecordingTrackId(null);
    if (wasPunchIn) setRecordArmedTrackId(null);

    if (track && track.role !== 'vocals' && track.role !== 'other' && !wasPunchIn) {
      // AI transform only for brand-new tracks (not punch-in re-records)
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
      // For punch-in, clear AI processed flag since this is fresh audio
      if (wasPunchIn && track?.aiProcessed) {
        await updateTrack({ ...track, aiProcessed: false });
      }
    }

    // Clear cached peaks so waveform refreshes for the re-recorded track
    setTrackPeaks((prev) => {
      const next = { ...prev };
      delete next[trackId];
      return next;
    });
    setTrackDurations((prev) => {
      const next = { ...prev };
      delete next[trackId];
      return next;
    });
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

  // --- Snap helper ---
  const barDuration = (60 / bpm) * 4; // 4/4 time
  const snapTime = useCallback((time: number) => {
    if (editMode === 'freeform') return Math.max(0, time);
    const bd = (60 / bpm) * 4;
    return Math.max(0, Math.round(time / bd) * bd);
  }, [editMode, bpm]);

  // --- Selection handlers ---
  const handleSelectionStart = (trackId: number, e: React.MouseEvent<HTMLDivElement>) => {
    if (isRecording) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = snapTime((x / rect.width) * maxDuration);
    setSelection({ trackId, startTime: time, endTime: time });
    setIsDragging(true);
  };

  const handleSelectionMove = (trackId: number, e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging || !selection || selection.trackId !== trackId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = snapTime((x / rect.width) * maxDuration);
    setSelection((prev) => prev ? { ...prev, endTime: time } : null);
  };

  const handleSelectionEnd = () => {
    if (!isDragging) return;
    setIsDragging(false);
    // Clear selection if start === end (just a click)
    if (selection && Math.abs(selection.endTime - selection.startTime) < 0.01) {
      setSelection(null);
    }
  };

  // --- Region operations ---
  const getSelectionRange = () => {
    if (!selection) return null;
    const start = Math.min(selection.startTime, selection.endTime);
    const end = Math.max(selection.startTime, selection.endTime);
    return { trackId: selection.trackId, start, end };
  };

  const handleDeleteRegion = async () => {
    const range = getSelectionRange();
    if (!range) return;
    const blob = await getAudioBlob(range.trackId);
    if (!blob) return;
    const buf = await decodeBlob(blob);
    if (!buf) return;
    const edited = deleteRegion(buf, range.start, range.end);
    const wav = encodeToWav(edited);
    await saveAudioBlob(range.trackId, wav);
    // Clear cached peaks
    setTrackPeaks((prev) => { const n = { ...prev }; delete n[range.trackId]; return n; });
    setTrackDurations((prev) => { const n = { ...prev }; delete n[range.trackId]; return n; });
    setSelection(null);
    await loadData();
  };

  const handleCopyRegion = async () => {
    const range = getSelectionRange();
    if (!range) return;
    const blob = await getAudioBlob(range.trackId);
    if (!blob) return;
    const buf = await decodeBlob(blob);
    if (!buf) return;
    setClipboard(copyRegion(buf, range.start, range.end));
  };

  const handleCutRegion = async () => {
    await handleCopyRegion();
    await handleDeleteRegion();
  };

  const handlePasteRegion = async () => {
    if (!clipboard) return;
    const range = getSelectionRange();
    // Paste at selection start or at play position or at end of track
    const targetTrackId = range?.trackId ?? selection?.trackId;
    if (!targetTrackId) return;
    const pasteAt = range?.start ?? playPos;
    const blob = await getAudioBlob(targetTrackId);
    if (!blob) return;
    const buf = await decodeBlob(blob);
    if (!buf) return;
    const edited = insertRegion(buf, clipboard, pasteAt);
    const wav = encodeToWav(edited);
    await saveAudioBlob(targetTrackId, wav);
    setTrackPeaks((prev) => { const n = { ...prev }; delete n[targetTrackId]; return n; });
    setTrackDurations((prev) => { const n = { ...prev }; delete n[targetTrackId]; return n; });
    setSelection(null);
    await loadData();
  };

  // --- Effects handlers ---
  const handleEffectsSave = async (track: Track, reverb: number, delay: number, delayTime: number, chorus: number) => {
    const updated = { ...track, reverbMix: reverb, delayMix: delay, delayTime, chorusMix: chorus };
    await updateTrack(updated);
    playerRef.current.updateTrackEffects(track.id!, reverb, delay, delayTime, chorus);
    setTracks((prev) => prev.map((t) => (t.id === track.id ? updated : t)));
  };

  // --- Quantize handler ---
  const handleQuantize = async (track: Track, resolution: QuantizeResolution, strength: number, sensitivity: number) => {
    if (!track.id) return;
    setBusy(true);
    try {
      const blob = await getAudioBlob(track.id);
      if (!blob) return;
      const buf = await decodeBlob(blob);
      if (!buf) return;
      const quantized = quantizeAudio(buf, bpm, resolution, strength, sensitivity);
      const wav = encodeToWav(quantized);
      await saveAudioBlob(track.id, wav);
      setTrackPeaks((prev) => { const n = { ...prev }; delete n[track.id!]; return n; });
      setTrackDurations((prev) => { const n = { ...prev }; delete n[track.id!]; return n; });
      await loadData();
    } finally {
      setBusy(false);
    }
  };

  // --- Pitch correction handler (Kits.AI) ---
  const handlePitchCorrect = async (track: Track, pitchShift: number, key: string, scale: string, correctionStrength: number) => {
    if (!track.id) return;
    setBusy(true);
    setAiProcessingTrackId(track.id);
    setAiStatus('Applying pitch correction...');
    try {
      const blob = await getAudioBlob(track.id);
      if (!blob) return;

      // Build query params
      const params = new URLSearchParams();
      // For pitch correction, we use the same voice model conversion but with pitch shift
      // and pitch correction parameters
      if (pitchShift !== 0) params.set('pitchShift', String(pitchShift));
      if (key && key !== 'off') {
        params.set('pitchCorrection', JSON.stringify({ key, scale, strength: correctionStrength }));
      }

      // We need a voice model for conversion - fetch one that matches the track role
      const resp = await fetch(`/api/kits/pitch-correct?${params.toString()}`, {
        method: 'POST',
        body: blob,
      });
      if (!resp.ok) throw new Error(await resp.text());
      const job = await resp.json();
      const jobId = job.id;

      // Poll for completion
      setAiStatus('AI is correcting pitch...');
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const poll = await fetch(`/api/kits/convert/${jobId}`);
        if (!poll.ok) continue;
        const data = await poll.json();
        if (data.status === 'completed' || data.status === 'success') {
          const outputUrl = data.outputFileUrl || data.outputUrl;
          if (!outputUrl) throw new Error('No output URL');
          setAiStatus('Downloading corrected audio...');
          const dl = await fetch(`/api/kits/download?url=${encodeURIComponent(outputUrl)}`);
          if (!dl.ok) throw new Error('Download failed');
          const corrected = await dl.blob();
          await saveAudioBlob(track.id, corrected);
          setTrackPeaks((prev) => { const n = { ...prev }; delete n[track.id!]; return n; });
          setTrackDurations((prev) => { const n = { ...prev }; delete n[track.id!]; return n; });
          await loadData();
          return;
        }
        if (data.status === 'failed' || data.status === 'error') {
          throw new Error(data.error || 'Pitch correction failed');
        }
      }
      throw new Error('Pitch correction timed out');
    } catch (err) {
      console.error('Pitch correction failed:', err);
      setAiStatus(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      await new Promise((r) => setTimeout(r, 3000));
    } finally {
      setAiProcessingTrackId(null);
      setAiStatus('');
      setBusy(false);
    }
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

  // --- Collaboration ---
  const loadCollabData = useCallback(async () => {
    const sid = getShareId(songId);
    if (!sid) return;
    try {
      const [b, c] = await Promise.all([getBranches(sid), fetchCollaborators(sid)]);
      setCollabBranches(b);
      setCollabInvitations(c);
    } catch { /* ignore */ }
  }, [songId]);

  const handlePublish = async () => {
    if (!user) { setCollabStatus('Sign in to collaborate'); return; }
    setCollabStatus('Publishing...');
    try {
      const data = await exportSongData(songId);
      if (!data) { setCollabStatus('Failed to export song'); return; }
      const sid = await publishSong(songId, data);
      setCollabStatus(`Published! Share ID: ${sid}`);
      await loadCollabData();
    } catch (err) {
      setCollabStatus('Publish failed: ' + (err instanceof Error ? err.message : 'Unknown'));
    }
  };

  const handleSyncBranch = async () => {
    const bid = getBranchId(songId);
    if (!bid) return;
    setCollabStatus('Syncing...');
    try {
      const data = await exportSongData(songId);
      if (!data) { setCollabStatus('Failed to export'); return; }
      await syncBranch(bid, data);
      setCollabStatus('Branch synced!');
    } catch (err) {
      setCollabStatus('Sync failed: ' + (err instanceof Error ? err.message : 'Unknown'));
    }
  };

  const handleInvite = async () => {
    const sid = getShareId(songId);
    if (!sid || !inviteEmail.trim()) return;
    setCollabStatus('Sending invite...');
    try {
      await inviteCollaborator(sid, inviteEmail.trim());
      setCollabStatus(`Invited ${inviteEmail.trim()}`);
      setInviteEmail('');
      await loadCollabData();
    } catch (err) {
      setCollabStatus('Invite failed: ' + (err instanceof Error ? err.message : 'Unknown'));
    }
  };

  const handleViewBranch = async (bid: string) => {
    try {
      const detail = await getBranchDetail(bid);
      setViewingBranch(detail);
    } catch { setCollabStatus('Failed to load branch'); }
  };

  const handleImportTrack = async (trackIdx: number) => {
    if (!viewingBranch) return;
    setImportingTrackIdx(trackIdx);
    try {
      const t = viewingBranch.tracks.find((tr) => tr.index === trackIdx);
      if (!t) return;
      const audio = viewingBranch.audioBase64[trackIdx] || '';
      await importTrackToSong(songId, {
        name: t.name, role: t.role, volume: t.volume, eqBass: t.eqBass, eqMids: t.eqMids,
        eqTreble: t.eqTreble, compressorEnabled: t.compressorEnabled,
        aiProcessed: t.aiProcessed, createdAt: Date.now(),
      }, audio);
      setCollabStatus(`Imported "${t.name}"`);
      await loadData();
    } catch (err) {
      setCollabStatus('Import failed: ' + (err instanceof Error ? err.message : 'Unknown'));
    } finally {
      setImportingTrackIdx(null);
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
        <button onClick={() => { setShowCollab(!showCollab); if (!showCollab) loadCollabData(); }}
          style={{
            padding: '6px 12px', background: showCollab ? '#bb86fc33' : '#2a2a2a',
            color: showCollab ? '#bb86fc' : '#ccc',
            borderRadius: 4, fontSize: 12, fontWeight: 500,
          }}>Collaborate</button>
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
        <button onClick={handleRecordButton}
          disabled={busy && !isRecording}
          style={{
            ...transportBtnStyle,
            color: isRecording ? '#f44336' : recordArmedTrackId !== null ? '#f44336' : '#ccc',
            fontSize: 16,
          }}
          title={isRecording ? 'Stop Recording' : recordArmedTrackId !== null ? 'Punch In' : 'Record'}>{'\u23FA'}</button>

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

        <div style={{ width: 1, height: 24, background: '#333', margin: '0 4px' }} />

        <button onClick={() => setEditMode(editMode === 'snap' ? 'freeform' : 'snap')}
          style={{
            ...transportBtnStyle, fontSize: 11, fontWeight: 600, padding: '4px 8px', borderRadius: 4,
            background: editMode === 'snap' ? '#4caf5033' : '#ff980033',
            color: editMode === 'snap' ? '#4caf50' : '#ff9800',
          }} title={editMode === 'snap' ? 'Snap to bar (click to switch to freeform)' : 'Freeform (click to switch to snap)'}>
          {editMode === 'snap' ? '\u{1F9F2} Snap' : '\u270B Free'}
        </button>

        {selection && (
          <div style={{ display: 'flex', gap: 4, marginLeft: 4 }}>
            <button onClick={handleCutRegion} style={{ ...transportBtnStyle, fontSize: 11, padding: '4px 8px', color: '#ff9800' }}
              title="Cut selection">Cut</button>
            <button onClick={handleCopyRegion} style={{ ...transportBtnStyle, fontSize: 11, padding: '4px 8px', color: '#4caf50' }}
              title="Copy selection">Copy</button>
            <button onClick={handleDeleteRegion} style={{ ...transportBtnStyle, fontSize: 11, padding: '4px 8px', color: '#f44336' }}
              title="Delete selection">Delete</button>
            {clipboard && (
              <button onClick={handlePasteRegion} style={{ ...transportBtnStyle, fontSize: 11, padding: '4px 8px', color: '#bb86fc' }}
                title="Paste at selection">Paste</button>
            )}
            <button onClick={() => setSelection(null)} style={{ ...transportBtnStyle, fontSize: 11, padding: '4px 6px', color: '#888' }}
              title="Clear selection">{'\u2715'}</button>
          </div>
        )}

        {!selection && clipboard && (
          <span style={{ fontSize: 10, color: '#bb86fc88', marginLeft: 4 }}>{'\u{1F4CB}'} Clipboard ready</span>
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
            <span style={{ fontSize: 12, color: '#f44336', fontWeight: 600 }}>
              {recordingTrackId !== null && tracks.find(t => t.id === recordingTrackId)
                ? `PUNCH IN: ${tracks.find(t => t.id === recordingTrackId)!.name}`
                : 'REC'}
            </span>
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
            <TimelineRuler duration={maxDuration} bpm={bpm} />
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
              const isArmed = track.id !== undefined && recordArmedTrackId === track.id;
              const hasSoloActive = soloTracks.size > 0;
              const audible = hasSoloActive ? isSolo : !isMuted;

              return (
                <div key={track.id} style={{
                  display: 'flex', borderBottom: '1px solid #1a1a1a',
                  opacity: audible ? 1 : 0.4,
                }}>
                  {/* Track header */}
                  <div style={{
                    width: 200, minWidth: 200, padding: '8px 10px',
                    background: isArmed ? '#2a1111' : '#1a1a1a',
                    borderRight: isArmed ? '2px solid #f44336' : '1px solid #2a2a2a',
                    display: 'flex', flexDirection: 'column', gap: 4,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <RoleBadge role={track.role} />
                      {track.aiProcessed && (
                        <span style={{
                          fontSize: 9, padding: '1px 5px', borderRadius: 4,
                          background: '#bb86fc33', color: '#bb86fc', fontWeight: 700,
                        }}>AI</span>
                      )}
                      {isArmed && (
                        <span style={{
                          fontSize: 9, padding: '1px 5px', borderRadius: 4,
                          background: '#f4433633', color: '#f44336', fontWeight: 700,
                          animation: 'pulse 1s infinite',
                        }}>REC</span>
                      )}
                    </div>
                    <span style={{ fontSize: 12, color: '#ccc', fontWeight: 500 }}>{track.name}</span>
                    <div style={{ display: 'flex', gap: 3, marginTop: 2, flexWrap: 'wrap' }}>
                      <button onClick={() => track.id !== undefined && toggleRecordArm(track.id)}
                        disabled={isRecording}
                        style={{ ...smallBtnStyle, background: isArmed ? '#f44336' : '#2a2a2a', color: isArmed ? '#fff' : '#888' }}
                        title={isArmed ? 'Disarm recording' : 'Arm for punch-in recording'}>R</button>
                      <button onClick={() => track.id !== undefined && toggleMute(track.id)}
                        style={{ ...smallBtnStyle, background: isMuted ? '#f44336' : '#2a2a2a', color: isMuted ? '#fff' : '#888' }}>M</button>
                      <button onClick={() => track.id !== undefined && toggleSolo(track.id)}
                        style={{ ...smallBtnStyle, background: isSolo ? '#ffc107' : '#2a2a2a', color: isSolo ? '#000' : '#888' }}>S</button>
                      <button onClick={() => setShowQuantize(track)} title="Quantize to beat grid"
                        style={{ ...smallBtnStyle, background: '#0a2a2a', color: '#00bcd4' }}>Q</button>
                      <button onClick={() => setShowPitchCorrect(track)} title="Pitch correction / Auto-tune"
                        style={{ ...smallBtnStyle, background: '#1a0a2a', color: '#9c27b0' }}>AT</button>
                      <button onClick={() => track.id !== undefined && handleDeleteTrack(track.id)}
                        style={{ ...smallBtnStyle, color: '#666' }}>{'\u2715'}</button>
                    </div>
                  </div>

                  {/* Track waveform lane */}
                  <div style={{ flex: 1, height: 80, background: '#111', position: 'relative', overflow: 'hidden', cursor: 'text' }}
                    onMouseDown={(e) => track.id !== undefined && handleSelectionStart(track.id, e)}
                    onMouseMove={(e) => track.id !== undefined && handleSelectionMove(track.id, e)}
                    onMouseUp={handleSelectionEnd}
                    onMouseLeave={handleSelectionEnd}
                  >
                    {/* Bar grid lines */}
                    {(() => {
                      const lines: React.ReactNode[] = [];
                      for (let t = barDuration; t < maxDuration; t += barDuration) {
                        lines.push(
                          <div key={`bg${t}`} style={{
                            position: 'absolute', top: 0, bottom: 0, width: 0,
                            borderLeft: '1px solid #1a1a1a',
                            left: `${(t / maxDuration) * 100}%`,
                          }} />
                        );
                      }
                      return lines;
                    })()}
                    {peaks && duration > 0 && (
                      <TrackWaveformCanvas peaks={peaks} duration={duration}
                        maxDuration={maxDuration} color={ROLE_COLORS[track.role]} />
                    )}
                    {recordingTrackId === track.id && liveWaveform && (
                      <LiveWaveformCanvas data={liveWaveform} color="#f44336" />
                    )}
                    {/* Selection overlay */}
                    {selection && track.id !== undefined && selection.trackId === track.id && (
                      <div style={{
                        position: 'absolute', top: 0, bottom: 0, zIndex: 3, pointerEvents: 'none',
                        left: `${(Math.min(selection.startTime, selection.endTime) / maxDuration) * 100}%`,
                        width: `${(Math.abs(selection.endTime - selection.startTime) / maxDuration) * 100}%`,
                        background: 'rgba(187, 134, 252, 0.2)',
                        borderLeft: '2px solid #bb86fc',
                        borderRight: '2px solid #bb86fc',
                      }} />
                    )}
                    {isPlaying && (
                      <div style={{
                        position: 'absolute', top: 0, bottom: 0, width: 1, background: '#4caf50',
                        left: `${(playPos / maxDuration) * 100}%`, zIndex: 4,
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
            isArmed={track.id !== undefined && recordArmedTrackId === track.id}
            isRecording={isRecording}
            onVolumeChange={(v) => handleVolumeChange(track, v)}
            onToggleMute={() => track.id !== undefined && toggleMute(track.id)}
            onToggleSolo={() => track.id !== undefined && toggleSolo(track.id)}
            onToggleArm={() => track.id !== undefined && toggleRecordArm(track.id)}
            onEQ={() => setShowEQ(track)}
            onToggleCompressor={() => handleToggleCompressor(track)}
            onFX={() => setShowEffects(track)}
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

      {/* ===== COLLABORATION PANEL ===== */}
      {showCollab && (
        <div style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 360, maxWidth: '100vw',
          background: '#141414', borderLeft: '2px solid #2a2a2a', zIndex: 100,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          boxShadow: '-4px 0 20px rgba(0,0,0,0.5)',
        }}>
          {/* Panel header */}
          <div style={{
            padding: '12px 16px', borderBottom: '1px solid #2a2a2a',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, color: '#bb86fc' }}>Collaboration</h3>
            <button onClick={() => setShowCollab(false)}
              style={{ background: 'none', color: '#888', fontSize: 18, padding: '2px 6px' }}>{'\u2715'}</button>
          </div>

          {/* Panel body */}
          <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Status message */}
            {collabStatus && (
              <div style={{ fontSize: 12, color: '#bb86fc', padding: '6px 10px', background: '#bb86fc15', borderRadius: 4 }}>
                {collabStatus}
              </div>
            )}

            {/* Publish / Sync section */}
            {branchId ? (
              <div>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>You are a collaborator on this song</div>
                <button onClick={handleSyncBranch}
                  style={{
                    width: '100%', padding: '8px 14px', background: '#4caf5033', color: '#4caf50',
                    borderRadius: 6, fontSize: 13, fontWeight: 600,
                  }}>Sync Changes to Owner</button>
              </div>
            ) : (
              <div>
                <button onClick={handlePublish}
                  style={{
                    width: '100%', padding: '8px 14px',
                    background: shareId ? '#4caf5033' : '#bb86fc33',
                    color: shareId ? '#4caf50' : '#bb86fc',
                    borderRadius: 6, fontSize: 13, fontWeight: 600,
                  }}>{shareId ? 'Re-publish Latest' : 'Publish for Collaboration'}</button>
                {!shareId && (
                  <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
                    Publish your song to the server so collaborators can access it
                  </div>
                )}
              </div>
            )}

            {/* Invite section (owner only) */}
            {shareId && !branchId && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#ccc', marginBottom: 6 }}>Invite Collaborator</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input type="email" placeholder="Email address" value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleInvite()}
                    style={{
                      flex: 1, padding: '6px 10px', background: '#1e1e1e', border: '1px solid #333',
                      borderRadius: 4, color: '#fff', fontSize: 13, outline: 'none',
                    }} />
                  <button onClick={handleInvite} disabled={!inviteEmail.trim()}
                    style={{
                      padding: '6px 12px', background: '#bb86fc', color: '#000',
                      borderRadius: 4, fontSize: 12, fontWeight: 600,
                    }}>Invite</button>
                </div>
              </div>
            )}

            {/* Collaborators list */}
            {collabInvitations.length > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#ccc', marginBottom: 6 }}>Collaborators</div>
                {collabInvitations.map((inv) => (
                  <div key={inv.id} style={{
                    padding: '6px 10px', background: '#1e1e1e', borderRadius: 4, marginBottom: 4,
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  }}>
                    <span style={{ fontSize: 12, color: '#ccc' }}>{inv.toEmail}</span>
                    <span style={{
                      fontSize: 10, padding: '2px 6px', borderRadius: 3,
                      background: inv.status === 'accepted' ? '#4caf5033' : '#ff980033',
                      color: inv.status === 'accepted' ? '#4caf50' : '#ff9800',
                      fontWeight: 600,
                    }}>{inv.status}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Branches section (owner view) */}
            {shareId && !branchId && collabBranches.length > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#ccc', marginBottom: 6 }}>Branches</div>
                {collabBranches.map((branch) => (
                  <div key={branch.id} style={{ marginBottom: 6 }}>
                    <button onClick={() => handleViewBranch(branch.id)}
                      style={{
                        width: '100%', textAlign: 'left', padding: '8px 10px',
                        background: viewingBranch?.id === branch.id ? '#bb86fc22' : '#1e1e1e',
                        border: viewingBranch?.id === branch.id ? '1px solid #bb86fc44' : '1px solid #2a2a2a',
                        borderRadius: 6, cursor: 'pointer',
                      }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#ccc' }}>{branch.userName}</div>
                      <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                        {branch.trackCount} tracks &middot; Updated {new Date(branch.updatedAt).toLocaleDateString()}
                      </div>
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Branch detail / track list */}
            {viewingBranch && (
              <div>
                <div style={{
                  fontSize: 12, fontWeight: 600, color: '#bb86fc', marginBottom: 6,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  <span>{viewingBranch.userName}'s Branch</span>
                  <button onClick={() => setViewingBranch(null)}
                    style={{ background: 'none', color: '#888', fontSize: 12, padding: '2px 4px' }}>{'\u2715'}</button>
                </div>
                {viewingBranch.tracks.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#666', padding: 8 }}>No tracks in this branch</div>
                ) : (
                  viewingBranch.tracks.map((t) => (
                    <div key={t.index} style={{
                      padding: '8px 10px', background: '#1a1a1a', borderRadius: 4, marginBottom: 4,
                      display: 'flex', alignItems: 'center', gap: 8,
                    }}>
                      <RoleBadge role={t.role} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, color: '#ccc', fontWeight: 500 }}>{t.name}</div>
                        <div style={{ fontSize: 10, color: '#666' }}>{t.role}</div>
                      </div>
                      <button onClick={() => handleImportTrack(t.index)}
                        disabled={importingTrackIdx === t.index}
                        style={{
                          padding: '4px 10px', background: '#4caf5033', color: '#4caf50',
                          borderRadius: 4, fontSize: 11, fontWeight: 600,
                          opacity: importingTrackIdx === t.index ? 0.5 : 1,
                        }}>{importingTrackIdx === t.index ? 'Importing...' : 'Import'}</button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}

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

      <Dialog open={showEffects !== null} onClose={() => setShowEffects(null)} title="Audio Effects">
        {showEffects && <EffectsControls track={showEffects} onSave={handleEffectsSave} onClose={() => setShowEffects(null)} />}
      </Dialog>

      <Dialog open={showQuantize !== null} onClose={() => setShowQuantize(null)} title="Quantize Track">
        {showQuantize && <QuantizeControls bpm={bpm} onApply={(res, str, sens) => { handleQuantize(showQuantize, res, str, sens); setShowQuantize(null); }} onClose={() => setShowQuantize(null)} />}
      </Dialog>

      <Dialog open={showPitchCorrect !== null} onClose={() => setShowPitchCorrect(null)} title="Pitch Correction / Auto-Tune">
        {showPitchCorrect && <PitchCorrectControls onApply={(ps, k, sc, st) => { handlePitchCorrect(showPitchCorrect, ps, k, sc, st); setShowPitchCorrect(null); }} onClose={() => setShowPitchCorrect(null)} />}
      </Dialog>

      <style>{`
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
        input[type=range] { accent-color: #bb86fc; }
      `}</style>
    </div>
  );
}

// --- Sub-components ---

function TimelineRuler({ duration, bpm }: { duration: number; bpm: number }) {
  const barDur = (60 / bpm) * 4; // 4/4 time
  const bars: { time: number; num: number }[] = [];
  let barNum = 1;
  for (let t = 0; t <= duration; t += barDur) {
    bars.push({ time: t, num: barNum++ });
  }

  // Determine label frequency to avoid crowding
  const barPct = (barDur / duration) * 100;
  const labelEvery = barPct < 2 ? 8 : barPct < 4 ? 4 : barPct < 7 ? 2 : 1;

  // Time ticks for reference
  const ticks: number[] = [];
  const step = duration <= 30 ? 5 : duration <= 120 ? 10 : 30;
  for (let t = 0; t <= duration; t += step) ticks.push(t);

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      {/* Bar markers */}
      {bars.map((bar, i) => (
        <div key={`b${i}`} style={{
          position: 'absolute', left: `${(bar.time / duration) * 100}%`, top: 0, bottom: 0,
          borderLeft: `1px solid ${i === 0 ? '#555' : '#3a3a3a'}`,
        }}>
          {(i % labelEvery === 0) && (
            <span style={{
              position: 'absolute', top: 1, left: 3, fontSize: 9, fontWeight: 600,
              color: i === 0 ? '#888' : '#666', whiteSpace: 'nowrap',
            }}>{bar.num}</span>
          )}
        </div>
      ))}
      {/* Time ticks */}
      {ticks.map((t) => (
        <div key={`t${t}`} style={{
          position: 'absolute', left: `${(t / duration) * 100}%`, top: 0, bottom: 0,
          borderLeft: '1px solid #222',
        }}>
          <span style={{
            position: 'absolute', bottom: 0, left: 3, fontSize: 8, color: '#555', whiteSpace: 'nowrap',
          }}>{formatTime(t)}</span>
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

function MixerStrip({ track, isMuted, isSolo, isArmed, isRecording: isRec, onVolumeChange, onToggleMute, onToggleSolo, onToggleArm, onEQ, onToggleCompressor, onFX }: {
  track: Track; isMuted: boolean; isSolo: boolean; isArmed: boolean; isRecording: boolean;
  onVolumeChange: (v: number) => void; onToggleMute: () => void;
  onToggleSolo: () => void; onToggleArm: () => void; onEQ: () => void; onToggleCompressor: () => void; onFX: () => void;
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
        <button onClick={onToggleArm} disabled={isRec}
          style={{ ...mixBtnStyle, background: isArmed ? '#f44336' : '#2a2a2a', color: isArmed ? '#fff' : '#888' }}
          title={isArmed ? 'Disarm' : 'Arm for recording'}>R</button>
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
        <button onClick={onFX} style={{
          ...mixBtnStyle,
          background: ((track.reverbMix ?? 0) > 0 || (track.delayMix ?? 0) > 0 || (track.chorusMix ?? 0) > 0) ? '#9c27b0' : '#2a2a2a',
          color: ((track.reverbMix ?? 0) > 0 || (track.delayMix ?? 0) > 0 || (track.chorusMix ?? 0) > 0) ? '#fff' : '#888',
        }}>FX</button>
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

const MUSICAL_KEYS = ['off', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const SCALE_TYPES = ['major', 'minor', 'chromatic'] as const;

function QuantizeControls({ bpm, onApply, onClose }: {
  bpm: number;
  onApply: (resolution: QuantizeResolution, strength: number, sensitivity: number) => void;
  onClose: () => void;
}) {
  const [resolution, setResolution] = useState<QuantizeResolution>(8);
  const [strength, setStrength] = useState(0.8);
  const [sensitivity, setSensitivity] = useState(0.6);

  const gridMs = ((60 / bpm) * (4 / resolution) * 1000).toFixed(0);

  return (
    <div>
      <p style={{ color: '#888', fontSize: 12, marginBottom: 12 }}>
        Aligns transients to the beat grid at {bpm} BPM ({gridMs}ms per grid unit).
      </p>
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
          <span style={{ color: '#00bcd4' }}>Grid Resolution</span>
          <span style={{ color: '#888' }}>1/{resolution} note</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {([4, 8, 16, 32] as QuantizeResolution[]).map((r) => (
            <button key={r} onClick={() => setResolution(r)} style={{
              flex: 1, padding: '6px 0', borderRadius: 4, fontWeight: 600, fontSize: 13,
              background: resolution === r ? '#00bcd4' : '#2a2a2a',
              color: resolution === r ? '#000' : '#888',
            }}>1/{r}</button>
          ))}
        </div>
      </div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
          <span style={{ color: '#00bcd4' }}>Strength</span>
          <span style={{ color: '#888' }}>{Math.round(strength * 100)}%</span>
        </div>
        <input type="range" min={0} max={100} value={Math.round(strength * 100)}
          onChange={(e) => setStrength(Number(e.target.value) / 100)}
          style={{ width: '100%', accentColor: '#00bcd4' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#555' }}>
          <span>Loose</span><span>Tight</span>
        </div>
      </div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
          <span style={{ color: '#00bcd4' }}>Sensitivity</span>
          <span style={{ color: '#888' }}>{Math.round(sensitivity * 100)}%</span>
        </div>
        <input type="range" min={0} max={100} value={Math.round(sensitivity * 100)}
          onChange={(e) => setSensitivity(Number(e.target.value) / 100)}
          style={{ width: '100%', accentColor: '#00bcd4' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#555' }}>
          <span>Few onsets</span><span>Many onsets</span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose}
          style={{ padding: '8px 16px', background: 'none', color: '#888', borderRadius: 4 }}>Cancel</button>
        <button onClick={() => onApply(resolution, strength, sensitivity)}
          style={{ padding: '8px 20px', background: '#00bcd4', color: '#000', borderRadius: 4, fontWeight: 600 }}>Quantize</button>
      </div>
    </div>
  );
}

function PitchCorrectControls({ onApply, onClose }: {
  onApply: (pitchShift: number, key: string, scale: string, strength: number) => void;
  onClose: () => void;
}) {
  const [pitchShift, setPitchShift] = useState(0);
  const [key, setKey] = useState('off');
  const [scale, setScale] = useState<typeof SCALE_TYPES[number]>('major');
  const [corrStrength, setCorrStrength] = useState(0.8);

  return (
    <div>
      <p style={{ color: '#888', fontSize: 12, marginBottom: 12 }}>
        Uses Kits.AI to apply pitch correction. Select a key and scale for auto-tune, or shift pitch by semitones.
      </p>
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
          <span style={{ color: '#9c27b0' }}>Pitch Shift</span>
          <span style={{ color: '#888' }}>{pitchShift > 0 ? '+' : ''}{pitchShift} semitones</span>
        </div>
        <input type="range" min={-12} max={12} value={pitchShift}
          onChange={(e) => setPitchShift(Number(e.target.value))}
          style={{ width: '100%', accentColor: '#9c27b0' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#555' }}>
          <span>-12</span><span>0</span><span>+12</span>
        </div>
      </div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: '#9c27b0', marginBottom: 6 }}>Key (Auto-Tune)</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {MUSICAL_KEYS.map((k) => (
            <button key={k} onClick={() => setKey(k)} style={{
              padding: '4px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600,
              background: key === k ? '#9c27b0' : '#2a2a2a',
              color: key === k ? '#fff' : '#888',
              minWidth: 32,
            }}>{k === 'off' ? 'Off' : k}</button>
          ))}
        </div>
      </div>
      {key !== 'off' && (
        <>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, color: '#9c27b0', marginBottom: 6 }}>Scale</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {SCALE_TYPES.map((s) => (
                <button key={s} onClick={() => setScale(s)} style={{
                  flex: 1, padding: '6px 0', borderRadius: 4, fontSize: 13, fontWeight: 600,
                  background: scale === s ? '#9c27b0' : '#2a2a2a',
                  color: scale === s ? '#fff' : '#888',
                  textTransform: 'capitalize',
                }}>{s}</button>
              ))}
            </div>
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
              <span style={{ color: '#9c27b0' }}>Correction Strength</span>
              <span style={{ color: '#888' }}>{Math.round(corrStrength * 100)}%</span>
            </div>
            <input type="range" min={0} max={100} value={Math.round(corrStrength * 100)}
              onChange={(e) => setCorrStrength(Number(e.target.value) / 100)}
              style={{ width: '100%', accentColor: '#9c27b0' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#555' }}>
              <span>Subtle</span><span>Full auto-tune</span>
            </div>
          </div>
        </>
      )}
      <div style={{ background: '#1a1a2e', borderRadius: 6, padding: 10, marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: '#888' }}>
          {key === 'off' && pitchShift === 0 && 'Select a key for auto-tune or adjust pitch shift.'}
          {key === 'off' && pitchShift !== 0 && `Will shift pitch by ${pitchShift > 0 ? '+' : ''}${pitchShift} semitones.`}
          {key !== 'off' && `Will auto-tune to ${key} ${scale}${pitchShift !== 0 ? ` and shift ${pitchShift > 0 ? '+' : ''}${pitchShift} semitones` : ''}.`}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose}
          style={{ padding: '8px 16px', background: 'none', color: '#888', borderRadius: 4 }}>Cancel</button>
        <button onClick={() => onApply(pitchShift, key, scale, corrStrength)}
          disabled={key === 'off' && pitchShift === 0}
          style={{
            padding: '8px 20px', borderRadius: 4, fontWeight: 600,
            background: (key === 'off' && pitchShift === 0) ? '#333' : '#9c27b0',
            color: (key === 'off' && pitchShift === 0) ? '#555' : '#fff',
          }}>Apply</button>
      </div>
    </div>
  );
}

function EffectsControls({ track, onSave, onClose }: {
  track: Track;
  onSave: (track: Track, reverb: number, delay: number, delayTime: number, chorus: number) => void;
  onClose: () => void;
}) {
  const [reverb, setReverb] = useState(track.reverbMix ?? 0);
  const [delay, setDelay] = useState(track.delayMix ?? 0);
  const [delayTime, setDelayTime] = useState(track.delayTime ?? 0.3);
  const [chorus, setChorus] = useState(track.chorusMix ?? 0);

  const pct = (v: number) => `${Math.round(v * 100)}%`;

  return (
    <div>
      {[
        { label: 'Reverb', value: reverb, set: setReverb, color: '#9c27b0' },
        { label: 'Delay', value: delay, set: setDelay, color: '#ff5722' },
        { label: 'Chorus', value: chorus, set: setChorus, color: '#00bcd4' },
      ].map(({ label, value, set, color }) => (
        <div key={label} style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
            <span style={{ color }}>{label}</span>
            <span style={{ color: '#888' }}>{pct(value)}</span>
          </div>
          <input type="range" min={0} max={100} value={Math.round(value * 100)}
            onChange={(e) => set(Number(e.target.value) / 100)}
            style={{ width: '100%', accentColor: color }} />
        </div>
      ))}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
          <span style={{ color: '#ff5722' }}>Delay Time</span>
          <span style={{ color: '#888' }}>{(delayTime * 1000).toFixed(0)} ms</span>
        </div>
        <input type="range" min={50} max={1000} value={Math.round(delayTime * 1000)}
          onChange={(e) => setDelayTime(Number(e.target.value) / 1000)}
          style={{ width: '100%', accentColor: '#ff5722' }} />
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose}
          style={{ padding: '8px 16px', background: 'none', color: '#888', borderRadius: 4 }}>Cancel</button>
        <button onClick={() => { onSave(track, reverb, delay, delayTime, chorus); onClose(); }}
          style={{ padding: '8px 20px', background: '#9c27b0', color: '#fff', borderRadius: 4, fontWeight: 600 }}>Apply</button>
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
  padding: '2px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700,
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
