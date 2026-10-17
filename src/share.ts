/**
 * Checking and cleaning a shared config before it's stored: the document a Myriad client builds
 * (`ConfigShare`, format 1). Only the parts the format has are kept, sizes are capped, and a setting the client marked
 * protected never keeps a value, whatever was sent.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export const FORMAT = 1;
const MODULE_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const LIMITS = { title: 100, description: 1000, modules: 500, controlPanels: 50, addons: 100 };

export class InvalidShare extends Error {}

/** The cleaned document, or throws {@link InvalidShare} saying what's wrong. */
export function cleanShare(input: unknown): JsonObject {
	const doc = object(input, "the share");
	if (doc.format !== FORMAT) throw new InvalidShare(`format must be ${FORMAT}`);
	const out: JsonObject = { format: FORMAT };
	out.title = text(doc.title ?? "Shared config", "title", LIMITS.title);
	if (doc.description !== undefined) out.description = text(doc.description, "description", LIMITS.description);
	if (doc.made !== undefined) out.made = object(doc.made, "made");

	const modules = list(doc.modules ?? [], "modules", LIMITS.modules).map((m, i) => module(m, i));
	out.modules = modules;
	if (doc.controlPanels !== undefined) out.controlPanels = list(doc.controlPanels, "controlPanels", LIMITS.controlPanels).map((p, i) => object(p, `controlPanels[${i}]`));
	if (doc.theme !== undefined) out.theme = object(doc.theme, "theme");
	if (doc.look !== undefined) out.look = object(doc.look, "look");
	out.addons = list(doc.addons ?? [], "addons", LIMITS.addons).map((a, i) => object(a, `addons[${i}]`));

	if (modules.length === 0 && out.controlPanels === undefined && out.theme === undefined) throw new InvalidShare("nothing to share");
	return out;
}

function module(input: Json, i: number): JsonObject {
	const m = object(input, `modules[${i}]`);
	const id = text(m.id, `modules[${i}].id`, 200);
	if (!MODULE_ID.test(id)) throw new InvalidShare(`modules[${i}].id is not a module id`);
	const out: JsonObject = { id, enabled: m.enabled === true, settings: m.settings === undefined ? {} : object(m.settings, `modules[${i}].settings`) };
	if (m.view !== undefined) out.view = view(object(m.view, `modules[${i}].view`));
	return out;
}

/** A module's look in the menu, with every protected row reduced to its name and kind. */
function view(v: JsonObject): JsonObject {
	const groups = Array.isArray(v.groups) ? v.groups : [];
	return {
		...v,
		groups: groups.map(g => {
			if (!isObject(g)) return g;
			const rows = Array.isArray(g.settings) ? g.settings : [];
			return { ...g, settings: rows.map(r => isObject(r) && r.protected === true ? { name: r.name ?? "", kind: r.kind ?? "text", protected: true } : r) };
		}),
	};
}

function isObject(v: Json | undefined): v is JsonObject {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function object(v: Json | unknown, what: string): JsonObject {
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
