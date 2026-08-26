/**
 * Terminal audio: short, quiet, synthesized in code.
 *
 * No samples, no files — every sound is an oscillator with an envelope, which
 * keeps the whole engine smaller than any audio asset would be. Browsers
 * refuse audio before the first user gesture, so the context is created
 * lazily on first use and never logs a complaint before that.
 *
 * One master gain (0.35) scales everything; the mute switch persists in
 * localStorage and defaults to on-at-low-volume.
 */

const KEY = "launchpad.sound";
const MASTER_GAIN = 0.35;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = (() => {
  try {
    return localStorage.getItem(KEY) === "off";
  } catch {
    return false;
  }
})();

export function soundEnabled(): boolean {
  return !muted;
}

export function setSoundEnabled(on: boolean): void {
  muted = !on;
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Not being able to remember the preference is survivable.
  }
}

/** Create the context — only ever inside a user-gesture call stack. */
function ensure(): AudioContext | null {
  if (muted) return null;
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as never as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = MASTER_GAIN;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** One enveloped tone. Times in seconds relative to now. */
function tone(
  freq: number,
  opts: { at?: number; dur?: number; gain?: number; type?: OscillatorType } = {},
): void {
  const c = ensure();
  if (!c || !master) return;
  const { at = 0, dur = 0.05, gain = 0.5, type = "square" } = opts;
  const t0 = c.currentTime + at;
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(gain, t0 + 0.004);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(env);
  env.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** UI click: a 2ms tick, barely there. */
export function sndClick(): void {
  tone(2000, { dur: 0.015, gain: 0.12, type: "square" });
}

/** Transaction sent: two notes, upward. */
export function sndTxSubmitted(): void {
  tone(660, { dur: 0.07, gain: 0.35, type: "triangle" });
  tone(990, { at: 0.08, dur: 0.09, gain: 0.35, type: "triangle" });
}

/** Transaction confirmed: a soft dual-tone register, still subtle. */
export function sndTxConfirmed(): void {
  tone(880, { dur: 0.12, gain: 0.3, type: "sine" });
  tone(1320, { dur: 0.28, gain: 0.22, type: "sine" });
  tone(1760, { at: 0.1, dur: 0.25, gain: 0.12, type: "sine" });
}

/** Failure: one short low buzz. */
export function sndTxFailed(): void {
  tone(140, { dur: 0.14, gain: 0.4, type: "sawtooth" });
}

/** New mint in the feed — fires often, so ~-30dB and at most once a second. */
let lastFeedTick = 0;
export function sndFeedTick(): void {
  const now = Date.now();
  if (now - lastFeedTick < 1000) return;
  lastFeedTick = now;
  tone(1500, { dur: 0.012, gain: 0.03, type: "square" });
}

/**
 * The global click hook: one capture-phase listener plays the UI tick for any
 * button press, which covers every tab and control without touching them.
 * Capture also makes this the user gesture that unlocks the context.
 */
export function installClickSound(): () => void {
  const onClick = (e: MouseEvent) => {
    const el = e.target as Element | null;
    if (el?.closest?.("button, [role='button'], select, input[type='checkbox']")) sndClick();
  };
  document.addEventListener("click", onClick, { capture: true });
  return () => document.removeEventListener("click", onClick, { capture: true });
}
