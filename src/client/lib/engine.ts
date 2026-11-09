/**
 * Stockfish 19 (lite, single-threaded WASM) in a Web Worker. One search at a time:
 * a new request stops the previous one and waits for its `bestmove` before starting.
 */
type Listener = (line: string) => void;

export interface EngineInfo {
  depth: number;
  /** Centipawns from White's point of view, or null when mate is reported. */
  cp: number | null;
  /** Mate in N from White's point of view (negative: Black mates). */
  mate: number | null;
  pv: string[];
}

export class Engine {
  private worker: Worker;
  private listeners = new Set<Listener>();
  private ready: Promise<void>;
  private searching: Promise<void> = Promise.resolve();
  private stopCurrent: (() => void) | null = null;

  constructor() {
    this.worker = new Worker("/engine/stockfish-19-lite-single.js");
    this.worker.onmessage = (e: MessageEvent) => {
      const line = typeof e.data === "string" ? e.data : String(e.data);
      this.listeners.forEach((l) => l(line));
    };
    this.ready = this.until("uciok", () => this.send("uci")).then(() => this.isReady());
  }

  private send(cmd: string) {
    this.worker.postMessage(cmd);
  }

  private until(prefix: string, start: () => void, onLine?: Listener): Promise<string> {
    return new Promise((resolve) => {
      const l: Listener = (line) => {
        onLine?.(line);
        if (line.startsWith(prefix)) {
          this.listeners.delete(l);
          resolve(line);
        }
      };
      this.listeners.add(l);
      start();
    });
  }

  private async isReady() {
    await this.until("readyok", () => this.send("isready"));
  }

  async setOption(name: string, value: string | number) {
    await this.ready;
    this.send(`setoption name ${name} value ${value}`);
    await this.isReady();
  }

  async newGame() {
    await this.ready;
    this.stop();
    await this.searching;
    this.send("ucinewgame");
    await this.isReady();
  }

  stop() {
    this.stopCurrent?.();
  }

  /** Runs `go <params>` on the position and resolves with the best move (UCI) or null. */
  async go(position: { fen?: string; moves: string[] }, params: string, onInfo?: (i: EngineInfo) => void): Promise<string | null> {
    await this.ready;
    this.stop();
    await this.searching;
    const startsWhite = position.fen ? position.fen.split(" ")[1] === "w" : true;
    const whiteToMove = (position.moves.length % 2 === 0) === startsWhite;
    let release!: () => void;
    this.searching = new Promise((r) => (release = r));
    this.send(`position ${position.fen ? `fen ${position.fen}` : "startpos"}${position.moves.length ? ` moves ${position.moves.join(" ")}` : ""}`);
    this.stopCurrent = () => this.send("stop");
    const line = await this.until("bestmove", () => this.send(`go ${params}`), (l) => {
      if (onInfo && l.startsWith("info") && l.includes(" pv ")) {
        const info = parseInfo(l, whiteToMove);
        if (info) onInfo(info);
      }
    });
    this.stopCurrent = null;
    release();
    const best = line.split(" ")[1];
    return best && best !== "(none)" ? best : null;
  }

  destroy() {
    this.worker.terminate();
    this.listeners.clear();
  }
}

function parseInfo(line: string, whiteToMove: boolean): EngineInfo | null {
  if (line.includes("multipv") && !line.includes("multipv 1 ")) return null;
  const t = line.split(" ");
  const depth = Number(t[t.indexOf("depth") + 1]);
  const si = t.indexOf("score");
  if (si < 0) return null;
  const kind = t[si + 1];
  const val = Number(t[si + 2]);
  const sign = whiteToMove ? 1 : -1;
  const pv = t.slice(t.indexOf("pv") + 1);
  return { depth, cp: kind === "cp" ? val * sign : null, mate: kind === "mate" ? val * sign : null, pv };
}

/** Strength presets for the "play the computer" mode. */
export const BOT_LEVELS = [
  { level: 1, skill: 0, depth: 1, ms: 50, label: "≈800" },
  { level: 2, skill: 3, depth: 2, ms: 100, label: "≈1100" },
  { level: 3, skill: 6, depth: 4, ms: 150, label: "≈1400" },
  { level: 4, skill: 9, depth: 6, ms: 200, label: "≈1700" },
  { level: 5, skill: 12, depth: 8, ms: 300, label: "≈2000" },
  { level: 6, skill: 15, depth: 11, ms: 400, label: "≈2300" },
  { level: 7, skill: 18, depth: 14, ms: 500, label: "≈2600" },
  { level: 8, skill: 20, depth: 22, ms: 800, label: "max" },
] as const;
