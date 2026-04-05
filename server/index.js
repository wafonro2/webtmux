import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const SESSION_PREFIX = 'webtmux-';
const AUTH_COOKIE_NAME = 'webtmux_auth';
const DEFAULT_PASSWORD = 'changeme';
const AUTH_TOKEN_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const PYTHON_BIN = process.env.WEBTMUX_PYTHON_BIN || 'python3';
const FASTER_WHISPER_MODEL = process.env.FASTER_WHISPER_MODEL || 'large-v3-turbo';
const FASTER_WHISPER_DEVICE = process.env.FASTER_WHISPER_DEVICE || 'auto';
const FASTER_WHISPER_COMPUTE_TYPE = process.env.FASTER_WHISPER_COMPUTE_TYPE || 'float16';
const FASTER_WHISPER_BEAM_SIZE = Number.parseInt(process.env.FASTER_WHISPER_BEAM_SIZE || '1', 10);
const FASTER_WHISPER_VAD_FILTER = process.env.FASTER_WHISPER_VAD_FILTER !== '0';
const FASTER_WHISPER_SCRIPT_PATH = path.join(__dirname, 'transcribe_faster_whisper.py');

const configuredPassword = process.env.WEBTMUX_PASSWORD || DEFAULT_PASSWORD;
if (!process.env.WEBTMUX_PASSWORD) {
  console.warn(
    '[webtmux] WEBTMUX_PASSWORD is not set; using default password "changeme".'
  );
}

const authTokens = new Set();

const app = express();
app.use(cors());
app.use(express.json());

function parseCookies(cookieHeader) {
  if (!cookieHeader) {
    return {};
  }

  return cookieHeader
    .split(';')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .reduce((acc, segment) => {
      const index = segment.indexOf('=');
      if (index <= 0) {
        return acc;
      }

      const key = segment.slice(0, index);
      const value = decodeURIComponent(segment.slice(index + 1));
      acc[key] = value;
      return acc;
    }, {});
}

function readAuthToken(cookieHeader) {
  const cookies = parseCookies(cookieHeader);
  return cookies[AUTH_COOKIE_NAME] || null;
}

function isAuthenticatedCookie(cookieHeader) {
  const token = readAuthToken(cookieHeader);
  return Boolean(token && authTokens.has(token));
}

function isAuthenticatedRequest(req) {
  return isAuthenticatedCookie(req.headers.cookie);
}

function clearAuthCookie(res) {
  const secure = process.env.WEBTMUX_COOKIE_SECURE === '1';
  const cookie = [
    `${AUTH_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0'
  ];

  if (secure) {
    cookie.push('Secure');
  }

  res.setHeader('Set-Cookie', cookie.join('; '));
}

function setAuthCookie(res, token) {
  const secure = process.env.WEBTMUX_COOKIE_SECURE === '1';
  const cookie = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${AUTH_TOKEN_MAX_AGE_SECONDS}`
  ];

  if (secure) {
    cookie.push('Secure');
  }

  res.setHeader('Set-Cookie', cookie.join('; '));
}

