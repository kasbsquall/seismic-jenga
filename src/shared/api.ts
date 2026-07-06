import type { Block, BlockType } from './model';

export type QuakeSummary = {
  id: number;
  ts: number;
  magnitude: number;
  fallen: number;
  survived: number;
};

/** Compact per-user recap shown when you return after being away. */
export type QuakeReport = {
  quakesMissed: number;
  standingNow: number;
  lostSinceSeen: number;
  earnedSinceSeen: number;
};

export type HallOfFameEntry = { epoch: number; peak: number; ts: number };

/** What the current player stands to earn if a quake hit right now. */
export type Stake = { blocks: number; pts: number };

export type PublicState = {
  /** Top VISIBLE_BLOCKS of the tower, bottom→top. */
  tower: Block[];
  /** Total number of blocks currently standing (tower height / "floor"). */
  height: number;
  instability: number;
  quakeId: number;
  nextQuakeAt: number;
  /** Server clock at response time — clients use it to correct clock skew. */
  serverNow: number;
  lastQuake: QuakeSummary | null;
  /** Current tower epoch (increments each time the tower fully collapses). */
  epoch: number;
  /** Tallest the current epoch's tower has ever reached. */
  epochPeak: number;
  /** Timestamp of the last mini-tremor — clients play a micro-shake when it changes. */
  tremorAt: number;
};

export type InitResponse = {
  type: 'init';
  username: string;
  credits: number;
  score: number;
  streak: number;
  dailyBonus: number;
  bestFloor: number;
  report: QuakeReport | null;
  /** Show the "How to play" card (true at most once per day per user). */
  showOnboard: boolean;
  state: PublicState;
  stake: Stake;
};

export type StateResponse = { type: 'state'; state: PublicState; stake: Stake };

/** Small credit trickle for actively watching the tower. */
export type WatchResponse = { type: 'watch'; credits: number; granted: number };

export type PlaceRequest = { type: BlockType; x: number };

export type PlaceResponse = {
  type: 'place';
  block: Block;
  credits: number;
  /** Blocks knocked down by gravity right after this placement (over-lean). */
  collapsed: number;
  state: PublicState;
  stake: Stake;
};

export type ReinforceRequest = { blockId: string };
export type ReinforceResponse = {
  type: 'reinforce';
  credits: number;
  state: PublicState;
  stake: Stake;
};

export type LeaderboardEntry = {
  username: string;
  score: number;
  standing: number;
  rank: number;
};

export type LeaderboardResponse = {
  type: 'leaderboard';
  entries: LeaderboardEntry[];
  totalBlocks: number;
  you: LeaderboardEntry | null;
};

export type ErrorResponse = { status: 'error'; message: string };
