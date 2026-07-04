<p align="center">
  <a href="https://desktop.webamp.org/">
    <img src="./res/logo.svg" alt="Webamp desktop logo" width=384 height=128>
  </a>

  <h3 align="center">Webamp on Desktop with Spotify Integration</h3>

  <p align="center">
    Webamp on Desktop with Spotify integration, inspired by <a href="https://github.com/remigallego/winampify-js">Winampify-js</a> by <a href="https://github.com/remigallego">@remigallego</a>, <a href="https://github.com/durasj/webamp-desktop">Webamp Desktop</a> by <a href="https://github.com/durasj">@durasj</a>, <a href="https://github.com/captbaritone/webamp">Webamp</a> by <a href="https://github.com/captbaritone">@captbaritone</a>, and <a href="https://medium.com/@jrcharney/spotiamp-the-story-of-two-good-things-that-never-got-together-d2ca11e7e309">Spotiamp</a>.
  </p>

  <p align="center">
    Check out the original Webamp on Desktop <a href="https://desktop.webamp.org/">here</a> by <a href="https://github.com/durasj">@durasj</a> for a more functional version of the app.
  </p>

<br>

[![Screenshot of webamp desktop on Windows](./res/screen-win.gif)](https://desktop.webamp.org/) [![Screenshot of Webamp on Linux](./res/screen-linux.png)](https://desktop.webamp.org/) [![Screenshot of Webamp on Mac OS X](./res/screen-mac.png)](https://desktop.webamp.org/)

This is a gimmicky, unofficial app. It has some of the functionality of Winamp/Spotiamp; however, it still lacks many features. It is mostly a proof of concept for the look and feel. It is based on [Webamp Desktop](https://github.com/durasj/webamp-desktop), which is based on [Webamp](https://github.com/captbaritone/webamp), "a reimplementation of Winamp 2.9 in HTML5 and JavaScript" by [@captbaritone](https://github.com/captbaritone).

## Downloads
Binaries will appear soon in the releases section.

## Features

### Implemented:
```
✅ Spotify authentication
✅ Spotify playlist support
✅ Spotify liked songs support
✅ Spotify playback, controls, shuffle and volume
✅ Partial Winamp skin support
✅ Pseudo-visualizer for Spotify
```

### Planned:
```
☐ Session persistence
☐ Caching playlists and liked songs
☐ Playlist interactions (add, remove, edit)
☐ Personalized playlist support (e.g. "Discover Weekly")
☐ Likes interactions (add, remove)
☐ Spotify search support
```
### Not planned:
```
❌ Equalizer support
❌ Spotify radio support
❌ Mono/Stereo mode
❌ Balance control
❌ Anything that requires modifying the original track as it would be a violation of Spotify's terms of service
```

### Maybe:
```
☐ Full visualizer support
```
## Known issues

### Installation files are not trusted

Some operating systems, especially Windows, and some browsers do not trust the installation files because they are not digitally signed and/or commonly used yet. Unfortunately, the code-signing certificates that would help solve this problem cost hundreds of euros per year. This project does not have any funding and therefore cannot afford them. If you are worried, we recommend verifying the checksum of the files. Every commit, and therefore every published checksum, is signed in this repository.

### Poor performance on Linux

This is caused by disabled hardware acceleration on Linux. The reason is [issues with transparency in the Chromium project](https://bugs.chromium.org/p/chromium/issues/detail?id=854601#c7).

## Developing

### Prerequisites

Make sure you have the latest versions of [Node.js](https://nodejs.org/en/), [Yarn](https://yarnpkg.com/lang/en/), [Python](https://www.python.org/downloads/), and Git installed.

### Development

Clone this repository, install dependencies and run the start script:

```
git clone https://github.com/yungtry/webamp-desktop-spotify.git
cd webamp-desktop-spotify
yarn install
python3 -m pip install --upgrade castlabs-evs
python -m castlabs_evs.vmp sign-pkg node_modules\electron\dist
# Go to https://developer.spotify.com/dashboard and create an app. Add the Web API and Web Playback SDK to the app, then add the client ID and secret to the .env file. The default callback URL is http://127.0.0.1:3000/callback
# Create a .env file and add your Spotify credentials
echo "SPOTIFY_CLIENT_ID=your_client_id_here
SPOTIFY_CLIENT_SECRET=your_client_secret_here 
SPOTIFY_REDIRECT_URI=http://127.0.0.1:3000/callback" > .env
# Edit the encryption passwords in src/server/server.js and scripts/inject-env.js
yarn start
```

### Production

Placeholder for now...

```
yarn install
yarn export-build
python -m castlabs_evs.vmp sign-pkg artifacts
```


After the build has completed, you should see one window with the app and one with developer tools. To try changes, edit the code in the `./src` directory, close the current window, and run `yarn start` again.

## Kudos

This project is possible thanks to [Webamp](https://github.com/captbaritone/webamp) by [@captbaritone](https://github.com/captbaritone), [Webamp Desktop](https://github.com/durasj/webamp-desktop) by [@durasj](https://github.com/durasj), and the wonderful open-source work of others like [@jberg](https://github.com/jberg) and the authors of [many dependencies](https://github.com/yungtry/webamp-desktop-spotify/blob/master/package.json).

Thumbar icons on Windows by [Smashicons](https://smashicons.com).

## Disclaimer
This project is not affiliated with [Winamp](http://www.winamp.com/) or [Spotify](https://www.spotify.com/). All product names, logos, and brands are property of their respective owners.