function passwordsMatch(candidateInput) {
  const candidate = typeof candidateInput === 'string' ? candidateInput : '';
  const expectedBuffer = Buffer.from(configuredPassword);
  const providedBuffer = Buffer.from(candidate);

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function requireAuth(req, res, next) {
  if (!isAuthenticatedRequest(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

let cachedWhisperDependency = {
  checkedAtMs: 0,
  ok: false,
  error: ''
};

function checkFasterWhisperDependency() {
  const now = Date.now();
  if (now - cachedWhisperDependency.checkedAtMs < 60_000) {
    return cachedWhisperDependency;
  }

  const result = spawnSync(PYTHON_BIN, ['-c', 'import faster_whisper'], {
    encoding: 'utf8'
  });

  cachedWhisperDependency = {
    checkedAtMs: now,
    ok: result.status === 0,
    error: result.status === 0 ? '' : (result.stderr || result.stdout || '').trim()
  };

  return cachedWhisperDependency;
}

function inferAudioExtension(contentType) {
  if (!contentType) {
    return 'webm';
  }

  if (contentType.includes('audio/webm')) {
    return 'webm';
  }
  if (contentType.includes('audio/mp4')) {
    return 'm4a';
  }
  if (contentType.includes('audio/ogg')) {
    return 'ogg';
  }
  if (contentType.includes('audio/wav')) {
    return 'wav';
  }

  return 'bin';
}

function runFasterWhisperTranscription({ audioPath, language }) {
  return new Promise((resolve, reject) => {
    const args = [
      FASTER_WHISPER_SCRIPT_PATH,
      '--input',
      audioPath,
      '--model',
      FASTER_WHISPER_MODEL,
      '--device',
      FASTER_WHISPER_DEVICE,
      '--compute-type',
      FASTER_WHISPER_COMPUTE_TYPE,
      '--beam-size',
      String(Number.isInteger(FASTER_WHISPER_BEAM_SIZE) && FASTER_WHISPER_BEAM_SIZE > 0 ? FASTER_WHISPER_BEAM_SIZE : 1),
      '--vad-filter',
      FASTER_WHISPER_VAD_FILTER ? '1' : '0'
    ];

    if (language) {
      args.push('--language', language);
    }

    const child = spawn(PYTHON_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `faster-whisper failed (${code}): ${(stderr || stdout || 'unknown error').trim()}`
          )
        );
        return;
      }

      try {
        const payload = JSON.parse(stdout);
        const text = typeof payload?.text === 'string' ? payload.text : '';
        resolve(text);
      } catch {
        reject(new Error('Invalid transcription response from faster-whisper worker'));
      }
    });
  });
}

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
      const createdAt =
        Number(created) > 0
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

app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: isAuthenticatedRequest(req) });
});

app.post('/api/auth/login', (req, res) => {
  if (!passwordsMatch(req.body?.password)) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  const token = crypto.randomBytes(32).toString('hex');
  authTokens.add(token);
  setAuthCookie(res, token);
  res.status(204).send();
});

app.post('/api/auth/logout', (req, res) => {
  const token = readAuthToken(req.headers.cookie);
  if (token) {
    authTokens.delete(token);
  }

  clearAuthCookie(res);
  res.status(204).send();
});

app.get('/api/speech/status', requireAuth, (_req, res) => {
  const dependency = checkFasterWhisperDependency();

  res.json({
    configured: dependency.ok,
    provider: 'faster-whisper',
    model: FASTER_WHISPER_MODEL,
    device: FASTER_WHISPER_DEVICE,
    computeType: FASTER_WHISPER_COMPUTE_TYPE,
    ...(dependency.ok ? {} : { error: dependency.error || 'faster_whisper import failed' })
  });
});

app.post(
  '/api/speech/transcribe',
  requireAuth,
  express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '20mb' }),
  async (req, res) => {
    const dependency = checkFasterWhisperDependency();
    if (!dependency.ok) {
      res.status(503).json({
        error:
          dependency.error ||
          'faster_whisper is not available. Install it in the server Python environment.'
      });
      return;
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: 'Audio payload is required.' });
      return;
    }

    const contentType =
      typeof req.headers['content-type'] === 'string'
        ? req.headers['content-type']
        : 'audio/webm';
    const languageRaw = req.query.language;
    const language =
      typeof languageRaw === 'string' && languageRaw.trim()
        ? languageRaw.trim().slice(0, 12)
        : undefined;

    const extension = inferAudioExtension(contentType);
    const tempName = `webtmux-speech-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${extension}`;
    const audioPath = path.join(os.tmpdir(), tempName);

    try {
      await fs.writeFile(audioPath, body);
      const text = await runFasterWhisperTranscription({
        audioPath,
        language
      });
      res.json({ text });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to run local faster-whisper';
      res.status(502).json({ error: message });
    } finally {
      await fs.rm(audioPath, { force: true }).catch(() => {});
    }
  }
);

app.get('/api/sessions', requireAuth, (_req, res) => {
  try {
    const sessions = listTmuxSessions();
    res.json({ sessions });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to list sessions';
    res.status(500).json({ error: message });
  }
});

app.post('/api/sessions', requireAuth, (req, res) => {
  try {
    const session = createTmuxSession(req.body?.name);
    res.status(201).json({ session });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to create session';
    res.status(500).json({ error: message });
  }
});

app.patch('/api/sessions/:id', requireAuth, (req, res) => {
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

app.delete('/api/sessions/:id', requireAuth, (req, res) => {
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
  if (!isAuthenticatedCookie(req.headers.cookie)) {
    ws.close(1008, 'unauthorized');
    return;
  }

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
