'use strict';

/**
 * CENZ STUDIO — 1:1 clone backend.
 *
 * Serves the reverse-engineered landing/legal pages plus a fully working
 * pipeline: Discord login, YouTube/SoundCloud extraction, ffmpeg conversion
 * with speed presets, Roblox 7-minute auto-split, Open Cloud upload,
 * moderation tracking and the in-game library push.
 */

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { randomUUID } = require('crypto');

const express = require('express');
const multer = require('multer');
const axios = require('axios');

const config = require('./config');
const store = require('./lib/store');
const auth = require('./lib/auth');
const vault = require('./lib/crypto').createVault(config.keySecret);
const convert = require('./lib/convert');
const roblox = require('./lib/roblox');

const app = express();
const PUBLIC_DIR = path.join(__dirname, 'public');
const OUT_DIR = config.outDir;
const TMP_DIR = config.tmpDir;
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

app.set('trust proxy', 1);
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));
// Canonical locale URLs: /en/ → /en
app.use((req, res, next) => {
  if (/^\/(en|id)\/$/.test(req.path)) return res.redirect(301, req.path.slice(0, -1));
  next();
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: 0, redirect: false }));

const upload = multer({ dest: TMP_DIR, limits: { fileSize: 250 * 1024 * 1024 } });

/* ------------------------------------------------------------------ helpers */

const LOCALES = ['en', 'id'];

function localeFromReq(req) {
  const cookie = auth.readCookie(req, 'cenz_locale');
  if (cookie && LOCALES.includes(cookie)) return cookie;
  const header = String(req.headers['accept-language'] || '');
  if (/\bid\b/i.test(header.split(',')[0] || '')) return 'id';
  return 'en';
}

function slug(value) {
  return String(value || 'audio')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'audio';
}

function planFor(user) {
  return config.plans[store.planOf(user)] || config.plans.free;
}

function quotaLeft(user) {
  const plan = planFor(user);
  if (plan.unlimited) return null;
  const usage = store.usageOf(store.getUser(user.id));
  return Math.max(0, plan.conversionsPerDay - usage.conversions);
}

function bumpUsage(userId) {
  const user = store.getUser(userId);
  if (!user) return;
  const usage = store.usageOf(user);
  usage.conversions += 1;
  store.save();
}

/* --------------------------------------------------------------------- jobs */

const jobs = new Map();
const streams = new Map(); // jobId -> Set<res>

