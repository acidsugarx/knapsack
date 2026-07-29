import { describe, expect, it } from "vitest";
import {
	formatGitDiff,
	formatGitLog,
	formatGitStatus,
	matchGit,
} from "../../src/core/command-formatters/git.js";
import { formatCommandOutput } from "../../src/core/command-formatters/index.js";
import {
	formatNpmInstall,
	formatNpmTest,
	matchNpm,
} from "../../src/core/command-formatters/npm.js";
import { formatPytest, matchPytest } from "../../src/core/command-formatters/python.js";
import {
	formatCargoBuild,
	formatCargoTest,
	matchCargo,
} from "../../src/core/command-formatters/rust.js";
import { formatGoTest, matchGoTest } from "../../src/core/command-formatters/test-runners.js";

const REAL_GIT_STATUS = `On branch feat/cross-agent
Changes to be committed:
  (use "git restore --staged <file>..." to unstage)
	new file:   src/core/command-formatters/index.ts
	new file:   src/core/command-formatters/git.ts
	modified:   src/core/pipeline.ts

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git checkout -- <file>..." to discard changes in working directory)
	modified:   src/adapters/opencode/plugin.ts
	modified:   test/core/pipeline.test.ts

Untracked files:
  (use "git add <file>..." to include in what will be committed)
	src/core/command-formatters/
	scripts/test-command-formatters.ts
`;

const REAL_GIT_DIFF = `diff --git a/src/core/pipeline.ts b/src/core/pipeline.ts
index 1234567..abcdefg 100644
--- a/src/core/pipeline.ts
+++ b/src/core/pipeline.ts
@@ -30,6 +30,8 @@
 import { checkDrift } from "../pillar2-memory/drift";
 import { commandTracker } from "./command-tracker";
+import { formatCommandOutput } from "./command-formatters";
+import { recordCompressionForStats } from "./retrieval-stats";
 import type { KnapsackDB } from "./database";
 import { sha256 } from "./hash";
@@ -95,6 +97,20 @@
 	if (params.command && toolName.toLowerCase() === "bash") {
 		const delta = commandTracker.check(params.command, contentText);
+		if (delta.type === "identical") {
+			return { content: [{ type: "text", text: delta.marker }] };
+		}
 	}
+	// Per-command formatters
+	if (params.command) {
+		const formatted = formatCommandOutput({
+			output: contentText,
+			command: params.command,
+		});
+	}
`;

const REAL_GIT_LOG = `commit a1b2c3d4e5f6789012345678901234567890abcd
Author: John Doe <john@example.com>
Date:   Mon Jul 26 12:00:00 2026 +0300

    feat: add per-command formatters

    Implements git/npm/pytest/cargo formatters with semantic output parsing.

commit b2c3d4e5f6789012345678901234567890abcdef01
Author: Jane Smith <jane@example.com>
Date:   Sun Jul 25 18:30:00 2026 +0300

    fix: NaN importance in saveMemory

commit c3d4e5f6789012345678901234567890abcdef012
Author: John Doe <john@example.com>
Date:   Sat Jul 24 10:15:00 2026 +0300

    refactor: extract core pipeline from Pi hook
`;

const REAL_NPM_INSTALL =
	[
		"npm warn deprecated some-package@1.0.0: Use newer-package instead",
		"npm warn deprecated another@2.0.0: No longer maintained",
		"",
		"npm warn install",
		"",
	].join("\n") +
	"\n" +
	Array.from(
		{ length: 50 },
		(_, i) =>
			`npm ${i % 2 === 0 ? "reify" : "fetch"} node_modules/${i} [###---------------------------]`,
	).join("\n") +
	"\n\n" +
	[
		"added 42 packages, and audited 43 packages in 3s",
		"",
		"7 packages are looking for funding",
		"  run `npm fund` for details",
		"",
		"found 0 vulnerabilities",
		"",
	].join("\n");

