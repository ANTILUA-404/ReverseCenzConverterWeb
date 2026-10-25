'use strict';

/**
 * Discord OAuth2 (authorization code + PKCE) and signed cookie sessions.
 *
 * Mirrors the reference login exactly:
 *   scope=identify email guilds
 *   response_type=code
 *   client_id=<app>
 *   redirect_uri=<base>/api/auth/callback/discord
 *   code_challenge=<sha256(verifier)>&code_challenge_method=S256
 *   state=<csrf>
 */

const crypto = require('crypto');
const axios = require('axios');

const config = require('../config');
const store = require('./store');

const COOKIE = 'cenz_session';
const STATE_COOKIE = 'cenz_oauth_state';
const PKCE_COOKIE = 'cenz_oauth_pkce';
const NEXT_COOKIE = 'cenz_oauth_next';

/* ------------------------------------------------------------------ cookies */

function parseCookies(header = '') {
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function sign(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

function setCookie(res, name, value, { maxAge = 60 * 60 * 24 * 30, httpOnly = true } = {}) {
  const signed = `${value}.${sign(value)}`;
  const parts = [`${name}=${encodeURIComponent(signed)}`, 'Path=/', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (httpOnly) parts.push('HttpOnly');
  if (config.baseUrl.startsWith('https://')) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function readCookie(req, name) {
  const raw = parseCookies(req.headers.cookie || '')[name];
  if (!raw) return null;
  const idx = raw.lastIndexOf('.');
  if (idx === -1) return null;
  const value = raw.slice(0, idx);
  const mac = raw.slice(idx + 1);
  if (sign(value) !== mac) return null;
  return value;
}

function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; Max-Age=0; SameSite=Lax`);
}

/* -------------------------------------------------------------------- oauth */

function createPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function authorizeUrl(next) {
  const state = crypto.randomBytes(16).toString('hex');
  const { verifier, challenge } = createPkce();

  const params = new URLSearchParams({
    scope: config.discord.scopes.join(' '),
    response_type: 'code',
    client_id: config.discord.clientId,
    redirect_uri: config.discord.redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });

  return { url: `https://discord.com/api/oauth2/authorize?${params}`, state, verifier, next };
}

async function exchangeCode(code, codeVerifier) {
  const body = new URLSearchParams({
    client_id: config.discord.clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.discord.redirectUri,
  });

  if (config.discord.clientSecret) body.set('client_secret', config.discord.clientSecret);
  if (codeVerifier) body.set('code_verifier', codeVerifier);

  const { data } = await axios.post('https://discord.com/api/oauth2/token', body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });
  return data.access_token;
}

async function fetchProfile(accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const { data } = await axios.get('https://discord.com/api/users/@me', { headers, timeout: 15000 });

  let guilds = [];
  if (config.discord.scopes.includes('guilds')) {
    try {
      const res = await axios.get('https://discord.com/api/users/@me/guilds', { headers, timeout: 15000 });
      guilds = Array.isArray(res.data) ? res.data : [];
    } catch {
      /* the guilds scope can be declined — not fatal */
    }
  }

  return {
    id: String(data.id),
    username: data.username,
    global_name: data.global_name || data.username,
    avatar: data.avatar || null,
    email: data.email || null,
    guilds: guilds.map((g) => ({ id: String(g.id), name: g.name, owner: Boolean(g.owner) })),
  };
}

function avatarUrl(user, size = 96) {
  if (!user || !user.avatar) return null;
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=${size}`;
}

/* ---------------------------------------------------------------- middleware */

function isAdmin(user) {
  if (!user) return false;
  return config.adminIds.includes(String(user.id));
}

function currentUser(req) {
  const sid = readCookie(req, COOKIE);
  const session = store.getSession(sid);
  if (!session) return null;
  const user = store.getUser(session.userId);
  if (!user) return null;
  return { ...user, isAdmin: isAdmin(user), plan: store.planOf(user) };
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Discord login required.', code: 'AUTH_REQUIRED' });
  if (user.blocked) return res.status(403).json({ error: 'Account blocked.', code: 'BLOCKED' });
  req.user = user;
  next();
}

/** Page-level guard: redirects to the landing page instead of returning JSON. */
function requirePage(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    const next = encodeURIComponent(req.originalUrl);
    return res.redirect(`/${req.params.locale || 'en'}?login=1&next=${next}`);
  }
  if (user.blocked) return res.status(403).send('Account blocked.');
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only.', code: 'ADMIN_ONLY' });
    next();
  });
}

function login(req, res, profile) {
  const user = store.upsertUser(profile);
  const sid = store.createSession(user.id, { ua: req.headers['user-agent'], ip: req.ip });
  setCookie(res, COOKIE, sid);
  return { ...user, isAdmin: isAdmin(user), plan: store.planOf(user) };
}

function logout(req, res) {
  const sid = readCookie(req, COOKIE);
  store.destroySession(sid);
  clearCookie(res, COOKIE);
}

module.exports = {
  COOKIE,
  STATE_COOKIE,
  PKCE_COOKIE,
  NEXT_COOKIE,
  parseCookies,
  setCookie,
  readCookie,
  clearCookie,
  authorizeUrl,
  exchangeCode,
  fetchProfile,
  avatarUrl,
  isAdmin,
  currentUser,
  requireAuth,
  requirePage,
  requireAdmin,
  login,
  logout,
};