function createJob(user) {
  const job = {
    id: randomUUID(),
    userId: user.id,
    stage: 'queued',
    message: 'Preparing…',
    percent: 0,
    parts: [],
    meta: null,
    error: null,
    createdAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  return job;
}

function setStage(job, stage, message, percent) {
  job.stage = stage;
  job.message = message;
  if (percent !== undefined) job.percent = percent;

  const listeners = streams.get(job.id);
  if (listeners && listeners.size) {
    const payload = JSON.stringify({
      stage: job.stage,
      message: job.message,
      percent: job.percent,
      parts: job.parts,
      meta: job.meta,
      error: job.error,
    });
    for (const res of listeners) {
      try {
        res.write(`data: ${payload}\n\n`);
      } catch {
        /* disconnected */
      }
    }
  }
}

async function runPipeline(job, user, input, options) {
  const workDir = path.join(TMP_DIR, job.id);
  await fsp.mkdir(workDir, { recursive: true });

  try {
    let sourceFile;

    if (input.kind === 'upload') {
      setStage(job, 'reading', 'Reading your file…', 6);
      sourceFile = input.filePath;
      job.meta = {
        title: input.originalName.replace(/\.[^.]+$/, ''),
        artist: '',
        durationSec: 0,
        thumbnail: '',
        platform: 'upload',
      };
    } else {
      setStage(job, 'metadata', 'Reading source metadata…', 4);
      job.meta = await convert.metadata(input.url);

      setStage(job, 'downloading', 'Downloading source audio…', 10);
      sourceFile = await convert.extract(input.url, workDir, (pct, msg) => setStage(job, 'downloading', msg, pct));
      job.meta.platform = /soundcloud/i.test(input.url) ? 'soundcloud' : 'youtube';
    }

    const probe = await convert.probe(sourceFile);
    job.meta.durationSec = job.meta.durationSec || probe.durationSec;
    setStage(job, 'probing', 'Analysing audio…', 55);

    const outputFile = path.join(workDir, `${slug(job.meta.title)}-${job.id.slice(0, 6)}.ogg`);
    setStage(job, 'converting', `Converting at ${options.speed}× …`, 62);

    const converted = await convert.convert(sourceFile, outputFile, {
      speed: options.speed,
      amplify: options.amplify,
      normalize: options.normalize,
    });

    setStage(job, 'splitting', 'Splitting for Roblox…', 82);
    const parts = await convert.split(converted.filePath, workDir, config.roblox.maxAssetSeconds);

    setStage(job, 'storing', 'Saving result…', 94);
    const stored = [];
    for (const part of parts) {
      const fileName = `${slug(job.meta.title)}-${job.id.slice(0, 6)}-p${part.index}.ogg`;
      const dest = path.join(OUT_DIR, fileName);
      await fsp.copyFile(part.filePath, dest);
      stored.push({
        index: part.index,
        fileName,
        url: `/api/file/${encodeURIComponent(fileName)}`,
        durationSec: Math.round(part.durationSec),
        duration: convert.formatDuration(part.durationSec),
        bytes: (await fsp.stat(dest)).size,
      });
    }

    job.parts = stored;
    job.result = {
      title: job.meta.title,
      artist: job.meta.artist,
      thumbnail: job.meta.thumbnail,
      platform: job.meta.platform,
      speed: converted.speed,
      amplify: converted.amplify,
      totalDuration: convert.formatDuration(converted.durationSec),
      parts: stored,
    };

    setStage(job, 'done', 'Conversion complete.', 100);

    store.pushActivity({
      userId: user.id,
      type: 'convert',
      title: job.meta.title,
      platform: job.meta.platform,
      parts: stored.length,
    });

    bumpUsage(user.id);
  } catch (err) {
    console.error('[pipeline]', err);
    job.error = err.message || 'Conversion failed.';
    setStage(job, 'error', job.error, 100);

    store.pushActivity({
      userId: user.id,
      type: 'convert_failed',
      title: input.kind === 'upload' ? input.originalName : input.url,
      error: job.error,
    });
  } finally {
    fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    if (input.kind === 'upload') fsp.rm(input.filePath, { force: true }).catch(() => {});
  }
}

/* --------------------------------------------------------------------- auth */

app.get('/auth/discord', (req, res) => {
  const next = typeof req.query.next === 'string' ? req.query.next : '/dashboard';
  const { url, state, verifier } = auth.authorizeUrl(next);

  auth.setCookie(res, auth.STATE_COOKIE, state, { maxAge: 600 });
  auth.setCookie(res, auth.PKCE_COOKIE, verifier, { maxAge: 600 });
  auth.setCookie(res, auth.NEXT_COOKIE, next, { maxAge: 600 });

  res.redirect(url);
});

async function handleCallback(req, res) {
  const { code, state, error } = req.query;
  const expected = auth.readCookie(req, auth.STATE_COOKIE);
  const verifier = auth.readCookie(req, auth.PKCE_COOKIE);
  const next = auth.readCookie(req, auth.NEXT_COOKIE) || '/dashboard';

  if (error) return res.redirect('/en?auth=cancelled');
  if (!code) return res.redirect('/en?auth=missing_code');
  if (!expected || expected !== state) return res.redirect('/en?auth=state_mismatch');

  try {
    const token = await auth.exchangeCode(String(code), verifier);
    const profile = await auth.fetchProfile(token);
    const user = auth.login(req, res, profile);

    store.pushActivity({ userId: user.id, type: 'login', title: user.global_name });

    auth.clearCookie(res, auth.STATE_COOKIE);
    auth.clearCookie(res, auth.PKCE_COOKIE);
    auth.clearCookie(res, auth.NEXT_COOKIE);

    res.redirect(next.startsWith('/') ? next : '/dashboard');
  } catch (err) {
    console.error('[auth] callback failed:', err.message);
    res.redirect('/en?auth=failed');
  }
}

app.get('/api/auth/callback/discord', handleCallback);
app.get('/auth/discord/callback', handleCallback);

app.post('/auth/dev-login', (req, res) => {
  if (!config.discord.allowDevLogin) {
    return res.status(400).json({ error: 'Dev login is disabled.' });
  }
  const id = String(req.body?.id || '').trim();
  if (!/^\d{5,25}$/.test(id)) return res.status(400).json({ error: 'A numeric Discord ID is required.' });

  const profile = {
    id,
    username: req.body?.name || `user_${id.slice(-4)}`,
    global_name: req.body?.name || `user_${id.slice(-4)}`,
    avatar: null,
    email: null,
    guilds: [],
  };

  const user = auth.login(req, res, profile);
  res.json({ ok: true, user });
});

app.post('/auth/logout', (req, res) => {
  auth.logout(req, res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = auth.currentUser(req);
  if (!user) {
    return res.json({
      authenticated: false,
      devLogin: config.discord.allowDevLogin,
      discordConfigured: Boolean(config.discord.clientSecret),
    });
  }

  const plan = planFor(user);
  const robloxInfo = user.roblox
    ? {
        linked: true,
        masked: vault.mask(vault.decrypt(user.roblox.key)),
        creatorType: user.roblox.creatorType || 'user',
        creatorId: user.roblox.creatorId || '',
        creatorName: user.roblox.creatorName || '',
        keyValid: Boolean(user.roblox.keyValid),
        creatorValid: Boolean(user.roblox.creatorValid),
        linkedAt: user.roblox.linkedAt || null,
      }
    : { linked: false };

  res.json({
    authenticated: true,
    user: {
      id: user.id,
      username: user.username,
      globalName: user.global_name,
      avatarUrl: auth.avatarUrl(user, 128),
      email: user.email,
      isAdmin: user.isAdmin,
      createdAt: user.createdAt,
    },
    plan: {
      id: plan.id,
      label: plan.label,
      priceIdr: plan.priceIdr,
      until: user.planUntil,
      unlimited: plan.unlimited,
      batchSize: plan.batchSize,
      speedControl: plan.speedControl,
    },
    quota: { left: quotaLeft(user), limit: plan.conversionsPerDay },
    roblox: robloxInfo,
    features: store.settings().features,
    scopes: config.scopes,
    devLogin: config.discord.allowDevLogin,
  });
});

/* -------------------------------------------------------------------- pages */

app.get('/', (req, res) => {
  res.redirect(`/${localeFromReq(req)}`);
});

app.get('/:locale(en|id)', (req, res, next) => {
  const file = path.join(PUBLIC_DIR, req.params.locale, 'index.html');
  if (!fs.existsSync(file)) return next();
  auth.setCookie(res, 'cenz_locale', req.params.locale, { maxAge: 60 * 60 * 24 * 365, httpOnly: false });
  res.sendFile(file);
});

app.get('/:locale(en|id)/:page(privacy|terms)', (req, res, next) => {
  const file = path.join(PUBLIC_DIR, req.params.locale, `${req.params.page}.html`);
  if (!fs.existsSync(file)) return next();
  res.sendFile(file);
});

app.get('/dashboard', (req, res) => {
  const user = auth.currentUser(req);
  if (!user) return res.redirect(`/${localeFromReq(req)}?login=1&next=%2Fdashboard`);
  res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
});

app.get('/checkout', (req, res) => {
  const user = auth.currentUser(req);
  const plan = String(req.query.plan || 'free');
  if (!config.plans[plan]) return res.redirect('/dashboard');

  if (!user) {
    return res.redirect(`/auth/discord?next=${encodeURIComponent(`/checkout?plan=${plan}`)}`);
  }
  res.sendFile(path.join(PUBLIC_DIR, 'checkout.html'));
});

/* ------------------------------------------------------------------ convert */

app.post('/api/detect', auth.requireAuth, async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'A valid URL is required.' });

  try {
    const meta = await convert.metadata(url);
    res.json({
      ok: true,
      title: meta.title,
      artist: meta.artist,
      duration: convert.formatDuration(meta.durationSec),
      durationSec: meta.durationSec,
      thumbnail: meta.thumbnail,
      platform: /soundcloud/i.test(url) ? 'soundcloud' : 'youtube',
      estimatedParts: Math.max(1, Math.ceil(meta.durationSec / config.roblox.maxAssetSeconds)),
    });
  } catch (err) {
    res.status(502).json({ error: 'Could not read that link.', detail: err.message });
  }
});

