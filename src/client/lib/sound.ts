/** Synthesised sounds (no audio assets): short, distinct, and cheap enough for bullet. */
import { getPrefs } from "./prefs";

let ctx: AudioContext | null = null;
function ac(): AudioContext | null {
  if (!getPrefs().sound) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Browsers only allow audio after a user gesture; call this from one. */
export function unlockAudio() {
  ac();
}

function noiseBurst(c: AudioContext, at: number, dur: number, freq: number, gain: number) {
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = freq;
  bp.Q.value = 1.2;
  const g = c.createGain();
  g.gain.value = gain * getPrefs().volume;
  src.connect(bp).connect(g).connect(c.destination);
  src.start(at);
}

function tone(c: AudioContext, at: number, dur: number, freq: number, gain: number, type: OscillatorType = "sine") {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain * getPrefs().volume, at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(c.destination);
  o.start(at);
  o.stop(at + dur + 0.02);
}

export const sound = {
  move() {
    const c = ac();
    if (c) noiseBurst(c, c.currentTime, 0.05, 1800, 0.9);
  },
  capture() {
    const c = ac();
    if (!c) return;
    noiseBurst(c, c.currentTime, 0.06, 1100, 1.1);
    noiseBurst(c, c.currentTime + 0.035, 0.05, 2400, 0.6);
  },
  check() {
    const c = ac();
    if (!c) return;
    noiseBurst(c, c.currentTime, 0.05, 1800, 0.9);
    tone(c, c.currentTime, 0.12, 880, 0.12, "triangle");
  },
  start() {
    const c = ac();
    if (!c) return;
    tone(c, c.currentTime, 0.12, 660, 0.15, "triangle");
    tone(c, c.currentTime + 0.1, 0.18, 990, 0.15, "triangle");
  },
  end() {
    const c = ac();
    if (!c) return;
    tone(c, c.currentTime, 0.18, 784, 0.14, "triangle");
    tone(c, c.currentTime + 0.12, 0.25, 523, 0.14, "triangle");
  },
  lowTime() {
    const c = ac();
    if (c) tone(c, c.currentTime, 0.07, 1320, 0.08, "square");
  },
  notify() {
    const c = ac();
    if (c) tone(c, c.currentTime, 0.15, 1046, 0.12, "sine");
  },
};

export function playMoveSound(san: string) {
  if (san.includes("#") || san.includes("+")) sound.check();
  else if (san.includes("x")) sound.capture();
  else sound.move();
}
