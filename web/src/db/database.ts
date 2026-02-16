import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Song, Track, AudioBlob, Collaborator } from './models';

interface SingSongDB extends DBSchema {
  songs: {
    key: number;
    value: Song;
    indexes: { 'by-updated': number };
  };
  tracks: {
    key: number;
    value: Track;
    indexes: { 'by-song': number };
  };
  audioBlobs: {
    key: number;
    value: AudioBlob;
    indexes: { 'by-track': number };
  };
  collaborators: {
    key: number;
    value: Collaborator;
    indexes: { 'by-song': number };
  };
}

let dbInstance: IDBPDatabase<SingSongDB> | null = null;

async function getDB(): Promise<IDBPDatabase<SingSongDB>> {
  if (dbInstance) return dbInstance;
  dbInstance = await openDB<SingSongDB>('singsong', 1, {
    upgrade(db) {
      const songStore = db.createObjectStore('songs', {
        keyPath: 'id',
        autoIncrement: true,
      });
      songStore.createIndex('by-updated', 'updatedAt');

      const trackStore = db.createObjectStore('tracks', {
        keyPath: 'id',
        autoIncrement: true,
      });
      trackStore.createIndex('by-song', 'songId');

      const audioStore = db.createObjectStore('audioBlobs', {
        keyPath: 'trackId',
      });
      audioStore.createIndex('by-track', 'trackId');

      const collabStore = db.createObjectStore('collaborators', {
        keyPath: 'id',
        autoIncrement: true,
      });
      collabStore.createIndex('by-song', 'songId');
    },
  });
  return dbInstance;
}

// Song operations
export async function getAllSongs(): Promise<Song[]> {
  const db = await getDB();
  const songs = await db.getAll('songs');
  return songs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getSong(id: number): Promise<Song | undefined> {
  const db = await getDB();
  return db.get('songs', id);
}

export async function createSong(name: string): Promise<number> {
  const db = await getDB();
  const now = Date.now();
  return db.add('songs', { name, createdAt: now, updatedAt: now } as Song);
}

export async function updateSong(song: Song): Promise<void> {
  const db = await getDB();
  await db.put('songs', { ...song, updatedAt: Date.now() });
}

export async function deleteSong(id: number): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(
    ['songs', 'tracks', 'audioBlobs', 'collaborators'],
    'readwrite'
  );

  // Delete associated tracks and audio
  const tracks = await tx.objectStore('tracks').index('by-song').getAll(id);
  for (const track of tracks) {
    if (track.id !== undefined) {
      await tx.objectStore('audioBlobs').delete(track.id);
      await tx.objectStore('tracks').delete(track.id);
    }
  }

  // Delete collaborators
  const collabs = await tx
    .objectStore('collaborators')
    .index('by-song')
    .getAll(id);
  for (const c of collabs) {
    if (c.id !== undefined) {
      await tx.objectStore('collaborators').delete(c.id);
    }
  }

  await tx.objectStore('songs').delete(id);
  await tx.done;
}

// Track operations
export async function getTracksBySong(songId: number): Promise<Track[]> {
  const db = await getDB();
  return db.getAllFromIndex('tracks', 'by-song', songId);
}

export async function createTrack(
  track: Omit<Track, 'id'>
): Promise<number> {
  const db = await getDB();
  const id = await db.add('tracks', track as Track);
  // Update song timestamp
  const song = await db.get('songs', track.songId);
  if (song) await db.put('songs', { ...song, updatedAt: Date.now() });
  return id;
}

export async function updateTrack(track: Track): Promise<void> {
  const db = await getDB();
  await db.put('tracks', track);
  const song = await db.get('songs', track.songId);
  if (song) await db.put('songs', { ...song, updatedAt: Date.now() });
}

export async function deleteTrack(id: number, songId: number): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['tracks', 'audioBlobs', 'songs'], 'readwrite');
  await tx.objectStore('audioBlobs').delete(id);
  await tx.objectStore('tracks').delete(id);
  const song = await tx.objectStore('songs').get(songId);
  if (song) await tx.objectStore('songs').put({ ...song, updatedAt: Date.now() });
  await tx.done;
}

// Audio blob operations
export async function saveAudioBlob(
  trackId: number,
  blob: Blob
): Promise<void> {
  const db = await getDB();
  await db.put('audioBlobs', { trackId, blob });
}

export async function getAudioBlob(
  trackId: number
): Promise<Blob | undefined> {
  const db = await getDB();
  const entry = await db.get('audioBlobs', trackId);
  return entry?.blob;
}

// Collaborator operations
export async function getCollaborators(
  songId: number
): Promise<Collaborator[]> {
  const db = await getDB();
  return db.getAllFromIndex('collaborators', 'by-song', songId);
}

export async function addCollaborator(
  collab: Omit<Collaborator, 'id'>
): Promise<number> {
  const db = await getDB();
  return db.add('collaborators', collab as Collaborator);
}

export async function removeCollaborator(id: number): Promise<void> {
  const db = await getDB();
  await db.delete('collaborators', id);
}
