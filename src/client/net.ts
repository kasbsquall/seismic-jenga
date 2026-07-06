import type {
  InitResponse,
  StateResponse,
  PlaceResponse,
  LeaderboardResponse,
  PlaceRequest,
  ReinforceResponse,
  WatchResponse,
} from '../shared/api';
import type { BlockType } from '../shared/model';

async function getJSON<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const api = {
  init: () => getJSON<InitResponse>('/api/init'),
  state: () => getJSON<StateResponse>('/api/state'),
  leaderboard: () => getJSON<LeaderboardResponse>('/api/leaderboard'),

  async watch(): Promise<WatchResponse | null> {
    try {
      const res = await fetch('/api/watch', { method: 'POST' });
      if (!res.ok) return null;
      return (await res.json()) as WatchResponse;
    } catch {
      return null;
    }
  },

  async place(type: BlockType, x: number): Promise<PlaceResponse | { error: string }> {
    try {
      const res = await fetch('/api/place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, x } satisfies PlaceRequest),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        return { error: body?.message ?? 'failed' };
      }
      return (await res.json()) as PlaceResponse;
    } catch {
      return { error: 'network' };
    }
  },

  async reinforce(blockId: string): Promise<ReinforceResponse | { error: string }> {
    try {
      const res = await fetch('/api/reinforce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blockId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        return { error: body?.message ?? 'failed' };
      }
      return (await res.json()) as ReinforceResponse;
    } catch {
      return { error: 'network' };
    }
  },
};
