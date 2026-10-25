'use strict';

/**
 * Roblox Open Cloud client.
 *
 *   Assets API      https://apis.roblox.com/assets/v1
 *   Users / Groups  https://users.roblox.com, https://groups.roblox.com
 *   DataStore API   https://apis.roblox.com/datastores/v1  (music library push)
 *   Messaging API   https://apis.roblox.com/messaging-service/v1
 */

const axios = require('axios');

const ASSETS = 'https://apis.roblox.com/assets/v1';
const USERS = 'https://users.roblox.com/v1';
const GROUPS = 'https://groups.roblox.com/v1';
const DATASTORES = 'https://apis.roblox.com/datastores/v1';
const MESSAGING = 'https://apis.roblox.com/messaging-service/v1';

function authHeaders(apiKey) {
  return { 'x-api-key': apiKey };
}

function robloxError(err) {
  const res = err.response;
  if (!res) return err.message || 'Could not reach Roblox.';
  const body = res.data || {};
  const detail =
    (Array.isArray(body.errors) && body.errors[0] && body.errors[0].message) ||
    body.message ||
    body.error;
  if (res.status === 401) return 'Roblox rejected the API key (401). Check the key and its scopes.';
  if (res.status === 403) return `Roblox denied access (403). ${detail || 'The key lacks permission for this resource.'}`;
  if (res.status === 429) return 'Roblox rate-limited the request (429). Try again shortly.';
  return detail || `Roblox returned HTTP ${res.status}.`;
}

/* ------------------------------------------------------------------ validate */

async function validateKey(apiKey) {
  if (!apiKey || String(apiKey).length < 20) {
    return { valid: false, message: 'That API key looks too short.' };
  }
  try {
    const probe = await axios.get(`${ASSETS}/assets/1`, {
      headers: authHeaders(apiKey),
      timeout: 15000,
      validateStatus: () => true,
    });

    if (probe.status === 401) return { valid: false, message: 'Roblox rejected this API key (401).' };
    if (probe.status === 403) {
      return { valid: true, scopes: [], message: 'Key accepted, but it has no asset:read scope yet.' };
    }
    return { valid: true, scopes: ['asset:read'], message: 'API key is valid.' };
  } catch (err) {
    return { valid: false, message: robloxError(err) };
  }
}

async function validateUser(userId) {
  try {
    const { data } = await axios.get(`${USERS}/users/${encodeURIComponent(userId)}`, { timeout: 15000 });
    return { valid: true, id: String(data.id), name: data.name, displayName: data.displayName };
  } catch (err) {
    if (err.response && err.response.status === 404) return { valid: false, message: 'User ID not found.' };
    return { valid: false, message: robloxError(err) };
  }
}

async function validateGroup(groupId) {
  try {
    const { data } = await axios.get(`${GROUPS}/groups/${encodeURIComponent(groupId)}`, { timeout: 15000 });
    return { valid: true, id: String(data.id), name: data.name };
  } catch (err) {
    if (err.response && err.response.status === 404) return { valid: false, message: 'Group ID not found.' };
    return { valid: false, message: robloxError(err) };
  }
}

/* ------------------------------------------------------------------- upload */

function creationContext(creatorType, creatorId) {
  return creatorType === 'group'
    ? { creator: { groupId: String(creatorId) } }
    : { creator: { userId: String(creatorId) } };
}

