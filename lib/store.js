'use strict';

/**
 * Tiny JSON store. Everything lives in data/db.json and is written atomically
 * on every mutation (debounced through a microtask so bursts collapse).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('../config');

const DB_FILE = path.join(config.dataDir, 'db.json');

const DEFAULTS = {
  users: {},
  sessions: {},
  assets: {},
  albums: {},
  payments: {},
  activity: [],
  planRequests: [],
  settings: {
    announcement: '',
    features: {
      convert: true,
      upload: true,
      library: true,
      checkout: true,
      musicSystem: false,
    },
  },
};

let db = null;
let writeScheduled = false;

function ensureDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function load() {
  if (db) return db;
  ensureDir();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    db = { ...structuredClone(DEFAULTS), ...JSON.parse(raw) };
    db.settings = { ...DEFAULTS.settings, ...(db.settings || {}) };
    db.settings.features = { ...DEFAULTS.settings.features, ...(db.settings.features || {}) };
  } catch {
    db = structuredClone(DEFAULTS);
  }
  return db;
}

function save() {
  if (writeScheduled) return;
  writeScheduled = true;
  queueMicrotask(() => {
    writeScheduled = false;
    try {
      ensureDir();
      const tmp = `${DB_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, DB_FILE);
    } catch (err) {
      console.error('[store] write failed:', err.message);
    }
  });
}

/* -------------------------------------------------------------------- users */

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function planOf(user) {
  if (!user) return 'free';
  const plan = user.plan && config.plans[user.plan] ? user.plan : 'free';
  if (plan === 'free') return 'free';
  if (user.planUntil && new Date(user.planUntil).getTime() < Date.now()) return 'free';
  return plan;
}

function usageOf(user) {
  if (!user) return { day: dayKey(), conversions: 0 };
  if (!user.usage || user.usage.day !== dayKey()) {
    user.usage = { day: dayKey(), conversions: 0 };
  }
  return user.usage;
}

function upsertUser(profile) {
  load();
  const id = String(profile.id);
  const existing = db.users[id];

  const user = {
    id,
    username: profile.username || existing?.username || 'creator',
    global_name: profile.global_name || existing?.global_name || profile.username || 'creator',
    avatar: profile.avatar ?? existing?.avatar ?? null,
    email: profile.email ?? existing?.email ?? null,
    guilds: profile.guilds ?? existing?.guilds ?? [],
    createdAt: existing?.createdAt || new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    plan: existing?.plan || 'free',
    planUntil: existing?.planUntil || null,
    blocked: existing?.blocked || false,
    usage: existing?.usage || { day: dayKey(), conversions: 0 },
    roblox: existing?.roblox || null,
    library: existing?.library || { albums: [], tracks: [] },
  };

  db.users[id] = user;
  save();
  return user;
}

function getUser(id) {
  load();
  return db.users[String(id)] || null;
}

function updateUser(id, patch) {
  load();
  const user = db.users[String(id)];
  if (!user) return null;
  Object.assign(user, patch);
  save();
  return user;
}

function listUsers() {
  load();
  return Object.values(db.users);
}

function countUsers() {
  return listUsers().length;
}

/* ----------------------------------------------------------------- sessions */

function createSession(userId, meta = {}) {
  load();
  const sid = crypto.randomBytes(32).toString('base64url');
  db.sessions[sid] = {
    userId: String(userId),
    createdAt: new Date().toISOString(),
    ua: meta.ua || '',
    ip: meta.ip || '',
  };
  save();
  return sid;
}

function getSession(sid) {
  load();
  return sid ? db.sessions[sid] || null : null;
}

function destroySession(sid) {
  load();
  if (!sid) return;
  delete db.sessions[sid];
  save();
}

function destroyUserSessions(userId) {
  load();
  let removed = 0;
  for (const [sid, s] of Object.entries(db.sessions)) {
    if (s.userId === String(userId)) {
      delete db.sessions[sid];
      removed += 1;
    }
  }
  if (removed) save();
  return removed;
}

/* ------------------------------------------------------------------- assets */

function assetsOf(userId) {
  load();
  const key = String(userId);
  if (!db.assets[key]) db.assets[key] = [];
  return db.assets[key];
}

function addAsset(userId, asset) {
  const list = assetsOf(userId);
  const record = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...asset,
  };
  list.unshift(record);
  if (list.length > 500) list.length = 500;
  save();
  return record;
}

function updateAsset(userId, assetId, patch) {
  const list = assetsOf(userId);
  const asset = list.find((a) => a.id === assetId);
  if (!asset) return null;
  Object.assign(asset, patch);
  save();
  return asset;
}

