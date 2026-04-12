# Aeolian Axioms

These are the governing principles of Aeolian — both the product it is and the code it is written in.
They are not aspirational. Every line already obeys them.

---

## I. Product Axioms

### 1. Zero startup friction
The only valid entry point is a file drop or a URL paste.
No accounts. No onboarding. No settings screen. No splash.
If a user lands on the page and cannot begin playing within three seconds, the design has failed.

### 2. The player owns no content
Aeolian does not host, store, transcode, or distribute audio.
It resolves streams that already exist on platforms the user has chosen to use.
The copyright notice in the footer is not a legal disclaimer — it is a product statement.

### 3. Features are modules, not entanglements
Each feature (queue, history, aura visualiser, YouTube resolution) can be removed
without touching the other features. If removing one breaks another, the boundary is wrong.

### 4. Supported formats are explicit, not inferred
The MIME allowlist and extension regex in `AeolianApp.tsx` are the canonical definition
of what Aeolian accepts. There is no "try it and see". Unknown types are rejected with a message.

### 5. Every error is recoverable
No error state is a dead end. Every error surface has one exit: a "Try again" action
that returns the player to the idle state. The user is never trapped.

### 6. Expiry is handled silently
YouTube streams expire after approximately six hours. The player detects this,
re-resolves the stream, and resumes — without user intervention and without showing an error.
Silent recovery is product quality; noisy recovery is a bug report.

### 7. History is local and bounded
Playback history is stored in `localStorage` under a single key.
It is capped at 20 entries. It is never synced, never sent anywhere, never shown to anyone else.
Local-source tracks (files the user drops in) are excluded from history — they are not replayable by URL.

### 8. The queue is additive only
Tracks are appended to the queue. There is no reorder, no remove, no shuffle.
These are absent because they introduce UI complexity that conflicts with axiom 1.
Add them only if the absence becomes a meaningful complaint from real users.

### 9. The visualiser is ambient, not decorative
The Aura canvas reflects actual audio data when playing.
When idle it breathes slowly. It never animates for its own sake.
Its colours shift toward the dominant hue of the track's cover art — the visual and audio are connected.

### 10. The aesthetic is sparse and honest
Dark background. One accent colour (teal). Typography from two typefaces only (Cormorant for display,
Syne for UI). No gradients on text. No card shadows without a reason.
The design should feel like an instrument, not an app.

---

## II. Code Axioms

### 1. No line contains multiple statements
A line ends with either an opening brace, a closing brace, a single declaration,
a single expression, or a single return. Semicolons do not appear mid-line.
This is not a style preference — it is the minimum condition for a diff to be readable.

```ts
// Wrong
setState(p => ({ ...p, isPlaying: false, isLoading: false, error: null }));

// Right
setState(p => ({
  ...p,
  isPlaying: false,
  isLoading: false,
  error:     null,
}));
```

### 2. No dead code
If a variable is declared and never read, delete it.
If a function is defined and never called, delete it.
If a CSS class is written and never referenced, delete it.
Commented-out code is dead code with extra steps.

### 3. No duplicate logic
If the same operation appears in two places, it becomes a function.
`resolveStream()` exists because both `handleURL` and the YouTube expiry recovery
needed to call `/api/resolve`. The second implementation was the signal to extract.

### 4. No noise comments
A comment must say something the code cannot say itself.
`// ── Section divider ──────────────────` says nothing. Delete it.
`// Guards against the synthetic MediaError(4) fired by audio.src='' during clear/load.`
says something the code cannot — keep it.

### 5. Every resource acquired is released in the same scope
| Resource | Acquisition | Release |
|---|---|---|
| `addEventListener` | `useEffect` body | same effect's cleanup, via `handlers[]` array |
| `requestAnimationFrame` | `draw()` | cleanup: `cancelAnimationFrame(rafRef.current)` |
| `ResizeObserver` | `new ResizeObserver(resize)` | cleanup: `ro.disconnect()` |
| `URL.createObjectURL` | `handleFile` | `revokeObjUrls()` on unmount and on reset |
| `AbortController` | `handleURL`, YT expiry effect | cleanup return or `.abort()` before re-issue |
| `AudioContext` | `ensureAudioContext()` | `audioCtxRef.current?.close()` on unmount |

If you acquire a resource and cannot point to where it is released, that is a leak.

### 6. Every in-flight async operation is cancellable
Any `fetch` that crosses a component boundary uses an `AbortController`.
The controller is aborted in the effect cleanup or before re-issuing the same request.
`AbortError` is explicitly caught and silently ignored — it is not a failure condition.

