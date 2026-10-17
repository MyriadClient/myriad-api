/** How many times each key (an address) did something within a window, forgetting what's older. */
export class RateLimit {
	private readonly hits = new Map<string, number[]>();
	private readonly limit: number;
	private readonly windowMs: number;

	constructor(limit: number, windowMs: number) {
		this.limit = limit;
		this.windowMs = windowMs;
	}

	/** Counts a try by {@code key} at {@code now}; false (and not counted) when it's over the limit. */
	tryHit(key: string, now: number): boolean {
		const recent = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs);
		if (recent.length >= this.limit) {
			this.hits.set(key, recent);
			return false;
		}
		recent.push(now);
		this.hits.set(key, recent);
		return true;
	}

	/** Drops keys with nothing in the window (call now and then, so the map doesn't grow forever). */
	sweep(now: number): void {
		for (const [key, times] of this.hits) if (times.every(t => now - t >= this.windowMs)) this.hits.delete(key);
	}
}
