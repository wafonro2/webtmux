import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
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

type Modifiers = {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
};

type KeyboardViewport = 'phone' | 'tablet';

const TERMINAL_SIZE_KEY_PREFIX = 'webtmux-terminal-size:';
const MIN_COLS = 20;
const MIN_ROWS = 6;

const ACTION_SEQUENCES: Record<string, string> = {
  esc: '\x1b',
  tab: '\t',
  enter: '\r',
  bksp: '\x7f',
  space: ' ',
  left: '\x1b[D',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  home: '\x1b[H',
  end: '\x1b[F',
  pgup: '\x1b[5~',
  pgdn: '\x1b[6~',
  ins: '\x1b[2~',
  del: '\x1b[3~'
};

const FUNCTION_KEYS: Record<string, string> = {
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f3: '\x1bOR',
  f4: '\x1bOS',
  f5: '\x1b[15~',
  f6: '\x1b[17~',
  f7: '\x1b[18~',
  f8: '\x1b[19~',
  f9: '\x1b[20~',
  f10: '\x1b[21~',
  f11: '\x1b[23~',
  f12: '\x1b[24~'
};

const NAV_ROWS_TABLET = [
  '{esc} {tab} {home} {end} {pgup} {pgdn} {ins} {del} {left} {up} {down} {right}',
  '{f1} {f2} {f3} {f4} {f5} {f6}',
  '{f7} {f8} {f9} {f10} {f11} {f12}'
];

const NAV_ROWS_PHONE = [
  '{esc} {tab} {home} {end} {pgup} {pgdn}',
  '{ins} {del} {left} {up} {down} {right}',
  '{f1} {f2} {f3} {f4} {f5} {f6}',
  '{f7} {f8} {f9} {f10} {f11} {f12}'
];

const KEYBOARD_DISPLAY: Record<string, string> = {
  '{esc}': 'Esc',
  '{tab}': 'Tab',
  '{home}': 'Home',
  '{end}': 'End',
  '{pgup}': 'PgUp',
  '{pgdn}': 'PgDn',
  '{ins}': 'Ins',
  '{del}': 'Del',
  '{left}': '←',
  '{up}': '↑',
  '{down}': '↓',
  '{right}': '→',
  '{bksp}': 'Bksp',
  '{enter}': 'Enter',
  '{space}': 'Space',
  '{shift}': 'Shift',
  '{ctrl}': 'Ctrl',
  '{alt}': 'Alt',
  '{abc}': 'ABC',
  '{sym}': '123',
  '{fit}': 'Fit',
  '{hide}': 'Hide',
  '{f1}': 'F1',
  '{f2}': 'F2',
  '{f3}': 'F3',
  '{f4}': 'F4',
  '{f5}': 'F5',
  '{f6}': 'F6',
  '{f7}': 'F7',
  '{f8}': 'F8',
  '{f9}': 'F9',
  '{f10}': 'F10',
  '{f11}': 'F11',
  '{f12}': 'F12'
};

function isTouchLike() {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 900;
}

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

function toCtrlChar(value: string) {
  if (value.length !== 1) {
    return null;
  }

  if (/^[a-z]$/i.test(value)) {
    const code = value.toUpperCase().charCodeAt(0) - 64;
    return String.fromCharCode(code);
  }

  if (value === ' ') {
    return '\x00';
  }

  if (value === '[') {
    return '\x1b';
  }

  if (value === '\\') {
    return '\x1c';
  }

  if (value === ']') {
    return '\x1d';
  }

  if (value === '^') {
    return '\x1e';
  }

  if (value === '_') {
    return '\x1f';
  }

  return null;
}

function unwrapToken(button: string) {
  if (button.startsWith('{') && button.endsWith('}')) {
    return button.slice(1, -1).toLowerCase();
  }

  return null;
}

function buildAlphaRows(shift: boolean, viewport: KeyboardViewport) {
  const lastRow =
    viewport === 'phone'
      ? '{sym} {ctrl} {alt} , . | {space} {enter}'
      : '{sym} {ctrl} {alt} , . / | {space} {enter}';

  if (shift) {
    return [
      'Q W E R T Y U I O P',
      'A S D F G H J K L',
      '{shift} Z X C V B N M {bksp}',
      lastRow
    ];
  }

  return [
    'q w e r t y u i o p',
    'a s d f g h j k l',
    '{shift} z x c v b n m {bksp}',
    lastRow
  ];
}

