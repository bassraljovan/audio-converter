# Audio Converter

A desktop app for converting audio files in batches. It works like NCH Switch:
drop files in, pick a format, press Convert. Everything runs on your own computer
using a bundled copy of ffmpeg, so nothing is uploaded anywhere.

## What it does

- **Converts to** MP3, AAC (.m4a), OGG Vorbis, Opus, WMA, WAV, AIFF, FLAC and ALAC (Apple Lossless)
- **Reads** almost anything: MP3, WAV, FLAC, M4A/AAC, OGG, Opus, WMA, AIFF, APE, WavPack, AC3, AMR, CAF and more.
  It also pulls the audio out of video files (MP4, MOV, MKV, WebM, AVI…).
- **Batch conversion**: add whole folders (subfolders included) and convert several files at once
- **Quality controls**: bitrate, MP3 constant or variable bitrate (V0–V9), OGG quality, bit depth (8/16/24/32-bit and 32-bit float),
  FLAC compression level, sample rate and mono/stereo
- **Presets**: 320k MP3, podcast, CD quality, studio WAV, archive FLAC, Apple AAC, streaming master and voice memo
- **Effects**: loudness normalisation (−14, −16 or −23 LUFS), volume up/down, fade in/out, trim silence
- **Keeps tags and album art** (title, artist, album and cover art carry over to MP3, M4A and FLAC)
- **Safe output**: it never overwrites the original. If a file already exists you choose to keep both, replace it, or skip it.
  Half-finished files are cleaned up if you press Stop.
- **Built-in preview player** to listen to originals and converted files
- **Estimated output size** before you convert

Keyboard: `Ctrl/Cmd+O` add files · `Delete` remove selected · `Space` play/pause · `Ctrl/Cmd+A` select all.
Double-click a converted file to open it.

## Download

Get the latest build from the [Releases page](https://github.com/bassraljovan/audio-converter/releases/latest):

| Computer | File |
|---|---|
| Windows (installer) | `Audio-Converter-x.y.z-Windows-Setup.exe` |
| Windows (no install, just run) | `Audio-Converter-x.y.z-Windows-Portable.exe` |
| Mac with Apple Silicon (M1–M4) | `Audio-Converter-x.y.z-Mac-arm64.dmg` |
| Intel Mac | `Audio-Converter-x.y.z-Mac-x64.dmg` |

The app isn't code-signed, so the first launch needs one extra step:
- **Windows** says "Windows protected your PC". Click *More info*, then *Run anyway*.
- **Mac**: drag the app into Applications, then run this once in Terminal before opening it:
  ```bash
  xattr -dr com.apple.quarantine "/Applications/Audio Converter.app"
  ```

## Running from source

You need [Node.js](https://nodejs.org) (the LTS version) installed once. Then, in this folder:

```bash
npm install     # first time only, downloads Electron and ffmpeg (~200 MB)
npm start       # opens the app
```

## Making an installer to share

Build on the same kind of computer as your friend's. The ffmpeg download matches
the machine you run `npm install` on.

```bash
npm run dist:win     # on Windows → dist/Audio-Converter-1.0.0-Windows-Setup.exe and -Portable.exe
npm run dist:mac     # on a Mac   → dist/Audio-Converter-1.0.0-Mac-arm64.dmg (or -x64 on Intel)
npm run dist:linux   # on Linux   → dist/Audio-Converter-1.0.0-Linux.AppImage
```

A build you make yourself on your own Mac opens straight away, with no Terminal step.

## Publishing a new version

Bump `version` in `package.json`, commit, then push a tag:

```bash
git tag v1.0.1 && git push origin v1.0.1
```

GitHub Actions (`.github/workflows/release.yml`) builds the Windows and Mac apps and attaches them to a new release.

## Project layout

```
src/main.js      Electron main process: file dialogs, probing, running ffmpeg, progress
src/formats.js   Format list, presets and the ffmpeg arguments for each setting
src/preload.js   The small bridge between the window and the main process
src/index.html   The window
src/renderer.js  The interface: queue, settings, preview player, drag and drop
src/app.css      Styles (follows the system light/dark mode)
build/icon.png   App icon (converted to .ico/.icns at build time)
```

## Licences

The app's code is MIT. ffmpeg is bundled through the `ffmpeg-static` package and is
GPL-licensed. Its licence text ships next to the binary in `node_modules/ffmpeg-static/`.
