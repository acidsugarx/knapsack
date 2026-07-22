import { describe, expect, it } from "vitest";
import { compressCode } from "../../src/pillar1-compression/strategies/code";
import { compressJson } from "../../src/pillar1-compression/strategies/json";

describe("compressCode", () => {
	const sample = `
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface User {
  id: string;
  name: string;
  email: string;
}

export class UserService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async findById(id: string): Promise<User | null> {
    const row = await this.db.query("SELECT * FROM users WHERE id = ?", [id]);
    if (!row) return null;
    return this.mapRow(row);
  }

  async create(data: CreateUserDTO): Promise<User> {
    const id = crypto.randomUUID();
    await this.db.query("INSERT INTO users (...) VALUES (...)", [id, data.name, data.email]);
    return { id, ...data };
  }

  private mapRow(row: Record<string, unknown>): User {
    return {
      id: row.id as string,
      name: row.name as string,
      email: row.email as string,
    };
  }
}

export type UserRole = "admin" | "user" | "guest";

export function validateUser(data: unknown): asserts data is User {
  if (typeof data !== "object" || data === null) throw new Error("Invalid user");
}
`.trim();

	it("extracts imports", () => {
		const result = compressCode(sample);
		expect(result.body).toContain("node:fs");
		expect(result.body).toContain("@earendil-works/pi-coding-agent");
	});

	it("extracts exports", () => {
		const result = compressCode(sample);
		expect(result.body).toContain("export interface User");
		expect(result.body).toContain("export class UserService");
		expect(result.body).toContain("export type UserRole");
	});

	it("extracts signatures and collapses bodies", () => {
		const result = compressCode(sample);
		expect(result.body).toContain("findById");
		expect(result.body).toContain("create");
		expect(result.body).toContain("{…}"); // bodies collapsed
	});

	it("reduces token count significantly", () => {
		const result = compressCode(sample);
		expect(result.compressedTokens).toBeLessThan(result.originalTokens);
		expect(result.savingsPercent).toBeGreaterThan(20);
		expect(result.strategy).toBe("code");
	});

	it("handles empty source", () => {
		const result = compressCode("");
		expect(result.originalTokens).toBe(0);
	});
});

describe("compressJson", () => {
	it("collapses JSON array to shape + samples", () => {
		// Use larger data so compression actually saves tokens
		const items = Array.from({ length: 20 }, (_, i) => ({
			id: i + 1,
			name: `User_${i + 1}`,
			age: 20 + i,
			email: `user${i + 1}@example.com`,
			active: i % 2 === 0,
		}));
		const data = JSON.stringify(items);
		const result = compressJson(data);
		expect(result.body).toContain("ARRAY");
		expect(result.body).toContain("Shape");
		expect(result.compressedTokens).toBeLessThan(result.originalTokens);
		expect(result.strategy).toBe("json");
	});

	it("collapses JSON object to shape", () => {
		const data = JSON.stringify({ name: "test", count: 42, enabled: true });
		const result = compressJson(data);
		expect(result.body).toContain("OBJECT");
		expect(result.body).toContain("Shape");
		expect(result.body).toContain("name: string");
	});

	it("handles invalid JSON gracefully", () => {
		const result = compressJson("not json");
		expect(result.savingsPercent).toBe(0);
		expect(result.strategy).toBe("json");
	});

	it("handles nested objects", () => {
		const data = JSON.stringify({ user: { name: "Alice", settings: { theme: "dark" } } });
		const result = compressJson(data);
		expect(result.body).toContain("OBJECT");
		expect(result.body).toContain("user: object");
	});
});

describe("compressJson — recursive shape inference", () => {
	it("inlines nested object shapes up to MAX_DEPTH", () => {
		const data = JSON.stringify({
			user: { name: "Alice", profile: { age: 30, address: { city: "NYC" } } },
		});
		const result = compressJson(data);
		expect(result.body).toContain("user: object{");
		expect(result.body).toContain("profile:object{");
		expect(result.body).toContain("name:string");
	});

	it("reports nested arrays of objects", () => {
		const data = JSON.stringify({
			items: [{ id: 1, name: "foo" }],
		});
		const result = compressJson(data);
		expect(result.body).toContain("items: array{");
		expect(result.body).toContain("id:number");
		expect(result.body).toContain("name:string");
	});
});

describe("compressJson — outlier detection", () => {
	it("reports stddev and outliers in stats", () => {
		const items = Array.from({ length: 20 }, (_, i) => ({
			id: i + 1,
			value: i < 19 ? i * 10 : 99999,
		}));
		const data = JSON.stringify(items);
		const result = compressJson(data);
		expect(result.body).toContain("σ=");
		expect(result.body).toContain("outliers=");
		expect(result.body).toContain("value:");
	});
});

describe("compressJson — cardinality", () => {
	it("classifies unique keys", () => {
		const items = Array.from({ length: 10 }, (_, i) => ({
			id: i + 1,
			status: i % 2 === 0 ? "active" : "inactive",
		}));
		const data = JSON.stringify(items);
		const result = compressJson(data);
		expect(result.body).toContain("Cardinality:");
		expect(result.body).toContain("id: unique");
		expect(result.body).toContain("status: enum(2)");
	});

	it("classifies varied cardinality", () => {
		const items = Array.from({ length: 20 }, (_, i) => ({
			category: `cat_${i % 8}`,
		}));
		const data = JSON.stringify(items);
		const result = compressJson(data);
		expect(result.body).toContain("category: 8/20 unique");
	});
});

describe("compressJson — mixed-type arrays", () => {
	it("detects and reports mixed element types", () => {
		const data = JSON.stringify(["hello", 42, { id: 1 }, true, "world", 99]);
		const result = compressJson(data);
		expect(result.body).toContain("mixed(");
		expect(result.body).toContain("string");
		expect(result.body).toContain("number");
	});

	it("reports single-type arrays correctly", () => {
		const data = JSON.stringify([1, 2, 3, 4, 5]);
		const result = compressJson(data);
		expect(result.body).toContain("type: number");
	});
});
