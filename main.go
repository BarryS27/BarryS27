// Aeolian – zero-state, portable, metadata-first local audio player.
// Single-binary Go rewrite of the original Tauri/TypeScript app.
//
// Architecture:
//   main()  ──► starts a local HTTP server on a random loopback port
//           ──► opens a native WebView window pointed at that server
//
// HTTP API (all relative, same origin):
//   GET  /                         main HTML+CSS+JS SPA
//   POST /api/pickfolder           native OS folder-picker dialog → {path}
//   GET  /api/scan?path=…          SSE stream of track JSON objects, then "done" event
//   GET  /api/artwork?path=…       raw artwork bytes from embedded tag
//   GET  /api/audio?path=…         audio file with Accept-Ranges / Range support
//   GET  /api/lrc?path=…           adjacent .lrc sidecar file content
//
// Build:
//   go build -ldflags="-H windowsgui" -o aeolian .   (Windows)
//   go build -o aeolian .                             (macOS / Linux)
//
// Dependencies:
//   github.com/dhowden/tag          – pure-Go audio tag reader
//   github.com/webview/webview_go   – CGo WebView (WKWebView/WebView2/WebKitGTK)

package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/dhowden/tag"
	webview "github.com/webview/webview_go"
)

// ── supported audio extensions ───────────────────────────────────────────────

var audioExts = map[string]bool{
	".flac": true, ".m4a": true, ".mp3": true,
	".ogg": true, ".opus": true, ".wav": true, ".aac": true,
}

var audioMIME = map[string]string{
	".mp3":  "audio/mpeg",
	".flac": "audio/flac",
	".m4a":  "audio/mp4",
	".aac":  "audio/aac",
	".ogg":  "audio/ogg",
	".opus": "audio/ogg",
	".wav":  "audio/wav",
}

// ── JSON types sent to the frontend ─────────────────────────────────────────

// Track is the JSON shape the frontend receives for each discovered file.
type Track struct {
	ID       string    `json:"id"`
	Path     string    `json:"path"`
	Filename string    `json:"filename"`
	Duration float64   `json:"duration"` // 0 initially; frontend fills from <audio>
	Metadata TrackMeta `json:"metadata"`
}

// TrackMeta mirrors the TypeScript Metadata type.
type TrackMeta struct {
	Title       *string `json:"title,omitempty"`
	Artist      *string `json:"artist,omitempty"`
	Album       *string `json:"album,omitempty"`
	AlbumArtist *string `json:"albumArtist,omitempty"`
	Composer    *string `json:"composer,omitempty"`
	Genre       *string `json:"genre,omitempty"`
	Year        *int    `json:"year,omitempty"`
	TrackNumber *int    `json:"trackNumber,omitempty"`
	DiscNumber  *int    `json:"discNumber,omitempty"`
	HasArtwork  bool    `json:"hasArtwork"`
	Lyrics      *Lyrics `json:"lyrics,omitempty"`
}

// Lyrics mirrors the TypeScript Lyrics type.
type Lyrics struct {
	Type    string `json:"type"`
	Content string `json:"content"`
}

// ── helpers ──────────────────────────────────────────────────────────────────

func strPtr(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}

func intPtr(n int) *int {
	if n == 0 {
		return nil
	}
	return &n
}

// ── metadata reading ─────────────────────────────────────────────────────────

func readMetadata(path string) (*Track, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	track := &Track{
		ID:       path,
		Path:     path,
		Filename: filepath.Base(path),
	}

	m, err := tag.ReadFrom(f)
	if err != nil {
		// File is valid audio but has no readable tags – return bare track.
		return track, nil
	}

	meta := TrackMeta{}
	meta.Title = strPtr(m.Title())
	meta.Artist = strPtr(m.Artist())
	meta.Album = strPtr(m.Album())
	meta.AlbumArtist = strPtr(m.AlbumArtist())
	meta.Composer = strPtr(m.Composer())
	meta.Genre = strPtr(m.Genre())

	if y := m.Year(); y != 0 {
		meta.Year = intPtr(y)
	}
	if tn, _ := m.Track(); tn != 0 {
		meta.TrackNumber = intPtr(tn)
	}
	if dn, _ := m.Disc(); dn != 0 {
		meta.DiscNumber = intPtr(dn)
	}
	if m.Picture() != nil {
		meta.HasArtwork = true
	}
	if lrc := m.Lyrics(); strings.TrimSpace(lrc) != "" {
		meta.Lyrics = &Lyrics{Type: "embedded", Content: lrc}
	}

	track.Metadata = meta
	return track, nil
}

