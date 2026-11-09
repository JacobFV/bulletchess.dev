import { Chess } from "chess.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { uciToMove } from "../../shared/core";
import { firstMoveMs } from "../../shared/tc";
import type { ClientGameMsg, Color, GameView, ServerGameMsg } from "../../shared/protocol";
import { wsUrl } from "./api";
import { playMoveSound, sound } from "./sound";

export interface ClockAnchor {
  clocks: { white: number; black: number };
  /** performance.now() when the anchor was taken. */
  at: number;
  running: boolean;
  turn: Color;
}

export interface LiveGame {
  g: GameView | null;
  anchor: ClockAnchor | null;
  /** Local-clock deadline for the first move (performance.now() based). */
  firstMoveDeadline: number | null;
  connected: boolean;
  rtt: number | null;
  error: string | null;
  archived: boolean;
}

const turnOf = (ply: number): Color => (ply % 2 === 0 ? "white" : "black");

export function clockValue(a: ClockAnchor | null, color: Color, now = performance.now()): number {
  if (!a) return 0;
  const v = a.clocks[color];
  return a.running && a.turn === color ? Math.max(0, v - (now - a.at)) : v;
}

export function useLiveGame(id: string, onRematch: (id: string) => void) {
  const [st, setSt] = useState<LiveGame>({ g: null, anchor: null, firstMoveDeadline: null, connected: false, rtt: null, error: null, archived: false });
  const ws = useRef<WebSocket | null>(null);
  const stRef = useRef(st);
  stRef.current = st;
  const rematchRef = useRef(onRematch);
  rematchRef.current = onRematch;

  const send = useCallback((m: ClientGameMsg) => {
    const s = ws.current;
    if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify(m));
  }, []);

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let pingTimer: number | undefined;
    let reconnectTimer: number | undefined;

    const fmDeadline = (serverDeadline: number | null, serverNow: number) => (serverDeadline === null ? null : performance.now() + (serverDeadline - serverNow));

    const connect = () => {
      const sock = new WebSocket(wsUrl(`/api/games/${id}/ws`));
      ws.current = sock;
      sock.onopen = () => {
        retry = 0;
        setSt((s) => ({ ...s, connected: true, error: null }));
        const ping = () => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify({ t: "ping", c: performance.now() } satisfies ClientGameMsg));
        ping();
        pingTimer = window.setInterval(ping, 2000);
      };
      sock.onmessage = (e) => {
        let m: ServerGameMsg;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        const now = performance.now();
        switch (m.t) {
          case "state":
          case "end": {
            const g = m.g;
            const prev = stRef.current.g;
            if (m.t === "end" && prev && prev.status === "started") sound.end();
            if (m.t === "state" && g.status === "started" && g.moves.length === 0 && prev?.status !== "started") sound.start();
            setSt((s) => ({
              ...s,
              g,
              anchor: { clocks: g.clocks, at: now, running: g.running, turn: turnOf(g.moves.length) },
              firstMoveDeadline: fmDeadline(g.firstMoveDeadline, g.serverNow),
            }));
            return;
          }
          case "move": {
            const s = stRef.current;
            const g = s.g;
            if (!g) return;
            let moves = g.moves;
            let sans = g.sans;
            if (m.ply === g.moves.length + 1) {
              moves = [...g.moves, m.u];
              sans = [...g.sans, m.san];
              if (g.you !== turnOf(g.moves.length)) playMoveSound(m.san);
            } else if (!(m.ply === g.moves.length && g.moves[m.ply - 1] === m.u)) {
              sock.close(4000, "resync"); // out of sync: reconnect for a fresh state
              return;
            }
            setSt((cur) => ({
              ...cur,
              g: cur.g && { ...cur.g, moves, sans, fen: m.fen, clocks: m.clocks, running: m.running, drawOffer: cur.g.drawOffer, firstMoveDeadline: m.firstMoveDeadline },
              anchor: { clocks: m.clocks, at: now, running: m.running, turn: turnOf(m.ply) },
              firstMoveDeadline: fmDeadline(m.firstMoveDeadline, m.serverNow),
            }));
            return;
          }
          case "offers":
            if (m.drawOffer && m.drawOffer !== stRef.current.g?.you) sound.notify();
            if (m.rematchOffer && m.rematchOffer !== stRef.current.g?.you) sound.notify();
            setSt((s) => ({ ...s, g: s.g && { ...s.g, drawOffer: m.drawOffer, rematchOffer: m.rematchOffer } }));
            return;
          case "presence":
            setSt((s) => ({ ...s, g: s.g && { ...s.g, online: m.online, spectators: m.spectators } }));
            return;
          case "rematch":
            rematchRef.current(m.id);
            return;
          case "pong":
            setSt((s) => ({ ...s, rtt: Math.round(now - m.c) }));
            return;
          case "ping":
            sock.send(JSON.stringify({ t: "pong", s: m.s } satisfies ClientGameMsg));
            return;
          case "error":
            setSt((s) => ({ ...s, error: m.message }));
            return;
        }
      };
      sock.onclose = (e) => {
        window.clearInterval(pingTimer);
        if (ws.current === sock) ws.current = null;
        setSt((s) => ({ ...s, connected: false }));
        if (closed) return;
        if (e.code === 1000 && e.reason === "archived") {
          setSt((s) => ({ ...s, archived: true }));
          return;
        }
        const delay = Math.min(5000, 250 * 2 ** retry++);
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearInterval(pingTimer);
      window.clearTimeout(reconnectTimer);
      ws.current?.close(1000, "leaving");
    };
  }, [id]);

  /** Play a move locally (optimistic) and send it. Returns the SAN or null if illegal locally. */
  const playMove = useCallback(
    (uci: string): string | null => {
      const s = stRef.current;
      const g = s.g;
      if (!g || g.status !== "started" || !g.you || turnOf(g.moves.length) !== g.you) return null;
      const chess = new Chess(g.fen);
      let san: string;
      try {
        san = chess.move(uciToMove(uci)).san;
      } catch {
        return null;
      }
      const ply = g.moves.length;
      const now = performance.now();
      const myClock = clockValue(s.anchor, g.you, now);
      const clocks = { ...(s.anchor?.clocks ?? g.clocks), [g.you]: myClock + (ply >= 2 ? g.inc * 1000 : 0) };
      const running = ply + 1 >= 2;
      const next = {
        ...s,
        g: { ...g, moves: [...g.moves, uci], sans: [...g.sans, san], fen: chess.fen(), drawOffer: g.drawOffer === g.you ? g.drawOffer : null },
        anchor: { clocks, at: now, running, turn: turnOf(ply + 1) },
        firstMoveDeadline: ply + 1 < 2 ? now + firstMoveMs(g) : null,
      };
      stRef.current = next;
      setSt(next);
      playMoveSound(san);
      send({ t: "move", u: uci, ply });
      return san;
    },
    [send],
  );

  const clearError = useCallback(() => setSt((s) => ({ ...s, error: null })), []);

  return { ...st, send, playMove, clearError };
}

