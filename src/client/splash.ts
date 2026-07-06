import { context, requestExpandedMode } from '@devvit/web/client';
import type { StateResponse } from '../shared/api';

const startButton = document.getElementById('start-button') as HTMLButtonElement;
const greeting = document.getElementById('greeting') as HTMLParagraphElement;
const countdownEl = document.getElementById('countdown') as HTMLSpanElement;
const floorEl = document.getElementById('floor') as HTMLElement;

startButton.addEventListener('click', (e) => {
  requestExpandedMode(e, 'game');
});

greeting.textContent = context?.username ? `Welcome back, ${context.username}.` : '';

function fmt(ms: number): string {
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

let quakeDeadline = 0; // local, skew-corrected
let refetching = false;

async function loadState(): Promise<void> {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) return;
    const data = (await res.json()) as StateResponse;
    quakeDeadline = Date.now() + Math.max(0, data.state.nextQuakeAt - data.state.serverNow);
    floorEl.textContent = String(data.state.height);
  } catch {
    /* preview stays static if the fetch fails */
  }
}

setInterval(() => {
  if (!quakeDeadline) return;
  const remaining = quakeDeadline - Date.now();
  if (remaining > 0) {
    countdownEl.textContent = fmt(remaining);
    return;
  }
  // Hit zero: the quake is resolving server-side. Show it, then re-poll for the
  // next scheduled time instead of freezing at 0:00.
  countdownEl.textContent = 'NOW';
  if (!refetching) {
    refetching = true;
    void loadState().finally(() => {
      refetching = false;
    });
  }
}, 1000);

void loadState();
