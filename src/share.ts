/**
 * Checking and cleaning a shared config before it's stored: the document a Myriad client builds (`ConfigShare`,
 * format 1).
 *
 * Everything is rebuilt from a whitelist: only the fields the format has are kept, each checked for its type and capped
 * in length, so nothing else can be stored and served. In particular:
 * - colours (which the website uses in styles) must be `#RRGGBB` or `#RRGGBBAA`, or they're dropped, so a share can't
 *   make a viewer's browser load anything;
 * - a setting the client marked protected keeps only its name and kind, whatever was sent;
 * - settings values (opaque to the server, read by Myriad clients) are limited in depth and size.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export const FORMAT = 1;
const MODULE_ID = /^[a-z0-9_.-]{1,64}:[a-z0-9_./-]{1,64}$/;
const COLOR = /^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
const KINDS = new Set(["toggle", "number", "choice", "color", "keybind", "list", "position", "text"]);
const MAX_DEPTH = 8;

export class InvalidShare extends Error {}

/** The cleaned document, or throws {@link InvalidShare} saying what's wrong. */
export function cleanShare(input: unknown): JsonObject {
	const doc = object(input, "the share");
	if (doc.format !== FORMAT) throw new InvalidShare(`format must be ${FORMAT}`);
	const out: JsonObject = { format: FORMAT, title: text(doc.title ?? "Shared config", "title", 100) };
	if (doc.description !== undefined) out.description = text(doc.description, "description", 1000);
	if (doc.made !== undefined) {
		const made = object(doc.made, "made");
		out.made = pick({ core: optText(made.core, 32), minecraft: optText(made.minecraft, 32) });
	}
	out.addons = list(doc.addons ?? [], "addons", 100).map((a, i) => {
		const o = object(a, `addons[${i}]`);
		return { id: text(o.id, `addons[${i}].id`, 64), name: text(o.name ?? o.id, `addons[${i}].name`, 80), version: text(o.version ?? "", `addons[${i}].version`, 40) };
	});

	const modules = list(doc.modules ?? [], "modules", 500).map((m, i) => module(m, i));
	out.modules = modules;
	if (doc.controlPanels !== undefined) out.controlPanels = list(doc.controlPanels, "controlPanels", 50).map((p, i) => controlPanel(p, i));
	if (doc.theme !== undefined) {
		const t = object(doc.theme, "theme");
		out.theme = pick({ name: optText(t.name, 80), settings: t.settings === undefined ? undefined : opaque(t.settings, "theme.settings"), view: t.view === undefined ? undefined : look(t.view) });
	}
	if (doc.look !== undefined) out.look = look(doc.look);

	if (modules.length === 0 && out.controlPanels === undefined && out.theme === undefined) throw new InvalidShare("nothing to share");
	return out;
}

function module(input: Json, i: number): JsonObject {
	const m = object(input, `modules[${i}]`);
	const id = text(m.id, `modules[${i}].id`, 129);
	if (!MODULE_ID.test(id)) throw new InvalidShare(`modules[${i}].id is not a module id`);
	const out: JsonObject = { id, enabled: m.enabled === true, settings: m.settings === undefined ? {} : opaque(m.settings, `modules[${i}].settings`) };
	if (m.view !== undefined) out.view = moduleView(object(m.view, `modules[${i}].view`));
	return out;
}

/** How a module looked in the sharer's menu. */
function moduleView(v: JsonObject): JsonObject {
	const category = isObject(v.category) ? pick({ name: optText(v.category.name, 40), icon: optText(v.category.icon, 8), color: color(v.category.color) }) : undefined;
	const groups = Array.isArray(v.groups) ? v.groups.slice(0, 30).filter(isObject).map(g => ({
		name: optText(g.name, 40) ?? "",
		settings: (Array.isArray(g.settings) ? g.settings.slice(0, 200) : []).filter(isObject).map(settingRow),
	})) : [];
	return pick({
		name: optText(v.name, 80),
		description: optText(v.description, 400),
		addon: optText(v.addon, 64),
		addonName: optText(v.addonName, 80),
		category,
		groups,
	});
}