// ── native folder picker ─────────────────────────────────────────────────────

func pickFolder() (string, error) {
	switch runtime.GOOS {
	case "darwin":
		out, err := exec.Command(
			"osascript", "-e", "POSIX path of (choose folder with prompt \"Select Music Folder\")",
		).Output()
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(out)), nil

	case "windows":
		ps := `Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Select Music Folder'
if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }`
		out, err := exec.Command("powershell", "-NoProfile", "-Command", ps).Output()
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(out)), nil

	default:
		// Linux – try zenity, then kdialog, then xdg-open fallback.
		if out, err := exec.Command(
			"zenity", "--file-selection", "--directory", "--title=Select Music Folder",
		).Output(); err == nil {
			return strings.TrimSpace(string(out)), nil
		}
		if out, err := exec.Command(
			"kdialog", "--getexistingdirectory", homeDir(), "--title", "Select Music Folder",
		).Output(); err == nil {
			return strings.TrimSpace(string(out)), nil
		}
		return "", fmt.Errorf("no native folder picker found (install zenity or kdialog)")
	}
}

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return "/"
}

// ── HTTP handlers ────────────────────────────────────────────────────────────

func handlePickFolder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	path, err := pickFolder()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"path": path})
}

func handleScan(w http.ResponseWriter, r *http.Request) {
	folder := r.URL.Query().Get("path")
	if folder == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	ctx := r.Context()
	_ = filepath.Walk(folder, func(path string, info os.FileInfo, err error) error {
		select {
		case <-ctx.Done():
			return filepath.SkipAll
		default:
		}
		if err != nil || info.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(path))
		if !audioExts[ext] {
			return nil
		}

		track, err := readMetadata(path)
		if err != nil {
			return nil
		}

		data, err := json.Marshal(track)
		if err != nil {
			return nil
		}

		fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
		return nil
	})

	fmt.Fprintf(w, "event: done\ndata: {}\n\n")
	flusher.Flush()
}

func handleArtwork(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	f, err := os.Open(path)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer f.Close()

	m, err := tag.ReadFrom(f)
	if err != nil {
		http.Error(w, "no tags", http.StatusNotFound)
		return
	}

	pic := m.Picture()
	if pic == nil {
		http.Error(w, "no artwork", http.StatusNotFound)
		return
	}

	mime := pic.MIMEType
	if mime == "" {
		mime = "image/jpeg"
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(pic.Data)
}

func handleAudio(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	f, err := os.Open(path)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		http.Error(w, "stat failed", http.StatusInternalServerError)
		return
	}

	ext := strings.ToLower(filepath.Ext(path))
	ct, ok := audioMIME[ext]
	if !ok {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Accept-Ranges", "bytes")

	// http.ServeContent handles Range, ETag, Last-Modified.
	http.ServeContent(w, r, stat.Name(), stat.ModTime(), f)
}

func handleLRC(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	lrcPath := strings.TrimSuffix(path, filepath.Ext(path)) + ".lrc"
	data, err := os.ReadFile(lrcPath)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write(data)
}

// ── main ─────────────────────────────────────────────────────────────────────

func main() {
	// Bind on a random loopback port.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(fmt.Errorf("aeolian: failed to bind: %w", err))
	}
	port := ln.Addr().(*net.TCPAddr).Port

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = fmt.Fprint(w, indexHTML)
	})
	mux.HandleFunc("/api/pickfolder", handlePickFolder)
	mux.HandleFunc("/api/scan", handleScan)
	mux.HandleFunc("/api/artwork", handleArtwork)
	mux.HandleFunc("/api/audio", handleAudio)
	mux.HandleFunc("/api/lrc", handleLRC)

	go func() {
		if err := http.Serve(ln, mux); err != nil && err != http.ErrServerClosed {
			panic(err)
		}
	}()

	url := fmt.Sprintf("http://127.0.0.1:%d", port)

	w := webview.New(false)
	defer w.Destroy()
	w.SetTitle("Aeolian")
	w.SetSize(960, 720, webview.HintNone)
	w.Navigate(url)
	w.Run()
}

