import { isIP } from "node:net";

/**
 * The client a request comes from, as a rate-limit key.
 *
 * Behind {@code trustedProxies} proxies, X-Forwarded-For ends with the addresses they appended; the entry the
 * outermost one appended is the client. Entries to its left come from the request itself and can say anything, so
 * they're never used. An IPv6 client is its /64 (one household or server can rotate through a whole /64).
 */
export function clientKey(forwardedFor: string | undefined, socketAddress: string | undefined, trustedProxies: number): string {
	let address = socketAddress;
	if (trustedProxies > 0) {
		const hops = (forwardedFor ?? "").split(",").map(s => s.trim()).filter(Boolean);
		address = hops.length >= trustedProxies ? hops[hops.length - trustedProxies] : undefined;
	}
	return keyOf(address);
}

function keyOf(address: string | undefined): string {
	if (!address) return "unknown";
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
	if (mapped) return mapped[1]!;
	switch (isIP(address)) {
		case 4:
			return address;
		case 6:
			return `${expand(address).slice(0, 4).join(":")}::/64`;
		default:
			return "invalid";
	}
}

/** An IPv6 address as its eight groups. */
function expand(address: string): string[] {
	const [head = "", tail] = address.split("::");
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const zeros = tail === undefined ? [] : Array(8 - left.length - right.length).fill("0");
	return [...left, ...zeros, ...right].map(g => g.toLowerCase().padStart(4, "0"));
}
