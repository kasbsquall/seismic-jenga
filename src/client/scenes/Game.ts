import { Scene } from 'phaser';
import * as Phaser from 'phaser';
import { api } from '../net';
import { sfx } from '../audio';
import type { Hud } from '../hud';
import type { PublicState, QuakeSummary } from '../../shared/api';
import type { Block, BlockType } from '../../shared/model';
import {
  BLOCK_W,
  BLOCK_H,
  BLOCK_STATS,
  blockW,
  clampPlacement,
  instabilityPct,
  toRichter,
  isFoundation,
} from '../../shared/model';

// Arcade Brut: material = fill, thick black outline. Ownership = accent halo (added separately).
const TYPE_STYLE: Record<BlockType, { fill: number; text: string }> = {
  beam: { fill: 0xffb43d, text: '#000000' },
  block: { fill: 0x3d7bff, text: '#ffffff' },
  pillar: { fill: 0xff3d8b, text: '#ffffff' },
};
const STROKE = 0x000000;
const ACCENT = 0xffd23d; // "you" halo + ghost
const GROUND = 0xffffff;
const QUAKE_MS = 5000; // full cinematic quake duration (shake + staggered collapse + pan)

type Sprite = { block: Block; c: Phaser.GameObjects.Container; mine: boolean };

export class Game extends Scene {
  private hud!: Hud;
  private username = '';
  private credits = 0;
  private streak = 0;
  private score = 0;
  private tower: Block[] = [];
  private sprites = new Map<string, Sprite>();
  private lastQuakeId = 0;
  private prevHeight = 0;
  private prevEpoch = 0;
  private lastInstability = 0;
  private nextQuakeAt = 0;
  private quakeUntil = 0;
  private quakeMag = 0;
  private lastTremorAt = 0;
  private tremorUntil = 0;
  private selected: BlockType | null = null;
  private aiming = false; // dragging the ghost before release-to-drop
  private aimVx = 0; // virtual x the ghost is currently aimed at

  private sky!: Phaser.GameObjects.Graphics;
  private starsC!: Phaser.GameObjects.Container;
  private cityG!: Phaser.GameObjects.Graphics;
  private cityLights!: Phaser.GameObjects.Graphics;
  private buildings: { x: number; w: number; h: number }[] = [];
  private windows: { x: number; up: number }[] = [];
  private worldLayer!: Phaser.GameObjects.Container;
  private towerLayer!: Phaser.GameObjects.Container;
  private ground!: Phaser.GameObjects.Graphics;
  private ghost!: Phaser.GameObjects.Container;
  private ghostG!: Phaser.GameObjects.Graphics;
  private ghostLabel!: Phaser.GameObjects.Text;

  // drag detection
  private downY = 0;

  private u = 1.4;
  private centerX = 0;
  private groundY = 0;
  private ceilingY = 0;
  private rowH = 0;
  private anchorX = 0;

  // vertical scroll of the world (ground + city + tower move together)
  private autoScroll = 0;
  private userScroll = 0;
  private dragLastY = 0;
  private dragging = false;
  private pointerDown = false;
  private scrollHinted = false;

  constructor() {
    super('Game');
  }

