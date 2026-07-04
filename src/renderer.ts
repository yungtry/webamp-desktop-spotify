// Temporary switch to custom webamp build
// import Webamp from 'webamp'
import Webamp from './webamp/webamp.bundle'

// Import types
import { Track as WebampTrack } from './webamp/webamp.bundle'
import type { 
    SpotifyPlayerInstance,
    SpotifyWebPlaybackError,
    SpotifyPlaybackState,
    SpotifyTrack,
    WebampSpotifyTrack,
    SpotifyPlaylist 
} from './types'

declare global {
  interface Window {
    ipcRenderer: {
      send: (channel: string, ...args: any[]) => void;
      on: (channel: string, func: (...args: any[]) => void) => void;
      once: (channel: string, func: (...args: any[]) => void) => void;
    };
    __webampSpotifySeekToPercent?: (percent: number) => void | Promise<void>;
    __webampSpotifyPositionPercent?: number;
    __webampSpotifySeekBarDraftPercent?: number;
    __webampSpotifySeekBarDragging?: boolean;
    __webampSpotifySuppressPositionReset?: boolean;
    __webampSpotifyHasActiveTrack?: boolean;
    __webampSpotifyPlaylistLoadingStatus?: string | null;
  }
}

const ipcRenderer = window.ipcRenderer;

const DEFAULT_DOCUMENT_TITLE = document.title
const SPOTIFY_SERVER_BASE_URL = 'http://127.0.0.1:3000';
window.__webampSpotifyPositionPercent = 0;
window.__webampSpotifySeekBarDraftPercent = 0;
window.__webampSpotifySeekBarDragging = false;
window.__webampSpotifySuppressPositionReset = false;
window.__webampSpotifyHasActiveTrack = false;
window.__webampSpotifyPlaylistLoadingStatus = null;
let spotifyPlayer: SpotifyPlayerInstance | null = null;
let currentDeviceId: string | null = null;
let isSpotifyPlaying = false;
let desiredSpotifyPlayback: 'playing' | 'paused' = 'paused';
let activeSpotifyUri: string | null = null;
let pauseRecoveryInProgress = false;
let lastPauseRecoveryAt = 0;
let lastAutoAdvancedTrackUri: string | null = null;
let lastAutoAdvanceAt = 0;
let suppressAutoAdvanceUntil = 0;
let playbackRequestSequence = 0;
let playbackStartPromise: Promise<void> | null = null;
let playbackStartUri: string | null = null;
let lastPlaybackCommandAt = 0;
let consecutivePlaybackErrorSkips = 0;
let lastTrackChangeUri: string | null = null;
let lastTrackChangeAt = 0;
let isSyncingSeekBarFromSpotify = false;
let lastSeekBarUserInteractionAt = 0;
let isSeekBarUserDragging = false;
let seekBarReleaseTimer: number | null = null;
let suppressSeekBarSyncUntil = 0;
let playerInitializationPromise: Promise<boolean> | null = null;
let playbackStateInterval: NodeJS.Timeout | null = null;
let visualizerInterval: NodeJS.Timeout | null = null;

// Add this at the top level to store track mappings
const trackUriMap = new Map<string, string>();

let previousAmplitudes: number[] = Array(20).fill(0);
let peakAmplitudes: number[] = Array(20).fill(0);
const PEAK_DROP_SPEED = 0.4; // How fast the peaks fall (pixels per frame)
const PEAK_HOLD_TIME = 3; // How many frames to hold the peak before it starts falling
let peakHoldCounters: number[] = Array(20).fill(0);
let canvasRef: HTMLCanvasElement | null = null;

// Add these variables at the top level
let lastSpotifyPosition = 0;
let isSeekingFromWebamp = false;

// Add a flag to track resume operations
let isResumingPlayback = false;

// Add this flag at the top level
let lastPlayedTrackUri: string | null = null;

// Add at the top level after imports
let isOverWebamp = false;

// Add this flag at the top level
let isPlaybackStarting = false;

// Add at the top level
let initialPlaybackHandled = false;

// Add at the top level
let isAuthenticated = false;

// Add this variable at the top level
let isVolumeChanging = false;

// Add this at the top level
let isAuthenticating = false;
let lastAuthAttempt = 0;
const AUTH_DEBOUNCE_TIME = 1000; // 1 second debounce
let suppressPausedStateUntil = 0;
let playlistLoadSequence = 0;
let isPlaylistAppendInProgress = false;
let suppressTrackChangeDuringAppendUntil = 0;
const TRACK_END_ADVANCE_WINDOW_MS = 1500;
const AUTO_ADVANCE_DEBOUNCE_MS = 5000;
const AUTO_ADVANCE_LOAD_GRACE_MS = 8000;
const SEEK_BAR_SYNC_SUPPRESSION_MS = 1500;
const MAX_CONSECUTIVE_PLAYBACK_ERROR_SKIPS = 1;
const PLAYBACK_START_RETRY_DELAYS_MS = [0, 750, 1500, 2500];
const PLAYLIST_APPEND_EVENT_SUPPRESSION_MS = 1000;

type SpotifyTrackResponseItem = {
  track: SpotifyTrack;
};

type PlaySpotifyTrackOptions = {
  force?: boolean;
  reason?: string;
};

type PlaybackUiState = 'playing' | 'paused' | 'stopped';

type SpotifyPlaybackStartResult = {
  ok: boolean;
  stale?: boolean;
  status?: number;
  statusText?: string;
  errorData?: unknown;
  attempts?: number;
};

type SpotifyTrackPageResponse = {
  total?: number;
  offset?: number;
  limit?: number;
  next_offset?: number | null;
  items?: SpotifyTrackResponseItem[];
  cached?: boolean;
  error?: string;
};

function createTrackKey(title?: string | null, artist?: string | null): string {
  return `${title || ''}-${artist || ''}`;
}

