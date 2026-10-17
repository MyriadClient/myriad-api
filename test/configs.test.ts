import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { Store } from "../src/db.ts";

const config: Config = {
	port: 0, dbPath: ":memory:", siteUrl: "https://myriadclient.dev", maxShareBytes: 4096,
	uploadsPerHour: 3, uploadsPerDay: 50, trustProxy: true,
};

function setup() {
	return createApp(new Store(":memory:"), config);
}

const share = {
	format: 1,
	title: "Highway",
	modules: [{
		id: "myriad-essentials:elytra_fly", enabled: true, settings: { general: { type: "Recast" } },
		view: { name: "Elytra Fly", groups: [{ name: "General", settings: [
			{ name: "Type", kind: "choice", shown: "Recast" },
			{ name: "Webhook", kind: "text", protected: true, shown: "https://leaked.example", value: "x" },
		] }] },
	}],
	addons: [{ id: "myriad-essentials", name: "Myriad Essentials", version: "0.3.2" }],
};

async function publish(app: ReturnType<typeof setup>, body: unknown, ip = "1.2.3.4") {
	return app.request("/v1/configs", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip }, body: JSON.stringify(body) });
}

test("publish, fetch and delete a share", async () => {
	const app = setup();
	const res = await publish(app, share);
	assert.equal(res.status, 201);
	const { code, url, deleteKey } = await res.json() as { code: string; url: string; deleteKey: string };
	assert.match(code, /^myriad_[A-Za-z0-9]{6}$/);
	assert.equal(url, `https://myriadclient.dev/config/${code}`);

	const got = await app.request(`/v1/configs/${code}`);
	assert.equal(got.status, 200);
	const doc = await got.json() as typeof share;
	assert.equal(doc.title, "Highway");
	assert.equal(doc.modules[0]!.settings.general.type, "Recast");

	assert.equal((await app.request(`/v1/configs/${code}`, { method: "DELETE", headers: { Authorization: "Bearer wrong" } })).status, 403);
	assert.equal((await app.request(`/v1/configs/${code}`, { method: "DELETE", headers: { Authorization: `Bearer ${deleteKey}` } })).status, 204);
	assert.equal((await app.request(`/v1/configs/${code}`)).status, 404);
});

test("a protected setting never keeps a value", async () => {
	const app = setup();
	const { code } = await (await publish(app, share)).json() as { code: string };
	const doc = await (await app.request(`/v1/configs/${code}`)).json() as { modules: { view: { groups: { settings: Record<string, unknown>[] }[] } }[] };
	const webhook = doc.modules[0]!.view.groups[0]!.settings[1]!;
	assert.deepEqual(webhook, { name: "Webhook", kind: "text", protected: true });
});

test("refuses what isn't a share", async () => {
	const app = setup();
	assert.equal((await publish(app, { format: 2, modules: [] })).status, 400);
	assert.equal((await publish(app, { format: 1, modules: [] })).status, 400);
	assert.equal((await publish(app, { format: 1, modules: [{ id: "Not An Id" }] })).status, 400);
	assert.equal((await app.request("/v1/configs/nope")).status, 400);
});

test("refuses shares that are too big", async () => {
	const app = setup();
	const big = { ...share, description: "x".repeat(900), modules: Array.from({ length: 40 }, () => share.modules[0]) };
	assert.equal((await publish(app, big)).status, 413);
});

test("limits shares per address", async () => {
	const app = setup();
	for (let i = 0; i < 3; i++) assert.equal((await publish(app, share, "5.6.7.8")).status, 201);
	assert.equal((await publish(app, share, "5.6.7.8")).status, 429);
	assert.equal((await publish(app, share, "9.9.9.9")).status, 201);
});
