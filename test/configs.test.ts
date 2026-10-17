import assert from "node:assert/strict";
import { test } from "node:test";
import { clientKey } from "../src/address.ts";
import { createApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { Store } from "../src/db.ts";

const base: Config = {
	port: 0, dbPath: ":memory:", siteUrl: "https://myriadclient.dev", maxShareBytes: 8192,
	uploadsPerHour: 3, uploadsPerDay: 50, globalUploadsPerHour: 1000, readsPerMinute: 100, missesPerMinute: 5,
	deletesPerHour: 30, trustedProxies: 1,
};

function setup(overrides: Partial<Config> = {}) {
	return createApp(new Store(":memory:"), { ...base, ...overrides });
}

const share = {
	format: 1,
	title: "Highway",
	modules: [{
		id: "myriad-essentials:elytra_fly", enabled: true, settings: { general: { type: "Recast" } },
		view: { name: "Elytra Fly", category: { name: "Movement", color: "#89B4FAFF" }, groups: [{ name: "General", settings: [
			{ name: "Type", kind: "choice", shown: "Recast" },
			{ name: "Webhook", kind: "text", protected: true, shown: "https://leaked.example", value: "x" },
		] }] },
	}],
	addons: [{ id: "myriad-essentials", name: "Myriad Essentials", version: "0.3.2" }],
};

type App = ReturnType<typeof setup>;

function publish(app: App, body: unknown, ip = "1.2.3.4") {
	return app.request("/v1/configs", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip }, body: JSON.stringify(body) });
}

function get(app: App, code: string, ip = "1.2.3.4") {
	return app.request(`/v1/configs/${code}`, { headers: { "X-Forwarded-For": ip } });
}

async function codeOf(res: Response) {
	return (await res.json() as { code: string }).code;
}

test("publish, fetch and delete a share", async () => {
	const app = setup();
	const res = await publish(app, share);
	assert.equal(res.status, 201);
	const { code, url, deleteKey } = await res.json() as { code: string; url: string; deleteKey: string };
	assert.match(code, /^myriad_[A-Za-z0-9]{6}$/);
	assert.equal(url, `https://myriadclient.dev/config/${code}`);

	const got = await get(app, code);
	assert.equal(got.status, 200);
	assert.equal((await got.json() as typeof share).modules[0]!.settings.general.type, "Recast");

	assert.equal((await app.request(`/v1/configs/${code}`, { method: "DELETE", headers: { Authorization: "Bearer wrong" } })).status, 403);
	assert.equal((await app.request(`/v1/configs/${code}`, { method: "DELETE", headers: { Authorization: `Bearer ${deleteKey}` } })).status, 204);
	assert.equal((await get(app, code)).status, 404);
});

test("a protected setting never keeps a value", async () => {
	const app = setup();
	const code = await codeOf(await publish(app, share));
	const doc = await (await get(app, code)).json() as { modules: { view: { groups: { settings: Record<string, unknown>[] }[] } }[] };
	assert.deepEqual(doc.modules[0]!.view.groups[0]!.settings[1], { name: "Webhook", kind: "text", protected: true });
});

test("only hex colours survive, so a share can't make a viewer load anything", async () => {
	const app = setup();
	const evil = structuredClone(share) as typeof share & { look: Record<string, unknown> };
	evil.modules[0]!.view.category.color = "url(https://tracker.example/x.png)";
	evil.look = { accent: "red; background: url(https://tracker.example)", window: "#131514D8", rounding: 9999 };
	const code = await codeOf(await publish(app, evil));
	const text = await (await get(app, code)).text();
	assert.ok(!text.includes("tracker.example"));
	const doc = JSON.parse(text) as { look: Record<string, unknown> };
	assert.deepEqual(doc.look, { window: "#131514D8", rounding: 20 });
});

test("unknown fields are dropped", async () => {
	const app = setup();
	const code = await codeOf(await publish(app, { ...share, extra: "<script>", modules: [{ ...share.modules[0], view: { ...share.modules[0]!.view, html: "<b>" } }] }));
	const text = await (await get(app, code)).text();
	assert.ok(!text.includes("<script>") && !text.includes("<b>"));
});

test("refuses what isn't a share", async () => {
	const app = setup();
	assert.equal((await publish(app, { format: 2, modules: [] })).status, 400);
	assert.equal((await publish(app, { format: 1, modules: [] })).status, 400);
	assert.equal((await publish(app, { format: 1, modules: [{ id: "Not An Id" }] })).status, 400);
	let deep: unknown = "x";
	for (let i = 0; i < 20; i++) deep = { a: deep };
	assert.equal((await publish(app, { ...share, modules: [{ ...share.modules[0], settings: deep }] })).status, 400);
	const notJson = await app.request("/v1/configs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
	assert.equal(notJson.status, 400);
	const form = await app.request("/v1/configs", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(share) });
	assert.equal(form.status, 415);
});

test("refuses shares that are too big", async () => {
	const app = setup();
	const big = { ...share, description: "x".repeat(900), modules: Array.from({ length: 40 }, () => share.modules[0]) };
	assert.equal((await publish(app, big)).status, 413);
});

test("limits shares per client, and a forged X-Forwarded-For doesn't help", async () => {
	const app = setup();
	// What the client writes comes first; the proxy appends the real address last.
	for (let i = 0; i < 3; i++) assert.equal((await publish(app, share, `10.0.0.${i}, 5.6.7.8`)).status, 201);
	assert.equal((await publish(app, share, "10.9.9.9, 5.6.7.8")).status, 429);
	assert.equal((await publish(app, share, "9.9.9.9")).status, 201);
});

test("an IPv6 client is its /64", () => {
	assert.equal(clientKey("2001:db8:1:2:aaaa::1", undefined, 1), clientKey("2001:db8:1:2:ffff:1:2:3", undefined, 1));
	assert.notEqual(clientKey("2001:db8:1:2::1", undefined, 1), clientKey("2001:db8:1:3::1", undefined, 1));
	assert.equal(clientKey("::ffff:1.2.3.4", undefined, 1), "1.2.3.4");
	assert.equal(clientKey(undefined, "1.2.3.4", 0), "1.2.3.4");
	assert.equal(clientKey("not-an-ip", undefined, 1), "invalid");
});

test("guessing codes is cut off", async () => {
	const app = setup();
	for (let i = 0; i < 5; i++) assert.equal((await get(app, `myriad_AAAAA${i}`, "7.7.7.7")).status, 404);
	assert.equal((await get(app, "myriad_AAAAA9", "7.7.7.7")).status, 429);
});

test("everyone together has a ceiling", async () => {
	const app = setup({ globalUploadsPerHour: 2 });
	assert.equal((await publish(app, share, "1.1.1.1")).status, 201);
	assert.equal((await publish(app, share, "2.2.2.2")).status, 201);
	assert.equal((await publish(app, share, "3.3.3.3")).status, 429);
});

test("security headers on every response", async () => {
	const app = setup();
	const res = await app.request("/health");
	assert.equal(res.headers.get("x-content-type-options"), "nosniff");
	assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
	assert.equal((await app.request("/nope")).status, 404);
});