function getPrimaryArtist(track: SpotifyTrack): string {
  return track.artists?.[0]?.name || 'Unknown Artist';
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getSpotifyTrackFromItem(item: SpotifyTrackResponseItem | { track?: SpotifyTrack } | SpotifyTrack): SpotifyTrack | null {
  const maybeItem = item as SpotifyTrackResponseItem;
  const track = maybeItem.track || (item as SpotifyTrack);

  if (
    !track?.uri ||
    !track.id ||
    (track.type && track.type !== 'track') ||
    track.is_local === true ||
    track.uri.startsWith('spotify:local:') ||
    track.is_playable === false ||
    (Array.isArray(track.available_markets) && track.available_markets.length === 0) ||
    track.restrictions?.reason
  ) {
    return null;
  }

  return track;
}

function createSpotifySilenceUrl(uri: string, durationMs: number): string {
  const safeDurationMs = Math.max(1000, Math.floor(durationMs || 1000));
  return `${SPOTIFY_SERVER_BASE_URL}/silence/${safeDurationMs}.wav?uri=${encodeURIComponent(uri)}`;
}

function getSpotifyUriFromTrackUrl(urlValue?: string): string | null {
  if (!urlValue) return null;

  try {
    return new URL(urlValue).searchParams.get('uri');
  } catch (error) {
    return null;
  }
}

function createWebampSpotifyTrack(item: SpotifyTrackResponseItem | SpotifyTrack): (WebampTrack & WebampSpotifyTrack) | null {
  const spotifyTrack = getSpotifyTrackFromItem(item);
  if (!spotifyTrack) return null;

  const artist = getPrimaryArtist(spotifyTrack);
  const url = createSpotifySilenceUrl(spotifyTrack.uri, spotifyTrack.duration_ms);
  const trackKey = createTrackKey(spotifyTrack.name, artist);

  trackUriMap.set(trackKey, spotifyTrack.uri);
  trackUriMap.set(url, spotifyTrack.uri);

  return {
    metaData: {
      artist,
      title: spotifyTrack.name,
      spotifyUri: spotifyTrack.uri
    },
    url,
    duration: Math.max(1, Math.floor((spotifyTrack.duration_ms || 1000) / 1000)),
    length: formatDuration(spotifyTrack.duration_ms || 1000),
    spotifyUri: spotifyTrack.uri,
    defaultName: `${spotifyTrack.name} - ${artist}`,
    isSpotifyTrack: true
  };
}

function getSpotifyUriFromWebampTrack(track: any): string | null {
  const uriFromUrl = getSpotifyUriFromTrackUrl(track?.url);
  if (uriFromUrl) return uriFromUrl;

  const metadataUri = track?.metaData?.spotifyUri || track?.spotifyUri;
  if (metadataUri) return metadataUri;

  return trackUriMap.get(createTrackKey(track?.metaData?.title, track?.metaData?.artist)) || null;
}

function clearPlaybackStateInterval() {
  if (playbackStateInterval) {
    clearInterval(playbackStateInterval);
    playbackStateInterval = null;
  }
}

function isSuppressingTrackChangeDuringAppend(): boolean {
  return isPlaylistAppendInProgress || Date.now() < suppressTrackChangeDuringAppendUntil;
}

function createPlaylistLoadingStatus() {
  window.__webampSpotifyPlaylistLoadingStatus = 'LOAD TRACKS';
}

function setPlaylistLoadingStatus(_status: void, message: string) {
  window.__webampSpotifyPlaylistLoadingStatus = message;
}

function removePlaylistLoadingStatus(_status: void) {
  window.__webampSpotifyPlaylistLoadingStatus = null;
}

async function appendTracksWithoutPlaybackSideEffects(tracks: (WebampTrack & WebampSpotifyTrack)[]) {
  isPlaylistAppendInProgress = true;
  suppressTrackChangeDuringAppendUntil = Date.now() + PLAYLIST_APPEND_EVENT_SUPPRESSION_MS;
  window.__webampSpotifySuppressPositionReset = true;

  try {
    await Promise.resolve(webamp.appendTracks(tracks));
  } finally {
    suppressTrackChangeDuringAppendUntil = Date.now() + PLAYLIST_APPEND_EVENT_SUPPRESSION_MS;
    window.setTimeout(() => {
      if (Date.now() >= suppressTrackChangeDuringAppendUntil) {
        isPlaylistAppendInProgress = false;
        window.__webampSpotifySuppressPositionReset = false;
      }
    }, PLAYLIST_APPEND_EVENT_SUPPRESSION_MS);
  }
}

function setSpotifyPositionPercent(percent: number) {
  window.__webampSpotifyHasActiveTrack = Boolean(
    activeSpotifyUri ||
    lastPlayedTrackUri ||
    isSpotifyPlaying ||
    desiredSpotifyPlayback === 'playing'
  );
  window.__webampSpotifyPositionPercent = Math.max(0, Math.min(100, percent));
}

function setSeekBarDraftPercent(percent: number) {
  window.__webampSpotifySeekBarDraftPercent = Math.max(0, Math.min(100, percent));
}

function readSeekBarPercent(): number | null {
  const seekingBar = document.getElementById('position') as HTMLInputElement;
  if (!seekingBar) return null;

  const percent = Number(seekingBar.value);
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
}

function setSeekBarPercent(percent: number) {
  const seekingBar = document.getElementById('position') as HTMLInputElement;
  const clampedPercent = Math.max(0, Math.min(100, percent));
  setSpotifyPositionPercent(clampedPercent);
  if (!seekingBar) return;

  seekingBar.value = clampedPercent.toString();
}

function syncSeekingBarFromSpotify(positionMs: number, durationMs: number) {
  if (durationMs > 0) {
    setSpotifyPositionPercent((positionMs / durationMs) * 100);
  }

  const seekingBar = document.getElementById('position') as HTMLInputElement;
  if (
    !seekingBar ||
    durationMs <= 0 ||
    isSeekingFromWebamp ||
    isSeekBarUserDragging ||
    Date.now() < suppressSeekBarSyncUntil
  ) {
    return;
  }

  isSyncingSeekBarFromSpotify = true;
  setSeekBarPercent((positionMs / durationMs) * 100);
  window.setTimeout(() => {
    isSyncingSeekBarFromSpotify = false;
  }, 0);
}

function beginSeekBarUserInteraction() {
  lastSeekBarUserInteractionAt = Date.now();
  isSeekBarUserDragging = true;
  window.__webampSpotifySeekBarDragging = true;
  suppressSeekBarSyncUntil = Date.now() + SEEK_BAR_SYNC_SUPPRESSION_MS;

  const currentPercent = readSeekBarPercent();
  if (currentPercent !== null) {
    setSeekBarDraftPercent(currentPercent);
  }

  if (seekBarReleaseTimer !== null) {
    window.clearTimeout(seekBarReleaseTimer);
    seekBarReleaseTimer = null;
  }
}

function endSeekBarUserInteraction() {
  if (!isSeekBarUserDragging && seekBarReleaseTimer === null) {
    return;
  }

  lastSeekBarUserInteractionAt = Date.now();
  suppressSeekBarSyncUntil = Date.now() + SEEK_BAR_SYNC_SUPPRESSION_MS;

  if (seekBarReleaseTimer !== null) {
    window.clearTimeout(seekBarReleaseTimer);
  }

  seekBarReleaseTimer = window.setTimeout(() => {
    isSeekBarUserDragging = false;
    window.__webampSpotifySeekBarDragging = false;
    seekBarReleaseTimer = null;
  }, 500);
}

async function seekSpotifyToPercent(percent: number) {
  if (!spotifyPlayer || isSeekingFromWebamp) return;

  const clampedPercent = Math.max(0, Math.min(100, percent));

  try {
    const state = await spotifyPlayer.getCurrentState();
    if (!state || state.duration <= 0) return;

    const newPosition = Math.floor(state.duration * (clampedPercent / 100));
    isSeekingFromWebamp = true;
    suppressSeekBarSyncUntil = Date.now() + SEEK_BAR_SYNC_SUPPRESSION_MS;
    setSeekBarDraftPercent(clampedPercent);
    setSeekBarPercent(clampedPercent);
    await spotifyPlayer.seek(newPosition);
    lastSpotifyPosition = newPosition;
    updateTimeDisplay(newPosition);
    syncWebampElapsedTimeFromSpotify(newPosition);
  } catch (error) {
    console.error('Failed to seek Spotify playback:', error);
  } finally {
    isSeekingFromWebamp = false;
  }
}

window.__webampSpotifySeekToPercent = async (percent: number) => {
  await seekSpotifyToPercent(percent);
};

function syncWebampElapsedTimeFromSpotify(positionMs: number) {
  const store = (webamp as any)?.store;
  if (!store) return;

  store.dispatch({
    type: 'UPDATE_TIME_ELAPSED',
    elapsed: Math.max(0, positionMs / 1000)
  });
}

function syncWebampPlaybackStatus(state: PlaybackUiState) {
  const store = (webamp as any)?.store;
  if (!store) return;

  const typeByState: Record<PlaybackUiState, string> = {
    playing: 'IS_PLAYING',
    paused: 'PAUSE',
    stopped: 'STOP'
  };

  store.dispatch({ type: typeByState[state] });
}

function setSpotifyPlaybackState(isPlaying: boolean, uiState: PlaybackUiState = isPlaying ? 'playing' : 'stopped') {
  const wasPlaying = isSpotifyPlaying;
  isSpotifyPlaying = isPlaying;
  updatePlaybackStateUI(uiState);
  syncWebampPlaybackStatus(uiState);

  if (isPlaying && !wasPlaying) {
    startVisualizer();
  } else if (!isPlaying && wasPlaying) {
    stopVisualizer();
  }
}

function getWebampPlaylistState() {
  return (webamp as any)?.store?.getState?.()?.playlist || null;
}

function getWebampMediaState() {
  return (webamp as any)?.store?.getState?.()?.media || null;
}

function canAdvanceWebampTrack(direction: 'next' | 'previous'): boolean {
  const playlist = getWebampPlaylistState();
  const media = getWebampMediaState();
  const trackOrder = playlist?.trackOrder || [];

  if (trackOrder.length === 0) return false;
  if (media?.repeat || media?.shuffle) return true;

  const currentIndex = trackOrder.indexOf(playlist?.currentTrack);
  if (currentIndex === -1) return false;

  return direction === 'next'
    ? currentIndex < trackOrder.length - 1
    : currentIndex > 0;
}

function hasSpotifyTrackEnded(state: SpotifyPlaybackState): boolean {
  if (!state.duration || state.duration <= 0) return false;

  const latestKnownPosition = Math.max(state.position || 0, lastSpotifyPosition || 0);
  return latestKnownPosition >= state.duration - TRACK_END_ADVANCE_WINDOW_MS;
}

function clearAutoAdvanceGuardForActivePlayback(state: SpotifyPlaybackState) {
  const stateTrackUri = state.track_window?.current_track?.uri || null;

  if (!stateTrackUri || hasSpotifyTrackEnded(state)) {
    return;
  }

  if (stateTrackUri === activeSpotifyUri || stateTrackUri !== lastAutoAdvancedTrackUri) {
    lastAutoAdvancedTrackUri = null;
    suppressAutoAdvanceUntil = 0;
  }
}

function isStaleSpotifyStateForActiveTrack(state: SpotifyPlaybackState): boolean {
  const stateTrackUri = state.track_window?.current_track?.uri || null;

  return Boolean(
    activeSpotifyUri &&
    stateTrackUri &&
    stateTrackUri !== activeSpotifyUri &&
    (isPlaybackStarting || playbackStartPromise)
  );
}

function advanceAfterSpotifyTrackEnd(state: SpotifyPlaybackState, source: string): boolean {
  if (desiredSpotifyPlayback !== 'playing' || !hasSpotifyTrackEnded(state)) {
    return false;
  }

  const stateTrackUri = state.track_window?.current_track?.uri || activeSpotifyUri || lastPlayedTrackUri;
  const now = Date.now();

  if (stateTrackUri && stateTrackUri === lastAutoAdvancedTrackUri) {
    return true;
  }

  if (playbackStartPromise || isPlaybackStarting || now < suppressAutoAdvanceUntil) {
    console.log('Waiting for Spotify to load the next track before auto-advancing again:', {
      source,
      stateTrackUri,
      activeSpotifyUri
    });
    return true;
  }

  if (stateTrackUri === lastAutoAdvancedTrackUri && now - lastAutoAdvanceAt < AUTO_ADVANCE_DEBOUNCE_MS) {
    return true;
  }

  lastAutoAdvancedTrackUri = stateTrackUri;
  lastAutoAdvanceAt = now;
  suppressAutoAdvanceUntil = now + AUTO_ADVANCE_LOAD_GRACE_MS;
  activeSpotifyUri = null;
  lastPlayedTrackUri = null;
  lastSpotifyPosition = 0;
  syncWebampElapsedTimeFromSpotify(0);
  setSeekBarPercent(0);

  console.log('Spotify track ended, advancing Webamp playlist:', { source, stateTrackUri });

  if (!advanceWebampTrack('next')) {
    console.log('No next Webamp track available, stopping playback');
    stopSpotifyPlayback().catch((error) => {
      console.error('Failed to stop playback after playlist ended:', error);
    });
  }

  return true;
}

async function recoverUnexpectedSpotifyPause(reason: string, state?: SpotifyPlaybackState | null) {
  if (!spotifyPlayer || desiredSpotifyPlayback !== 'playing' || pauseRecoveryInProgress) {
    return;
  }

  if (playbackStartPromise || Date.now() < suppressPausedStateUntil) {
    console.log('Deferring unexpected pause recovery while playback is starting:', reason);
    return;
  }

  const now = Date.now();
  if (now - lastPauseRecoveryAt < 1200) {
    return;
  }

  pauseRecoveryInProgress = true;
  lastPauseRecoveryAt = now;
  suppressPausedStateUntil = now + 2500;

  try {
    console.warn('Recovering unexpected Spotify pause:', reason);
    const currentUri = state?.track_window?.current_track?.uri;

    if (activeSpotifyUri && currentUri && currentUri !== activeSpotifyUri) {
      await playSpotifyTrack(activeSpotifyUri, lastSpotifyPosition, { force: true, reason });
    } else {
      try {
        await spotifyPlayer.resume();
        setSpotifyPlaybackState(true);
        startPlaybackStateMonitoring();
      } catch (resumeError) {
        if (!activeSpotifyUri) {
          throw resumeError;
        }
        console.warn('Spotify resume failed, replaying active URI:', resumeError);
        await playSpotifyTrack(activeSpotifyUri, lastSpotifyPosition, { force: true, reason });
      }
    }
  } catch (error) {
    console.error('Failed to recover Spotify playback:', error);
  } finally {
    pauseRecoveryInProgress = false;
  }
}

async function readSpotifyErrorData(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

function shouldRetrySpotifyPlaybackStart(status: number): boolean {
  return status === 403 || status === 404 || status === 429 || status >= 500;
}

async function startSpotifyPlaybackOnDevice(
  token: string,
  body: any,
  uri: string,
  requestId: number
): Promise<SpotifyPlaybackStartResult> {
  let lastResult: SpotifyPlaybackStartResult = { ok: false, attempts: 0 };

  for (let attemptIndex = 0; attemptIndex < PLAYBACK_START_RETRY_DELAYS_MS.length; attemptIndex++) {
    const retryDelay = PLAYBACK_START_RETRY_DELAYS_MS[attemptIndex];
    if (retryDelay > 0) {
      await delay(retryDelay);
    }

    if (requestId !== playbackRequestSequence) {
      return { ok: false, stale: true, attempts: attemptIndex + 1 };
    }

    console.log('Starting playback on device:', {
      deviceId: currentDeviceId,
      uri,
      attempt: attemptIndex + 1
    });

    const response = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${currentDeviceId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (response.ok) {
      return { ok: true };
    }

    const errorData = await readSpotifyErrorData(response);
    lastResult = {
      ok: false,
      status: response.status,
      statusText: response.statusText,
      errorData,
      attempts: attemptIndex + 1
    };

    if (!shouldRetrySpotifyPlaybackStart(response.status) || attemptIndex === PLAYBACK_START_RETRY_DELAYS_MS.length - 1) {
      return lastResult;
    }

    console.warn('Spotify playback start failed, retrying:', lastResult);
  }

  return lastResult;
}

// Function to get canvas reference
function getCanvas(): HTMLCanvasElement | null {
  if (!canvasRef) {
    canvasRef = document.querySelector('#webamp #main-window #visualizer2') as HTMLCanvasElement;
  }
  return canvasRef;
}

// Function to initialize Spotify Web Playback SDK
async function initSpotifyPlayer() {
  // If already initializing, return the existing promise
  if (playerInitializationPromise) {
    return playerInitializationPromise;
  }

  playerInitializationPromise = (async () => {
    try {
      // First verify we have a valid token
      const tokenResponse = await fetch(`${SPOTIFY_SERVER_BASE_URL}/token`);
      const tokenData = await tokenResponse.json();
      if (tokenData.error) {
        throw new Error('No valid token available');
      }

      // If we already have a player instance, try to reconnect it first
      if (spotifyPlayer) {
        try {
          const connected = await spotifyPlayer.connect();
          if (connected) {
            console.log('Reconnected existing player');
            return true;
          }
        } catch (error) {
          console.warn('Failed to reconnect existing player:', error);
        }
      }

      // Remove any existing Spotify script
      const existingScript = document.querySelector('script[src*="spotify-player.js"]');
      if (existingScript) {
        existingScript.remove();
      }

      // Set up the ready callback before loading the script
      return new Promise((resolve, reject) => {
        let timeoutId: NodeJS.Timeout;

        window.onSpotifyWebPlaybackSDKReady = () => {
          clearTimeout(timeoutId);
          try {
            console.log('Spotify SDK ready, creating player...');
            spotifyPlayer = new window.Spotify.Player({
              name: 'Webamp Desktop',
              getOAuthToken: async (cb: (token: string) => void) => {
                try {
                  const response = await fetch(`${SPOTIFY_SERVER_BASE_URL}/token`);
                  const data = await response.json();
                  if (data.error) {
                    console.error('Failed to get token:', data.error);
                    return;
                  }
                  cb(data.token);
                } catch (error) {
                  console.error('Error getting token:', error);
                }
              },
              // Set initial volume to match slider
              volume: parseInt((document.querySelector('input[type="range"][title="Volume Bar"]') as HTMLInputElement)?.value || '78') / 100
            });

            // Error handling
            spotifyPlayer.addListener('initialization_error', ({ message }: SpotifyWebPlaybackError) => {
              console.error('Failed to initialize:', message);
              currentDeviceId = null;
              reject(new Error(message));
            });

            spotifyPlayer.addListener('authentication_error', ({ message }: SpotifyWebPlaybackError) => {
              console.error('Failed to authenticate:', message);
              currentDeviceId = null;
              playerInitializationPromise = null; // Allow retry
              // Reinitialize auth
              initSpotifyAuth();
            });

            spotifyPlayer.addListener('account_error', ({ message }: SpotifyWebPlaybackError) => {
              console.error('Failed to validate Spotify account:', message);
              currentDeviceId = null;
              playerInitializationPromise = null; // Allow retry
            });

            spotifyPlayer.addListener('playback_error', ({ message }: SpotifyWebPlaybackError) => {
              console.error('Failed to perform playback:', message);
              // Don't reset device ID here, just retry the playback
            });

            // Ready
            spotifyPlayer.addListener('ready', async ({ device_id }: { device_id: string }) => {
              console.log('Ready with Device ID', device_id);
              currentDeviceId = device_id;

              // Immediately set this device as active
              try {
                const tokenResponse = await fetch(`${SPOTIFY_SERVER_BASE_URL}/token`);
                const tokenData = await tokenResponse.json();
                if (!tokenData.error) {
                  await fetch('https://api.spotify.com/v1/me/player', {
                    method: 'PUT',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${tokenData.token}`
                    },
                    body: JSON.stringify({
                      device_ids: [device_id],
                      play: false // Don't auto-play
                    })
                  });
                  console.log('Device set as active');
                }
              } catch (error) {
                console.error('Error setting device as active:', error);
              }

              resolve(true);
            });

            // Not ready
            spotifyPlayer.addListener('not_ready', ({ device_id }: { device_id: string }) => {
              console.log('Device ID is not ready:', device_id);
              if (currentDeviceId === device_id) {
                currentDeviceId = null;
                // Try to reconnect
                spotifyPlayer?.connect().catch(console.error);
              }
            });

            // Connect to the player
            console.log('Connecting to Spotify...');
            spotifyPlayer.connect().then(success => {
              if (success) {
                console.log('Successfully connected to Spotify');
              } else {
                console.error('Failed to connect to Spotify');
                currentDeviceId = null;
                playerInitializationPromise = null; // Allow retry
                reject(new Error('Failed to connect to Spotify'));
              }
            }).catch(error => {
              console.error('Connection error:', error);
              currentDeviceId = null;
              playerInitializationPromise = null; // Allow retry
              reject(error);
            });

            // Add state change listener
            spotifyPlayer.addListener('player_state_changed', async (state: SpotifyPlaybackState | null) => {
              console.log('Playback state changed:', state);
              if (state) {
                if (isStaleSpotifyStateForActiveTrack(state)) {
                  console.log('Ignoring stale Spotify state while a new Webamp track is starting');
                  return;
                }

                clearAutoAdvanceGuardForActivePlayback(state);

                if (advanceAfterSpotifyTrackEnd(state, 'player_state_changed')) {
                  return;
                }

                if (state.paused && desiredSpotifyPlayback === 'playing') {
                  if (playbackStartPromise || Date.now() < suppressPausedStateUntil) {
                    console.log('Ignoring transient paused state during playback start');
                    return;
                  }

                  desiredSpotifyPlayback = 'paused';
                  setSpotifyPlaybackState(false, 'paused');
                  clearPlaybackStateInterval();
                  return;
                }

                const wasPlaying = isSpotifyPlaying;
                setSpotifyPlaybackState(!state.paused, state.paused ? 'paused' : 'playing');

                // Handle initial playback
                if (isSpotifyPlaying && !wasPlaying) {
                  isPlaybackStarting = true;
                  initialPlaybackHandled = false;
                  // Wait a bit before allowing seeks
                  setTimeout(() => {
                    isPlaybackStarting = false;
                  }, 1000);
                }

                // Only handle position updates if we're not in the initial playback start
                if (!isPlaybackStarting) {
                  // If this is the first position update after initial playback
                  if (state.position > 0 && !initialPlaybackHandled) {
                    initialPlaybackHandled = true;
                    syncSeekingBarFromSpotify(state.position, state.duration);
                  }
                }

                if (isSpotifyPlaying) {
                  startPlaybackStateMonitoring();
                } else {
                  clearPlaybackStateInterval();
                  document.title = DEFAULT_DOCUMENT_TITLE;
                }
              }
            });

          } catch (error) {
            console.error('Error in SDK ready callback:', error);
            currentDeviceId = null;
            playerInitializationPromise = null;
            reject(error);
          }
        };

        // Load the Spotify Web Playback SDK
        console.log('Loading Spotify SDK...');
        const script = document.createElement('script');
        script.src = 'https://sdk.scdn.co/spotify-player.js';
        script.async = true;
        script.onerror = (e) => {
          console.error('Failed to load Spotify SDK:', e);
          currentDeviceId = null;
          playerInitializationPromise = null; // Allow retry
          reject(new Error('Failed to load Spotify SDK'));
        };
        document.body.appendChild(script);

        // Set a timeout for the SDK to load
        timeoutId = setTimeout(() => {
          currentDeviceId = null;
          playerInitializationPromise = null; // Allow retry
          reject(new Error('Spotify SDK load timeout'));
        }, 10000);
      });
    } catch (error) {
      console.error('Error in initSpotifyPlayer:', error);
      currentDeviceId = null;
      playerInitializationPromise = null; // Allow retry
      throw error;
    }
  })();

  return playerInitializationPromise;
}

// Function to format duration in milliseconds to MM:SS
function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Function to play a Spotify track
async function playSpotifyTrack(uri: string, startPosition: number = 0, options: PlaySpotifyTrackOptions = {}) {
  const now = Date.now();

  if (!options.force && playbackStartPromise && playbackStartUri === uri) {
    console.log('Joining in-flight Spotify playback request:', { uri, reason: options.reason });
    return playbackStartPromise;
  }

  if (
    !options.force &&
    activeSpotifyUri === uri &&
    isSpotifyPlaying &&
    now - lastPlaybackCommandAt < 2500
  ) {
    console.log('Ignoring duplicate Spotify playback request:', { uri, reason: options.reason });
    return;
  }

  const requestId = ++playbackRequestSequence;
  playbackStartUri = uri;
  lastPlaybackCommandAt = now;

  const request = performSpotifyTrackPlayback(uri, startPosition, requestId, options);
  playbackStartPromise = request;

  try {
    await request;
  } finally {
    if (playbackStartPromise === request) {
      playbackStartPromise = null;
      playbackStartUri = null;
    }
  }
}

async function performSpotifyTrackPlayback(
  uri: string,
  startPosition: number,
  requestId: number,
  options: PlaySpotifyTrackOptions
) {
  console.log('Starting playback...', { uri, startPosition });
  desiredSpotifyPlayback = 'playing';
  activeSpotifyUri = uri;
  
  // Check if this is a local file
  if (uri.startsWith('spotify:local:')) {
    console.log('Local file detected, cannot play through Spotify Web Playback SDK');
    throw new Error('Local files are not supported in Spotify Web Playback SDK');
  }

  // Ensure player is initialized
  if (!spotifyPlayer || !currentDeviceId) {
    console.log('Player not initialized, initializing...');
    try {
      await initSpotifyPlayer();
      // Wait a bit for the player to be ready
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error('Failed to initialize player:', error);
      throw error;
    }
  }

  if (!spotifyPlayer || !currentDeviceId) {
    throw new Error('Failed to initialize Spotify player');
  }
  
  // Get fresh token
  const tokenResponse = await fetch(`${SPOTIFY_SERVER_BASE_URL}/token`);
  const { token } = await tokenResponse.json();

  try {
    isPlaybackStarting = true;
    suppressPausedStateUntil = Date.now() + 2000;

    if (requestId !== playbackRequestSequence) {
      console.log('Skipping stale Spotify playback request before state lookup:', { uri, requestId });
      return;
    }

    // Get current playback state
    const stateResponse = await fetch('https://api.spotify.com/v1/me/player', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    let state = null;
    if (stateResponse.status !== 204) { // 204 means no content, player is inactive
      state = await stateResponse.json();
    }
    console.log('Current playback state:', state);

    if (requestId !== playbackRequestSequence) {
      console.log('Skipping stale Spotify playback request before transfer:', { uri, requestId });
      return;
    }

    // Transfer playback to our device first
    console.log('Transferring playback to our device...');
    const transferResponse = await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        device_ids: [currentDeviceId],
        play: false
      })
    });

    if (!transferResponse.ok) {
      throw new Error(`Failed to transfer playback: ${transferResponse.status} ${transferResponse.statusText}`);
    }

    // Wait a bit for the transfer to take effect
    await delay(250);

    // Prepare request body
    const body: any = {
      uris: [uri]
    };
    
    if (startPosition > 0) {
      body.position_ms = startPosition;
    }

    if (requestId !== playbackRequestSequence) {
      console.log('Skipping stale Spotify playback request before play:', { uri, requestId });
      return;
    }

    const playbackStartResult = await startSpotifyPlaybackOnDevice(token, body, uri, requestId);

    if (!playbackStartResult.ok) {
      if (playbackStartResult.stale) {
        console.log('Skipping stale Spotify playback request after play retries:', { uri, requestId });
        return;
      }

      const errorMessage = [
        playbackStartResult.status,
        playbackStartResult.statusText,
        playbackStartResult.errorData ? JSON.stringify(playbackStartResult.errorData) : null
      ].filter(Boolean).join(' ');

      console.error('Playback API error details:', playbackStartResult);

      if (
        playbackStartResult.status === 403 &&
        consecutivePlaybackErrorSkips < MAX_CONSECUTIVE_PLAYBACK_ERROR_SKIPS
      ) {
        consecutivePlaybackErrorSkips += 1;
        console.warn('Track playback was rejected after retries, skipping one track:', {
          uri,
          consecutivePlaybackErrorSkips
        });

        if (advanceWebampTrack('next')) {
          return;
        }
      }

      throw new Error(`Playback failed after ${playbackStartResult.attempts || 1} attempt(s): ${errorMessage}`);
    }

    if (requestId !== playbackRequestSequence && !options.force) {
      console.log('Ignoring stale Spotify playback completion:', { uri, requestId });
      return;
    }

    consecutivePlaybackErrorSkips = 0;
    setSpotifyPlaybackState(true);
    startPlaybackStateMonitoring();
    setTimeout(() => {
      isPlaybackStarting = false;
    }, 1000);
    console.log('Playback started successfully');
  } catch (error) {
    isPlaybackStarting = false;
    if (activeSpotifyUri === uri) {
      desiredSpotifyPlayback = 'paused';
    }
    console.error('Error in playback sequence:', error);
    throw error;
  }
}

// Function to load Spotify playlists
async function loadSpotifyPlaylists(): Promise<SpotifyPlaylist[]> {
  try {
    const response = await fetch(`${SPOTIFY_SERVER_BASE_URL}/playlists`);
    const data = await response.json();
    if (data.error) return [];
    return data.items;
  } catch (error) {
    console.error('Error loading playlists:', error);
    return [];
  }
}

type SpotifyPlaylistMenuSelection = {
  requestId: string;
  value: string | null;
};

function showNativePlaylistMenu(ejectButton: Element, playlists: SpotifyPlaylist[]): Promise<string | null> {
  const ejectRect = ejectButton.getBoundingClientRect();
  const requestId = `spotify-playlist-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => resolve(null), 30000);

    window.ipcRenderer.once('spotify-playlist-menu-selected', (selection: SpotifyPlaylistMenuSelection) => {
      if (!selection || selection.requestId !== requestId) return;

      window.clearTimeout(timeoutId);
      resolve(selection.value || null);
    });

    window.ipcRenderer.send('show-spotify-playlist-menu', {
      requestId,
      playlists,
      x: Math.round(ejectRect.left),
      y: Math.round(ejectRect.bottom + 5)
    });
  });
}

async function loadTracksIntoWebamp(baseUrl: string, pageLimit: number, loadingStatus: void) {
  const loadId = ++playlistLoadSequence;
  setPlaylistLoadingStatus(loadingStatus, 'LOAD TRACKS');
  await webamp.setTracksToPlay([]);

  let totalProcessed = 0;
  let totalAvailable = 0;
  let offset = 0;

  const appendItems = async (items: SpotifyTrackResponseItem[]) => {
    const batchSize = 100;
    let batch: (WebampTrack & WebampSpotifyTrack)[] = [];
    let appended = 0;

    for (const item of items) {
      if (loadId !== playlistLoadSequence) return appended;

      const track = createWebampSpotifyTrack(item);
      if (!track) continue;

      batch.push(track);
      appended++;

      if (batch.length >= batchSize) {
        await appendTracksWithoutPlaybackSideEffects(batch);
        batch = [];
        await delay(0);
      }
    }

    if (batch.length > 0 && loadId === playlistLoadSequence) {
      await appendTracksWithoutPlaybackSideEffects(batch);
    }

    return appended;
  };

  while (loadId === playlistLoadSequence) {
    setPlaylistLoadingStatus(loadingStatus, totalAvailable > 0
      ? `LOAD ${totalProcessed}/${totalAvailable}`
      : 'LOAD TRACKS');

    const pagedUrl = new URL(baseUrl);
    pagedUrl.searchParams.set('progressive', '1');
    pagedUrl.searchParams.set('offset', offset.toString());
    pagedUrl.searchParams.set('limit', pageLimit.toString());

    const response = await fetch(pagedUrl.toString());
    const data: SpotifyTrackPageResponse = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || `Failed to load tracks: ${response.status}`);
    }

    totalAvailable = data.total || totalAvailable || 0;
    const appended = await appendItems(data.items || []);
    totalProcessed += appended;

    setPlaylistLoadingStatus(loadingStatus, data.cached
      ? `CACHE ${totalProcessed}/${totalAvailable}`
      : `LOAD ${totalProcessed}/${totalAvailable}`);

    if (data.next_offset == null || data.next_offset <= offset) {
      break;
    }

    offset = data.next_offset;
    await delay(0);
  }

  if (loadId === playlistLoadSequence) {
    setPlaylistLoadingStatus(loadingStatus, `READY ${totalProcessed}/${totalAvailable || totalProcessed}`);
    await delay(750);
  }
}

// Show Spotify playlist selector
async function showPlaylistSelector(ejectButton: Element): Promise<void> {
  document.querySelector('.spotify-playlist-wrapper')?.remove();

  const playlists = await loadSpotifyPlaylists();
  const selectedPlaylistId = await showNativePlaylistMenu(ejectButton, playlists);
  if (!selectedPlaylistId) return;

  if (spotifyPlayer && isSpotifyPlaying) {
    await stopSpotifyPlayback();
  }

  const loadingStatus = createPlaylistLoadingStatus();

  try {
    if (selectedPlaylistId === 'liked') {
      await loadTracksIntoWebamp(`${SPOTIFY_SERVER_BASE_URL}/liked`, 50, loadingStatus);
    } else {
      await loadTracksIntoWebamp(`${SPOTIFY_SERVER_BASE_URL}/playlist/${selectedPlaylistId}`, 100, loadingStatus);
    }
  } catch (error) {
    console.error('Error loading tracks:', error);
    setPlaylistLoadingStatus(loadingStatus, 'LOAD ERROR');
    await delay(2000);
  } finally {
    removePlaylistLoadingStatus(loadingStatus);
  }
}

// Function to initialize Spotify authentication
function initSpotifyAuth() {
  // Check if already authenticated
  if (isAuthenticated) {
    console.log('Already authenticated');
    return;
  }

  // Check if authentication is in progress
  if (isAuthenticating) {
    console.log('Authentication already in progress');
    return;
  }

  // Debounce check
  const now = Date.now();
  if (now - lastAuthAttempt < AUTH_DEBOUNCE_TIME) {
    console.log('Auth attempt too soon, debouncing');
    return;
  }
  lastAuthAttempt = now;

  // Set authenticating flag
  isAuthenticating = true;

  // Remove any existing player instance
  if (spotifyPlayer) {
    spotifyPlayer.disconnect();
    spotifyPlayer = null;
    currentDeviceId = null;
    playerInitializationPromise = null;
  }

  // Set up IPC listener for auth success
  window.ipcRenderer.on('spotify-auth-success', async () => {
    console.log('Authentication successful, initializing player...');
    
    // Initialize player after a short delay to ensure token is saved
    setTimeout(async () => {
      try {
        // Verify we have a valid token before initializing player
        const tokenResponse = await fetch(`${SPOTIFY_SERVER_BASE_URL}/token`);
        const tokenData = await tokenResponse.json();
        if (tokenData.error) {
          console.error('No valid token available after auth');
          isAuthenticating = false; // Reset flag
          return;
        }

        // Initialize the player
        await initSpotifyPlayer();
        console.log('Player initialized successfully');
        
        // Mark as authenticated and update UI
        isAuthenticated = true;
        isAuthenticating = false; // Reset flag
        updateAuthenticationUI(true);
      } catch (error) {
        console.error('Failed to initialize player:', error);
        isAuthenticating = false; // Reset flag
      }
    }, 500);
  });

  // Start the authentication process
  window.ipcRenderer.send('initiate-spotify-auth');
}

// Add this debug function at the top level
function debugLogTrack(track: any) {
  if (!track) {
    console.log('Debug Track Object: null');
    return;
  }
  
  console.log('Debug Track Object:', {
    fullTrack: track,
    hasMetaData: !!track?.metaData,
    metaData: track?.metaData,
    hasSpotifyUri: !!track?.spotifyUri,
    spotifyUriInMetaData: !!(track?.metaData as any)?.spotifyUri,
    keys: Object.keys(track || {}),
    prototype: Object.getPrototypeOf(track),
  });
}

const webamp = new Webamp({
  availableSkins: [
    { url: './skins/base-2.91.wsz', name: 'Base v2.91' },
    { url: './skins/Green-Dimension-V2.wsz', name: 'Green Dimension V2' },
    { url: './skins/MacOSXAqua1-5.wsz', name: 'Mac OSX v1.5 (Aqua)' },
    { url: './skins/Skinner_Atlas.wsz', name: 'Skinner Atlas' },
    { url: './skins/TopazAmp1-2.wsz', name: 'TopazAmp v1.2' },
    { url: './skins/Vizor1-01.wsz', name: 'Vizor v1.01' },
    { url: './skins/XMMS-Turquoise.wsz', name: 'XMMS Turquoise' },
    { url: './skins/ZaxonRemake1-0.wsz', name: 'Zaxon Remake v1.0' },
  ],
  enableHotkeys: false
})

const unsubscribeOnMinimize = webamp.onMinimize(() => {
  window.minimizeElectronWindow()
})

const unsubscribeOnClose = webamp.onClose(() => {
  window.closeElectronWindow()
  unsubscribeOnMinimize()
  unsubscribeOnClose()
})

async function startSynchronizedPlayback(spotifyUri: string) {
  console.log('Starting Spotify playback...');
  await playSpotifyTrack(spotifyUri, 0);
  setSpotifyPlaybackState(true);
  startPlaybackStateMonitoring();
}

function advanceWebampTrack(direction: 'next' | 'previous'): boolean {
  if (!canAdvanceWebampTrack(direction)) {
    return false;
  }

  desiredSpotifyPlayback = 'playing';
  if (direction === 'next') {
    (webamp as any).nextTrack();
  } else {
    (webamp as any).previousTrack();
  }

  return true;
}

async function pauseSpotifyPlayback() {
  desiredSpotifyPlayback = 'paused';

  if (spotifyPlayer) {
    await spotifyPlayer.pause();
  }

  setSpotifyPlaybackState(false, 'paused');
  clearPlaybackStateInterval();
}

async function stopSpotifyPlayback() {
  desiredSpotifyPlayback = 'paused';
  activeSpotifyUri = null;
  lastPlayedTrackUri = null;
  lastSpotifyPosition = 0;
  isSeekingFromWebamp = false;
  document.title = DEFAULT_DOCUMENT_TITLE;
  syncWebampElapsedTimeFromSpotify(0);
  setSeekBarPercent(0);

  if (spotifyPlayer) {
    await spotifyPlayer.pause();
  }

  setSpotifyPlaybackState(false, 'stopped');
  clearPlaybackStateInterval();
}

// Modify the onTrackDidChange handler
webamp.onTrackDidChange((track: any) => {
  console.log('Track change event triggered');
  debugLogTrack(track);

  // If we're resuming, don't process the track change
  if (isResumingPlayback) {
    console.log('Ignoring track change during resume operation');
    return;
  }

  if (!track || !track.metaData) {
    console.log('No track or metadata');
    return;
  }

  const trackKey = createTrackKey(track.metaData.title, track.metaData.artist);
  const spotifyUri = getSpotifyUriFromWebampTrack(track);
  const now = Date.now();
  
  console.log('Track lookup:', { trackKey, spotifyUri });

  if (spotifyUri) {
    if (isSuppressingTrackChangeDuringAppend() && (isSpotifyPlaying || activeSpotifyUri)) {
      console.log('Ignoring Webamp track event caused by progressive playlist append:', { spotifyUri });
      return;
    }

    if (spotifyUri === activeSpotifyUri && spotifyUri === lastPlayedTrackUri) {
      console.log('Ignoring Webamp status-only track event for active Spotify track:', { spotifyUri });
      return;
    }

    if (spotifyUri === lastTrackChangeUri && now - lastTrackChangeAt < 1200) {
      console.log('Ignoring duplicate Webamp track change event:', { spotifyUri });
      return;
    }

    lastTrackChangeUri = spotifyUri;
    lastTrackChangeAt = now;

    // Reset position tracking only after accepting a real track change.
    lastSpotifyPosition = 0;
    activeSpotifyUri = spotifyUri;
    isSeekingFromWebamp = false;
    isPlaybackStarting = true;
    suppressSeekBarSyncUntil = Date.now() + AUTO_ADVANCE_LOAD_GRACE_MS;
    updateTimeDisplay(0);
    setSeekBarPercent(0);
    syncWebampElapsedTimeFromSpotify(0);

    console.log('Spotify track detected:', {
      name: track.metaData.title,
      artist: track.metaData.artist,
      uri: spotifyUri,
      playerInitialized: !!spotifyPlayer,
      deviceId: currentDeviceId
    });
    
    // Update document title
    document.title = `${track.metaData.title} - ${track.metaData.artist}` || DEFAULT_DOCUMENT_TITLE;

    // Only start playback if this is a new track
    if (spotifyUri !== lastPlayedTrackUri) {
      lastPlayedTrackUri = spotifyUri;
      startSynchronizedPlayback(spotifyUri).catch((error) => {
        console.error('Failed to start synchronized playback:', error);
        desiredSpotifyPlayback = 'paused';
        setSpotifyPlaybackState(false);
      });
    }

    // Reset playback starting flag after a short delay
    setTimeout(() => {
      isPlaybackStarting = false;
    }, 1000);
  }
});

// Function to update play/stop state in UI
function updatePlaybackStateUI(state: PlaybackUiState) {
  const mainWindow = document.getElementById('main-window');
  if (mainWindow) {
    const classes = mainWindow.className.split(' ').filter(c => c !== 'play' && c !== 'pause' && c !== 'stop');
    classes.push(state === 'playing' ? 'play' : state === 'paused' ? 'pause' : 'stop');
    mainWindow.className = classes.join(' ');
  }
}

function installAuthenticationHintStyles() {
  if (document.getElementById('spotify-auth-hint-style')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'spotify-auth-hint-style';
  style.textContent = `
    #webamp #main-window.spotify-auth-needed #about {
      display: block;
      overflow: visible;
      z-index: 20;
      filter: drop-shadow(0 0 2px #1ed760);
    }

    #webamp #main-window.spotify-auth-needed #about::after {
      content: "";
      position: absolute;
      left: -6px;
      top: -6px;
      width: 25px;
      height: 27px;
      border: 1px solid rgba(30, 215, 96, 0.95);
      background: rgba(30, 215, 96, 0.16);
      box-shadow:
        0 0 0 1px rgba(30, 215, 96, 0.35),
        0 0 6px rgba(30, 215, 96, 0.95),
        0 0 14px rgba(30, 215, 96, 0.7);
      pointer-events: none;
      animation: spotify-auth-logo-glow 1.2s ease-in-out infinite;
    }

    #webamp #main-window.spotify-auth-needed #about:hover {
      filter: drop-shadow(0 0 4px #1ed760);
    }

    #webamp #main-window.spotify-auth-needed #about:hover::after {
      background: rgba(30, 215, 96, 0.24);
      box-shadow:
        0 0 0 1px rgba(30, 215, 96, 0.55),
        0 0 8px rgba(30, 215, 96, 1),
        0 0 18px rgba(30, 215, 96, 0.85);
    }

    @keyframes spotify-auth-logo-glow {
      0%, 100% {
        opacity: 0.55;
        transform: scale(0.95);
      }
      50% {
        opacity: 1;
        transform: scale(1.08);
      }
    }
  `;
  document.head.appendChild(style);
}

// Function to generate fake analyzer data with smoother transitions
function generateAnalyzerData(numBars: number): number[] {
  const data = [];
  const transitionSpeed = 0.3; // Faster transitions like Winamp
  const canvas = getCanvas();
  if (!canvas) return Array(numBars).fill(0);

  for (let i = 0; i < numBars; i++) {
    // Target amplitude - use exponential distribution for more Winamp-like movement
    const targetAmplitude = isSpotifyPlaying 
      ? Math.pow(Math.random(), 2) * 0.9 + 0.1 // More variance in heights
      : Math.random() * 0.05;
    
    // Smoothly transition to target
    const currentAmplitude = previousAmplitudes[i];
    const newAmplitude = currentAmplitude + (targetAmplitude - currentAmplitude) * transitionSpeed;
    
    // Update peak for this bar
    if (newAmplitude >= peakAmplitudes[i]) {
      peakAmplitudes[i] = newAmplitude;
      peakHoldCounters[i] = PEAK_HOLD_TIME;
    } else {
      if (peakHoldCounters[i] > 0) {
        peakHoldCounters[i]--;
      } else {
        // Convert peak drop speed from pixels to amplitude
        const dropAmount = PEAK_DROP_SPEED / canvas.height;
        peakAmplitudes[i] = Math.max(newAmplitude, peakAmplitudes[i] - dropAmount);
      }
    }
    
    data.push(newAmplitude);
    previousAmplitudes[i] = newAmplitude;
  }
  return data;
}

// Function to adjust color brightness
function adjustColorBrightness(color: string, factor: number): string {
  const rgb = color.match(/\d+/g)?.map(Number);
  if (!rgb || rgb.length < 3) return color;
  
  return `rgb(${
    Math.min(255, Math.round(rgb[0] * factor))},${
    Math.min(255, Math.round(rgb[1] * factor))},${
    Math.min(255, Math.round(rgb[2] * factor))
  })`;
}

// Function to check if a color is transparent or too dark
function isValidColor(color: string, isBackground: boolean = false): boolean {
  const rgb = color.match(/\d+/g)?.map(Number);
  if (!rgb || rgb.length < 3) return false;
  
  // Only check if color is transparent
  if (color.includes('rgba') && rgb[3] === 0) return false;
  
  return true; // Accept all non-transparent colors
}

// Function to extract lightest color from base64 image
function getAverageColorFromBase64(base64String: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = base64String;
    
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve('rgb(0, 255, 0)'); // Fallback color
        return;
      }
      
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      
      let maxBrightness = 0;
      let lightestR = 0, lightestG = 0, lightestB = 0;
      
      // Find the pixel with highest brightness
      for (let i = 0; i < data.length; i += 4) {
        // Only consider non-transparent pixels
        if (data[i + 3] > 128) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          
          // Calculate brightness (HSL lightness formula)
          const brightness = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
          
          if (brightness > maxBrightness) {
            maxBrightness = brightness;
            lightestR = r;
            lightestG = g;
            lightestB = b;
          }
        }
      }
      
      if (maxBrightness > 0) {
        resolve(`rgb(${lightestR}, ${lightestG}, ${lightestB})`);
      } else {
        resolve('rgb(0, 255, 0)'); // Fallback color
      }
    };
    
    img.onerror = () => {
      resolve('rgb(0, 255, 0)'); // Fallback color
    };
  });
}

// Function to get theme colors from main window
async function getThemeColors(): Promise<{ low: string, mid: string, high: string, peak: string }> {
  try {
    // Find the skin style tag
    const skinStyle = document.querySelector('style#webamp-skin');
    if (!skinStyle || !skinStyle.textContent) {
      console.log('Skin style not found, using fallback colors');
      return {
        low: 'rgb(0, 255, 0)',
        mid: 'rgb(255, 255, 0)',
        high: 'rgb(255, 0, 0)',
        peak: 'rgb(255, 255, 255)'
      };
    }

    // Extract character-52 background image
    const charMatch = skinStyle.textContent.match(/#webamp \.character-52\s*{[^}]*background-image:\s*url\(([^)]+)\)/);
    if (!charMatch) {
      console.log('Character-52 style not found, using fallback colors');
      return {
        low: 'rgb(0, 255, 0)',
        mid: 'rgb(255, 255, 0)',
        high: 'rgb(255, 0, 0)',
        peak: 'rgb(255, 255, 255)'
      };
    }

    // Get the base64 image
    const base64Image = charMatch[1];
    
    // Get average color from image
    const color = await getAverageColorFromBase64(base64Image);
    console.log('Extracted color from character-52:', color);

    // Create variations
    const rgb = color.match(/\d+/g)?.map(Number);
    if (!rgb || rgb.length < 3) {
      throw new Error('Invalid color format');
    }

    // Create brighter and darker variations
    const lowColor = color;
    const midColor = adjustColorBrightness(color, 0.7);
    const highColor = adjustColorBrightness(color, 0.4);

    return {
      low: lowColor,
      mid: midColor,
      high: highColor,
      peak: 'rgb(255, 255, 255)' // Keep peaks white for visibility
    };
  } catch (error) {
    console.log('Error getting theme colors:', error);
    return {
      low: 'rgb(0, 255, 0)', // Green
      mid: 'rgb(255, 255, 0)', // Yellow
      high: 'rgb(255, 0, 0)', // Red
      peak: 'rgb(255, 255, 255)' // White
    };
  }
}

// Cache for theme colors
let cachedThemeColors: { low: string, mid: string, high: string, peak: string } | null = null;

// Function to create gradient for a bar
async function createBarGradient(ctx: CanvasRenderingContext2D, x: number, width: number, height: number, maxHeight: number): Promise<CanvasGradient> {
  const gradient = ctx.createLinearGradient(x, maxHeight, x, maxHeight - height);
  
  // Get or update cached colors
  if (!cachedThemeColors) {
    cachedThemeColors = await getThemeColors();
  }
  
  // Calculate relative height (0-1)
  const relativeHeight = height / maxHeight;
  
  if (relativeHeight <= 0.4) {
    // Low amplitude - base color variant
    gradient.addColorStop(0, cachedThemeColors.low);
    gradient.addColorStop(1, adjustColorBrightness(cachedThemeColors.low, 0.8));
  } else if (relativeHeight <= 0.7) {
    // Medium amplitude - transition to mid color
    gradient.addColorStop(0, cachedThemeColors.low);
    gradient.addColorStop(0.6, cachedThemeColors.mid);
    gradient.addColorStop(1, cachedThemeColors.low);
  } else {
    // High amplitude - full spectrum
    gradient.addColorStop(0, cachedThemeColors.low);
    gradient.addColorStop(0.5, cachedThemeColors.mid);
    gradient.addColorStop(0.8, cachedThemeColors.high);
    gradient.addColorStop(1, cachedThemeColors.low);
  }
  
  return gradient;
}

// Function to draw visualizer
async function drawVisualizer() {
  const canvas = getCanvas();
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Clear the canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Generate data for exactly 20 bars
  const NUM_BARS = 20;
  const data = generateAnalyzerData(NUM_BARS);
  
  // Calculate bar width and spacing
  const barWidth = 2; // Thinner bars
  const spacing = 6; // More space between bars
  const totalWidth = NUM_BARS * (barWidth + spacing) - spacing;
  const startX = Math.floor((canvas.width - totalWidth) / 2); // Center the bars

  // Draw each bar and its peak
  for (let i = 0; i < data.length; i++) {
    const amplitude = data[i];
    const height = Math.max(1, Math.floor(amplitude * canvas.height));
    const x = startX + i * (barWidth + spacing);
    const y = canvas.height - height;

    // Create and apply gradient for main bar
    const gradient = await createBarGradient(ctx, x, barWidth, height, canvas.height);
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, barWidth, height);
    
    // Draw peak for this bar
    const peakHeight = Math.max(1, Math.floor(peakAmplitudes[i] * canvas.height));
    const peakY = canvas.height - peakHeight;
    
    // Set peak color to white
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(x, peakY, barWidth, 1); // 1px peak line like Winamp
  }
}

// Function to start visualizer animation
function startVisualizer() {
  if (visualizerInterval) {
    clearInterval(visualizerInterval);
  }

  // Reset peaks when starting
  peakAmplitudes = Array(20).fill(0);
  peakHoldCounters = Array(20).fill(0);
  
  // Reset canvas reference to ensure we get the latest one
  canvasRef = null;

  // Reset color cache
  cachedThemeColors = null;

  visualizerInterval = setInterval(() => {
    drawVisualizer().catch(console.error);
  }, 50); // Update every 50ms
}

// Function to stop visualizer animation
function stopVisualizer() {
  if (visualizerInterval) {
    clearInterval(visualizerInterval);
    visualizerInterval = null;
  }

  // Set all bar amplitudes to 0 but keep peaks falling
  previousAmplitudes = Array(20).fill(0);
  
  // Start a new interval just for falling peaks
  visualizerInterval = setInterval(async () => {
    const canvas = getCanvas();
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear the canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Calculate bar dimensions
    const NUM_BARS = 20;
    const barWidth = 2;
    const spacing = 6;
    const totalWidth = NUM_BARS * (barWidth + spacing) - spacing;
    const startX = Math.floor((canvas.width - totalWidth) / 2);

    // Get or update theme colors
    if (!cachedThemeColors) {
      cachedThemeColors = await getThemeColors();
    }

    // Draw each bar (at zero height) and its falling peak
    for (let i = 0; i < NUM_BARS; i++) {
      const x = startX + i * (barWidth + spacing);
      
      // Draw bar at minimum height using theme color
      const gradient = await createBarGradient(ctx, x, barWidth, 1, canvas.height);
      ctx.fillStyle = gradient;
      ctx.fillRect(x, canvas.height - 1, barWidth, 1);
      
      // Update and draw peak
      if (peakAmplitudes[i] > 0) {
        const peakHeight = Math.max(1, Math.floor(peakAmplitudes[i] * canvas.height));
        const peakY = canvas.height - peakHeight;
        
        // Draw peak in white
        ctx.fillStyle = cachedThemeColors.peak;
        ctx.fillRect(x, peakY, barWidth, 1);
        
        // Make peak fall
        peakAmplitudes[i] = Math.max(0, peakAmplitudes[i] - (PEAK_DROP_SPEED / canvas.height));
      }
    }

    // Stop the interval when all peaks have fallen
    if (peakAmplitudes.every(peak => peak === 0)) {
      clearInterval(visualizerInterval);
      visualizerInterval = null;
      
      // Draw one last frame with minimal amplitudes
      drawVisualizer();
    }
  }, 50); // Update every 50ms
}

// Function to start playback state monitoring
function startPlaybackStateMonitoring() {
  clearPlaybackStateInterval();

  playbackStateInterval = setInterval(async () => {
    if (!spotifyPlayer || !isSpotifyPlaying) return;

    try {
      const state = await spotifyPlayer.getCurrentState();
      if (state) {
        if (isStaleSpotifyStateForActiveTrack(state)) {
          console.log('Ignoring stale Spotify monitor state while a new Webamp track is starting');
          return;
        }

        clearAutoAdvanceGuardForActivePlayback(state);

        // Only update if we're not seeking from Webamp
        if (!isSeekingFromWebamp) {
          lastSpotifyPosition = state.position;
        }
        if (!state.paused) {
          setSpotifyPlaybackState(true);
        }
        
        // Update document title with current track info
        if (state.track_window?.current_track) {
          const { name, artists } = state.track_window.current_track;
          document.title = `${name} - ${artists[0].name}`;
        }

        updateTimeDisplay(state.position);
        syncWebampElapsedTimeFromSpotify(state.position);
        syncSeekingBarFromSpotify(state.position, state.duration);

        if (advanceAfterSpotifyTrackEnd(state, 'playback_state_monitor')) {
          return;
        }

        // If track has been paused externally
        if (state.paused && isSpotifyPlaying) {
          if (desiredSpotifyPlayback === 'playing') {
            if (playbackStartPromise || Date.now() < suppressPausedStateUntil) {
              return;
            }

            desiredSpotifyPlayback = 'paused';
            setSpotifyPlaybackState(false, 'paused');
            clearPlaybackStateInterval();
            return;
          }

          document.title = DEFAULT_DOCUMENT_TITLE;
          setSpotifyPlaybackState(false, 'paused');
          clearPlaybackStateInterval();
        }
      }
    } catch (error) {
      console.error('Error getting playback state:', error);
    }
  }, 1000); // Update every second

  // Start the visualizer when playback starts
  startVisualizer();
  
}

// Clean up interval when window is closed
window.addEventListener('beforeunload', () => {
  if (visualizerInterval) {
    clearInterval(visualizerInterval);
    visualizerInterval = null;
  }
  clearPlaybackStateInterval();
});

// Update play/pause functions
window.webampPlay = async function () {
  if (spotifyPlayer && !isSpotifyPlaying) {
    try {
      desiredSpotifyPlayback = 'playing';
      await spotifyPlayer.resume();
      setSpotifyPlaybackState(true);
      startPlaybackStateMonitoring();
      console.log('Resumed playback');
    } catch (error) {
      console.error('Failed to resume:', error);
    }
  }
}

window.webampPause = async function () {
  if (spotifyPlayer && isSpotifyPlaying) {
    try {
      await pauseSpotifyPlayback();
      console.log('Paused playback');
    } catch (error) {
      console.error('Failed to pause:', error);
    }
  }
}

window.webampStop = async function () {
  try {
    await stopSpotifyPlayback();
    console.log('Stopped playback');
  } catch (error) {
    console.error('Failed to stop:', error);
  }
}

window.webampNext = function () {
  advanceWebampTrack('next');
}

window.webampPrevious = function () {
  advanceWebampTrack('previous');
}

// Render after the skin has loaded.
const appElement = document.getElementById('app');
if (appElement) {
  webamp.renderWhenReady(appElement).then(() => {
    window.setupRendered();
    installAuthenticationHintStyles();
    
    // Set up second visualizer
    setupSecondVisualizer();
    
    // Draw initial visualizer state
    drawVisualizer();
    
    // Set up seeking bar
    setupSeekingBar();

    // Initialize authentication UI state
    updateAuthenticationUI(false);

    // Add click handlers for About and Eject buttons
    setTimeout(() => {
      // About button for authentication
      const aboutButton = document.querySelector('#main-window #about');
      if (aboutButton) {
        aboutButton.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          initSpotifyAuth();
        }, { passive: false });
      }

      // Eject button for playlist selection
      const ejectButton = document.querySelector('#main-window #eject');
      if (ejectButton) {
        ejectButton.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (isAuthenticated) {
            showPlaylistSelector(ejectButton);
          }
        }, { passive: false });
      }

      // Set up playlist action buttons
      setupPlaylistActionButtons();

      // Add non-passive event listeners for playlist scrolling
      const playlistWindow = document.querySelector('#playlist-window');
      if (playlistWindow) {
        playlistWindow.addEventListener('wheel', (e: WheelEvent) => {
          e.preventDefault();
          const delta = e.deltaY > 0 ? 1 : -1;
          const scrollAmount = delta * 10;
          const element = playlistWindow as HTMLElement;
          element.scrollTop += scrollAmount;
        }, { passive: false });
      }
    }, 1000); // Give time for Webamp to fully initialize
  });
}

// Function to update time display
function updateTimeDisplay(positionMs: number) {
  const minutes = Math.floor(positionMs / 60000);
  const seconds = Math.floor((positionMs % 60000) / 1000);
  
  const minuteFirstDigit = Math.floor(minutes / 10);
  const minuteSecondDigit = minutes % 10;
  const secondFirstDigit = Math.floor(seconds / 10);
  const secondSecondDigit = seconds % 10;

  const minuteFirstElement = document.getElementById('minute-first-digit');
  const minuteSecondElement = document.getElementById('minute-second-digit');
  const secondFirstElement = document.getElementById('second-first-digit');
  const secondSecondElement = document.getElementById('second-second-digit');

  if (minuteFirstElement) minuteFirstElement.className = `digit digit-${minuteFirstDigit}`;
  if (minuteSecondElement) minuteSecondElement.className = `digit digit-${minuteSecondDigit}`;
  if (secondFirstElement) secondFirstElement.className = `digit digit-${secondFirstDigit}`;
  if (secondSecondElement) secondSecondElement.className = `digit digit-${secondSecondDigit}`;
}

// Add this function to handle seeking bar changes
function setupSeekingBar() {
  const seekingBar = document.getElementById('position') as HTMLInputElement;
  if (!seekingBar) return;

  ['pointerdown', 'mousedown', 'touchstart', 'keydown'].forEach((eventName) => {
    seekingBar.addEventListener(eventName, beginSeekBarUserInteraction);
  });

  ['pointerup', 'mouseup', 'touchend', 'touchcancel', 'keyup', 'blur'].forEach((eventName) => {
    seekingBar.addEventListener(eventName, endSeekBarUserInteraction);
  });

  document.addEventListener('pointerup', endSeekBarUserInteraction);
  document.addEventListener('mouseup', endSeekBarUserInteraction);
  document.addEventListener('touchend', endSeekBarUserInteraction);

  seekingBar.addEventListener('input', () => {
    const currentPercent = readSeekBarPercent();
    if (currentPercent !== null) {
      setSeekBarDraftPercent(currentPercent);
    }

    if (isSyncingSeekBarFromSpotify) return;

    lastSeekBarUserInteractionAt = Date.now();
    suppressSeekBarSyncUntil = Date.now() + SEEK_BAR_SYNC_SUPPRESSION_MS;
  }, { capture: true });

  seekingBar.addEventListener('change', async () => {
    if (!spotifyPlayer || isResumingPlayback || isSeekingFromWebamp) return;
    if (isSyncingSeekBarFromSpotify) return;

    if (Date.now() - lastSeekBarUserInteractionAt > 2000) {
      console.log('Ignoring non-user seek bar change');
      return;
    }

    try {
      const percentage = parseFloat(seekingBar.value);
      await seekSpotifyToPercent(percentage);
    } catch (error) {
      console.error('Failed to seek Spotify playback:', error);
    } finally {
      endSeekBarUserInteraction();
    }
  });
}

// Function to handle resuming playback
async function handleResume(state: SpotifyPlaybackState) {
  if (!spotifyPlayer || !currentDeviceId) return;

  try {
    isResumingPlayback = true;
    // Get current track URI
    const currentTrackUri = state.track_window?.current_track?.uri;
    if (!currentTrackUri) return;

    const position = Math.max(0, lastSpotifyPosition || state.position || 0);

    console.log('Resuming playback:', { currentTrackUri, position });

    // Get fresh token
    const tokenResponse = await fetch(`${SPOTIFY_SERVER_BASE_URL}/token`);
    const tokenData = await tokenResponse.json();
    if (tokenData.error) throw new Error('No valid token available');

    // First ensure we're the active device
    await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenData.token}`
      },
      body: JSON.stringify({
        device_ids: [currentDeviceId]
      })
    });

    // Wait for device activation
    await new Promise(resolve => setTimeout(resolve, 300));

    // Resume playback with position
    await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${currentDeviceId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenData.token}`
      },
      body: JSON.stringify({
        uris: [currentTrackUri],
        position_ms: position
      })
    });

    suppressPausedStateUntil = Date.now() + 1500;
    await new Promise(resolve => setTimeout(resolve, 500));

    desiredSpotifyPlayback = 'playing';
    activeSpotifyUri = currentTrackUri;
    setSpotifyPlaybackState(true);
    startPlaybackStateMonitoring();

    // Reset resuming flag after a delay
    setTimeout(() => {
      isResumingPlayback = false;
    }, 1000);
  } catch (error) {
    console.error('Failed to resume playback:', error);
    desiredSpotifyPlayback = 'paused';
    setSpotifyPlaybackState(false);
    isResumingPlayback = false;
  }
}

