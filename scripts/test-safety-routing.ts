/**
 * Manual test: safety routing passthrough behavior.
 *
 * Usage: npx tsx scripts/test-safety-routing.ts
 *
 * Verifies that stack traces, private keys, SQL migrations, and binary
 * data pass through the pipeline uncompressed.
 */

import { checkSafety } from "../src/core/safety-router";

function test(label: string, output: string, expectPassthrough: boolean) {
	const result = checkSafety(output, "bash");
	const pass = result.shouldPassthrough === expectPassthrough;
	const status = pass ? "PASS" : "FAIL";
	console.log(
		`${status}: ${label} — ${result.shouldPassthrough ? `PASSTHROUGH (${result.reason})` : "COMPRESS"}`,
	);
}

// Stack trace
test(
	"JS stack trace",
	[
		"Error: something broke",
		"    at foo (/app/src/bar.ts:10:5)",
		"    at Module._compile (...)",
	].join("\n"),
	true,
);

// Python traceback
test(
	"Python Traceback",
	[
		"Traceback (most recent call last):",
		'  File "app.py", line 10',
		"    main()",
		"ValueError: bad input",
	].join("\n"),
	true,
);

// PEM private key
test(
	"PEM private key",
	["-----BEGIN RSA PRIVATE KEY-----", "MIIEpAIBAAKCAQEA...", "-----END RSA PRIVATE KEY-----"].join(
		"\n",
	),
	true,
);

// SQL migration
test(
	"SQL migration",
	["CREATE TABLE users (", "  id INTEGER PRIMARY KEY,", "  name TEXT NOT NULL", ");"].join("\n"),
	true,
);

// Normal output
test("normal ls output", "total 24\ndrwxr-xr-x  5 user  staff  160 Jul 29 12:00 .\n", false);

// Normal grep output
test("normal grep output", "src/index.ts:10:import { foo } from './bar'\n", false);

// Empty
test("empty output", "", false);

console.log("\nDone.");
