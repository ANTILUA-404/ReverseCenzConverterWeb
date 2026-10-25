/* CENZ STUDIO workspace — vanilla client for the cloned pipeline. */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ state */

  const state = {
    me: null,
    view: 'convert',
    preset: 'default',
    mode: 'url',
    job: null,
    jobStream: null,
    library: { albums: [], tracks: [], assets: [], musicSystem: false },
    plans: [],
    admin: null,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(message, kind) {
    const stack = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast${kind ? ` is-${kind}` : ''}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
      ...options,
      body:
        options.body instanceof FormData
          ? options.body
          : options.body
          ? JSON.stringify(options.body)
          : undefined,
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function fmtIdr(n) {
    return `Rp ${Number(n || 0).toLocaleString('id-ID')}`;
  }

  function bytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  /* -------------------------------------------------------------- bootstrap */

  async function boot() {
    try {
      const me = await api('/api/auth/me');
      if (!me.authenticated) {
        location.replace('/en?login=1&next=%2Fdashboard');
        return;
      }
      state.me = me;
      paintUser();
    } catch {
      location.replace('/en?login=1&next=%2Fdashboard');
      return;
    }

    bindChrome();
    window.addEventListener('hashchange', route);
    route();
  }

  function paintUser() {
    const me = state.me;
    const name = me.user.globalName || me.user.username;

    $('#user-name').textContent = name;
    const chip = $('#user-chip');
    chip.innerHTML = me.user.avatarUrl
      ? `<img src="${esc(me.user.avatarUrl)}" alt="" /><span>${esc(name)}</span>`
      : `<span class="avatar-fallback">${esc(name.slice(0, 1).toUpperCase())}</span><span>${esc(name)}</span>`;

    const quota = me.quota;
    $('#quota-text').textContent = quota.left === null ? 'Unlimited' : `${quota.left} / ${quota.limit}`;
    const pct = quota.left === null ? 100 : Math.min(100, ((quota.limit - quota.left) / quota.limit) * 100);
    $('#quota-bar').style.width = `${pct}%`;

    if (me.user.isAdmin) $('#admin-link').hidden = false;
    if (me.roblox && me.roblox.linked) $('#roblox-badge').hidden = false;
  }

  function bindChrome() {
    $('#logout-btn').addEventListener('click', async () => {
      await api('/auth/logout', { method: 'POST' });
      location.href = '/en';
    });

    const menu = $('#menu-btn');
    if (window.matchMedia('(max-width: 900px)').matches) menu.style.display = '';
    menu.addEventListener('click', () => $('#sidebar').classList.toggle('is-open'));

    $$('.side-link').forEach((a) => {
      a.addEventListener('click', () => {
        $('#sidebar').classList.remove('is-open');
      });
    });
  }

  /* ----------------------------------------------------------------- router */

  const VIEW_META = {
    convert: ['Convert', 'YouTube or SoundCloud in, Roblox asset out'],
    library: ['Library', 'Albums and tracks for your game'],
    assets: ['Assets', 'Uploads and moderation status'],
    roblox: ['Roblox', 'Link your Open Cloud key'],
    plan: ['Plan & billing', 'Usage, limits and upgrades'],
    admin: ['Admin', 'Accounts, payments and feature flags'],
  };

  function route() {
    const hash = location.hash.replace(/^#\/?/, '') || 'convert';
    const view = VIEW_META[hash] ? hash : 'convert';
    state.view = view;

    const [title, sub] = VIEW_META[view];
    $('#page-title').textContent = title;
    $('#page-sub').textContent = sub;

    $$('.side-link').forEach((a) => a.classList.toggle('is-active', a.dataset.view === view));

    const content = $('#content');
    content.innerHTML = '<div class="page"><div class="skeleton" style="width: 180px"></div><div class="skeleton" style="width: 100%; height: 120px"></div></div>';

    const render = {
      convert: renderConvert,
      library: renderLibrary,
      assets: renderAssets,
      roblox: renderRoblox,
      plan: renderPlan,
      admin: renderAdmin,
    }[view];

    Promise.resolve(render()).catch((err) => {
      content.innerHTML = `<div class="card"><div class="card-body"><p class="hint">${esc(err.message)}</p></div></div>`;
    });
  }

  /* ---------------------------------------------------------------- convert */

  function presetsHtml() {
    const list = [
      ['slow', 'Slow', '0.7×'],
      ['default', 'Default', '1.0×'],
      ['fast', 'Fast', '1.5×'],
      ['faster', 'Faster', '2.3×'],
      ['ultra', 'Ultra', '3.0×'],
    ];
    return list
      .map(
        ([id, label, rate]) => `<button class="preset${state.preset === id ? ' is-active' : ''}" type="button" data-preset="${id}">
          <strong>${label}</strong><small>${rate}</small>
        </button>`
      )
      .join('');
  }

  async function renderConvert() {
    const me = state.me;
    const quotaLeft = me.quota.left;
    const outOfQuota = quotaLeft !== null && quotaLeft <= 0;

    $('#content').innerHTML = `
      <div class="page">
        <div class="page-head">
          <div>
            <h2>From a link to a Roblox asset</h2>
            <p>Paste a YouTube or SoundCloud link, or drop an audio file. We convert, split and upload.</p>
          </div>
          <div class="row">
            <span class="badge">${esc(me.plan.label.en)}</span>
            <span class="badge${outOfQuota ? ' badge-danger' : ' badge-success'}">
              ${quotaLeft === null ? 'Unlimited' : `${quotaLeft} left today`}
            </span>
          </div>
        </div>

        ${
          outOfQuota
            ? `<div class="card"><div class="card-body row">
                 <div>
                   <strong style="font-size:13px">Daily free limit reached</strong>
                   <p class="hint" style="margin:4px 0 0">Free accounts get 2 conversions every 24 hours. Upgrade for unlimited.</p>
                 </div>
                 <a class="btn row-end" href="#/plan">See plans</a>
               </div></div>`
            : ''
        }

        <div class="card">
          <div class="card-head">
            <span class="eyebrow">Source</span>
            <h3>Input</h3>
            <div class="row row-end">
              <div class="tabs">
                <button class="tab${state.mode === 'url' ? ' is-active' : ''}" type="button" data-mode="url">Paste link</button>
                <button class="tab${state.mode === 'file' ? ' is-active' : ''}" type="button" data-mode="file">Drop file</button>
              </div>
            </div>
          </div>
          <div class="card-body" style="display:grid;gap:14px">
            <div id="source-url" ${state.mode === 'url' ? '' : 'hidden'}>
              <div class="row" style="gap:8px">
                <input class="input" id="url-input" placeholder="https://youtu.be/… or https://soundcloud.com/…" style="flex:1;min-width:220px" />
                <button class="btn btn-outline" type="button" id="detect-btn">Check</button>
              </div>
              <div id="detect-result" class="hint" style="margin-top:8px"></div>
            </div>

            <div id="source-file" ${state.mode === 'file' ? '' : 'hidden'}>
              <label class="dropzone" id="dropzone" for="file-input">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="M7 10l5-5 5 5"></path><path d="M12 5v12"></path></svg>
                <strong>Drop an audio file or click to browse</strong>
                <small>MP3, WAV, FLAC, M4A, OGG — up to ${me.plan.id === 'free' ? 200 : 200} MB</small>
                <input type="file" id="file-input" accept="audio/*" hidden />
              </label>
              <div id="file-name" class="hint" style="margin-top:8px"></div>
            </div>

            <div class="field">
              <label>Speed preset</label>
              <div class="preset-grid" id="preset-grid">${presetsHtml()}</div>
              <span class="hint" id="amplify-hint"></span>
            </div>

            <div class="row">
              <label class="row" style="gap:7px;font-size:12.5px;color:var(--muted)">
                <input type="checkbox" id="normalize" /> Normalise loudness
              </label>
              <button class="btn row-end" type="button" id="convert-btn" ${outOfQuota ? 'disabled' : ''}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg>
                Convert
              </button>
            </div>
          </div>
        </div>

        <div class="card" id="job-card" hidden>
          <div class="card-head">
            <span class="eyebrow">Job</span>
            <h3 id="job-title">Working…</h3>
            <span class="badge row-end" id="job-badge">running</span>
          </div>
          <div class="card-body" style="display:grid;gap:14px">
            <div class="progress">
              <div class="progress-head"><strong id="job-message">Starting…</strong><span id="job-percent">0%</span></div>
              <div class="progress-track"><div class="progress-fill" id="job-fill"></div></div>
            </div>
            <ul class="stage-list" id="stage-list"></ul>
            <div id="parts-wrap" hidden>
              <div class="divider" style="margin-bottom:14px"></div>
              <div class="row" style="margin-bottom:10px">
                <span class="eyebrow">Output parts</span>
                <button class="btn btn-sm row-end" type="button" id="upload-parts-btn">Upload all to Roblox</button>
              </div>
              <div id="parts-list"></div>
            </div>
          </div>
        </div>
      </div>`;

    const urlInput = $('#url-input');
    const fileInput = $('#file-input');

    $$('[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.mode = btn.dataset.mode;
        $$('[data-mode]').forEach((b) => b.classList.toggle('is-active', b === btn));
        $('#source-url').hidden = state.mode !== 'url';
        $('#source-file').hidden = state.mode !== 'file';
      });
    });

    $$('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.preset = btn.dataset.preset;
        $$('[data-preset]').forEach((b) => b.classList.toggle('is-active', b === btn));
        updateAmplifyHint();
      });
    });

    function updateAmplifyHint() {
      const speed = { slow: 0.7, default: 1, fast: 1.5, faster: 2.3, ultra: 3 }[state.preset] || 1;
      const db = speed === 1 ? 0 : Math.round(-20 * Math.log10(speed) * 10) / 10;
      $('#amplify-hint').textContent = `Amplification derived automatically: ${db > 0 ? '+' : ''}${db} dB`;
    }
    updateAmplifyHint();

    $('#detect-btn').addEventListener('click', async () => {
      const url = urlInput.value.trim();
      if (!url) return;
      const out = $('#detect-result');
      out.textContent = 'Reading…';
      try {
        const meta = await api('/api/detect', { method: 'POST', body: { url } });
        out.innerHTML = `<strong style="color:var(--fg)">${esc(meta.title)}</strong> · ${esc(meta.artist || 'unknown')} · ${esc(
          meta.duration
        )} · ${meta.estimatedParts} part(s)`;
      } catch (err) {
        out.textContent = err.message;
      }
    });

    $('#dropzone').addEventListener('dragover', (e) => {
      e.preventDefault();
      $('#dropzone').classList.add('is-drag');
    });
    $('#dropzone').addEventListener('dragleave', () => $('#dropzone').classList.remove('is-drag'));
    $('#dropzone').addEventListener('drop', (e) => {
      e.preventDefault();
      $('#dropzone').classList.remove('is-drag');
      if (e.dataTransfer.files.length) {
        fileInput.files = e.dataTransfer.files;
        $('#file-name').textContent = e.dataTransfer.files[0].name;
      }
    });
    fileInput.addEventListener('change', () => {
      $('#file-name').textContent = fileInput.files[0] ? fileInput.files[0].name : '';
    });

    $('#convert-btn').addEventListener('click', startConvert);

    async function startConvert() {
      const btn = $('#convert-btn');
      btn.disabled = true;

      try {
        let jobId;

        if (state.mode === 'url') {
          const url = urlInput.value.trim();
          if (!url) throw new Error('Paste a link first.');
          const res = await api('/api/convert', { method: 'POST', body: { url, preset: state.preset } });
          jobId = res.jobId;
        } else {
          if (!fileInput.files.length) throw new Error('Choose a file first.');
          const form = new FormData();
          form.append('file', fileInput.files[0]);
          form.append('preset', state.preset);
          const res = await api('/api/convert-upload', { method: 'POST', body: form });
          jobId = res.jobId;
        }

        watchJob(jobId);
      } catch (err) {
        btn.disabled = false;
        toast(err.message, 'error');
      }
    }

    function watchJob(jobId) {
      const card = $('#job-card');
      card.hidden = false;

      const stages = ['metadata', 'downloading', 'converting', 'splitting', 'done'];
      const labels = {
        metadata: 'Reading metadata',
        downloading: 'Downloading source',
        converting: 'Converting audio',
        splitting: 'Splitting for Roblox',
        done: 'Done',
      };
      $('#stage-list').innerHTML = stages
        .map((s) => `<li class="stage-item" data-stage="${s}"><span class="stage-dot"></span>${labels[s]}</li>`)
        .join('');

      let source;
      try {
        source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/stream`);
      } catch {
        source = null;
      }

      const onData = (job) => {
        $('#job-message').textContent = job.message || 'Working…';
        $('#job-percent').textContent = `${job.percent || 0}%`;
        $('#job-fill').style.width = `${job.percent || 0}%`;
        if (job.meta && job.meta.title) $('#job-title').textContent = job.meta.title;

        const order = ['metadata', 'downloading', 'converting', 'splitting', 'done'];
        const idx = order.indexOf(job.stage);
        $$('#stage-list .stage-item').forEach((li) => {
          const i = order.indexOf(li.dataset.stage);
          li.classList.toggle('is-done', idx > i || job.stage === 'done');
          li.classList.toggle('is-active', i === idx && job.stage !== 'done');
        });

        if (job.stage === 'done') {
          $('#job-badge').textContent = 'complete';
          $('#job-badge').className = 'badge badge-success row-end';
          $('#convert-btn').disabled = false;
          paintParts(job.parts || []);
          if (source) source.close();
          state.me.quota.left = Math.max(0, (state.me.quota.left || 0) - 1);
          if (state.me.quota.left !== null) {
            $('#quota-text').textContent = `${state.me.quota.left} / ${state.me.quota.limit}`;
          }
        }

        if (job.stage === 'error') {
          $('#job-badge').textContent = 'failed';
          $('#job-badge').className = 'badge badge-danger row-end';
          $('#job-message').textContent = job.error || 'Conversion failed.';
          $('#convert-btn').disabled = false;
          if (source) source.close();
        }
      };

      if (source) {
        source.onmessage = (e) => {
          try {
            onData(JSON.parse(e.data));
          } catch {
            /* ignore */
          }
        };
        source.onerror = () => {
          source.close();
          poll();
        };
      } else {
        poll();
      }

      async function poll() {
        for (let i = 0; i < 400; i += 1) {
          await new Promise((r) => setTimeout(r, 1500));
          try {
            const job = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
            onData(job);
            if (job.stage === 'done' || job.stage === 'error') return;
          } catch {
            return;
          }
        }
      }
    }

    function paintParts(parts) {
      if (!parts.length) return;
      $('#parts-wrap').hidden = false;
      $('#parts-list').innerHTML = `
        <table class="table">
          <thead><tr><th>Part</th><th>Length</th><th>Size</th><th></th></tr></thead>
          <tbody>
            ${parts
              .map(
                (p) => `<tr>
                  <td><strong>Part ${p.index}</strong></td>
                  <td class="mono">${esc(p.duration)}</td>
                  <td class="mono">${bytes(p.bytes)}</td>
                  <td style="text-align:right"><a class="btn btn-outline btn-sm" href="${esc(p.url)}" download>Download</a></td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>`;

      $('#upload-parts-btn').addEventListener('click', async () => {
        if (!state.me.roblox || !state.me.roblox.linked) {
          toast('Link your Roblox account first.', 'error');
          location.hash = '#/roblox';
          return;
        }
        const btn = $('#upload-parts-btn');
        btn.disabled = true;
        btn.textContent = 'Uploading…';
        try {
          const res = await api('/api/roblox/upload', {
            method: 'POST',
            body: { files: parts.map((p) => p.fileName) },
          });
          const ok = res.results.filter((r) => r.ok).length;
          toast(`${ok}/${res.results.length} uploaded to Roblox.`, ok === res.results.length ? 'success' : 'error');
          btn.textContent = 'Uploaded';
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false;
          btn.textContent = 'Upload all to Roblox';
        }
      });
    }
  }

  /* ---------------------------------------------------------------- library */

  async function renderLibrary() {
    const data = await api('/api/library');
    state.library = data;

    const albums = data.albums || [];
    const tracks = data.tracks || [];

    $('#content').innerHTML = `
      <div class="page">
        <div class="page-head">
          <div>
            <h2>Your game library</h2>
            <p>Albums and tracks that live inside your Roblox map.</p>
          </div>
          <div class="row">
            <button class="btn btn-outline" type="button" id="new-album">New album</button>
          </div>
        </div>

        ${
          data.musicSystem
            ? ''
            : `<div class="card"><div class="card-body row">
                 <div>
                   <strong style="font-size:13px">CENZ Music System not detected</strong>
                   <p class="hint" style="margin:4px 0 0">Editing the in-game library needs the music system installed in your map.</p>
                 </div>
                 <a class="btn btn-outline row-end" href="https://discord.gg/wmEXsuMtDM" target="_blank" rel="noopener">Ask in Discord</a>
               </div></div>`
        }

        <div class="card">
          <div class="card-head"><span class="eyebrow">Albums</span><h3>${albums.length} album(s)</h3></div>
          <div class="card-body">
            ${
              albums.length
                ? `<div class="album-grid">${albums
                    .map(
                      (a) => `<div class="album" data-album="${esc(a.id)}">
                        <div class="album-cover">${a.cover ? `<img src="${esc(a.cover)}" alt="" />` : esc(a.name.slice(0, 2).toUpperCase())}</div>
                        <div class="album-name">${esc(a.name)}</div>
                        <div class="album-count">${tracks.filter((t) => t.albumId === a.id).length} tracks</div>
                      </div>`
                    )
                    .join('')}</div>`
                : '<div class="empty">No albums yet. Create one to group your tracks.</div>'
            }
          </div>
        </div>

        <div class="card">
          <div class="card-head"><span class="eyebrow">Tracks</span><h3>${tracks.length} track(s)</h3></div>
          <div class="card-body" style="padding:0">
            ${
              tracks.length
                ? `<table class="table">
                     <thead><tr><th>Title</th><th>Album</th><th>Playback</th><th>Parts</th><th></th></tr></thead>
                     <tbody>${tracks
                       .map((t) => {
                         const album = albums.find((a) => a.id === t.albumId);
                         return `<tr>
                           <td><strong>${esc(t.title)}</strong></td>
                           <td>${album ? esc(album.name) : '—'}</td>
                           <td class="mono">${Number(t.playbackSpeed).toFixed(2)}×</td>
                           <td class="mono">${(t.parts || []).length || 1}</td>
                           <td style="text-align:right"><button class="btn btn-ghost btn-sm" data-del-track="${esc(t.id)}">Delete</button></td>
                         </tr>`;
                       })
                       .join('')}</tbody>
                   </table>`
                : '<div class="table-empty">No tracks yet. Convert a song and add it here.</div>'
            }
          </div>
        </div>
      </div>`;

    $('#new-album').addEventListener('click', async () => {
      const name = prompt('Album name');
      if (!name) return;
      await api('/api/library/albums', { method: 'POST', body: { name } });
      renderLibrary();
    });

    $$('[data-del-track]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api(`/api/library/tracks/${btn.dataset.delTrack}`, { method: 'DELETE' });
        renderLibrary();
      });
    });
  }

  /* ----------------------------------------------------------------- assets */

  async function renderAssets() {
    const data = await api('/api/assets');
    const assets = data.assets || [];

    const pending = assets.filter((a) => a.moderation === 'pending').length;
    const badge = $('#pending-badge');
    if (pending) {
      badge.hidden = false;
      badge.textContent = String(pending);
    } else {
      badge.hidden = true;
    }

    $('#content').innerHTML = `
      <div class="page">
        <div class="page-head">
          <div>
            <h2>Uploaded assets</h2>
            <p>Every asset you pushed to Roblox, with its live moderation state.</p>
          </div>
          <div class="row">
            <button class="btn btn-outline" type="button" id="refresh-mod">Refresh moderation</button>
          </div>
        </div>

        <div class="grid-3">
          <div class="stat"><span>Total</span><strong>${assets.length}</strong><small>uploaded assets</small></div>
          <div class="stat"><span>Accepted</span><strong>${assets.filter((a) => a.moderation === 'accepted').length}</strong><small>cleared moderation</small></div>
          <div class="stat"><span>Pending</span><strong>${pending}</strong><small>waiting on Roblox</small></div>
        </div>

        <div class="card">
          <div class="card-head"><span class="eyebrow">Assets</span><h3>Moderation</h3></div>
          <div class="card-body" style="padding:0">
            ${
              assets.length
                ? `<table class="table">
                     <thead><tr><th>Name</th><th>Asset ID</th><th>Status</th><th>Uploaded</th><th></th></tr></thead>
                     <tbody>${assets
                       .map((a) => {
                         const cls =
                           a.moderation === 'accepted'
                             ? 'badge badge-success'
                             : a.moderation === 'rejected'
                             ? 'badge badge-danger'
                             : 'badge badge-warn';
                         return `<tr>
                           <td><strong>${esc(a.displayName || a.fileName)}</strong></td>
                           <td class="mono">${esc(a.assetId)}</td>
                           <td><span class="${cls}">${esc(a.moderation)}</span></td>
                           <td class="mono">${new Date(a.createdAt).toLocaleString()}</td>
                           <td style="text-align:right">
                             <a class="btn btn-ghost btn-sm" href="${esc(a.dashboardUrl)}" target="_blank" rel="noopener">Open</a>
                           </td>
                         </tr>`;
                       })
                       .join('')}</tbody>
                   </table>`
                : '<div class="table-empty">No assets yet. Convert a song and upload it.</div>'
            }
          </div>
        </div>
      </div>`;

    $('#refresh-mod').addEventListener('click', async () => {
      try {
        const res = await api('/api/roblox/moderation', { method: 'POST' });
        toast(`Checked ${res.checked} asset(s), ${res.updates.length} updated.`, 'success');
        renderAssets();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  /* ----------------------------------------------------------------- roblox */

  async function renderRoblox() {
    const info = await api('/api/roblox');

    $('#content').innerHTML = `
      <div class="page">
        <div class="page-head">
          <div>
            <h2>Roblox account</h2>
            <p>Your Open Cloud key is stored with AES-256-GCM and never returned by any endpoint.</p>
          </div>
          <div class="row">
            <span class="badge${info.linked ? ' badge-success' : ''}">${info.linked ? 'linked' : 'not linked'}</span>
          </div>
        </div>

        ${
          info.linked
            ? `<div class="card">
                 <div class="card-head"><span class="eyebrow">Connection</span><h3>${esc(info.creatorName || 'Linked')}</h3></div>
                 <div class="card-body" style="display:grid;gap:14px">
                   <div class="grid-3">
                     <div class="stat"><span>API key</span><strong style="font-size:15px" class="mono">${esc(info.masked)}</strong><small>masked</small></div>
                     <div class="stat"><span>Creator</span><strong style="font-size:15px">${esc(info.creatorType)}</strong><small>${esc(info.creatorId)}</small></div>
                     <div class="stat"><span>Linked</span><strong style="font-size:15px">${new Date(info.linkedAt).toLocaleDateString()}</strong><small>${info.keyValid ? 'key valid' : 'key unverified'}</small></div>
                   </div>
                   <div class="row">
                     <button class="btn btn-danger" type="button" id="unlink-btn">Unlink and delete key</button>
                     <span class="hint">Removes the stored key from the database outright.</span>
                   </div>
                 </div>
               </div>`
            : ''
        }

        <div class="card">
          <div class="card-head"><span class="eyebrow">Open Cloud</span><h3>${info.linked ? 'Replace key' : 'Link your key'}</h3></div>
          <div class="card-body" style="display:grid;gap:14px">
            <div class="field">
              <label>API key</label>
              <input class="input" id="key-input" type="password" placeholder="paste your Open Cloud API key" autocomplete="off" />
            </div>
            <div class="row" style="gap:12px;align-items:flex-end">
              <div class="field" style="flex:0 0 140px">
                <label>Creator type</label>
                <select class="select" id="creator-type">
                  <option value="user">User</option>
                  <option value="group">Group</option>
                </select>
              </div>
              <div class="field" style="flex:1;min-width:180px">
                <label>Creator ID</label>
                <input class="input" id="creator-id" placeholder="e.g. 7412093" inputmode="numeric" />
              </div>
              <button class="btn btn-outline" type="button" id="validate-btn">Validate</button>
            </div>
            <div id="roblox-msg" class="hint"></div>

            <div class="divider"></div>

            <div>
              <span class="eyebrow">Scopes requested</span>
              <div class="row" style="margin-top:8px">
                ${(info.scopes || [])
                  .map((s) => `<span class="badge">${esc(s)}</span>`)
                  .join('')}
                <span class="badge badge-danger">delete — never</span>
              </div>
            </div>

            <div class="row">
              <button class="btn" type="button" id="link-btn">${info.linked ? 'Replace key' : 'Link account'}</button>
            </div>
          </div>
        </div>
      </div>`;

    const msg = $('#roblox-msg');

    $('#validate-btn').addEventListener('click', async () => {
      const apiKey = $('#key-input').value.trim();
      const type = $('#creator-type').value;
      const id = $('#creator-id').value.trim();
      msg.textContent = 'Validating…';
      try {
        const keyRes = await api('/api/roblox/link', { method: 'POST', body: { apiKey, creatorType: type, creatorId: id } });
        msg.innerHTML = `<span style="color:var(--success)">Key accepted — ${esc(keyRes.creatorName)}</span>`;
        state.me.roblox = { linked: true };
        $('#roblox-badge').hidden = false;
        setTimeout(renderRoblox, 700);
      } catch (err) {
        msg.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
      }
    });

    $('#link-btn').addEventListener('click', async () => {
      const apiKey = $('#key-input').value.trim();
      const creatorType = $('#creator-type').value;
      const creatorId = $('#creator-id').value.trim();
      msg.textContent = 'Linking…';
      try {
        const res = await api('/api/roblox/link', { method: 'POST', body: { apiKey, creatorType, creatorId } });
        toast(`Linked to ${res.creatorName}.`, 'success');
        $('#roblox-badge').hidden = false;
        renderRoblox();
      } catch (err) {
        msg.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
      }
    });

    const unlink = $('#unlink-btn');
    if (unlink) {
      unlink.addEventListener('click', async () => {
        if (!confirm('Delete the stored API key? This cannot be undone.')) return;
        await api('/api/roblox/unlink', { method: 'POST' });
        toast('Key deleted.', 'success');
        $('#roblox-badge').hidden = true;
        renderRoblox();
      });
    }
  }

  /* ------------------------------------------------------------------- plan */

  async function renderPlan() {
    const data = await api('/api/plans');
    state.plans = data.plans;

    const current = state.me.plan;
    const payments = await api('/api/payments').catch(() => ({ payments: [] }));

    const features = (plan) => {
      const list = [];
      list.push(plan.unlimited ? 'Unlimited audio conversions' : `${plan.conversionsPerDay} conversions per 24 hours`);
      list.push('Auto upload to Roblox');
      list.push(plan.speedControl ? 'Speed control' : 'Default speed');
      list.push('Moderation status tracking');
      if (plan.prioritySupport) list.push('Priority support');
      if (plan.batchSize > 1) list.push(`Convert up to ${plan.batchSize} songs at once`);
      if (plan.albumOfAccepted) list.push('Album of accepted songs');
      return list;
    };

    $('#content').innerHTML = `
      <div class="page">
        <div class="page-head">
          <div>
            <h2>Plan &amp; billing</h2>
            <p>Every plan covers converting, bypassing, uploading and moderation tracking.</p>
          </div>
          <div class="row">
            <span class="badge badge-success">${esc(current.label.en)}${current.until ? ` · until ${new Date(current.until).toLocaleDateString()}` : ''}</span>
          </div>
        </div>

        <div class="plan-grid">
          ${data.plans
            .map((plan) => {
              const isCurrent = plan.id === current.id;
              return `<div class="plan${isCurrent ? ' is-current' : ''}">
                <div class="plan-name">${esc(plan.label.en)}${isCurrent ? '<span class="badge badge-success">current</span>' : ''}</div>
                <div class="plan-price">${plan.priceIdr === 0 ? 'Rp 0' : fmtIdr(plan.priceIdr)}
                  <small>${plan.days ? `/ ${plan.days} days` : 'forever'}</small></div>
                <ul class="plan-features">
                  ${features(plan)
                    .map(
                      (f) => `<li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"></path></svg>${esc(f)}</li>`
                    )
                    .join('')}
                </ul>
                <button class="btn${plan.id === '30d' ? '' : ' btn-outline'}" type="button" data-buy="${esc(plan.id)}" ${
                isCurrent || plan.id === 'free' ? 'disabled' : ''
              }>${isCurrent ? 'Active' : plan.id === 'free' ? 'Default' : 'Buy now'}</button>
              </div>`;
            })
            .join('')}
        </div>

        <div class="card">
          <div class="card-head"><span class="eyebrow">History</span><h3>Payments</h3></div>
          <div class="card-body" style="padding:0">
            ${
              payments.payments.length
                ? `<table class="table">
                     <thead><tr><th>Plan</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead>
                     <tbody>${payments.payments
                       .map(
                         (p) => `<tr>
                           <td><strong>${esc(p.planId)}</strong></td>
                           <td class="mono">${fmtIdr(p.amountIdr)}</td>
                           <td><span class="badge${p.status === 'paid' ? ' badge-success' : ' badge-warn'}">${esc(p.status)}</span></td>
                           <td class="mono">${new Date(p.createdAt).toLocaleString()}</td>
                         </tr>`
                       )
                       .join('')}</tbody>
                   </table>`
                : '<div class="table-empty">No payments yet.</div>'
            }
          </div>
        </div>
      </div>`;

    $$('[data-buy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const plan = btn.dataset.buy;
        btn.disabled = true;
        try {
          const res = await api('/api/checkout', { method: 'POST', body: { plan } });
          if (res.redirectUrl) {
            location.href = res.redirectUrl;
            return;
          }
          toast(res.message || 'Order created.', 'success');
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false;
        }
      });
    });
  }

  /* ------------------------------------------------------------------ admin */

  async function renderAdmin() {
    const data = await api('/api/admin/overview');
    state.admin = data;

    $('#content').innerHTML = `
      <div class="page">
        <div class="page-head">
          <div><h2>Admin</h2><p>Accounts, payments and global feature flags.</p></div>
        </div>

        <div class="grid-3">
          <div class="stat"><span>Users</span><strong>${data.stats.users}</strong><small>registered</small></div>
          <div class="stat"><span>Paid</span><strong>${data.stats.paid}</strong><small>active plans</small></div>
          <div class="stat"><span>Assets</span><strong>${data.stats.assets}</strong><small>uploaded</small></div>
        </div>

        <div class="card">
          <div class="card-head"><span class="eyebrow">Accounts</span><h3>${data.users.length} user(s)</h3></div>
          <div class="card-body" style="padding:0;overflow-x:auto">
            <table class="table">
              <thead><tr><th>User</th><th>ID</th><th>Plan</th><th>Linked</th><th>Status</th><th></th></tr></thead>
              <tbody>${data.users
                .map(
                  (u) => `<tr>
                    <td><strong>${esc(u.name)}</strong></td>
                    <td class="mono">${esc(u.id)}</td>
                    <td><span class="badge">${esc(u.plan)}</span></td>
                    <td>${u.linked ? '✓' : '—'}</td>
                    <td>${u.blocked ? '<span class="badge badge-danger">blocked</span>' : '<span class="badge badge-success">active</span>'}</td>
                    <td style="text-align:right;white-space:nowrap">
                      <button class="btn btn-ghost btn-sm" data-grant="${esc(u.id)}" data-plan="30d">+30d</button>
                      <button class="btn btn-ghost btn-sm" data-block="${esc(u.id)}" data-blocked="${u.blocked ? '1' : '0'}">${u.blocked ? 'Unblock' : 'Block'}</button>
                    </td>
                  </tr>`
                )
                .join('')}</tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><span class="eyebrow">Features</span><h3>Global flags</h3></div>
          <div class="card-body" style="display:grid;gap:10px">
            ${Object.entries(data.settings.features)
              .map(
                ([key, value]) => `<label class="row" style="gap:8px;font-size:12.5px;color:var(--muted)">
                  <input type="checkbox" data-feature="${esc(key)}" ${value ? 'checked' : ''} /> ${esc(key)}
                </label>`
              )
              .join('')}
          </div>
        </div>
      </div>`;

    $$('[data-grant]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api('/api/admin/user', { method: 'POST', body: { id: btn.dataset.grant, plan: btn.dataset.plan } });
        toast('Plan updated.', 'success');
        renderAdmin();
      });
    });

    $$('[data-block]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const blocked = btn.dataset.blocked === '1';
        await api('/api/admin/user', { method: 'POST', body: { id: btn.dataset.block, blocked: !blocked } });
        renderAdmin();
      });
    });

    $$('[data-feature]').forEach((input) => {
      input.addEventListener('change', async () => {
        await api('/api/admin/features', { method: 'POST', body: { [input.dataset.feature]: input.checked } });
        toast('Feature updated.', 'success');
      });
    });
  }

  /* ------------------------------------------------------------------- boot */

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