// Modify setupSecondVisualizer function
function setupSecondVisualizer() {
  // Create and insert the new visualizer
  const mainWindow = document.querySelector('#webamp #main-window');
  if (!mainWindow) return;

  const canvas = document.createElement('canvas');
  canvas.id = 'visualizer2';
  canvas.classList.add('visualizer');
  canvas.width = 152;
  canvas.height = 32;
  
  // Add positioning CSS
  canvas.style.position = 'absolute';
  canvas.style.top = '43px';
  canvas.style.left = '24px';
  canvas.style.width = '76px';
  canvas.style.height = '16px';
  
  mainWindow.appendChild(canvas);

  // Set up theme observer
  setupThemeObserver();

  // Add play/pause event listeners
  const playButton = document.querySelector('#main-window #play');
  const pauseButton = document.querySelector('#main-window #pause');
  const stopButton = document.querySelector('#main-window #stop');

  if (playButton) {
    playButton.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (isSpotifyPlaying) return;

      try {
        if (!spotifyPlayer) {
          await initSpotifyPlayer();
        }
        if (!spotifyPlayer) return;

        const state = await spotifyPlayer.getCurrentState();
        if (!state) {
          console.log('No state, reinitializing player...');
          await initSpotifyPlayer();
        }

        if (!spotifyPlayer) return;
        const currentState = await spotifyPlayer.getCurrentState();
        if (!currentState) {
          (webamp as any).play();
          return;
        }

        if (currentState.track_window?.current_track && currentState.paused) {
          await handleResume(currentState);
        } else {
          (webamp as any).play();
        }
      } catch (error) {
        console.error('Play button error:', error);
        desiredSpotifyPlayback = 'paused';
        setSpotifyPlaybackState(false);
      }
    }, { capture: true });
  }

  if (pauseButton) {
    pauseButton.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (spotifyPlayer && isSpotifyPlaying) {
        try {
          await pauseSpotifyPlayback();
          console.log('Paused playback');
        } catch (error) {
          console.error('Failed to pause:', error);
        }
      }
    }, { capture: true });
  }

  if (stopButton) {
    stopButton.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      try {
        await stopSpotifyPlayback();
        console.log('Stopped playback');
      } catch (error) {
        console.error('Failed to stop:', error);
      }
    }, { capture: true });
  }
}

