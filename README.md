# webtmux MVP

Local tmux frontend with a web UI, password protection, and PWA install support.

## Features
- Multiple tmux sessions managed from the web UI
- Left sidebar tabs: create, rename, drag-and-drop reorder, close
- xterm.js terminal with live tmux attach via WebSocket
- Session persistence through tmux (survives page/backend restart)
- Sidebar splitter resize + terminal grid resize shortcuts (`Ctrl +`, `Ctrl -`, `Ctrl 0`)
- Single-user password authentication (cookie-based)
- Installable PWA (manifest + service worker)

## Requirements
- Node.js + npm
- `tmux` in `PATH`
- Python 3 with `faster-whisper` installed (for local Whisper voice mode)

## Development
1. Install dependencies:
   ```bash
   npm install
   ```
2. Run both frontend and backend:
   ```bash
   ./run
   ```
   (or `npm run dev`)
3. Open `http://localhost:5173`
4. Login with password:
   - `WEBTMUX_PASSWORD` env var if set
   - otherwise default: `changeme`

## Production Run
```bash
npm run build
WEBTMUX_PASSWORD='your-password' npm run start
```
Open `http://localhost:3001`.

## Local faster-whisper Setup
Install local transcription runtime in your Python environment:
```bash
python3 -m pip install --upgrade faster-whisper
```

For NVIDIA GPUs (for example RTX 3090), ensure CUDA-enabled PyTorch/CTranslate2 deps are available in that Python environment.

Speech endpoints used by the app:
- `GET /api/speech/status`
- `POST /api/speech/transcribe`

Key env vars:
- `WEBTMUX_PYTHON_BIN` (default `python3`)
- `FASTER_WHISPER_MODEL` (default `large-v3-turbo`)
- `FASTER_WHISPER_DEVICE` (`auto`, `cuda`, `cpu`)
- `FASTER_WHISPER_COMPUTE_TYPE` (default `float16`)
- `FASTER_WHISPER_BEAM_SIZE` (default `1`)
- `FASTER_WHISPER_VAD_FILTER` (`1` or `0`)

## systemd Install
Use the installer script (Linux):
```bash
sudo WEBTMUX_PASSWORD='your-password' ./scripts/install-systemd.sh
```
Optional envs:
- `WEBTMUX_USER` (service user; default is current sudo user)
- `WEBTMUX_PORT` (default `3001`)

Service commands:
```bash
sudo systemctl status webtmux.service
sudo systemctl restart webtmux.service
sudo journalctl -u webtmux.service -f
```

## PWA Install
- Open the app in Chromium/Chrome/Edge.
- Use the browser install action (Install App).
- App metadata is in `public/manifest.webmanifest`; service worker is `public/sw.js`.

## Security Notes
- Set a strong `WEBTMUX_PASSWORD` in production.
- `WEBTMUX_COOKIE_SECURE=1` should be used only behind HTTPS.
- App-managed tmux sessions use `webtmux-` prefix.
