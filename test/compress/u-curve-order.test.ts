import { describe, expect, it } from "vitest";
import { compressBash } from "../../src/pillar1-compression/strategies/bash.js";
import { compressJson } from "../../src/pillar1-compression/strategies/json.js";

describe("U-curve position optimization", () => {
	describe("bash strategy — errors at top, tail at bottom", () => {
		it("places ERRORS section before TEMPLATES", () => {
			const lines: string[] = [];
			for (let i = 0; i < 100; i++) lines.push(`[INFO] Compiling module_${i}...`);
			lines.push("[ERROR] Failed to compile module D");
			const result = compressBash(lines.join("\n"), "", 1);
			const errorIdx = result.body.indexOf("── ERRORS");
			const templateIdx = result.body.indexOf("── TEMPLATES");
			expect(errorIdx).toBeGreaterThan(-1);
			if (templateIdx > -1) {
				expect(errorIdx).toBeLessThan(templateIdx);
			}
		});

		it("places ERRORS section before WARNINGS", () => {
			const lines: string[] = [];
			for (let i = 0; i < 100; i++) lines.push(`[INFO] Processing ${i}...`);
			lines.push("[WARN] Deprecated API");
			lines.push("[ERROR] Connection refused");
			const result = compressBash(lines.join("\n"), "", 1);
			const errorIdx = result.body.indexOf("── ERRORS");
			const warnIdx = result.body.indexOf("── WARNINGS");
			expect(errorIdx).toBeLessThan(warnIdx);
		});

		it("places TAIL section last", () => {
			const lines: string[] = [];
			for (let i = 0; i < 100; i++) lines.push(`[INFO] Processing ${i}...`);
			lines.push("[ERROR] Failed");
			lines.push("final line output");
			const result = compressBash(lines.join("\n"), "", 1);
			const tailIdx = result.body.indexOf("── TAIL");
			const errorIdx = result.body.indexOf("── ERRORS");
			expect(tailIdx).toBeGreaterThan(errorIdx);
		});

		it("errors appear in first 5 lines of output", () => {
			const lines: string[] = [];
			for (let i = 0; i < 200; i++) lines.push(`[INFO] Step ${i} completed`);
			lines.push("[ERROR] Critical failure at step 150");
			const result = compressBash(lines.join("\n"), "", 1);
			const firstLines = result.body.split("\n").slice(0, 5).join("\n");
			expect(firstLines).toContain("ERROR");
		});
	});

	describe("json strategy — shape before samples", () => {
		it("places Shape before First/Last items", () => {
			const items = Array.from({ length: 50 }, (_, i) => ({
				id: i,
				name: `User_${i}`,
				active: i % 2 === 0,
			}));
			const result = compressJson(JSON.stringify(items));
			const shapeIdx = result.body.indexOf("Shape:");
			const firstIdx = result.body.indexOf("First:");
			expect(shapeIdx).toBeGreaterThan(-1);
			expect(firstIdx).toBeGreaterThan(-1);
			expect(shapeIdx).toBeLessThan(firstIdx);
		});

		it("places Stats before Samples", () => {
			const items = Array.from({ length: 50 }, (_, i) => ({
				id: i,
				value: i * 10,
			}));
			const result = compressJson(JSON.stringify(items));
			const statsIdx = result.body.indexOf("Stats:");
			const samplesIdx = result.body.indexOf("Samples:");
			if (statsIdx > -1 && samplesIdx > -1) {
				expect(statsIdx).toBeLessThan(samplesIdx);
			}
		});

		it("places Cardinality before First/Last items", () => {
			const items = Array.from({ length: 50 }, (_, i) => ({
				id: i,
				status: i % 2 === 0 ? "active" : "inactive",
			}));
			const result = compressJson(JSON.stringify(items));
			const cardIdx = result.body.indexOf("Cardinality:");
			const firstIdx = result.body.indexOf("First:");
			if (cardIdx > -1) {
				expect(cardIdx).toBeLessThan(firstIdx);
			}
		});
	});
});