// Add this function after window.onload
function setupMouseHandling() {
  // Get all Webamp windows and UI elements
  const webampWindows = ['#main-window', '#equalizer-window', '#playlist-window', '#webamp-context-menu'];
  
  // Function to check if element is part of Webamp UI
  function isWebampElement(element: HTMLElement | null): boolean {
    if (!element) return false;
    return webampWindows.some(sel => element.closest(sel)) || 
           element.closest('.spotify-playlist-wrapper') !== null ||
           element.closest('#webamp-context-menu') !== null;
  }

  // Handle mouse enter/leave for Webamp windows
  webampWindows.forEach(selector => {
    const window = document.querySelector(selector);
    if (window) {
      window.addEventListener('mouseenter', () => {
        if (!isOverWebamp) {
          isOverWebamp = true;
          ipcRenderer.send('ignoreMouseEvents', false);
        }
      });

      window.addEventListener('mouseleave', (e) => {
        const toElement = (e as MouseEvent).relatedTarget as HTMLElement;
        if (!isWebampElement(toElement)) {
          isOverWebamp = false;
          ipcRenderer.send('ignoreMouseEvents', true);
        }
      });
    }
  });

  // Handle playlist wrapper and context menu
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if ((node as HTMLElement).classList?.contains('spotify-playlist-wrapper') ||
            (node as HTMLElement).id === 'webamp-context-menu') {
          const element = node as HTMLElement;
          element.addEventListener('mouseenter', () => {
            if (!isOverWebamp) {
              isOverWebamp = true;
              ipcRenderer.send('ignoreMouseEvents', false);
            }
          });

          element.addEventListener('mouseleave', (e) => {
            const toElement = (e as MouseEvent).relatedTarget as HTMLElement;
            if (!isWebampElement(toElement)) {
              isOverWebamp = false;
              ipcRenderer.send('ignoreMouseEvents', true);
            }
          });
        }
      });
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Handle clicks outside Webamp windows
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!isWebampElement(target)) {
      isOverWebamp = false;
      ipcRenderer.send('ignoreMouseEvents', true);
    }
  });
}

