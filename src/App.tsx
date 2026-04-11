import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TerminalPane } from './TerminalPane';

type Session = {
  id: string;
  name: string;
  createdAt: string;
  lastActivityAt?: string;
  status: 'running' | 'exited';
  alerts?: string;
};

type StoppedSessionAlert = {
  id: string;
  name: string;
  stoppedAt: string;
  seen: boolean;
  reason: 'missing' | 'exited';
};

type LiveSessionAlert = {
  token: string;
};

const SESSION_ORDER_KEY = 'webtmux-session-order';
const SESSION_ACTIVITY_SEEN_KEY = 'webtmux-session-activity-seen';
const SESSION_SNAPSHOT_KEY = 'webtmux-session-snapshot';
const SESSION_ALERT_SEEN_KEY = 'webtmux-session-alert-seen';
const SIDEBAR_HIDDEN_KEY = 'webtmux-sidebar-hidden';
const SOUND_ALERTS_ENABLED_KEY = 'webtmux-sound-alerts-enabled';

function readSessionOrder(): string[] {
  try {
    const raw = localStorage.getItem(SESSION_ORDER_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function persistSessionOrder(order: string[]) {
  localStorage.setItem(SESSION_ORDER_KEY, JSON.stringify(order));
}

function readSeenActivityMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SESSION_ACTIVITY_SEEN_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, string>;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    const cleaned: Record<string, string> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof id === 'string' && typeof value === 'string' && value) {
        cleaned[id] = value;
      }
    }

    return cleaned;
  } catch {
    return {};
  }
}

function persistSeenActivityMap(map: Record<string, string>) {
  localStorage.setItem(SESSION_ACTIVITY_SEEN_KEY, JSON.stringify(map));
}

function readSessionSnapshot(): Map<string, Session> {
  try {
    const raw = localStorage.getItem(SESSION_SNAPSHOT_KEY);
    if (!raw) {
      return new Map();
    }

    const parsed = JSON.parse(raw) as Session[];
    if (!Array.isArray(parsed)) {
      return new Map();
    }

    return new Map(
      parsed
        .filter((item) => item && typeof item.id === 'string')
        .map((item) => [item.id, item])
    );
  } catch {
    return new Map();
  }
}

function persistSessionSnapshot(sessions: Session[]) {
  localStorage.setItem(SESSION_SNAPSHOT_KEY, JSON.stringify(sessions));
}

function readSeenAlertTokenMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SESSION_ALERT_SEEN_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, string>;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    const cleaned: Record<string, string> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof id === 'string' && typeof value === 'string' && value) {
        cleaned[id] = value;
      }
    }

    return cleaned;
  } catch {
    return {};
  }
}

function persistSeenAlertTokenMap(map: Record<string, string>) {
  localStorage.setItem(SESSION_ALERT_SEEN_KEY, JSON.stringify(map));
}