const REAL_PYTEST = `============================= test session starts ==============================
platform linux -- Python 3.12.0, pytest-8.0.0, pluggy-1.4.0
rootdir: /home/user/project
collected 15 items

tests/test_auth.py::test_login PASSED                              [  6%]
tests/test_auth.py::test_logout PASSED                             [ 13%]
tests/test_auth.py::test_invalid_token FAILED                      [ 20%]
tests/test_users.py::test_create_user PASSED                       [ 26%]
tests/test_users.py::test_delete_user PASSED                       [ 33%]
tests/test_users.py::test_update_user FAILED                       [ 40%]
tests/test_api.py::test_get_status PASSED                          [ 46%]
tests/test_api.py::test_post_data PASSED                           [ 53%]
tests/test_api.py::test_delete_resource PASSED                     [ 60%]
tests/test_api.py::test_rate_limit PASSED                          [ 66%]
tests/test_api.py::test_auth_header PASSED                         [ 73%]
tests/test_utils.py::test_format_date PASSED                       [ 80%]
tests/test_utils.py::test_parse_input PASSED                       [ 86%]
tests/test_utils.py::test_validate_email SKIPPED                   [ 93%]
tests/test_utils.py::test_sanitize_input PASSED                    [100%]

=================================== FAILURES ===================================
___________________________ test_invalid_token ____________________________
    def test_invalid_token():
>       assert auth.validate("invalid") == False
E       AssertionError: assert True == False
E        +  where True = auth.validate("invalid")

tests/test_auth.py:15: AssertionError
___________________________ test_update_user ____________________________
    def test_update_user():
>       response = client.put("/api/users/1", json={"name": ""})
E       AssertionError: assert response.status_code == 400
E        +  where 200 = response.status_code

tests/test_users.py:28: AssertionError
=========================== short test summary info ============================
FAILED tests/test_auth.py::test_invalid_token - AssertionError: assert True == False
FAILED tests/test_users.py::test_update_user - AssertionError: assert response.status_code == 400
======================== 13 passed, 2 failed, 1 skipped in 0.8s =========================
`;

const REAL_CARGO_TEST = `running 8 tests
test tests::test_basic ... ok
test tests::test_compression ... ok
test tests::test_cache_hit ... ok
test tests::test_cache_miss ... ok
test tests::test_dedup ... ok
test tests::test_redaction ... FAILED
test tests::test_tag_protector ... ok
test tests::test_secret_detect ... ok

---- tests::test_redaction stdout ----
thread 'tests::test_redaction' panicked at 'assertion failed: result.contains("<redacted>")', src/lib.rs:45:5

test result: FAILED. 7 passed; 1 failed; 0 ignored; 0 measured; 0 measured
`;

describe("command formatters — git", () => {
	it("matches git status command", () => {
		expect(matchGit("git status", "status")).toBe(true);
		expect(matchGit("git status --short", "status")).toBe(true);
		expect(matchGit("git log", "status")).toBe(false);
	});

	it("formats git status with real output", () => {
		const result = formatGitStatus(REAL_GIT_STATUS, "git status");
		expect(result).not.toBeNull();
		expect(result!.strategy).toBe("git-status");
		expect(result!.body).toContain("Staged: 3");
		expect(result!.body).toContain("new: 2");
		expect(result!.body).toContain("Modified: 2");
		expect(result!.body).toContain("Untracked: 2");
		expect(result!.savingsPercent).toBeGreaterThan(40);
	});

	it("formats git diff with context reduction", () => {
		const result = formatGitDiff(REAL_GIT_DIFF);
		expect(result).not.toBeNull();
		expect(result!.strategy).toBe("git-diff");
		expect(result!.body).toContain("context lines");
		expect(result!.savingsPercent).toBeGreaterThan(20);
	});

	it("formats git log to hash + author + subject", () => {
		const result = formatGitLog(REAL_GIT_LOG);
		expect(result).not.toBeNull();
		expect(result!.strategy).toBe("git-log");
		expect(result!.body).toContain("a1b2c3d");
		expect(result!.body).toContain("John Doe");
		expect(result!.body).toContain("feat: add per-command formatters");
		expect(result!.body).not.toContain("Implements git/npm");
		expect(result!.savingsPercent).toBeGreaterThan(60);
	});

	it("returns null for non-git output", () => {
		expect(formatGitStatus("hello world", "echo hello")).toBeNull();
	});
});

describe("command formatters — npm", () => {
	it("matches npm install", () => {
		expect(matchNpm("npm install", "install")).toBe(true);
		expect(matchNpm("pnpm add react", "install")).toBe(true);
		expect(matchNpm("npm test", "install")).toBe(false);
	});

	it("formats npm install — strips progress, keeps summary", () => {
		const result = formatNpmInstall(REAL_NPM_INSTALL);
		expect(result).not.toBeNull();
		expect(result!.strategy).toBe("npm-install");
		expect(result!.body).toContain("added 42 packages");
		expect(result!.body).toContain("npm warn");
		expect(result!.savingsPercent).toBeGreaterThan(30);
	});
});