app.post('/api/convert', auth.requireAuth, async (req, res) => {
  if (!store.settings().features.convert) {
    return res.status(503).json({ error: 'Conversion is temporarily disabled.' });
  }

  const left = quotaLeft(req.user);
  if (left !== null && left <= 0) {
    return res.status(402).json({ error: 'Daily free limit reached.', code: 'QUOTA_EXCEEDED' });
  }

  const url = String(req.body?.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'A valid URL is required.' });

  const presetId = String(req.body?.preset || 'default');
  const preset = config.presets[presetId] || config.presets.default;
  const plan = planFor(req.user);

  const options = {
    speed: plan.speedControl ? Number(req.body?.speed) || preset.speed : preset.speed,
    amplify:
      req.body?.amplify === undefined || req.body?.amplify === null
        ? convert.deriveAmplify(plan.speedControl ? Number(req.body?.speed) || preset.speed : preset.speed)
        : Number(req.body.amplify),
    normalize: Boolean(req.body?.normalize),
    preset: preset.id,
  };

  const job = createJob(req.user);
  job.meta = { title: '', artist: '', platform: 'youtube' };
  res.json({ ok: true, jobId: job.id, stream: `/api/jobs/${job.id}/stream` });

  runPipeline(job, req.user, { kind: 'url', url }, options).catch(() => {});
});

