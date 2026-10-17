import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { CODE, hashKey, keyMatches, newCode, newDeleteKey } from "./codes.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { RateLimit } from "./rateLimit.ts";
import { cleanShare, InvalidShare } from "./share.ts";

const HOUR = 60 * 60 * 1000;

/**
 * The HTTP API, version 1:
 *
 * - `POST /v1/configs` a shared config (JSON) → `201 {code, url, deleteKey}`
 * - `GET /v1/configs/:code` → the shared config
 * - `DELETE /v1/configs/:code` with `Authorization: Bearer <deleteKey>` → `204`
 *
 * Reading is open to any site (the website shows shares from the browser); publishing is limited per address.
 */
export function createApp(store: Store, config: Config, now: () => number = Date.now): Hono {
	const app = new Hono();
	const perHour = new RateLimit(config.uploadsPerHour, HOUR);
	const perDay = new RateLimit(config.uploadsPerDay, 24 * HOUR);
	setInterval(() => {
		perHour.sweep(now());
		perDay.sweep(now());
	}, HOUR).unref();

	app.use("/v1/*", cors({ origin: "*", allowMethods: ["GET", "POST", "DELETE"], allowHeaders: ["Content-Type", "Authorization"] }));

	app.get("/health", c => c.json({ ok: true }));

	app.post("/v1/configs", bodyLimit({ maxSize: config.maxShareBytes, onError: c => c.json({ error: "Too big" }, 413) }), async c => {
		const address = clientAddress(c.req.header("x-forwarded-for"), c.env, config.trustProxy);
		const t = now();
		if (!perHour.tryHit(address, t) || !perDay.tryHit(address, t)) return c.json({ error: "Too many shares from here; try again later" }, 429);
		let document;
		try {
			document = cleanShare(await c.req.json());
		} catch (e) {
			if (e instanceof InvalidShare) return c.json({ error: `Not a valid share: ${e.message}` }, 400);
			if (e instanceof SyntaxError) return c.json({ error: "Not JSON" }, 400);
			throw e;
		}
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
		const code = c.req.param("code");
		if (!CODE.test(code)) return c.json({ error: "Not a share code" }, 400);
		const row = store.viewShare(code);
		if (!row) return c.json({ error: "No share with that code" }, 404);
		c.header("Cache-Control", "public, max-age=60");
		return c.body(row.document, 200, { "Content-Type": "application/json" });
	});

	app.delete("/v1/configs/:code", c => {
		const code = c.req.param("code");
		const key = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
		const hash = CODE.test(code) ? store.deleteHashOf(code) : undefined;
		if (!hash) return c.json({ error: "No share with that code" }, 404);
		if (!key || !keyMatches(key, hash)) return c.json({ error: "That key doesn't delete this share" }, 403);
		store.deleteShare(code);
		return c.body(null, 204);
	});

	return app;
}

/** Who's asking: the first address in X-Forwarded-For behind a proxy, else the socket's. */
function clientAddress(forwarded: string | undefined, env: unknown, trustProxy: boolean): string {
	if (trustProxy && forwarded) return forwarded.split(",")[0]!.trim();
	const incoming = (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
	return incoming?.socket?.remoteAddress ?? "unknown";
}