describe("command formatters — pytest", () => {
	it("matches pytest", () => {
		expect(matchPytest("pytest tests/")).toBe(true);
		expect(matchPytest("python -m pytest")).toBe(true);
		expect(matchPytest("ls")).toBe(false);
	});

	it("formats pytest — failures only, passing collapsed to count", () => {
		const result = formatPytest(REAL_PYTEST, 1);
		expect(result).not.toBeNull();
		expect(result!.strategy).toBe("pytest");
		expect(result!.body).toContain("Passed: 12");
		expect(result!.body).toContain("Failed: 2");
		expect(result!.body).toContain("Skipped: 1");
		expect(result!.body).toContain("test_invalid_token");
		expect(result!.body).toContain("test_update_user");
		expect(result!.body).toContain("AssertionError");
		expect(result!.savingsPercent).toBeGreaterThan(40);
	});

	it("preserves traceback lines in failures", () => {
		const result = formatPytest(REAL_PYTEST, 1);
		expect(result!.body).toContain("assert True == False");
		expect(result!.body).toContain("assert response.status_code == 400");
	});
});

describe("command formatters — cargo", () => {
	it("matches cargo build/test", () => {
		expect(matchCargo("cargo build", "build")).toBe(true);
		expect(matchCargo("cargo test", "test")).toBe(true);
		expect(matchCargo("cargo build", "test")).toBe(false);
	});

	it("formats cargo test — failures only", () => {
		const result = formatCargoTest(REAL_CARGO_TEST);
		expect(result).not.toBeNull();
		expect(result!.strategy).toBe("cargo-test");
		expect(result!.body).toContain("Passed: 7");
		expect(result!.body).toContain("Failed: 1");
		expect(result!.body).toContain("test_redaction");
		expect(result!.body).toContain("panicked");
		expect(result!.savingsPercent).toBeGreaterThan(30);
	});
});

describe("command formatters — registry dispatch", () => {
	it("dispatches git status to git formatter", () => {
		const result = formatCommandOutput({ output: REAL_GIT_STATUS, command: "git status" });
		expect(result).not.toBeNull();
		expect(result!.strategy).toBe("git-status");
	});

	it("dispatches pytest to pytest formatter", () => {
		const result = formatCommandOutput({
			output: REAL_PYTEST,
			command: "pytest tests/",
			exitCode: 1,
		});
		expect(result).not.toBeNull();
		expect(result!.strategy).toBe("pytest");
	});

	it("returns null for unrecognized command", () => {
		const result = formatCommandOutput({ output: "hello", command: "echo hello" });
		expect(result).toBeNull();
	});

	it("returns null for empty command", () => {
		const result = formatCommandOutput({ output: "hello", command: "" });
		expect(result).toBeNull();
	});

	it("formats go test output with failures", () => {
		const output = [
			"=== RUN   TestPass",
			"--- PASS: TestPass (0.00s)",
			"=== RUN   TestFail",
			"--- FAIL: TestFail (0.00s)",
			"    foo_test.go:10: expected 5, got 3",
			"FAIL",
			"FAIL\texample.com/pkg\t0.123s",
		].join("\n");
		const result = formatGoTest(output);
		expect(result).not.toBeNull();
		expect(result!.strategy).toBe("go-test");
		expect(result!.body).toContain("Failed: 1");
		expect(result!.body).toContain("expected 5, got 3");
	});

	it("formats go test output with all passing", () => {
		const output = [
			"=== RUN   TestA",
			"--- PASS: TestA (0.00s)",
			"=== RUN   TestB",
			"--- PASS: TestB (0.00s)",
			"ok  \texample.com/pkg\t0.050s",
		].join("\n");
		const result = formatGoTest(output);
		expect(result).not.toBeNull();
		expect(result!.body).toContain("Passed: 1");
	});

	it("go test not recognized for non-test output", () => {
		expect(formatGoTest("hello world")).toBeNull();
		expect(matchGoTest("go build")).toBe(false);
		expect(matchGoTest("go test ./...")).toBe(true);
	});

	it("dispatches go test via command formatter registry", () => {
		const output = [
			"=== RUN   TestX",
			"--- FAIL: TestX (0.00s)",
			"    x_test.go:5: expected nil",
			"FAIL\tpkg\t0.001s",
		].join("\n");
		const result = formatCommandOutput({ output, command: "go test ./..." });
		expect(result).not.toBeNull();
		expect(result!.strategy).toBe("go-test");
	});
});
