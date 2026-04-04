import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

type TerminalPaneProps = {
  sessionId: string;
};

type SocketMessage =
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode?: number; signal?: number }
  | { type: 'closed' };

type GridSize = {
  cols: number;
  rows: number;
};

const TERMINAL_SIZE_KEY_PREFIX = 'webtmux-terminal-size:';
const MIN_COLS = 20;
const MIN_ROWS = 6;

function readStoredSize(sessionId: string): GridSize | null {
  try {
    const raw = localStorage.getItem(`${TERMINAL_SIZE_KEY_PREFIX}${sessionId}`);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<GridSize>;
    if (
      Number.isInteger(parsed.cols) &&
      Number.isInteger(parsed.rows) &&
      (parsed.cols as number) >= MIN_COLS &&
      (parsed.rows as number) >= MIN_ROWS
    ) {
      return { cols: parsed.cols as number, rows: parsed.rows as number };
    }
  } catch {
    // Ignore malformed storage and fall back to auto-fit.
  }

  return null;
}

function writeStoredSize(sessionId: string, size: GridSize) {
  localStorage.setItem(`${TERMINAL_SIZE_KEY_PREFIX}${sessionId}`, JSON.stringify(size));
}

function clearStoredSize(sessionId: string) {
  localStorage.removeItem(`${TERMINAL_SIZE_KEY_PREFIX}${sessionId}`);
}

export function TerminalPane({ sessionId }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const term = new Terminal({
      cursorBlink: true,
      convertEol: false,
      theme: {
        background: '#0a101a',
        foreground: '#dce7ff'
      }
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    const manualSizeRef: { current: { cols: number; rows: number } | null } = {
      current: null
    };
    const storedSize = readStoredSize(sessionId);
    if (storedSize) {
      manualSizeRef.current = storedSize;
      term.resize(storedSize.cols, storedSize.rows);
    } else {
      fitAddon.fit();
    }

    const initialCols = manualSizeRef.current?.cols ?? term.cols;
    const initialRows = manualSizeRef.current?.rows ?? term.rows;

    const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${wsProtocol}://${window.location.host}/ws?sessionId=${encodeURIComponent(
        sessionId
      )}&cols=${initialCols}&rows=${initialRows}`
    );

    const sendResize = (cols: number, rows: number) => {
      if (ws.readyState !== ws.OPEN) {
        return;
      }

      ws.send(
        JSON.stringify({
          type: 'resize',
          cols,
          rows
        })
      );
    };

    const runAutoFit = () => {
      fitAddon.fit();
      sendResize(term.cols, term.rows);
    };

    const adjustManualSize = (deltaCols: number, deltaRows: number) => {
      const base = manualSizeRef.current ?? { cols: term.cols, rows: term.rows };
      const nextCols = Math.max(MIN_COLS, base.cols + deltaCols);
      const nextRows = Math.max(MIN_ROWS, base.rows + deltaRows);

      manualSizeRef.current = {
        cols: nextCols,
        rows: nextRows
      };
      writeStoredSize(sessionId, manualSizeRef.current);

      term.resize(nextCols, nextRows);
      sendResize(nextCols, nextRows);
    };

    const resetManualSize = () => {
      manualSizeRef.current = null;
      clearStoredSize(sessionId);
      runAutoFit();
    };

    ws.addEventListener('open', () => {
      if (manualSizeRef.current) {
        sendResize(manualSizeRef.current.cols, manualSizeRef.current.rows);
        return;
      }
      runAutoFit();
    });

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data) as SocketMessage;

      if (msg.type === 'output') {
        term.write(msg.data);
      }

      if (msg.type === 'exit') {
        const codeLabel =
          typeof msg.exitCode === 'number' ? ` with code ${msg.exitCode}` : '';
        term.writeln('');
        term.writeln(`[process exited${codeLabel}]`);
      }

      if (msg.type === 'closed') {
        term.writeln('');
        term.writeln('[session closed]');
      }
    });

    const dataSubscription = term.onData((data) => {
      if (ws.readyState !== ws.OPEN) {
        return;
      }
      ws.send(JSON.stringify({ type: 'input', data }));
    });

    term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== 'keydown') {
        return true;
      }

      const isModifierCombo =
        event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;

      if (!isModifierCombo) {
        return true;
      }

      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        adjustManualSize(4, 2);
        return false;
      }

      if (event.key === '-') {
        event.preventDefault();
        adjustManualSize(-4, -2);
        return false;
      }

      if (event.key === '0') {
        event.preventDefault();
        resetManualSize();
        return false;
      }

      return true;
    });

    const resizeObserver = new ResizeObserver(() => {
      if (manualSizeRef.current) {
        return;
      }

      runAutoFit();
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      dataSubscription.dispose();
      ws.close();
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div className="terminal-frame">
      <div ref={containerRef} className="terminal-pane" />
    </div>
  );
}
