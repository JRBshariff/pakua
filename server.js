process.env.YOUTUBE_DL_SKIP_PYTHON_CHECK = '1';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { create: createYoutubeDl } = require('youtube-dl-exec');

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_PATH = process.env.BASE_PATH || '/pakuwavideo';

const YTDLP_PATH = '/usr/local/bin/yt-dlp';
const YOUTUBE_COOKIES_FILE =
  process.env.YOUTUBE_COOKIES_FILE || '/etc/secrets/youtube-cookies.txt';

const youtubedl = createYoutubeDl(YTDLP_PATH);

const PUBLIC_DIR = path.join(__dirname, 'public');
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));
app.use(BASE_PATH, express.static(PUBLIC_DIR));
app.use('/downloads', express.static(DOWNLOAD_DIR));
app.use(`${BASE_PATH}/downloads`, express.static(DOWNLOAD_DIR));

function buildAppUrl(relativePath = '') {
  const clean = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  return `${BASE_PATH}${clean}`;
}

function detectPlatform(url = '') {
  const u = url.toLowerCase();

  if (u.includes('tiktok.com')) return 'tiktok';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('facebook.com') || u.includes('fb.watch')) return 'facebook';

  return 'unknown';
}

function isTikTokDirectCdnUrl(url = '') {
  return /https?:\/\/v\d+-webapp-prime\.tiktok\.com\/video\//i.test(url);
}

function getReferer(platform, originalUrl) {
  if (platform === 'youtube') return 'https://www.youtube.com/';
  if (platform === 'tiktok') return 'https://www.tiktok.com/';
  if (platform === 'instagram') return 'https://www.instagram.com/';
  if (platform === 'facebook') return 'https://www.facebook.com/';
  return originalUrl;
}

function buildYtdlpOptions(url, platform) {
  const opts = {
    noWarnings: true,
    noPlaylist: true,
    noConfig: true,
    noCheckCertificates: true,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    referer: getReferer(platform, url)
  };

  if (platform === 'youtube' && fs.existsSync(YOUTUBE_COOKIES_FILE)) {
    opts.cookies = YOUTUBE_COOKIES_FILE;
  }

  return opts;
}

function makeInfoOptions(url, platform) {
  return {
    ...buildYtdlpOptions(url, platform),
    dumpSingleJson: true,
    skipDownload: true
  };
}

function chooseBestFormat(info) {
  if (!info || !Array.isArray(info.formats)) return null;

  const formats = info.formats.filter(f => f && f.url);
  if (!formats.length) return null;

  const muxed = formats
    .filter(
      f =>
        f.vcodec &&
        f.vcodec !== 'none' &&
        f.acodec &&
        f.acodec !== 'none'
    )
    .sort((a, b) => {
      const heightDiff = (b.height || 0) - (a.height || 0);
      if (heightDiff !== 0) return heightDiff;
      return (b.tbr || 0) - (a.tbr || 0);
    });

  if (muxed.length > 0) {
    return muxed[0];
  }

  const audioOnly = formats
    .filter(
      f =>
        (!f.vcodec || f.vcodec === 'none') &&
        f.acodec &&
        f.acodec !== 'none'
    )
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));

  const videoOnly = formats
    .filter(
      f =>
        f.vcodec &&
        f.vcodec !== 'none' &&
        (!f.acodec || f.acodec === 'none')
    )
    .sort((a, b) => {
      const heightDiff = (b.height || 0) - (a.height || 0);
      if (heightDiff !== 0) return heightDiff;
      return (b.tbr || 0) - (a.tbr || 0);
    });

  if (videoOnly.length > 0) {
    return videoOnly[0];
  }

  if (audioOnly.length > 0) {
    return audioOnly[0];
  }

  return formats.sort((a, b) => {
    const heightDiff = (b.height || 0) - (a.height || 0);
    if (heightDiff !== 0) return heightDiff;
    return (b.tbr || 0) - (a.tbr || 0);
  })[0];
}

function sanitizeFormats(info) {
  if (!info || !Array.isArray(info.formats)) return [];

  return info.formats
    .filter(f => f && f.url)
    .map(f => ({
      format_id: f.format_id || null,
      ext: f.ext || null,
      width: f.width || null,
      height: f.height || null,
      vcodec: f.vcodec || null,
      acodec: f.acodec || null,
      format_note: f.format_note || null,
      protocol: f.protocol || null,
      tbr: f.tbr || null,
      abr: f.abr || null
    }))
    .sort((a, b) => {
      const heightDiff = (b.height || 0) - (a.height || 0);
      if (heightDiff !== 0) return heightDiff;
      return (b.tbr || 0) - (a.tbr || 0);
    });
}

