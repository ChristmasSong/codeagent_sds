import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import {
  AlertTriangle,
  Archive,
  ArrowDownToLine,
  Bot,
  CircleStop,
  Cloud,
  Coins,
  FileSearch,
  Focus,
  FolderTree,
  History,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  Square,
  Terminal,
  X,
  type LucideIcon,
} from 'lucide-react';

import '@xterm/xterm/css/xterm.css';

import { m } from '@/core/i18n/messages';
import { Link } from '@/core/i18n/navigation';
import { envConfigs } from '@/config';
import type { CodeModelView } from '@/modules/code/models';
import {
  CODE_SESSION_AGENTS,
  normalizeAgent,
  previewUrl,
  shouldRestoreWorkspace,
  type CodeSessionAgent,
} from '@/modules/code/runtime';
import type { CodeSessionView } from '@/modules/code/service';
import {
  useTerminalSession,
  type TerminalConnectionEvent,
  type TerminalStatus,
} from '@/modules/code/use-terminal-session';
import { ApiError, apiGet, apiPost } from '@/lib/api-client';
import type { WorkspaceFileEntry } from '@/lib/code-files';
import { cn } from '@/lib/utils';
import { SandboxFilePreview } from '@/components/code-workspace/sandbox-file-preview';
import { SandboxFileTree } from '@/components/code-workspace/sandbox-file-tree';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type CodeAction =
  | 'health'
  | 'inspect'
  | 'archive'
  | 'restore'
  | 'resume-preflight'
  | 'resume'
  | 'suspend'
  | 'discard'
  | 'end';

interface CodeActionResponse {
  session?: CodeSessionView;
  archive?: Record<string, unknown> | null;
  archiveStatus?: Record<string, unknown> | null;
  restore?: Record<string, unknown>;
  restoreIntegrity?: Record<string, unknown> | null;
  clear?: Record<string, unknown>;
  tmuxStatus?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  archiveError?: string | null;
  clearError?: string | null;
  tmux?: string;
  claude?: string;
  codex?: string;
  codexConfigured?: boolean;
  ok?: boolean;
  [key: string]: unknown;
}

interface SessionStartIssue {
  reason: 'insufficient_credits' | 'model_costs_not_configured';
  balance?: number;
  requiredBalance?: number;
}

type ArchiveCheckpointState =
  | 'idle'
  | 'saving'
  | 'saved'
  | 'verified'
  | 'error';

interface ArchiveCheckpoint {
  sessionId: string | null;
  state: ArchiveCheckpointState;
  savedAt?: string;
  digest?: string;
  message?: string;
}

interface CodeLoaderData {
  runtimeUserId: string;
  session: CodeSessionView | null;
  sessions: CodeSessionView[];
  archivedSessions: CodeSessionView[];
  models: CodeModelView[];
  runtimeBase: string;
}

const CODE_SIDEBAR_COLLAPSED_KEY = 'hicode:code-sidebar-collapsed';

