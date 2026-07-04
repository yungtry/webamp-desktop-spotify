import { Track as WebampTrack } from './webamp/webamp.bundle';

// Spotify Web Playback SDK types
declare global {
    interface Window {
        Spotify: {
            Player: new (options: SpotifyPlayerOptions) => SpotifyPlayerInstance;
        };
        onSpotifyWebPlaybackSDKReady: () => void;
    }
}

export interface SpotifyPlayerOptions {
    name: string;
    getOAuthToken: (cb: (token: string) => void) => void;
    volume?: number;
}

export type { WebampTrack };

export interface SpotifyPlayerInstance {
    addListener(event: 'ready', callback: (data: { device_id: string }) => void): void;
    addListener(event: 'not_ready', callback: (data: { device_id: string }) => void): void;
    addListener(event: 'player_state_changed', callback: (state: SpotifyPlaybackState | null) => void): void;
    addListener(event: 'initialization_error', callback: (error: SpotifyWebPlaybackError) => void): void;
    addListener(event: 'authentication_error', callback: (error: SpotifyWebPlaybackError) => void): void;
    addListener(event: 'account_error', callback: (error: SpotifyWebPlaybackError) => void): void;
    addListener(event: 'playback_error', callback: (error: SpotifyWebPlaybackError) => void): void;
    connect(): Promise<boolean>;
    disconnect(): void;
    getCurrentState(): Promise<SpotifyPlaybackState | null>;
    getVolume(): Promise<number>;
    nextTrack(): Promise<void>;
    pause(): Promise<void>;
    previousTrack(): Promise<void>;
    resume(): Promise<void>;
    seek(position_ms: number): Promise<void>;
    setName(name: string): Promise<void>;
    setVolume(volume: number): Promise<void>;
    togglePlay(): Promise<void>;
}

export interface SpotifyWebPlaybackError {
    message: string;
}

export interface SpotifyPlaybackState {
    context: {
        uri: string;
        metadata: any;
    };
    disallows: {
        pausing: boolean;
        peeking_next: boolean;
        peeking_prev: boolean;
        resuming: boolean;
        seeking: boolean;
        skipping_next: boolean;
        skipping_prev: boolean;
    };
    duration: number;
    paused: boolean;
    position: number;
    repeat_mode: number;
    shuffle: boolean;
    track_window: {
        current_track: SpotifyTrack;
        next_tracks: SpotifyTrack[];
        previous_tracks: SpotifyTrack[];
    };
}

export interface SpotifyTrackMetadata {
    artist: string;
    title: string;
}

export interface SpotifyTrack {
    album: {
        images: { url: string }[];
        name: string;
        uri: string;
    };
    artists: {
        name: string;
        uri: string;
    }[];
    duration_ms: number;
    id: string;
    is_local?: boolean;
    is_playable?: boolean;
    name: string;
    type?: string;
    uri: string;
    available_markets?: string[];
    restrictions?: {
        reason?: string;
    };
}

export interface WebampSpotifyTrack {
    spotifyUri: string;
    isSpotifyTrack: boolean;
    url?: string;
    duration?: number;
    length?: string;
    defaultName?: string;
    metaData?: {
        artist: string;
        title: string;
        spotifyUri: string;
    };
}

export interface SpotifyPlaylist {
    id: string;
    name: string;
}