app.post('/api/convert-upload', auth.requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });

  const plan = planFor(req.user);
  const maxBytes = plan.maxFileMb * 1024 * 1024;
  if (req.file.size > maxBytes) {
    fsp.rm(req.file.path, { force: true }).catch(() => {});
    return res.status(413).json({ error: `File is larger than ${plan.maxFileMb} MB.` });
  }

  const left = quotaLeft(req.user);
  if (left !== null && left <= 0) {
    fsp.rm(req.file.path, { force: true }).catch(() => {});
    return res.status(402).json({ error: 'Daily free limit reached.', code: 'QUOTA_EXCEEDED' });
  }

  const presetId = String(req.body?.preset || 'default');
  const preset = config.presets[presetId] || config.presets.default;

  const options = {
    speed: plan.speedControl ? Number(req.body?.speed) || preset.speed : preset.speed,
    amplify:
      req.body?.amplify === undefined || req.body?.amplify === null
        ? convert.deriveAmplify(preset.speed)
        : Number(req.body.amplify),
    normalize: Boolean(req.body?.normalize),
    preset: preset.id,
  };

  const job = createJob(req.user);
  job.meta = { title: req.file.originalname, artist: '', platform: 'upload' };
  res.json({ ok: true, jobId: job.id, stream: `/api/jobs/${job.id}/stream` });

  runPipeline(job, req.user, { kind: 'upload', filePath: req.file.path, originalName: req.file.originalname }, options).catch(
    () => {}
  );
});

app.get('/api/jobs/:id', auth.requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.userId !== req.user.id) return res.status(404).json({ error: 'Job not found.' });

  res.json({
    stage: job.stage,
    message: job.message,
    percent: job.percent,
    parts: job.parts,
    meta: job.meta,
    error: job.error,
  });

  if (job.stage === 'done' || job.stage === 'error') {
    setTimeout(() => jobs.delete(job.id), 5 * 60 * 1000);
  }
});

app.get('/api/jobs/:id/stream', auth.requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.userId !== req.user.id) return res.status(404).json({ error: 'Job not found.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(
    `data: ${JSON.stringify({
      stage: job.stage,
      message: job.message,
      percent: job.percent,
      parts: job.parts,
      meta: job.meta,
      error: job.error,
    })}\n\n`
  );

  if (!streams.has(job.id)) streams.set(job.id, new Set());
  streams.get(job.id).add(res);

  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* gone */
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    const set = streams.get(job.id);
    if (set) {
      set.delete(res);
      if (!set.size) streams.delete(job.id);
    }
  });
});

app.get('/api/file/:name', auth.requireAuth, (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(OUT_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'File not found.' });
  res.sendFile(file);
});

/* ------------------------------------------------------------------- roblox */

app.get('/api/roblox', auth.requireAuth, (req, res) => {
  const saved = req.user.roblox;
  if (!saved) return res.json({ linked: false, scopes: config.scopes });
  res.json({
    linked: true,
    masked: vault.mask(vault.decrypt(saved.key)),
    creatorType: saved.creatorType || 'user',
    creatorId: saved.creatorId || '',
    creatorName: saved.creatorName || '',
    keyValid: Boolean(saved.keyValid),
    creatorValid: Boolean(saved.creatorValid),
    linkedAt: saved.linkedAt || null,
    scopes: config.scopes,
  });
});