// Add this line to window.onload
window.onload = async () => {
  // ... existing code ...
  
  setupMouseHandling();
  
  // Set up volume slider
  const volumeSlider = document.querySelector('input[type="range"][title="Volume Bar"]') as HTMLInputElement;
  if (volumeSlider) {
    // Set initial volume when player is ready
    const initialVolume = parseInt(volumeSlider.value) / 100;
    if (spotifyPlayer) {
      await spotifyPlayer.setVolume(initialVolume);
    }

    // Handle volume changes
    volumeSlider.addEventListener('input', async () => {
      await synchronizeVolume(volumeSlider);
    });

    // Also handle change event for when the user stops dragging
    volumeSlider.addEventListener('change', async () => {
      await synchronizeVolume(volumeSlider);
    });
  }
};

// Add these functions near the top
function disablePlaybackControls() {
  const controls = [
    '#main-window .actions #play',
    '#main-window .actions #pause',
    '#main-window .actions #stop',
    '#main-window .actions #previous',
    '#main-window .actions #next',
    '#main-window #eject'
  ];
  
  controls.forEach(selector => {
    const button = document.querySelector(selector) as HTMLElement;
    if (button) {
      button.style.pointerEvents = 'none';
      button.style.opacity = '0.5';
    }
  });
}

function enablePlaybackControls() {
  const controls = [
    '#main-window .actions #play',
    '#main-window .actions #pause',
    '#main-window .actions #stop',
    '#main-window .actions #previous',
    '#main-window .actions #next',
    '#main-window #eject'
  ];
  
  controls.forEach(selector => {
    const button = document.querySelector(selector) as HTMLElement;
    if (button) {
      button.style.pointerEvents = 'auto';
      button.style.opacity = '1';
    }
  });
}

