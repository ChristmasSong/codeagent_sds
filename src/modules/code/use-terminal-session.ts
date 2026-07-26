import { useCallback, useEffect, useRef, useState } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import { terminalWsUrl, type CodeSessionAgent } from '@/modules/code/runtime';

export type TerminalStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'closed'
  | 'error';
export type TerminalConnectionMode = 'none' | 'proxy' | 'direct';
type TerminalChunk = string;

export interface TerminalConnectionEvent {
  eventType: string;
  severity?: 'info' | 'warn' | 'error';
  message?: string;
  metadata?: Record<string, unknown>;
}

interface Options {
  sessionId: string | null;
  container: HTMLDivElement | null;
  runtimeBase?: string;
  runtimeUserId?: string | null;
  agent?: CodeSessionAgent;
  model?: string;
  onConnectionEvent?: (event: TerminalConnectionEvent) => void;
}

export function useTerminalSession({
  sessionId,
  container,
  runtimeBase,
  runtimeUserId,
  agent,
  model,
  onConnectionEvent,
}: Options): {
  status: TerminalStatus;
  focused: boolean;
  mode: TerminalConnectionMode;
  reconnect: () => void;
  resize: () => void;
  focus: () => void;
  interrupt: () => void;
  scrollToBottom: () => void;
  enterScrollback: () => void;
} {
  const [status, setStatus] = useState<TerminalStatus>('idle');
  const [focused, setFocused] = useState(false);
  const [mode, setMode] = useState<TerminalConnectionMode>('none');
  const [terminalReady, setTerminalReady] = useState(false);
  const [connectNonce, setConnectNonce] = useState(0);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeTimersRef = useRef<number[]>([]);
  const pendingOutputRef = useRef<TerminalChunk[]>([]);
  const textDecoderRef = useRef<TextDecoder | null>(null);

  const reportConnectionEvent = useCallback(
    (event: TerminalConnectionEvent) => {
      try {
        onConnectionEvent?.(event);
      } catch (error) {
        console.warn('[code-terminal] event report failed', error);
      }
    },
    [onConnectionEvent]
  );

  const flushPendingOutput = useCallback(() => {
    const term = termRef.current;
    if (!term || pendingOutputRef.current.length === 0) return;
    const chunks = pendingOutputRef.current;
    pendingOutputRef.current = [];
    chunks.forEach((chunk) => term.write(chunk));
  }, []);

  const writeTerminal = useCallback(
    (chunk: TerminalChunk) => {
      if (!chunk) return;
      const term = termRef.current;
      if (!term) {
        pendingOutputRef.current.push(chunk);
        return;
      }
      flushPendingOutput();
      term.write(chunk);
    },
    [flushPendingOutput]
  );

  const decodeTerminalBytes = useCallback((bytes: Uint8Array) => {
    if (bytes.byteLength === 0) return '';
    if (typeof TextDecoder === 'undefined') {
      let value = '';
      for (let index = 0; index < bytes.byteLength; index += 1) {
        value += String.fromCharCode(bytes[index]!);
      }
      return value;
    }
    textDecoderRef.current ??= new TextDecoder();
    return textDecoderRef.current.decode(bytes, { stream: true });
  }, []);

  const sessionTerminalUrls = useCallback(
    (id: string) => {
      const proxy = new URL(
        `/api/code/sessions/${encodeURIComponent(id)}/terminal`,
        window.location.href
      );
      proxy.protocol = proxy.protocol === 'https:' ? 'wss:' : 'ws:';

      const urls: Array<{ mode: TerminalConnectionMode; url: string }> = [];
      if (runtimeBase && runtimeUserId) {
        urls.push({
          mode: 'direct',
          url: terminalWsUrl(runtimeBase, runtimeUserId, id, agent, model),
        });
      }
      urls.push({ mode: 'proxy', url: proxy.toString() });
      return urls;
    },
    [agent, model, runtimeBase, runtimeUserId]
  );

  const sendResize = useCallback(
    (redraw = false) => {
      const term = termRef.current;
      const fit = fitRef.current;
      const socket = socketRef.current;
      if (
        !term ||
        !fit ||
        !container ||
        container.clientWidth <= 0 ||
        container.clientHeight <= 0
      ) {
        return;
      }
      try {
        fit.fit();
      } catch {
        return;
      }
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })
        );
        if (redraw) {
          socket.send(JSON.stringify({ type: 'input', data: '\x0c' }));
        }
      }
    },
    [container]
  );

  const queueResize = useCallback(
    (delayMs: number, redraw = false) => {
      const timer = window.setTimeout(() => {
        resizeTimersRef.current = resizeTimersRef.current.filter(
          (item) => item !== timer
        );
        window.requestAnimationFrame(() => sendResize(redraw));
      }, delayMs);
      resizeTimersRef.current.push(timer);
    },
    [sendResize]
  );

  const scheduleResizeBurst = useCallback(
    (redraw = false) => {
      resizeTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      resizeTimersRef.current = [];
      [0, 80, 250, 600, 1200].forEach((delayMs, index) => {
        queueResize(delayMs, redraw && index >= 2);
      });
    },
    [queueResize]
  );

  const sendInput = useCallback((data: string) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'input', data }));
    }
  }, []);

  const focus = useCallback(() => {
    const term = termRef.current;
    if (!term) {
      setFocused(false);
      return;
    }
    term.focus();
    window.requestAnimationFrame(() => term.focus());
    setFocused(true);
  }, []);

  const interrupt = useCallback(() => {
    sendInput('\x03');
    const term = termRef.current;
    term?.scrollToBottom();
    term?.focus();
    setFocused(Boolean(term));
  }, [sendInput]);

  const scrollToBottom = useCallback(() => {
    termRef.current?.scrollToBottom();
    termRef.current?.focus();
    setFocused(Boolean(termRef.current));
  }, []);

  const enterScrollback = useCallback(() => {
    const term = termRef.current;
    if (term) {
      term.scrollLines(-Math.max(term.rows - 2, 1));
    }
    termRef.current?.focus();
    setFocused(Boolean(termRef.current));
  }, []);

  const connect = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
    pendingOutputRef.current = [];
    if (!sessionId) {
      termRef.current?.clear();
      setMode('none');
      setStatus('idle');
      return;
    }
    const urls = sessionTerminalUrls(sessionId);
    textDecoderRef.current =
      typeof TextDecoder === 'undefined' ? null : new TextDecoder();

    const openSocket = (index: number, targetStartedAt = Date.now()) => {
      const target = urls[index];
      if (!target) {
        reportConnectionEvent({
          eventType: 'terminal.error',
          severity: 'error',
          message: 'No terminal endpoint available',
          metadata: { mode: 'none' },
        });
        setStatus('error');
        return;
      }

      setMode(target.mode);
      setStatus('connecting');
      const attemptStartedAt = Date.now();
      const eventMetadata = (extra: Record<string, unknown> = {}) => ({
        mode: target.mode,
        index,
        elapsedMs: Date.now() - attemptStartedAt,
        totalElapsedMs: Date.now() - targetStartedAt,
        ...extra,
      });
      const reportSocketEvent = (
        eventType: string,
        severity: 'info' | 'warn' | 'error',
        message: string,
        metadata: Record<string, unknown> = {}
      ) => {
        reportConnectionEvent({
          eventType,
          severity,
          message,
          metadata: eventMetadata(metadata),
        });
      };
      let socket: WebSocket;
      try {
        socket = new WebSocket(target.url);
      } catch {
        reportSocketEvent(
          'terminal.error',
          'warn',
          'Terminal WebSocket constructor failed'
        );
        window.setTimeout(() => openSocket(index + 1), 0);
        return;
      }
      let opened = false;
      let keepAliveInterval: number | undefined;
      socket.binaryType = 'arraybuffer';
      socketRef.current = socket;

      const clearConnectTimeout = () => {
        window.clearTimeout(connectTimeout);
        if (keepAliveInterval) {
          window.clearInterval(keepAliveInterval);
          keepAliveInterval = undefined;
        }
      };
      const fallback = (reason = 'fallback') => {
        if (socketRef.current !== socket) return;
        clearConnectTimeout();
        if (
          !opened &&
          target.mode === 'direct' &&
          Date.now() - targetStartedAt < 120000
        ) {
          socketRef.current = null;
          socket.close();
          window.setTimeout(() => openSocket(index, targetStartedAt), 1500);
          return;
        }
        if (opened || index >= urls.length - 1) {
          reportSocketEvent(
            'terminal.error',
            'error',
            'Terminal connection failed',
            { reason, opened }
          );
          setStatus('error');
          return;
        }
        reportSocketEvent(
          'terminal.fallback',
          'warn',
          'Terminal connection fallback',
          {
            reason,
            from: target.mode,
            to: urls[index + 1]?.mode || 'none',
          }
        );
        socketRef.current = null;
        socket.close();
        window.setTimeout(() => openSocket(index + 1), 0);
      };
      const writeIncoming = (chunk: string) => {
        if (socketRef.current !== socket || !chunk) return;
        writeTerminal(chunk);
      };
      const connectTimeout = window.setTimeout(
        fallback,
        target.mode === 'direct' ? 120000 : 30000
      );

      socket.addEventListener('open', () => {
        if (socketRef.current !== socket) return;
        clearConnectTimeout();
        opened = true;
        reportSocketEvent('terminal.open', 'info', 'Terminal connected');
        setStatus('connected');
        scheduleResizeBurst(true);
        keepAliveInterval = window.setInterval(() => {
          if (
            socketRef.current !== socket ||
            socket.readyState !== WebSocket.OPEN
          ) {
            if (keepAliveInterval) {
              window.clearInterval(keepAliveInterval);
              keepAliveInterval = undefined;
            }
            return;
          }
          socket.send(JSON.stringify({ type: 'heartbeat' }));
        }, 20000);
        // xterm only emits onData (keystrokes) while its helper textarea holds
        // focus; focus on connect so the user can type without clicking first.
        termRef.current?.focus();
      });
      socket.addEventListener('message', (event) => {
        if (socketRef.current !== socket) return;
        if (typeof event.data === 'string') {
          writeIncoming(event.data);
        } else if (event.data instanceof Blob) {
          event.data.arrayBuffer().then((buffer) => {
            if (socketRef.current === socket) {
              writeIncoming(decodeTerminalBytes(new Uint8Array(buffer)));
            }
          });
        } else {
          writeIncoming(
            decodeTerminalBytes(new Uint8Array(event.data as ArrayBuffer))
          );
        }
      });
      socket.addEventListener('close', (event) => {
        if (socketRef.current !== socket) return;
        clearConnectTimeout();
        if (!opened && index < urls.length - 1) {
          fallback('close_before_open');
          return;
        }
        reportSocketEvent(
          'terminal.close',
          event.wasClean ? 'info' : 'warn',
          'Terminal WebSocket closed',
          {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
            opened,
          }
        );
        setStatus('closed');
      });
      socket.addEventListener('error', () => fallback('socket_error'));
    };

    openSocket(0);
  }, [
    decodeTerminalBytes,
    reportConnectionEvent,
    sessionId,
    sessionTerminalUrls,
    scheduleResizeBurst,
    writeTerminal,
  ]);

  const reconnect = useCallback(() => {
    setMode('none');
    setStatus(sessionId ? 'connecting' : 'idle');
    setConnectNonce((value) => value + 1);
  }, [sessionId]);

  const resize = useCallback(() => {
    scheduleResizeBurst(true);
  }, [scheduleResizeBurst]);

  useEffect(() => {
    let disposed = false;
    let removeWindowResize: (() => void) | null = null;
    let removeTerminalFocusListeners: (() => void) | null = null;
    if (!container) return;
    setTerminalReady(false);
    setStatus(sessionId ? 'connecting' : 'idle');

    (async () => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
        ]);
        if (disposed) return;

        const term = new Terminal({
          cursorBlink: true,
          cursorStyle: 'block',
          cursorInactiveStyle: 'outline',
          convertEol: false,
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12,
          letterSpacing: 0,
          lineHeight: 1.15,
          scrollback: 5000,
          theme: {
            background: '#17130f',
            foreground: '#f4eadf',
            cursor: '#ffffff',
          },
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(container);

        termRef.current = term;
        fitRef.current = fit;
        setTerminalReady(true);

        try {
          fit.fit();
        } catch (error) {
          console.warn('[code-terminal] initial fit failed', error);
        }

        try {
          term.focus();
          setFocused(true);
        } catch {
          // Focus is ergonomic, not required for the websocket session.
        }

        term.onData((data) => {
          sendInput(data);
        });
        if (term.element) {
          const onFocusIn = () => setFocused(true);
          const onFocusOut = () => setFocused(false);
          term.element.addEventListener('focusin', onFocusIn);
          term.element.addEventListener('focusout', onFocusOut);
          removeTerminalFocusListeners = () => {
            term.element?.removeEventListener('focusin', onFocusIn);
            term.element?.removeEventListener('focusout', onFocusOut);
          };
        }

        flushPendingOutput();
        scheduleResizeBurst();
        const fontsReady = document.fonts?.ready;
        if (fontsReady && typeof fontsReady.then === 'function') {
          fontsReady
            .then(() => {
              if (!disposed) scheduleResizeBurst(true);
            })
            .catch(() => undefined);
        }

        // The terminal's real pixel size settles after hydration/layout and can
        // change without a window resize (side panels, font load, breakpoints).
        // Track the container directly so xterm's cols/rows stay in sync with the
        // dimensions we report to the PTY — otherwise Claude/tmux draw at the
        // wrong width/height and the TUI renders garbled. Fires once on observe.
        if (typeof ResizeObserver !== 'undefined') {
          const resizeObserver = new ResizeObserver(() =>
            scheduleResizeBurst()
          );
          resizeObserver.observe(container);
          resizeObserverRef.current = resizeObserver;
        }
        const onWindowResize = () => scheduleResizeBurst();
        window.addEventListener('resize', onWindowResize);
        removeWindowResize = () =>
          window.removeEventListener('resize', onWindowResize);
      } catch (error) {
        console.warn('[code-terminal] terminal setup failed', error);
        if (!disposed) {
          if (termRef.current) {
            setTerminalReady(true);
          } else {
            setStatus('error');
          }
        }
      }
    })();

    return () => {
      disposed = true;
      setTerminalReady(false);
      removeTerminalFocusListeners?.();
      removeWindowResize?.();
      resizeTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      resizeTimersRef.current = [];
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      socketRef.current?.close();
      socketRef.current = null;
      pendingOutputRef.current = [];
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [
    container,
    flushPendingOutput,
    scheduleResizeBurst,
    sendInput,
    sessionId,
  ]);

  useEffect(() => {
    if (!terminalReady) return;
    connect();
  }, [terminalReady, connect, connectNonce]);

  return {
    status,
    focused,
    mode,
    reconnect,
    resize,
    focus,
    interrupt,
    scrollToBottom,
    enterScrollback,
  };
}