/** One setting as the menu showed it. A protected one is only its name and kind. */
function settingRow(r: JsonObject): JsonObject {
	const name = optText(r.name, 60) ?? "";
	const kind = typeof r.kind === "string" && KINDS.has(r.kind) ? r.kind : "text";
	if (r.protected === true) return { name, kind, protected: true };
	return pick({
		name,
		kind,
		description: optText(r.description, 400),
		default: typeof r.default === "boolean" ? r.default : undefined,
		shown: optText(r.shown, 200),
		value: typeof r.value === "boolean" || finite(r.value) ? r.value : undefined,
		min: finite(r.min) ? r.min : undefined,
		max: finite(r.max) ? r.max : undefined,
		options: Array.isArray(r.options) ? r.options.slice(0, 50).filter((o): o is string => typeof o === "string").map(o => o.slice(0, 60)) : undefined,
		color: color(r.color),
	});
}

function controlPanel(input: Json, i: number): JsonObject {
	const p = object(input, `controlPanels[${i}]`);
	const members = list(p.members ?? [], `controlPanels[${i}].members`, 200).filter((m): m is string => typeof m === "string" && MODULE_ID.test(m));
	return pick({
		name: text(p.name, `controlPanels[${i}].name`, 100),
		description: optText(p.description, 400),
		members,
		settings: p.settings === undefined ? undefined : opaque(p.settings, `controlPanels[${i}].settings`),
	});
}

/** The sharer's theme colours and rounding: nothing but colours and a number. */
function look(input: Json): JsonObject {
	const l = object(input, "look");
	const out: JsonObject = {};
	for (const key of ["accent", "secondary", "window", "title", "surface", "text", "textDim", "border"]) {
		const c = color(l[key]);
		if (c) out[key] = c;
	}
	if (finite(l.rounding)) out.rounding = Math.min(20, Math.max(0, l.rounding));
	return out;
}

/** Settings values: any JSON a client reads, kept as sent but limited in depth, keys and string length. */
function opaque(v: Json, what: string, depth = 0): Json {
	if (depth > MAX_DEPTH) throw new InvalidShare(`${what} is nested too deeply`);
	if (typeof v === "string") return v.slice(0, 4096);
	if (Array.isArray(v)) {
		if (v.length > 1000) throw new InvalidShare(`${what} has more than 1000 entries`);
		return v.map(x => opaque(x, what, depth + 1));
	}
	if (isObject(v)) {
		const keys = Object.keys(v);
		if (keys.length > 500) throw new InvalidShare(`${what} has more than 500 keys`);
		const out: JsonObject = {};
		for (const k of keys) if (k.length <= 128) out[k] = opaque(v[k]!, what, depth + 1);
		return out;
	}
	return v;
}

function color(v: Json | undefined): string | undefined {
	return typeof v === "string" && COLOR.test(v) ? v : undefined;
}

function finite(v: Json | undefined): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

/** The object without its undefined fields. */
function pick(o: Record<string, Json | undefined>): JsonObject {
	const out: JsonObject = {};
	for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
	return out;
}

function isObject(v: Json | undefined): v is JsonObject {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function object(v: unknown, what: string): JsonObject {
	if (!isObject(v as Json)) throw new InvalidShare(`${what} must be an object`);
	return v as JsonObject;
}

function list(v: Json | undefined, what: string, max: number): Json[] {
	if (!Array.isArray(v)) throw new InvalidShare(`${what} must be a list`);
	if (v.length > max) throw new InvalidShare(`${what} has more than ${max} entries`);
	return v;
}

function text(v: Json | undefined, what: string, max: number): string {
	if (typeof v !== "string") throw new InvalidShare(`${what} must be text`);
	if (v.length > max) throw new InvalidShare(`${what} is longer than ${max} characters`);
	return v;
}

function optText(v: Json | undefined, max: number): string | undefined {
	return typeof v === "string" ? v.slice(0, max) : undefined;
}