function readSidebarHidden() {
  try {
    return localStorage.getItem(SIDEBAR_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

function persistSidebarHidden(hidden: boolean) {
  localStorage.setItem(SIDEBAR_HIDDEN_KEY, hidden ? '1' : '0');
}

function readSoundAlertsEnabled() {
  try {
    const raw = localStorage.getItem(SOUND_ALERTS_ENABLED_KEY);
    if (raw === null) {
      return true;
    }
    return raw !== '0';
  } catch {
    return true;
  }
}

function persistSoundAlertsEnabled(enabled: boolean) {
  localStorage.setItem(SOUND_ALERTS_ENABLED_KEY, enabled ? '1' : '0');
}

function syncSessionOrder(sessionIds: string[], existingOrder: string[]) {
  const presentIds = new Set(sessionIds);
  const nextOrder = existingOrder.filter((id) => presentIds.has(id));

  for (const id of sessionIds) {
    if (!nextOrder.includes(id)) {
      nextOrder.push(id);
    }
  }

  return nextOrder;
}

function sortSessionsByOrder(sessions: Session[], order: string[]) {
  const indexMap = new Map(order.map((id, idx) => [id, idx]));

  return [...sessions].sort((a, b) => {
    const ai = indexMap.has(a.id)
      ? (indexMap.get(a.id) as number)
      : Number.MAX_SAFE_INTEGER;
    const bi = indexMap.has(b.id)
      ? (indexMap.get(b.id) as number)
      : Number.MAX_SAFE_INTEGER;

    if (ai !== bi) {
      return ai - bi;
    }

    return a.createdAt.localeCompare(b.createdAt);
  });
}

function moveId(ids: string[], sourceId: string, targetId: string) {
  const from = ids.indexOf(sourceId);
  const to = ids.indexOf(targetId);

  if (from < 0 || to < 0 || from === to) {
    return ids;
  }

  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

function isLikelyRenamedSession(previousSession: Session, candidate: Session) {
  const prevTime = Date.parse(previousSession.createdAt);
  const nextTime = Date.parse(candidate.createdAt);

  if (!Number.isFinite(prevTime) || !Number.isFinite(nextTime)) {
    return false;
  }

  if (Math.abs(prevTime - nextTime) > 1000) {
    return false;
  }

  return previousSession.status === candidate.status;
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [dropTargetSessionId, setDropTargetSessionId] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [sidebarHidden, setSidebarHidden] = useState(() => readSidebarHidden());
  const [touchMode, setTouchMode] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [stoppedAlerts, setStoppedAlerts] = useState<StoppedSessionAlert[]>([]);
  const [liveAlerts, setLiveAlerts] = useState<Record<string, LiveSessionAlert>>({});
  const [soundAlertsEnabled, setSoundAlertsEnabled] = useState(() => readSoundAlertsEnabled());

  const orderRef = useRef<string[]>([]);
  const knownSessionsRef = useRef<Map<string, Session>>(new Map());
  const snapshotSessionsRef = useRef<Map<string, Session>>(new Map());
  const seenActivityRef = useRef<Record<string, string>>({});
  const seenAlertTokenRef = useRef<Record<string, string>>({});
  const activityCatchupPendingRef = useRef(true);
  const appWasHiddenRef = useRef(false);
  const expectedClosedSessionsRef = useRef<Set<string>>(new Set());
  const pendingRenameMapRef = useRef<Map<string, string>>(new Map());
  const notificationKeysRef = useRef<Set<string>>(new Set());
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    orderRef.current = readSessionOrder();
    seenActivityRef.current = readSeenActivityMap();
    seenAlertTokenRef.current = readSeenAlertTokenMap();
    snapshotSessionsRef.current = readSessionSnapshot();
  }, []);

  useEffect(() => {
    const updateTouchMode = () => {
      const next =
        window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 900;
      setTouchMode(next);
    };

    updateTouchMode();
    window.addEventListener('resize', updateTouchMode);
    return () => window.removeEventListener('resize', updateTouchMode);
  }, []);

  useEffect(() => {
    persistSidebarHidden(sidebarHidden);
  }, [sidebarHidden]);

  const clearSessionUi = useCallback(() => {
    setSessions([]);
    setActiveSessionId(null);
    setBusy(false);
    setEditingSessionId(null);
    setEditingName('');
    setRenamingSessionId(null);
    setDraggingSessionId(null);
    setDropTargetSessionId(null);
    setStoppedAlerts([]);
    setLiveAlerts({});
    knownSessionsRef.current = new Map();
    expectedClosedSessionsRef.current = new Set();
    notificationKeysRef.current = new Set();
    activityCatchupPendingRef.current = true;
    appWasHiddenRef.current = false;
    seenAlertTokenRef.current = readSeenAlertTokenMap();
  }, []);

  const handleUnauthorized = useCallback(() => {
    clearSessionUi();
    setAuthenticated(false);
    setAuthChecked(true);
  }, [clearSessionUi]);

  const checkAuth = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/status');
      if (!response.ok) {
        setAuthenticated(false);
        return;
      }

      const data = await response.json();
      setAuthenticated(Boolean(data.authenticated));
    } catch {
      setAuthenticated(false);
    } finally {
      setAuthChecked(true);
    }
  }, []);

  useEffect(() => {
    checkAuth().catch(console.error);
  }, [checkAuth]);

  useEffect(() => {
    if (authenticated) {
      activityCatchupPendingRef.current = true;
    }
  }, [authenticated]);

  useEffect(() => {
    persistSoundAlertsEnabled(soundAlertsEnabled);
  }, [soundAlertsEnabled]);

  const ensureAudioContext = useCallback(async () => {
    if (typeof window === 'undefined') {
      return null;
    }

    const audioWindow = window as Window & { webkitAudioContext?: typeof AudioContext };
    const Ctx = audioWindow.AudioContext || audioWindow.webkitAudioContext;
    if (!Ctx) {
      return null;
    }

    if (!audioContextRef.current) {
      audioContextRef.current = new Ctx();
    }

    if (audioContextRef.current.state === 'suspended') {
      try {
        await audioContextRef.current.resume();
      } catch {
        return null;
      }
    }

    return audioContextRef.current;
  }, []);

  const ringAlertBell = useCallback(async () => {
    const ctx = await ensureAudioContext();
    if (!ctx) {
      return false;
    }

    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, ctx.currentTime);
    gainNode.gain.setValueAtTime(0.0001, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.015);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.18);
    return true;
  }, [ensureAudioContext]);

  const maybePlayAlertSound = useCallback((key: string) => {
    if (!soundAlertsEnabled) {
      return;
    }

    if (document.visibilityState === 'visible') {
      return;
    }

    if (notificationKeysRef.current.has(key)) {
      return;
    }

    notificationKeysRef.current.add(key);
    void ringAlertBell().then((played) => {
      if (!played) {
        notificationKeysRef.current.delete(key);
      }
    });
  }, [ringAlertBell, soundAlertsEnabled]);

  const toggleSoundAlerts = useCallback(() => {
    setSoundAlertsEnabled((current) => {
      const next = !current;
      if (next) {
        void ringAlertBell();
      }
      return next;
    });
  }, [ringAlertBell]);

  const applySessions = useCallback((nextSessions: Session[]) => {
    pendingRenameMapRef.current = new Map();

    const previousById = knownSessionsRef.current;
    const baselinePrevious =
      previousById.size > 0 ? previousById : snapshotSessionsRef.current;
    const nextById = new Map(nextSessions.map((session) => [session.id, session]));
    const nowIso = new Date().toISOString();

    const renameMatchesByOldId = new Map<string, Session>();
    const renameIdMap = new Map<string, string>();
    const renameCandidatePool = nextSessions.filter(
      (session) => !baselinePrevious.has(session.id)
    );

    for (const [previousId, previousSession] of baselinePrevious.entries()) {
      if (nextById.has(previousId)) {
        continue;
      }

      if (expectedClosedSessionsRef.current.has(previousId)) {
        continue;
      }

      const matchIndex = renameCandidatePool.findIndex((candidate) =>
        isLikelyRenamedSession(previousSession, candidate)
      );
      if (matchIndex >= 0) {
        const [match] = renameCandidatePool.splice(matchIndex, 1);
        renameMatchesByOldId.set(previousId, match);
        renameIdMap.set(previousId, match.id);
      }
    }

    if (renameIdMap.size > 0) {
      const nextSeenActivity = { ...seenActivityRef.current };
      let seenActivityChanged = false;
      const nextSeenAlertToken = { ...seenAlertTokenRef.current };
      let seenAlertTokenChanged = false;

      for (const [oldId, match] of renameMatchesByOldId.entries()) {
        if (nextSeenActivity[oldId]) {
          nextSeenActivity[match.id] = nextSeenActivity[oldId];
          delete nextSeenActivity[oldId];
          seenActivityChanged = true;
        }

        if (nextSeenAlertToken[oldId]) {
          nextSeenAlertToken[match.id] = nextSeenAlertToken[oldId];
          delete nextSeenAlertToken[oldId];
          seenAlertTokenChanged = true;
        }
      }

      if (seenActivityChanged) {
        seenActivityRef.current = nextSeenActivity;
        persistSeenActivityMap(nextSeenActivity);
      }

      if (seenAlertTokenChanged) {
        seenAlertTokenRef.current = nextSeenAlertToken;
        persistSeenAlertTokenMap(nextSeenAlertToken);
      }
    }

    let orderSeed = orderRef.current;
    if (renameIdMap.size > 0) {
      orderSeed = orderSeed.map((id) => renameIdMap.get(id) ?? id);
    }

    const nextOrder = syncSessionOrder(
      nextSessions.map((session) => session.id),
      orderSeed
    );

    setStoppedAlerts((prev) => {
      const byId = new Map(prev.map((alert) => [alert.id, alert]));

      for (const [previousId, previousSession] of baselinePrevious.entries()) {
        if (nextById.has(previousId)) {
          continue;
        }

        if (expectedClosedSessionsRef.current.has(previousId)) {
          expectedClosedSessionsRef.current.delete(previousId);
          continue;
        }

        if (renameMatchesByOldId.has(previousId)) {
          continue;
        }

        const existing = byId.get(previousId);
        const alert = {
          id: previousId,
          name: previousSession.name,
          stoppedAt: nowIso,
          seen: existing?.seen ?? false,
          reason: 'missing' as const
        };
        byId.set(previousId, {
          ...alert
        });
        if (!existing) {
          maybePlayAlertSound(`stopped:${previousId}`);
        }
      }

      for (const session of nextSessions) {
        if (session.status === 'exited') {
          const existing = byId.get(session.id);
          const seen = existing?.seen ?? session.id === activeSessionId;
          const alert = {
            id: session.id,
            name: session.name,
            stoppedAt: nowIso,
            seen,
            reason: 'exited' as const
          };
          byId.set(session.id, {
            ...alert
          });
          if (!seen && !existing) {
            maybePlayAlertSound(`exited:${session.id}`);
          }
        } else {
          byId.delete(session.id);
        }
      }

      return Array.from(byId.values()).sort((a, b) =>
        b.stoppedAt.localeCompare(a.stoppedAt)
      );
    });

    const allowActivityCatchup = activityCatchupPendingRef.current;
    setLiveAlerts((prev) => {
      const prevAlerts: Record<string, LiveSessionAlert> =
        renameMatchesByOldId.size > 0 ? { ...prev } : prev;

      if (renameMatchesByOldId.size > 0) {
        for (const [oldId, match] of renameMatchesByOldId.entries()) {
          if (prevAlerts[oldId]) {
            prevAlerts[match.id] = prevAlerts[oldId];
            delete prevAlerts[oldId];
          }
        }
      }

      const next: Record<string, LiveSessionAlert> = {};
      const nextSeenActivity = { ...seenActivityRef.current };
      const nextSeenAlertToken = { ...seenAlertTokenRef.current };
      let seenActivityChanged = false;
      let seenAlertTokenChanged = false;

      for (const session of nextSessions) {
        const tmuxToken = (session.alerts || '').trim();
        const activityIso = session.lastActivityAt || '';
        const hasActivityTimestamp = Number.isFinite(Date.parse(activityIso));
        const previousSeenIso = nextSeenActivity[session.id];
        let hasUnseenActivity = false;

        if (hasActivityTimestamp) {
          if (!previousSeenIso) {
            nextSeenActivity[session.id] = activityIso;
            seenActivityChanged = true;
          } else if (
            allowActivityCatchup &&
            Date.parse(activityIso) > Date.parse(previousSeenIso) + 500
          ) {
            hasUnseenActivity = true;
          }
        }

        if (session.id === activeSessionId && hasActivityTimestamp) {
          if (!previousSeenIso || Date.parse(activityIso) > Date.parse(previousSeenIso)) {
            nextSeenActivity[session.id] = activityIso;
            seenActivityChanged = true;
          }
          hasUnseenActivity = false;
        }

        const tokenParts: string[] = [];
        if (tmuxToken) {
          tokenParts.push(`tmux:${tmuxToken}`);
        }
        if (hasUnseenActivity && activityIso) {
          tokenParts.push(`activity:${activityIso}`);
        }
        const token = tokenParts.join('|');
        const existing = prevAlerts[session.id];

        if (session.id === activeSessionId) {
          // Opening the tab acknowledges any pending live alert.
          if (token) {
            if (nextSeenAlertToken[session.id] !== token) {
              nextSeenAlertToken[session.id] = token;
              seenAlertTokenChanged = true;
            }
          } else if (nextSeenAlertToken[session.id]) {
            delete nextSeenAlertToken[session.id];
            seenAlertTokenChanged = true;
          }
          continue;
        }

        if (!token) {
          // Keep unseen catch-up activity until user opens that tab.
          if (existing && existing.token.includes('activity:')) {
            next[session.id] = existing;
          }
          if (nextSeenAlertToken[session.id]) {
            delete nextSeenAlertToken[session.id];
            seenAlertTokenChanged = true;
          }
          continue;
        }

        const seenToken = nextSeenAlertToken[session.id];
        const tokenAlreadySeen = seenToken === token;
        if (tokenAlreadySeen) {
          continue;
        }

        const tokenChanged = !existing || existing.token !== token;
        next[session.id] = tokenChanged ? { token } : existing;

        if (tokenChanged) {
          maybePlayAlertSound(`live:${session.id}:${token}`);
        }
      }

      for (const sessionId of Object.keys(nextSeenActivity)) {
        if (!nextById.has(sessionId)) {
          delete nextSeenActivity[sessionId];
          seenActivityChanged = true;
        }
      }
      for (const sessionId of Object.keys(nextSeenAlertToken)) {
        if (!nextById.has(sessionId)) {
          delete nextSeenAlertToken[sessionId];
          seenAlertTokenChanged = true;
        }
      }

      if (seenActivityChanged) {
        seenActivityRef.current = nextSeenActivity;
        persistSeenActivityMap(nextSeenActivity);
      }
      if (seenAlertTokenChanged) {
        seenAlertTokenRef.current = nextSeenAlertToken;
        persistSeenAlertTokenMap(nextSeenAlertToken);
      }

      return next;
    });
    activityCatchupPendingRef.current = false;

    knownSessionsRef.current = nextById;
    snapshotSessionsRef.current = nextById;
    persistSessionSnapshot(nextSessions);
    orderRef.current = nextOrder;
    persistSessionOrder(nextOrder);
    setSessions(sortSessionsByOrder(nextSessions, nextOrder));
    pendingRenameMapRef.current = renameIdMap;
  }, [activeSessionId, maybePlayAlertSound]);

  const fetchSessions = useCallback(async () => {
    if (!authenticated) {
      return;
    }

    const response = await fetch('/api/sessions');
    if (response.status === 401) {
      handleUnauthorized();
      return;
    }

    if (!response.ok) {
      throw new Error('Failed to load sessions');
    }

    const data = await response.json();
    const nextSessions = (data.sessions as Session[]) ?? [];
    applySessions(nextSessions);
    const renameMap = pendingRenameMapRef.current;
    const renamedActiveId =
      activeSessionId && renameMap.has(activeSessionId)
        ? renameMap.get(activeSessionId) ?? null
        : null;

    if (renamedActiveId) {
      setActiveSessionId(renamedActiveId);
    }

    if (!nextSessions.length) {
      setActiveSessionId(null);
      pendingRenameMapRef.current = new Map();
      return;
    }

    const activeIdForLookup = renamedActiveId ?? activeSessionId;
    if (!activeIdForLookup || !nextSessions.some((s) => s.id === activeIdForLookup)) {
      const sorted = sortSessionsByOrder(nextSessions, orderRef.current);
      setActiveSessionId(sorted[0]?.id ?? null);
    }

    pendingRenameMapRef.current = new Map();
  }, [activeSessionId, applySessions, authenticated, handleUnauthorized]);

  useEffect(() => {
    if (!authenticated) {
      return;
    }

    fetchSessions().catch(console.error);
    const timer = setInterval(() => {
      fetchSessions().catch(console.error);
    }, 5000);

    return () => clearInterval(timer);
  }, [authenticated, fetchSessions]);

  useEffect(() => {
    if (!authenticated) {
      return;
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        appWasHiddenRef.current = true;
        return;
      }

      if (appWasHiddenRef.current) {
        activityCatchupPendingRef.current = true;
        appWasHiddenRef.current = false;
      }

      fetchSessions().catch(console.error);
    };

    const handleFocus = () => {
      if (appWasHiddenRef.current) {
        activityCatchupPendingRef.current = true;
        appWasHiddenRef.current = false;
      }
      fetchSessions().catch(console.error);
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [authenticated, fetchSessions]);

  useEffect(() => {
    if (!activeSessionId) {
      return;
    }

    setLiveAlerts((prev) => {
      const current = prev[activeSessionId];
      if (!current) {
        return prev;
      }

      const nextSeenAlertToken = {
        ...seenAlertTokenRef.current,
        [activeSessionId]: current.token
      };
      seenAlertTokenRef.current = nextSeenAlertToken;
      persistSeenAlertTokenMap(nextSeenAlertToken);

      const next = { ...prev };
      delete next[activeSessionId];
      return next;
    });

    setStoppedAlerts((prev) =>
      prev.map((alert) => (alert.id === activeSessionId ? { ...alert, seen: true } : alert))
    );

    const activeSession = sessions.find((session) => session.id === activeSessionId);
    const activityIso = activeSession?.lastActivityAt || '';
    if (activityIso && Number.isFinite(Date.parse(activityIso))) {
      const previousSeenIso = seenActivityRef.current[activeSessionId];
      if (!previousSeenIso || Date.parse(activityIso) > Date.parse(previousSeenIso)) {
        const nextSeenActivity = {
          ...seenActivityRef.current,
          [activeSessionId]: activityIso
        };
        seenActivityRef.current = nextSeenActivity;
        persistSeenActivityMap(nextSeenActivity);
      }
    }
  }, [activeSessionId, sessions]);

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!password) {
      setLoginError('Password is required.');
      return;
    }

    setLoginBusy(true);
    setLoginError('');

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ password })
      });

      if (!response.ok) {
        setLoginError('Invalid password.');
        return;
      }

      setPassword('');
      setAuthenticated(true);
      setAuthChecked(true);
    } catch {
      setLoginError('Failed to login.');
    } finally {
      setLoginBusy(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Ignore network errors and clear local auth state anyway.
    }

    handleUnauthorized();
  };

  const handleCreate = async () => {
    setBusy(true);
    try {
      const count = sessions.length + 1;
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: `Session ${count}` })
      });

      if (response.status === 401) {
        handleUnauthorized();
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to create session');
      }

      const data = await response.json();
      const session = data.session as Session;
      applySessions([...sessions, session]);
      setActiveSessionId(session.id);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    expectedClosedSessionsRef.current.add(id);
    const response = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (response.status === 401) {
      handleUnauthorized();
      return;
    }

    if (!response.ok) {
      expectedClosedSessionsRef.current.delete(id);
      throw new Error('Failed to delete session');
    }

    setStoppedAlerts((prev) => prev.filter((alert) => alert.id !== id));
    setSessions((prev) => {
      const remaining = prev.filter((session) => session.id !== id);
      const nextOrder = syncSessionOrder(
        remaining.map((session) => session.id),
        orderRef.current
      );
      orderRef.current = nextOrder;
      persistSessionOrder(nextOrder);
      setActiveSessionId((active) => {
        if (active !== id) {
          return active;
        }
        return remaining[0]?.id ?? null;
      });
      return sortSessionsByOrder(remaining, nextOrder);
    });

    if (editingSessionId === id) {
      setEditingSessionId(null);
      setEditingName('');
    }
  };

  const selectSession = useCallback((id: string) => {
    setActiveSessionId(id);
    setLiveAlerts((prev) => {
      const current = prev[id];
      if (!current) {
        return prev;
      }

      const nextSeenAlertToken = {
        ...seenAlertTokenRef.current,
        [id]: current.token
      };
      seenAlertTokenRef.current = nextSeenAlertToken;
      persistSeenAlertTokenMap(nextSeenAlertToken);

      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const acknowledgeStoppedAlert = useCallback((id: string) => {
    setStoppedAlerts((prev) =>
      prev.map((alert) => (alert.id === id ? { ...alert, seen: true } : alert))
    );
  }, []);

  const dismissStoppedAlert = useCallback((id: string) => {
    setStoppedAlerts((prev) => prev.filter((alert) => alert.id !== id));
  }, []);

  const startRename = (session: Session) => {
    selectSession(session.id);
    setEditingSessionId(session.id);
    setEditingName(session.name);
  };

  const cancelRename = () => {
    setEditingSessionId(null);
    setEditingName('');
  };

  const submitRename = async (session: Session) => {
    if (renamingSessionId === session.id) {
      return;
    }

    const trimmed = editingName.trim();
    if (!trimmed || trimmed === session.name) {
      cancelRename();
      return;
    }

    setRenamingSessionId(session.id);
    try {
      const response = await fetch(`/api/sessions/${session.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: trimmed })
      });

      if (response.status === 401) {
        handleUnauthorized();
        return;
      }

      if (!response.ok) {
        console.error(await response.text());
        return;
      }

      const data = await response.json();
      const updated = data.session as Session;

      setSessions((prev) => {
        const next = prev.map((item) => (item.id === session.id ? updated : item));
        return sortSessionsByOrder(next, orderRef.current);
      });

      if (updated.id !== session.id) {
        expectedClosedSessionsRef.current.add(session.id);
        pendingRenameMapRef.current = new Map([[session.id, updated.id]]);

        const knownSession = knownSessionsRef.current.get(session.id);
        if (knownSession) {
          knownSessionsRef.current.delete(session.id);
          knownSessionsRef.current.set(updated.id, updated);
        }

        const snapshotSession = snapshotSessionsRef.current.get(session.id);
        if (snapshotSession) {
          snapshotSessionsRef.current.delete(session.id);
          snapshotSessionsRef.current.set(updated.id, updated);
        }

        if (seenActivityRef.current[session.id]) {
          seenActivityRef.current = {
            ...seenActivityRef.current,
            [updated.id]: seenActivityRef.current[session.id]
          };
          delete seenActivityRef.current[session.id];
          persistSeenActivityMap(seenActivityRef.current);
        }

        if (seenAlertTokenRef.current[session.id]) {
          seenAlertTokenRef.current = {
            ...seenAlertTokenRef.current,
            [updated.id]: seenAlertTokenRef.current[session.id]
          };
          delete seenAlertTokenRef.current[session.id];
          persistSeenAlertTokenMap(seenAlertTokenRef.current);
        }

        setLiveAlerts((prev) => {
          if (!prev[session.id]) {
            return prev;
          }

          const next = { ...prev, [updated.id]: prev[session.id] };
          delete next[session.id];
          return next;
        });

        setStoppedAlerts((prev) => prev.filter((alert) => alert.id !== session.id));

        orderRef.current = orderRef.current.map((id) =>
          id === session.id ? updated.id : id
        );
        persistSessionOrder(orderRef.current);
      }

      setActiveSessionId((prev) => (prev === session.id ? updated.id : prev));
      cancelRename();
    } finally {
      setRenamingSessionId(null);
    }
  };

  const reorderSessions = (sourceId: string, targetId: string) => {
    setSessions((prev) => {
      const ids = prev.map((session) => session.id);
      const nextIds = moveId(ids, sourceId, targetId);
      const byId = new Map(prev.map((session) => [session.id, session]));
      const reordered = nextIds
        .map((id) => byId.get(id))
        .filter((session): session is Session => Boolean(session));

      orderRef.current = nextIds;
      persistSessionOrder(nextIds);
      return reordered;
    });
  };

  const moveSessionByOffset = (sessionId: string, offset: number) => {
    setSessions((prev) => {
      const from = prev.findIndex((session) => session.id === sessionId);
      const to = from + offset;
      if (from < 0 || to < 0 || to >= prev.length) {
        return prev;
      }

      const targetId = prev[to].id;
      const ids = prev.map((session) => session.id);
      const nextIds = moveId(ids, sessionId, targetId);
      const byId = new Map(prev.map((session) => [session.id, session]));
      const reordered = nextIds
        .map((id) => byId.get(id))
        .filter((session): session is Session => Boolean(session));

      orderRef.current = nextIds;
      persistSessionOrder(nextIds);
      return reordered;
    });
  };

  const startTabDrag = (
    event: React.DragEvent<HTMLElement>,
    sessionId: string
  ) => {
    setDraggingSessionId(sessionId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', sessionId);
  };

  const clearTabDragState = () => {
    setDraggingSessionId(null);
    setDropTargetSessionId(null);
  };

  const handleSidebarResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);

    const handleMove = (moveEvent: PointerEvent) => {
      const next = startWidth + (moveEvent.clientX - startX);
      const clamped = Math.max(220, Math.min(480, next));
      setSidebarWidth(clamped);
    };

    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp, { once: true });
  };

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const unseenLiveAlertCount = useMemo(() => Object.keys(liveAlerts).length, [liveAlerts]);
  const unseenStoppedAlertCount = useMemo(
    () => stoppedAlerts.filter((alert) => !alert.seen).length,
    [stoppedAlerts]
  );
  const totalUnseenAlerts = unseenLiveAlertCount + unseenStoppedAlertCount;
  const shellStyle = { '--sidebar-width': `${sidebarWidth}px` } as CSSProperties;

  if (!authChecked) {
    return <div className="auth-shell">Checking authentication...</div>;
  }

  if (!authenticated) {
    return (
      <div className="auth-shell">
        <form className="auth-card" onSubmit={handleLogin}>
          <h1>webtmux</h1>
          <p>Enter the single-user password to access your local terminal sessions.</p>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
          {loginError ? <div className="auth-error">{loginError}</div> : null}
          <button type="submit" disabled={loginBusy}>
            {loginBusy ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className={`app-shell ${sidebarHidden ? 'sidebar-hidden' : ''}`} style={shellStyle}>
      <aside className="session-sidebar">
        <div className="sidebar-header">
          <h1>
            webtmux
            {totalUnseenAlerts > 0 ? (
              <span className="alert-count-badge" title="Unseen terminal alerts">
                {totalUnseenAlerts}
              </span>
            ) : null}
          </h1>
          <div className="sidebar-header-actions">
            <button
              onClick={toggleSoundAlerts}
              className={!soundAlertsEnabled ? 'notify-btn-off' : ''}
            >
              {soundAlertsEnabled ? 'Notify On' : 'Notify Off'}
            </button>
            <button onClick={handleCreate} disabled={busy}>
              New
            </button>
            <button className="logout-btn" onClick={handleLogout}>
              Logout
            </button>
            <button onClick={() => setSidebarHidden(true)} title="Hide session sidebar">
              Hide
            </button>
          </div>
        </div>

        <div className="session-list">
          {sessions.map((session, index) => {
            const isActive = session.id === activeSessionId;
            const isEditing = session.id === editingSessionId;
            const isRenaming = session.id === renamingSessionId;
            const isDragging = session.id === draggingSessionId;
            const isDropTarget = session.id === dropTargetSessionId;
            const isFirst = index === 0;
            const isLast = index === sessions.length - 1;
            const liveAlert = liveAlerts[session.id];
            const dotClass = liveAlert
              ? 'status-dot alert unseen'
              : `status-dot ${session.status === 'running' ? 'running' : 'exited'}`;

            return (
              <div
                key={session.id}
                className={`session-item ${isActive ? 'active' : ''} ${
                  isDragging ? 'dragging' : ''
                } ${isDropTarget ? 'drop-target' : ''}`}
                onClick={() => selectSession(session.id)}
                role="button"
                tabIndex={0}
                onDragOver={(event) => {
                  if (touchMode) {
                    return;
                  }
                  if (!draggingSessionId) {
                    return;
                  }
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                }}
                onDragEnter={() => {
                  if (touchMode) {
                    return;
                  }
                  if (draggingSessionId && draggingSessionId !== session.id) {
                    setDropTargetSessionId(session.id);
                  }
                }}
                onDragLeave={() => {
                  if (dropTargetSessionId === session.id) {
                    setDropTargetSessionId(null);
                  }
                }}
                onDrop={(event) => {
                  if (touchMode) {
                    return;
                  }
                  event.preventDefault();
                  const sourceId = event.dataTransfer.getData('text/plain');
                  if (!sourceId || sourceId === session.id) {
                    clearTabDragState();
                    return;
                  }
                  reorderSessions(sourceId, session.id);
                  clearTabDragState();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    selectSession(session.id);
                  }
                }}
              >
                <div className="session-main">
                  <span className={dotClass} />
                  {isEditing ? (
                    <input
                      className="session-name-input"
                      value={editingName}
                      autoFocus
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setEditingName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          submitRename(session).catch(console.error);
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          cancelRename();
                        }
                      }}
                    />
                  ) : (
                    <span className="session-name">{session.name}</span>
                  )}
                </div>
                <div className="session-actions">
                  {touchMode ? (
                    <>
                      <button
                        className="icon-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          moveSessionByOffset(session.id, -1);
                        }}
                        title="Move up"
                        aria-label="Move up"
                        disabled={isFirst}
                      >
                        ▲
                      </button>
                      <button
                        className="icon-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          moveSessionByOffset(session.id, 1);
                        }}
                        title="Move down"
                        aria-label="Move down"
                        disabled={isLast}
                      >
                        ▼
                      </button>
                    </>
                  ) : null}
                  {!touchMode ? (
                    <button
                      className="icon-btn drag-handle"
                      onClick={(event) => event.stopPropagation()}
                      title="Drag to reorder"
                      aria-label="Drag to reorder"
                      draggable={!isEditing}
                      onDragStart={(event) => startTabDrag(event, session.id)}
                      onDragEnd={clearTabDragState}
                    >
                      ⋮⋮
                    </button>
                  ) : null}
                  <button
                    className="icon-btn"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (isEditing) {
                        submitRename(session).catch(console.error);
                        return;
                      }
                      startRename(session);
                    }}
                    title={isEditing ? 'Save rename' : 'Rename session'}
                    aria-label="Rename session"
                    disabled={isRenaming}
                  >
                    {isEditing ? (
                      '✓'
                    ) : (
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="M4 16.25V20h3.75L19.06 8.69l-3.75-3.75L4 16.25zm17.71-10.04a1 1 0 0 0 0-1.41l-2.5-2.5a1 1 0 0 0-1.41 0l-1.96 1.96 3.75 3.75 2.12-2.12z"
                          fill="currentColor"
                        />
                      </svg>
                    )}
                  </button>
                  <button
                    className="icon-btn"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleDelete(session.id).catch(console.error);
                    }}
                    title="Close session"
                    aria-label="Close session"
                  >
                    x
                  </button>
                </div>
              </div>
            );
          })}
          {stoppedAlerts.length ? (
            <div className="stopped-alerts">
              <div className="stopped-alerts-header">Stopped Sessions</div>
              {stoppedAlerts.map((alert) => (
                <div
                  key={`stopped-${alert.id}`}
                  className={`session-item stopped-item ${alert.seen ? 'seen' : 'unseen'}`}
                  onClick={() => acknowledgeStoppedAlert(alert.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      acknowledgeStoppedAlert(alert.id);
                    }
                  }}
                >
                  <div className="session-main">
                    <span className={`status-dot alert ${alert.seen ? 'seen' : 'unseen'}`} />
                    <span className="session-name">
                      {alert.name}
                      <span className="stopped-reason">
                        {alert.reason === 'exited' ? ' exited' : ' stopped'}
                      </span>
                    </span>
                  </div>
                  <div className="session-actions">
                    <span className="stopped-time">
                      {new Date(alert.stoppedAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </span>
                    <button
                      className="icon-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        dismissStoppedAlert(alert.id);
                      }}
                      title="Dismiss alert"
                      aria-label="Dismiss alert"
                    >
                      x
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </aside>

      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize sidebar"
        onPointerDown={handleSidebarResizeStart}
      >
        <div className="sidebar-resizer-grip" />
      </div>

      <main className="terminal-area">
        {sidebarHidden ? (
          <div className="terminal-area-header">
            <button
              className="sidebar-reveal-btn"
              onClick={() => setSidebarHidden(false)}
              title="Show session sidebar"
            >
              Sessions
            </button>
          </div>
        ) : null}
        <div className="terminal-content">
          {activeSession ? (
            <TerminalPane sessionId={activeSession.id} />
          ) : (
            <div className="empty-state">Create a session to start.</div>
          )}
        </div>
      </main>
    </div>
  );
}
