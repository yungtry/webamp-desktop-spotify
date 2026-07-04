import { Track } from './webamp/webamp.bundle'

declare global {
    interface Window {
        minimizeElectronWindow: () => void
        closeElectronWindow: () => void
        setupRendered: () => void
        webampOnTrackDidChange: (track: Track) => void
        webampPlay: () => void
        webampPause: () => void
        webampStop: () => void
        webampNext: () => void
        webampPrevious: () => void
        ipcRenderer: {
            send: (channel: string, ...args: any[]) => void
            on: (channel: string, func: (...args: any[]) => void) => void
            once: (channel: string, func: (...args: any[]) => void) => void
        }

        // Spectron smoke tests only
        spectronRequire: (path: string) => void
    }
}

interface SpotifyTrack {
    metaData: {
        artist: string
        title: string
    }
    url: string
    spotifyUri: string
}

interface SpotifyPlaylist {
    id: string
    name: string
}