// ── embedded SPA ─────────────────────────────────────────────────────────────

const indexHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<meta name="color-scheme" content="dark"/>
<title>Aeolian</title>
<style>
:root {
  color-scheme: dark;
  --z-background: 0;
  --z-base: 1;
  --z-surface: 2;
  --z-interactive: 3;
  --z-overlay: 4;
  --z-system-root: 5;
  --space-4: 4px;
  --space-8: 8px;
  --space-16: 16px;
  --space-24: 24px;
  --space-40: 40px;
  --space-64: 64px;
  --radius-4: 4px;
  --radius-8: 8px;
  --radius-12: 12px;
  --radius-16: 16px;
  --motion-curve: cubic-bezier(0.25, 1, 0.5, 1);
  --motion-120: 120ms;
  --motion-240: 240ms;
  --motion-480: 480ms;
  font-family: "Segoe UI", "SF Pro Display", system-ui, sans-serif;
  font-weight: 400;
  background: #111820;
  color: #eef1f8;
}
*{box-sizing:border-box;}
body{margin:0;min-height:100vh;overflow:hidden;background:linear-gradient(145deg,#111820,#191827);}
button{font:inherit;font-size:16px;line-height:1.125;letter-spacing:.04em;color:inherit;border:0;cursor:pointer;transition:transform var(--motion-120) var(--motion-curve),background var(--motion-240) var(--motion-curve);}
button:active{transform:scale(0.96);}
#app{min-height:100vh;position:relative;z-index:var(--z-system-root);}
.artwork-environment{
  position:fixed;inset:calc(var(--space-64)*-1);z-index:var(--z-background);
  background:var(--artwork-image);background-size:cover;background-position:center;
  filter:blur(40px) brightness(0.56) saturate(0.72);
  transform:scale(1.4);opacity:.88;
  transition:opacity var(--motion-480) var(--motion-curve),filter var(--motion-480) var(--motion-curve);
}
.artwork-environment.is-playing{animation:drift 12s var(--motion-curve) infinite alternate;}
.artwork-environment.is-paused{animation:none;}
.shuffle-ceremony .artwork-environment{animation:ceremony var(--motion-480) var(--motion-curve);}
.now-playing{
  position:relative;z-index:var(--z-base);min-height:100vh;
  display:grid;grid-template-rows:auto 1fr auto auto;gap:var(--space-24);
  padding:var(--space-40);place-items:center;
  background:radial-gradient(circle at center,rgba(45,47,72,.24),rgba(17,24,32,.64));
}
.metadata-trigger{
  z-index:var(--z-interactive);padding:var(--space-16) var(--space-24);
  border-radius:var(--radius-16);background:rgba(25,28,39,.24);backdrop-filter:blur(16px);
}
.metadata-trigger h1{margin:0;font-size:24px;font-weight:400;line-height:1.125;letter-spacing:.04em;}
.metadata-trigger p{margin:var(--space-8) 0 0;font-size:16px;line-height:1.414;letter-spacing:.08em;color:rgba(238,241,248,.8);}
.lyrics-panel{display:grid;gap:var(--space-8);text-align:center;min-height:calc(var(--space-40)*9);align-content:center;}
.lyric-line{margin:0;font-size:16px;line-height:1.414;letter-spacing:.08em;transition:opacity var(--motion-240) var(--motion-curve),transform var(--motion-240) var(--motion-curve);}
.lyric-line.is-current{font-size:24px;line-height:1.125;letter-spacing:.04em;text-shadow:0 0 16px rgba(166,174,214,.4);}
.depth-0{opacity:1;}.depth-1{opacity:.8;}.depth-2{opacity:.6;}.depth-3{opacity:.4;}.depth-4{opacity:.2;}
.transport{width:100%;display:grid;gap:var(--space-24);z-index:var(--z-surface);}
.progress{height:var(--space-4);border-radius:var(--radius-4);background:rgba(129,135,166,.24);overflow:hidden;cursor:pointer;}
.progress span{display:block;height:100%;border-radius:var(--radius-4);background:rgba(201,207,232,.88);box-shadow:0 0 16px rgba(166,174,214,.4);transition:width .25s linear;}
.controls{display:flex;justify-content:center;gap:var(--space-16);}
.icon-button,.folder-button{
  display:grid;place-items:center;min-width:var(--space-64);min-height:var(--space-64);
  border-radius:var(--radius-16);background:rgba(29,32,45,.56);
  backdrop-filter:blur(16px) saturate(1.2);box-shadow:0 16px 40px rgba(12,16,24,.4);
}
.icon-button svg{width:24px;height:24px;}
.icon-button.primary{background:rgba(52,57,83,.72);}
.icon-button.active{background:rgba(72,79,120,.72);}
.folder-button{padding:var(--space-16) var(--space-24);min-width:auto;}
.metadata-sheet{
  position:fixed;z-index:var(--z-overlay);left:var(--space-24);right:var(--space-24);bottom:0;
  height:70vh;padding:var(--space-24);border-radius:var(--radius-16) var(--radius-16) 0 0;
  background:rgba(25,28,39,.72);backdrop-filter:blur(24px) saturate(1.2);
  transform:translateY(100%);opacity:0;
  transition:transform var(--motion-480) var(--motion-curve),opacity var(--motion-480) var(--motion-curve);
}
.metadata-sheet.is-open{transform:translateY(0);opacity:1;}
.metadata-sleeve{display:grid;gap:var(--space-16);overflow:auto;max-height:100%;}
.metadata-sleeve span{font-size:8px;line-height:1.414;letter-spacing:.08em;opacity:.6;display:block;}
.metadata-sleeve p{margin:var(--space-4) 0 0;font-size:16px;line-height:1.414;letter-spacing:.08em;word-break:break-all;}
.status-bar{font-size:12px;opacity:.5;text-align:center;padding:var(--space-8);}
@keyframes drift{
  from{transform:scale(1.4) translate3d(calc(var(--space-8)*-1),calc(var(--space-4)*-1),0) rotate(-1deg);}
  to{transform:scale(1.4) translate3d(var(--space-8),var(--space-4),0) rotate(1deg);}
}
@keyframes ceremony{
  from{transform:scale(1.4) rotate(-1deg);}
  to{transform:scale(1.4) rotate(1deg);}
}
</style>
</head>
<body>
<section id="app"></section>
<script>
'use strict';

// ── Icons ─────────────────────────────────────────────────────────────────────
const icons = {
  play:     '<svg viewBox="0 0 256 256" aria-hidden="true"><path fill="currentColor" d="M232.4 114.5 88.3 26.4A16 16 0 0 0 64 40v176a16 16 0 0 0 24.3 13.6l144.1-88.1a16 16 0 0 0 0-27Z"/></svg>',
  pause:    '<svg viewBox="0 0 256 256" aria-hidden="true"><path fill="currentColor" d="M96 40H72a16 16 0 0 0-16 16v144a16 16 0 0 0 16 16h24a16 16 0 0 0 16-16V56a16 16 0 0 0-16-16Zm88 0h-24a16 16 0 0 0-16 16v144a16 16 0 0 0 16 16h24a16 16 0 0 0 16-16V56a16 16 0 0 0-16-16Z"/></svg>',
  lyrics:   '<svg viewBox="0 0 256 256" aria-hidden="true"><path fill="currentColor" d="M208 40v128a40 40 0 1 1-16-32V72H96v112a40 40 0 1 1-16-32V56a16 16 0 0 1 16-16Z"/></svg>',
  shuffle:  '<svg viewBox="0 0 256 256" aria-hidden="true"><path fill="currentColor" d="M237.7 178.3a8.2 8.2 0 0 1 0 11.4l-32 32a8.1 8.1 0 0 1-11.4-11.4L212.7 192H200c-53.7 0-79.6-37.9-102.4-71.3C76 89.1 57.3 64 24 64a8 8 0 0 1 0-16c42.1 0 65.4 34.1 86.8 65.2C133.5 146.4 154.9 176 200 176h12.7l-18.4-18.3a8.1 8.1 0 0 1 11.4-11.4ZM144.7 96.6a8 8 0 0 0 11.1-2.1C168.2 76.9 181.8 64 200 64h12.7l-18.4 18.3a8.1 8.1 0 0 0 11.4 11.4l32-32a8.2 8.2 0 0 0 0-11.4l-32-32a8.1 8.1 0 0 0-11.4 11.4L212.7 48H200c-25.7 0-43.5 16.4-57.4 36.4a8 8 0 0 0 2.1 12.2ZM111.3 159.4a8 8 0 0 0-11.1 2.1C87.8 179.1 74.2 192 56 192H24a8 8 0 0 0 0 16h32c25.7 0 43.5-16.4 57.4-36.4a8 8 0 0 0-2.1-12.2Z"/></svg>',
  previous: '<svg viewBox="0 0 256 256" aria-hidden="true"><path fill="currentColor" d="M208 47.9v160.2a16 16 0 0 1-24.4 13.6L80 157.9V216a8 8 0 0 1-16 0V40a8 8 0 0 1 16 0v58.1l103.6-63.8A16 16 0 0 1 208 47.9Z"/></svg>',
  next:     '<svg viewBox="0 0 256 256" aria-hidden="true"><path fill="currentColor" d="M192 40v176a8 8 0 0 1-16 0v-58.1L72.4 221.7A16 16 0 0 1 48 208.1V47.9a16 16 0 0 1 24.4-13.6L176 98.1V40a8 8 0 0 1 16 0Z"/></svg>',
};

// ── Gradient fallback ─────────────────────────────────────────────────────────
function generatedGradient(seed) {
  let hash = 0;
  for (const c of seed) hash = ((hash * 31) + c.charCodeAt(0)) >>> 0;
  const hueA = 220 + (hash % 24);
  const hueB = 260 + ((hash >>> 8) % 24);
  return 'radial-gradient(circle at 24% 16%, hsl(' + hueA + ' 28% 24%), transparent 64%), ' +
         'radial-gradient(circle at 80% 72%, hsl(' + hueB + ' 24% 18%), transparent 64%), ' +
         'linear-gradient(145deg, #111820, #191827)';
}

// ── LRC parser ────────────────────────────────────────────────────────────────
const timestampPat = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;

function parseLrc(content) {
  const lines = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const matches = [...rawLine.matchAll(timestampPat)];
    if (!matches.length) continue;
    const text = rawLine.replace(timestampPat, '').trim();
    for (const m of matches) {
      const mins = Number(m[1]);
      const secs = Number(m[2]);
      const frac = Number((m[3] ?? '0').padEnd(3, '0')) / 1000;
      lines.push({ time: mins * 60 + secs + frac, text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

function getNineLineWindow(lines, currentTime) {
  if (!lines.length) return [];
  let foundIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].time <= currentTime) { foundIndex = i; break; }
  }
  const ci = Math.max(0, foundIndex);
  const visible = [];
  for (let offset = -4; offset <= 4; offset++) {
    const line = lines[ci + offset];
    if (line) visible.push({ ...line, depth: Math.abs(offset), current: offset === 0 });
  }
  return visible;
}

// ── Fisher–Yates shuffle ──────────────────────────────────────────────────────
function fisherYates(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Display helpers ───────────────────────────────────────────────────────────
const forbiddenFallbacks = new Set(['Unknown Artist','Unknown Album','No Lyrics','No Artwork','Missing Metadata']);
function visible(v) {
  const t = (v ?? '').toString().trim();
  return t && !forbiddenFallbacks.has(t) ? t : null;
}
function displayTitle(track)  { return visible(track.metadata.title)  ?? track.filename; }
function displayArtist(track) { return visible(track.metadata.artist); }
function displayAlbum(track)  { return visible(track.metadata.album); }
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function formatDuration(s) {
  if (!Number.isFinite(s) || s <= 0) return null;
  const m = Math.floor(s / 60), r = String(Math.floor(s % 60)).padStart(2,'0');
  return m + ':' + r;
}

// ── Web Audio DSP chain ───────────────────────────────────────────────────────
let audioCtx = null;
let sourceNode = null;
const audioEl = new Audio();
audioEl.preload = 'auto';
audioEl.crossOrigin = 'anonymous';

function ensureAudioGraph() {
  if (audioCtx) return;
  audioCtx = new AudioContext();
  sourceNode = audioCtx.createMediaElementSource(audioEl);

  // Low shelf +4 dB @ 100 Hz
  const low = audioCtx.createBiquadFilter();
  low.type = 'lowshelf'; low.frequency.value = 100; low.gain.value = 4;

  // Mid presence +2 dB @ 1 kHz Q=1
  const mid = audioCtx.createBiquadFilter();
  mid.type = 'peaking'; mid.frequency.value = 1000; mid.gain.value = 2; mid.Q.value = 1;

  // High shelf +3 dB @ 8 kHz
  const high = audioCtx.createBiquadFilter();
  high.type = 'highshelf'; high.frequency.value = 8000; high.gain.value = 3;

  // Compressor –18 dBFS, ratio 3, fast attack
  const comp = audioCtx.createDynamicsCompressor();
  comp.threshold.value = -18; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.2;

  // Limiter –1 dBFS, hard knee
  const lim = audioCtx.createDynamicsCompressor();
  lim.threshold.value = -1; lim.knee.value = 0; lim.ratio.value = 20;
  lim.attack.value = 0.003; lim.release.value = 0.05;

  sourceNode.connect(low).connect(mid).connect(high).connect(comp).connect(lim).connect(audioCtx.destination);
}

// ── Application state ─────────────────────────────────────────────────────────
const state = {
  tracks: [],        // all discovered Track objects
  queue: [],         // shuffled queue (Track refs)
  currentIndex: -1,
  currentTrack: null,
  isPlaying: false,
  progress: 0,
  duration: 0,
  scanning: false,
  scanCount: 0,
  metadataOpen: false,
  lyricsVisible: true,
  lrcLines: [],      // parsed LRC lines for currentTrack
};

// ── Audio event wiring ────────────────────────────────────────────────────────
audioEl.addEventListener('timeupdate', () => {
  state.progress = audioEl.currentTime;
  render();
});
audioEl.addEventListener('durationchange', () => {
  const d = audioEl.duration;
  state.duration = Number.isFinite(d) ? d : 0;
  if (state.currentTrack) state.currentTrack.duration = state.duration;
  render();
});
audioEl.addEventListener('ended', () => { void next(); });
audioEl.addEventListener('error', () => { void next(); });
audioEl.addEventListener('play',  () => { state.isPlaying = true;  render(); });
audioEl.addEventListener('pause', () => { state.isPlaying = false; render(); });

// ── Player actions ────────────────────────────────────────────────────────────
async function loadTrackAtIndex(index, autoplay) {
  const track = state.queue[index];
  if (!track) return;
  state.currentIndex = index;
  state.currentTrack = track;
  state.progress = 0;
  state.duration = track.duration || 0;

  // Fetch LRC sidecar if no embedded lyrics
  if (!track.metadata.lyrics) {
    await fetchLrc(track);
  } else {
    state.lrcLines = parseLrc(track.metadata.lyrics.content);
  }

  ensureAudioGraph();
  await audioCtx.resume();
  audioEl.src = '/api/audio?path=' + encodeURIComponent(track.path);
  audioEl.load();
  if (autoplay) {
    try { await audioEl.play(); } catch(e) { /* autoplay blocked */ }
  }
  render();
}

async function fetchLrc(track) {
  try {
    const res = await fetch('/api/lrc?path=' + encodeURIComponent(track.path));
    if (res.ok) {
      const text = await res.text();
      state.lrcLines = parseLrc(text);
      track.metadata.lyrics = { type: 'lrc', content: text };
    } else {
      state.lrcLines = [];
    }
  } catch(_) {
    state.lrcLines = [];
  }
}

async function play() {
  if (!state.queue.length) return;
  const idx = state.currentIndex < 0 ? 0 : state.currentIndex;
  await loadTrackAtIndex(idx, true);
}

function pause() {
  audioEl.pause();
}

async function resume() {
  ensureAudioGraph();
  await audioCtx.resume();
  try { await audioEl.play(); } catch(e) {}
}

async function next() {
  if (!state.queue.length) return;
  let nextIdx = state.currentIndex + 1;
  if (nextIdx >= state.queue.length) {
    // Regenerate shuffle queue
    state.queue = fisherYates(state.tracks);
    nextIdx = 0;
    document.getElementById('app').classList.add('shuffle-ceremony');
    setTimeout(() => document.getElementById('app').classList.remove('shuffle-ceremony'), 480);
  }
  await loadTrackAtIndex(nextIdx, true);
}

async function previous() {
  if (!state.queue.length) return;
  const prevIdx = Math.max(0, state.currentIndex - 1);
  await loadTrackAtIndex(prevIdx, true);
}

// ── Folder selection & scanning ───────────────────────────────────────────────
async function chooseFolder() {
  try {
    const res = await fetch('/api/pickfolder', { method: 'POST' });
    if (!res.ok) { alert('Could not open folder picker.'); return; }
    const { path } = await res.json();
    if (path) await startScan(path);
  } catch(e) {
    alert('Folder picker error: ' + e.message);
  }
}

async function startScan(folderPath) {
  // Reset everything
  state.tracks = [];
  state.queue = [];
  state.currentIndex = -1;
  state.currentTrack = null;
  state.isPlaying = false;
  state.progress = 0;
  state.duration = 0;
  state.scanning = true;
  state.scanCount = 0;
  state.lrcLines = [];
  audioEl.pause();
  audioEl.removeAttribute('src');
  render();

  const evtSource = new EventSource('/api/scan?path=' + encodeURIComponent(folderPath));
  let autoStarted = false;

  evtSource.onmessage = (e) => {
    const track = JSON.parse(e.data);
    state.tracks.push(track);
    state.scanCount = state.tracks.length;

    if (!autoStarted) {
      // Start playing as soon as the first track arrives
      autoStarted = true;
      state.queue = fisherYates(state.tracks);
      void loadTrackAtIndex(0, true);
    } else {
      // Keep queue growing: append new track at end
      state.queue = [...state.queue, track];
    }
    render();
  };

  evtSource.addEventListener('done', () => {
    evtSource.close();
    state.scanning = false;
    // Final re-shuffle now that we have everything
    if (!state.isPlaying && state.tracks.length) {
      state.queue = fisherYates(state.tracks);
    }
    render();
  });

  evtSource.onerror = () => {
    evtSource.close();
    state.scanning = false;
    render();
  };
}

// ── Progress bar seeking ──────────────────────────────────────────────────────
function handleProgressClick(e) {
  const bar = e.currentTarget;
  const pct = e.offsetX / bar.offsetWidth;
  const target = pct * (state.duration || 0);
  audioEl.currentTime = Math.max(0, target);
  state.progress = audioEl.currentTime;
  render();
}

// ── Metadata sheet artwork URL ────────────────────────────────────────────────
function artworkCssImage(track) {
  if (!track) return generatedGradient('aeolian');
  if (track.metadata.hasArtwork) {
    return 'url(/api/artwork?path=' + encodeURIComponent(track.path) + ')';
  }
  return generatedGradient(track.id);
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  const root = document.getElementById('app');
  const t = state.currentTrack;
  const title  = t ? displayTitle(t)  : 'Aeolian';
  const artist = t ? displayArtist(t) : null;
  const pct = state.duration > 0 ? Math.min(100, (state.progress / state.duration) * 100) : 0;
  const artwork = artworkCssImage(t);

  // Lyrics
  let lyricsHtml = '<section class="lyrics-panel" aria-hidden="true"></section>';
  if (t && state.lyricsVisible && state.lrcLines.length) {
    const window = getNineLineWindow(state.lrcLines, state.progress);
    lyricsHtml = '<section class="lyrics-panel">' +
      window.map(l =>
        '<p class="lyric-line depth-' + l.depth + (l.current ? ' is-current' : '') + '">' +
        escapeHtml(l.text) + '</p>'
      ).join('') + '</section>';
  } else if (t && state.lyricsVisible && t.metadata.lyrics && !state.lrcLines.length) {
    // Plain (non-timestamped) embedded lyrics
    const plain = t.metadata.lyrics.content.trim().split(/\r?\n/).slice(0, 9);
    lyricsHtml = '<section class="lyrics-panel">' +
      plain.map((line,i) =>
        '<p class="lyric-line depth-' + Math.abs(i-4) + (i===0?'':'')+'">' +
        escapeHtml(line) + '</p>'
      ).join('') + '</section>';
  } else if (!state.lyricsVisible || !t) {
    lyricsHtml = '<section class="lyrics-panel" aria-hidden="true"></section>';
  }

  // Metadata sheet rows
  let metaHtml = '';
  if (t) {
    const rows = [
      ['Title',        t.metadata.title],
      ['Artist',       t.metadata.artist],
      ['Album',        t.metadata.album],
      ['Album Artist', t.metadata.albumArtist],
      ['Composer',     t.metadata.composer],
      ['Genre',        t.metadata.genre],
      ['Year',         t.metadata.year],
      ['Track',        t.metadata.trackNumber],
      ['Disc',         t.metadata.discNumber],
      ['Duration',     formatDuration(t.duration)],
      ['Path',         t.path],
    ].filter(([,v]) => v !== undefined && v !== null && String(v).trim() !== '');
    metaHtml =
      '<aside class="metadata-sheet' + (state.metadataOpen ? ' is-open' : '') + '" aria-hidden="' + (state.metadataOpen?'false':'true') + '">' +
      '<div class="metadata-sleeve">' +
      rows.map(([l,v]) => '<div><span>' + escapeHtml(String(l)) + '</span><p>' + escapeHtml(String(v)) + '</p></div>').join('') +
      '</div></aside>';
  }

  // Status bar
  const statusText = state.scanning
    ? 'Scanning\u2026 ' + state.scanCount + ' tracks found'
    : state.tracks.length
      ? state.tracks.length + ' tracks'
      : '';

  root.innerHTML =
    '<div class="artwork-environment ' + (state.isPlaying ? 'is-playing' : 'is-paused') +
    '" style="--artwork-image: ' + artwork + '"></div>' +
    '<main class="now-playing">' +
    '<button class="metadata-trigger" id="metaTrigger">' +
    '<h1>' + escapeHtml(title) + '</h1>' +
    (artist ? '<p>' + escapeHtml(artist) + '</p>' : '') +
    '</button>' +
    lyricsHtml +
    '<section class="transport">' +
    '<div class="progress" id="progressBar" aria-label="Playback progress">' +
    '<span style="width:' + pct + '%"></span></div>' +
    '<div class="controls">' +
    '<button class="icon-button" id="btnPrev" aria-label="Previous">' + icons.previous + '</button>' +
    '<button class="icon-button primary" id="btnPlay" aria-label="' + (state.isPlaying?'Pause':'Play') + '">' + (state.isPlaying?icons.pause:icons.play) + '</button>' +
    '<button class="icon-button' + (state.lyricsVisible?' active':'') + '" id="btnLyrics" aria-label="Lyrics">' + icons.lyrics + '</button>' +
    '<button class="icon-button" id="btnShuffle" aria-label="Shuffle">' + icons.shuffle + '</button>' +
    '<button class="icon-button" id="btnNext" aria-label="Next">' + icons.next + '</button>' +
    '</div></section>' +
    '<button class="folder-button" id="btnFolder">' + (state.scanning ? 'Scanning\u2026' : 'Select Folder') + '</button>' +
    (statusText ? '<div class="status-bar">' + escapeHtml(statusText) + '</div>' : '') +
    '</main>' +
    metaHtml;

  // Bind events
  document.getElementById('btnFolder')?.addEventListener('click', () => void chooseFolder());
  document.getElementById('btnPlay')?.addEventListener('click', () => {
    if (state.isPlaying) { pause(); }
    else if (state.currentTrack) { void resume(); }
    else { void play(); }
  });
  document.getElementById('btnPrev')?.addEventListener('click', () => void previous());
  document.getElementById('btnNext')?.addEventListener('click', () => void next());
  document.getElementById('btnLyrics')?.addEventListener('click', () => {
    state.lyricsVisible = !state.lyricsVisible; render();
  });
  document.getElementById('btnShuffle')?.addEventListener('click', () => {
    if (!state.tracks.length) return;
    const cur = state.currentTrack;
    state.queue = fisherYates(state.tracks);
    if (cur) {
      // Put current track first so playback continues uninterrupted
      const idx = state.queue.findIndex(t => t.id === cur.id);
      if (idx > 0) {
        state.queue.splice(idx, 1);
        state.queue.unshift(cur);
      }
      state.currentIndex = 0;
    }
    root.classList.add('shuffle-ceremony');
    setTimeout(() => root.classList.remove('shuffle-ceremony'), 480);
    render();
  });
  document.getElementById('metaTrigger')?.addEventListener('click', () => {
    state.metadataOpen = !state.metadataOpen; render();
  });
  document.getElementById('progressBar')?.addEventListener('click', handleProgressClick);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
render();
</script>
</body>
</html>`
