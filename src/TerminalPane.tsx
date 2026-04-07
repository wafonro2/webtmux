import { CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import VirtualKeyboard from './VirtualKeyboard';

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
type SpeechRecognitionLike = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: ((event: Event) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechRecognitionEventLike = Event & {
  resultIndex?: number;
  results?: ArrayLike<{
    isFinal?: boolean;
    [index: number]: { transcript?: string } | undefined;
  }>;
};
type SpeechRecognitionErrorEventLike = Event & { error?: string };
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
type WindowWithSpeechRecognition = Window & {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
};
type WindowWithAudioContext = Window & {
  webkitAudioContext?: typeof AudioContext;
};
type CommandModeRule = {
  id: string;
  spoken: string[];
  output: string;
  outputLabel: string;
  description: string;
};
type CompiledCommandModeRule = CommandModeRule & {
  pattern: RegExp;
  maxWords: number;
};
type VoiceEngine = 'browser' | 'whisper';

const TERMINAL_SIZE_KEY_PREFIX = 'webtmux-terminal-size:';
const KEYBOARD_SCALE_KEY_PREFIX = 'webtmux-keyboard-scale:';
const MIN_COLS = 20;
const MIN_ROWS = 6;
const PHONE_KEYBOARD_DEFAULT_SCALE = 100;
const TABLET_KEYBOARD_DEFAULT_SCALE = 100;
const PHONE_TERMINAL_FONT_SIZE = 8;
const DEFAULT_TERMINAL_FONT_SIZE = 15;
const POWERLINE_FONT_FAMILY = [
  "'WebtmuxNerdMono'",
  "'MesloLGS NF'",
  "'CaskaydiaCove Nerd Font'",
  "'JetBrainsMono Nerd Font'",
  "'Hack Nerd Font'",
  "'SauceCodePro Nerd Font'",
  "'FiraCode Nerd Font'",
  "'Symbols Nerd Font Mono'",
  "'PowerlineSymbols'",
  "'Noto Sans Mono'",
  "'DejaVu Sans Mono'",
  "'Menlo'",
  "'Consolas'",
  'monospace'
].join(', ');
const TOUCH_TAP_THRESHOLD_PX = 10;
const TOUCH_MOVE_CANCEL_SELECTION_PX = 10;
const TOUCH_WHEEL_STEP_PX = 24;
const TOUCH_SELECTION_HOLD_MS = 200;
const WHISPER_SILENCE_INTERVAL_MS = 120;
const WHISPER_SILENCE_HOLD_MS = 900;
const WHISPER_SILENCE_RMS_THRESHOLD = 0.018;

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
  '{esc} {tab} {home} {end} {left} {up} {down} {right}'
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
  '{caps}': 'Caps',
  '{ctrl}': 'Ctrl',
  '{alt}': 'Alt',
  '{abc}': 'ABC',
  '{sym}': '123',
  '{mic}': 'Mic',
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

// Add entries here to extend spoken command replacements in Commands Mode.
const COMMAND_MODE_RULES: CommandModeRule[] = [
  {
    id: 'run-last',
    spoken: ['run last', 'repeat last'],
    output: '!!',
    outputLabel: '!!',
    description: 'Run previous command'
  },
  {
    id: 'list',
    spoken: ['list'],
    output: 'ls',
    outputLabel: 'ls',
    description: 'List files'
  },
  {
    id: 'pipe',
    spoken: ['pipe', 'bar'],
    output: '|',
    outputLabel: '|',
    description: 'Pipe operator'
  },
  {
    id: 'comma',
    spoken: ['comma'],
    output: ',',
    outputLabel: ',',
    description: 'Comma punctuation'
  },
  {
    id: 'dot',
    spoken: ['dot', 'dots', 'period'],
    output: '.',
    outputLabel: '.',
    description: 'Dot punctuation'
  },
  {
    id: 'enter',
    spoken: ['enter'],
    output: '\r',
    outputLabel: '<ENTER>',
    description: 'Press Enter'
  },
  {
    id: 'arrow-up',
    spoken: ['arrow up', 'up'],
    output: '\x1b[A',
    outputLabel: '<UP>',
    description: 'Arrow Up'
  },
  {
    id: 'arrow-down',
    spoken: ['arrow down', 'down'],
    output: '\x1b[B',
    outputLabel: '<DOWN>',
    description: 'Arrow Down'
  },
  {
    id: 'arrow-left',
    spoken: ['arrow left', 'left'],
    output: '\x1b[D',
    outputLabel: '<LEFT>',
    description: 'Arrow Left'
  },
  {
    id: 'arrow-right',
    spoken: ['arrow right', 'right'],
    output: '\x1b[C',
    outputLabel: '<RIGHT>',
    description: 'Arrow Right'
  }
];

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileCommandModeRules() {
  const compiled: CompiledCommandModeRule[] = COMMAND_MODE_RULES.map((rule) => {
    const spokenPatterns = rule.spoken.map((phrase) =>
      phrase
        .trim()
        .split(/\s+/)
        .map((part) => escapeRegex(part))
        .join('\\s+')
    );

    const maxWords = Math.max(...rule.spoken.map((phrase) => phrase.trim().split(/\s+/).length));
    const pattern = new RegExp(`\\b(?:${spokenPatterns.join('|')})\\b`, 'gi');
    return { ...rule, pattern, maxWords };
  });

  return compiled.sort((a, b) => b.maxWords - a.maxWords);
}

const COMMAND_MODE_RULES_COMPILED = compileCommandModeRules();

function applyCommandModeTransforms(input: string) {
  let output = input;

  for (const rule of COMMAND_MODE_RULES_COMPILED) {
    output = output.replace(rule.pattern, rule.output);
  }

  output = output.replace(/\s+([,.;:!?])/g, '$1');
  output = output.replace(/\s*\|\s*/g, ' | ');
  output = output.replace(/\s*(\x1b\[[ABCD])\s*/g, '$1');
  output = output.replace(/[ \t]*\r[ \t]*/g, '\r');
  output = output.replace(/[ \t]{2,}/g, ' ');
  output = output.replace(/^[ \t]+|[ \t]+$/g, '');

  return output;
}

function formatCommandOutputPreview(input: string) {
  return input
    .replace(/\x1b\[A/g, '<UP>')
    .replace(/\x1b\[B/g, '<DOWN>')
    .replace(/\x1b\[D/g, '<LEFT>')
    .replace(/\x1b\[C/g, '<RIGHT>')
    .replace(/\r/g, '<ENTER>');
}

function getPreferredAudioMimeType() {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
    return null;
  }

  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus'
  ];

  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return null;
}

function isTouchLike() {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 900;
}

function shouldAutoShowKeyboardAfterVoiceStop() {
  if (typeof window === 'undefined') {
    return true;
  }

  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const phoneWidth = window.innerWidth <= 820;
  return !(coarsePointer && phoneWidth);
}

function isPhoneViewport() {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.innerWidth <= 820;
}

function getSpeechRecognitionCtor() {
  if (typeof window === 'undefined') {
    return null;
  }

  const speechWindow = window as WindowWithSpeechRecognition;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function getAudioContextCtor() {
  if (typeof window === 'undefined') {
    return null;
  }

  const audioWindow = window as WindowWithAudioContext;
  return audioWindow.AudioContext ?? audioWindow.webkitAudioContext ?? null;
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

function getKeyboardScaleBounds(viewport: KeyboardViewport) {
  return viewport === 'phone' ? { min: 70, max: 140 } : { min: 80, max: 155 };
}

function clampKeyboardScale(scale: number, viewport: KeyboardViewport) {
  const { min, max } = getKeyboardScaleBounds(viewport);
  return Math.max(min, Math.min(max, scale));
}

function getDefaultKeyboardScale(viewport: KeyboardViewport) {
  const target =
    viewport === 'phone' ? PHONE_KEYBOARD_DEFAULT_SCALE : TABLET_KEYBOARD_DEFAULT_SCALE;
  return clampKeyboardScale(target, viewport);
}

function readStoredKeyboardScale(viewport: KeyboardViewport) {
  try {
    const raw = localStorage.getItem(`${KEYBOARD_SCALE_KEY_PREFIX}${viewport}`);
    if (!raw) {
      return getDefaultKeyboardScale(viewport);
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      return getDefaultKeyboardScale(viewport);
    }

    return clampKeyboardScale(parsed, viewport);
  } catch {
    return getDefaultKeyboardScale(viewport);
  }
}

function persistKeyboardScale(viewport: KeyboardViewport, scale: number) {
  localStorage.setItem(`${KEYBOARD_SCALE_KEY_PREFIX}${viewport}`, String(scale));
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

function buildAlphaRows(uppercase: boolean, viewport: KeyboardViewport) {
  const lastRow =
    viewport === 'phone'
      ? '{sym} {ctrl} {alt} {space} , . {enter}'
      : '{sym} {ctrl} {alt} / {space} , . {enter}';

  if (uppercase) {
    return [
      '{tab} Q W E R T Y U I O P',
      '{caps} A S D F G H J K L',
      '{shift} Z X C V B N M {bksp}',
      lastRow
    ];
  }

  return [
    '{tab} q w e r t y u i o p',
    '{caps} a s d f g h j k l',
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

export function TerminalPane({ sessionId }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const manualSizeRef = useRef<GridSize | null>(null);
  const adjustManualSizeRef = useRef<(deltaCols: number, deltaRows: number) => void>(() => {});
  const resetManualSizeRef = useRef<() => void>(() => {});
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const whisperRecorderRef = useRef<MediaRecorder | null>(null);
  const whisperStreamRef = useRef<MediaStream | null>(null);
  const whisperChunksRef = useRef<Blob[]>([]);
  const whisperAudioContextRef = useRef<AudioContext | null>(null);
  const whisperAnalyserRef = useRef<AnalyserNode | null>(null);
  const whisperSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const whisperSilenceTimerRef = useRef<number | null>(null);
  const whisperLastSpeechAtRef = useRef(0);
  const whisperHeardSpeechRef = useRef(false);
  const speechFinalByIndexRef = useRef<Map<number, string>>(new Map());
  const speechCommittedSegmentsRef = useRef<string[]>([]);
  const speechKeepAliveRef = useRef(false);

  const [touchMode, setTouchMode] = useState(() => isTouchLike());
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardMode, setKeyboardMode] = useState<'abc' | 'sym'>('abc');
  const [keyboardViewport, setKeyboardViewport] = useState<KeyboardViewport>(() =>
    typeof window !== 'undefined' && (isTouchLike() || window.innerWidth <= 820)
      ? 'phone'
      : 'tablet'
  );
  const [keyboardScale, setKeyboardScale] = useState(() =>
    readStoredKeyboardScale(
      typeof window !== 'undefined' && (isTouchLike() || window.innerWidth <= 820)
        ? 'phone'
        : 'tablet'
    )
  );
  const [modifiers, setModifiers] = useState<Modifiers>({
    ctrl: false,
    alt: false,
    shift: false
  });
  const [capsLock, setCapsLock] = useState(false);
  const [speechListening, setSpeechListening] = useState(false);
  const [speechError, setSpeechError] = useState('');
  const [speechFinalText, setSpeechFinalText] = useState('');
  const [speechPreviewText, setSpeechPreviewText] = useState('');
  const [browserSpeechSupported] = useState(() => Boolean(getSpeechRecognitionCtor()));
  const [voiceEngine, setVoiceEngine] = useState<VoiceEngine>('browser');
  const [whisperConfigured, setWhisperConfigured] = useState(false);
  const [whisperBusy, setWhisperBusy] = useState(false);
  const [whisperRecording, setWhisperRecording] = useState(false);
  const [commandModeEnabled, setCommandModeEnabled] = useState(false);
  const [commandListVisible, setCommandListVisible] = useState(false);
  const speechSupported = browserSpeechSupported || whisperConfigured;

  useEffect(() => {
    const updateTouchMode = () => {
      const next = isTouchLike();
      setTouchMode(next);
      setKeyboardViewport(next || window.innerWidth <= 820 ? 'phone' : 'tablet');
      if (!next) {
        setKeyboardVisible(false);
      }
    };

    updateTouchMode();
    window.addEventListener('resize', updateTouchMode);

    return () => {
      window.removeEventListener('resize', updateTouchMode);
    };
  }, []);

  useEffect(() => {
    setKeyboardScale(readStoredKeyboardScale(keyboardViewport));
  }, [keyboardViewport]);

  useEffect(() => {
    setKeyboardScale((current) => clampKeyboardScale(current, keyboardViewport));
  }, [keyboardViewport, touchMode]);

  useEffect(() => {
    let cancelled = false;

    async function loadSpeechStatus() {
      try {
        const response = await fetch('/api/speech/status');
        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as { configured?: boolean };
        if (cancelled) {
          return;
        }

        const configured = Boolean(payload.configured);
        setWhisperConfigured(configured);
        if (configured) {
          setVoiceEngine('whisper');
        }
      } catch {
        // Keep browser speech as fallback.
      }
    }

    loadSpeechStatus().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const term = new Terminal({
      cursorBlink: true,
      convertEol: false,
      scrollback: 10000,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      fontSize: isPhoneViewport() ? PHONE_TERMINAL_FONT_SIZE : DEFAULT_TERMINAL_FONT_SIZE,
      fontFamily: POWERLINE_FONT_FAMILY,
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

    let activeTouchId: number | null = null;
    let touchStartX = 0;
    let touchStartY = 0;
    let touchLastY = 0;
    let touchCurrentX = 0;
    let touchCurrentY = 0;
    let touchMoved = false;
    let touchWheelRemainder = 0;
    let touchSelectionIntent = false;
    let touchSelectionDragging = false;
    let touchSelectionTimer: number | null = null;

    const clearTouchSelectionTimer = () => {
      if (touchSelectionTimer !== null) {
        window.clearTimeout(touchSelectionTimer);
        touchSelectionTimer = null;
      }
    };

    const clampPointToBounds = (target: HTMLElement, clientX: number, clientY: number) => {
      const bounds = target.getBoundingClientRect();
      const minClientX = bounds.left + 1;
      const maxClientX = bounds.right - 1;
      const minClientY = bounds.top + 1;
      const maxClientY = bounds.bottom - 1;
      const clampedX =
        minClientX <= maxClientX
          ? Math.min(maxClientX, Math.max(minClientX, clientX))
          : clientX;
      const clampedY =
        minClientY <= maxClientY
          ? Math.min(maxClientY, Math.max(minClientY, clientY))
          : clientY;

      return { x: clampedX, y: clampedY };
    };

    const dispatchSelectionMouseEvent = (
      target: HTMLElement,
      type: 'mousedown' | 'mousemove' | 'mouseup',
      clientX: number,
      clientY: number,
      buttons: 0 | 1
    ) => {
      const point = clampPointToBounds(target, clientX, clientY);
      target.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons,
          clientX: point.x,
          clientY: point.y
        })
      );
    };

    const getTrackedTouch = (touches: TouchList, identifier: number | null) => {
      if (touches.length === 0) {
        return null;
      }

      if (identifier === null) {
        return touches[0] ?? null;
      }

      for (let index = 0; index < touches.length; index += 1) {
        const touch = touches[index];
        if (touch.identifier === identifier) {
          return touch;
        }
      }

      return null;
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (!isTouchLike()) {
        return;
      }

      if (event.touches.length !== 1) {
        activeTouchId = null;
        touchMoved = true;
        touchSelectionIntent = false;
        touchSelectionDragging = false;
        clearTouchSelectionTimer();
        return;
      }

      const touch = event.touches[0];
      activeTouchId = touch.identifier;
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      touchLastY = touch.clientY;
      touchCurrentX = touch.clientX;
      touchCurrentY = touch.clientY;
      touchMoved = false;
      touchWheelRemainder = 0;
      touchSelectionIntent = false;
      clearTouchSelectionTimer();
      touchSelectionTimer = window.setTimeout(() => {
        touchSelectionIntent = true;
        const selectionTarget = term.element ?? containerRef.current;
        if (selectionTarget && activeTouchId !== null && !touchSelectionDragging) {
          dispatchSelectionMouseEvent(
            selectionTarget,
            'mousedown',
            touchCurrentX,
            touchCurrentY,
            1
          );
          touchSelectionDragging = true;
        }
        touchSelectionTimer = null;
      }, TOUCH_SELECTION_HOLD_MS);
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!isTouchLike() || activeTouchId === null) {
        return;
      }

      const touch = getTrackedTouch(event.touches, activeTouchId);
      if (!touch) {
        touchMoved = true;
        return;
      }
      touchCurrentX = touch.clientX;
      touchCurrentY = touch.clientY;

      const deltaY = touchLastY - touch.clientY;
      touchLastY = touch.clientY;
      const deltaFromStartX = Math.abs(touch.clientX - touchStartX);
      const deltaFromStartY = Math.abs(touch.clientY - touchStartY);

      if (
        deltaFromStartX > TOUCH_MOVE_CANCEL_SELECTION_PX ||
        deltaFromStartY > TOUCH_MOVE_CANCEL_SELECTION_PX
      ) {
        clearTouchSelectionTimer();
      }

      if (deltaFromStartX > TOUCH_TAP_THRESHOLD_PX || deltaFromStartY > TOUCH_TAP_THRESHOLD_PX) {
        touchMoved = true;
      }

      if (touchSelectionIntent) {
        event.preventDefault();
        const selectionTarget = term.element ?? containerRef.current;
        if (selectionTarget) {
          if (!touchSelectionDragging) {
            dispatchSelectionMouseEvent(
              selectionTarget,
              'mousedown',
              touchStartX,
              touchStartY,
              1
            );
            touchSelectionDragging = true;
          }
          dispatchSelectionMouseEvent(
            selectionTarget,
            'mousemove',
            touch.clientX,
            touch.clientY,
            1
          );
        }
        return;
      }

      if (!touchMoved || deltaY === 0) {
        return;
      }

      event.preventDefault();
      touchWheelRemainder += deltaY;

      const wheelTarget = term.element ?? containerRef.current;
      if (!wheelTarget) {
        return;
      }

      const wheelPoint = clampPointToBounds(wheelTarget, touch.clientX, touch.clientY);

      while (Math.abs(touchWheelRemainder) >= TOUCH_WHEEL_STEP_PX) {
        const wheelDelta = touchWheelRemainder > 0 ? TOUCH_WHEEL_STEP_PX : -TOUCH_WHEEL_STEP_PX;
        touchWheelRemainder -= wheelDelta;
        wheelTarget.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: wheelDelta,
            deltaMode: WheelEvent.DOM_DELTA_PIXEL,
            bubbles: true,
            cancelable: true,
            clientX: wheelPoint.x,
            clientY: wheelPoint.y
          })
        );
      }
    };

    const handleTouchEnd = (event: TouchEvent) => {
      if (!isTouchLike() || activeTouchId === null) {
        return;
      }

      const touch = getTrackedTouch(event.changedTouches, activeTouchId);
      const movedByDistance =
        touch !== null &&
        (Math.abs(touch.clientX - touchStartX) > TOUCH_TAP_THRESHOLD_PX ||
          Math.abs(touch.clientY - touchStartY) > TOUCH_TAP_THRESHOLD_PX);
      clearTouchSelectionTimer();

      if (touchSelectionIntent || touchSelectionDragging) {
        event.preventDefault();
        const selectionTarget = term.element ?? containerRef.current;
        if (selectionTarget) {
          dispatchSelectionMouseEvent(
            selectionTarget,
            'mouseup',
            touch?.clientX ?? touchStartX,
            touch?.clientY ?? touchStartY,
            0
          );
        }
        activeTouchId = null;
        touchMoved = false;
        touchWheelRemainder = 0;
        touchSelectionIntent = false;
        touchSelectionDragging = false;
        return;
      }

      if (!touchMoved && !movedByDistance) {
        event.preventDefault();
        term.focus();
        helperTextarea?.focus();
      }

      activeTouchId = null;
      touchMoved = false;
      touchWheelRemainder = 0;
      touchSelectionIntent = false;
      touchSelectionDragging = false;
    };

    const handleTouchCancel = () => {
      clearTouchSelectionTimer();
      if (touchSelectionDragging) {
        const selectionTarget = term.element ?? containerRef.current;
        if (selectionTarget) {
          dispatchSelectionMouseEvent(selectionTarget, 'mouseup', touchStartX, touchStartY, 0);
        }
      }
      activeTouchId = null;
      touchMoved = false;
      touchWheelRemainder = 0;
      touchSelectionIntent = false;
      touchSelectionDragging = false;
    };

    if (helperTextarea) {
      helperTextarea.setAttribute('inputmode', 'text');
      helperTextarea.setAttribute('autocorrect', 'off');
      helperTextarea.setAttribute('autocapitalize', 'off');
      helperTextarea.spellcheck = false;
    }

    containerRef.current.addEventListener('touchstart', handleTouchStart, {
      passive: true
    });
    containerRef.current.addEventListener('touchmove', handleTouchMove, {
      passive: false
    });
    containerRef.current.addEventListener('touchend', handleTouchEnd, {
      passive: false
    });
    containerRef.current.addEventListener('touchcancel', handleTouchCancel, {
      passive: true
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
      clearTouchSelectionTimer();
      containerRef.current?.removeEventListener('touchstart', handleTouchStart);
      containerRef.current?.removeEventListener('touchmove', handleTouchMove);
      containerRef.current?.removeEventListener('touchend', handleTouchEnd);
      containerRef.current?.removeEventListener('touchcancel', handleTouchCancel);
      resizeObserver.disconnect();
      dataSubscription.dispose();
      ws.close();
      term.dispose();
      wsRef.current = null;
      termRef.current = null;
      adjustManualSizeRef.current = () => {};
      resetManualSizeRef.current = () => {};
      setModifiers({ ctrl: false, alt: false, shift: false });
      setCapsLock(false);
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

  const pasteFromClipboard = async () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          sendInput(text);
          return;
        }
      } catch {
        // Fallback to prompt below if clipboard read is blocked.
      }
    }

    const manualText = window.prompt('Paste text');
    if (manualText) {
      sendInput(manualText);
    }
  };

  const copySelection = async () => {
    const selected = termRef.current?.getSelection() ?? '';
    if (!selected) {
      return;
    }

    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(selected);
        return;
      } catch {
        // Fall through to legacy copy command.
      }
    }

    const helper = document.createElement('textarea');
    helper.value = selected;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.top = '-9999px';
    helper.style.left = '-9999px';
    document.body.appendChild(helper);
    helper.select();
    try {
      document.execCommand('copy');
    } finally {
      document.body.removeChild(helper);
    }
  };

  const releaseSpeechRecognition = (abort: boolean) => {
    const recognition = speechRecognitionRef.current;
    if (!recognition) {
      return;
    }

    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;

    try {
      if (abort) {
        recognition.abort();
      } else {
        recognition.stop();
      }
    } catch {
      // Ignore state errors during speech recognizer teardown.
    }

    speechRecognitionRef.current = null;
  };

  const clearWhisperSilenceWatcher = () => {
    if (whisperSilenceTimerRef.current !== null) {
      window.clearInterval(whisperSilenceTimerRef.current);
      whisperSilenceTimerRef.current = null;
    }

    const source = whisperSourceRef.current;
    if (source) {
      try {
        source.disconnect();
      } catch {
        // Ignore disconnect errors.
      }
    }
    whisperSourceRef.current = null;

    const analyser = whisperAnalyserRef.current;
    if (analyser) {
      try {
        analyser.disconnect();
      } catch {
        // Ignore disconnect errors.
      }
    }
    whisperAnalyserRef.current = null;

    const audioContext = whisperAudioContextRef.current;
    if (audioContext) {
      audioContext.close().catch(() => {});
    }
    whisperAudioContextRef.current = null;

    whisperLastSpeechAtRef.current = 0;
    whisperHeardSpeechRef.current = false;
  };

  const releaseWhisperCapture = () => {
    clearWhisperSilenceWatcher();

    const recorder = whisperRecorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      try {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      } catch {
        // Ignore recorder teardown errors.
      }
    }
    whisperRecorderRef.current = null;

    const stream = whisperStreamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore track stop errors.
        }
      }
    }
    whisperStreamRef.current = null;
    whisperChunksRef.current = [];
    setWhisperBusy(false);
  };

  const stopSpeechInput = () => {
    const restoreKeyboard = () => {
      if (shouldAutoShowKeyboardAfterVoiceStop()) {
        setKeyboardVisible(true);
      }
    };

    if (voiceEngine === 'whisper') {
      if (whisperRecording) {
        const recorder = whisperRecorderRef.current;
        setWhisperRecording(false);
        setWhisperBusy(true);
        try {
          if (recorder && recorder.state !== 'inactive') {
            recorder.stop();
          } else {
            setWhisperBusy(false);
          }
        } catch {
          setWhisperBusy(false);
        }
        return;
      }

      speechKeepAliveRef.current = false;
      setWhisperBusy(false);
      setWhisperRecording(false);
      if (!whisperRecorderRef.current && !whisperStreamRef.current) {
        setSpeechListening(false);
        restoreKeyboard();
      } else {
        releaseWhisperCapture();
      }
      setSpeechListening(false);
      restoreKeyboard();
      return;
    }

    commitSpeechRun();
    releaseSpeechRecognition(true);

    setSpeechListening(false);
    restoreKeyboard();
  };

  const buildSpeechRunText = () => {
    return Array.from(speechFinalByIndexRef.current.entries())
      .sort((a, b) => a[0] - b[0])
      .map((entry) => entry[1])
      .filter(Boolean)
      .join(' ')
      .trim();
  };

  const formatSpeechSegment = (segment: string) => {
    const trimmed = segment.trim();
    if (!trimmed) {
      return '';
    }

    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  };

  const buildSpeechPreviewText = (runText: string) => {
    const committed = speechCommittedSegmentsRef.current
      .map((segment) => formatSpeechSegment(segment))
      .filter(Boolean)
      .join(' ')
      .trim();
    const currentRun = runText ? formatSpeechSegment(runText) : '';
    return [committed, currentRun].filter(Boolean).join(' ').trim();
  };

  const updateSpeechPreviewText = () => {
    const runText = buildSpeechRunText();
    const committed = speechCommittedSegmentsRef.current.join(' ').trim();
    const combined = [committed, runText].filter(Boolean).join(' ').trim();
    setSpeechFinalText(combined);
    setSpeechPreviewText(buildSpeechPreviewText(runText));
  };

  const commitSpeechRun = () => {
    const runText = buildSpeechRunText();
    if (runText) {
      speechCommittedSegmentsRef.current.push(runText);
    }
    speechFinalByIndexRef.current = new Map();
    setSpeechFinalText(speechCommittedSegmentsRef.current.join(' ').trim());
    setSpeechPreviewText(buildSpeechPreviewText(''));
  };

  const appendSpeechSegment = (segment: string) => {
    const cleaned = segment.trim();
    if (!cleaned) {
      return;
    }
    speechCommittedSegmentsRef.current.push(cleaned);
    setSpeechFinalText(speechCommittedSegmentsRef.current.join(' ').trim());
    setSpeechPreviewText(buildSpeechPreviewText(''));
  };

  const transcribeWhisperBlob = async (blob: Blob) => {
    if (!blob.size) {
      return;
    }

    setWhisperBusy(true);
    try {
      const language = (navigator.language || 'en-US').split('-')[0];
      const response = await fetch(`/api/speech/transcribe?language=${encodeURIComponent(language)}`, {
        method: 'POST',
        headers: {
          'Content-Type': blob.type || 'audio/webm'
        },
        body: blob
      });

      const payload = (await response.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'Transcription failed');
      }

      const text = (payload.text || '').trim();
      if (text) {
        appendSpeechSegment(text);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Transcription failed';
      setSpeechError(message);
    } finally {
      setWhisperBusy(false);
    }
  };

  const startBrowserSpeechInput = () => {
    releaseWhisperCapture();
    setWhisperRecording(false);
    setWhisperBusy(false);

    const SpeechRecognition = getSpeechRecognitionCtor();
    if (!SpeechRecognition) {
      speechKeepAliveRef.current = false;
      setSpeechError('Voice input is not supported in this browser.');
      setSpeechListening(false);
      return;
    }

    // Recreate recognizer each start to avoid stale Android background state.
    releaseSpeechRecognition(true);
    speechKeepAliveRef.current = true;
    setSpeechError('');
    setSpeechFinalText('');
    setSpeechPreviewText('');
    speechCommittedSegmentsRef.current = [];
    speechFinalByIndexRef.current = new Map();
    setKeyboardVisible(false);

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.lang = navigator.language || 'en-US';

    recognition.onresult = (event) => {
      const speechEvent = event as SpeechRecognitionEventLike;

      if (!speechEvent.results) {
        return;
      }

      for (let index = 0; index < speechEvent.results.length; index += 1) {
        const result = speechEvent.results[index];
        const transcript = result?.[0]?.transcript ?? '';
        if (!transcript) {
          continue;
        }

        if (result?.isFinal) {
          speechFinalByIndexRef.current.set(index, transcript.trim());
        }
      }

      updateSpeechPreviewText();
    };

    recognition.onerror = (event) => {
      const speechErrorEvent = event as SpeechRecognitionErrorEventLike;
      const reason = speechErrorEvent.error ?? 'unknown';
      const recoverable = reason === 'no-speech' || reason === 'aborted';
      if (!recoverable) {
        speechKeepAliveRef.current = false;
        setSpeechError(`Voice input error: ${reason}.`);
        releaseSpeechRecognition(true);
      }
      if (!speechKeepAliveRef.current) {
        setSpeechListening(false);
      }
    };

    recognition.onend = () => {
      commitSpeechRun();
      if (speechKeepAliveRef.current) {
        try {
          recognition.start();
          setSpeechListening(true);
          return;
        } catch {
          window.setTimeout(() => {
            if (!speechKeepAliveRef.current) {
              return;
            }
            try {
              recognition.start();
              setSpeechListening(true);
            } catch {
              setSpeechListening(false);
              releaseSpeechRecognition(true);
            }
          }, 120);
          return;
        }
      }
      setSpeechListening(false);
      if (shouldAutoShowKeyboardAfterVoiceStop()) {
        setKeyboardVisible(true);
      }
      releaseSpeechRecognition(false);
    };

    speechRecognitionRef.current = recognition;

    recognition.lang = navigator.language || recognition.lang;

    try {
      recognition.start();
      setSpeechListening(true);
    } catch {
      speechKeepAliveRef.current = false;
      setSpeechError('Could not start voice input. Check mic permission and retry.');
      setSpeechListening(false);
      releaseSpeechRecognition(true);
    }
  };

  const startWhisperSpeechInput = async () => {
    if (!whisperConfigured) {
      setSpeechError('Whisper backend is not configured on the server.');
      return;
    }

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia ||
      typeof MediaRecorder === 'undefined'
    ) {
      setSpeechError('Audio recording is not supported in this browser.');
      return;
    }

    if (whisperRecording || whisperBusy) {
      return;
    }

    const isFreshSession = !speechListening;
    releaseWhisperCapture();
    speechKeepAliveRef.current = true;
    setSpeechError('');
    if (isFreshSession) {
      setSpeechFinalText('');
      setSpeechPreviewText('');
      speechCommittedSegmentsRef.current = [];
      speechFinalByIndexRef.current = new Map();
    }
    setKeyboardVisible(false);

    const mimeType = getPreferredAudioMimeType();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          noiseSuppression: true,
          echoCancellation: true
        }
      });

      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      whisperStreamRef.current = stream;
      whisperRecorderRef.current = recorder;
      whisperChunksRef.current = [];
      whisperLastSpeechAtRef.current = Date.now();
      whisperHeardSpeechRef.current = false;

      const AudioContextCtor = getAudioContextCtor();
      if (AudioContextCtor) {
        try {
          const audioContext = new AudioContextCtor();
          const analyser = audioContext.createAnalyser();
          analyser.fftSize = 2048;
          analyser.smoothingTimeConstant = 0.15;
          const source = audioContext.createMediaStreamSource(stream);
          source.connect(analyser);

          whisperAudioContextRef.current = audioContext;
          whisperAnalyserRef.current = analyser;
          whisperSourceRef.current = source;

          const samples = new Uint8Array(analyser.fftSize);
          whisperSilenceTimerRef.current = window.setInterval(() => {
            if (recorder.state !== 'recording') {
              return;
            }

            analyser.getByteTimeDomainData(samples);
            let sumSquares = 0;
            for (let index = 0; index < samples.length; index += 1) {
              const normalized = (samples[index] - 128) / 128;
              sumSquares += normalized * normalized;
            }

            const rms = Math.sqrt(sumSquares / samples.length);
            if (rms >= WHISPER_SILENCE_RMS_THRESHOLD) {
              whisperHeardSpeechRef.current = true;
              whisperLastSpeechAtRef.current = Date.now();
              return;
            }

            if (
              whisperHeardSpeechRef.current &&
              Date.now() - whisperLastSpeechAtRef.current >= WHISPER_SILENCE_HOLD_MS
            ) {
              whisperHeardSpeechRef.current = false;
              setWhisperRecording(false);
              setWhisperBusy(true);
              try {
                recorder.stop();
              } catch {
                setWhisperBusy(false);
              }
            }
          }, WHISPER_SILENCE_INTERVAL_MS);
        } catch {
          // Silence detection is optional; recording still works without it.
        }
      }

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          whisperChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        clearWhisperSilenceWatcher();
        setSpeechError('Could not record audio.');
        setWhisperRecording(false);
        setWhisperBusy(false);
        setSpeechListening(false);
      };

      recorder.onstop = () => {
        clearWhisperSilenceWatcher();
        const chunks = whisperChunksRef.current;
        whisperChunksRef.current = [];

        const recordedBlob = new Blob(chunks, {
          type: recorder.mimeType || mimeType || 'audio/webm'
        });

        const activeStream = whisperStreamRef.current;
        if (activeStream) {
          for (const track of activeStream.getTracks()) {
            try {
              track.stop();
            } catch {
              // Ignore cleanup errors.
            }
          }
        }
        whisperStreamRef.current = null;
        whisperRecorderRef.current = null;

        transcribeWhisperBlob(recordedBlob)
          .catch(() => {})
          .finally(() => {
            setWhisperBusy(false);
          });
      };

      recorder.start(1000);
      setSpeechListening(true);
      setWhisperBusy(false);
      setWhisperRecording(true);
    } catch {
      speechKeepAliveRef.current = false;
      setSpeechError('Could not start voice input. Check mic permission and retry.');
      setWhisperRecording(false);
      setWhisperBusy(false);
      setSpeechListening(false);
      releaseWhisperCapture();
    }
  };

  const startSpeechInput = () => {
    if (voiceEngine === 'whisper') {
      startWhisperSpeechInput().catch(() => {});
      return;
    }

    startBrowserSpeechInput();
  };

  useEffect(() => {
    const handleAppHidden = () => {
      if (!document.hidden) {
        return;
      }

      speechKeepAliveRef.current = false;
      setWhisperRecording(false);
      setWhisperBusy(false);
      setSpeechListening(false);
      setCommandListVisible(false);
      releaseSpeechRecognition(true);
      releaseWhisperCapture();
    };

    const handlePageHide = () => {
      speechKeepAliveRef.current = false;
      setWhisperRecording(false);
      setWhisperBusy(false);
      setSpeechListening(false);
      setCommandListVisible(false);
      releaseSpeechRecognition(true);
      releaseWhisperCapture();
    };

    document.addEventListener('visibilitychange', handleAppHidden);
    window.addEventListener('pagehide', handlePageHide);

    return () => {
      document.removeEventListener('visibilitychange', handleAppHidden);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, []);

  useEffect(() => {
    return () => {
      speechKeepAliveRef.current = false;
      releaseSpeechRecognition(true);
      releaseWhisperCapture();
    };
  }, []);

  useEffect(() => {
    speechKeepAliveRef.current = false;
    setSpeechError('');
    setSpeechListening(false);
    setSpeechFinalText('');
    setSpeechPreviewText('');
    setCommandListVisible(false);
    setWhisperRecording(false);
    setWhisperBusy(false);
    speechCommittedSegmentsRef.current = [];
    speechFinalByIndexRef.current = new Map();
    releaseSpeechRecognition(true);
    releaseWhisperCapture();
  }, [sessionId]);

  const clearSpeechBuffer = () => {
    setSpeechFinalText('');
    setSpeechPreviewText('');
    speechCommittedSegmentsRef.current = [];
    speechFinalByIndexRef.current = new Map();
  };

  const clearLastSpeechSegment = () => {
    const runText = buildSpeechRunText();
    if (runText) {
      speechFinalByIndexRef.current = new Map();
      updateSpeechPreviewText();
      return;
    }

    if (!speechCommittedSegmentsRef.current.length) {
      return;
    }

    speechCommittedSegmentsRef.current.pop();
    updateSpeechPreviewText();
  };

  const sendSpeechBuffer = (withEnter: boolean) => {
    const rawBuffered = speechFinalText.replace(/\s+/g, ' ').trim();
    if (!rawBuffered && !withEnter) {
      return;
    }

    const buffered = commandModeEnabled
      ? applyCommandModeTransforms(rawBuffered)
      : rawBuffered;

    if (buffered) {
      sendInput(buffered);
    }
    if (withEnter) {
      // Send Enter as a dedicated key event payload after text.
      sendInput('\r');
    }
    clearSpeechBuffer();
  };

  const handleKeyboardToggle = () => {
    if (speechListening) {
      stopSpeechInput();
      setKeyboardVisible(true);
      return;
    }

    setKeyboardVisible((prev) => !prev);
  };

  const handleVoiceToggle = () => {
    if (voiceEngine === 'whisper' && speechListening && !whisperRecording && !whisperBusy) {
      startWhisperSpeechInput().catch(() => {});
      return;
    }

    if (speechListening) {
      stopSpeechInput();
      return;
    }

    startSpeechInput();
  };

  const switchVoiceEngine = (nextEngine: VoiceEngine) => {
    if (nextEngine === voiceEngine) {
      return;
    }

    if (speechListening) {
      stopSpeechInput();
    }

    setSpeechError('');
    setVoiceEngine(nextEngine);
  };

  const commandOutputPreview = useMemo(() => {
    if (!commandModeEnabled) {
      return '';
    }

    const rawBuffered = speechFinalText.replace(/\s+/g, ' ').trim();
    if (!rawBuffered) {
      return '';
    }

    return formatCommandOutputPreview(applyCommandModeTransforms(rawBuffered));
  }, [commandModeEnabled, speechFinalText]);

  const clearOneShotModifiers = () => {
    setModifiers({ ctrl: false, alt: false, shift: false });
  };

  const sendCharacter = (key: string) => {
    const useUppercase = modifiers.shift !== capsLock;
    let value = useUppercase ? key.toUpperCase() : key;

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

    if (token === 'caps') {
      setCapsLock((prev) => !prev);
      setModifiers((prev) => ({ ...prev, shift: false }));
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

    if (token === 'mic') {
      handleVoiceToggle();
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
        ? buildAlphaRows(modifiers.shift !== capsLock, keyboardViewport)
        : buildSymbolRows(keyboardViewport);
    const utilityRow = speechSupported ? '{fit} {mic} {hide}' : '{fit} {hide}';
    return [...navRows, ...contentRows, utilityRow];
  }, [capsLock, keyboardMode, keyboardViewport, modifiers.shift, speechSupported]);

  const buttonTheme = useMemo(() => {
    const activeButtons = [
      modifiers.ctrl ? '{ctrl}' : '',
      modifiers.alt ? '{alt}' : '',
      modifiers.shift ? '{shift}' : '',
      capsLock ? '{caps}' : '',
      speechListening ? '{mic}' : ''
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
    const navButtons =
      keyboardViewport === 'phone'
        ? '{esc} {tab} {home} {end} {left} {up} {down} {right} {fit} {mic} {hide}'
        : '{esc} {tab} {home} {end} {pgup} {pgdn} {ins} {del} {left} {up} {down} {right} {f1} {f2} {f3} {f4} {f5} {f6} {f7} {f8} {f9} {f10} {f11} {f12} {fit} {mic} {hide}';
    themes.push({
      class: 'vk-mod',
      buttons: '{shift} {caps} {ctrl} {alt} {abc} {sym} {fit} {mic} {hide}'
    });
    themes.push({ class: 'vk-nav', buttons: navButtons });

    return themes;
  }, [capsLock, keyboardViewport, modifiers, speechListening]);

  const updateKeyboardScale = (nextScale: number) => {
    const clamped = clampKeyboardScale(nextScale, keyboardViewport);
    setKeyboardScale(clamped);
    persistKeyboardScale(keyboardViewport, clamped);
  };

  const adjustKeyboardScale = (delta: number) => {
    updateKeyboardScale(keyboardScale + delta);
  };

  const keyboardScaleBounds = getKeyboardScaleBounds(keyboardViewport);
  const keyboardScaleStyle = useMemo(
    () =>
      ({
        '--vk-scale': String(keyboardScale / 100)
      }) as CSSProperties,
    [keyboardScale]
  );

  const voiceToolbarLabel = speechListening
    ? voiceEngine === 'whisper'
      ? whisperRecording
        ? 'Stop recording'
        : whisperBusy
          ? 'Transcribing'
          : 'Record again'
      : 'Stop voice'
    : 'Voice input';
  const voiceReadyToResume =
    speechListening && voiceEngine === 'whisper' && !whisperRecording && !whisperBusy;

  return (
    <div className="terminal-frame">
      <div ref={containerRef} className="terminal-pane" />

      {touchMode ? (
        <div className="terminal-toolbar">
          <button
            type="button"
            className="terminal-toolbar-btn"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              copySelection().catch(() => {});
            }}
            title="Copy selected text"
            aria-label="Copy selected text"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M8 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2zm0 2v10h10V10H8zM4 4h10a2 2 0 0 1 2 2v1h-2V6H4v10h1v2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"
                fill="currentColor"
              />
            </svg>
          </button>
          <button
            type="button"
            className="terminal-toolbar-btn"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              pasteFromClipboard().catch(() => {});
            }}
            title="Paste from clipboard"
            aria-label="Paste from clipboard"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M16 4h-1.2A3 3 0 0 0 12 2a3 3 0 0 0-2.8 2H8a2 2 0 0 0-2 2v1h2V6h2.1a2 2 0 1 0 3.8 0H16v1h2V6a2 2 0 0 0-2-2zm-4 1a1 1 0 1 1 0-2 1 1 0 0 1 0 2zM7 9h10v11H7V9zm-2 0a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9z"
                fill="currentColor"
              />
            </svg>
          </button>
          <button
            type="button"
            className="terminal-toolbar-btn"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => sendAction('up')}
            aria-label="Arrow up"
          >
            ↑
          </button>
          <button
            type="button"
            className="terminal-toolbar-btn"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => sendAction('down')}
            aria-label="Arrow down"
          >
            ↓
          </button>
          <button
            type="button"
            className="terminal-toolbar-btn"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => sendAction('enter')}
            title="Enter"
            aria-label="Enter"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M4 5a1 1 0 0 1 1-1h7a1 1 0 1 1 0 2H6v6h10.59l-2.3-2.29a1 1 0 1 1 1.42-1.42l4 4a1 1 0 0 1 0 1.42l-4 4a1 1 0 1 1-1.42-1.42L16.59 14H5a1 1 0 0 1-1-1V5z"
                fill="currentColor"
              />
            </svg>
          </button>
          <button
            type="button"
            className={`terminal-toolbar-btn ${keyboardVisible ? 'mode-active' : ''}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={handleKeyboardToggle}
            title={keyboardVisible ? 'Hide keyboard' : 'Show keyboard'}
            aria-label={keyboardVisible ? 'Hide keyboard' : 'Show keyboard'}
          >
            ⌨
          </button>
          {speechSupported ? (
            <button
              type="button"
              className={`terminal-toolbar-btn ${
                voiceReadyToResume ? 'success' : speechListening ? 'listening' : ''
              }`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleVoiceToggle}
              title={voiceToolbarLabel}
              aria-label={voiceToolbarLabel}
            >
              {speechListening && !voiceReadyToResume ? (
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path d="M7 7h10v10H7z" fill="currentColor" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path
                    d="M12 15a3 3 0 0 0 3-3V7a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a1 1 0 0 1 2 0 7 7 0 0 1-6 6.93V21h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-2.07A7 7 0 0 1 5 12a1 1 0 1 1 2 0 5 5 0 1 0 10 0z"
                    fill="currentColor"
                  />
                </svg>
              )}
            </button>
          ) : null}
        </div>
      ) : null}

      {touchMode && speechError ? (
        <div className="terminal-speech-error">{speechError}</div>
      ) : null}
      {touchMode && speechListening ? (
        <div className="terminal-voice-panel">
          <div className="terminal-voice-mode-row">
            <button
              type="button"
              className={`terminal-toolbar-btn ${voiceEngine === 'browser' ? 'mode-active' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => switchVoiceEngine('browser')}
            >
              Browser
            </button>
            <button
              type="button"
              className={`terminal-toolbar-btn ${voiceEngine === 'whisper' ? 'mode-active' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => switchVoiceEngine('whisper')}
              disabled={!whisperConfigured}
            >
              Whisper
            </button>
            <button
              type="button"
              className={`terminal-toolbar-btn ${commandModeEnabled ? 'mode-active' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setCommandModeEnabled((prev) => !prev)}
            >
              Commands: {commandModeEnabled ? 'On' : 'Off'}
            </button>
            <button
              type="button"
              className="terminal-toolbar-btn"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setCommandListVisible((prev) => !prev)}
            >
              {commandListVisible ? 'Hide Commands' : 'Show Commands'}
            </button>
          </div>

          <div className="terminal-voice-preview">
            {speechPreviewText.trim() ||
              (voiceEngine === 'whisper' && whisperBusy
                ? 'Transcribing...'
                : voiceEngine === 'whisper' && !whisperRecording
                  ? 'Ready to send. Tap Record Again for another segment.'
                  : 'Listening...')}
          </div>

          {commandModeEnabled ? (
            <div className="terminal-command-preview">
              <div className="terminal-command-label">Command Output</div>
              <div className="terminal-command-value">
                {commandOutputPreview || '(no command output yet)'}
              </div>
            </div>
          ) : null}

          {commandListVisible ? (
            <div className="terminal-command-list">
              {COMMAND_MODE_RULES.map((rule) => (
                <div key={rule.id} className="terminal-command-item">
                  <span className="terminal-command-spoken">{rule.spoken.join(' / ')}</span>
                  <span className="terminal-command-arrow">{'->'}</span>
                  <span className="terminal-command-output">{rule.outputLabel}</span>
                  <span className="terminal-command-desc">{rule.description}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="terminal-voice-actions">
            {voiceEngine === 'whisper' && !whisperRecording ? (
              <button
                type="button"
                className="terminal-toolbar-btn"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => startWhisperSpeechInput().catch(() => {})}
                disabled={whisperBusy}
              >
                {whisperBusy ? 'Transcribing...' : 'Record'}
              </button>
            ) : null}
            <button
              type="button"
              className="terminal-toolbar-btn send-left"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => sendSpeechBuffer(false)}
              disabled={!speechFinalText.trim()}
            >
              Send
            </button>
            <button
              type="button"
              className="terminal-toolbar-btn"
              onMouseDown={(event) => event.preventDefault()}
              onClick={clearLastSpeechSegment}
              disabled={!speechFinalText.trim()}
            >
              Clear Last
            </button>
            <button
              type="button"
              className="terminal-toolbar-btn"
              onMouseDown={(event) => event.preventDefault()}
              onClick={clearSpeechBuffer}
              disabled={!speechFinalText.trim()}
            >
              Clear
            </button>
            <button
              type="button"
              className="terminal-toolbar-btn listening"
              onMouseDown={(event) => event.preventDefault()}
              onClick={stopSpeechInput}
            >
              {voiceEngine === 'whisper' && whisperRecording ? 'Stop Recording' : 'Close Voice'}
            </button>
            <button
              type="button"
              className="terminal-toolbar-btn success"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => sendSpeechBuffer(true)}
            >
              Send + Enter
            </button>
          </div>
        </div>
      ) : null}

      {touchMode && keyboardVisible && !speechListening ? (
        <div
          className={`terminal-keyboard ${keyboardViewport === 'phone' ? 'phone' : ''}`}
          style={keyboardScaleStyle}
        >
          <div className="terminal-keyboard-resize">
            <button
              type="button"
              className="terminal-toolbar-btn"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => adjustKeyboardScale(-5)}
            >
              A-
            </button>
            <input
              type="range"
              min={keyboardScaleBounds.min}
              max={keyboardScaleBounds.max}
              value={keyboardScale}
              className="terminal-keyboard-range"
              aria-label="Keyboard key size"
              onChange={(event) =>
                updateKeyboardScale(Number.parseInt(event.target.value, 10) || keyboardScale)
              }
            />
            <span className="terminal-keyboard-size-label">{keyboardScale}%</span>
            <button
              type="button"
              className="terminal-toolbar-btn"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => adjustKeyboardScale(5)}
            >
              A+
            </button>
          </div>
          <VirtualKeyboard
            rows={keyboardRows}
            display={KEYBOARD_DISPLAY}
            onKeyPress={onVirtualKeyPress}
            buttonTheme={buttonTheme}
            themeClass={keyboardViewport === 'phone' ? 'webtmux-phone' : 'webtmux-tablet'}
          />
        </div>
      ) : null}
    </div>
  );
}
