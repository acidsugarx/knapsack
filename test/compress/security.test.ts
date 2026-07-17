import { describe, expect, it } from "vitest";
import { detectSecrets, redactSecrets } from "../../src/core/security.js";

describe("security", () => {
	it("detects a JWT", () => {
		const jwt =
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
		const findings = detectSecrets(`Authorization: Bearer ${jwt}`);
		expect(findings.length).toBe(1);
		expect(findings[0]?.kind).toBe("jwt");
	});

	it("detects AWS access key id", () => {
		const findings = detectSecrets("aws_access_key_id = AKIAIOSFODNN7EXAMPLE");
		expect(findings.length).toBe(1);
		expect(findings[0]?.kind).toBe("aws_access_key");
	});

	it("detects vendor tokens (GitHub PAT, Anthropic, Slack)", () => {
		const text = `ghp_${"a".repeat(36)} sk-ant-${"b".repeat(30)} xoxb-1234567890-abcdef`;
		const findings = detectSecrets(text);
		expect(findings.length).toBe(3);
		const kinds = findings.map((f) => f.kind);
		expect(kinds).toContain("vendor_token");
	});

	it("detects PEM private key blocks", () => {
		const text =
			"-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
		const findings = detectSecrets(text);
		expect(findings.length).toBe(1);
		expect(findings[0]?.kind).toBe("private_key");
	});

	it("does NOT flag generic 'token' or 'password' keywords (Headroom parity)", () => {
		// In LLM agent context these are CLI flags and env names, not secrets.
		const text = "TOKEN=my_token_value\npassword=prompt_user_for_it\nexport GITHUB_TOKEN";
		expect(detectSecrets(text).length).toBe(0);
	});

	it("redacts findings while leaving non-secret text intact", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature1234567890abcdefghij";
		const text = `boot...\nAuthorization: Bearer ${jwt}\nshutdown`;
		const findings = detectSecrets(text);
		const redacted = redactSecrets(text, findings);
		expect(redacted).toContain("<redacted:jwt>");
		expect(redacted).toContain("boot...");
		expect(redacted).toContain("shutdown");
		expect(redacted).not.toContain(jwt);
	});

	it("no-op when nothing matches", () => {
		expect(detectSecrets("plain output")).toEqual([]);
		expect(redactSecrets("plain output", [])).toBe("plain output");
	});
});