app.post('/api/roblox/link', auth.requireAuth, async (req, res) => {
  const apiKey = String(req.body?.apiKey || '').trim();
  const creatorType = req.body?.creatorType === 'group' ? 'group' : 'user';
  const creatorId = String(req.body?.creatorId || '').trim();

  if (apiKey.length < 20) return res.status(400).json({ error: 'That API key looks too short.' });
  if (!/^\d{1,25}$/.test(creatorId)) return res.status(400).json({ error: 'Creator ID must be numeric.' });

  const keyCheck = await roblox.validateKey(apiKey);
  if (!keyCheck.valid) return res.status(400).json({ error: keyCheck.message });

  const creatorCheck =
    creatorType === 'group' ? await roblox.validateGroup(creatorId) : await roblox.validateUser(creatorId);
  if (!creatorCheck.valid) return res.status(400).json({ error: creatorCheck.message });

  const record = {
    key: vault.encrypt(apiKey),
    creatorType,
    creatorId,
    creatorName: creatorCheck.name,
    keyValid: true,
    creatorValid: true,
    linkedAt: new Date().toISOString(),
  };

  store.updateUser(req.user.id, { roblox: record });
  store.pushActivity({ userId: req.user.id, type: 'roblox_linked', title: creatorCheck.name });

  res.json({
    ok: true,
    linked: true,
    masked: vault.mask(apiKey),
    creatorType,
    creatorId,
    creatorName: creatorCheck.name,
    scopes: config.scopes,
  });
});

app.post('/api/roblox/unlink', auth.requireAuth, (req, res) => {
  // "Unlinking deletes it" — an actual delete, not a flag.
  store.updateUser(req.user.id, { roblox: null });
  store.pushActivity({ userId: req.user.id, type: 'roblox_unlinked', title: 'key deleted' });
  res.json({ ok: true, linked: false });
});

app.post('/api/roblox/validate-user', auth.requireAuth, async (req, res) => {
  const id = String(req.body?.id || '').trim();
  if (!/^\d{1,25}$/.test(id)) return res.status(400).json({ error: 'Numeric user ID required.' });
  res.json(await roblox.validateUser(id));
});

app.post('/api/roblox/validate-group', auth.requireAuth, async (req, res) => {
  const id = String(req.body?.id || '').trim();
  if (!/^\d{1,25}$/.test(id)) return res.status(400).json({ error: 'Numeric group ID required.' });
  res.json(await roblox.validateGroup(id));
});

function userKey(user) {
  if (!user.roblox || !user.roblox.key) return null;
  return vault.decrypt(user.roblox.key);
}

app.post('/api/roblox/upload', auth.requireAuth, async (req, res) => {
  if (!store.settings().features.upload) {
    return res.status(503).json({ error: 'Uploads are temporarily disabled.' });
  }

  const apiKey = userKey(req.user);
  if (!apiKey) return res.status(400).json({ error: 'Link your Roblox account first.', code: 'ROBLOX_NOT_LINKED' });

  const fileNames = Array.isArray(req.body?.files) ? req.body.files.slice(0, 12) : [];
  if (!fileNames.length) return res.status(400).json({ error: 'No files selected.' });

  const displayName = String(req.body?.displayName || '').slice(0, 50);
  const description = String(req.body?.description || 'Uploaded via CENZ STUDIO').slice(0, 1000);

  const results = [];

  for (const rawName of fileNames) {
    const fileName = path.basename(String(rawName));
    const filePath = path.join(OUT_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      results.push({ fileName, ok: false, error: 'File no longer exists on the server.' });
      continue;
    }

    const buffer = await fsp.readFile(filePath);
    const started = await roblox.uploadAsset({
      apiKey,
      buffer,
      fileName,
      mimeType: 'audio/ogg',
      displayName: displayName || fileName.replace(/\.[^.]+$/, ''),
      description,
      creatorType: req.user.roblox.creatorType || 'user',
      creatorId: req.user.roblox.creatorId,
    });

    if (!started.ok) {
      results.push({ fileName, ok: false, error: started.error });
      continue;
    }

    // Poll the operation until Roblox resolves the asset id.
    let assetId = null;
    let lastError = null;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      const status = await roblox.checkStatus({ apiKey, operationId: started.operationId });
      if (status.asset_id) {
        assetId = status.asset_id;
        break;
      }
      if (status.error) lastError = status.error;
      if (status.done && !status.asset_id) break;
    }

    if (!assetId) {
      results.push({ fileName, ok: false, error: lastError || 'Roblox did not return an asset id in time.' });
      continue;
    }

    const record = store.addAsset(req.user.id, {
      fileName,
      assetId,
      displayName: displayName || fileName,
      moderation: 'pending',
      creatorType: req.user.roblox.creatorType || 'user',
      creatorId: req.user.roblox.creatorId,
      dashboardUrl: `https://create.roblox.com/store/asset/${assetId}`,
    });

    results.push({ fileName, ok: true, assetId, recordId: record.id });
  }

  store.pushActivity({
    userId: req.user.id,
    type: 'upload',
    title: `${results.filter((r) => r.ok).length}/${results.length} uploaded`,
  });

  res.json({ ok: results.every((r) => r.ok), results });
});

