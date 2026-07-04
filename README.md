# Aeolian

A single-binary, local-first music player. Drop audio files onto the page and it plays — no upload, no library, no accounts.

**~4.7 MB binary · ~2 MB RAM at idle · zero runtime dependencies.**

---

## Design

Inspired by Tidal's now-playing screen: the album art *is* the background, heavily gaussian-blurred and darkened, with the sharp artwork floating above it on a subtle 3D tilt that follows the cursor. Everything else — type, controls, scrubber — stays quiet and restrained so the art carries the whole page.

- Pure void-black base (`#080808`), no warm tints
- Dual-layer crossfading background — art blurs and darkens behind the UI, fading smoothly between tracks
- Accent color is extracted live from each track's artwork (canvas pixel sampling) and tints the progress bar, glow, and active states
- A built-in frequency visualizer renders inside the art frame when a track has no embedded artwork
- One typeface, one icon weight, generous negative space

---

## How it works

1. Run the binary, open the URL it prints
2. Drag MP3 / FLAC / AAC / WAV / OGG files onto the page
3. It reads embedded ID3v2 tags (title, artist, album art) directly in the browser using the File API — nothing is uploaded to the server
4. Playback, the visualizer, and the playlist all run client-side

The Go binary's only job is serving one static HTML page. There's no upload endpoint, no database, no network calls except to your own browser.

---

## Quick start

```bash
chmod +x player-linux-amd64
./player-linux-amd64 -port 7070
# → http://localhost:7070
```

Drop a folder of songs onto the window.

---

## Controls

| Control | Action |
|---|---|
| Scrubber | Click or drag to seek |
| Volume bar | Click or drag |
| ▶/⏸ (center) | Play / pause |
| ⏮ ⏭ | Previous / next track (prev restarts if >3s in) |
| Shuffle icon | Toggle shuffle |
| Repeat icon | Cycle: off → repeat all → repeat one |
| **Tracks** pill (bottom) | Open playlist drawer |

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `← →` | Seek ±5s |
| `↑ ↓` | Volume ±5% |
| `[` `]` | Previous / next track |
| `M` | Mute toggle |
| `L` | Toggle playlist |
| `Esc` | Close playlist |

Also wired to the OS media keys / lock-screen controls via the Media Session API.

---

## Metadata support

A small ID3v2 parser (no library, ~80 lines of JS) reads:
- `TIT2` — title
- `TPE1` — artist
- `TALB` — album
- `APIC` — embedded cover art (extracted as a blob, used as both the floating art and the blurred background)

Files without usable ID3 tags fall back to the filename, and files without embedded art fall back to the live audio visualizer.

---

## Cross-compile

```bash
make cross          # Linux / macOS / Windows, amd64 + arm64
ls dist/
```

---

## Run as a system service

**macOS (launchd)**
```xml
<!-- ~/Library/LaunchAgents/com.user.player.plist -->
<key>ProgramArguments</key>
<array>
  <string>/usr/local/bin/player</string>
  <string>-port</string><string>7070</string>
</array>
<key>RunAtLoad</key><true/>
```

**Linux (systemd)**
```ini
[Unit]
Description=Player

[Service]
ExecStart=/usr/local/bin/player -port 7070
Restart=always
User=nobody

[Install]
WantedBy=default.target
```
