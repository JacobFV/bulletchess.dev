/**
 * One lobby WebSocket for the whole app: keeps you visible as online, delivers matchmaking
 * results, incoming challenges and scheduled-game starts on any page.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import type { ChallengeView, ClientLobbyMsg, ServerLobbyMsg } from "../../shared/protocol";
import type { PoolId } from "../../shared/tc";
import { api, wsUrl } from "./api";
import { useMe } from "./me";
import { sound } from "./sound";

export interface Stats {
  players: number;
  games: number;
  pools: Record<string, number>;
}

export interface MyChallenges {
  incoming: ChallengeView[];
  outgoing: ChallengeView[];
  upcoming: ChallengeView[];
  started: ChallengeView[];
}

const EMPTY: MyChallenges = { incoming: [], outgoing: [], upcoming: [], started: [] };

interface LobbyCtx {
  connected: boolean;
  stats: Stats | null;
  seeking: { pool: PoolId; since: number } | null;
  error: string | null;
  seek: (pool: PoolId) => void;
  cancelSeek: () => void;
  clearError: () => void;
  challenges: MyChallenges;
  refreshChallenges: () => Promise<void>;
  toasts: Toast[];
  dismissToast: (id: string) => void;
  /** Bumped whenever presence or challenges change, so lists can refetch. */
  version: number;
}

export type Toast = { id: string; kind: "challenge"; c: ChallengeView } | { id: string; kind: "note"; text: string };

const Ctx = createContext<LobbyCtx | null>(null);

export function LobbyProvider({ children }: { children: ReactNode }) {
  const { me } = useMe();
  const nav = useNavigate();
  const uid = me?.user?.id ?? null;
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [seeking, setSeeking] = useState<{ pool: PoolId; since: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [challenges, setChallenges] = useState<MyChallenges>(EMPTY);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [version, setVersion] = useState(0);
  const ws = useRef<WebSocket | null>(null);
  const pendingSeek = useRef<PoolId | null>(null);
  const navRef = useRef(nav);
  navRef.current = nav;

  const refreshChallenges = useCallback(async () => {
    if (!uid) return setChallenges(EMPTY);
    try {
      setChallenges(await api<MyChallenges>("/api/challenges"));
    } catch {
      /* keep previous */
    }
  }, [uid]);

  useEffect(() => {
    void refreshChallenges();
  }, [refreshChallenges]);

  const pushToast = useCallback((t: Toast) => {
    setToasts((ts) => [...ts.filter((x) => x.id !== t.id), t].slice(-4));
    if (t.kind === "note") window.setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== t.id)), 6000);
  }, []);

  // (Re)connect whenever the signed-in user changes, so the server sees who we are.
  const loaded = me !== null;
  useEffect(() => {
    if (!loaded) return;
    let closed = false;
    let retry = 0;
    let timer: number | undefined;
    let keepalive: number | undefined;
    const connect = () => {
      const s = new WebSocket(wsUrl("/api/lobby/ws"));
      ws.current = s;
      s.onopen = () => {
        retry = 0;
        setConnected(true);
        keepalive = window.setInterval(() => s.readyState === WebSocket.OPEN && s.send(JSON.stringify({ t: "ping" } satisfies ClientLobbyMsg)), 25_000);
        if (pendingSeek.current) s.send(JSON.stringify({ t: "seek", pool: pendingSeek.current } satisfies ClientLobbyMsg));
      };
      s.onmessage = (e) => {
        const m = JSON.parse(e.data) as ServerLobbyMsg;
        switch (m.t) {
          case "hello":
          case "stats":
            setStats({ players: m.players, games: m.games, pools: m.pools });
            setVersion((v) => v + 1);
            break;
          case "seeking":
            setSeeking({ pool: m.pool, since: performance.now() });
            break;
          case "cancelled":
            pendingSeek.current = null;
            setSeeking(null);
            break;
          case "start":
            pendingSeek.current = null;
            setSeeking(null);
            sound.start();
            navRef.current(`/game/${m.id}`);
            break;
          case "error":
            pendingSeek.current = null;
            setSeeking(null);
            setError(m.message);
            break;
          case "challenge":
            sound.notify();
            pushToast({ id: m.c.id, kind: "challenge", c: m.c });
            void refreshChallenges();
            setVersion((v) => v + 1);
            break;
          case "challenges":
            if (m.note) pushToast({ id: `n${Date.now()}`, kind: "note", text: m.note });
            void refreshChallenges();
            setVersion((v) => v + 1);
            break;
        }
      };
      s.onclose = () => {
        window.clearInterval(keepalive);
        setConnected(false);
        if (!closed) timer = window.setTimeout(connect, Math.min(5000, 300 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      window.clearInterval(keepalive);
      ws.current?.close();
      ws.current = null;
    };
  }, [uid, loaded, pushToast, refreshChallenges]);

  // Drop challenge toasts whose challenge is no longer incoming (accepted elsewhere, cancelled, expired).
  useEffect(() => {
    const live = new Set(challenges.incoming.map((c) => c.id));
    setToasts((ts) => ts.filter((t) => t.kind !== "challenge" || live.has(t.id)));
  }, [challenges.incoming]);

  const send = (m: ClientLobbyMsg) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(m));
  };

  const seek = useCallback((pool: PoolId) => {
    setError(null);
    pendingSeek.current = pool;
    setSeeking({ pool, since: performance.now() });
    send({ t: "seek", pool });
  }, []);

  const cancelSeek = useCallback(() => {
    pendingSeek.current = null;
    setSeeking(null);
    send({ t: "cancel" });
  }, []);

  return (
    <Ctx.Provider
      value={{
        connected,
        stats,
        seeking,
        error,
        seek,
        cancelSeek,
        clearError: () => setError(null),
        challenges,
        refreshChallenges,
        toasts,
        dismissToast: (id) => setToasts((ts) => ts.filter((t) => t.id !== id)),
        version,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useLobby(): LobbyCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useLobby outside LobbyProvider");
  return c;
}

/** Accept / decline / cancel helpers shared by toasts, the challenges page and the players page. */
export async function challengeAction(id: string, action: "accept" | "decline" | "cancel"): Promise<{ gameId?: string; scheduledAt?: number }> {
  return api(`/api/challenges/${id}/${action}`, { method: "POST", json: {} });
}
