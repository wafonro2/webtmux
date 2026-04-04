import { CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { TerminalPane } from './TerminalPane';

type Session = {
  id: string;
  name: string;
  createdAt: string;
  status: 'running' | 'exited';
};

const SESSION_ORDER_KEY = 'webtmux-session-order';

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
    const ai = indexMap.has(a.id) ? (indexMap.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
    const bi = indexMap.has(b.id) ? (indexMap.get(b.id) as number) : Number.MAX_SAFE_INTEGER;

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
  const orderRef = useRef<string[]>([]);

  useEffect(() => {
    orderRef.current = readSessionOrder();
  }, []);

  const applySessions = useCallback((nextSessions: Session[]) => {
    const nextOrder = syncSessionOrder(
      nextSessions.map((session) => session.id),
      orderRef.current
    );

    orderRef.current = nextOrder;
    persistSessionOrder(nextOrder);
    setSessions(sortSessionsByOrder(nextSessions, nextOrder));
  }, []);

  const fetchSessions = useCallback(async () => {
    const response = await fetch('/api/sessions');
    const data = await response.json();
    const nextSessions = (data.sessions as Session[]) ?? [];
    applySessions(nextSessions);

    if (!nextSessions.length) {
      setActiveSessionId(null);
      return;
    }

    if (!activeSessionId || !nextSessions.some((s) => s.id === activeSessionId)) {
      const sorted = sortSessionsByOrder(nextSessions, orderRef.current);
      setActiveSessionId(sorted[0]?.id ?? null);
    }
  }, [activeSessionId, applySessions]);

  useEffect(() => {
    fetchSessions().catch(console.error);
    const timer = setInterval(() => {
      fetchSessions().catch(console.error);
    }, 5000);

    return () => clearInterval(timer);
  }, [fetchSessions]);

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

      const data = await response.json();
      const session = data.session as Session;
      applySessions([...sessions, session]);
      setActiveSessionId(session.id);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
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

  const startRename = (session: Session) => {
    setActiveSessionId(session.id);
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

      if (!response.ok) {
        console.error(await response.text());
        return;
      }

      const data = await response.json();
      const updated = data.session as Session;

      setSessions((prev) => {
        const next = prev.map((item) => (item.id === session.id ? updated : item));
        const reordered = sortSessionsByOrder(next, orderRef.current);
        return reordered;
      });

      if (updated.id !== session.id) {
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

  const handleSidebarResizeStart = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = sidebarWidth;

    const handleMove = (moveEvent: MouseEvent) => {
      const next = startWidth + (moveEvent.clientX - startX);
      const clamped = Math.max(220, Math.min(480, next));
      setSidebarWidth(clamped);
    };

    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const shellStyle = { '--sidebar-width': `${sidebarWidth}px` } as CSSProperties;

  return (
    <div className="app-shell" style={shellStyle}>
      <aside className="session-sidebar">
        <div className="sidebar-header">
          <h1>webtmux</h1>
          <button onClick={handleCreate} disabled={busy}>
            New
          </button>
        </div>

        <div className="session-list">
          {sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            const isEditing = session.id === editingSessionId;
            const isRenaming = session.id === renamingSessionId;
            const isDragging = session.id === draggingSessionId;
            const isDropTarget = session.id === dropTargetSessionId;

            return (
              <div
                key={session.id}
                className={`session-item ${isActive ? 'active' : ''} ${
                  isDragging ? 'dragging' : ''
                } ${
                  isDropTarget ? 'drop-target' : ''
                }`}
                onClick={() => setActiveSessionId(session.id)}
                role="button"
                tabIndex={0}
                onDragOver={(event) => {
                  if (!draggingSessionId) {
                    return;
                  }
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                }}
                onDragEnter={() => {
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
                    setActiveSessionId(session.id);
                  }
                }}
              >
                <div className="session-main">
                  <span
                    className={`status-dot ${
                      session.status === 'running' ? 'running' : 'exited'
                    }`}
                  />
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
        </div>
      </aside>

      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize sidebar"
        onMouseDown={handleSidebarResizeStart}
      >
        <div className="sidebar-resizer-grip" />
      </div>

      <main className="terminal-area">
        {activeSession ? (
          <TerminalPane sessionId={activeSession.id} />
        ) : (
          <div className="empty-state">Create a session to start.</div>
        )}
      </main>
    </div>
  );
}