// Add this function after the existing functions
function updateAuthenticationUI(isAuthenticated: boolean) {
  const mainWindow = document.querySelector('#main-window') as HTMLElement;
  if (mainWindow) {
    mainWindow.classList.toggle('spotify-auth-needed', !isAuthenticated);
  }

  // Disable/enable About button
  const aboutButton = document.querySelector('#main-window #about') as HTMLElement;
  if (aboutButton) {
    aboutButton.style.pointerEvents = isAuthenticated ? 'none' : 'auto';
    aboutButton.style.opacity = isAuthenticated ? '0.5' : '1';
  }

  // Disable/enable Eject button
  const ejectButton = document.querySelector('#main-window #eject') as HTMLElement;
  if (ejectButton) {
    ejectButton.style.pointerEvents = isAuthenticated ? 'auto' : 'none';
    ejectButton.style.opacity = isAuthenticated ? '1' : '0.5';
  }
}

// Function to handle volume synchronization
async function synchronizeVolume(volumeSlider: HTMLInputElement) {
  if (!spotifyPlayer || isVolumeChanging) return;

  try {
    isVolumeChanging = true;
    const volume = parseInt(volumeSlider.value) / 100;
    await spotifyPlayer.setVolume(volume);
    console.log('Volume set to:', volume);
  } catch (error) {
    console.error('Failed to set volume:', error);
  } finally {
    isVolumeChanging = false;
  }
}