function CodeWorkspacePage() {
  const loader = Route.useLoaderData() as CodeLoaderData;
  const balanceQuery = useQuery({
    queryKey: ['user-credits', 'balance'],
    queryFn: () => apiGet<{ balance: number }>('/api/credits'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const initialSession = loader.session ?? loader.sessions[0] ?? null;
  const initialAgent = initialSession?.agent ?? 'claude';
  const [sessions, setSessions] = useState<CodeSessionView[]>(loader.sessions);
  const [archivedSessions, setArchivedSessions] = useState<CodeSessionView[]>(
    loader.archivedSessions
  );
  const [sessionId, setSessionId] = useState<string | null>(
    initialSession?.id ?? null
  );
  const [models] = useState<CodeModelView[]>(loader.models);
  const [selectedAgent, setSelectedAgent] =
    useState<CodeSessionAgent>(initialAgent);
  const [selectedModel, setSelectedModel] = useState<string>(
    initialSession?.model || defaultModelFor(models, initialAgent)?.model || ''
  );
  const [actionMsg, setActionMsg] = useState<string>('');
  const [newSessionMsg, setNewSessionMsg] = useState<string>('');
  const [newSessionIssue, setNewSessionIssue] =
    useState<SessionStartIssue | null>(null);
  const [confirmNewSessionOpen, setConfirmNewSessionOpen] = useState(false);
  const [confirmRestoreSession, setConfirmRestoreSession] =
    useState<CodeSessionView | null>(null);
  const [runtimeIssue, setRuntimeIssue] = useState<string>('');
  const [busyAction, setBusyAction] = useState<string>('');
  const [previewNonce, setPreviewNonce] = useState(0);
  const [selectedFile, setSelectedFile] = useState<WorkspaceFileEntry | null>(
    null
  );
  const [restoredSessionIds, setRestoredSessionIds] = useState<
    Record<string, true>
  >({});
  const [restoreGate, setRestoreGate] = useState<{
    sessionId: string | null;
    status: 'ready' | 'restoring' | 'error';
    message: string;
  }>({ sessionId: null, status: 'ready', message: '' });
  const [archiveCheckpoint, setArchiveCheckpoint] = useState<ArchiveCheckpoint>(
    () => checkpointFromSession(initialSession)
  );
  const [terminalElement, setTerminalElement] = useState<HTMLDivElement | null>(
    null
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const currentSession =
    sessions.find((session) => session.id === sessionId) ??
    archivedSessions.find((session) => session.id === sessionId) ??
    null;
  const currentAgent = currentSession?.agent ?? selectedAgent;
  const currentModel = currentSession?.model || selectedModel;
  const currentRuntimeUserId =
    currentSession?.runtimeUserId ?? loader.runtimeUserId;
  const sessionRestoreReady = sessionId
    ? Boolean(restoredSessionIds[sessionId])
    : true;
  const restoreInProgress =
    restoreGate.sessionId === sessionId && restoreGate.status === 'restoring';
  const terminalSessionId =
    sessionId && sessionRestoreReady && currentSession?.status === 'active'
      ? sessionId
      : null;
  const billingSuspended =
    currentSession?.status === 'suspended' &&
    currentSession.suspensionReason === 'insufficient_credits';
  const availableModels = models.filter(
    (model) => model.agent === selectedAgent
  );
  const canCreateSession = Boolean(selectedModel && availableModels.length);
  const hasSession = Boolean(sessionId);
  const controlsDisabled =
    !hasSession || Boolean(busyAction) || restoreInProgress;
  const markSessionRestoreReady = useCallback((id: string) => {
    setRestoredSessionIds((prev) =>
      prev[id] ? prev : { ...prev, [id]: true }
    );
  }, []);
  const markSessionRestorePending = useCallback((id: string) => {
    setRestoredSessionIds((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);
  const markArchiveSaving = useCallback((id: string) => {
    setArchiveCheckpoint((prev) => ({
      sessionId: id,
      state: 'saving',
      savedAt: prev.sessionId === id ? prev.savedAt : undefined,
      digest: prev.sessionId === id ? prev.digest : undefined,
    }));
  }, []);
  const markArchiveSaved = useCallback(
    (id: string, payload: CodeActionResponse) => {
      const status = objectField(payload, 'archiveStatus');
      const savedAt =
        stringField(status, 'savedAt') ||
        payload.session?.lastActiveAt ||
        new Date().toISOString();
      const digest =
        stringField(status, 'digest') ||
        digestFrom(payload.archive) ||
        payload.session?.archiveDigest ||
        '';

      setArchiveCheckpoint({
        sessionId: id,
        state: 'saved',
        savedAt,
        digest,
      });
    },
    []
  );
  const markArchiveError = useCallback((id: string, error: unknown) => {
    const message = (error as Error).message || 'archive failed';
    setArchiveCheckpoint((prev) => ({
      sessionId: id,
      state: 'error',
      savedAt: prev.sessionId === id ? prev.savedAt : undefined,
      digest: prev.sessionId === id ? prev.digest : undefined,
      message,
    }));
  }, []);
  const markRestoreIntegrity = useCallback(
    (id: string, payload: CodeActionResponse) => {
      const integrity = objectField(payload, 'restoreIntegrity');
      const state = stringField(integrity, 'state');
      if (state !== 'verified' && state !== 'reconciled') return;

      setArchiveCheckpoint({
        sessionId: id,
        state: 'verified',
        savedAt: payload.session?.lastActiveAt,
        digest:
          stringField(integrity, 'restoredDigest') ||
          stringField(integrity, 'expectedDigest') ||
          payload.session?.archiveDigest ||
          '',
      });
    },
    []
  );
  const rememberArchivedSession = useCallback(
    (session: CodeSessionView | undefined) => {
      if (
        !session ||
        (session.status !== 'ended' && session.status !== 'suspended') ||
        !session.archiveKey
      ) {
        return;
      }
      setArchivedSessions((prev) => upsertArchivedSession(prev, session));
      markSessionRestorePending(session.id);
    },
    [markSessionRestorePending]
  );
  const restoreSessionBeforeConnect = useCallback(
    async (id: string) => {
      const payload = await runSessionAction(id, 'restore');
      if (payload.session) {
        setSessions((prev) => upsertSession(prev, payload.session!));
      }
      markSessionRestoreReady(id);
      markRestoreIntegrity(id, payload);
      setRuntimeIssue('');
      setPreviewNonce(Date.now());
      return payload;
    },
    [markRestoreIntegrity, markSessionRestoreReady]
  );
  const reportTerminalEvent = useCallback(
    (event: TerminalConnectionEvent) => {
      if (!sessionId) return;
      void apiPost(
        `/api/code/sessions/${encodeURIComponent(sessionId)}/events`,
        event
      ).catch((error) => {
        console.warn('[code-terminal] failed to report event', error);
      });
    },
    [sessionId]
  );

  const {
    status,
    focused,
    mode,
    reconnect,
    resize: resizeTerminal,
    focus: focusTerminal,
    interrupt,
    scrollToBottom,
    enterScrollback,
  } = useTerminalSession({
    sessionId: terminalSessionId,
    container: terminalElement,
    runtimeBase: loader.runtimeBase,
    runtimeUserId: currentRuntimeUserId ?? null,
    agent: currentAgent,
    model: currentModel,
    onConnectionEvent: reportTerminalEvent,
  });
  const terminalStatusText = restoreInProgress
    ? m['code.actions.restoring']()
    : `${statusLabel(status)}${mode !== 'none' ? ` · ${mode}` : ''}`;
  const archiveDigest = archiveDigestForSession(
    currentSession,
    archiveCheckpoint
  );

  useEffect(() => {
    setSidebarCollapsed(
      window.localStorage.getItem(CODE_SIDEBAR_COLLAPSED_KEY) === 'true'
    );
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(resizeTerminal, 220);
    return () => window.clearTimeout(timer);
  }, [mobileSidebarOpen, resizeTerminal, sidebarCollapsed]);

  useEffect(() => {
    setRuntimeIssue('');
    setSelectedFile(null);
  }, [sessionId]);

  useEffect(() => {
    setArchiveCheckpoint((prev) => {
      if (
        prev.sessionId === sessionId &&
        (prev.state === 'saving' ||
          prev.state === 'error' ||
          prev.state === 'verified')
      ) {
        return prev;
      }
      return checkpointFromSession(currentSession);
    });
  }, [
    currentSession?.archiveDigest,
    currentSession?.archiveKey,
    currentSession?.lastActiveAt,
    sessionId,
  ]);

  useEffect(() => {
    if (!sessionId || !currentSession) {
      setRestoreGate({ sessionId: null, status: 'ready', message: '' });
      return;
    }

    if (restoredSessionIds[sessionId] || !currentSession.archiveKey) {
      markSessionRestoreReady(sessionId);
      setRestoreGate({ sessionId, status: 'ready', message: '' });
      return;
    }

    let cancelled = false;
    const restoringMessage = m['code.actions.restoring']();
    setRestoreGate({
      sessionId,
      status: 'restoring',
      message: restoringMessage,
    });
    setActionMsg(restoringMessage);

    runSessionAction(sessionId, 'inspect')
      .then(async (inspection) => {
        const workspaceExists = booleanField(inspection.workspace, 'exists');
        if (
          shouldRestoreWorkspace({
            archiveKey: currentSession.archiveKey,
            status: currentSession.status,
            workspaceExists,
          })
        ) {
          return {
            action: 'restore' as const,
            payload: await restoreSessionBeforeConnect(sessionId),
          };
        }
        markSessionRestoreReady(sessionId);
        return { action: 'inspect' as const, payload: inspection };
      })
      .then(({ action, payload }) => {
        if (cancelled) return;
        setRestoreGate({ sessionId, status: 'ready', message: '' });
        setActionMsg(
          action === 'restore' ? formatActionMessage(action, payload) : ''
        );
      })
      .catch((err) => {
        if (cancelled) return;
        const message = (err as Error).message || 'restore failed';
        setRestoreGate({ sessionId, status: 'error', message });
        setRuntimeIssue(`${m['code.runtime.restore_failed']()} ${message}`);
        setActionMsg(message);
      });

    return () => {
      cancelled = true;
    };
  }, [
    currentSession,
    markSessionRestoreReady,
    restoreSessionBeforeConnect,
    restoredSessionIds,
    sessionId,
  ]);

  useEffect(() => {
    if (!sessionId || (status !== 'closed' && status !== 'error')) return;
    let cancelled = false;

    runSessionAction(sessionId, 'inspect')
      .then((payload) => {
        if (cancelled) return;
        if (payload.session) {
          setSessions((prev) => upsertSession(prev, payload.session!));
          if (
            payload.session.status === 'suspended' ||
            payload.session.status === 'ended'
          ) {
            setArchivedSessions((prev) =>
              upsertArchivedSession(prev, payload.session!)
            );
          }
        }
        const issue = runtimeIssueFrom(payload);
        if (issue) {
          setRuntimeIssue(issue);
          setActionMsg(issue);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [sessionId, status]);

  useEffect(() => {
    if (!terminalSessionId || status !== 'connected' || busyAction) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      markArchiveSaving(terminalSessionId);
      runSessionAction(terminalSessionId, 'archive')
        .then((payload) => {
          if (cancelled || !payload.session) return;
          setSessions((prev) => upsertSession(prev, payload.session!));
          markArchiveSaved(terminalSessionId, payload);
        })
        .catch((error) => {
          if (!cancelled) markArchiveError(terminalSessionId, error);
        });
    }, 60000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    busyAction,
    markArchiveError,
    markArchiveSaved,
    markArchiveSaving,
    status,
    terminalSessionId,
  ]);

  const newSession = async (
    currentAction: 'suspend' | 'discard' = 'suspend'
  ) => {
    if (!canCreateSession) {
      setNewSessionMsg(m['code.model.configure_required']());
      return;
    }
    setBusyAction('new');
    setNewSessionIssue(null);
    setNewSessionMsg(m['code.actions.running']());
    try {
      await apiPost('/api/code/sessions', {
        preflight: true,
        agent: selectedAgent,
        model: selectedModel,
      });

      const idsToEnd = sessionId ? [sessionId] : sessions.map((s) => s.id);
      const cleanupErrors: string[] = [];
      for (const id of idsToEnd) {
        try {
          const payload = await runSessionAction(id, currentAction);
          if (currentAction === 'suspend') {
            rememberArchivedSession(payload.session);
          }
        } catch (error) {
          cleanupErrors.push((error as Error).message || 'cleanup failed');
        }
      }

      const session = await apiPost<CodeSessionView>('/api/code/sessions', {
        agent: selectedAgent,
        model: selectedModel,
      });
      setSessions([session]);
      setSessionId(session.id);
      setArchiveCheckpoint(checkpointFromSession(session));
      markSessionRestoreReady(session.id);
      setSelectedAgent(session.agent);
      setSelectedModel(session.model);
      setMobileSidebarOpen(false);
      setPreviewNonce(Date.now());
      const message = `${m['code.actions.started']()}: ${shortId(session.id)}`;
      setNewSessionMsg(
        cleanupErrors.length
          ? `${message} - ${m['code.actions.cleanup_warning']()}`
          : message
      );
    } catch (err) {
      const issue = sessionStartIssueFromError(err);
      setNewSessionIssue(issue);
      setNewSessionMsg(issue ? '' : (err as Error).message || 'error');
    } finally {
      setBusyAction('');
    }
  };

  const requestNewSession = () => {
    if (sessionId) {
      setConfirmNewSessionOpen(true);
      return;
    }
    void newSession();
  };

  const requestRestoreArchivedSession = (session: CodeSessionView) => {
    if (sessionId) {
      setConfirmRestoreSession(session);
      return;
    }
    void restoreArchivedSession(session.id);
  };

  const endCurrentSession = async () => {
    if (!sessionId) return;
    const endingId = sessionId;
    setBusyAction('end');
    setActionMsg(m['code.actions.running']());
    try {
      const payload = await runSessionAction(endingId, 'end');
      rememberArchivedSession(payload.session);
      setSessions((prev) => prev.filter((session) => session.id !== endingId));
      setSessionId(null);
      setActionMsg(formatActionMessage('end', payload));
    } catch (err) {
      setActionMsg((err as Error).message || 'error');
    } finally {
      setBusyAction('');
    }
  };

  const restoreArchivedSession = async (archivedSessionId: string) => {
    setBusyAction('resume');
    setNewSessionIssue(null);
    setNewSessionMsg(m['code.actions.running']());
    setActionMsg(m['code.actions.running']());
    try {
      await runSessionAction(archivedSessionId, 'resume-preflight');

      if (sessionId) {
        const payload = await runSessionAction(sessionId, 'suspend');
        rememberArchivedSession(payload.session);
        setSessions((prev) =>
          prev.filter((session) => session.id !== sessionId)
        );
        setSessionId(null);
      }

      const payload = await runSessionAction(archivedSessionId, 'resume');
      if (!payload.session) throw new Error('Restore failed');
      const resumedSession = payload.session;
      markSessionRestorePending(resumedSession.id);
      setRestoreGate({
        sessionId: resumedSession.id,
        status: 'restoring',
        message: m['code.actions.restoring'](),
      });
      const restorePayload = await restoreSessionBeforeConnect(
        resumedSession.id
      );
      const session = restorePayload.session || resumedSession;
      setArchivedSessions((prev) =>
        prev.filter((item) => item.id !== session.id)
      );
      setSessions([session]);
      setSessionId(session.id);
      setArchiveCheckpoint(checkpointFromSession(session));
      setSelectedAgent(session.agent);
      setSelectedModel(session.model);
      setMobileSidebarOpen(false);
      setRuntimeIssue('');
      setPreviewNonce(Date.now());
      setNewSessionMsg(
        `${m['code.actions.restoring']()}: ${shortId(session.id)}`
      );
      setRestoreGate({ sessionId: session.id, status: 'ready', message: '' });
      setActionMsg(formatActionMessage('restore', restorePayload));
    } catch (err) {
      const issue = sessionStartIssueFromError(err);
      const message = issue ? '' : (err as Error).message || 'error';
      setNewSessionIssue(issue);
      setNewSessionMsg(message);
      setActionMsg(message);
    } finally {
      setBusyAction('');
    }
  };

  const runAction = async (action: CodeAction) => {
    if (!sessionId) return;
    setBusyAction(action);
    setActionMsg(m['code.actions.running']());
    if (action === 'archive') {
      markArchiveSaving(sessionId);
    }
    try {
      const payload = await runSessionAction(sessionId, action);
      if (action === 'suspend') {
        rememberArchivedSession(payload.session);
        setSessions((prev) =>
          prev.filter((session) => session.id !== sessionId)
        );
        setSessionId(null);
      } else if (payload.session) {
        setSessions((prev) => upsertSession(prev, payload.session!));
      }
      if (action === 'archive') {
        markArchiveSaved(sessionId, payload);
      }
      if (action === 'restore') {
        markSessionRestoreReady(sessionId);
        markRestoreIntegrity(sessionId, payload);
        setRestoreGate({ sessionId, status: 'ready', message: '' });
        setRuntimeIssue('');
        setPreviewNonce(Date.now());
      }
      if (action === 'inspect') {
        setRuntimeIssue(runtimeIssueFrom(payload));
      }
      setActionMsg(formatActionMessage(action, payload));
    } catch (err) {
      if (action === 'archive') {
        markArchiveError(sessionId, err);
      }
      setActionMsg((err as Error).message || 'error');
    } finally {
      setBusyAction('');
    }
  };

  const reconnectTerminal = async () => {
    if (!sessionId) return;
    setBusyAction('inspect');
    setActionMsg(m['code.actions.running']());
    try {
      const payload = await runSessionAction(sessionId, 'inspect');
      if (payload.session) {
        setSessions((prev) => upsertSession(prev, payload.session!));
      }
      const issue = runtimeIssueFrom(payload);
      if (issue) {
        const workspaceExists = booleanField(payload.workspace, 'exists');
        if (
          shouldRestoreWorkspace({
            archiveKey: currentSession?.archiveKey,
            status: currentSession?.status,
            workspaceExists,
          })
        ) {
          const restorePayload = await restoreSessionBeforeConnect(sessionId);
          setRestoreGate({ sessionId, status: 'ready', message: '' });
          setActionMsg(formatActionMessage('restore', restorePayload));
        } else {
          setRuntimeIssue(issue);
          setActionMsg(issue);
          return;
        }
      }
      setRuntimeIssue('');
      setActionMsg('');
      reconnect();
    } catch (err) {
      setActionMsg((err as Error).message || 'error');
    } finally {
      setBusyAction('');
    }
  };

  const toggleSidebar = () => {
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      window.localStorage.setItem(CODE_SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  };

  return (
    <div className="bg-background text-foreground min-h-screen">
      <header className="border-border bg-background/90 sticky top-0 z-40 border-b backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <img
              src={envConfigs.app_logo}
              alt=""
              className="size-7 rounded-[7px]"
            />
            <span className="font-serif text-lg italic">
              {envConfigs.app_name}
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/settings/credits"
              className={cn(
                buttonVariants({ size: 'sm', variant: 'ghost' }),
                'hidden min-w-24 gap-1.5 rounded-full sm:inline-flex'
              )}
              title={m['code.billing.balance']({
                balance: balanceQuery.data?.balance ?? 0,
              })}
            >
              <Coins className="size-4" />
              <span className="tabular-nums">
                {balanceQuery.isPending
                  ? '…'
                  : (balanceQuery.data?.balance ?? 0).toLocaleString()}
              </span>
            </Link>
            <Link
              href="/settings/top-up"
              className={cn(
                buttonVariants({ size: 'sm', variant: 'outline' }),
                'gap-1.5 rounded-full'
              )}
            >
              <Coins className="size-4" />
              <span>{m['code.billing.topup']()}</span>
            </Link>
            <Link
              href="/settings"
              className={cn(buttonVariants({ size: 'sm' }), 'rounded-full')}
            >
              {m['code.header.settings']()}
            </Link>
          </div>
        </div>
      </header>

      {mobileSidebarOpen && (
        <button
          type="button"
          className="fixed inset-0 top-16 z-40 bg-black/35 lg:hidden"
          aria-label={m['code.sidebar.close']()}
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      <main
        className={cn(
          'mx-auto grid max-w-[1600px] gap-4 px-4 py-4 transition-[grid-template-columns] duration-200 sm:px-6',
          sidebarCollapsed
            ? 'lg:grid-cols-[56px_minmax(0,1fr)]'
            : 'lg:grid-cols-[260px_minmax(0,1fr)]'
        )}
      >
        <aside
          className={cn(
            'border-border bg-card fixed top-20 bottom-4 left-4 z-50 max-h-[calc(100vh-6rem)] w-[min(320px,calc(100vw-2rem))] overflow-y-auto rounded-lg border p-4 shadow-xl transition-[width,padding] duration-200 lg:static lg:z-auto lg:block lg:max-h-none lg:min-h-[calc(100vh-6rem)] lg:w-auto lg:overflow-visible lg:shadow-none',
            mobileSidebarOpen ? 'block' : 'hidden lg:block',
            sidebarCollapsed && 'lg:p-2'
          )}
        >
          <div
            className={cn(
              'flex items-center justify-between',
              sidebarCollapsed && 'lg:flex-col lg:gap-3'
            )}
          >
            <div className={cn(sidebarCollapsed && 'lg:hidden')}>
              <p className="text-sm font-semibold">
                {m['code.sessions.title']()}
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                {m['code.sessions.subtitle']()}
              </p>
            </div>
            <div
              className={cn(
                'flex items-center gap-2',
                sidebarCollapsed && 'lg:flex-col'
              )}
            >
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="hidden size-8 lg:inline-flex"
                aria-label={
                  sidebarCollapsed
                    ? m['code.sidebar.expand']()
                    : m['code.sidebar.collapse']()
                }
                title={
                  sidebarCollapsed
                    ? m['code.sidebar.expand']()
                    : m['code.sidebar.collapse']()
                }
                aria-expanded={!sidebarCollapsed}
                onClick={toggleSidebar}
              >
                {sidebarCollapsed ? (
                  <PanelLeftOpen className="size-4" />
                ) : (
                  <PanelLeftClose className="size-4" />
                )}
              </Button>
              <Button
                size="icon"
                className="size-8 rounded-full"
                aria-label={m['code.sessions.new']()}
                disabled={
                  Boolean(busyAction) || restoreInProgress || !canCreateSession
                }
                onClick={requestNewSession}
              >
                <Plus className="size-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-8 lg:hidden"
                aria-label={m['code.sidebar.close']()}
                title={m['code.sidebar.close']()}
                onClick={() => setMobileSidebarOpen(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>

          <div
            className={cn('mt-5 space-y-2', sidebarCollapsed && 'lg:hidden')}
          >
            <Label className="text-muted-foreground text-xs">
              {m['code.agent.new_session']()}
            </Label>
            <Select
              value={selectedAgent}
              onValueChange={(value) => {
                const agent = normalizeAgent(value);
                setSelectedAgent(agent);
                setSelectedModel(defaultModelFor(models, agent)?.model || '');
              }}
              disabled={Boolean(busyAction)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {CODE_SESSION_AGENTS.map((agent) => (
                  <SelectItem key={agent} value={agent}>
                    {agentLabel(agent)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div
            className={cn('mt-4 space-y-2', sidebarCollapsed && 'lg:hidden')}
          >
            <Label className="text-muted-foreground text-xs">
              {m['code.model.new_session']()}
            </Label>
            <Select
              value={selectedModel}
              onValueChange={(value) => value && setSelectedModel(value)}
              disabled={Boolean(busyAction) || availableModels.length === 0}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={m['code.model.select']()} />
              </SelectTrigger>
              <SelectContent align="start">
                {availableModels.map((model) => (
                  <SelectItem key={model.id} value={model.model}>
                    {model.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {availableModels.length === 0 && (
              <p className="text-muted-foreground text-xs">
                {m['code.model.configure_required']()}
              </p>
            )}
          </div>

          {newSessionMsg && (
            <p
              aria-live="polite"
              className={cn(
                'text-muted-foreground mt-3 rounded-md border border-dashed px-3 py-2 text-xs leading-5',
                sidebarCollapsed && 'lg:hidden'
              )}
            >
              {newSessionMsg}
            </p>
          )}

          {newSessionIssue && (
            <div
              role="alert"
              className={cn(
                'border-destructive/40 bg-destructive/5 mt-3 rounded-md border px-3 py-3 text-xs leading-5',
                sidebarCollapsed && 'lg:hidden'
              )}
            >
              <div className="text-destructive flex items-start gap-2 font-medium">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  {newSessionIssue.reason === 'insufficient_credits'
                    ? m['code.billing.insufficient_title']()
                    : m['code.billing.model_unavailable_title']()}
                </span>
              </div>
              <p className="text-muted-foreground mt-1.5">
                {newSessionIssue.reason === 'insufficient_credits'
                  ? m['code.billing.insufficient_description']({
                      balance: newSessionIssue.balance ?? 0,
                      required: newSessionIssue.requiredBalance ?? 0,
                    })
                  : m['code.billing.model_unavailable_description']()}
              </p>
              {newSessionIssue.reason === 'insufficient_credits' && (
                <Link
                  href="/settings/top-up"
                  className="text-primary mt-2 inline-flex font-medium hover:underline"
                >
                  {m['code.billing.manage_credits']()}
                </Link>
              )}
            </div>
          )}

          <div
            className={cn('mt-6 space-y-2', sidebarCollapsed && 'lg:hidden')}
          >
            {sessions.length === 0 && (
              <p className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs">
                {m['code.sessions.empty']()}
              </p>
            )}
            {sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                className={cn(
                  'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors',
                  session.id === sessionId ? 'bg-muted' : 'hover:bg-muted/70'
                )}
                onClick={() => {
                  setSessionId(session.id);
                  setSelectedAgent(session.agent);
                  setSelectedModel(session.model);
                  setMobileSidebarOpen(false);
                }}
              >
                <span
                  className={cn(
                    'size-2 rounded-full',
                    session.id === sessionId
                      ? 'bg-primary'
                      : 'bg-muted-foreground'
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs">
                    {session.id}
                  </span>
                  <span className="text-muted-foreground mt-0.5 flex items-center gap-1 text-[11px]">
                    <Bot className="size-3" />
                    {agentLabel(session.agent)}
                  </span>
                  <span className="text-muted-foreground mt-0.5 block truncate text-[11px]">
                    {modelLabel(models, session)}
                  </span>
                </span>
              </button>
            ))}
          </div>

          <div
            className={cn(
              'border-border mt-6 border-t pt-5',
              sidebarCollapsed && 'lg:hidden'
            )}
          >
            <div className="mb-3 flex items-center gap-2 text-xs font-medium">
              <History className="text-muted-foreground size-3.5" />
              {m['code.sessions.archived_title']()}
            </div>
            <div className="space-y-2">
              {archivedSessions.length === 0 && (
                <p className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs">
                  {m['code.sessions.archived_empty']()}
                </p>
              )}
              {archivedSessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className="hover:bg-muted/70 flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={Boolean(busyAction) || restoreInProgress}
                  onClick={() => requestRestoreArchivedSession(session)}
                >
                  <span className="border-muted-foreground/40 size-2 rounded-full border" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs">
                      {session.id}
                    </span>
                    <span className="text-muted-foreground mt-0.5 flex items-center gap-1 text-[11px]">
                      <Archive className="size-3" />
                      {sessionStatusLabel(session.status)} ·{' '}
                      {agentLabel(session.agent)}
                    </span>
                    <span className="text-muted-foreground mt-0.5 block truncate text-[11px]">
                      {modelLabel(models, session)}
                    </span>
                  </span>
                  <span className="text-primary shrink-0 text-[11px] font-medium">
                    {m['code.sessions.restore']()}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div
            className={cn(
              'border-border mt-6 rounded-lg border p-3',
              sidebarCollapsed && 'lg:hidden'
            )}
          >
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <Cloud className="text-primary size-4" />
              {m['code.runtime.title']()}
            </div>
            <div className="space-y-3 text-xs">
              <Metric
                label={m['code.runtime.sandbox']()}
                value={m['code.runtime.ready']()}
              />
              <Metric
                label={m['code.runtime.session_status']()}
                value={
                  currentSession
                    ? sessionStatusLabel(currentSession.status)
                    : m['code.sessions.empty']()
                }
              />
              <Metric
                label={m['code.agent.current']()}
                value={agentLabel(currentAgent)}
              />
              <Metric
                label={m['code.model.current']()}
                value={modelLabel(models, currentModel)}
              />
              <Metric
                label={m['code.runtime.tmux']()}
                value={statusLabel(status)}
              />
              <Metric
                label={m['code.runtime.archive']()}
                value={archiveMetricValue(currentSession, archiveCheckpoint)}
              />
            </div>
          </div>
        </aside>

        <section className="grid min-w-0 gap-4 2xl:grid-cols-[minmax(800px,1fr)_320px]">
          <div className="border-border bg-card min-w-0 overflow-hidden rounded-lg border">
            <div className="border-border bg-background/80 flex items-center justify-between border-b px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="-ml-2 size-7 shrink-0 lg:hidden"
                  aria-label={m['code.sidebar.open']()}
                  title={m['code.sidebar.open']()}
                  aria-expanded={mobileSidebarOpen}
                  onClick={() => setMobileSidebarOpen(true)}
                >
                  <PanelLeftOpen className="size-4" />
                </Button>
                <Terminal className="text-muted-foreground size-4" />
                <span className="text-sm font-medium">
                  {m['code.terminal.title']()}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs">
                  {terminalStatusText}
                </span>
                <span
                  className={cn(
                    'hidden text-xs sm:inline',
                    focused ? 'text-primary' : 'text-muted-foreground'
                  )}
                >
                  {focused
                    ? m['code.terminal.focused']()
                    : m['code.terminal.unfocused']()}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 rounded-full"
                  disabled={!terminalSessionId}
                  aria-label={m['code.terminal.focus']()}
                  title={m['code.terminal.focus']()}
                  onClick={focusTerminal}
                >
                  <Focus className="size-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 rounded-full"
                  disabled={!terminalSessionId}
                  aria-label={m['code.terminal.scrollback']()}
                  title={m['code.terminal.scrollback']()}
                  onClick={enterScrollback}
                >
                  <History className="size-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 rounded-full"
                  disabled={!terminalSessionId}
                  aria-label={m['code.terminal.bottom']()}
                  title={m['code.terminal.bottom']()}
                  onClick={scrollToBottom}
                >
                  <ArrowDownToLine className="size-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 rounded-full"
                  disabled={!terminalSessionId || status !== 'connected'}
                  aria-label={m['code.terminal.interrupt']()}
                  title={m['code.terminal.interrupt']()}
                  onClick={interrupt}
                >
                  <CircleStop className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-full text-xs"
                  disabled={
                    !terminalSessionId ||
                    Boolean(busyAction) ||
                    restoreInProgress
                  }
                  onClick={() => void reconnectTerminal()}
                >
                  {m['code.terminal.reconnect']()}
                </Button>
              </div>
            </div>
            <div
              className={cn(
                'relative h-[calc(100vh-12rem)] min-h-[620px] overflow-hidden bg-[#17130f] p-3 ring-2 ring-transparent transition-shadow lg:min-h-[720px]',
                focused && 'ring-primary/30'
              )}
              onClick={focusTerminal}
            >
              <div
                ref={setTerminalElement}
                className="h-full min-h-0 w-full cursor-text"
              />
              {!sessionId && (
                <div className="absolute inset-0 flex items-center justify-center bg-[#17130f] px-6 text-center text-sm text-[#f4eadf]/70">
                  {m['code.sessions.empty']()}
                </div>
              )}
              {sessionId && restoreInProgress && (
                <div className="absolute inset-0 flex items-center justify-center bg-[#17130f] px-6 text-center text-sm text-[#f4eadf]/70">
                  {restoreGate.message || m['code.actions.restoring']()}
                </div>
              )}
              {sessionId && runtimeIssue && (
                <div className="absolute inset-x-4 top-4 rounded-md border border-red-500/40 bg-red-950/85 px-4 py-3 text-sm text-red-50 shadow-lg">
                  {runtimeIssue}
                </div>
              )}
              {sessionId && billingSuspended && (
                <div className="absolute inset-0 flex items-center justify-center bg-[#17130f]/95 px-6">
                  <div className="max-w-md text-center">
                    <AlertTriangle className="mx-auto size-7 text-amber-400" />
                    <h3 className="mt-3 text-base font-semibold text-[#f4eadf]">
                      {m['code.billing.suspended_title']()}
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-[#f4eadf]/65">
                      {m['code.billing.suspended_description']()}
                    </p>
                    <Link
                      href="/settings/top-up"
                      className={cn(
                        buttonVariants({ size: 'sm' }),
                        'mt-4 inline-flex'
                      )}
                    >
                      {m['code.billing.recharge']()}
                    </Link>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="grid gap-4">
            <Panel
              icon={FolderTree}
              title={m['code.files.title']()}
              subtitle={m['code.files.subtitle']()}
            >
              <div className="h-72 min-h-0 overflow-hidden">
                <SandboxFileTree
                  sessionId={sessionId}
                  sessionStatus={currentSession?.status}
                  selectedPath={selectedFile?.path}
                  onFileSelect={setSelectedFile}
                  labels={{
                    refresh: m['code.files.refresh'](),
                    loading: m['code.files.loading'](),
                    empty: m['code.files.empty'](),
                    failed: m['code.files.failed'](),
                    inactive: m['code.files.inactive'](),
                    truncated: m['code.files.truncated'](),
                    selected: m['code.files.selected'](),
                  }}
                />
              </div>
            </Panel>

            <Panel
              icon={FileSearch}
              title={m['code.file_preview.title']()}
              subtitle={m['code.file_preview.subtitle']()}
            >
              <div className="h-[32rem] min-h-0 overflow-hidden">
                <SandboxFilePreview
                  key={sessionId || 'no-session'}
                  sessionId={sessionId}
                  sessionStatus={currentSession?.status}
                  file={selectedFile}
                  labels={{
                    empty: m['code.file_preview.empty'](),
                    inactive: m['code.file_preview.inactive'](),
                    loading: m['code.file_preview.loading'](),
                    failed: m['code.file_preview.failed'](),
                    unsupported: m['code.file_preview.unsupported'](),
                    tooLarge: m['code.file_preview.too_large'](),
                    truncated: m['code.file_preview.truncated'](),
                    rendered: m['code.file_preview.rendered'](),
                    source: m['code.file_preview.source'](),
                    copy: m['code.file_preview.copy'](),
                    copied: m['code.file_preview.copied'](),
                    refresh: m['code.file_preview.refresh'](),
                    mime: m['code.file_preview.mime'](),
                    size: m['code.file_preview.size'](),
                    modified: m['code.file_preview.modified'](),
                    imageAlt: m['code.file_preview.image_alt'](),
                  }}
                />
              </div>
            </Panel>

            <Panel
              icon={Play}
              title={m['code.preview.title']()}
              subtitle={m['code.preview.subtitle']()}
            >
              <div className="border-border bg-background overflow-hidden rounded-md border">
                {sessionId ? (
                  terminalSessionId ? (
                    <iframe
                      title="preview"
                      className="h-56 w-full"
                      src={`${previewUrl(
                        loader.runtimeBase,
                        currentRuntimeUserId,
                        terminalSessionId
                      )}?t=${previewNonce}`}
                    />
                  ) : (
                    <div className="text-muted-foreground flex h-56 items-center justify-center px-4 text-center text-xs">
                      {restoreGate.message || m['code.actions.restoring']()}
                    </div>
                  )
                ) : (
                  <div className="text-muted-foreground flex h-56 items-center justify-center px-4 text-center text-xs">
                    {m['code.preview.empty']()}
                  </div>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="mt-3 h-7 rounded-full text-xs"
                disabled={!terminalSessionId}
                onClick={() => setPreviewNonce(Date.now())}
              >
                {m['code.actions.refresh_preview']()}
              </Button>
            </Panel>

            <Panel
              icon={Archive}
              title={m['code.archive.title']()}
              subtitle={m['code.archive.subtitle']()}
            >
              <div className="border-primary/50 mb-3 border-l-2 pl-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium">
                      {m['code.archive.status']()}
                    </p>
                    <p
                      className={cn(
                        'mt-1 text-xs leading-5',
                        archiveCheckpoint.sessionId === sessionId &&
                          archiveCheckpoint.state === 'error'
                          ? 'text-destructive'
                          : 'text-muted-foreground'
                      )}
                    >
                      {archiveStatusText(currentSession, archiveCheckpoint)}
                    </p>
                    {archiveDigest && (
                      <p className="text-muted-foreground mt-1 truncate font-mono text-[11px]">
                        {m['code.archive.digest']({
                          digest: shortDigest(archiveDigest),
                        })}
                      </p>
                    )}
                  </div>
                  {archiveCheckpoint.sessionId === sessionId &&
                    archiveCheckpoint.state === 'error' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 shrink-0 rounded-full text-xs"
                        disabled={controlsDisabled}
                        onClick={() => void runAction('archive')}
                      >
                        {m['code.archive.retry']()}
                      </Button>
                    )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-full text-xs"
                  disabled={controlsDisabled}
                  onClick={() => void runAction('health')}
                >
                  {m['code.actions.health']()}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-full text-xs"
                  disabled={controlsDisabled}
                  onClick={() => void runAction('inspect')}
                >
                  {m['code.actions.inspect']()}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-full text-xs"
                  disabled={controlsDisabled}
                  onClick={() => void runAction('archive')}
                >
                  {m['code.actions.archive']()}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-full text-xs"
                  disabled={controlsDisabled}
                  onClick={() => void runAction('restore')}
                >
                  {m['code.actions.restore']()}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-full text-xs"
                  disabled={controlsDisabled}
                  onClick={() => void runAction('suspend')}
                >
                  {m['code.actions.suspend']()}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7 rounded-full text-xs"
                  disabled={controlsDisabled}
                  onClick={() => void endCurrentSession()}
                >
                  <Square className="size-3" />
                  {m['code.actions.end']()}
                </Button>
              </div>
              <p className="text-muted-foreground mt-3 min-h-4 font-mono text-xs">
                {actionMsg}
              </p>
            </Panel>
          </div>
        </section>
      </main>

      <Dialog
        open={confirmNewSessionOpen}
        onOpenChange={setConfirmNewSessionOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{m['code.sessions.new_confirm_title']()}</DialogTitle>
            <DialogDescription>
              {m['code.sessions.new_confirm_description']()}
            </DialogDescription>
          </DialogHeader>
          <div className="text-muted-foreground space-y-3 text-sm">
            <div>
              <p className="text-foreground font-medium">
                {m['code.sessions.new_confirm_save_title']()}
              </p>
              <p>{m['code.sessions.new_confirm_save_description']()}</p>
            </div>
            <div>
              <p className="text-foreground font-medium">
                {m['code.sessions.new_confirm_discard_title']()}
              </p>
              <p>{m['code.sessions.new_confirm_discard_description']()}</p>
            </div>
          </div>
          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmNewSessionOpen(false)}
            >
              {m['code.sessions.new_confirm_cancel']()}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirmNewSessionOpen(false);
                void newSession('discard');
              }}
            >
              {m['code.sessions.new_confirm_discard_confirm']()}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setConfirmNewSessionOpen(false);
                void newSession('suspend');
              }}
            >
              {m['code.sessions.new_confirm_save_confirm']()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(confirmRestoreSession)}
        onOpenChange={(open) => {
          if (!open) setConfirmRestoreSession(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {m['code.sessions.restore_confirm_title']()}
            </DialogTitle>
            <DialogDescription>
              {m['code.sessions.restore_confirm_description']()}
            </DialogDescription>
          </DialogHeader>
          {confirmRestoreSession && (
            <p className="text-muted-foreground rounded-md border px-3 py-2 font-mono text-xs">
              {confirmRestoreSession.id}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmRestoreSession(null)}
            >
              {m['code.sessions.restore_confirm_cancel']()}
            </Button>
            <Button
              type="button"
              onClick={() => {
                const session = confirmRestoreSession;
                setConfirmRestoreSession(null);
                if (session) void restoreArchivedSession(session.id);
              }}
            >
              {m['code.sessions.restore_confirm_confirm']()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

async function runSessionAction(sessionId: string, action: CodeAction) {
  return apiPost<CodeActionResponse>(
    `/api/code/sessions/${encodeURIComponent(sessionId)}/actions`,
    { action }
  );
}

function upsertSession(sessions: CodeSessionView[], session: CodeSessionView) {
  const rest = sessions.filter((item) => item.id !== session.id);
  if (session.status !== 'active') return rest;
  return [session, ...rest].slice(0, 10);
}

function upsertArchivedSession(
  sessions: CodeSessionView[],
  session: CodeSessionView
) {
  const rest = sessions.filter((item) => item.id !== session.id);
  if (
    (session.status !== 'ended' && session.status !== 'suspended') ||
    !session.archiveKey
  ) {
    return rest;
  }
  return [session, ...rest].slice(0, 20);
}

function shortId(sessionId: string) {
  return sessionId.length > 18 ? `${sessionId.slice(0, 18)}...` : sessionId;
}

function formatActionMessage(action: CodeAction, payload: CodeActionResponse) {
  if (action === 'health') {
    return (
      [payload.tmux, payload.claude, payload.codex]
        .filter(Boolean)
        .join(' / ') || 'ok'
    );
  }

  if (action === 'inspect') {
    return runtimeIssueFrom(payload) || m['code.runtime.available']();
  }

  if (action === 'end') {
    return payload.archiveError
      ? `${m['code.actions.ended']()}: ${payload.archiveError}`
      : m['code.actions.ended']();
  }

  if (action === 'suspend') {
    return payload.archiveError || payload.clearError
      ? `${m['code.actions.suspended']()}: ${payload.archiveError || payload.clearError}`
      : m['code.actions.suspended']();
  }

  if (action === 'discard') {
    return m['code.actions.discarded']();
  }

  if (action === 'resume') {
    return m['code.actions.restore_started']();
  }

  const detail =
    action === 'archive'
      ? payload.archive
      : action === 'restore'
        ? payload.restore
        : payload;
  const digest = digestFrom(detail) || digestFrom(payload);

  if (digest) return `${action}: ${digest.slice(0, 12)}...`;
  return `${action}: ok`;
}

function runtimeIssueFrom(payload: CodeActionResponse) {
  const tmuxExists = booleanField(payload.tmuxStatus, 'exists');
  const workspaceExists = booleanField(payload.workspace, 'exists');
  if (tmuxExists === false || workspaceExists === false) {
    return m['code.runtime.lost']();
  }
  return '';
}

function booleanField(payload: unknown, field: string) {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === 'boolean' ? value : undefined;
}

function digestFrom(payload: unknown) {
  if (!payload || typeof payload !== 'object') return '';
  const value =
    (payload as Record<string, unknown>).workspaceDigest ||
    (payload as Record<string, unknown>).archiveSha256 ||
    (payload as Record<string, unknown>).digest;
  return typeof value === 'string' ? value : '';
}

function objectField(payload: unknown, field: string) {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[field];
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(payload: unknown, field: string) {
  if (!payload || typeof payload !== 'object') return '';
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

function sessionStartIssueFromError(error: unknown): SessionStartIssue | null {
  if (!(error instanceof ApiError) || !error.data) return null;
  if (typeof error.data !== 'object') return null;

  const data = error.data as Record<string, unknown>;
  const reason = data.reason;
  if (
    reason !== 'insufficient_credits' &&
    reason !== 'model_costs_not_configured'
  ) {
    return null;
  }

  return {
    reason,
    balance: finiteNumber(data.balance),
    requiredBalance: finiteNumber(data.requiredBalance),
  };
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function checkpointFromSession(
  session: CodeSessionView | null | undefined
): ArchiveCheckpoint {
  if (!session) return { sessionId: null, state: 'idle' };
  if (!session.archiveKey) {
    return { sessionId: session.id, state: 'idle' };
  }
  return {
    sessionId: session.id,
    state: 'saved',
    savedAt: session.lastActiveAt,
    digest: session.archiveDigest || undefined,
  };
}

function archiveDigestForSession(
  session: CodeSessionView | null,
  checkpoint: ArchiveCheckpoint
) {
  if (session && checkpoint.sessionId === session.id && checkpoint.digest) {
    return checkpoint.digest;
  }
  return session?.archiveDigest || '';
}

function archiveMetricValue(
  session: CodeSessionView | null,
  checkpoint: ArchiveCheckpoint
) {
  if (session && checkpoint.sessionId === session.id) {
    if (checkpoint.state === 'saving') return m['code.archive.saving_short']();
    if (checkpoint.state === 'error') return m['code.archive.error_short']();
    if (checkpoint.state === 'verified') {
      return m['code.archive.verified_short']();
    }
    if (checkpoint.state === 'saved') return m['code.archive.saved_short']();
  }
  return session?.archiveKey
    ? m['code.archive.saved_short']()
    : m['code.archive.unavailable_short']();
}

function archiveStatusText(
  session: CodeSessionView | null,
  checkpoint: ArchiveCheckpoint
) {
  if (!session) return m['code.sessions.empty']();
  if (checkpoint.sessionId === session.id) {
    if (checkpoint.state === 'saving') return m['code.archive.saving']();
    if (checkpoint.state === 'error') {
      return m['code.archive.failed']({
        message: checkpoint.message || 'unknown',
      });
    }
    if (checkpoint.state === 'verified') return m['code.archive.verified']();
    if (checkpoint.state === 'saved') {
      return m['code.archive.saved']({
        time: checkpoint.savedAt
          ? relativeTime(checkpoint.savedAt)
          : m['code.archive.just_now'](),
      });
    }
  }
  if (session.archiveKey) {
    return m['code.archive.saved']({
      time: relativeTime(session.lastActiveAt),
    });
  }
  return m['code.archive.unavailable']();
}

function relativeTime(value: string) {
  const date = new Date(value);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) return m['code.archive.just_now']();

  const deltaSeconds = Math.round((timestamp - Date.now()) / 1000);
  const absSeconds = Math.abs(deltaSeconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, {
    numeric: 'auto',
  });

  if (absSeconds < 60) return formatter.format(deltaSeconds, 'second');
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (Math.abs(deltaMinutes) < 60) {
    return formatter.format(deltaMinutes, 'minute');
  }
  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) {
    return formatter.format(deltaHours, 'hour');
  }
  const deltaDays = Math.round(deltaHours / 24);
  return formatter.format(deltaDays, 'day');
}

function shortDigest(digest: string) {
  return digest.length > 16 ? `${digest.slice(0, 16)}...` : digest;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate text-right font-medium">{value}</span>
    </div>
  );
}

function agentLabel(agent: CodeSessionAgent) {
  switch (agent) {
    case 'codex':
      return m['code.agent.codex']();
    case 'claude':
    default:
      return m['code.agent.claude']();
  }
}

function defaultModelFor(models: CodeModelView[], agent: CodeSessionAgent) {
  return (
    models.find((model) => model.agent === agent && model.isDefault) ??
    models.find((model) => model.agent === agent)
  );
}

function modelLabel(
  models: CodeModelView[],
  value: CodeSessionView | string | null | undefined
) {
  const modelId = typeof value === 'string' ? value : value?.model || '';
  if (!modelId) return m['code.model.unselected']();
  const model = models.find((item) => item.model === modelId);
  return model?.label || modelId;
}

function sessionStatusLabel(status: CodeSessionView['status']) {
  switch (status) {
    case 'active':
      return m['code.session_status.active']();
    case 'suspended':
      return m['code.session_status.suspended']();
    case 'ended':
      return m['code.session_status.ended']();
    case 'error':
      return m['code.session_status.error']();
    default:
      return status;
  }
}

function statusLabel(status: TerminalStatus): string {
  switch (status) {
    case 'connecting':
      return m['code.terminal.connecting']();
    case 'connected':
      return m['code.terminal.connected']();
    case 'error':
      return m['code.terminal.error']();
    case 'closed':
      return m['code.terminal.closed']();
    default:
      return m['code.terminal.idle']();
  }
}

function Panel({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="border-border bg-card rounded-lg border p-4">
      <div className="mb-4 flex items-start gap-3">
        <div className="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
          <Icon className="size-4" />
        </div>
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="text-muted-foreground mt-1 text-xs leading-5">
            {subtitle}
          </p>
        </div>
      </div>
      {children}
    </div>
  );
}

const getCodeSession = createServerFn().handler(async () => {
  const { getRequest } = await import('@tanstack/react-start/server');
  const { getAuth } = await import('@/core/auth');
  const { listArchivedSessions, listSessions } =
    await import('@/modules/code/service');
  const { listEnabledCodeModels } = await import('@/modules/code/models');
  const { sanitizeUserId } = await import('@/modules/code/runtime');

  const request = getRequest();
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session?.user) return null;

  const sessions = await listSessions(session.user.id);
  const archivedSessions = await listArchivedSessions(session.user.id);
  const activeSession = sessions[0] ?? null;
  const models = await listEnabledCodeModels();

  return {
    runtimeUserId:
      activeSession?.runtimeUserId ?? sanitizeUserId(session.user.id),
    session: activeSession,
    sessions,
    archivedSessions,
    models,
  };
});

export const Route = createFileRoute('/code')({
  loader: async () => {
    const session = await getCodeSession();
    if (!session) {
      throw redirect({ to: '/sign-in' });
    }
    return {
      ...session,
      runtimeBase: envConfigs.runtime_base_url,
    };
  },
  component: CodeWorkspacePage,
});
