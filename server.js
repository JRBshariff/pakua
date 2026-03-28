const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');
const youtubedl = require('youtube-dl-exec');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}
app.use('/downloads', express.static(DOWNLOAD_DIR));

function detectPlatform(url = '') {
  const u = url.toLowerCase();
  if (u.includes('tiktok.com')) return 'tiktok';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  return 'unknown';
}

function isTikTokDirectCdnUrl(url = '') {
  return /https?:\/\/v\d+-webapp-prime\.tiktok\.com\/video\//i.test(url);
}

function getReferer(platform, originalUrl) {
  if (platform === 'youtube') return 'https://www.youtube.com/';
  if (platform === 'tiktok') return 'https://www.tiktok.com/';
  return originalUrl;
}

function chooseBestFormat(info) {
  if (!info || !Array.isArray(info.formats)) return null;

  const withUrl = info.formats.filter(f => f && f.url);
  if (!withUrl.length) return null;

  const muxed = withUrl
    .filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none')
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

  return muxed || withUrl.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
}

function makeYtdlpOptions(url, platform) {
  return {
    dumpSingleJson: true,
    skipDownload: true,
    noWarnings: true,
    noPlaylist: true,
    noConfig: true,
    noCheckCertificates: true,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    referer: getReferer(platform, url)
  };
}

async function downloadTikTokToFile(pageUrl) {
  const fileId = crypto.randomBytes(8).toString('hex');
  const outputTemplate = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);

  await youtubedl(pageUrl, {
    noWarnings: true,
    noPlaylist: true,
    noConfig: true,
    noCheckCertificates: true,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    referer: 'https://www.tiktok.com/',
    output: outputTemplate
  });

  const files = fs.readdirSync(DOWNLOAD_DIR).filter(name => name.startsWith(fileId + '.'));
  if (!files.length) {
    throw new Error('Imeshindikana kuhifadhi video ya TikTok kwenye server');
  }

  return `/downloads/${files[0]}`;
}

app.post('/api/download', async (req, res) => {
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
      message: 'Platform haijatambulika. Tumia YouTube au TikTok link sahihi.'
    });
  }

  if (platform === 'tiktok' && isTikTokDirectCdnUrl(url)) {
    return res.status(400).json({
      status: 'error',
      message: 'Tumia TikTok page URL ya kawaida, si direct CDN URL.'
    });
  }

  try {
    const info = await youtubedl(url, makeYtdlpOptions(url, platform));
    if (!info) {
      throw new Error('Hakuna taarifa za video zilizopatikana');
    }

    // TIKTOK: pakua file kwenye server badala ya ku-proxy direct_url
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

    // YOUTUBE: endelea kutumia stream proxy
    let best = null;
    let downloadUrl = info.url;

    if (!downloadUrl) {
      best = chooseBestFormat(info);
      if (best?.url) downloadUrl = best.url;
    }

    if (!downloadUrl) {
      return res.status(422).json({
        status: 'error',
        message: 'Hakuna media URL iliyopatikana kwa video hii'
      });
    }

    const encodedMediaUrl = Buffer.from(downloadUrl, 'utf8').toString('base64');
    const streamUrl = `/api/stream?u=${encodeURIComponent(encodedMediaUrl)}&platform=${encodeURIComponent(platform)}`;

    return res.json({
      status: 'success',
      title: info.title || 'Video',
      thumbnail: info.thumbnail || '',
      platform,
      stream_url: streamUrl,
      direct_url: downloadUrl,
      note: 'Tumia stream_url kwa YouTube.'
    });

  } catch (error) {
    console.error(`${platform} Error:`, error);

    return res.status(500).json({
      status: 'error',
      message: error.stderr || error.message || 'Imeshindikana kuchakata video'
    });
  }
});

app.get('/api/stream', async (req, res) => {
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
        return res.redirect(
          `/api/stream?u=${encodeURIComponent(
            Buffer.from(upstream.headers.location, 'utf8').toString('base64')
          )}&platform=${encodeURIComponent(String(platform))}`
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
});

app.listen(PORT, () => {
  console.log(`🚀 Server inafanya kazi kwenye http://localhost:${PORT}`);
});