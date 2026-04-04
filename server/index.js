import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const SESSION_PREFIX = 'webtmux-';
const app = express();
app.use(cors());
app.use(express.json());

function runTmux(args, options = {}) {
  const result = spawnSync('tmux', args, {
    encoding: 'utf8'
  });

  if (result.status === 0) {
    return result.stdout.trim();
  }

  const stderr = (result.stderr || '').trim();
  if (options.allowNoServer && stderr.includes('no server running')) {
    return '';
  }

  throw new Error(`tmux ${args.join(' ')} failed: ${stderr || 'unknown error'}`);
}

function sessionDisplayName(sessionName) {
  if (sessionName.startsWith(SESSION_PREFIX)) {
    const raw = sessionName.slice(SESSION_PREFIX.length);
    if (raw) {
      return raw;
    }
  }

  return sessionName;
}

function listTmuxSessions() {
  const output = runTmux(['list-sessions', '-F', '#{session_name}|#{session_created}'], {
    allowNoServer: true
  });

  if (!output) {
    return [];
  }

  const sessions = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, created] = line.split('|');
      const createdAt = Number(created) > 0
        ? new Date(Number(created) * 1000).toISOString()
        : new Date().toISOString();

      return {
        id: name,
        name: sessionDisplayName(name),
        createdAt,
        status: 'running'
      };
    })
    .filter((session) => session.id.startsWith(SESSION_PREFIX));

  sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return sessions;
}

function tmuxSessionExists(sessionId) {
  const result = spawnSync('tmux', ['has-session', '-t', sessionId], {
    encoding: 'utf8'
  });

  return result.status === 0;
}

function sanitizeSessionName(input) {
  return (input || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, 40);
}

function buildUniqueSessionId(baseName, currentId) {
  let candidate = `${SESSION_PREFIX}${baseName}`;
  let counter = 2;

  while (tmuxSessionExists(candidate) && candidate !== currentId) {
    candidate = `${SESSION_PREFIX}${baseName}-${counter}`;
    counter += 1;
  }

  return candidate;
}

function createTmuxSession(displayNameInput) {
  const baseName = sanitizeSessionName(displayNameInput) || `session-${Date.now()}`;
  const candidate = buildUniqueSessionId(baseName);

  runTmux(['new-session', '-d', '-s', candidate]);

  const created = listTmuxSessions().find((session) => session.id === candidate);
  if (!created) {
    throw new Error('Created tmux session was not found');
  }

  return created;
}

function renameTmuxSession(sessionId, nextDisplayNameInput) {
  if (!tmuxSessionExists(sessionId)) {
    throw new Error('Session not found');
  }

  const baseName = sanitizeSessionName(nextDisplayNameInput);
  if (!baseName) {
    throw new Error('Session name cannot be empty');
  }

  const nextSessionId = buildUniqueSessionId(baseName, sessionId);

  if (nextSessionId !== sessionId) {
    runTmux(['rename-session', '-t', sessionId, nextSessionId]);
  }

  const renamed = listTmuxSessions().find((session) => session.id === nextSessionId);
  if (!renamed) {
    throw new Error('Renamed tmux session was not found');
  }

  return renamed;
}

function ensureAtLeastOneSession() {
  const existing = listTmuxSessions();
  if (existing.length > 0) {
    return;
  }

  createTmuxSession('session-1');
}

app.get('/api/health', (_req, res) => {
  let tmuxAvailable = true;
  let error;

  try {
    runTmux(['-V']);
  } catch (err) {
    tmuxAvailable = false;
    error = err instanceof Error ? err.message : 'tmux unavailable';
  }

  res.json({
    ok: tmuxAvailable,
    platform: os.platform(),
    tmuxAvailable,
    ...(error ? { error } : {})
  });
});

app.get('/api/sessions', (_req, res) => {
  try {
    const sessions = listTmuxSessions();
    res.json({ sessions });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to list sessions';
    res.status(500).json({ error: message });
  }
});

app.post('/api/sessions', (req, res) => {
  try {
    const session = createTmuxSession(req.body?.name);
    res.status(201).json({ session });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to create session';
    res.status(500).json({ error: message });
  }
});

app.patch('/api/sessions/:id', (req, res) => {
  const sessionId = req.params.id;

  if (!sessionId.startsWith(SESSION_PREFIX)) {
    res.status(400).json({ error: 'Invalid session id' });
    return;
  }

  try {
    const session = renameTmuxSession(sessionId, req.body?.name);
    res.json({ session });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to rename session';
    if (message === 'Session not found') {
      res.status(404).json({ error: message });
      return;
    }
    if (message === 'Session name cannot be empty') {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  const sessionId = req.params.id;

  if (!sessionId.startsWith(SESSION_PREFIX)) {
    res.status(400).json({ error: 'Invalid session id' });
    return;
  }

  if (!tmuxSessionExists(sessionId)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  try {
    runTmux(['kill-session', '-t', sessionId]);
    res.status(204).send();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to delete session';
    res.status(500).json({ error: message });
  }
});

const distDir = path.join(rootDir, 'dist');
app.use(express.static(distDir));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    next();
    return;
  }

  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) {
      next();
    }
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const sessionId = url.searchParams.get('sessionId');
  const initialColsRaw = url.searchParams.get('cols');
  const initialRowsRaw = url.searchParams.get('rows');

  if (!sessionId || !sessionId.startsWith(SESSION_PREFIX)) {
    ws.close(1008, 'invalid session id');
    return;
  }

  if (!tmuxSessionExists(sessionId)) {
    ws.close(1008, 'session not found');
    return;
  }

  const initialCols = Number.parseInt(initialColsRaw || '', 10);
  const initialRows = Number.parseInt(initialRowsRaw || '', 10);
  const cols = Number.isInteger(initialCols) && initialCols > 0 ? initialCols : 100;
  const rows = Number.isInteger(initialRows) && initialRows > 0 ? initialRows : 30;

  const proc = pty.spawn('tmux', ['attach-session', '-t', sessionId], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.HOME || process.cwd(),
    env: process.env
  });

  proc.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'output', data }));
    }
  });

  proc.onExit(({ exitCode, signal }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
      ws.close();
    }
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'input' && typeof msg.data === 'string') {
      proc.write(msg.data);
    }

    if (
      msg.type === 'resize' &&
      Number.isInteger(msg.cols) &&
      Number.isInteger(msg.rows)
    ) {
      proc.resize(msg.cols, msg.rows);
    }
  });

  ws.on('close', () => {
    try {
      proc.kill();
    } catch {
      // Process may already be closed.
    }
  });
});

try {
  ensureAtLeastOneSession();
} catch (err) {
  const message = err instanceof Error ? err.message : 'tmux init failed';
  console.error(message);
}

const port = Number(process.env.PORT || 3001);
server.listen(port, () => {
  console.log(`webtmux server running at http://localhost:${port}`);
});
