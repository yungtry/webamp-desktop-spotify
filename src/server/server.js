const express = require('express');
const SpotifyWebApi = require('spotify-web-api-node');
const path = require('path');
const crypto = require('crypto');

// Decryption function
function decrypt(encryptedText) {
  const password = 'your-secret-password';
  const key = crypto.scryptSync(password, 'salt', 32);
  const [ivHex, encryptedHex] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

// Load environment variables based on environment
let envConfig = {};
try {
  if (process.env.NODE_ENV === 'development') {
    require('dotenv').config();
    envConfig = process.env;
  } else {
    // In production, use the bundled env file and decrypt values
    const encryptedConfig = require('../../build-env.json');
    envConfig = {
      SPOTIFY_CLIENT_ID: decrypt(encryptedConfig.SPOTIFY_CLIENT_ID),
      SPOTIFY_CLIENT_SECRET: decrypt(encryptedConfig.SPOTIFY_CLIENT_SECRET),
      SPOTIFY_REDIRECT_URI: decrypt(encryptedConfig.SPOTIFY_REDIRECT_URI)
    };
  }
} catch (err) {
  console.error('Error loading environment variables:', err);
}

const app = express();
const port = 3000;

// Add CORS and JSON middleware
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

const spotifyApi = new SpotifyWebApi({
  clientId: envConfig.SPOTIFY_CLIENT_ID,
  clientSecret: envConfig.SPOTIFY_CLIENT_SECRET,
  redirectUri: envConfig.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:${port}/callback`
});

let isAuthenticated = false;
const trackCollectionCache = new Map();
const TRACK_CACHE_TTL_MS = 15 * 60 * 1000;
const TRACK_FETCH_CONCURRENCY = 4;

function requireAuthentication(res) {
  if (isAuthenticated) return true;
  res.status(401).json({ error: 'Not authenticated' });
  return false;
}

function getCachedCollection(cacheKey) {
  const cached = trackCollectionCache.get(cacheKey);
  if (!cached) return null;

  if (Date.now() - cached.createdAt > TRACK_CACHE_TTL_MS) {
    trackCollectionCache.delete(cacheKey);
    return null;
  }

  return {
    total: cached.total,
    items: cached.items,
    cached: true,
    cachedAt: cached.createdAt
  };
}

function setCachedCollection(cacheKey, total, items) {
  const createdAt = Date.now();
  trackCollectionCache.set(cacheKey, { total, items, createdAt });
  return { total, items, cached: false, cachedAt: createdAt };
}

function toTrackPayload(item) {
  const track = item && item.track ? item.track : item;
  if (!track || !track.uri || track.uri.startsWith('spotify:local:')) {
    return null;
  }

  const artists = Array.isArray(track.artists)
    ? track.artists.map((artist) => ({
        name: artist.name || 'Unknown Artist',
        uri: artist.uri || null
      }))
    : [];

  return {
    uri: track.uri,
    id: track.id || null,
    name: track.name || 'Unknown Title',
    artists,
    duration_ms: track.duration_ms || 0,
    is_playable: track.is_playable !== false,
    album: track.album
      ? {
          name: track.album.name || '',
          uri: track.album.uri || null,
          images: Array.isArray(track.album.images) ? track.album.images : []
        }
      : null
  };
}

async function fetchCachedTrackCollection(cacheKey, fetchPage, limit) {
  const cached = getCachedCollection(cacheKey);
  if (cached) {
    console.log(`Serving ${cacheKey} from cache (${cached.items.length}/${cached.total} tracks)`);
    return cached;
  }

  const firstResponse = await fetchPage({ limit: 1, offset: 0 });
  const total = firstResponse.body.total || 0;
  const offsets = [];
  for (let offset = 0; offset < total; offset += limit) {
    offsets.push(offset);
  }

  const tracks = [];
  for (let index = 0; index < offsets.length; index += TRACK_FETCH_CONCURRENCY) {
    const batchOffsets = offsets.slice(index, index + TRACK_FETCH_CONCURRENCY);
    const failedOffsets = [];
    const pages = await Promise.all(
      batchOffsets.map((offset) =>
        fetchPage({ limit, offset })
          .then((response) => response.body.items || [])
          .catch((error) => {
            console.error(`Error fetching ${cacheKey} at offset ${offset}:`, error);
            failedOffsets.push(offset);
            return [];
          })
      )
    );

    if (failedOffsets.length > 0) {
      throw new Error(`Failed to fetch ${cacheKey} pages at offsets: ${failedOffsets.join(', ')}`);
    }

    pages.forEach((items) => {
      items.forEach((item) => {
        const payload = toTrackPayload(item);
        if (payload) tracks.push({ track: payload });
      });
    });

    console.log(`Fetched ${Math.min(offsets[index + batchOffsets.length - 1] + limit, total)}/${total} for ${cacheKey}`);
  }

  console.log(`Caching ${tracks.length}/${total} tracks for ${cacheKey}`);
  return setCachedCollection(cacheKey, total, tracks);
}

function sendTrackCollection(res, collection) {
  res.json({
    total: collection.total,
    items: collection.items,
    cached: collection.cached,
    cached_at: collection.cachedAt
  });
}

function writeAscii(view, offset, value) {
  for (let i = 0; i < value.length; i++) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function createSilentWavBuffer(durationMs) {
  const sampleRate = 8000;
  const channels = 1;
  const bitsPerSample = 8;
  const safeDurationMs = Math.max(1000, Math.min(durationMs || 1000, 60 * 60 * 1000));
  const numSamples = Math.ceil(sampleRate * (safeDurationMs / 1000));
  const dataSize = numSamples * channels * (bitsPerSample / 8);
  const fileSize = 44 + dataSize;
  const buffer = Buffer.alloc(fileSize, 128);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, fileSize - 8, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  return buffer;
}

app.get('/login', (req, res) => {
  const scopes = [
    'user-read-private',
    'user-read-email',
    'playlist-read-private',
    'streaming',
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-library-read'
  ];
  const authorizeURL = spotifyApi.createAuthorizeURL(scopes);
  res.redirect(authorizeURL);
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const data = await spotifyApi.authorizationCodeGrant(code);
    spotifyApi.setAccessToken(data.body['access_token']);
    spotifyApi.setRefreshToken(data.body['refresh_token']);
    isAuthenticated = true;
    
    // Just show success message, main process will handle the window
    res.send(`
      <h1 style="font-family: Arial; text-align: center; margin-top: 50px;">
        Authentication successful! This window will close automatically.
      </h1>
    `);
  } catch (error) {
    console.error('Error getting tokens:', error);
    res.status(500).send(`
      <h1 style="font-family: Arial; text-align: center; margin-top: 50px; color: red;">
        Authentication failed: ${error.message}
      </h1>
    `);
  }
});

app.get('/token', (req, res) => {
  if (!requireAuthentication(res)) return;
  res.json({ token: spotifyApi.getAccessToken() });
});

app.get('/playlists', async (req, res) => {
  if (!requireAuthentication(res)) return;
  try {
    const data = await spotifyApi.getUserPlaylists();
    res.json(data.body);
  } catch (error) {
    console.error('Error getting playlists:', error);
    res.status(500).send('Failed to fetch playlists');
  }
});

app.get('/playlist/:id/tracks', async (req, res) => {
  if (!requireAuthentication(res)) return;
  try {
    console.log(`Fetching tracks for playlist ${req.params.id}...`);
    const collection = await fetchCachedTrackCollection(
      `playlist:${req.params.id}`,
      (options) => spotifyApi.getPlaylistTracks(req.params.id, options),
      100
    );
    sendTrackCollection(res, collection);
  } catch (error) {
    console.error('Error getting playlist tracks:', error);
    res.status(500).json({ 
      error: 'Failed to fetch playlist tracks',
      details: error.message
    });
  }
});

// Refresh token endpoint
app.post('/refresh_token', async (req, res) => {
  try {
    const data = await spotifyApi.refreshAccessToken();
    spotifyApi.setAccessToken(data.body['access_token']);
    res.json({ token: data.body['access_token'] });
  } catch (error) {
    console.error('Error refreshing token:', error);
    res.status(500).send('Failed to refresh token');
  }
});

app.get('/liked', async (req, res) => {
  if (!requireAuthentication(res)) return;

  try {
    console.log('Fetching liked songs...');
    const collection = await fetchCachedTrackCollection(
      'liked',
      (options) => spotifyApi.getMySavedTracks(options),
      50
    );
    sendTrackCollection(res, collection);
  } catch (error) {
    console.error('Error fetching liked songs:', error);
    res.status(500).json({ 
      error: 'Failed to fetch liked songs',
      details: error.message
    });
  }
});

app.get('/playlist/:id', async (req, res) => {
  if (!requireAuthentication(res)) return;

  try {
    console.log('Fetching playlist tracks...');
    const collection = await fetchCachedTrackCollection(
      `playlist:${req.params.id}`,
      (options) => spotifyApi.getPlaylistTracks(req.params.id, options),
      100
    );
    sendTrackCollection(res, collection);
  } catch (error) {
    console.error('Error fetching playlist tracks:', error);
    res.status(500).json({ 
      error: 'Failed to fetch playlist tracks',
      details: error.message
    });
  }
});

app.get('/silence/:durationMs.wav', (req, res) => {
  const durationMs = Number.parseInt(req.params.durationMs, 10);
  const buffer = createSilentWavBuffer(Number.isFinite(durationMs) ? durationMs : 1000);

  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(buffer);
});

module.exports = { app, spotifyApi }; 
