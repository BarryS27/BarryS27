# Aeolian

Aeolian is a zero-state, portable, metadata-first local audio player for Windows, macOS, and Linux.

This version is a **single-file, zero-dependency Go rewrite** of the original project. It bundles a custom embedded HTML5/Web Audio UI inside a compiled binary, spawning an ephemeral, zero-configuration local server and native WebView window upon launch.

It does not manage music, organize libraries, build databases, track accounts, sync data, or persist user state. It reads supported audio files directly from a user-selected folder, streams media/metadata dynamically, and plays music through a hyper-focused, pure-black one-screen listening environment.

## Product Principles

* **Files are the source of truth.** FLAC, M4A, MP3, OGG, OPUS, WAV, and AAC files are read directly from disk.
* **Metadata first.** Titles, artists, albums, artwork, and technical audio details are displayed dynamically from files.
* **Enhanced Lyrics support.** Supports both embedded lyrics and external sidecar files (`.lrc`) matching the track name, rendered inside a dedicated sidebar.
* **Stream-as-you-scan.** Leveraging Server-Sent Events (SSE), the application begins playback the moment the first valid audio file is resolved, populating the randomized queue on-the-fly without long initial loading states.
* **Zero state.** Closing Aeolian releases all runtime state. There is no playback history, favorites, ratings, session restoration, or persistent queue.
* **Zero configuration.** Aeolian does not create settings, dotfiles, or preferences on your filesystem.
* **Zero database & cache.** No IndexedDB, SQLite, or cache directory writes. Artwork and technical data are parsed completely in-memory.
* **Single-binary portable.** A single compiled executable. Copy, run, select a folder, and play.

## Single-Binary Architecture

```text
       [ Executable Binary ]
                 │
  ┌──────────────┴──────────────┐
  ▼                             ▼
Local Go Micro-Server       Native Webview (UI)
  │                             │
  ├─► SSE Scanner Stream        ├─► Localhost Interface (127.0.0.1)
  ├─► Metadata / Audio Stream   ├─► Fisher–Yates Shuffle Queue
  └─► Embedded HTML5/JS/CSS     └─► Fixed Hardware-Emulated DSP Chain
                                        │
                                        ▼
                                  System Output

```

### The Fixed DSP Chain

Every track is treated and normalized inside the Web Audio API layer with a hardcoded, studio-inspired processing chain:

* **Low Shelf:** +4 dB @ 100 Hz (Warm bass profile)
* **Peaking:** +2 dB @ 1 kHz ($Q=1$) (Vocal presence)
* **High Shelf:** +3 dB @ 8 kHz (Treble clarity)
* **Dynamics Compressor:** Threshold -18 dBFS (Restores low-level details)
* **Limiter:** Hard Knee @ -1 dBFS (Strict anti-clipping protection)

## Project Layout

Unlike multi-layered JS/Rust fullstack builds, the architecture is stripped down to an uncompromising, ultra-maintainable footprint:

```text
.
├── main.go      # Go Core (Embedded Web Server, Native Dialog Hooks, SSE Scanner)
├── go.mod       # Dependency Definition
└── go.sum       # Module Checksums

```

*Note: The entire frontend Single Page Application (HTML, dark UI styling, responsive design, typography tokens, Fisher-Yates shuffle engine, and Web Audio API DSP routing) is natively embedded directly inside `main.go` as a bundled asset string (`indexHTML`), removing external distribution requirements.*

## Native Integration

Aeolian leverages lightweight system commands to trigger native folder picking dialogs dynamically without bloated external frameworks:

* **macOS:** Dispatches asynchronous `osascript` AppleScript selectors.
* **Windows:** Dispatches native PowerShell Forms UI objects.
* **Linux:** Hooks into system fallback binaries (`zenity` or `kdialog`).

## Development and Building

To build the optimized, production-ready portable binary:

```bash
# Initialize and fetch minimal webview wrappers
go mod download

# Build a stripped, lightweight binary for production
go build -ldflags="-s -w" -o aeolian

# Run instantly
./aeolian

```

## Constraints

Aeolian strictly enforces the following rules at runtime:

* **No Client Storage:** Fully isolates itself from `localStorage`, `sessionStorage`, and `indexedDB`.
* **No File Mutation:** Operates completely as a **read-only** client against targeted music paths.
* **No Configurations:** Will never read or write `settings.json`, `config.json`, or local app data directories.
* **Strict Minimal UI:** Pure dark-mode experience constrained to a singular destination view: **Now Playing**.