async function checkBinary() {
  if (!fs.existsSync(YTDLP_BIN)) {
    throw new Error(`yt-dlp binary haipo kwenye path: ${YTDLP_BIN}`);
  }

  try {
    fs.accessSync(YTDLP_BIN, fs.constants.X_OK);
  } catch {
    throw new Error(`yt-dlp binary haina execute permission: ${YTDLP_BIN}`);
  }

  const { stdout, stderr } = await execFileAsync(YTDLP_BIN, ['--version'], {
    timeout: 15000
  });

  return {
    ok: true,
    version: (stdout || stderr || '').trim()
  };
}

async function getVideoInfo(url, platform) {
  const info = await youtubedl(url, makeInfoOptions(url, platform));

  if (!info || typeof info !== 'object') {
    throw new Error('yt-dlp hakurudisha metadata object');
  }

  return info;
}

async function downloadTikTokToFile(pageUrl) {
  const fileId = crypto.randomBytes(8).toString('hex');
  const outputTemplate = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);

  await youtubedl(pageUrl, {
    ...buildYtdlpOptions(pageUrl, 'tiktok'),
    output: outputTemplate
  });

  const files = fs.readdirSync(DOWNLOAD_DIR).filter(name => name.startsWith(`${fileId}.`));

  if (!files.length) {
    throw new Error('Imeshindikana kuhifadhi video ya TikTok kwenye server');
  }

  return buildAppUrl(`/downloads/${files[0]}`);
}

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get(BASE_PATH, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get(`${BASE_PATH}/`, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

async function healthHandler(req, res) {
  try {
    const bin = await checkBinary();
    return res.json({
      status: 'ok',
      base_path: BASE_PATH,
      yt_dlp_bin: YTDLP_BIN,
      binary: bin,
      youtube_cookies_exists: fs.existsSync(YOUTUBE_COOKIES_FILE)
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message,
      yt_dlp_bin: YTDLP_BIN
    });
  }
}

app.get('/api/health', healthHandler);
app.get(`${BASE_PATH}/api/health`, healthHandler);

async function handleDownloadRequest(req, res) {
  const { url } = req.body;
  let { platform } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({
      status: 'error',
      message: 'Tafadhali ingiza link ya video'
    });
  }

  platform = platform || detectPlatform(url);

  if (platform === 'unknown') {
    return res.status(400).json({
      status: 'error',
      message: 'Platform haijatambulika. Tumia YouTube, TikTok, Instagram, au Facebook link sahihi.'
    });
  }

  if (platform === 'tiktok' && isTikTokDirectCdnUrl(url)) {
    return res.status(400).json({
      status: 'error',
      message: 'Tumia TikTok page URL ya kawaida, si direct CDN URL.'
    });
  }

  if (platform === 'youtube' && !fs.existsSync(YOUTUBE_COOKIES_FILE)) {
    return res.status(500).json({
      status: 'error',
      message: 'YouTube cookies file haipo kwenye server'
    });
  }

  try {
    await checkBinary();

    const info = await getVideoInfo(url, platform);

    if (platform === 'tiktok') {
      const localFileUrl = await downloadTikTokToFile(url);

      return res.json({
        status: 'success',
        title: info.title || 'TikTok Video',
        thumbnail: info.thumbnail || '',
        platform,
        file_url: localFileUrl,
        note: 'Video imehifadhiwa kwenye server na iko tayari kupakuliwa.'
      });
    }

    const best = chooseBestFormat(info);
    const downloadUrl = best?.url || info.url || null;

    if (!downloadUrl) {
      return res.status(422).json({
        status: 'error',
        message: 'Hakuna media URL iliyopatikana kwa video hii',
        debug: {
          title: info.title || null,
          formats_count: Array.isArray(info.formats) ? info.formats.length : 0
        }
      });
    }

    const encodedMediaUrl = Buffer.from(downloadUrl, 'utf8').toString('base64');
    const streamUrl = buildAppUrl(
      `/api/stream?u=${encodeURIComponent(encodedMediaUrl)}&platform=${encodeURIComponent(platform)}`
    );

    return res.json({
      status: 'success',
      title: info.title || 'Video',
      thumbnail: info.thumbnail || '',
      platform,
      stream_url: streamUrl,
      direct_url: downloadUrl,
      file_url: platform === 'instagram' || platform === 'facebook' ? streamUrl : undefined,
      selected_format: best
        ? {
            format_id: best.format_id || null,
            ext: best.ext || null,
            height: best.height || null,
            width: best.width || null,
            vcodec: best.vcodec || null,
            acodec: best.acodec || null,
            format_note: best.format_note || null
          }
        : null,
      formats: sanitizeFormats(info),
      note:
        platform === 'youtube'
          ? 'Tumia stream_url kwa YouTube.'
          : 'Format bora iliyopatikana imechaguliwa.'
    });
  } catch (error) {
    console.error(`${platform} Error:`, error);

    return res.status(500).json({
      status: 'error',
      message: error.stderr || error.message || 'Imeshindikana kuchakata video'
    });
  }
}

app.post('/api/download', handleDownloadRequest);
app.post(`${BASE_PATH}/api/download`, handleDownloadRequest);

async function handleStreamRequest(req, res) {
  const { u, platform = 'unknown' } = req.query;

  if (!u) {
    return res.status(400).json({
      status: 'error',
      message: 'Media URL haipo'
    });
  }

  let mediaUrl = '';
  try {
    mediaUrl = Buffer.from(String(u), 'base64').toString('utf8');
  } catch {
    return res.status(400).json({
      status: 'error',
      message: 'Media URL si sahihi'
    });
  }

  if (!/^https?:\/\//i.test(mediaUrl)) {
    return res.status(400).json({
      status: 'error',
      message: 'Media URL si sahihi'
    });
  }

  try {
    const parsed = new URL(mediaUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      'Referer': getReferer(platform, mediaUrl)
    };

    const request = client.get(mediaUrl, { headers }, upstream => {
      const statusCode = upstream.statusCode || 500;

      if (statusCode >= 300 && statusCode < 400 && upstream.headers.location) {
        const redirectEncoded = Buffer.from(upstream.headers.location, 'utf8').toString('base64');
        return res.redirect(
          buildAppUrl(
            `/api/stream?u=${encodeURIComponent(redirectEncoded)}&platform=${encodeURIComponent(String(platform))}`
          )
        );
      }

      if (statusCode !== 200 && statusCode !== 206) {
        let body = '';
        upstream.on('data', chunk => {
          body += chunk.toString();
        });
        upstream.on('end', () => {
          return res.status(statusCode).json({
            status: 'error',
            message: `Source imerudisha ${statusCode}`,
            details: body.slice(0, 500)
          });
        });
        return;
      }

      res.status(statusCode);
      res.setHeader('Content-Type', upstream.headers['content-type'] || 'application/octet-stream');

      if (upstream.headers['content-length']) {
        res.setHeader('Content-Length', upstream.headers['content-length']);
      }

      if (upstream.headers['accept-ranges']) {
        res.setHeader('Accept-Ranges', upstream.headers['accept-ranges']);
      }

      if (upstream.headers['content-range']) {
        res.setHeader('Content-Range', upstream.headers['content-range']);
      }

      upstream.pipe(res);
    });

    request.on('error', err => {
      if (!res.headersSent) {
        res.status(500).json({
          status: 'error',
          message: 'Imeshindikana kusoma media stream',
          details: err.message
        });
      }
    });

    req.on('close', () => request.destroy());
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: 'Imeshindikana ku-proxy media',
      details: error.message
    });
  }
}

app.get('/api/stream', handleStreamRequest);
app.get(`${BASE_PATH}/api/stream`, handleStreamRequest);

app.use((req, res, next) => {
  if (req.method !== 'GET') return next();

  const wantsHtml = (req.headers.accept || '').includes('text/html');
  const isApi = req.path.startsWith('/api/') || req.path.startsWith(`${BASE_PATH}/api/`);
  const isDownload = req.path.startsWith('/downloads/') || req.path.startsWith(`${BASE_PATH}/downloads/`);

  if (!isApi && !isDownload && wantsHtml) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }

  next();
});

app.listen(PORT, () => {
  console.log(`🚀 Server inafanya kazi kwenye port ${PORT}`);
  console.log(`📁 Base path: ${BASE_PATH}`);
  console.log(`🎬 yt-dlp binary: ${YTDLP_BIN}`);
  console.log(`🍪 YouTube cookies file: ${YOUTUBE_COOKIES_FILE}`);
});
