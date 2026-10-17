/**
 * How many times each key did something within a window, forgetting what's older. Keeps at most {@code maxKeys}
 * keys (the oldest go first), so addresses churning through it can't grow it without bound.
 */
export class RateLimit {
	private readonly hits = new Map<string, number[]>();
	private readonly limit: number;
	private readonly windowMs: number;
	private readonly maxKeys: number;

	constructor(limit: number, windowMs: number, maxKeys = 100_000) {
		this.limit = limit;
		this.windowMs = windowMs;
		this.maxKeys = maxKeys;
	}

	/** Counts a try by {@code key} at {@code now}; false (and not counted) when it's over the limit. */
	tryHit(key: string, now: number): boolean {
		const recent = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs);
		this.hits.delete(key);
		if (recent.length >= this.limit) {
			this.hits.set(key, recent);
			return false;
		}
		recent.push(now);
		this.hits.set(key, recent);
		if (this.hits.size > this.maxKeys) this.evict(now);
		return true;
	}

	/** Whether {@code key} is at its limit, without counting a try. */
	isLimited(key: string, now: number): boolean {
		return (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs).length >= this.limit;
	}

	/** Drops keys with nothing in the window. */
	sweep(now: number): void {
		for (const [key, times] of this.hits) if (times.every(t => now - t >= this.windowMs)) this.hits.delete(key);
	}

	private evict(now: number): void {
		this.sweep(now);
		for (const key of this.hits.keys()) {
			if (this.hits.size <= this.maxKeys) break;
			this.hits.delete(key);
		}
	}
}
