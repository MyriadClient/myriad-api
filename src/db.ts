import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrate.ts";

/** A stored share: the document as sent (cleaned), and the hash of the key that deletes it. */
export interface ShareRow {
	code: string;
	document: string;
	deleteHash: string;
	createdAt: number;
	views: number;
}

/** The API's storage: one SQLite file, its tables made (or brought up to date) on open. */
export class Store {
	readonly db: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA journal_mode = WAL");
		migrate(this.db);
	}

	insertShare(row: Omit<ShareRow, "views">): boolean {
		try {
			this.db.prepare("INSERT INTO shares (code, document, delete_hash, created_at) VALUES (?, ?, ?, ?)")
				.run(row.code, row.document, row.deleteHash, row.createdAt);
			return true;
		} catch (e) {
			if (e instanceof Error && /UNIQUE/.test(e.message)) return false;
			throw e;
		}
	}

	/** The share with this code, counting a view. */
	viewShare(code: string): ShareRow | undefined {
		const row = this.db.prepare("UPDATE shares SET views = views + 1 WHERE code = ? RETURNING code, document, delete_hash, created_at, views")
			.get(code) as Record<string, unknown> | undefined;
		return row && {
			code: String(row.code),
			document: String(row.document),
			deleteHash: String(row.delete_hash),
			createdAt: Number(row.created_at),
			views: Number(row.views),
		};
	}

	deleteHashOf(code: string): string | undefined {
		const row = this.db.prepare("SELECT delete_hash FROM shares WHERE code = ?").get(code) as { delete_hash: string } | undefined;
		return row?.delete_hash;
	}

	deleteShare(code: string): void {
		this.db.prepare("DELETE FROM shares WHERE code = ?").run(code);
	}

	/**
	 * A copy of the whole database at `dir/myriad-<date>.db` (SQLite's `VACUUM INTO`, consistent while the API runs),
	 * keeping the newest `keep`. Local, against bad writes; copies off the server are made outside the API.
	 */
	backup(dir: string, date: Date, keep = 7): void {
		mkdirSync(dir, { recursive: true });
		const file = join(dir, `myriad-${date.toISOString().slice(0, 10)}.db`);
		if (!existsSync(file)) this.db.prepare("VACUUM INTO ?").run(file);
		const old = readdirSync(dir).filter(f => /^myriad-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -keep);
		for (const f of old) rmSync(join(dir, f));
	}

	close(): void {
		this.db.close();
	}
}
