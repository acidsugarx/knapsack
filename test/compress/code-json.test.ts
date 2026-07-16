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