app.get('/api/roblox/moderation', auth.requireAuth, async (req, res) => {
  const apiKey = userKey(req.user);
  if (!apiKey) return res.status(400).json({ error: 'Link your Roblox account first.' });

  const assets = store.assetsOf(req.user.id).filter((a) => a.moderation === 'pending').slice(0, 20);
  const updates = [];

  for (const asset of assets) {
    const state = await roblox.moderationState(apiKey, asset.assetId);
    if (state.ok && state.state !== 'pending') {
      store.updateAsset(req.user.id, asset.id, { moderation: state.state, moderatedAt: new Date().toISOString() });
      updates.push({ id: asset.id, assetId: asset.assetId, moderation: state.state });
    }
  }

  res.json({ ok: true, checked: assets.length, updates });
});

app.post('/api/roblox/grant', auth.requireAuth, async (req, res) => {
  const apiKey = userKey(req.user);
  if (!apiKey) return res.status(400).json({ error: 'Link your Roblox account first.' });

  const assetIds = (Array.isArray(req.body?.assetIds) ? req.body.assetIds : []).map(String).filter(Boolean);
  const subjectId = String(req.body?.subjectId || '').trim();
  const subjectType = ['Universe', 'User', 'Group'].includes(req.body?.subjectType) ? req.body.subjectType : 'Universe';

  if (!assetIds.length) return res.status(400).json({ error: 'No asset ids provided.' });
  if (!/^\d{1,25}$/.test(subjectId)) return res.status(400).json({ error: 'Invalid subject id.' });

  res.json(await roblox.grantUse({ apiKey, assetIds, subjectId, subjectType }));
});

app.post('/api/roblox/push-library', auth.requireAuth, async (req, res) => {
  const apiKey = userKey(req.user);
  if (!apiKey) return res.status(400).json({ error: 'Link your Roblox account first.' });

  const universeId = String(req.body?.universeId || '').trim();
  if (!/^\d{1,25}$/.test(universeId)) return res.status(400).json({ error: 'Invalid universe id.' });

  if (!store.settings().features.musicSystem) {
    return res.status(501).json({
      error: 'Sending songs into your game needs the CENZ Music System installed.',
      code: 'MUSIC_SYSTEM_REQUIRED',
    });
  }

  const albumKey = String(req.body?.albumKey || 'cenz_library');
  const tracks = Array.isArray(req.body?.tracks) ? req.body.tracks : [];

  const pushed = await roblox.pushLibrary({ apiKey, universeId, albumKey, payload: { tracks, updatedAt: Date.now() } });
  if (!pushed.ok) return res.status(502).json({ error: pushed.error });

  await roblox.publishMessage({
    apiKey,
    universeId,
    topic: 'cenz_library_updated',
    message: { albumKey, count: tracks.length },
  });

  res.json({ ok: true, pushed: tracks.length });
});

/* ------------------------------------------------------------------ library */

app.get('/api/library', auth.requireAuth, (req, res) => {
  const lib = store.libraryOf(req.user.id);
  res.json({
    albums: lib.albums,
    tracks: lib.tracks,
    assets: store.assetsOf(req.user.id),
    musicSystem: store.settings().features.musicSystem,
  });
});

