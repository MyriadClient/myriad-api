import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { clientKey } from "./address.ts";
import { CODE, hashKey, keyMatches, newCode, newDeleteKey } from "./codes.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { RateLimit } from "./rateLimit.ts";
import { cleanShare, InvalidShare } from "./share.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * The HTTP API, version 1:
 *
 * - `POST /v1/configs` a shared config (JSON) → `201 {code, url, deleteKey}`
 * - `GET /v1/configs/:code` → the shared config
 * - `DELETE /v1/configs/:code` with `Authorization: Bearer <deleteKey>` → `204`
 *
 * There are no accounts and no cookies, so nothing can be done in a visitor's name; what's stored is public to anyone
 * with its code. Every route is limited per client, and publishing also has a ceiling for everyone together.
 * Addresses are only kept in memory, for the limits, and never stored.
 */
export function createApp(store: Store, config: Config, now: () => number = Date.now): Hono {
	const app = new Hono();
	const limits = {
		uploadsHour: new RateLimit(config.uploadsPerHour, HOUR),
		uploadsDay: new RateLimit(config.uploadsPerDay, 24 * HOUR),
		uploadsEveryone: new RateLimit(config.globalUploadsPerHour, HOUR),
		// Every publish attempt, valid or not, so malformed ones can't keep the server parsing.
		attempts: new RateLimit(config.uploadsPerHour * 6, HOUR),
		reads: new RateLimit(config.readsPerMinute, MINUTE),
		misses: new RateLimit(config.missesPerMinute, MINUTE),
		deletes: new RateLimit(config.deletesPerHour, HOUR),
	};
	setInterval(() => Object.values(limits).forEach(l => l.sweep(now())), 10 * MINUTE).unref();

	// JSON only: nothing here is ever rendered as a page, framed or sniffed as something else.
	app.use("*", secureHeaders({
		contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
		crossOriginResourcePolicy: "cross-origin",
		referrerPolicy: "no-referrer",
	}));
	app.use("/v1/*", cors({ origin: "*", allowMethods: ["GET", "POST", "DELETE"], allowHeaders: ["Content-Type", "Authorization"], maxAge: 600 }));

	app.onError((err, c) => {
		console.error(err);
		return c.json({ error: "Something went wrong" }, 500);
	});
	app.notFound(c => c.json({ error: "Not found" }, 404));

	const who = (c: Context) => clientKey(c.req.header("x-forwarded-for"), socketAddress(c), config.trustedProxies);

	app.get("/health", c => c.json({ ok: true }));

	app.post("/v1/configs", bodyLimit({ maxSize: config.maxShareBytes, onError: c => c.json({ error: "Too big" }, 413) }), async c => {
		const client = who(c);
		const t = now();
		if (!limits.attempts.tryHit(client, t)) return tooMany(c, "Too many tries from here; try again later");
		if (limits.uploadsHour.isLimited(client, t) || limits.uploadsDay.isLimited(client, t)) return tooMany(c, "Too many shares from here; try again later");
		if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) return c.json({ error: "Send JSON" }, 415);
		let document;
		try {
			document = cleanShare(JSON.parse(await c.req.text()));
		} catch (e) {
			if (e instanceof InvalidShare) return c.json({ error: `Not a valid share: ${e.message}` }, 400);
			if (e instanceof SyntaxError || e instanceof RangeError) return c.json({ error: "Not JSON" }, 400);
			throw e;
		}
		// Counted once it's a real share: a malformed one doesn't use up the sender's allowance.
		if (!limits.uploadsEveryone.tryHit("*", t)) return tooMany(c, "Myriad is getting a lot of shares right now; try again later");
		limits.uploadsHour.tryHit(client, t);
		limits.uploadsDay.tryHit(client, t);

		const deleteKey = newDeleteKey();
		const text = JSON.stringify(document);
		for (let tries = 0; tries < 10; tries++) {
			const code = newCode();
			if (store.insertShare({ code, document: text, deleteHash: hashKey(deleteKey), createdAt: t })) {
				return c.json({ code, url: `${config.siteUrl}/config/${code}`, deleteKey }, 201);
			}
		}
		return c.json({ error: "Couldn't find a free code" }, 503);
	});

	app.get("/v1/configs/:code", c => {
		const client = who(c);
		const t = now();
		if (limits.misses.isLimited(client, t)) return tooMany(c, "Too many codes that don't exist; slow down");
		if (!limits.reads.tryHit(client, t)) return tooMany(c, "Too many requests; slow down");
		const code = c.req.param("code");
		const row = CODE.test(code) ? store.viewShare(code) : undefined;
		if (!row) {
			limits.misses.tryHit(client, t);
			return c.json({ error: "No share with that code" }, 404);
		}
		c.header("Cache-Control", "public, max-age=60");
		return c.body(row.document, 200, { "Content-Type": "application/json; charset=utf-8" });
	});

	app.delete("/v1/configs/:code", c => {
		if (!limits.deletes.tryHit(who(c), now())) return tooMany(c, "Too many tries; slow down");
		const code = c.req.param("code");
		const key = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(c.req.header("authorization") ?? "")?.[1];
		const hash = CODE.test(code) ? store.deleteHashOf(code) : undefined;
		if (!hash) return c.json({ error: "No share with that code" }, 404);
		if (!key || !keyMatches(key, hash)) return c.json({ error: "That key doesn't delete this share" }, 403);
		store.deleteShare(code);
		return c.body(null, 204);
	});

	return app;
}

function tooMany(c: Context, error: string) {
	c.header("Retry-After", "60");
	return c.json({ error }, 429);
}

/** The socket's address, when served by Node. */
function socketAddress(c: Context): string | undefined {
	return (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
}