async function uploadAsset({ apiKey, buffer, fileName, mimeType, displayName, description, creatorType, creatorId }) {
  const request = {
    assetType: 'Audio',
    displayName: String(displayName || fileName).slice(0, 50),
    description: String(description || 'Uploaded via CENZ STUDIO').slice(0, 1000),
    creationContext: creationContext(creatorType, creatorId),
  };

  const form = new FormData();
  form.append('request', JSON.stringify(request));
  form.append('fileContent', new Blob([buffer], { type: mimeType || 'audio/ogg' }), fileName);

  try {
    const { data } = await axios.post(`${ASSETS}/assets`, form, {
      headers: { ...authHeaders(apiKey), 'Content-Type': 'multipart/form-data' },
      timeout: 180000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    return { ok: true, operationId: data.operationId || String(data.path || '').split('/').pop(), raw: data };
  } catch (err) {
    return { ok: false, error: robloxError(err) };
  }
}

async function getOperation(apiKey, operationId) {
  try {
    const { data } = await axios.get(`${ASSETS}/operations/${encodeURIComponent(operationId)}`, {
      headers: authHeaders(apiKey),
      timeout: 20000,
    });
    const assetId = data.response && data.response.path ? String(data.response.path).split('/').pop() : null;
    return { ok: true, done: Boolean(data.done), assetId, error: data.error || null };
  } catch (err) {
    return { ok: false, error: robloxError(err) };
  }
}

/**
 * Moderation state for an asset.
 * Roblox reports `moderationResult.moderationState`: Approved | Rejected | Reviewing.
 */
async function moderationState(apiKey, assetId) {
  try {
    const { data } = await axios.get(`${ASSETS}/assets/${encodeURIComponent(assetId)}`, {
      headers: authHeaders(apiKey),
      timeout: 20000,
      validateStatus: () => true,
    });

    const state = String((data.moderationResult && data.moderationResult.moderationState) || '').toLowerCase();
    const map = {
      approved: 'accepted',
      rejected: 'rejected',
      reviewing: 'pending',
      pending: 'pending',
    };

    return {
      ok: true,
      state: map[state] || 'pending',
      raw: state || 'unknown',
      displayName: data.displayName || null,
      assetType: data.assetType || null,
    };
  } catch (err) {
    return { ok: false, state: 'pending', error: robloxError(err) };
  }
}

async function checkStatus({ apiKey, operationId, assetId }) {
  if (operationId) {
    const op = await getOperation(apiKey, operationId);
    if (!op.ok) return { done: false, success: false, error: op.error };
    return {
      done: op.done,
      success: op.done ? !op.error : true,
      asset_id: op.assetId,
      error: op.error,
      dashboard_url: op.assetId ? `https://create.roblox.com/store/asset/${op.assetId}` : null,
    };
  }

  if (assetId) {
    return {
      done: true,
      success: true,
      asset_id: String(assetId),
      dashboard_url: `https://create.roblox.com/store/asset/${assetId}`,
    };
  }

  return { done: false, success: true, error: 'No operation id or asset id.' };
}

/* --------------------------------------------------------------- permissions */

async function grantUse({ apiKey, assetIds, subjectId, subjectType }) {
  const requests = [{ action: 'Use', subjectType, subjectId: String(subjectId) }];
  const failures = [];
  let succeeded = 0;

  for (const assetId of assetIds) {
    try {
      await axios.patch(
        `${ASSETS}/assets/${encodeURIComponent(assetId)}/permissions`,
        { requests },
        {
          headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
          timeout: 30000,
        }
      );
      succeeded += 1;
    } catch (err) {
      failures.push({ assetId: String(assetId), error: robloxError(err) });
    }
  }

  return {
    success: failures.length === 0,
    requestedCount: assetIds.length,
    succeededCount: succeeded,
    failedCount: failures.length,
    failures: failures.slice(0, 100),
  };
}

/* ------------------------------------------------------- datastore / library */

/**
 * Push the album payload into the game's DataStore. This is the "send it into
 * your map" step — it needs the CENZ Music System on the game side to read it.
 */
async function pushLibrary({ apiKey, universeId, albumKey, payload }) {
  const url = `${DATASTORES}/universes/${encodeURIComponent(universeId)}/standard-libraries/${encodeURIComponent(
    albumKey
  )}/entries`;
  try {
    await axios.post(
      url,
      { value: JSON.stringify(payload) },
      {
        headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: robloxError(err) };
  }
}

async function publishMessage({ apiKey, universeId, topic, message }) {
  const url = `${MESSAGING}/universes/${encodeURIComponent(universeId)}/topics/${encodeURIComponent(topic)}`;
  try {
    await axios.post(
      url,
      { message: JSON.stringify(message) },
      {
        headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
        timeout: 20000,
      }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: robloxError(err) };
  }
}

module.exports = {
  validateKey,
  validateUser,
  validateGroup,
  uploadAsset,
  getOperation,
  moderationState,
  checkStatus,
  grantUse,
  pushLibrary,
  publishMessage,
  robloxError,
};