function removeAsset(userId, assetId) {
  const list = assetsOf(userId);
  const idx = list.findIndex((a) => a.id === assetId);
  if (idx === -1) return false;
  list.splice(idx, 1);
  save();
  return true;
}

/* ------------------------------------------------------------------- albums */

function libraryOf(userId) {
  load();
  const user = db.users[String(userId)];
  if (!user) return { albums: [], tracks: [] };
  if (!user.library) user.library = { albums: [], tracks: [] };
  return user.library;
}

function addAlbum(userId, album) {
  const lib = libraryOf(userId);
  const record = {
    id: crypto.randomUUID(),
    name: album.name || 'Untitled album',
    cover: album.cover || null,
    createdAt: new Date().toISOString(),
  };
  lib.albums.push(record);
  save();
  return record;
}

function updateAlbum(userId, albumId, patch) {
  const lib = libraryOf(userId);
  const album = lib.albums.find((a) => a.id === albumId);
  if (!album) return null;
  Object.assign(album, patch);
  save();
  return album;
}

function removeAlbum(userId, albumId) {
  const lib = libraryOf(userId);
  const idx = lib.albums.findIndex((a) => a.id === albumId);
  if (idx === -1) return false;
  lib.albums.splice(idx, 1);
  lib.tracks = lib.tracks.filter((t) => t.albumId !== albumId);
  save();
  return true;
}

function addTrack(userId, track) {
  const lib = libraryOf(userId);
  const record = {
    id: crypto.randomUUID(),
    albumId: track.albumId || null,
    assetId: track.assetId || null,
    title: track.title || 'Untitled',
    playbackSpeed: Number(track.playbackSpeed) || 1,
    parts: track.parts || [],
    createdAt: new Date().toISOString(),
  };
  lib.tracks.push(record);
  save();
  return record;
}

function updateTrack(userId, trackId, patch) {
  const lib = libraryOf(userId);
  const track = lib.tracks.find((t) => t.id === trackId);
  if (!track) return null;
  Object.assign(track, patch);
  save();
  return track;
}

function removeTrack(userId, trackId) {
  const lib = libraryOf(userId);
  const idx = lib.tracks.findIndex((t) => t.id === trackId);
  if (idx === -1) return false;
  lib.tracks.splice(idx, 1);
  save();
  return true;
}

/* ---------------------------------------------------------------- activity */

function pushActivity(entry) {
  load();
  db.activity.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), ...entry });
  if (db.activity.length > 500) db.activity.length = 500;
  save();
}

function activityFor(userId, limit = 25) {
  load();
  return db.activity.filter((a) => a.userId === String(userId)).slice(0, limit);
}

/* ---------------------------------------------------------------- payments */

function addPayment(payment) {
  load();
  const id = crypto.randomUUID();
  db.payments[id] = { id, createdAt: new Date().toISOString(), ...payment };
  save();
  return db.payments[id];
}

function updatePayment(id, patch) {
  load();
  const p = db.payments[id];
  if (!p) return null;
  Object.assign(p, patch);
  save();
  return p;
}

function paymentsFor(userId) {
  load();
  return Object.values(db.payments).filter((p) => p.userId === String(userId));
}

/* ---------------------------------------------------------------- settings */

function settings() {
  return load().settings;
}

function updateSettings(patch) {
  load();
  Object.assign(db.settings, patch);
  save();
  return db.settings;
}

/* -------------------------------------------------------------------- stats */

function globalStats() {
  load();
  const users = Object.values(db.users);
  const paid = users.filter((u) => planOf(u) !== 'free').length;
  const totalAssets = Object.values(db.assets).reduce((n, list) => n + list.length, 0);
  return {
    users: users.length,
    paid,
    assets: totalAssets,
    conversions: db.activity.filter((a) => a.type === 'convert').length,
  };
}

module.exports = {
  load,
  save,
  dayKey,
  planOf,
  usageOf,
  upsertUser,
  getUser,
  updateUser,
  listUsers,
  countUsers,
  createSession,
  getSession,
  destroySession,
  destroyUserSessions,
  assetsOf,
  addAsset,
  updateAsset,
  removeAsset,
  libraryOf,
  addAlbum,
  updateAlbum,
  removeAlbum,
  addTrack,
  updateTrack,
  removeTrack,
  pushActivity,
  activityFor,
  addPayment,
  updatePayment,
  paymentsFor,
  settings,
  updateSettings,
  globalStats,
  get db() {
    return load();
  },
};
