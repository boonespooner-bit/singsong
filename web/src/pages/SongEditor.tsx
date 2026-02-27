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
import { transformAudio, reTransformAudio, fetchAllModels } from '../audio/kitsai';
import type { VoiceModel, TransformOptions } from '../audio/kitsai';
import { Metronome, METRONOME_NOTES, type MetronomeNote } from '../audio/metronome';
import { mixdownToWav } from '../audio/mixdown';
import { generateAiTrack, mixTracksToBase64 } from '../audio/aiGenerate';
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
  const [recordingTime, setRecordingTime] = useState(0);
  const recStartRef = useRef(0);
  const recAnimRef = useRef(0);

  // Zoom
  const [zoom, setZoom] = useState(1);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const lanesScrollRef = useRef<HTMLDivElement>(null);

  // Playback
  const [isPlaying, setIsPlaying] = useState(false);
  const [playPos, setPlayPos] = useState(0);
  const playAnimRef = useRef(0);

  // AI processing
  const [aiProcessingTrackId, setAiProcessingTrackId] = useState<number | null>(null);
  const [aiStatus, setAiStatus] = useState('');
  const aiAbortRef = useRef<AbortController | null>(null);
  const aiRawBlobRef = useRef<Blob | null>(null);

  // Mixer: local mute/solo state
  const [mutedTracks, setMutedTracks] = useState<Set<number>>(new Set());
  const [soloTracks, setSoloTracks] = useState<Set<number>>(new Set());

  // Metronome
  const [metronomeEnabled, setMetronomeEnabled] = useState(false);
  const [bpm, setBpm] = useState(120);
  const [currentBeat, setCurrentBeat] = useState(-1);
  const [countInEnabled, setCountInEnabled] = useState(true);
  const [metronomeNote, setMetronomeNote] = useState<MetronomeNote | null>(null);

  // Dialogs
  const [showNewTrack, setShowNewTrack] = useState(false);
  const [newTrackName, setNewTrackName] = useState('');
  const [newTrackRole, setNewTrackRole] = useState<TrackRole>('vocals');
  const [trackCreationMode, setTrackCreationMode] = useState<'record' | 'ai'>('record');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiGenStatus, setAiGenStatus] = useState('');
  const aiGenAbortRef = useRef<AbortController | null>(null);
  const [showEQ, setShowEQ] = useState<Track | null>(null);

  // Delete confirmation
  const [deleteConfirmTrackId, setDeleteConfirmTrackId] = useState<number | null>(null);

  // Undo stack: stores audio snapshots before destructive edits
  const undoStackRef = useRef<{ trackId: number; blob: Blob }[]>([]);
  const MAX_UNDO = 30;

  // Waveform selection & editing
  const [selection, setSelection] = useState<{ trackId: number; startTime: number; endTime: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [clipboard, setClipboard] = useState<AudioBuffer | null>(null);
  const [focusedTrackId, setFocusedTrackId] = useState<number | null>(null);
  // Clip boundary markers per track: array of {start, end} times for pasted/placed clips
  const [clipRegions, setClipRegions] = useState<Record<number, { start: number; end: number }[]>>({});
  const [editMode, setEditMode] = useState<'snap' | 'freeform'>('snap');
  // Grid resolution: beats per bar division. 1 = whole notes (bars), 4 = quarter notes, 8 = eighth, 16 = sixteenth
  const [gridResolution, setGridResolution] = useState<1 | 4 | 8 | 16>(4);
  const [loopEnabled, setLoopEnabled] = useState(false);

  // Playlists / takes: trackId → array of Blob takes. Index 0 is always the current/active take.
  const [playlists, setPlaylists] = useState<Record<number, Blob[]>>({});
  const [activePlaylistIndex, setActivePlaylistIndex] = useState<Record<number, number>>({});
  const [showPlaylists, setShowPlaylists] = useState<number | null>(null); // trackId or null

  // Pre-roll / Post-roll (in bars)
  const [preRollBars, setPreRollBars] = useState(1);
  const [preRollEnabled, setPreRollEnabled] = useState(false);

  // Track groups: each group is { name, trackIds, color }
  const [trackGroups, setTrackGroups] = useState<{ name: string; trackIds: Set<number>; color: string }[]>([]);
  const [showGroupDialog, setShowGroupDialog] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupTrackIds, setNewGroupTrackIds] = useState<Set<number>>(new Set());

  // Effects dialog
  const [showEffects, setShowEffects] = useState<Track | null>(null);

  // Keyboard shortcuts help
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Quantize dialog
  const [showQuantize, setShowQuantize] = useState<Track | null>(null);

  // Pitch correction / auto-tune dialog
  const [showPitchCorrect, setShowPitchCorrect] = useState<Track | null>(null);

  // AI Transform dialog (re-process via Kits.AI)
  const [showAiTransform, setShowAiTransform] = useState<Track | null>(null);

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

  // AI mode: auto-set metronome note to song key and enable metronome
  useEffect(() => {
    if (song?.aiMode && song.aiKey) {
      const key = song.aiKey as MetronomeNote;
      if (METRONOME_NOTES.includes(key)) {
        setMetronomeNote(key);
      }
      setMetronomeEnabled(true);
    }
  }, [song?.aiMode, song?.aiKey]);

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

  // --- Keyboard shortcuts ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip if user is typing in an input or textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      switch (e.key) {
        case 'z': // Ctrl+Z / Cmd+Z = undo
        case 'Z':
          if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
            e.preventDefault();
            handleUndo();
          }
          break;
        case ' ': // Space = play/pause
          e.preventDefault();
          if (tracks.length > 0) handlePlay();
          break;
        case 'Enter': // Enter = stop (return to 0)
          e.preventDefault();
          handleStop();
          break;
        case 'r': // R = record
        case 'R':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            handleRecordButton();
          }
          break;
        case 'x': // Ctrl+X = cut
        case 'X':
          if ((e.ctrlKey || e.metaKey) && selection) {
            e.preventDefault();
            handleCutRegion();
          }
          break;
        case 'c': // Ctrl+C = copy
        case 'C':
          if ((e.ctrlKey || e.metaKey) && selection) {
            e.preventDefault();
            handleCopyRegion();
          }
          break;
        case 'v': // Ctrl+V = paste
        case 'V':
          if ((e.ctrlKey || e.metaKey) && clipboard) {
            e.preventDefault();
            handlePasteRegion();
          }
          break;
        case 'Delete': // Delete = delete selection
        case 'Backspace':
          if (selection && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            handleDeleteRegion();
          }
          break;
        case 'l': // L = toggle loop
        case 'L':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            setLoopEnabled(prev => !prev);
          }
          break;
        case 'm': // M = toggle metronome
        case 'M':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            setMetronomeEnabled(prev => !prev);
          }
          break;
        case 'g': // G = snap/freeform toggle
        case 'G':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            setEditMode(prev => prev === 'snap' ? 'freeform' : 'snap');
          }
          break;
        case 'Escape': // Esc = clear selection
          if (selection) {
            e.preventDefault();
            setSelection(null);
          }
          break;
        case '+': // Zoom in
        case '=':
          e.preventDefault();
          setZoom(prev => Math.min(5, prev + 0.25));
          break;
        case '-': // Zoom out
        case '_':
          e.preventDefault();
          setZoom(prev => Math.max(1, prev - 0.25));
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

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
  const toggleRecordArm = async (trackId: number) => {
    if (isRecording) {
      // If already recording on this track, stop recording
      if (recordingTrackId === trackId) {
        handleStopRecording();
      }
      return;
    }
    // Save the current audio as a take before overwriting
    const currentBlob = await getAudioBlob(trackId);
    if (currentBlob && currentBlob.size > 0) {
      saveTakeToPlaylist(trackId, currentBlob);
      setActivePlaylistIndex(prev => ({
        ...prev,
        [trackId]: (playlists[trackId]?.length ?? 0),
      }));
    }
    // Start recording directly on this track
    setRecordArmedTrackId(trackId);
    handleRecordOnTrack(trackId);
  };

  const handleRecordOnTrack = async (trackId: number) => {
    // Pre-roll: play back other tracks for N bars before recording starts
    const preRollDuration = preRollEnabled ? barDuration * preRollBars : 0;
    const otherTracks = tracks.filter((t) => t.id !== trackId);

    if (preRollDuration > 0 && otherTracks.length > 0) {
      setIsPlaying(true);
      await playerRef.current.play(otherTracks, getAudioBlob);
      applyMixVolumes(mutedTracks, soloTracks);
      const animate = () => {
        if (!playerRef.current.playing) { setPlayPos(0); return; }
        setPlayPos(playerRef.current.currentTime);
        playAnimRef.current = requestAnimationFrame(animate);
      };
      animate();
      if (metronomeEnabled) {
        const met = metronomeRef.current;
        met.bpm = bpm; met.note = metronomeNote; met.onTick = setCurrentBeat; met.start();
      }
      // Wait for pre-roll duration
      await new Promise(r => setTimeout(r, preRollDuration * 1000));
    }

    // Count-in if metronome is on (and no pre-roll, or after pre-roll)
    if (metronomeEnabled && countInEnabled && preRollDuration === 0) {
      const met = metronomeRef.current;
      met.bpm = bpm;
      met.note = metronomeNote;
      met.onTick = setCurrentBeat;
      await met.countIn();
      setCurrentBeat(-1);
    }

    setRecordingTrackId(trackId);
    setIsRecording(true);
    setRecordingTime(0);
    recStartRef.current = performance.now();
    const animateRec = () => {
      setRecordingTime((performance.now() - recStartRef.current) / 1000);
      recAnimRef.current = requestAnimationFrame(animateRec);
    };
    recAnimRef.current = requestAnimationFrame(animateRec);

    // Play back all other tracks while recording (if not already playing from pre-roll)
    if (preRollDuration === 0 && otherTracks.length > 0) {
      setIsPlaying(true);
      await playerRef.current.play(otherTracks, getAudioBlob);
      applyMixVolumes(mutedTracks, soloTracks);
      const animate = () => {
        if (!playerRef.current.playing) {
          setPlayPos(0);
          return;
        }
        setPlayPos(playerRef.current.currentTime);
        playAnimRef.current = requestAnimationFrame(animate);
      };
      animate();
    }

    await recorderRef.current.start(setAudioLevel, setLiveWaveform);
    if (metronomeEnabled && preRollDuration === 0) {
      const met = metronomeRef.current;
      met.bpm = bpm;
      met.note = metronomeNote;
      met.onTick = setCurrentBeat;
      met.start();
    }
  };

  const handleRecordButton = () => {
    if (isRecording) {
      handleStopRecording();
    } else if (recordArmedTrackId !== null) {
      handleRecordOnTrack(recordArmedTrackId);
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
      met.note = metronomeNote;
      met.onTick = setCurrentBeat;
      await met.countIn();
      setCurrentBeat(-1);
    }

    setRecordingTrackId(trackId);
    setIsRecording(true);
    setRecordingTime(0);
    recStartRef.current = performance.now();
    const animateRec = () => {
      setRecordingTime((performance.now() - recStartRef.current) / 1000);
      recAnimRef.current = requestAnimationFrame(animateRec);
    };
    recAnimRef.current = requestAnimationFrame(animateRec);

    // Play back all existing tracks while recording the new one
    const existingTracks = tracks;
    if (existingTracks.length > 0) {
      setIsPlaying(true);
      await playerRef.current.play(existingTracks, getAudioBlob);
      applyMixVolumes(mutedTracks, soloTracks);
      const animate = () => {
        if (!playerRef.current.playing) {
          setPlayPos(0);
          return;
        }
        setPlayPos(playerRef.current.currentTime);
        playAnimRef.current = requestAnimationFrame(animate);
      };
      animate();
    }

    await recorderRef.current.start(setAudioLevel, setLiveWaveform);
    if (metronomeEnabled) {
      const met = metronomeRef.current;
      met.bpm = bpm;
      met.note = metronomeNote;
      met.onTick = setCurrentBeat;
      met.start();
    }
  };

  const handleAiTrack = async () => {
    const name = newTrackName.trim();
    if (!name) return;

    const instrument = newTrackRole;
    setShowNewTrack(false);
    setAiGenerating(true);
    setAiGenStatus('Preparing...');

    const abortController = new AbortController();
    aiGenAbortRef.current = abortController;

    try {
      // Create the track entry in the database first
      const trackId = await createTrack({
        songId, name, role: instrument, volume: 0.8,
        eqBass: 0.5, eqMids: 0.5, eqTreble: 0.5,
        compressorEnabled: false, aiProcessed: false, createdAt: Date.now(),
        aiGenerated: true,
      });
      setNewTrackName('');
      setNewTrackRole('vocals');
      setTrackCreationMode('record');
      await loadData();

      // Gather existing track audio for AI analysis
      let existingTracksAudio: string | undefined;
      let targetDuration = 30;

      if (tracks.length > 0) {
        setAiGenStatus('Mixing existing tracks for AI analysis...');
        const trackBlobs: Blob[] = [];
        for (const t of tracks) {
          if (t.id === undefined) continue;
          const blob = await getAudioBlob(t.id);
          if (blob) trackBlobs.push(blob);
        }
        if (trackBlobs.length > 0) {
          const { base64, duration } = await mixTracksToBase64(
            trackBlobs,
            (msg) => setAiGenStatus(msg)
          );
          existingTracksAudio = base64;
          targetDuration = Math.ceil(duration);
        }
      }

      setAiGenStatus('AI is creating your track...');

      const generatedBlob = await generateAiTrack(
        {
          instrument,
          bpm,
          key: song?.aiKey,
          scale: song?.aiScale,
          durationSeconds: targetDuration,
          existingTracksAudio,
        },
        (msg) => setAiGenStatus(msg),
        abortController.signal
      );

      // Save the generated audio
      setAiGenStatus('Saving generated track...');
      await saveAudioBlob(trackId, generatedBlob);
      await loadData();
      setAiGenStatus('');
      setAiGenerating(false);
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setAiGenStatus('Cancelled');
      } else {
        setAiGenStatus(`Error: ${(err as Error).message}`);
      }
      setTimeout(() => {
        setAiGenerating(false);
        setAiGenStatus('');
      }, 3000);
    } finally {
      aiGenAbortRef.current = null;
    }
  };

  const handleStopRecording = async () => {
    const blob = await recorderRef.current.stop();
    metronomeRef.current.stop();
    setCurrentBeat(-1);
    setIsRecording(false);
    setAudioLevel(0);
    setLiveWaveform(null);
    cancelAnimationFrame(recAnimRef.current);
    setRecordingTime(0);

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
      // Save raw audio first so track is usable even if AI is cancelled
      await saveAudioBlob(trackId, blob);
      setAiProcessingTrackId(trackId);
      aiRawBlobRef.current = blob;
      const controller = new AbortController();
      aiAbortRef.current = controller;
      try {
        const converted = await transformAudio(blob, track.role, setAiStatus, controller.signal);
        await saveAudioBlob(trackId, converted);
        await updateTrack({ ...track, aiProcessed: true });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // User cancelled — raw audio already saved above
          console.log('AI transform cancelled by user');
        } else {
          console.error('AI transform failed, keeping raw audio:', err);
        }
      } finally {
        aiAbortRef.current = null;
        aiRawBlobRef.current = null;
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

    // AI Mode: auto-quantize and auto-pitch-correct every recording
    if (song?.aiMode && song.aiKey) {
      setAiProcessingTrackId(trackId);
      try {
        // Step 1: Quantize to the beat grid
        setAiStatus('Auto-quantizing...');
        const qBlob = await getAudioBlob(trackId);
        if (qBlob) {
          const qBuf = await decodeBlob(qBlob);
          if (qBuf) {
            const quantized = quantizeAudio(qBuf, bpm, 8, 0.85, 0.6);
            const qWav = encodeToWav(quantized);
            await saveAudioBlob(trackId, qWav);
          }
        }
        // Step 2: Pitch-correct to the song key
        setAiStatus(`Auto-tuning to ${song.aiKey} ${song.aiScale ?? 'major'}...`);
        const pcBlob = await getAudioBlob(trackId);
        if (pcBlob) {
          const pcParams = new URLSearchParams();
          pcParams.set('pitchCorrection', JSON.stringify({
            key: song.aiKey, scale: song.aiScale ?? 'major', strength: 0.85,
          }));
          const controller = new AbortController();
          aiAbortRef.current = controller;
          const resp = await fetch(`/api/kits/pitch-correct?${pcParams.toString()}`, {
            method: 'POST', body: pcBlob, signal: controller.signal,
          });
          if (resp.ok) {
            const job = await resp.json();
            for (let i = 0; i < 60; i++) {
              await new Promise((r) => {
                const timer = setTimeout(r, 3000);
                controller.signal.addEventListener('abort', () => { clearTimeout(timer); r(undefined); }, { once: true });
              });
              if (controller.signal.aborted) break;
              const poll = await fetch(`/api/kits/convert/${job.id}`, { signal: controller.signal });
              if (!poll.ok) continue;
              const data = await poll.json();
              if (data.status === 'completed' || data.status === 'success') {
                const outputUrl = data.outputFileUrl || data.outputUrl;
                if (outputUrl) {
                  const dl = await fetch(`/api/kits/download?url=${encodeURIComponent(outputUrl)}`, { signal: controller.signal });
                  if (dl.ok) {
                    const corrected = await dl.blob();
                    await saveAudioBlob(trackId, corrected);
                  }
                }
                break;
              }
              if (data.status === 'failed' || data.status === 'error') break;
            }
          }
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          console.error('AI mode auto-processing failed:', err);
        }
      } finally {
        aiAbortRef.current = null;
        setAiProcessingTrackId(null);
        setAiStatus('');
      }
    }

    // Save this take to playlists for comping
    const savedBlob = await getAudioBlob(trackId);
    if (savedBlob && savedBlob.size > 0) {
      saveTakeToPlaylist(trackId, savedBlob);
      setActivePlaylistIndex(prev => ({
        ...prev,
        [trackId]: (playlists[trackId]?.length ?? 0), // new take is appended
      }));
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

    const useLoop = loopEnabled && selection && Math.abs(selection.endTime - selection.startTime) > 0.01;
    const loopStart = useLoop ? Math.min(selection!.startTime, selection!.endTime) : 0;
    const loopEnd = useLoop ? Math.max(selection!.startTime, selection!.endTime) : 0;

    const startOffset = useLoop ? loopStart : playPos;

    setIsPlaying(true);
    if (useLoop) {
      await playerRef.current.playLooped(tracks, getAudioBlob, loopStart, loopEnd);
    } else {
      await playerRef.current.play(tracks, getAudioBlob, startOffset);
    }

    // Apply mute/solo state to the freshly created audio nodes
    applyMixVolumes(mutedTracks, soloTracks);

    if (metronomeEnabled) {
      const met = metronomeRef.current;
      met.bpm = bpm;
      met.note = metronomeNote;
      met.onTick = setCurrentBeat;
      met.start();
    }

    const loopDuration = loopEnd - loopStart;
    const animate = () => {
      if (!playerRef.current.playing) {
        setIsPlaying(false);
        setPlayPos(0);
        metronomeRef.current.stop();
        setCurrentBeat(-1);
        return;
      }
      const elapsed = playerRef.current.currentTime;
      if (useLoop) {
        setPlayPos(loopStart + (elapsed % loopDuration));
      } else {
        setPlayPos(startOffset + elapsed);
      }
      playAnimRef.current = requestAnimationFrame(animate);
    };
    animate();
  };

  const handleStop = () => {
    if (isRecording) {
      handleStopRecording();
      return;
    }
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

  const handlePanChange = async (track: Track, pan: number) => {
    const updated = { ...track, pan };
    await updateTrack(updated);
    playerRef.current.updateTrackPan(track.id!, pan);
    setTracks((prev) => prev.map((t) => (t.id === track.id ? updated : t)));
  };

  // --- Track group volume/mute/solo linked ---
  const getGroupForTrack = (trackId: number) => trackGroups.find(g => g.trackIds.has(trackId));

  const handleGroupedVolumeChange = async (track: Track, volume: number) => {
    const group = track.id !== undefined ? getGroupForTrack(track.id) : undefined;
    if (group) {
      for (const tid of group.trackIds) {
        const t = tracks.find(tr => tr.id === tid);
        if (t) await handleVolumeChange(t, volume);
      }
    } else {
      await handleVolumeChange(track, volume);
    }
  };

  const toggleGroupedMute = (id: number) => {
    const group = getGroupForTrack(id);
    if (group) {
      setMutedTracks((prev) => {
        const anyMuted = [...group.trackIds].some(tid => prev.has(tid));
        const next = new Set(prev);
        for (const tid of group.trackIds) {
          if (anyMuted) next.delete(tid); else next.add(tid);
        }
        setSoloTracks(currentSolo => { applyMixVolumes(next, currentSolo); return currentSolo; });
        return next;
      });
    } else {
      toggleMute(id);
    }
  };

  const toggleGroupedSolo = (id: number) => {
    const group = getGroupForTrack(id);
    if (group) {
      setSoloTracks((prev) => {
        const anySolo = [...group.trackIds].some(tid => prev.has(tid));
        const next = new Set(prev);
        for (const tid of group.trackIds) {
          if (anySolo) next.delete(tid); else next.add(tid);
        }
        setMutedTracks(currentMuted => { applyMixVolumes(currentMuted, next); return currentMuted; });
        return next;
      });
    } else {
      toggleSolo(id);
    }
  };

  // --- Playlist management ---
  const saveTakeToPlaylist = (trackId: number, blob: Blob) => {
    setPlaylists(prev => {
      const takes = prev[trackId] ? [...prev[trackId]] : [];
      takes.push(blob);
      return { ...prev, [trackId]: takes };
    });
  };

  const switchPlaylist = async (trackId: number, takeIndex: number) => {
    const takes = playlists[trackId];
    if (!takes || !takes[takeIndex]) return;
    // Save current audio as a take first if not already saved
    const currentBlob = await getAudioBlob(trackId);
    if (currentBlob && currentBlob.size > 0) {
      const currentIdx = activePlaylistIndex[trackId] ?? -1;
      setPlaylists(prev => {
        const t = prev[trackId] ? [...prev[trackId]] : [];
        if (currentIdx >= 0 && currentIdx < t.length) {
          t[currentIdx] = currentBlob;
        }
        return { ...prev, [trackId]: t };
      });
    }
    // Load the selected take
    await saveAudioBlob(trackId, takes[takeIndex]);
    setActivePlaylistIndex(prev => ({ ...prev, [trackId]: takeIndex }));
    // Refresh waveform
    setTrackPeaks((prev) => { const n = { ...prev }; delete n[trackId]; return n; });
    setTrackDurations((prev) => { const n = { ...prev }; delete n[trackId]; return n; });
    await loadData();
  };

  const addTrackGroup = () => {
    if (!newGroupName.trim() || newGroupTrackIds.size === 0) return;
    const colors = ['#e91e63', '#00bcd4', '#ff9800', '#4caf50', '#bb86fc', '#ff5722'];
    setTrackGroups(prev => [...prev, {
      name: newGroupName.trim(),
      trackIds: new Set(newGroupTrackIds),
      color: colors[prev.length % colors.length],
    }]);
    setNewGroupName('');
    setNewGroupTrackIds(new Set());
    setShowGroupDialog(false);
  };

  const removeTrackGroup = (index: number) => {
    setTrackGroups(prev => prev.filter((_, i) => i !== index));
  };

  // Clean up stale solo/mute entries when tracks change (e.g. after recording a new track)
  useEffect(() => {
    const validIds = new Set(tracks.map(t => t.id).filter((id): id is number => id !== undefined));
    setMutedTracks(prev => {
      const cleaned = new Set([...prev].filter(id => validIds.has(id)));
      return cleaned.size !== prev.size ? cleaned : prev;
    });
    setSoloTracks(prev => {
      const cleaned = new Set([...prev].filter(id => validIds.has(id)));
      return cleaned.size !== prev.size ? cleaned : prev;
    });
  }, [tracks]);

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
      // Read soloTracks from latest state to avoid stale closures
      setSoloTracks(currentSolo => { applyMixVolumes(next, currentSolo); return currentSolo; });
      return next;
    });
  };

  const toggleSolo = (id: number) => {
    setSoloTracks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      // Read mutedTracks from latest state to avoid stale closures
      setMutedTracks(currentMuted => { applyMixVolumes(currentMuted, next); return currentMuted; });
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

  const handleRenameTrack = async (track: Track, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === track.name) return;
    const updated = { ...track, name: trimmed };
    await updateTrack(updated);
    setTracks((prev) => prev.map((t) => (t.id === track.id ? updated : t)));
  };

  // --- Snap helper ---
  const barDuration = (60 / bpm) * 4; // 4/4 time
  const snapTime = useCallback((time: number) => {
    if (editMode === 'freeform') return Math.max(0, time);
    // Snap to the selected grid resolution
    const beatDuration = 60 / bpm; // quarter note duration
    const gridStep = (beatDuration * 4) / gridResolution; // duration of one grid division
    return Math.max(0, Math.round(time / gridStep) * gridStep);
  }, [editMode, bpm, gridResolution]);

  // --- Selection handlers ---
  const handleSelectionStart = (trackId: number, e: React.MouseEvent<HTMLDivElement>) => {
    if (isRecording) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = snapTime((x / rect.width) * maxDuration);
    setSelection({ trackId, startTime: time, endTime: time });
    setFocusedTrackId(trackId);
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
    // Clear selection if start === end (just a click) — treat as cursor positioning
    if (selection && Math.abs(selection.endTime - selection.startTime) < 0.01) {
      if (!isPlaying) {
        setPlayPos(selection.startTime);
      }
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

  // --- Undo ---
  const pushUndo = async (trackId: number) => {
    const blob = await getAudioBlob(trackId);
    if (!blob || blob.size === 0) return;
    undoStackRef.current.push({ trackId, blob });
    if (undoStackRef.current.length > MAX_UNDO) {
      undoStackRef.current.shift();
    }
  };

  const handleUndo = async () => {
    const entry = undoStackRef.current.pop();
    if (!entry) return;
    await saveAudioBlob(entry.trackId, entry.blob);
    setTrackPeaks((prev) => { const n = { ...prev }; delete n[entry.trackId]; return n; });
    setTrackDurations((prev) => { const n = { ...prev }; delete n[entry.trackId]; return n; });
    setClipRegions((prev) => { const n = { ...prev }; delete n[entry.trackId]; return n; });
    setSelection(null);
    await loadData();
  };

  const handleDeleteRegion = async () => {
    const range = getSelectionRange();
    if (!range) return;
    await pushUndo(range.trackId);
    const blob = await getAudioBlob(range.trackId);
    if (!blob) return;
    const buf = await decodeBlob(blob);
    if (!buf) return;
    const edited = deleteRegion(buf, range.start, range.end);
    const wav = encodeToWav(edited);
    await saveAudioBlob(range.trackId, wav);
    // Clear cached peaks and clip regions (times shifted by delete)
    setTrackPeaks((prev) => { const n = { ...prev }; delete n[range.trackId]; return n; });
    setTrackDurations((prev) => { const n = { ...prev }; delete n[range.trackId]; return n; });
    setClipRegions((prev) => { const n = { ...prev }; delete n[range.trackId]; return n; });
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
    // Paste at cursor position on the focused track, or replace selection if active
    const targetTrackId = range?.trackId ?? focusedTrackId;
    if (!targetTrackId) return;
    await pushUndo(targetTrackId);
    const pasteAt = range?.start ?? playPos;
    const clipDuration = clipboard.duration;
    const blob = await getAudioBlob(targetTrackId);
    let buf: AudioBuffer | null;
    if (blob) {
      buf = await decodeBlob(blob);
      if (!buf) return;
    } else {
      // Target track has no audio yet — create a silent buffer up to the paste point
      const sr = clipboard.sampleRate;
      const silentLen = Math.max(1, Math.floor(pasteAt * sr));
      buf = new AudioBuffer({ numberOfChannels: clipboard.numberOfChannels, length: silentLen, sampleRate: sr });
    }
    // If there's an active selection, delete that region first (replace behavior)
    if (range && range.end - range.start > 0.01) {
      buf = deleteRegion(buf, range.start, range.end);
    }
    const edited = insertRegion(buf, clipboard, pasteAt);
    const wav = encodeToWav(edited);
    await saveAudioBlob(targetTrackId, wav);
    // Record clip boundary for the pasted region
    setClipRegions((prev) => ({
      ...prev,
      [targetTrackId]: [...(prev[targetTrackId] ?? []), { start: pasteAt, end: pasteAt + clipDuration }],
    }));
    setTrackPeaks((prev) => { const n = { ...prev }; delete n[targetTrackId]; return n; });
    setTrackDurations((prev) => { const n = { ...prev }; delete n[targetTrackId]; return n; });
    setSelection(null);
    await loadData();
  };

  // --- Effects handlers ---
  const handleEffectsSave = async (
    track: Track, reverb: number, delay: number, delayTime: number, chorus: number,
    harmMix: number, harmInterval: 3 | 5, harmDirection: 'above' | 'below'
  ) => {
    const updated = {
      ...track, reverbMix: reverb, delayMix: delay, delayTime, chorusMix: chorus,
      harmonizerMix: harmMix, harmonizerInterval: harmInterval, harmonizerDirection: harmDirection,
    };
    await updateTrack(updated);
    playerRef.current.updateTrackEffects(track.id!, reverb, delay, delayTime, chorus, harmMix, harmInterval, harmDirection);
    setTracks((prev) => prev.map((t) => (t.id === track.id ? updated : t)));
  };

  // --- Quantize handler ---
  const handleQuantize = async (track: Track, resolution: QuantizeResolution, strength: number, sensitivity: number) => {
    if (!track.id) return;
    await pushUndo(track.id);
    setAiProcessingTrackId(track.id);
    setAiStatus('Quantizing audio...');
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
      setAiProcessingTrackId(null);
      setAiStatus('');
    }
  };

  // --- Pitch correction handler (Kits.AI) ---
  const handlePitchCorrect = async (track: Track, pitchShift: number, key: string, scale: string, correctionStrength: number) => {
    if (!track.id) return;
    await pushUndo(track.id);
    setAiProcessingTrackId(track.id);
    setAiStatus('Applying pitch correction...');
    const controller = new AbortController();
    aiAbortRef.current = controller;
    aiRawBlobRef.current = null;
    try {
      const blob = await getAudioBlob(track.id);
      if (!blob) return;
      aiRawBlobRef.current = blob;

      // Build query params
      const params = new URLSearchParams();
      if (pitchShift !== 0) params.set('pitchShift', String(pitchShift));
      if (key && key !== 'off') {
        params.set('pitchCorrection', JSON.stringify({ key, scale, strength: correctionStrength }));
      }

      const resp = await fetch(`/api/kits/pitch-correct?${params.toString()}`, {
        method: 'POST',
        body: blob,
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(await resp.text());
      const job = await resp.json();
      const jobId = job.id;

      // Poll for completion
      setAiStatus('AI is correcting pitch...');
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => {
          const timer = setTimeout(r, 3000);
          controller.signal.addEventListener('abort', () => { clearTimeout(timer); r(undefined); }, { once: true });
        });
        controller.signal.throwIfAborted();

        const poll = await fetch(`/api/kits/convert/${jobId}`, { signal: controller.signal });
        if (!poll.ok) continue;
        const data = await poll.json();
        if (data.status === 'completed' || data.status === 'success') {
          const outputUrl = data.outputFileUrl || data.outputUrl;
          if (!outputUrl) throw new Error('No output URL');
          setAiStatus('Downloading corrected audio...');
          const dl = await fetch(`/api/kits/download?url=${encodeURIComponent(outputUrl)}`, { signal: controller.signal });
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
      if (err instanceof DOMException && err.name === 'AbortError') {
        console.log('Pitch correction cancelled by user');
      } else {
        console.error('Pitch correction failed:', err);
        setAiStatus(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    } finally {
      aiAbortRef.current = null;
      aiRawBlobRef.current = null;
      setAiProcessingTrackId(null);
      setAiStatus('');
    }
  };

  // --- AI Re-Transform handler (Kits.AI with custom settings) ---
  const handleAiReTransform = async (track: Track, options: TransformOptions) => {
    if (!track.id) return;
    await pushUndo(track.id);
    setAiProcessingTrackId(track.id);
    setAiStatus('Starting AI transform...');
    const controller = new AbortController();
    aiAbortRef.current = controller;
    aiRawBlobRef.current = null;
    try {
      const blob = await getAudioBlob(track.id);
      if (!blob) return;
      aiRawBlobRef.current = blob;
      const converted = await reTransformAudio(blob, options, setAiStatus, controller.signal);
      await saveAudioBlob(track.id, converted);
      await updateTrack({ ...track, aiProcessed: true });
      setTrackPeaks((prev) => { const n = { ...prev }; delete n[track.id!]; return n; });
      setTrackDurations((prev) => { const n = { ...prev }; delete n[track.id!]; return n; });
      await loadData();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        console.log('AI re-transform cancelled by user');
      } else {
        console.error('AI re-transform failed:', err);
        setAiStatus(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    } finally {
      aiAbortRef.current = null;
      aiRawBlobRef.current = null;
      setAiProcessingTrackId(null);
      setAiStatus('');
    }
  };

  // --- Stop AI processing ---
  const handleStopAi = () => {
    if (aiAbortRef.current) {
      aiAbortRef.current.abort();
    }
  };

  const handleDeleteTrack = (trackId: number) => {
    setDeleteConfirmTrackId(trackId);
  };

  const confirmDeleteTrack = async () => {
    if (deleteConfirmTrackId === null) return;
    await deleteTrack(deleteConfirmTrackId, songId);
    setClipRegions((prev) => { const n = { ...prev }; delete n[deleteConfirmTrackId]; return n; });
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

  const busy = aiProcessingTrackId !== null || aiGenerating;

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
            color: '#fff', padding: '4px 0', display: 'flex', alignItems: 'center', gap: 8,
          }} title="Click to edit title">
            {song.name}
            {song.aiMode && (
              <span style={{
                fontSize: 10, padding: '2px 8px', borderRadius: 4, fontWeight: 700,
                background: '#e91e6322', color: '#e91e63', letterSpacing: 0.5,
              }}>AI {'\u00B7'} {song.aiKey} {song.aiScale}</span>
            )}
          </h2>
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
        <button onClick={() => setShowShortcuts(true)}
          style={{
            padding: '6px 10px', background: '#2a2a2a', color: '#888',
            borderRadius: 4, fontSize: 14, fontWeight: 700,
          }} title="Keyboard shortcuts">?</button>
      </header>

      {/* ===== TRANSPORT BAR ===== */}
      <div style={{
        padding: '6px 16px', background: '#1e1e1e', borderBottom: '1px solid #2a2a2a',
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap',
      }}>
        <button onClick={handleStop} style={{
          width: 44, height: 44, borderRadius: 6, background: '#2a2a2a',
          color: '#ccc', fontSize: 20, border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} title="Stop">{'\u23F9'}</button>
        <button onClick={handlePlay} disabled={tracks.length === 0 || busy}
          style={{
            width: 44, height: 44, borderRadius: 6,
            background: isPlaying ? '#4caf5033' : '#2a2a2a',
            color: isPlaying ? '#4caf50' : '#ccc', fontSize: 20,
            border: isPlaying ? '1px solid #4caf50' : 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          title={isPlaying ? 'Pause' : 'Play'}>{isPlaying ? '\u23F8' : '\u25B6'}</button>
        <button onClick={handleRecordButton}
          disabled={busy && !isRecording}
          style={{
            width: 44, height: 44, borderRadius: 6,
            background: isRecording ? '#f4433633' : recordArmedTrackId !== null ? '#f4433622' : '#2a2a2a',
            color: isRecording ? '#f44336' : recordArmedTrackId !== null ? '#f44336' : '#ccc',
            fontSize: 22, border: isRecording ? '1px solid #f44336' : 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            animation: isRecording ? 'pulse 1s infinite' : undefined,
          }}
          title={isRecording ? 'Stop Recording' : recordArmedTrackId !== null ? 'Punch In' : 'Record'}>{'\u23FA'}</button>

        <div style={{ width: 1, height: 24, background: '#333', margin: '0 4px' }} />

        <div style={{
          fontFamily: 'monospace', fontSize: 14,
          color: isRecording ? '#f44336' : '#4caf50',
          background: '#0a0a0a',
          padding: '4px 12px', borderRadius: 4, minWidth: 80, textAlign: 'center',
        }}>{formatTime(isRecording ? recordingTime : playPos)}</div>

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
          <select
            value={metronomeNote ?? ''}
            onChange={(e) => setMetronomeNote(e.target.value ? e.target.value as MetronomeNote : null)}
            style={{
              background: metronomeNote ? '#e91e6333' : '#0a0a0a',
              border: `1px solid ${metronomeNote ? '#e91e63' : '#333'}`,
              borderRadius: 4, color: metronomeNote ? '#e91e63' : '#888',
              fontSize: 11, padding: '2px 4px', cursor: 'pointer',
            }}
            title="Metronome note — plays a pitched tone to help singers stay in key"
          >
            <option value="">Click</option>
            {METRONOME_NOTES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        )}

        <button onClick={() => setPreRollEnabled(!preRollEnabled)}
          style={{
            ...transportBtnStyle, fontSize: 11, padding: '4px 8px', borderRadius: 4,
            background: preRollEnabled ? '#2196f333' : 'transparent',
            color: preRollEnabled ? '#2196f3' : '#888',
          }} title={`Pre-roll: play ${preRollBars} bar(s) before punch-in recording starts`}>
          Pre-roll
        </button>

        {preRollEnabled && (
          <select value={preRollBars} onChange={(e) => setPreRollBars(Number(e.target.value))}
            style={{
              background: '#0a0a0a', border: '1px solid #333', borderRadius: 4,
              color: '#2196f3', fontSize: 11, padding: '2px 4px',
            }}>
            {[1, 2, 4].map(n => <option key={n} value={n}>{n} bar{n > 1 ? 's' : ''}</option>)}
          </select>
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
          }} title={editMode === 'snap' ? 'Snap to grid (click to switch to freeform)' : 'Freeform (click to switch to snap)'}>
          {editMode === 'snap' ? '\u{1F9F2} Snap' : '\u270B Free'}
        </button>

        {/* Grid resolution selector */}
        <div style={{ display: 'flex', gap: 1, background: '#1a1a1a', borderRadius: 4, padding: 1 }}>
          {([1, 4, 8, 16] as const).map((res) => {
            const labels: Record<number, string> = { 1: '1/1', 4: '1/4', 8: '1/8', 16: '1/16' };
            const titles: Record<number, string> = { 1: 'Whole notes (bars)', 4: 'Quarter notes', 8: 'Eighth notes', 16: 'Sixteenth notes' };
            return (
              <button key={res} onClick={() => setGridResolution(res)}
                style={{
                  ...transportBtnStyle, fontSize: 10, padding: '3px 6px', borderRadius: 3,
                  background: gridResolution === res ? '#4caf5044' : 'transparent',
                  color: gridResolution === res ? '#4caf50' : '#666',
                  fontWeight: gridResolution === res ? 700 : 400,
                }} title={titles[res]}>{labels[res]}</button>
            );
          })}
        </div>

        <button onClick={() => setLoopEnabled(!loopEnabled)}
          style={{
            ...transportBtnStyle, fontSize: 11, fontWeight: 600, padding: '4px 8px', borderRadius: 4,
            background: loopEnabled ? '#ff980033' : 'transparent',
            color: loopEnabled ? '#ff9800' : '#888',
          }} title={loopEnabled ? 'Loop enabled — select a region and press play to loop' : 'Enable loop mode'}>
          {'\u{1F501}'} Loop
        </button>

        <button onClick={() => setShowGroupDialog(true)}
          style={{
            ...transportBtnStyle, fontSize: 11, fontWeight: 600, padding: '4px 8px', borderRadius: 4,
            background: trackGroups.length > 0 ? '#2196f333' : 'transparent',
            color: trackGroups.length > 0 ? '#2196f3' : '#888',
          }} title="Manage track groups">
          Groups{trackGroups.length > 0 ? ` (${trackGroups.length})` : ''}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 4 }}>
            {focusedTrackId && (
              <button onClick={handlePasteRegion} style={{ ...transportBtnStyle, fontSize: 11, padding: '4px 8px', color: '#bb86fc' }}
                title="Paste at cursor position (\u2318V)">Paste</button>
            )}
            <span style={{ fontSize: 10, color: '#bb86fc88' }}>{'\u{1F4CB}'} Clipboard ready {focusedTrackId ? '— click timeline to position, then \u2318V' : '— click a track first'}</span>
          </div>
        )}

        <button onClick={handleUndo}
          disabled={undoStackRef.current.length === 0}
          style={{
            ...transportBtnStyle, fontSize: 11, padding: '4px 8px', borderRadius: 4,
            color: undoStackRef.current.length > 0 ? '#ccc' : '#444',
          }} title="Undo last edit (\u2318Z)">{'\u21A9'} Undo</button>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {busy && (
            <>
              <div style={{
                width: 8, height: 8, borderRadius: '50%', background: '#bb86fc',
                animation: 'pulse 1s infinite',
              }} />
              <span style={{ fontSize: 11, color: aiGenerating ? '#e91e63' : '#bb86fc' }}>
                {aiGenerating ? (aiGenStatus || 'AI generating track...') : (aiStatus || 'AI Processing...')}
              </span>
              <button
                onClick={aiGenerating ? () => { aiGenAbortRef.current?.abort(); setAiGenerating(false); setAiGenStatus(''); } : handleStopAi}
                title={aiGenerating ? 'Cancel AI generation' : 'Stop AI rendering'}
                style={{
                  background: '#f4433644', color: '#f44336', border: '1px solid #f4433666',
                  borderRadius: 4, padding: '2px 8px', fontSize: 10, fontWeight: 700,
                  cursor: 'pointer', marginLeft: 4,
                }}>{aiGenerating ? 'Cancel' : 'Stop'}</button>
              <div style={{ width: 1, height: 24, background: '#333', margin: '0 4px' }} />
            </>
          )}
          <span style={{ fontSize: 11, color: '#888' }}>{'\u{1F50D}'}</span>
          <input type="range" min={100} max={500} value={Math.round(zoom * 100)}
            onChange={(e) => setZoom(Number(e.target.value) / 100)}
            style={{ width: 80, accentColor: '#888' }}
            title={`Zoom: ${Math.round(zoom * 100)}%`} />
          <span style={{ fontSize: 10, color: '#666', minWidth: 32 }}>{Math.round(zoom * 100)}%</span>
        </div>
      </div>

      {/* ===== RECORDING LEVEL ===== */}
      {isRecording && (
        <div style={{ padding: '6px 16px', background: '#1a0a0a', borderBottom: '1px solid #331111', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#f44336', animation: 'pulse 1s infinite' }} />
            <span style={{ fontSize: 13, color: '#f44336', fontWeight: 700 }}>
              {recordArmedTrackId !== null ? 'PUNCH IN' : 'RECORDING'}
            </span>
            {recordingTrackId !== null && tracks.find(t => t.id === recordingTrackId) && (
              <span style={{ fontSize: 12, color: '#ccc' }}>
                {tracks.find(t => t.id === recordingTrackId)!.name}
              </span>
            )}
            <span style={{ fontSize: 14, fontFamily: 'monospace', color: '#f44336', fontWeight: 700, marginLeft: 'auto' }}>
              {formatTime(recordingTime)}
            </span>
            <button onClick={handleStopRecording} style={{
              padding: '3px 12px', background: '#f44336', color: '#fff',
              border: 'none', borderRadius: 4, fontWeight: 700, fontSize: 11, cursor: 'pointer',
            }}>STOP</button>
          </div>
          <LevelMeter level={audioLevel} />
        </div>
      )}

      {/* ===== TRACK ARRANGEMENT (DAW-style) ===== */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
        {/* Timeline ruler */}
        <div ref={timelineScrollRef} style={{ overflowX: 'hidden', overflowY: 'hidden', height: 24, background: '#111', borderBottom: '1px solid #2a2a2a', flexShrink: 0 }}
          onScroll={() => { if (lanesScrollRef.current && timelineScrollRef.current) lanesScrollRef.current.scrollLeft = timelineScrollRef.current.scrollLeft; }}>
          <div style={{ display: 'flex', height: 24, minWidth: `calc(200px + ${zoom * 100}%)` }}>
            <div style={{ width: 200, minWidth: 200, background: '#1a1a1a', borderRight: '1px solid #2a2a2a', position: 'sticky', left: 0, zIndex: 3 }} />
            <div style={{ flex: 1, position: 'relative' }}>
              <TimelineRuler duration={maxDuration} bpm={bpm} gridResolution={gridResolution} />
              {loopEnabled && selection && Math.abs(selection.endTime - selection.startTime) > 0.01 && (
                <div style={{
                  position: 'absolute', top: 0, bottom: 0, zIndex: 1, pointerEvents: 'none',
                  left: `${(Math.min(selection.startTime, selection.endTime) / maxDuration) * 100}%`,
                  width: `${(Math.abs(selection.endTime - selection.startTime) / maxDuration) * 100}%`,
                  background: 'rgba(255, 152, 0, 0.15)',
                  borderLeft: '2px solid #ff9800',
                  borderRight: '2px solid #ff9800',
                }} />
              )}
              <div style={{
                position: 'absolute', top: 0, bottom: 0, width: isPlaying ? 1 : 2, background: '#4caf50',
                left: `${(playPos / maxDuration) * 100}%`, zIndex: 2,
              }} />
            </div>
          </div>
        </div>

        {/* Track lanes */}
        <div ref={lanesScrollRef} style={{ flex: 1, overflow: 'auto' }}
          onScroll={() => { if (timelineScrollRef.current && lanesScrollRef.current) timelineScrollRef.current.scrollLeft = lanesScrollRef.current.scrollLeft; }}>
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
                  minWidth: `calc(200px + ${zoom * 100}%)`,
                }}>
                  {/* Track header */}
                  <div style={{
                    width: 200, minWidth: 200, padding: '8px 10px',
                    background: isArmed ? '#2a1111' : '#1a1a1a',
                    borderRight: isArmed ? '2px solid #f44336' : '1px solid #2a2a2a',
                    display: 'flex', flexDirection: 'column', gap: 4,
                    position: 'sticky', left: 0, zIndex: 1,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        defaultValue={track.name}
                        key={track.id + '-' + track.name}
                        onBlur={(e) => { e.currentTarget.style.outline = 'none'; handleRenameTrack(track, e.currentTarget.value); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                        onFocus={(e) => { e.currentTarget.style.outline = `1px solid ${ROLE_COLORS[track.role]}`; }}
                        style={{
                          fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
                          background: ROLE_COLORS[track.role] + '33',
                          color: ROLE_COLORS[track.role],
                          border: 'none', outline: 'none',
                          padding: '2px 8px', borderRadius: 12,
                          maxWidth: 120, cursor: 'text',
                        }}
                      />
                      {track.role !== 'vocals' && track.role !== 'other' && (trackDurations[track.id!] ?? 0) > 0 && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setShowAiTransform(track); }}
                          disabled={aiProcessingTrackId === track.id}
                          title={track.aiProcessed ? 'Re-transform with AI' : 'Transform with AI'}
                          style={{
                            ...smallBtnStyle,
                            background: track.aiProcessed ? '#bb86fc33' : '#bb86fc1a',
                            color: track.aiProcessed ? '#bb86fc' : '#bb86fc99',
                            border: track.aiProcessed ? 'none' : '1px dashed #bb86fc44',
                            padding: '2px 8px', minWidth: 28,
                          }}>AI</button>
                      )}
                      {track.aiGenerated && (
                        <span style={{
                          fontSize: 8, padding: '1px 5px', borderRadius: 3, fontWeight: 700,
                          background: '#e91e6322', color: '#e91e63', letterSpacing: 0.5,
                        }}>AI GEN</span>
                      )}
                      {isArmed && (
                        <span style={{
                          fontSize: 9, padding: '1px 5px', borderRadius: 4,
                          background: '#f4433633', color: '#f44336', fontWeight: 700,
                          animation: 'pulse 1s infinite',
                        }}>REC</span>
                      )}
                      {track.id !== undefined && playlists[track.id] && playlists[track.id].length > 0 && (
                        <span
                          onClick={() => setShowPlaylists(showPlaylists === track.id! ? null : track.id!)}
                          style={{
                            fontSize: 9, padding: '1px 5px', borderRadius: 4, cursor: 'pointer',
                            background: '#2196f333', color: '#2196f3', fontWeight: 700,
                          }}
                          title="Click to switch takes"
                        >{playlists[track.id!].length} takes</span>
                      )}
                    </div>
                    {/* Playlist take switcher */}
                    {track.id !== undefined && showPlaylists === track.id && playlists[track.id] && (
                      <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap', marginTop: 2 }}>
                        {playlists[track.id!].map((_, i) => (
                          <button key={i}
                            onClick={() => switchPlaylist(track.id!, i)}
                            style={{
                              ...smallBtnStyle,
                              background: (activePlaylistIndex[track.id!] ?? playlists[track.id!].length - 1) === i ? '#2196f3' : '#2a2a2a',
                              color: (activePlaylistIndex[track.id!] ?? playlists[track.id!].length - 1) === i ? '#fff' : '#888',
                              fontSize: 9, padding: '1px 4px',
                            }}
                            title={`Switch to take ${i + 1}`}
                          >T{i + 1}</button>
                        ))}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 3, marginTop: 2, flexWrap: 'wrap' }}>
                      <button onClick={() => track.id !== undefined && toggleRecordArm(track.id)}
                        disabled={isRecording && recordingTrackId !== track.id}
                        style={{
                          ...smallBtnStyle,
                          background: recordingTrackId === track.id ? '#f44336' : isArmed ? '#f4433688' : '#2a2a2a',
                          color: recordingTrackId === track.id || isArmed ? '#fff' : '#888',
                          animation: recordingTrackId === track.id ? 'pulse 1s infinite' : undefined,
                        }}
                        title={recordingTrackId === track.id ? 'Stop recording' : 'Record on this track'}>R</button>
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
                    {/* Grid lines */}
                    {(() => {
                      const lines: React.ReactNode[] = [];
                      const beatDur = 60 / bpm;
                      const gridStep = (beatDur * 4) / gridResolution;
                      for (let t = gridStep; t < maxDuration; t += gridStep) {
                        const barIndex = t / barDuration;
                        const isBar = Math.abs(barIndex - Math.round(barIndex)) < 0.001;
                        const beatIndex = t / beatDur;
                        const isBeat = Math.abs(beatIndex - Math.round(beatIndex)) < 0.001;
                        lines.push(
                          <div key={`bg${t}`} style={{
                            position: 'absolute', top: 0, bottom: 0, width: 0,
                            borderLeft: `1px solid ${isBar ? '#2a2a2a' : isBeat ? '#1a1a1a' : '#151515'}`,
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
                    {/* Clip boundary markers */}
                    {track.id !== undefined && clipRegions[track.id]?.map((clip, ci) => (
                      <div key={`clip-${ci}`} style={{
                        position: 'absolute', top: 0, bottom: 0, zIndex: 2, pointerEvents: 'none',
                        left: `${(clip.start / maxDuration) * 100}%`,
                        width: `${((clip.end - clip.start) / maxDuration) * 100}%`,
                        borderLeft: '2px solid rgba(255,255,255,0.35)',
                        borderRight: '2px solid rgba(255,255,255,0.35)',
                        boxSizing: 'border-box',
                      }}>
                        {/* Top accent bar */}
                        <div style={{
                          position: 'absolute', top: 0, left: 0, right: 0, height: 3,
                          background: ROLE_COLORS[track.role] + '88',
                        }} />
                        {/* Bottom accent bar */}
                        <div style={{
                          position: 'absolute', bottom: 0, left: 0, right: 0, height: 3,
                          background: ROLE_COLORS[track.role] + '88',
                        }} />
                      </div>
                    ))}
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
                    {/* Loop region overlay */}
                    {loopEnabled && selection && Math.abs(selection.endTime - selection.startTime) > 0.01 && (
                      <div style={{
                        position: 'absolute', top: 0, bottom: 0, zIndex: 2, pointerEvents: 'none',
                        left: `${(Math.min(selection.startTime, selection.endTime) / maxDuration) * 100}%`,
                        width: `${(Math.abs(selection.endTime - selection.startTime) / maxDuration) * 100}%`,
                        background: 'rgba(255, 152, 0, 0.08)',
                        borderTop: '2px solid #ff9800',
                        borderBottom: '2px solid #ff9800',
                      }} />
                    )}
                    <div style={{
                      position: 'absolute', top: 0, bottom: 0, width: isPlaying ? 1 : 2, background: '#4caf50',
                      left: `${(playPos / maxDuration) * 100}%`, zIndex: 4,
                    }} />
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
            isRecording={isRecording && recordingTrackId !== track.id}
            groupColor={track.id !== undefined ? getGroupForTrack(track.id)?.color : undefined}
            onVolumeChange={(v) => handleGroupedVolumeChange(track, v)}
            onPanChange={(p) => handlePanChange(track, p)}
            onToggleMute={() => track.id !== undefined && toggleGroupedMute(track.id)}
            onToggleSolo={() => track.id !== undefined && toggleGroupedSolo(track.id)}
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

        {/* Creation mode toggle */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: '#888', display: 'block', marginBottom: 6 }}>Creation Method</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setTrackCreationMode('record')}
              style={{
                flex: 1, padding: '10px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                background: trackCreationMode === 'record' ? '#bb86fc22' : '#1e1e1e',
                border: `2px solid ${trackCreationMode === 'record' ? '#bb86fc' : '#333'}`,
                color: trackCreationMode === 'record' ? '#bb86fc' : '#888',
                cursor: 'pointer', textAlign: 'center',
              }}>
              <div style={{ fontSize: 20, marginBottom: 4 }}>{'\uD83C\uDFA4'}</div>
              Record a new track
            </button>
            <button onClick={() => setTrackCreationMode('ai')}
              style={{
                flex: 1, padding: '10px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                background: trackCreationMode === 'ai' ? '#e91e6322' : '#1e1e1e',
                border: `2px solid ${trackCreationMode === 'ai' ? '#e91e63' : '#333'}`,
                color: trackCreationMode === 'ai' ? '#e91e63' : '#888',
                cursor: 'pointer', textAlign: 'center',
              }}>
              <div style={{ fontSize: 20, marginBottom: 4 }}>{'\u2728'}</div>
              AI created track
            </button>
          </div>
        </div>

        {/* Instrument selection */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: '#888', display: 'block', marginBottom: 6 }}>Instrument</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {TRACK_ROLES.map((role) => (
              <button key={role} onClick={() => setNewTrackRole(role)}
                style={{
                  padding: '6px 12px', borderRadius: 20, fontSize: 12,
                  background: newTrackRole === role ? (trackCreationMode === 'ai' ? '#e91e63' : '#bb86fc') : '#2a2a2a',
                  color: newTrackRole === role ? '#000' : '#aaa',
                  fontWeight: newTrackRole === role ? 600 : 400, textTransform: 'capitalize',
                }}>{role}</button>
            ))}
          </div>
        </div>

        {/* Context info */}
        {trackCreationMode === 'record' && newTrackRole !== 'vocals' && newTrackRole !== 'other' && (
          <p style={{ fontSize: 12, color: '#bb86fc', marginBottom: 12, lineHeight: 1.4 }}>
            AI will transform your recording to sound like {newTrackRole} using KITS.AI
          </p>
        )}
        {trackCreationMode === 'ai' && (
          <div style={{
            fontSize: 12, color: '#e91e63', marginBottom: 12, lineHeight: 1.6,
            background: '#e91e6312', borderRadius: 8, padding: '10px 14px',
          }}>
            <strong>AI Musician</strong> will create a {newTrackRole} track
            {tracks.length > 0
              ? ` that matches your existing ${tracks.length} track${tracks.length > 1 ? 's' : ''}`
              : ''}.
            {song?.aiKey && ` Key: ${song.aiKey} ${song.aiScale ?? 'major'}.`}
            {` Tempo: ${bpm} BPM.`}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={() => { setShowNewTrack(false); setTrackCreationMode('record'); }}
            style={{ padding: '8px 16px', background: 'none', color: '#888', borderRadius: 4 }}>Cancel</button>
          {trackCreationMode === 'record' ? (
            <button onClick={handleAddTrack}
              style={{ padding: '8px 20px', background: '#bb86fc', color: '#000', borderRadius: 4, fontWeight: 600 }}>Record</button>
          ) : (
            <button onClick={handleAiTrack}
              style={{ padding: '8px 20px', background: '#e91e63', color: '#fff', borderRadius: 4, fontWeight: 600 }}>
              Generate with AI
            </button>
          )}
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

      <Dialog open={showAiTransform !== null} onClose={() => setShowAiTransform(null)} title="AI Transform (Kits.AI)">
        {showAiTransform && <AITransformControls track={showAiTransform} onApply={(opts) => { handleAiReTransform(showAiTransform, opts); setShowAiTransform(null); }} onClose={() => setShowAiTransform(null)} />}
      </Dialog>

      {/* Track Groups dialog */}
      <Dialog open={showGroupDialog} onClose={() => setShowGroupDialog(false)} title="Track Groups">
        <div>
          {trackGroups.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#ccc', marginBottom: 6 }}>Current Groups</div>
              {trackGroups.map((group, gi) => (
                <div key={gi} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
                  background: '#1e1e1e', borderRadius: 4, marginBottom: 4,
                  borderLeft: `3px solid ${group.color}`,
                }}>
                  <span style={{ fontSize: 12, color: group.color, fontWeight: 600, flex: 1 }}>{group.name}</span>
                  <span style={{ fontSize: 10, color: '#888' }}>
                    {[...group.trackIds].map(tid => tracks.find(t => t.id === tid)?.name).filter(Boolean).join(', ')}
                  </span>
                  <button onClick={() => removeTrackGroup(gi)}
                    style={{ background: 'none', color: '#666', fontSize: 12, padding: '2px 4px', cursor: 'pointer' }}>{'\u2715'}</button>
                </div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 12, fontWeight: 600, color: '#ccc', marginBottom: 6 }}>New Group</div>
          <input type="text" placeholder="Group name" value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            style={{ ...dialogInputStyle, marginBottom: 8 }} />
          <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Select tracks:</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
            {tracks.map(t => (
              <button key={t.id} onClick={() => {
                setNewGroupTrackIds(prev => {
                  const next = new Set(prev);
                  if (next.has(t.id!)) next.delete(t.id!); else next.add(t.id!);
                  return next;
                });
              }} style={{
                padding: '4px 10px', borderRadius: 4, fontSize: 11,
                background: newGroupTrackIds.has(t.id!) ? ROLE_COLORS[t.role] + '44' : '#2a2a2a',
                color: newGroupTrackIds.has(t.id!) ? ROLE_COLORS[t.role] : '#888',
                border: newGroupTrackIds.has(t.id!) ? `1px solid ${ROLE_COLORS[t.role]}` : '1px solid transparent',
              }}>{t.name}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setShowGroupDialog(false)}
              style={{ padding: '8px 16px', background: 'none', color: '#888', borderRadius: 4 }}>Close</button>
            <button onClick={addTrackGroup}
              disabled={!newGroupName.trim() || newGroupTrackIds.size === 0}
              style={{
                padding: '8px 20px', borderRadius: 4, fontWeight: 600,
                background: (!newGroupName.trim() || newGroupTrackIds.size === 0) ? '#333' : '#2196f3',
                color: (!newGroupName.trim() || newGroupTrackIds.size === 0) ? '#555' : '#fff',
              }}>Create Group</button>
          </div>
        </div>
      </Dialog>

      {/* Keyboard shortcuts help */}
      <Dialog open={showShortcuts} onClose={() => setShowShortcuts(false)} title="Keyboard Shortcuts">
        <div style={{ fontSize: 12 }}>
          {([
            ['Space', 'Play / Pause'],
            ['Enter', 'Stop (return to start)'],
            ['R', 'Record / Punch-in'],
            ['\u2318/Ctrl+Z', 'Undo last edit'],
            ['Ctrl+X', 'Cut selection'],
            ['Ctrl+C', 'Copy selection'],
            ['Ctrl+V', 'Paste at cursor'],
            ['Delete', 'Delete selection'],
            ['L', 'Toggle loop mode'],
            ['M', 'Toggle metronome'],
            ['G', 'Toggle snap/freeform'],
            ['Esc', 'Clear selection'],
            ['+', 'Zoom in'],
            ['-', 'Zoom out'],
          ] as [string, string][]).map(([key, desc]) => (
            <div key={key} style={{ display: 'flex', gap: 12, marginBottom: 6, alignItems: 'center' }}>
              <span style={{
                fontFamily: 'monospace', fontWeight: 700, color: '#bb86fc',
                background: '#2a2a2a', padding: '2px 6px', borderRadius: 3, textAlign: 'center',
                minWidth: 70, display: 'inline-block',
              }}>{key}</span>
              <span style={{ color: '#ccc' }}>{desc}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={() => setShowShortcuts(false)}
            style={{ padding: '8px 20px', background: '#bb86fc', color: '#000', borderRadius: 4, fontWeight: 600 }}>Close</button>
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

function TimelineRuler({ duration, bpm, gridResolution }: { duration: number; bpm: number; gridResolution: 1 | 4 | 8 | 16 }) {
  const barDur = (60 / bpm) * 4; // 4/4 time
  const beatDur = 60 / bpm; // quarter note
  const gridStep = (beatDur * 4) / gridResolution; // duration of one grid division

  // Bar markers (always shown with labels)
  const bars: { time: number; num: number }[] = [];
  let barNum = 1;
  for (let t = 0; t <= duration; t += barDur) {
    bars.push({ time: t, num: barNum++ });
  }

  // Determine bar label frequency to avoid crowding
  const barPct = (barDur / duration) * 100;
  const labelEvery = barPct < 2 ? 8 : barPct < 4 ? 4 : barPct < 7 ? 2 : 1;

  // Sub-grid lines (only if resolution > 1 bar)
  const subGridLines: { time: number; isBeat: boolean }[] = [];
  if (gridResolution > 1) {
    for (let t = gridStep; t < duration; t += gridStep) {
      // Skip lines that land on bar boundaries (those are drawn separately)
      const barIndex = t / barDur;
      if (Math.abs(barIndex - Math.round(barIndex)) < 0.001) continue;
      const beatIndex = t / beatDur;
      const isBeat = Math.abs(beatIndex - Math.round(beatIndex)) < 0.001;
      subGridLines.push({ time: t, isBeat });
    }
  }

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      {/* Sub-grid lines */}
      {subGridLines.map((sg, i) => (
        <div key={`sg${i}`} style={{
          position: 'absolute', left: `${(sg.time / duration) * 100}%`, top: 0, bottom: 0,
          borderLeft: `1px solid ${sg.isBeat ? '#2a2a2a' : '#1a1a1a'}`,
        }} />
      ))}
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

function MixerStrip({ track, isMuted, isSolo, isArmed, isRecording: isRec, groupColor, onVolumeChange, onPanChange, onToggleMute, onToggleSolo, onToggleArm, onEQ, onToggleCompressor, onFX }: {
  track: Track; isMuted: boolean; isSolo: boolean; isArmed: boolean; isRecording: boolean;
  groupColor?: string;
  onVolumeChange: (v: number) => void; onPanChange: (p: number) => void; onToggleMute: () => void;
  onToggleSolo: () => void; onToggleArm: () => void; onEQ: () => void; onToggleCompressor: () => void; onFX: () => void;
}) {
  const volDb = track.volume > 0 ? (20 * Math.log10(track.volume)).toFixed(1) : '-inf';
  const pan = track.pan ?? 0;
  const panLabel = pan === 0 ? 'C' : pan < 0 ? `L${Math.round(Math.abs(pan) * 100)}` : `R${Math.round(pan * 100)}`;

  return (
    <div style={{
      minWidth: 72, width: 72, display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '8px 4px', borderRight: '1px solid #2a2a2a', gap: 4,
      borderTop: groupColor ? `3px solid ${groupColor}` : undefined,
    }}>
      <span style={{
        fontSize: 10, fontWeight: 600, textAlign: 'center', lineHeight: 1.2,
        color: ROLE_COLORS[track.role], textTransform: 'uppercase',
      }}>
        {track.name.length > 8 ? track.name.slice(0, 7) + '\u2026' : track.name}
      </span>

      {/* Pan knob */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0, width: '100%', padding: '0 2px' }}>
        <input type="range" min={-100} max={100} value={Math.round(pan * 100)}
          onChange={(e) => onPanChange(Number(e.target.value) / 100)}
          onDoubleClick={() => onPanChange(0)}
          style={{ width: '100%', height: 10, accentColor: '#2196f3', margin: 0 }}
          title={`Pan: ${panLabel} (double-click to center)`} />
      </div>
      <span style={{ fontSize: 7, color: '#666', marginTop: -2 }}>{panLabel}</span>

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
            height: 60, width: 24,
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
          background: ((track.reverbMix ?? 0) > 0 || (track.delayMix ?? 0) > 0 || (track.chorusMix ?? 0) > 0 || (track.harmonizerMix ?? 0) > 0) ? '#9c27b0' : '#2a2a2a',
          color: ((track.reverbMix ?? 0) > 0 || (track.delayMix ?? 0) > 0 || (track.chorusMix ?? 0) > 0 || (track.harmonizerMix ?? 0) > 0) ? '#fff' : '#888',
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

const INSTRUMENT_ROLES: TrackRole[] = ['guitar', 'bass', 'drums', 'piano', 'synth', 'strings'];

function AITransformControls({ track, onApply, onClose }: {
  track: Track;
  onApply: (options: TransformOptions) => void;
  onClose: () => void;
}) {
  const [models, setModels] = useState<VoiceModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedModelId, setSelectedModelId] = useState<number | null>(null);
  const [filterRole, setFilterRole] = useState<TrackRole | 'all'>(track.role);
  const [conversionStrength, setConversionStrength] = useState(0.5);
  const [modelVolumeMix, setModelVolumeMix] = useState(0.5);
  const [pitchShift, setPitchShift] = useState(0);

  useEffect(() => {
    fetchAllModels()
      .then((m) => { setModels(m); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, []);

  const roleKeywords: Record<string, string[]> = {
    guitar: ['guitar'], bass: ['bass'], drums: ['drum', 'percussion'],
    piano: ['piano', 'keys'], synth: ['synth', 'synthesizer'], strings: ['string', 'violin', 'cello'],
  };

  const filteredModels = filterRole === 'all'
    ? models
    : models.filter((m) => {
        const text = [m.title?.toLowerCase() ?? '', ...(m.tags?.map((t) => t.toLowerCase()) ?? [])].join(' ');
        const kws = roleKeywords[filterRole];
        if (!kws) return true;
        if (filterRole === 'bass' && text.includes('bassoon')) return false;
        return kws.some((kw) => text.includes(kw));
      });

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 20, color: '#888' }}>Loading models...</div>;
  }
  if (error) {
    return <div style={{ color: '#f44336', padding: 12 }}>Failed to load models: {error}</div>;
  }

  return (
    <div>
      <p style={{ color: '#888', fontSize: 12, marginBottom: 12, lineHeight: 1.4 }}>
        Re-process this track's audio through Kits.AI. Choose a different instrument model and adjust conversion parameters.
      </p>

      {/* Instrument filter */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: '#bb86fc', marginBottom: 6 }}>Instrument</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          <button onClick={() => { setFilterRole('all'); setSelectedModelId(null); }} style={{
            padding: '4px 10px', borderRadius: 4, fontSize: 11, fontWeight: 600,
            background: filterRole === 'all' ? '#bb86fc' : '#2a2a2a',
            color: filterRole === 'all' ? '#000' : '#888',
          }}>All</button>
          {INSTRUMENT_ROLES.map((r) => (
            <button key={r} onClick={() => { setFilterRole(r); setSelectedModelId(null); }} style={{
              padding: '4px 10px', borderRadius: 4, fontSize: 11, fontWeight: 600,
              background: filterRole === r ? ROLE_COLORS[r] : '#2a2a2a',
              color: filterRole === r ? '#000' : '#888',
              textTransform: 'capitalize',
            }}>{r}</button>
          ))}
        </div>
      </div>

      {/* Model list */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: '#bb86fc', marginBottom: 6 }}>
          Voice Model <span style={{ color: '#555', fontWeight: 400 }}>({filteredModels.length})</span>
        </div>
        <div style={{
          maxHeight: 140, overflowY: 'auto', background: '#1e1e1e', borderRadius: 6,
          border: '1px solid #333', padding: 4,
        }}>
          {filteredModels.length === 0 ? (
            <div style={{ padding: 12, color: '#555', fontSize: 12, textAlign: 'center' }}>No models found</div>
          ) : filteredModels.map((m) => (
            <button key={m.id} onClick={() => setSelectedModelId(m.id)} style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '6px 10px', borderRadius: 4, fontSize: 12,
              background: selectedModelId === m.id ? '#bb86fc22' : 'transparent',
              color: selectedModelId === m.id ? '#bb86fc' : '#ccc',
              border: selectedModelId === m.id ? '1px solid #bb86fc44' : '1px solid transparent',
              marginBottom: 2, cursor: 'pointer',
            }}>
              <span style={{ fontWeight: 600 }}>{m.title}</span>
              {m.tags && m.tags.length > 0 && (
                <span style={{ fontSize: 10, color: '#666', marginLeft: 8 }}>{m.tags.slice(0, 3).join(', ')}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Conversion Strength */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
          <span style={{ color: '#bb86fc' }}>Conversion Strength</span>
          <span style={{ color: '#888' }}>{Math.round(conversionStrength * 100)}%</span>
        </div>
        <input type="range" min={0} max={100} value={Math.round(conversionStrength * 100)}
          onChange={(e) => setConversionStrength(Number(e.target.value) / 100)}
          style={{ width: '100%', accentColor: '#bb86fc' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#555' }}>
          <span>Original</span><span>Full model accent</span>
        </div>
      </div>

      {/* Model Volume Mix */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
          <span style={{ color: '#bb86fc' }}>Volume Mix</span>
          <span style={{ color: '#888' }}>{Math.round(modelVolumeMix * 100)}%</span>
        </div>
        <input type="range" min={0} max={100} value={Math.round(modelVolumeMix * 100)}
          onChange={(e) => setModelVolumeMix(Number(e.target.value) / 100)}
          style={{ width: '100%', accentColor: '#bb86fc' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#555' }}>
          <span>Input dynamics</span><span>Model volume</span>
        </div>
      </div>

      {/* Pitch Shift */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
          <span style={{ color: '#bb86fc' }}>Pitch Shift</span>
          <span style={{ color: '#888' }}>{pitchShift > 0 ? '+' : ''}{pitchShift} semitones</span>
        </div>
        <input type="range" min={-24} max={24} value={pitchShift}
          onChange={(e) => setPitchShift(Number(e.target.value))}
          style={{ width: '100%', accentColor: '#bb86fc' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#555' }}>
          <span>-24</span><span>0</span><span>+24</span>
        </div>
      </div>

      {/* Summary */}
      {selectedModelId && (
        <div style={{ background: '#1a1a2e', borderRadius: 6, padding: 10, marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: '#888' }}>
            Will transform using <strong style={{ color: '#bb86fc' }}>{models.find((m) => m.id === selectedModelId)?.title}</strong>
            {' '}at {Math.round(conversionStrength * 100)}% strength
            {pitchShift !== 0 && `, ${pitchShift > 0 ? '+' : ''}${pitchShift} semitones`}.
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose}
          style={{ padding: '8px 16px', background: 'none', color: '#888', borderRadius: 4 }}>Cancel</button>
        <button onClick={() => {
          if (!selectedModelId) return;
          onApply({ voiceModelId: selectedModelId, conversionStrength, modelVolumeMix, pitchShift });
        }}
          disabled={!selectedModelId}
          style={{
            padding: '8px 20px', borderRadius: 4, fontWeight: 600,
            background: selectedModelId ? '#bb86fc' : '#333',
            color: selectedModelId ? '#000' : '#555',
          }}>Transform</button>
      </div>
    </div>
  );
}

function EffectsControls({ track, onSave, onClose }: {
  track: Track;
  onSave: (track: Track, reverb: number, delay: number, delayTime: number, chorus: number,
    harmMix: number, harmInterval: 3 | 5, harmDirection: 'above' | 'below') => void;
  onClose: () => void;
}) {
  const [reverb, setReverb] = useState(track.reverbMix ?? 0);
  const [delay, setDelay] = useState(track.delayMix ?? 0);
  const [delayTime, setDelayTime] = useState(track.delayTime ?? 0.3);
  const [chorus, setChorus] = useState(track.chorusMix ?? 0);
  const [harmMix, setHarmMix] = useState(track.harmonizerMix ?? 0);
  const [harmInterval, setHarmInterval] = useState<3 | 5>(track.harmonizerInterval ?? 5);
  const [harmDirection, setHarmDirection] = useState<'above' | 'below'>(track.harmonizerDirection ?? 'above');

  const pct = (v: number) => `${Math.round(v * 100)}%`;

  const segBtnStyle = (active: boolean, color: string): React.CSSProperties => ({
    flex: 1, padding: '5px 0', fontSize: 12, fontWeight: 600, borderRadius: 4,
    background: active ? color : '#1a1a1a', color: active ? '#fff' : '#666',
    border: `1px solid ${active ? color : '#333'}`, cursor: 'pointer', transition: 'all 0.15s',
  });

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

      {/* Harmonizer section */}
      <div style={{ borderTop: '1px solid #333', paddingTop: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
          <span style={{ color: '#e91e63' }}>Harmonizer</span>
          <span style={{ color: '#888' }}>{pct(harmMix)}</span>
        </div>
        <input type="range" min={0} max={100} value={Math.round(harmMix * 100)}
          onChange={(e) => setHarmMix(Number(e.target.value) / 100)}
          style={{ width: '100%', accentColor: '#e91e63', marginBottom: 12 }} />
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Interval</div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={() => setHarmInterval(3)} style={segBtnStyle(harmInterval === 3, '#e91e63')}>3rd</button>
              <button onClick={() => setHarmInterval(5)} style={segBtnStyle(harmInterval === 5, '#e91e63')}>5th</button>
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Direction</div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={() => setHarmDirection('above')} style={segBtnStyle(harmDirection === 'above', '#e91e63')}>Above</button>
              <button onClick={() => setHarmDirection('below')} style={segBtnStyle(harmDirection === 'below', '#e91e63')}>Below</button>
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose}
          style={{ padding: '8px 16px', background: 'none', color: '#888', borderRadius: 4 }}>Cancel</button>
        <button onClick={() => { onSave(track, reverb, delay, delayTime, chorus, harmMix, harmInterval, harmDirection); onClose(); }}
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