function buildSymbolRows(viewport: KeyboardViewport) {
  if (viewport === 'phone') {
    return [
      '1 2 3 4 5 6 7 8 9 0',
      '- / ; : ( ) $ & @ "',
      ". , ? ! ' # % * + =",
      '{abc} {ctrl} {alt} | _ {space} {enter}'
    ];
  }

  return [
    '1 2 3 4 5 6 7 8 9 0',
    '- / ; : ( ) $ & @ " |',
    ". , ? ! ' # % * + = {bksp}",
    '{abc} {ctrl} {alt} \\ _ {space} {enter}'
  ];
}

const VirtualKeyboard = lazy(() => import('./VirtualKeyboard'));

export function TerminalPane({ sessionId }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const manualSizeRef = useRef<GridSize | null>(null);
  const adjustManualSizeRef = useRef<(deltaCols: number, deltaRows: number) => void>(() => {});
  const resetManualSizeRef = useRef<() => void>(() => {});

  const [touchMode, setTouchMode] = useState(() => isTouchLike());
  const [keyboardVisible, setKeyboardVisible] = useState(() => isTouchLike());
  const [keyboardMode, setKeyboardMode] = useState<'abc' | 'sym'>('abc');
  const [keyboardViewport, setKeyboardViewport] = useState<KeyboardViewport>(() =>
    typeof window !== 'undefined' && window.innerWidth <= 820 ? 'phone' : 'tablet'
  );
  const [modifiers, setModifiers] = useState<Modifiers>({
    ctrl: false,
    alt: false,
    shift: false
  });

  useEffect(() => {
    const updateTouchMode = () => {
      const next = isTouchLike();
      setTouchMode(next);
      setKeyboardViewport(window.innerWidth <= 820 ? 'phone' : 'tablet');
      if (next) {
        setKeyboardVisible(true);
      }
    };

    updateTouchMode();
    window.addEventListener('resize', updateTouchMode);

    return () => {
      window.removeEventListener('resize', updateTouchMode);
    };
  }, []);

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

    termRef.current = term;

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    const helperTextarea = containerRef.current.querySelector(
      '.xterm-helper-textarea'
    ) as HTMLTextAreaElement | null;

    const handleNativeFocus = () => {
      if (isTouchLike()) {
        helperTextarea?.blur();
      }
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (!isTouchLike()) {
        return;
      }

      event.preventDefault();
      helperTextarea?.blur();
    };

    if (helperTextarea) {
      helperTextarea.setAttribute('inputmode', 'none');
      helperTextarea.setAttribute('autocorrect', 'off');
      helperTextarea.setAttribute('autocapitalize', 'off');
      helperTextarea.spellcheck = false;
      helperTextarea.addEventListener('focus', handleNativeFocus);
    }

    containerRef.current.addEventListener('touchstart', handleTouchStart, {
      passive: false
    });

    const storedSize = readStoredSize(sessionId);
    if (storedSize) {
      manualSizeRef.current = storedSize;
      term.resize(storedSize.cols, storedSize.rows);
    } else {
      manualSizeRef.current = null;
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

    wsRef.current = ws;

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

    adjustManualSizeRef.current = adjustManualSize;
    resetManualSizeRef.current = resetManualSize;

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
      if (helperTextarea) {
        helperTextarea.removeEventListener('focus', handleNativeFocus);
      }

      containerRef.current?.removeEventListener('touchstart', handleTouchStart);
      resizeObserver.disconnect();
      dataSubscription.dispose();
      ws.close();
      term.dispose();
      wsRef.current = null;
      termRef.current = null;
      adjustManualSizeRef.current = () => {};
      resetManualSizeRef.current = () => {};
      setModifiers({ ctrl: false, alt: false, shift: false });
    };
  }, [sessionId]);

  const sendInput = (input: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    ws.send(JSON.stringify({ type: 'input', data: input }));
    if (!isTouchLike()) {
      termRef.current?.focus();
    }
  };

  const clearOneShotModifiers = () => {
    setModifiers({ ctrl: false, alt: false, shift: false });
  };

  const sendCharacter = (key: string) => {
    let value = modifiers.shift ? key.toUpperCase() : key;

    if (modifiers.ctrl) {
      const ctrl = toCtrlChar(value);
      if (ctrl) {
        value = ctrl;
      }
    }

    if (modifiers.alt) {
      value = `\x1b${value}`;
    }

    sendInput(value);
    clearOneShotModifiers();
  };

  const sendAction = (actionKey: string) => {
    const direct = ACTION_SEQUENCES[actionKey] || FUNCTION_KEYS[actionKey];
    if (!direct) {
      return;
    }

    const value = modifiers.alt ? `\x1b${direct}` : direct;
    sendInput(value);
    clearOneShotModifiers();
  };

  const onVirtualKeyPress = (button: string) => {
    const token = unwrapToken(button);

    if (token === 'ctrl') {
      setModifiers((prev) => ({ ...prev, ctrl: !prev.ctrl }));
      return;
    }

    if (token === 'alt') {
      setModifiers((prev) => ({ ...prev, alt: !prev.alt }));
      return;
    }

    if (token === 'shift') {
      setModifiers((prev) => ({ ...prev, shift: !prev.shift }));
      return;
    }

    if (token === 'sym') {
      setKeyboardMode('sym');
      return;
    }

    if (token === 'abc') {
      setKeyboardMode('abc');
      return;
    }

    if (token === 'fit') {
      resetManualSizeRef.current();
      clearOneShotModifiers();
      return;
    }

    if (token === 'hide') {
      setKeyboardVisible(false);
      return;
    }

    if (token && (ACTION_SEQUENCES[token] || FUNCTION_KEYS[token])) {
      sendAction(token);
      return;
    }

    if (!token) {
      sendCharacter(button);
    }
  };

  const keyboardRows = useMemo(() => {
    const navRows = keyboardViewport === 'phone' ? NAV_ROWS_PHONE : NAV_ROWS_TABLET;
    const contentRows =
      keyboardMode === 'abc'
        ? buildAlphaRows(modifiers.shift, keyboardViewport)
        : buildSymbolRows(keyboardViewport);
    return [...navRows, ...contentRows, '{fit} {hide}'];
  }, [keyboardMode, keyboardViewport, modifiers.shift]);

  const buttonTheme = useMemo(() => {
    const activeButtons = [
      modifiers.ctrl ? '{ctrl}' : '',
      modifiers.alt ? '{alt}' : '',
      modifiers.shift ? '{shift}' : ''
    ]
      .filter(Boolean)
      .join(' ');

    const themes = [] as Array<{ class: string; buttons: string }>;

    if (activeButtons) {
      themes.push({ class: 'vk-active', buttons: activeButtons });
    }

    themes.push({ class: 'vk-space', buttons: '{space}' });
    themes.push({ class: 'vk-enter', buttons: '{enter}' });
    themes.push({ class: 'vk-backspace', buttons: '{bksp}' });
    themes.push({
      class: 'vk-mod',
      buttons: '{shift} {ctrl} {alt} {abc} {sym} {fit} {hide}'
    });
    themes.push({ class: 'vk-nav', buttons: '{esc} {tab} {home} {end} {pgup} {pgdn} {ins} {del} {left} {up} {down} {right} {f1} {f2} {f3} {f4} {f5} {f6} {f7} {f8} {f9} {f10} {f11} {f12} {fit} {hide}' });

    return themes;
  }, [modifiers]);

  return (
    <div className="terminal-frame">
      <div ref={containerRef} className="terminal-pane" />

      {touchMode ? (
        <div className="terminal-toolbar">
          <button
            type="button"
            className="terminal-toolbar-btn"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setKeyboardVisible((prev) => !prev)}
          >
            {keyboardVisible ? 'Hide Keyboard' : 'Show Keyboard'}
          </button>
          <button
            type="button"
            className="terminal-toolbar-btn"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => resetManualSizeRef.current()}
          >
            Fit Terminal
          </button>
        </div>
      ) : null}

      {touchMode && keyboardVisible ? (
        <div className="terminal-keyboard">
          <Suspense fallback={<div className="keyboard-loading">Loading keyboard...</div>}>
            <VirtualKeyboard
              rows={keyboardRows}
              display={KEYBOARD_DISPLAY}
              onKeyPress={onVirtualKeyPress}
              buttonTheme={buttonTheme}
              themeClass={keyboardViewport === 'phone' ? 'webtmux-phone' : 'webtmux-tablet'}
            />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}
