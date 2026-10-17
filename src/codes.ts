import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A share code: {@code myriad_} and six letters or digits (62^6, about 57 billion). */
export const CODE = /^myriad_[A-Za-z0-9]{6}$/;

export function newCode(): string {
	let code = "myriad_";
	for (let i = 0; i < 6; i++) code += ALPHABET[randomInt(ALPHABET.length)];
	return code;
}

/** The secret that deletes a share: given to its publisher once, stored only as a hash. */
export function newDeleteKey(): string {
	return randomBytes(24).toString("base64url");
}

export function hashKey(key: string): string {
	return createHash("sha256").update(key).digest("hex");
}

/** Whether {@code key} is the one {@code hash} was made from (in constant time). */
export function keyMatches(key: string, hash: string): boolean {
	const a = Buffer.from(hashKey(key), "hex");
	const b = Buffer.from(hash, "hex");
	return a.length === b.length && timingSafeEqual(a, b);
}