app.post('/api/library/albums', auth.requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Album name is required.' });
  res.json({ ok: true, album: store.addAlbum(req.user.id, { name, cover: req.body?.cover || null }) });
});

app.patch('/api/library/albums/:id', auth.requireAuth, (req, res) => {
  const album = store.updateAlbum(req.user.id, req.params.id, {
    ...(req.body?.name ? { name: String(req.body.name).slice(0, 60) } : {}),
    ...(req.body?.cover !== undefined ? { cover: req.body.cover } : {}),
  });
  if (!album) return res.status(404).json({ error: 'Album not found.' });
  res.json({ ok: true, album });
});

app.delete('/api/library/albums/:id', auth.requireAuth, (req, res) => {
  const ok = store.removeAlbum(req.user.id, req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
});

app.post('/api/library/tracks', auth.requireAuth, (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 80);
  if (!title) return res.status(400).json({ error: 'Track title is required.' });

  const track = store.addTrack(req.user.id, {
    albumId: req.body?.albumId || null,
    assetId: req.body?.assetId || null,
    title,
    playbackSpeed: req.body?.playbackSpeed,
    parts: Array.isArray(req.body?.parts) ? req.body.parts : [],
  });
  res.json({ ok: true, track });
});

app.patch('/api/library/tracks/:id', auth.requireAuth, (req, res) => {
  const patch = {};
  if (req.body?.title) patch.title = String(req.body.title).slice(0, 80);
  if (req.body?.albumId !== undefined) patch.albumId = req.body.albumId;
  if (req.body?.playbackSpeed !== undefined) patch.playbackSpeed = Number(req.body.playbackSpeed) || 1;

  const track = store.updateTrack(req.user.id, req.params.id, patch);
  if (!track) return res.status(404).json({ error: 'Track not found.' });
  res.json({ ok: true, track });
});