// Function to set up playlist action buttons
function setupPlaylistActionButtons() {
  // Eject button
  const ejectButton = document.querySelector('.playlist-bottom-right .playlist-action-buttons .playlist-eject-button');
  if (ejectButton) {
    const clonedButton = ejectButton.cloneNode(true);
    ejectButton.parentNode?.replaceChild(clonedButton, ejectButton);
    
    clonedButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const mainEject = document.querySelector('#main-window #eject') as HTMLElement;
      if (mainEject) {
        mainEject.click();
      }
    });
  }
}

// Function to set up theme observer
function setupThemeObserver() {
  // Create observer for the entire webamp container to catch all theme changes
  const webampContainer = document.getElementById('webamp');
  if (!webampContainer) return;

  // Function to handle skin changes
  function handleSkinChange() {
    console.log('Skin change detected');
    // Reset color cache to force recalculation
    cachedThemeColors = null;
    // Wait a bit for the skin to fully load
    setTimeout(() => {
      if (visualizerInterval) {
        drawVisualizer();
      }
    }, 100);
  }

  // Watch for skin changes through the options menu
  const optionsButton = document.querySelector('#main-window #option');
  if (optionsButton) {
    optionsButton.addEventListener('click', () => {
      // Wait for the skin menu to appear
      setTimeout(() => {
        const skinMenu = document.querySelector('#webamp-context-menu');
        if (skinMenu) {
          // Add click listener to the entire menu to catch all skin selections
          skinMenu.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            if (target.closest('.skin-menu')) {
              console.log('Skin menu option clicked');
              // Wait for skin to load and check multiple times
              for (let delay of [500, 1000, 1500]) {
                setTimeout(handleSkinChange, delay);
              }
            }
          });
        }
      }, 50);
    });
  }

  // Main observer for style changes
  const observer = new MutationObserver((mutations) => {
    let shouldUpdate = false;

    for (const mutation of mutations) {
      // Check for style or class changes
      if (mutation.type === 'attributes' && 
         (mutation.attributeName === 'style' || mutation.attributeName === 'class')) {
        const target = mutation.target as HTMLElement;
        // Only trigger on main window or its direct children changes
        if (target.id === 'main-window' || target.closest('#main-window')) {
          shouldUpdate = true;
          break;
        }
      }
      
      // Check for structural changes
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        const addedNodes = Array.from(mutation.addedNodes);
        if (addedNodes.some(node => 
          node instanceof HTMLElement && (
            node.id === 'main-window' ||
            node.classList.contains('window') ||
            node.classList.contains('selected') // Detect skin selection
          ))) {
          shouldUpdate = true;
          break;
        }
      }
    }

    if (shouldUpdate) {
      handleSkinChange();
    }
  });

  // Observe the webamp container
  observer.observe(webampContainer, {
    attributes: true,
    childList: true,
    subtree: true,
    attributeFilter: ['style', 'class']
  });

  // Also observe the document body for skin menu appearance
  const bodyObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        const addedNodes = Array.from(mutation.addedNodes);
        if (addedNodes.some(node => 
          node instanceof HTMLElement && 
          (node.id === 'webamp-context-menu' || node.classList.contains('skin-menu')))) {
          console.log('Skin menu appeared');
          // Wait for potential skin change
          setTimeout(handleSkinChange, 500);
        }
      }
    }
  });

  bodyObserver.observe(document.body, {
    childList: true,
    subtree: true
  });

  console.log('Theme observers set up successfully');
}
