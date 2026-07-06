import type { BlockType } from '../shared/model';
import { BLOCK_STATS } from '../shared/model';
import type { PublicState, LeaderboardResponse, QuakeReport, Stake } from '../shared/api';
import { sfx } from './audio';

const $ = (id: string) => document.getElementById(id);

function fmtCountdown(ms: number): string {
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export class Hud {
  private credits = 0;
  private quakeDeadline = 0; // client-clock timestamp, corrected for server skew
  private onSelect: (t: BlockType) => void = () => {};
  private prevCredits = -1;
  private prevScore = -1;
  private prevFloor = -1;

  bind(onSelect: (t: BlockType) => void): void {
    this.onSelect = onSelect;

    (['beam', 'block', 'pillar'] as BlockType[]).forEach((t) => {
      $(`tool-${t}`)?.addEventListener('click', () => {
        if (this.credits < BLOCK_STATS[t].cost) {
          this.toast('Not enough credits — survive a quake to earn more', 'warn');
          return;
        }
        this.onSelect(t);
      });
    });

    // Survivors sheet
    $('lb-open')?.addEventListener('click', () => $('lb-sheet')?.classList.add('show'));
    $('lb-close')?.addEventListener('click', () => $('lb-sheet')?.classList.remove('show'));
    $('lb-sheet')?.addEventListener('click', (e) => {
      if (e.target === $('lb-sheet')) $('lb-sheet')?.classList.remove('show');
    });

    // Help / onboarding — the initial show is decided by the server (once/day per
    // user); the Help button always re-opens it on demand.
    $('help-btn')?.addEventListener('click', () => $('onboard')?.classList.add('show'));
    $('onboard-close')?.addEventListener('click', () => $('onboard')?.classList.remove('show'));

    // Sound toggle
    $('mute-btn')?.addEventListener('click', () => {
      const muted = !sfx.isMuted();
      sfx.setMuted(muted);
      const b = $('mute-btn');
      if (b) b.textContent = muted ? '🔇' : '🔊';
    });

    $('report-close')?.addEventListener('click', () => $('report')?.classList.remove('show'));

    // Keyboard shortcuts: A / S / D (or 1 / 2 / 3) to pick a shape fast (desktop)
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      let btn: HTMLElement | null = null;
      if (k === 'a' || k === '1') btn = $('tool-beam');
      else if (k === 's' || k === '2') btn = $('tool-block');
      else if (k === 'd' || k === '3') btn = $('tool-pillar');
      if (btn) {
        btn.click();
        btn.blur(); // don't leave the button focused/highlighted
      }
    });

    // Live countdown + imminent-quake alert
    setInterval(() => {
      const ms = this.quakeDeadline - Date.now();
      const el = $('countdown');
      if (el && this.quakeDeadline) el.textContent = fmtCountdown(ms);
      $('quake-clock')?.classList.toggle('imminent', this.quakeDeadline > 0 && ms > 0 && ms < 15000);
    }, 1000);
  }

  showOnboarding(): void {
    $('onboard')?.classList.add('show');
  }

  setSelected(type: BlockType | null): void {
    (['beam', 'block', 'pillar'] as BlockType[]).forEach((t) =>
      $(`tool-${t}`)?.classList.toggle('active', t === type)
    );
  }

  setPlayer(credits: number, streak: number, score: number): void {
    this.credits = credits;
    // motion-graphics: float the deltas (skip the very first call on load)
    if (this.prevCredits >= 0 && credits !== this.prevCredits) {
      const d = credits - this.prevCredits;
      this.floatFx(`${d > 0 ? '+' : ''}${d}💎`, 'credits', d > 0 ? 'gain' : 'loss');
    }
    if (this.prevScore >= 0 && score > this.prevScore) {
      this.floatFx(`+${score - this.prevScore}★`, 'score', 'gain');
      sfx.coin();
    }
    this.prevCredits = credits;
    this.prevScore = score;

    const c = $('credits');
    if (c) c.textContent = String(credits);
    const s = $('streak');
    if (s) s.textContent = String(streak);
    const sc = $('score');
    if (sc) sc.textContent = String(score);
    (['beam', 'block', 'pillar'] as BlockType[]).forEach((t) =>
      $(`tool-${t}`)?.classList.toggle('locked', credits < BLOCK_STATS[t].cost)
    );
  }

  /** Spawn a floating +N / −N near a HUD element. */
  private floatFx(text: string, anchorId: string, kind: 'gain' | 'loss'): void {
    const anchor = $(anchorId);
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = `floatfx ${kind}`;
    el.textContent = text;
    el.style.left = `${r.left + r.width / 2}px`;
    el.style.top = `${r.top - 6}px`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1000);
  }

  setState(state: PublicState): void {
    // convert the server's absolute quake time into a local deadline (skew-free)
    this.quakeDeadline = Date.now() + Math.max(0, state.nextQuakeAt - state.serverNow);
    const floor = $('floor');
    if (floor) floor.textContent = String(state.height);
    // float the floor drop when a quake/collapse knocks blocks down
    if (this.prevFloor >= 0 && state.height < this.prevFloor) {
      this.floatFx(`${state.height - this.prevFloor}`, 'floor', 'loss');
    }
    this.prevFloor = state.height;

    const epoch = $('epoch');
    if (epoch) epoch.textContent = `Tower #${state.epoch}`;
    const rec = $('epoch-rec');
    if (rec) rec.textContent = `record ${state.epochPeak}`;

    const fill = $('inst-fill');
    if (fill) {
      fill.style.width = `${state.instability}%`;
      fill.dataset.level = state.instability > 78 ? 'crit' : state.instability > 45 ? 'warn' : 'ok';
    }
    const pct = $('inst-pct');
    if (pct) pct.textContent = `${state.instability}%`;

    const cd = $('countdown');
    if (cd) cd.textContent = fmtCountdown(this.quakeDeadline - Date.now());
  }

  setStake(stake: Stake): void {
    const bar = $('stake-bar');
    if (!bar) return;
    if (stake.blocks <= 0) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    const pts = $('stake-pts');
    if (pts) pts.textContent = String(stake.pts);
    const blocks = $('stake-blocks');
    if (blocks) blocks.textContent = String(stake.blocks);
  }

  setLeaderboard(lb: LeaderboardResponse, you: string): void {
    const list = $('lb-list');
    const medals = ['①', '②', '③'];
    if (list) {
      list.innerHTML =
        lb.entries.length === 0
          ? '<li class="lb-empty">No survivors yet — be the first.</li>'
          : lb.entries
              .map((e) => {
                const mark = medals[e.rank - 1] ?? String(e.rank);
                const me = e.username === you ? ' me' : '';
                return `<li class="lb-row${me}"><span class="lb-rank">${mark}</span><span class="lb-name">${escapeHtml(
                  e.username
                )}</span><span class="lb-score">${e.score}</span></li>`;
              })
              .join('');
    }
    const total = $('lb-total');
    if (total) total.textContent = `${lb.totalBlocks} blocks standing`;
    const mini = $('lb-mini');
    if (mini) mini.textContent = lb.you && lb.you.rank > 0 ? `#${lb.you.rank}` : String(lb.entries.length);
  }

  showReport(r: QuakeReport): void {
    const set = (id: string, v: string) => {
      const el = $(id);
      if (el) el.textContent = v;
    };
    set('rp-quakes', String(r.quakesMissed));
    set('rp-standing', String(r.standingNow));
    set('rp-lost', String(r.lostSinceSeen));
    set('rp-earned', `+${r.earnedSinceSeen}`);
    const verdict = $('rp-verdict');
    if (verdict) {
      verdict.textContent =
        r.lostSinceSeen === 0
          ? r.standingNow > 0
            ? 'Your tower held. 🟢'
            : 'The dust has settled.'
          : `You lost ${r.lostSinceSeen} block${r.lostSinceSeen === 1 ? '' : 's'}.`;
    }
    $('report')?.classList.add('show');
  }

  private lastToast = { msg: '', at: 0 };

  toast(msg: string, kind: 'ok' | 'warn' | 'quake' | 'tremor' = 'ok'): void {
    const wrap = $('toasts');
    if (!wrap) return;
    const now = Date.now();
    if (msg === this.lastToast.msg && now - this.lastToast.at < 1600) return;
    this.lastToast = { msg, at: now };
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3100);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );
}