  create(): void {
    this.hud = this.registry.get('hud') as Hud;
    this.hud.bind((t) => this.select(t));

    // "cinema" mode (?cinema=1): hide all UI for recording a clean splash video
    if (new URLSearchParams(window.location.search).has('cinema')) {
      for (const id of ['ui', 'toasts', 'onboard', 'report']) {
        document.getElementById(id)?.style.setProperty('display', 'none');
      }
    }

    this.sky = this.add.graphics().setDepth(-20);
    this.starsC = this.add.container(0, 0).setDepth(-18).setAlpha(0);

    // The "world" (city + ground + tower) scrolls vertically as one so the
    // ground line and city skyline always stay aligned.
    this.worldLayer = this.add.container(0, 0).setDepth(0);
    this.cityG = this.add.graphics();
    this.cityLights = this.add.graphics();
    this.ground = this.add.graphics();
    this.towerLayer = this.add.container(0, 0);
    this.worldLayer.add([this.cityG, this.cityLights, this.ground, this.towerLayer]);

    this.buildStars();
    this.buildCity();
    this.updateAtmosphere(0);
    this.cityLights.setAlpha(0.55);
    this.tweens.add({
      targets: this.cityLights,
      alpha: 0.32,
      duration: 2600,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.inOut',
    });

    this.ghost = this.add.container(0, 0).setDepth(8).setVisible(false);
    this.ghostG = this.add.graphics();
    this.ghostLabel = this.add
      .text(0, 0, '', {
        fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
        fontSize: '13px',
        fontStyle: 'bold',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1);
    this.ghost.add([this.ghostG, this.ghostLabel]);

    this.computeLayout();
    this.scale.on('resize', () => {
      this.computeLayout();
      this.buildStars();
      this.buildCity();
      this.updateAtmosphere(this.prevHeight);
      this.renderPositions(false);
    });

    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (this.selected) this.moveGhost(p.x);
      else if (this.pointerDown || p.isDown) this.onDrag(p.y);
    });
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      sfx.unlock(); // audio must start from a user gesture
      this.pointerDown = true;
      this.downY = p.y;
      this.dragLastY = p.y;
      this.dragging = false;
      this.onPointerDown(p);
    });
    this.input.on('pointerup', () => {
      this.pointerDown = false;
      this.onPointerUp();
    });
    // desktop: mouse wheel scrolls the tower (DOM listener is reliable in the iframe)
    document.getElementById('game-container')?.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        if (this.autoScroll <= 0) return;
        e.preventDefault();
        this.userScroll -= e.deltaY * 0.45;
        this.applyScroll();
      },
      { passive: false }
    );

    // "Back to build zone" pill
    document.getElementById('build-pill')?.addEventListener('click', () => this.scrollHome());

    void this.boot();
    this.time.addEvent({ delay: 3000, loop: true, callback: () => void this.poll() });
    this.time.addEvent({ delay: 9000, loop: true, callback: () => void this.refreshLeaderboard() });
    // credit trickle for actively watching the tower (only while the tab is visible)
    this.time.addEvent({ delay: 12000, loop: true, callback: () => void this.tickWatch() });
    // near the deadline, poll fast so the quake lands right when the clock hits 0
    this.time.addEvent({
      delay: 600,
      loop: true,
      callback: () => {
        const ms = this.nextQuakeAt - Date.now();
        if (ms < 3500 && ms > -8000) void this.poll();
      },
    });
  }

  // ─── networking ─────────────────────────────────────────────────────────────
  private async boot(): Promise<void> {
    const res = await api.init();
    if (!res) {
      this.hud.toast('Connection lost — retrying…', 'warn');
      this.time.delayedCall(2000, () => void this.boot());
      return;
    }
    this.username = res.username;
    this.credits = res.credits;
    this.streak = res.streak;
    this.score = res.score;
    this.prevEpoch = res.state.epoch;
    this.prevHeight = res.state.height;
    this.lastQuakeId = res.state.quakeId;
    this.hud.setPlayer(res.credits, res.streak, res.score);
    this.hud.setStake(res.stake);
    if (res.dailyBonus > 0)
      this.hud.toast(`Daily streak ×${res.streak} — +${res.dailyBonus} 💎`, 'ok');
    if (res.bestFloor > 0)
      this.time.delayedCall(1400, () => this.hud.toast(`🗼 Your best: floor ${res.bestFloor} — beat it!`, 'ok'));
    this.applyState(res.state, false);
    if (res.showOnboard) this.hud.showOnboarding(); // server-gated: once/day per user
    if (res.report) this.time.delayedCall(600, () => this.hud.showReport(res.report!));
    void this.refreshLeaderboard();
  }

  private async poll(): Promise<void> {
    const res = await api.state();
    if (res) {
      this.hud.setStake(res.stake);
      this.applyState(res.state, true);
    }
  }

  /** Reward the player a small credit for actively watching (visible tab only). */
  private async tickWatch(): Promise<void> {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const r = await api.watch();
    if (r && r.granted > 0) {
      this.credits = r.credits;
      this.hud.setPlayer(r.credits, this.streak, this.score); // floats a +N💎 on the wallet
    }
  }

  private async refreshLeaderboard(): Promise<void> {
    const lb = await api.leaderboard();
    if (lb) {
      this.hud.setLeaderboard(lb, this.username);
      if (lb.you) {
        this.score = lb.you.score;
        this.hud.setPlayer(this.credits, this.streak, this.score);
      }
    }
  }

  // ─── state application ──────────────────────────────────────────────────────
  private applyState(state: PublicState, animate: boolean): void {
    this.hud.setState(state);
    this.updateAtmosphere(state.height);
    this.lastInstability = state.instability;
    // local, skew-corrected deadline (drives the pre-quake tremor timing)
    this.nextQuakeAt = Date.now() + Math.max(0, state.nextQuakeAt - state.serverNow);

    if (animate && this.prevEpoch > 0 && state.epoch > this.prevEpoch) {
      this.hud.toast(`🏗️ Tower #${state.epoch} begins — a fresh start!`, 'ok');
    }

    const quaked = animate && state.quakeId > this.lastQuakeId;
    const grew = state.height > this.prevHeight;
    const tremored =
      animate && !quaked && this.lastTremorAt > 0 && state.tremorAt > this.lastTremorAt;
    const surviving = new Set(state.tower.map((b) => b.id));
    const removed = [...this.sprites.keys()].filter((id) => !surviving.has(id));

    this.tower = state.tower;
    this.lastQuakeId = state.quakeId;
    this.lastTremorAt = state.tremorAt;
    this.prevEpoch = state.epoch;
    this.prevHeight = state.height;

    if (tremored) this.microTremor();

    // topmost blocks fall first → cascade from the top down
    const cascade = removed
      .map((id) => ({ id, y: this.sprites.get(id)?.c.y ?? 0 }))
      .sort((a, b) => a.y - b.y);

    if (quaked && state.lastQuake) {
      this.quakeFx(state.lastQuake);
      cascade.forEach((r, i) => this.tumble(r.id, i, 500)); // fall after the shake builds
    } else if (removed.length > 0 && !grew) {
      // a collapse (your over-lean, or another player's) — blocks topple
      this.dustBurst();
      sfx.collapse();
      cascade.forEach((r, i) => this.tumble(r.id, i));
    } else {
      removed.forEach((id) => this.destroySprite(id)); // scrolled below the view
    }

    // On a quake, ease the scroll so a tall tower's view pans down with the
    // collapse instead of snapping and leaving a mid-air gap.
    this.renderPositions(animate, quaked);
  }

  // ─── layout ─────────────────────────────────────────────────────────────────
  private computeLayout(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    // Scale to BOTH width and height so short viewports (Reddit embeds) fit more
    // blocks and short towers keep their base on screen without scrolling.
    this.u = Math.min(1.7, Math.max(0.9, Math.min(W / 250, H / 430)));
    this.centerX = W / 2;
    // Natural spacing — blocks touch edge-to-edge (slight overlap hides shadows).
    this.rowH = BLOCK_H * this.u * 0.96;
    this.measureBounds();
    this.towerLayer.setPosition(this.centerX, this.groundY);
  }

  /**
   * Pixel-perfect play band: the ceiling sits just below the top HUD (with room
   * for the ghost) and the floor just above the bottom HUD (wallet/dock), both
   * measured from the DOM so blocks never overlap the UI on any viewport and it
   * adapts as the "at stake" bar shows/hides.
   */
  private measureBounds(): void {
    const canvas = this.game.canvas;
    const cr = canvas ? canvas.getBoundingClientRect() : null;
    const sf = cr && cr.height > 0 ? this.scale.height / cr.height : 1;
    const toY = (clientY: number): number => (cr ? (clientY - cr.top) * sf : clientY);

    let ceil = this.scale.height * 0.14;
    const sr = document.querySelector('.hud-strip')?.getBoundingClientRect();
    if (cr && sr && sr.height > 0) ceil = toY(sr.bottom); // ignore a hidden HUD (cinema mode)
    this.ceilingY = ceil + this.rowH * 0.7 + 6;

    let floor = this.scale.height * 0.86;
    const wr = document.querySelector('.wallet')?.getBoundingClientRect();
    if (cr && wr && wr.height > 0) floor = toY(wr.top) - 4;
    this.groundY = Math.max(this.ceilingY + this.rowH * 2, floor);
  }

  /** Hide blocks outside the play band (both edges) so none show behind the HUD. */
  private cullBlocks(): void {
    const top = this.ceilingY - this.rowH * 0.5;
    const bot = this.groundY - this.rowH * 0.5;
    for (const sp of this.sprites.values()) {
      const sy = this.worldLayer.y + this.groundY + sp.c.y;
      sp.c.setVisible(sy >= top && sy <= bot);
    }
  }

  /** Position the world so the build zone (tower top) is on screen; clamp drag.
   *  `smooth` eases the scroll (used during a quake so a tall tower's view pans
   *  down to follow the collapse instead of snapping and leaving a gap). */
  private applyScroll(smooth = false): void {
    // During a quake the collapse owns the camera (a slow pan). A routine poll must
    // not snap the scroll mid-fall — that caused the collapse to "jump".
    if (!smooth && this.time.now < this.quakeUntil) return;
    const n = this.tower.length;
    const topAt0 = this.groundY - (n - 0.5) * this.rowH; // top block screenY at scroll 0
    // keep a full block of clear headroom below the HUD so the top block + the
    // ghost above it are always fully visible when the tower is tall.
    this.autoScroll = Math.max(0, this.ceilingY + this.rowH * 1.2 - topAt0);
    this.userScroll = Phaser.Math.Clamp(this.userScroll, -this.autoScroll, 0);
    const target = this.autoScroll + this.userScroll;
    this.tweens.killTweensOf(this.worldLayer);
    if (smooth && Math.abs(this.worldLayer.y - target) > this.rowH) {
      // pan the camera down slowly, tracking the top-down collapse block by block
      this.tweens.add({
        targets: this.worldLayer,
        y: target,
        duration: 3200,
        delay: 600,
        ease: 'Sine.inOut',
      });
    } else {
      this.worldLayer.y = target;
    }
    const pill = document.getElementById('build-pill');
    if (pill) pill.hidden = this.userScroll > -15;
    this.updateScrollRail();
    this.cullBlocks();
    if (this.autoScroll > this.rowH * 2 && !this.scrollHinted) {
      this.scrollHinted = true;
      this.hud.toast('↕ Drag or scroll to explore the tower', 'ok');
    }
  }

  /** Right-side scroll indicator — shows there's more tower and where you are. */
  private updateScrollRail(): void {
    const rail = document.getElementById('scroll-rail');
    const thumb = document.getElementById('scroll-thumb');
    if (!rail || !thumb) return;
    if (this.autoScroll < this.rowH) {
      rail.hidden = true;
      return;
    }
    rail.hidden = false;
    // total scrollable content vs the window; thumb fraction ≈ window / total
    const total = this.autoScroll + (this.groundY - this.ceilingY);
    const win = this.groundY - this.ceilingY;
    const thumbH = Math.max(14, (win / total) * 100);
    // userScroll 0 = viewing top → thumb at top; -autoScroll = base → thumb bottom
    const pos = (-this.userScroll / this.autoScroll) * (100 - thumbH);
    thumb.style.height = `${thumbH}%`;
    thumb.style.top = `${pos}%`;
  }

  private onDrag(y: number): void {
    if (this.autoScroll <= 0) return; // nothing to scroll
    const dy = y - this.dragLastY;
    if (!this.dragging && Math.abs(y - this.downY) < 8) return; // ignore micro-moves
    this.dragging = true;
    this.dragLastY = y;
    this.userScroll += dy;
    this.applyScroll();
  }

  private scrollHome(): void {
    this.tweens.add({
      targets: this,
      userScroll: 0,
      duration: 260,
      ease: 'Cubic.out',
      onUpdate: () => this.applyScroll(),
    });
  }

  // ─── atmosphere (climb toward space, keyed to floor count) ───────────────────
  private static SKY_STOPS: { a: number; top: number; bot: number }[] = [
    { a: 0.0, top: 0x241f2b, bot: 0x17171b },
    { a: 0.4, top: 0x2a1a3a, bot: 0x181322 },
    { a: 0.7, top: 0x0e1430, bot: 0x0a0e22 },
    { a: 1.0, top: 0x05060d, bot: 0x02030a },
  ];

  private lerpHex(a: number, b: number, t: number): number {
    const ar = (a >> 16) & 255,
      ag = (a >> 8) & 255,
      ab = a & 255;
    const br = (b >> 16) & 255,
      bg = (b >> 8) & 255,
      bb = b & 255;
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const bl = Math.round(ab + (bb - ab) * t);
    return (r << 16) | (g << 8) | bl;
  }

  private buildStars(): void {
    this.starsC.removeAll(true);
    const W = this.scale.width;
    const H = this.scale.height;
    for (let i = 0; i < 55; i++) {
      const x = Math.random() * W;
      const y = Math.random() * H * 0.8;
      const r = Math.random() < 0.2 ? 1.8 : 1;
      const dot = this.add.circle(x, y, r, 0xffffff, 0.9);
      this.starsC.add(dot);
      if (Math.random() < 0.25) {
        this.tweens.add({
          targets: dot,
          alpha: 0.2,
          duration: 900 + Math.random() * 1500,
          yoyo: true,
          repeat: -1,
        });
      }
    }
  }

  private buildCity(): void {
    // generate the skyline layout + lit windows ONCE (stable), redrawn at the
    // current groundY each frame. A gentle global alpha "breathe" gives it life.
    const W = this.scale.width;
    const baseY = this.groundY;
    this.buildings = [];
    let x = -10;
    while (x < W + 10) {
      const bw = 26 + Math.random() * 40;
      const bh = 40 + Math.random() * 130;
      this.buildings.push({ x, w: bw, h: bh });
      x += bw + 3 + Math.random() * 7;
    }
    this.windows = [];
    for (const b of this.buildings) {
      for (let wy = baseY - b.h + 8; wy < baseY - 8; wy += 13) {
        for (let wx = b.x + 5; wx < b.x + b.w - 6; wx += 11) {
          if (Math.random() < 0.28) this.windows.push({ x: wx, up: baseY - wy });
        }
      }
    }
    this.drawCity();
  }

  private drawCity(): void {
    const baseY = this.groundY;
    const g = this.cityG;
    g.clear();
    for (const b of this.buildings) {
      g.fillStyle(0x0b0b18, 1); // dark navy — reads as a distant skyline
      g.fillRect(b.x, baseY - b.h, b.w, b.h);
      g.lineStyle(1, 0x1a1a2e, 1);
      g.strokeRect(b.x, baseY - b.h, b.w, b.h);
    }
    this.drawCityLights();
  }

  /** Draw the (stable) lit windows; overall brightness breathes via cityLights.alpha. */
  private drawCityLights(): void {
    const g = this.cityLights;
    g.clear();
    g.fillStyle(0xffb43d, 1);
    for (const w of this.windows) g.fillRect(w.x, this.groundY - w.up, 4, 5);
  }

  private updateAtmosphere(height: number): void {
    const alt = Math.min(1, height / 60);
    const stops = Game.SKY_STOPS;
    let s = stops[0]!;
    let e = stops[stops.length - 1]!;
    for (let i = 0; i < stops.length - 1; i++) {
      if (alt >= stops[i]!.a && alt <= stops[i + 1]!.a) {
        s = stops[i]!;
        e = stops[i + 1]!;
        break;
      }
    }
    const t = e.a === s.a ? 0 : (alt - s.a) / (e.a - s.a);
    const top = this.lerpHex(s.top, e.top, t);
    const bot = this.lerpHex(s.bot, e.bot, t);

    const W = this.scale.width;
    const H = this.scale.height;
    const bands = 10;
    this.sky.clear();
    for (let i = 0; i < bands; i++) {
      this.sky.fillStyle(this.lerpHex(top, bot, i / (bands - 1)), 1);
      this.sky.fillRect(0, (H * i) / bands, W, H / bands + 1);
    }
    this.starsC.setAlpha(Math.max(0, (alt - 0.4) / 0.6));
  }

  private drawGround(): void {
    const W = this.scale.width;
    const g = this.ground;
    g.clear();
    // ground/street: a filled slab below the line so it reads as solid earth
    g.fillStyle(0x05050a, 1);
    g.fillRect(0, this.groundY, W, this.scale.height);
    const pedW = (BLOCK_W * BLOCK_STATS.beam.widthMul + 20) * this.u; // fits the wide bedrock beam
    g.fillStyle(0x14141f, 1);
    g.fillRect(this.centerX - pedW / 2, this.groundY, pedW, 12);
    g.lineStyle(2, GROUND, 0.55);
    g.lineBetween(0, this.groundY, W, this.groundY);
  }

  // ─── rendering ──────────────────────────────────────────────────────────────
  private renderPositions(animateNew: boolean, smoothScroll = false): void {
    this.measureBounds();
    this.towerLayer.setPosition(this.centerX, this.groundY);
    this.drawGround();
    this.drawCity();
    this.anchorX = this.tower.length
      ? this.tower.reduce((s, b) => s + b.x, 0) / this.tower.length
      : 0;

    this.tower.forEach((b, i) => {
      const x = (b.x - this.anchorX) * this.u;
      const y = -(i + 0.5) * this.rowH;
      let sp = this.sprites.get(b.id);

      // recreate if reinforcement state changed (needs a new look)
      if (sp && sp.block.r !== b.r) {
        sp.c.destroy();
        this.sprites.delete(b.id);
        sp = undefined;
      }

      if (!sp) {
        sp = this.makeBlock(b);
        this.sprites.set(b.id, sp);
        if (smoothScroll) {
          // revealed by a quake collapse: fade in already-in-place (no drop-from-above)
          // so the camera pans down onto a continuous tower — no mid-air gap.
          sp.c.setPosition(x, y).setAlpha(0);
          this.tweens.add({ targets: sp.c, alpha: 1, duration: 450, ease: 'Quad.out' });
        } else if (animateNew) {
          this.dropIn(sp.c, x, y, blockW(b) * this.u);
        } else {
          sp.c.setPosition(x, y);
        }
      } else {
        this.tweens.add({ targets: sp.c, x, y, duration: 180, ease: 'Quad.out' });
      }
    });

    this.applyScroll(smoothScroll);
    this.updateGhost();
  }

  /** Flashy landing: fall fast, squash-and-stretch, flash white, kick up dust. */
  private dropIn(c: Phaser.GameObjects.Container, x: number, y: number, blockWidth: number): void {
    c.setPosition(x, y - 150).setAlpha(0).setScale(1, 1);
    this.tweens.add({ targets: c, y, alpha: 1, duration: 280, ease: 'Cubic.in' });
    this.tweens.add({ targets: c, scaleX: 1.18, scaleY: 0.72, duration: 100, delay: 280, ease: 'Quad.out' });
    this.tweens.add({ targets: c, scaleX: 1, scaleY: 1, duration: 220, delay: 380, ease: 'Back.out' });
    // white impact flash
    const w = blockWidth;
    const h = BLOCK_H * this.u;
    const flash = this.add.rectangle(0, 0, w, h, 0xffffff, 0.9);
    c.add(flash);
    this.tweens.add({
      targets: flash,
      alpha: 0,
      duration: 260,
      delay: 280,
      onComplete: () => flash.destroy(),
    });
    // little dust puff at the landing point (added to towerLayer → scrolls with it)
    this.time.delayedCall(280, () => this.puff(x, y + (BLOCK_H * this.u) / 2));
  }

  private puff(lx: number, ly: number): void {
    for (let i = 0; i < 6; i++) {
      const d = this.add.circle(lx + (Math.random() - 0.5) * 30, ly, 2 + Math.random() * 2, 0xcfc9c0, 0.6);
      this.towerLayer.add(d);
      this.tweens.add({
        targets: d,
        x: d.x + (Math.random() - 0.5) * 40,
        y: d.y - 10 - Math.random() * 20,
        alpha: 0,
        duration: 400,
        onComplete: () => d.destroy(),
      });
    }
  }

  private makeBlock(b: Block): Sprite {
    const foundation = isFoundation(b);
    const st = TYPE_STYLE[b.type];
    const mine = !foundation && b.owner === this.username;
    const c = this.add.container(0, 0);
    const g = this.add.graphics();
    const w = blockW(b) * this.u; // width varies by shape (beam wide, pillar narrow)
    const h = BLOCK_H * this.u;

    // ── System bedrock: a distinct, ownerless stone base nobody scores on ──
    if (foundation) {
      g.fillStyle(0x000000, 0.35);
      g.fillRoundedRect(-w / 2 + 2, -h / 2 + 3, w, h, 4);
      g.fillStyle(0x4a4a52, 1); // stone grey
      g.fillRoundedRect(-w / 2, -h / 2, w, h, 4);
      g.lineStyle(2.5, 0x24242a, 1);
      g.strokeRoundedRect(-w / 2, -h / 2, w, h, 4);
      // hatch marks so it reads as solid bedrock, not a player block
      g.lineStyle(1.5, 0x2f2f37, 0.9);
      for (let hx = -w / 2 + 8; hx < w / 2 - 4; hx += 10) {
        g.lineBetween(hx, -h / 2 + 3, hx - 6, h / 2 - 3);
      }
      const base = this.add
        .text(0, 0, '⛰ BEDROCK', {
          fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
          fontSize: `${Math.round(8 * this.u)}px`,
          color: '#c9c9d2',
        })
        .setOrigin(0.5);
      c.add([g, base]);
      this.towerLayer.add(c);
      return { block: b, c, mine: false };
    }

    // "you" halo
    if (mine) {
      g.fillStyle(ACCENT, 0.25);
      g.fillRoundedRect(-w / 2 - 5, -h / 2 - 5, w + 10, h + 10, 6);
    }
    // drop shadow
    g.fillStyle(0x000000, 0.35);
    g.fillRoundedRect(-w / 2 + 2, -h / 2 + 3, w, h, 4);
    // body
    g.fillStyle(st.fill, 1);
    g.fillRoundedRect(-w / 2, -h / 2, w, h, 4);
    // outline — accent + thick for your own, black otherwise
    g.lineStyle(mine ? 3 : 2.5, mine ? ACCENT : STROKE, 1);
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, 4);
    // reinforced (anchored): keep the material fill, add a white plating inset
    // + corner bolts so it reads as "reinforced", NOT as a different material.
    if (b.r) {
      g.lineStyle(2, 0xffffff, 0.85);
      g.strokeRoundedRect(-w / 2 + 3, -h / 2 + 3, w - 6, h - 6, 3);
      g.fillStyle(0xffffff, 0.95);
      const rx = w / 2 - 5;
      const ry = h / 2 - 5;
      const bolts: [number, number][] = [
        [-rx, -ry],
        [rx, -ry],
        [-rx, ry],
        [rx, ry],
      ];
      for (const [sx, sy] of bolts) g.fillCircle(sx, sy, 1.7);
    }

    // Fit the name to the block width (narrow pillars only show a few chars).
    const maxChars = Math.max(3, Math.floor(w / (5.4 * this.u)));
    const name =
      b.owner.length > maxChars ? b.owner.slice(0, Math.max(1, maxChars - 1)) + '…' : b.owner;
    const label = this.add
      .text(0, 0, name, {
        fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
        fontSize: `${Math.round(8.5 * this.u)}px`,
        color: st.text,
      })
      .setOrigin(0.5);

    c.add([g, label]);
    this.towerLayer.add(c);
    return { block: b, c, mine };
  }

  private destroySprite(id: string): void {
    const sp = this.sprites.get(id);
    if (sp) sp.c.destroy();
    this.sprites.delete(id);
  }

  private tumble(id: string, order = 0, base = 0): void {
    const sp = this.sprites.get(id);
    if (!sp) return;
    this.sprites.delete(id);
    const dir = sp.c.x >= 0 ? 1 : -1;
    this.tweens.add({
      targets: sp.c,
      x: sp.c.x + dir * (110 + Math.random() * 200),
      y: 170 + Math.random() * 90, // fall well past the ground line
      angle: dir * (160 + Math.random() * 280),
      alpha: 0,
      delay: base + order * 150, // deliberate top-down cascade — one, two, three…
      duration: 780 + Math.random() * 380,
      ease: 'Quad.in', // gravity-like acceleration
      onComplete: () => sp.c.destroy(),
    });
  }

  // ─── aiming / placing ───────────────────────────────────────────────────────
  private select(t: BlockType): void {
    this.userScroll = 0; // aiming always snaps back to the build zone
    this.applyScroll();
    this.selected = t;
    this.hud.setSelected(t);
    const st = TYPE_STYLE[t];
    const w = BLOCK_W * BLOCK_STATS[t].widthMul * this.u; // ghost matches the shape's width
    const h = BLOCK_H * this.u;
    this.ghostG.clear();
    this.ghostG.fillStyle(st.fill, 0.5);
    this.ghostG.fillRoundedRect(-w / 2, -h / 2, w, h, 4);
    this.ghostG.lineStyle(2.5, ACCENT, 0.95);
    this.ghostG.strokeRoundedRect(-w / 2, -h / 2, w, h, 4);
    this.ghost.setVisible(true);
    // start the ghost centered over the tower (no top-left flash on first block)
    const cx = this.topBlock() ? this.centerX + (this.topBlock()!.x - this.anchorX) * this.u : this.centerX;
    this.ghost.setPosition(cx, this.dropY());
    this.updateGhostStress(this.topBlock()?.x ?? this.anchorX);
  }

  private cancel(): void {
    this.selected = null;
    this.hud.setSelected(null);
    this.ghost.setVisible(false);
  }

  /** Preview how much this placement would add to structural stress (material feel). */
  private updateGhostStress(vx: number): void {
    if (!this.selected) return;
    const hypo: Block = { id: '_ghost', owner: '', type: this.selected, x: Math.round(vx) };
    const delta = Math.max(0, instabilityPct([...this.tower, hypo]) - instabilityPct(this.tower));
    this.ghostLabel.setPosition(0, -(BLOCK_H * this.u) / 2 - 6);
    this.ghostLabel.setText(`+${delta}%`);
    this.ghostLabel.setColor(delta > 22 ? '#ff3b3b' : delta > 10 ? '#ffb43d' : '#3ddc84');
  }

  private topBlock(): Block | undefined {
    return this.tower[this.tower.length - 1];
  }

  private virtualXAt(screenX: number): number {
    return this.anchorX + (screenX - this.centerX) / this.u;
  }

  private dropY(): number {
    return this.worldLayer.y + this.groundY - (this.tower.length + 0.7) * this.rowH;
  }

  private moveGhost(screenX: number): void {
    if (!this.selected) return;
    const vx = clampPlacement(this.virtualXAt(screenX), this.topBlock());
    this.aimVx = vx; // remember where the ghost is aimed, to drop on release
    this.ghost.setPosition(this.centerX + (vx - this.anchorX) * this.u, this.dropY());
    this.updateGhostStress(vx);
  }

  private updateGhost(): void {
    if (!this.selected) return;
    this.ghost.y = this.dropY();
  }

  private onPointerDown(p: Phaser.Input.Pointer): void {
    if (!this.selected) return; // taps without a selected block just aim/scroll
    if (this.time.now < this.quakeUntil) {
      this.hud.toast('🌋 Quake in progress — hold on…', 'warn'); // placement locked
      return;
    }
    const target = p.event?.target as HTMLElement | undefined;
    if (target && target.closest('#ui, .dock, .panel, .modal')) return;
    // Begin aiming: the ghost jumps under the finger/cursor and follows it as you
    // drag. It DROPS on release (pointerup) — same feel on touch and mouse.
    this.aiming = true;
    this.moveGhost(p.x);
  }

  /** Release: drop the selected block where the ghost is aimed. */
  private onPointerUp(): void {
    if (this.selected && this.aiming) void this.place(this.selected, this.aimVx);
    this.aiming = false;
  }

  private async place(type: BlockType, vx: number): Promise<void> {
    const clamped = clampPlacement(vx, this.topBlock());
    this.cancel();
    const res = await api.place(type, clamped);
    if ('error' in res) {
      const msg = res.error === 'network' || res.error === 'failed' ? 'Try again' : res.error;
      this.hud.toast(msg, 'warn');
      return;
    }
    this.credits = res.credits;
    this.hud.setPlayer(res.credits, this.streak, this.score);
    this.hud.setStake(res.stake);

    if (res.collapsed > 0) {
      // Show YOUR block LAND first, then let it (and the overhang) topple — so the
      // player sees the block that broke the tower actually fall.
      sfx.place();
      this.tower = [...this.tower, res.block];
      this.renderPositions(true);
      this.time.delayedCall(430, () => {
        this.hud.toast(
          `💥 Over-leaned! ${res.collapsed} block${res.collapsed === 1 ? '' : 's'} slid off`,
          'quake'
        );
        this.applyState(res.state, true);
      });
    } else {
      sfx.place();
      this.applyState(res.state, true);
    }
  }

  // ─── quake ──────────────────────────────────────────────────────────────────
  private dustBurst(): void {
    for (let i = 0; i < 16; i++) {
      const d = this.add.circle(this.centerX + (Math.random() - 0.5) * 90, this.groundY, 2 + Math.random() * 3, 0xcfc9c0, 0.7);
      this.worldLayer.add(d);
      this.tweens.add({
        targets: d,
        x: d.x + (Math.random() - 0.5) * 160,
        y: this.groundY - 30 - Math.random() * 70,
        alpha: 0,
        scale: 0.2,
        duration: 500 + Math.random() * 350,
        ease: 'Quad.out',
        onComplete: () => d.destroy(),
      });
    }
  }

  /** A small, frequent tremor: a brief shake + a puff of dust as the tower shifts
   *  off-center. Sells the "the ground is never still" feeling between big quakes. */
  private microTremor(): void {
    this.tremorUntil = this.time.now + 700; // the tower rocks side-to-side for ~0.7s
    sfx.tremor();
    // minimalist "pum" notification with a small magnitude (stable per tremor)
    const mag = (1.8 + (this.lastTremorAt % 17) / 10).toFixed(1);
    this.hud.toast(`〰️ mini-quake · M${mag}`, 'tremor');
    for (let i = 0; i < 4; i++) {
      const d = this.add.circle(
        this.centerX + (Math.random() - 0.5) * 60,
        this.groundY,
        1.5 + Math.random() * 2,
        0xcfc9c0,
        0.45
      );
      this.worldLayer.add(d);
      this.tweens.add({
        targets: d,
        y: this.groundY - 14 - Math.random() * 22,
        alpha: 0,
        duration: 460,
        ease: 'Quad.out',
        onComplete: () => d.destroy(),
      });
    }
  }

  private quakeFx(q: QuakeSummary): void {
    // ── THE hero moment: a ~5s cinematic earthquake, placement locked throughout ──
    sfx.quake(q.magnitude);
    this.quakeMag = q.magnitude;
    this.quakeUntil = this.time.now + QUAKE_MS; // drives the escalating shake + placement lock
    this.cancel(); // drop any aim — you can't place mid-quake
    this.cameras.main.flash(240, 255, 70, 40, false);

    // slam-in banner + red vignette (restart the CSS animations)
    const banner = document.getElementById('quake-banner');
    if (banner) {
      banner.textContent = `EARTHQUAKE  M${toRichter(q.magnitude).toFixed(1)}`;
      banner.classList.remove('on');
      void banner.offsetWidth;
      banner.classList.add('on');
    }
    const flash = document.getElementById('quake-flash');
    if (flash) {
      flash.classList.remove('on');
      void flash.offsetWidth;
      flash.classList.add('on');
    }

    // repeated dust eruptions through the shake
    [0, 450, 950, 1500, 2100, 2800, 3500, 4200].forEach((t) =>
      this.time.delayedCall(t, () => this.dustBurst())
    );
    this.time.delayedCall(3400, () =>
      this.hud.toast(`💥 ${q.fallen} block${q.fallen === 1 ? '' : 's'} fell — ${q.survived} survived`, 'quake')
    );
    this.time.delayedCall(QUAKE_MS - 200, () => void this.refreshLeaderboard());
  }

  // ─── idle sway + imminent tremor ─────────────────────────────────────────────
  override update(): void {
    const now = this.time.now;
    this.cullBlocks();

    const cam = this.cameras.main;

    // ── cinematic quake shake (escalate → hold → fade over the quake) ──
    if (now < this.quakeUntil) {
      const t = 1 - (this.quakeUntil - now) / QUAKE_MS;
      const env = t < 0.1 ? t / 0.1 : t > 0.7 ? Math.max(0, (1 - t) / 0.3) : 1;
      const a = env * (9 + this.quakeMag * 24);
      cam.setScroll((Math.random() - 0.5) * a, (Math.random() - 0.5) * a);
      this.worldLayer.rotation = (Math.random() - 0.5) * 0.055 * env;
      return;
    }
    if (cam.scrollX !== 0 || cam.scrollY !== 0) cam.setScroll(0, 0);
    if (this.worldLayer.rotation !== 0) this.worldLayer.rotation = 0;

    // ── tower motion: idle sway + a micro-tremor wobble or pre-quake jitter ──
    const amp = 0.004 + (this.lastInstability / 100) * 0.03;
    let rot = Math.sin(now * 0.0016) * amp; // gentle idle breathing
    let tx = this.centerX;
    const ms = this.nextQuakeAt - Date.now();

    if (now < this.tremorUntil) {
      // mini-tremor: the whole tower sways side-to-side a little (NOT the camera),
      // so you SEE the blocks rock left and right, then settle.
      const e = (this.tremorUntil - now) / 700;
      tx = this.centerX + Math.sin(now * 0.035) * 13 * e;
      rot += Math.sin(now * 0.03) * 0.02 * e;
    } else if (this.nextQuakeAt > 0 && ms > 0 && ms < 7000) {
      // subtle pre-quake jitter warning in the last few seconds
      tx = this.centerX + (Math.random() - 0.5) * (1 - ms / 7000) * 2.5;
    }
    this.towerLayer.rotation = rot;
    this.towerLayer.x = tx;
  }
}