app.delete('/api/library/tracks/:id', auth.requireAuth, (req, res) => {
  const ok = store.removeTrack(req.user.id, req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
});

/* ------------------------------------------------------------------- assets */

app.get('/api/assets', auth.requireAuth, (req, res) => {
  res.json({ assets: store.assetsOf(req.user.id) });
});

app.delete('/api/assets/:id', auth.requireAuth, (req, res) => {
  const ok = store.removeAsset(req.user.id, req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
});

/* ------------------------------------------------------------------ billing */

app.get('/api/plans', (req, res) => {
  res.json({
    plans: Object.values(config.plans),
    midtransConfigured: config.midtrans.configured,
  });
});

app.post('/api/checkout', auth.requireAuth, async (req, res) => {
  const planId = String(req.body?.plan || '');
  const plan = config.plans[planId];
  if (!plan) return res.status(400).json({ error: 'Unknown plan.' });

  if (planId === 'free') {
    return res.json({ ok: true, free: true, message: 'The free plan is active by default.' });
  }

  if (!config.midtrans.configured) {
    const payment = store.addPayment({
      userId: req.user.id,
      planId,
      amountIdr: plan.priceIdr,
      status: 'pending',
      provider: 'manual',
    });
    return res.json({
      ok: true,
      manual: true,
      paymentId: payment.id,
      amountIdr: plan.priceIdr,
      message: 'Midtrans is not configured — the order is queued for manual activation.',
    });
  }

  try {
    const orderId = `CENZ-${Date.now()}-${req.user.id.slice(-4)}`;
    const authHeader = Buffer.from(`${config.midtrans.serverKey}:`).toString('base64');
    const base = config.midtrans.isProduction
      ? 'https://app.midtrans.com/snap/v1/transactions'
      : 'https://app.sandbox.midtrans.com/snap/v1/transactions';

    const { data } = await axios.post(
      base,
      {
        transaction_details: { order_id: orderId, gross_amount: plan.priceIdr },
        customer_details: { first_name: req.user.global_name, email: req.user.email || undefined },
        item_details: [{ id: planId, price: plan.priceIdr, quantity: 1, name: `CENZ ${plan.label.en}` }],
      },
      { headers: { Authorization: `Basic ${authHeader}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    store.addPayment({
      userId: req.user.id,
      planId,
      amountIdr: plan.priceIdr,
      status: 'pending',
      provider: 'midtrans',
      orderId,
      token: data.token,
    });

    res.json({ ok: true, token: data.token, redirectUrl: data.redirect_url, orderId });
  } catch (err) {
    console.error('[checkout]', err.message);
    res.status(502).json({ error: 'Could not start the payment.', detail: err.message });
  }
});

app.post('/api/midtrans/notification', (req, res) => {
  const body = req.body || {};
  const orderId = String(body.order_id || '');
  const status = String(body.transaction_status || '');

  const payment = Object.values(store.db.payments).find((p) => p.orderId === orderId);
  if (!payment) return res.status(404).json({ ok: false });

  const paid = status === 'settlement' || status === 'capture';

  store.updatePayment(payment.id, { status: paid ? 'paid' : status });

  if (paid) {
    const plan = config.plans[payment.planId];
    const user = store.getUser(payment.userId);
    if (plan && user) {
      const base = user.planUntil && new Date(user.planUntil) > new Date() ? new Date(user.planUntil) : new Date();
      base.setDate(base.getDate() + plan.days);
      store.updateUser(user.id, { plan: payment.planId, planUntil: base.toISOString() });
      store.pushActivity({ userId: user.id, type: 'plan_activated', title: plan.label.en });
    }
  }

  res.json({ ok: true });
});

app.get('/api/payments', auth.requireAuth, (req, res) => {
  res.json({ payments: store.paymentsFor(req.user.id) });
});

/* -------------------------------------------------------------------- stats */

app.get('/api/stats', (req, res) => {
  res.json({ ...store.globalStats(), uptime: process.uptime() });
});

app.get('/api/activity', auth.requireAuth, (req, res) => {
  res.json({ activity: store.activityFor(req.user.id) });
});

/* -------------------------------------------------------------------- admin */

app.get('/api/admin/overview', auth.requireAdmin, (req, res) => {
  const users = store.listUsers();
  res.json({
    stats: {
      users: users.length,
      paid: users.filter((u) => store.planOf(u) !== 'free').length,
      blocked: users.filter((u) => u.blocked).length,
      assets: Object.values(store.db.assets).reduce((n, l) => n + l.length, 0),
    },
    users: users.map((u) => ({
      id: u.id,
      name: u.global_name,
      plan: store.planOf(u),
      planUntil: u.planUntil,
      blocked: u.blocked,
      linked: Boolean(u.roblox),
      createdAt: u.createdAt,
    })),
    payments: Object.values(store.db.payments),
    settings: store.settings(),
  });
});

app.post('/api/admin/user', auth.requireAdmin, (req, res) => {
  const id = String(req.body?.id || '');
  const user = store.getUser(id);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const patch = {};
  if (req.body?.plan && config.plans[req.body.plan]) {
    const plan = config.plans[req.body.plan];
    patch.plan = req.body.plan;
    if (plan.days) {
      const until = new Date();
      until.setDate(until.getDate() + plan.days);
      patch.planUntil = until.toISOString();
    } else {
      patch.planUntil = null;
    }
  }
  if (typeof req.body?.blocked === 'boolean') patch.blocked = req.body.blocked;

  store.updateUser(id, patch);
  res.json({ ok: true });
});

app.post('/api/admin/features', auth.requireAdmin, (req, res) => {
  const current = store.settings().features;
  const next = { ...current };
  for (const key of Object.keys(current)) {
    if (typeof req.body?.[key] === 'boolean') next[key] = req.body[key];
  }
  store.updateSettings({ features: next });
  res.json({ ok: true, features: next });
});

app.post('/api/admin/announcement', auth.requireAdmin, (req, res) => {
  store.updateSettings({ announcement: String(req.body?.text || '').slice(0, 300) });
  res.json({ ok: true, announcement: store.settings().announcement });
});

/* ---------------------------------------------------------------------- 404 */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint not found.' });
  res.status(404).sendFile(path.join(PUBLIC_DIR, 'en', 'index.html'));
});

app.listen(config.port, () => {
  console.log(`CENZ STUDIO clone → ${config.baseUrl}`);
  console.log(`  Discord OAuth : ${config.discord.clientSecret ? 'configured' : 'PKCE public client'}`);
  console.log(`  Dev login     : ${config.discord.allowDevLogin ? 'enabled' : 'disabled'}`);
  console.log(`  Midtrans      : ${config.midtrans.configured ? 'configured' : 'not configured'}`);
  console.log(`  Admin ids     : ${config.adminIds.join(', ')}`);
});