### 7. Stale state after unmount is guarded with `mountedRef`
After any `await`, check `if (!mountedRef.current) return` before touching state.
The ref is set `true` on mount and `false` in cleanup.
This prevents React's "Can't perform state update on unmounted component" warning
and the subtle data-race bugs that precede it.

### 8. `useRef` for values that must not trigger re-renders
`currentTimeRef` in `Player.tsx` exists so `handleSeekKeyDown` can read the current
seek position without being recreated every second as `currentTime` changes.
The rule: if a value is read but its change should not re-run an effect or recreate a callback, use a ref.

### 9. `useCallback` for every event handler and async action
Callbacks passed as props or used in effect dependency arrays are wrapped in `useCallback`.
This keeps effect dependency arrays honest and prevents child re-renders from cascading.

### 10. Guard clauses over nested conditionals
Return or throw early. Do not nest the happy path inside an `if`.

```ts
// Wrong
async function loadTrack(newTrack: Track) {
  const audio = audioRef.current;
  if (audio) {
    // ... 40 lines of logic
  }
}

// Right
async function loadTrack(newTrack: Track) {
  const audio = audioRef.current;
  if (!audio) return;
  // ... 40 lines of logic
}
```

### 11. Constants are module-scope, never component-scope
Values that do not change at runtime (`ACCEPTED`, `HISTORY_KEY`, `MAX_HISTORY`,
`YOUTUBE_HOSTS`, `UA`, `ERROR_MSGS`) are declared once at the top of their file.
They are not declared inside a component or a function — that would reallocate them on every call.

### 12. Types are named interfaces, not inline unions
```ts
// Wrong
function foo(state: { isPlaying: boolean; error: string | null }) {}

// Right
interface AudioState { isPlaying: boolean; error: string | null; }
function foo(state: AudioState) {}
```
Named interfaces are searchable, extensible, and self-documenting.

### 13. Alignment whitespace is permitted for vertical grouping
When multiple related assignments or object properties share a block,
trailing spaces may align the `=` or `:` vertically.
This is the one exception to "no extra whitespace" — it aids scanning.

```ts
const ACCEPTED_EXT = /\.(mp3|flac|wav)$/i;
const HISTORY_KEY  = 'aeolian_history';
const MAX_HISTORY  = 20;
```

### 14. The API layer fails fast and returns early
Each branch in `route.ts` either returns a `NextResponse` immediately or falls through
to the next check. There is no deep nesting. The happy path is always the last branch.

### 15. SSRF is not an afterthought
Any server-side code that accepts a URL from the client must validate it.
`PRIVATE_HOST` is checked before the outbound `fetch` and again after redirects,
because a server can 302 to a private address. This check is not optional.

### 16. The audio error guard `srcIsRealRef` is not paranoia
Setting `audio.src = ''` to unload a track fires a synthetic `MediaError(4)`.
Without the guard, that error would propagate to the UI as a playback failure.
The ref is the minimal mechanism to distinguish a real error from an internal reset.

### 17. CSS: one property per declaration block line
The same rule as axiom 1, applied to CSS.
```css
/* Wrong */
.foo { display: flex; align-items: center; gap: 8px; }

/* Right */
.foo {
  display: flex;
  align-items: center;
  gap: 8px;
}
```
Single-property rules (e.g. `.bar { opacity: 0; }`) may remain on one line.

### 18. CSS variables carry the design system
All colours, spacing tokens, typography, radii, and easing curves live in `:root` in `globals.css`.
Component stylesheets consume them via `var(--token)`. Magic numbers in component CSS
are a signal that a token is missing.

### 19. No third-party UI components
Every visible element — buttons, sliders, drawers, badges — is hand-written CSS.
Dependencies are for logic that cannot be reasonably self-implemented:
`jsmediatags` for binary tag parsing, `@distube/ytdl-core` for YouTube extraction.
A UI library would own the aesthetic. The aesthetic belongs to Aeolian.

### 20. Animation serves function
Every animation in the product either communicates state (the aura reacts to audio energy,
the spinner signals resolution in progress) or eases a spatial transition (the queue drawer slides up).
No animation exists only because it looks interesting.
`prefers-reduced-motion` disables all animation unconditionally.

### 21. Accessibility is structural, not cosmetic
`role`, `aria-label`, `aria-live`, `aria-modal`, `aria-valuemin/max/now/text`, and
`tabIndex` are present because the player must be operable without a mouse.
The seek bar is a proper `role="slider"` with keyboard handlers.
Focus styles are never suppressed globally — `:focus { outline: none }` is offset by
`:focus-visible { outline: 2px solid var(--col-teal) }`, preserving keyboard visibility.

---

*Last updated: April 2026*
