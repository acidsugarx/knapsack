/**
 * Manual test: sliceable CCR retrieval.
 *
 * Usage: npx tsx scripts/test-sliceable-retrieval.ts
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cache, retrieve } from "../src/pillar1-compression/ccr";

const SAMPLE = [
	"INFO  Starting server on port 3000",
	"WARN  Deprecated middleware 'legacyAuth'",
	"INFO  Connected to database",
	"ERROR Failed to connect to Redis at localhost:6379",
	"INFO  Loading routes",
	"ERROR Missing env variable 'API_KEY'",
	"INFO  Server ready",
	"FATAL Port 3000 already in use — shutting down",
].join("\n");

function test(label: string, ok: boolean) {
	console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
}

const home = join(tmpdir(), `knapsack-slice-test-${Date.now()}`);
mkdirSync(home, { recursive: true });
const h = cache(home, null, "deadbeef1234".repeat(4), SAMPLE) as string;

// Cleanup
process.on("exit", () => {
	try {
		rmSync(home, { recursive: true, force: true });
	} catch {
		/* */
	}
});

// Full retrieve (backward compat)
const full = retrieve(home, null, h);
test("full retrieve (backward compat)", full === SAMPLE);

// grep=ERROR
const errors = retrieve(home, null, h, { grep: "ERROR" });
test(
	"grep=ERROR returns only error lines",
	errors !== null &&
		errors!.includes("Failed to connect") &&
		errors!.includes("Missing env") &&
		!errors!.includes("INFO"),
);

// grep=WARN
const warnings = retrieve(home, null, h, { grep: "WARN" });
test(
	"grep=WARN returns warning line",
	warnings !== null && warnings!.includes("Deprecated middleware") && !warnings!.includes("ERROR"),
);

// lines=4-6
const lines = retrieve(home, null, h, { lines: "4-6" });
test(
	"lines=4-6 returns correct range",
	lines !== null &&
		lines!.includes("Failed to connect") &&
		lines!.includes("Loading routes") &&
		lines!.includes("Missing env"),
);

// head=3
const head = retrieve(home, null, h, { head: 3 });
test(
	"head=3 returns first 3 lines",
	head !== null &&
		head!.includes("Starting server") &&
		head!.includes("Deprecated middleware") &&
		head!.includes("Connected to database") &&
		!head!.includes("Failed to connect"),
);

// tail=2
const tail = retrieve(home, null, h, { tail: 2 });
test(
	"tail=2 returns last 2 lines",
	tail !== null && tail!.includes("Server ready") && tail!.includes("Port 3000"),
);

// invalid hash
const invalid = retrieve(home, null, "zzzzz");
test("invalid hash returns null", invalid === null);

console.log("\nDone.");
