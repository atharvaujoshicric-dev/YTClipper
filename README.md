# GTA 6 CLIPFORGE

Local, browser-only live-stream clipper, highlight detector and vertical-shorts generator. Static site: no backend, no accounts, no uploads to any server. All media and metadata stay in your browser (IndexedDB).

> **Rights.** Only process footage you own or have permission to republish. Being able to *watch* a stream is not the same as having the right to *republish* it. CLIPFORGE does not download from URLs, does not bypass DRM, and never publishes anything for you. Detection scores are heuristics, not predictions — nothing here promises views or virality.

## Run locally

```bash
git clone <your-repo-url> && cd <repo>
python3 -m http.server 8000
# open http://localhost:8000
```
`file://` will not work (ES modules, workers, IndexedDB). Any static server is fine.

## Deploy to GitHub Pages

1. Create a repository and push this folder so `index.html` is at the repo root (`.nojekyll` is included).
2. Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
3. Branch `main`, folder `/ (root)` → Save.
4. Open `https://<user>.github.io/<repo>/` after the build finishes (about a minute).

All paths are relative, so it works under a repo subpath.

## Deploy to Vercel
1. Push the folder to GitHub (or run `npx vercel` inside it).
2. In Vercel: **Add New → Project**, import the repo. Framework preset: **Other**. Build command: empty. Output directory: `.` (root).
3. Deploy. `vercel.json` sets safe headers and allows screen capture. HTTPS is automatic, which live capture requires.

## Live capture permissions
The app cannot download from a stream link. Paste the link in the "Stream link" box to open it in a tab, then capture that tab with "Share tab audio".

"Live Clipper" uses `getDisplayMedia`. The browser asks you to choose a tab/window/screen; tick **Share tab audio** (Chrome/Edge) to capture sound. Needs HTTPS or localhost. Stopping the share in the browser auto-finalises the recording. The rolling buffer is capped (Settings) and flagged moments are protected from eviction.

## Browser compatibility
| Feature | Chrome/Edge | Firefox | Safari |
|---|---|---|---|
| Upload, analysis, editor | Yes | Expected | Expected |
| Tab-audio live capture | Yes | Screen video only | Limited |
| Live speech recognition (Web Speech) | Yes (usually needs network) | No | Partial |
| Export (MediaRecorder + FFmpeg.wasm) | Yes | Untested | Untested |

Only Chrome (headless) was tested — see the implementation report.

## FFmpeg initialisation
MP4 export first renders a WebM with MediaRecorder, then transcodes to H.264/AAC with single-threaded FFmpeg.wasm (no SharedArrayBuffer needed). The ~31 MB core is downloaded on first use from jsDelivr (fallback unpkg) — initialise it in **Settings** or on first export. If it cannot load, you get a verified WebM instead. Every export is decoded and checked (dimensions, duration, audio) before being reported as successful.

## Known limitations
- Heuristic detection only (audio, motion, scene change, colour, voice-band loudness); no ML models. Category labels beyond what the signals support need live speech keywords or manual review.
- Speech recognition works only on the live microphone, not on uploaded files (no automatic captions for uploads; add captions manually).
- No subject tracking: crops are static or suggested from motion.
- Export renders in real time; keep the tab visible.
- Very large files fall back to slower real-time audio analysis; storing media in the browser is capped by quota (Settings).

## Architecture
- `index.html` – shell. `css/` – style, components, dashboard, editor, responsive.
- `js/app.js`, `navigation.js` – hash router, onboarding. `state.js`, `storage.js` – store + IndexedDB. `settings.js`, `utils.js`.
- Analysis: `analyze.js`, `dsp.js`, `audio-analyzer.js`, `visual-analyzer.js`, `speech-analyzer.js`, `engagement-scorer.js`, `event-classifier.js`, `clip-extractor.js`, `highlight-detector.js`.
- Hooks/editing: `hook-intelligence.js`, `caption-engine.js`, `crop-engine.js`, `compositor.js`, `video-editor.js`.
- Views: `dashboard.js`, `live-capture.js`, `video-upload.js`, `library.js`, `highlights.js`, `export-center.js`, `analytics.js`.
- Export: `export-engine.js` (+ `vendor/ffmpeg`). `workers/` – analysis worker, audio-tap worklet.
