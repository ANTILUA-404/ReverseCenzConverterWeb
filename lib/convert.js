'use strict';

/**
 * Audio pipeline: ffmpeg/ffprobe wrappers.
 *
 * Everything the UI exposes is applied here so the produced file is genuinely
 * playable: speed preset, derived amplification, loudness normalisation and the
 * Roblox 7-minute auto-split.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

function resolveBinary(envKey, binName, installerModule) {
  const candidates = [];
  if (process.env[envKey]) candidates.push(process.env[envKey]);
  candidates.push(path.join(__dirname, '..', 'bin', binName));
  try {
    candidates.push(require(installerModule).path);
  } catch {
    /* optional */
  }

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).size > 1024 * 1024) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return binName.replace(/\.exe$/i, '');
}

const FFMPEG = resolveBinary('FFMPEG_PATH', 'ffmpeg.exe', '@ffmpeg-installer/ffmpeg');
const FFPROBE = resolveBinary('FFPROBE_PATH', 'ffprobe.exe', '@ffprobe-installer/ffprobe');

function run(bin, args, { timeout = 10 * 60 * 1000, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timer = null;

    if (timeout) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${path.basename(bin)} timed out`));
      }, timeout);
    }

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      if (onStderr) onStderr(chunk);
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(bin)} exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/* ------------------------------------------------------------------- probe */

async function probe(file) {
  const { stdout } = await run(
    FFPROBE,
    [
      '-v', 'error',
      '-show_entries', 'format=duration,bit_rate,format_name:stream=codec_name,channels,sample_rate',
      '-of', 'json',
      file,
    ],
    { timeout: 30000 }
  );

  const data = JSON.parse(stdout || '{}');
  const stream = (data.streams || [])[0] || {};
  const format = data.format || {};

  return {
    durationSec: Number.parseFloat(format.duration) || 0,
    bitrate: Number.parseInt(format.bit_rate, 10) || 0,
    formatName: format.format_name || '',
    codec: stream.codec_name || '',
    channels: stream.channels || 0,
    sampleRate: Number.parseInt(stream.sample_rate, 10) || 0,
  };
}

/* ---------------------------------------------------------------- amplitude */

/**
 * "Amplification is derived for you" — a speed change alters perceived
 * loudness, so we compensate with a fixed dB offset instead of asking the user.
 */
function deriveAmplify(speed) {
  const s = Math.min(3, Math.max(0.5, Number(speed) || 1));
  if (Math.abs(s - 1) < 0.001) return 0;
  const db = -20 * Math.log10(s);
  return Math.round(db * 10) / 10;
}

/* ------------------------------------------------------------------ convert */

/**
 * @param {string} input
 * @param {string} output
 * @param {{speed?:number, amplify?:number, normalize?:boolean, format?:string}} options
 */
async function convert(input, output, options = {}) {
  const speed = Math.min(3, Math.max(0.5, Number(options.speed) || 1));
  const amplify =
    options.amplify === undefined || options.amplify === null
      ? deriveAmplify(speed)
      : Math.min(20, Math.max(-30, Number(options.amplify)));

  const filters = [];
  if (Math.abs(speed - 1) > 0.001) filters.push(`atempo=${speed.toFixed(4)}`);
  if (Math.abs(amplify) > 0.01) filters.push(`volume=${amplify}dB`);
  if (options.normalize) filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');

  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input];
  if (filters.length) args.push('-af', filters.join(','));
  args.push('-vn', '-map_metadata', '-1');

  // Roblox ingests OGG/Vorbis most reliably.
  args.push('-c:a', 'libvorbis', '-qscale:a', '6', '-ar', '44100');
  args.push(output);

  await run(FFMPEG, args, { timeout: 15 * 60 * 1000 });

  const stat = fs.statSync(output);
  const info = await probe(output);
  return { filePath: output, bytes: stat.size, durationSec: info.durationSec, speed, amplify };
}

/* -------------------------------------------------------------------- split */

/**
 * Auto-Split for Roblox: cut into <= maxSeconds parts on packet boundaries.
 * @returns {Promise<{index:number, filePath:string, durationSec:number}[]>}
 */
async function split(input, outDir, maxSeconds = 7 * 60) {
  const info = await probe(input);
  if (info.durationSec <= maxSeconds + 1) {
    return [{ index: 1, filePath: input, durationSec: info.durationSec }];
  }

  const base = path.basename(input, path.extname(input));
  const pattern = path.join(outDir, `${base}-part%03d.ogg`);

  await run(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', input,
      '-f', 'segment',
      '-segment_time', String(maxSeconds),
      '-reset_timestamps', '1',
      '-c', 'copy',
      pattern,
    ],
    { timeout: 15 * 60 * 1000 }
  );

  const files = fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith(`${base}-part`) && f.endsWith('.ogg'))
    .sort();

  const parts = [];
  for (let i = 0; i < files.length; i += 1) {
    const filePath = path.join(outDir, files[i]);
    const partInfo = await probe(filePath);
    parts.push({ index: i + 1, filePath, durationSec: partInfo.durationSec });
  }
  return parts;
}

/* ------------------------------------------------------------------ extract */

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

async function extract(url, outDir, onProgress) {
  const template = path.join(outDir, 'source.%(ext)s');

  if (onProgress) onProgress(10, 'Reading source metadata…');

  // yt-dlp shells out to ffmpeg for post-processing; point it at ours so it
  // works even when ffmpeg is not on PATH.
  const ffmpegLocation = FFMPEG.includes(path.sep) ? path.dirname(FFMPEG) : null;

  const args = [
    '--no-warnings',
    '--no-playlist',
    '--extract-audio',
    '--audio-format', 'best',
    '--audio-quality', '0',
    '--output', template,
    '--print', 'after_move:filepath',
  ];
  if (ffmpegLocation) args.push('--ffmpeg-location', ffmpegLocation);
  args.push(url);

  await run(YTDLP, args, {
      timeout: 8 * 60 * 1000,
      onStderr: (chunk) => {
        const m = chunk.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
        if (m && onProgress) onProgress(10 + Number(m[1]) * 0.5, 'Downloading source audio…');
      },
    }
  );

  const files = fs.readdirSync(outDir).filter((f) => f.startsWith('source.'));
  if (!files.length) throw new Error('Source audio could not be downloaded.');
  return path.join(outDir, files[0]);
}

async function metadata(url) {
  try {
    const { stdout } = await run(
      YTDLP,
      ['--no-warnings', '--no-playlist', '--print', '%(title)s\t%(uploader)s\t%(duration)s\t%(thumbnail)s', url],
      { timeout: 45000 }
    );
    const [title, uploader, duration, thumbnail] = stdout.trim().split('\t');
    return {
      title: title || '',
      artist: uploader || '',
      durationSec: Number.parseFloat(duration) || 0,
      thumbnail: thumbnail || '',
    };
  } catch {
    return { title: '', artist: '', durationSec: 0, thumbnail: '' };
  }
}

function availableFormats() {
  return ['ogg', 'mp3', 'wav', 'flac', 'm4a'];
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

module.exports = {
  FFMPEG,
  FFPROBE,
  YTDLP,
  probe,
  deriveAmplify,
  convert,
  split,
  extract,
  metadata,
  availableFormats,
  formatDuration,
};
