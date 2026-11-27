import { BlockList, isIP } from "node:net";

/** Addresses only our own network can have: the proxies in front of the API (Traefik, cloudflared) connect from these. */
const OWN_NETWORK = new BlockList();
OWN_NETWORK.addSubnet("10.0.0.0", 8, "ipv4");
OWN_NETWORK.addSubnet("172.16.0.0", 12, "ipv4");
OWN_NETWORK.addSubnet("192.168.0.0", 16, "ipv4");
OWN_NETWORK.addSubnet("127.0.0.0", 8, "ipv4");
OWN_NETWORK.addSubnet("fc00::", 7, "ipv6");
OWN_NETWORK.addAddress("::1", "ipv6");

/** Whether an address is on our own network (a proxy of ours), never a client on the internet. */
export function ownNetwork(address: string | undefined): boolean {
	if (!address) return false;
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
	const a = mapped ? mapped[1]! : address;
	switch (isIP(a)) {
		case 4:
			return OWN_NETWORK.check(a, "ipv4");
		case 6:
			return OWN_NETWORK.check(a, "ipv6");
		default:
			return false;
	}
}

/**
 * The client a request comes from, as a rate-limit key.
 *
 * Behind {@code trustedProxies} proxies, X-Forwarded-For ends with the addresses they appended; the entry the
 * outermost one appended is the client. Entries to its left come from the request itself and can say anything, so
 * they're never used.
 *
 * A proxy's entry is only believed when whoever handed the request to that proxy is one of ours: the socket must be on
 * our own network (else the request reached the API directly and its header is the sender's own words), and each
 * proxy in between must have been reached from our own network too. So a request that skips the tunnel and hits the
 * front proxy straight from the internet is keyed by its real address, however it fills the header.
 *
 * An IPv6 client is its /64 (one household or server can rotate through a whole /64).
 */
export function clientKey(forwardedFor: string | undefined, socketAddress: string | undefined, trustedProxies: number, edgeClient?: string): string {
	if (trustedProxies <= 0 || !ownNetwork(socketAddress)) return keyOf(socketAddress);
	const hops = (forwardedFor ?? "").split(",").map(s => s.trim()).filter(Boolean);
	// Cloudflare names the visitor in CF-Connecting-IP (the front proxy replaces X-Forwarded-For with the tunnel's own
	// address). Believed only when every hop is our own network, i.e. it came through the tunnel: a request that reached
	// the front proxy from the internet carries its real address as a hop and is keyed by that instead.
	const edge = edgeClient?.trim();
	if (edge && isIP(edge) && hops.every(ownNetwork)) return keyOf(edge);
	if (hops.length === 0) return keyOf(socketAddress);
	// hops[last] is who connected to the innermost proxy; step left only past addresses of our own proxies.
	let i = hops.length - 1;
	for (let step = 1; step < trustedProxies && i > 0 && ownNetwork(hops[i]); step++) i--;
	return keyOf(hops[i]);
}

/**
 * The shape of a forwarded chain without any address in it (addresses are never logged): how many hops, and which are
 * on our own network. Logged once after start, so a deploy shows whether the proxies chain the way {@link clientKey}
 * expects.
 */
export function forwardedShape(forwardedFor: string | undefined, socketAddress: string | undefined, edgeClient?: string): string {
	const hops = (forwardedFor ?? "").split(",").map(s => s.trim()).filter(Boolean);
	const kind = (a: string | undefined) => (ownNetwork(a) ? "own" : isIP(a ?? "") || /^::ffff:/i.test(a ?? "") ? "internet" : "invalid");
	return `socket ${kind(socketAddress)}; forwarded [${hops.map(kind).join(", ")}]; cf-connecting-ip ${edgeClient ? kind(edgeClient.trim()) : "absent"}`;
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
