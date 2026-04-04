# webtmux MVP

Local web terminal multiplexer MVP with a left-side session list and a tmux-backed terminal runtime.

## What is implemented
- Multiple tmux sessions managed from the web UI
- Vertical session tabs on the left (`New`, rename, reorder by drag-and-drop, and close)
- xterm.js terminal view for the selected tmux session
- WebSocket stream for terminal input/output
- Persistent sessions through tmux (survive UI refresh and backend restarts)
- Resizable sidebar splitter to resize terminal viewport width
- Terminal grid resize shortcuts inside the terminal: `Ctrl +`, `Ctrl -`, `Ctrl 0` (reset)

## Requirements
- Node.js + npm
- `tmux` installed and available in `PATH`

## Run
1. Install dependencies:
   ```bash
   npm install
   ```
2. Start development mode (frontend + backend):
   ```bash
   npm run dev
   ```
   or use:
   ```bash
   ./run
   ```
3. Open:
   `http://localhost:5173`

## Production-like run
```bash
npm run build
npm run start
```
Then open `http://localhost:3001`.

## Notes
- This MVP is **local usage only**.
- The app manages tmux sessions with the `webtmux-` prefix.
- If no matching tmux session exists, one default session is created automatically.
