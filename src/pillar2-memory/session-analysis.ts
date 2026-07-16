/**
 * Session analysis — `/knapsack-learn` command.
 *
 * Analyzes the current pi session for patterns and learnings:
 * 1. Failed tool calls → saved as gotchas
 * 2. Successful workarounds → saved as facts
 * 3. User corrections → saved as preferences
 * 4. Anchor-worthy decisions → suggested for drift detection
 *
 * Uses pi's session format: JSONL files in ~/.pi/agent/sessions/
 *
 * @module session-analysis
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnapsackDB } from "../core/database";
import type { KnapsackStore } from "../core/types";

/**
 * Result of session analysis.
 */
export interface SessionAnalysis {
	/** Tool calls that ended with errors */
	failedTools: Array<{ tool: string; error: string; timestamp: string }>;
	/** Total tool calls in the session */
	totalToolCalls: number;
	/** Patterns detected (repeated commands, common error types) */
	patterns: string[];
	/** Suggested memories to save */
	suggestions: Array<{ content: string; type: string; importance: number }>;
}

/**
 * Analyze a pi session file for learnings.
 *
 * Reads the JSONL session file, extracts tool calls and results,
 * identifies failures and patterns.
 *
 * @param sessionPath - Path to the .jsonl session file
 * @returns Session analysis with failed tools, patterns, suggestions
 */
export function analyzeSession(sessionPath: string): SessionAnalysis {
	const analysis: SessionAnalysis = {
		failedTools: [],
		totalToolCalls: 0,
		patterns: [],
		suggestions: [],
	};

	if (!existsSync(sessionPath)) return analysis;

	const lines = readFileSync(sessionPath, "utf-8").split("\n").filter(Boolean);

	const toolErrors: Record<string, number> = {};
	const commandCounts: Record<string, number> = {};

	for (const line of lines) {
		try {
			const entry = JSON.parse(line);
			if (!isToolResultEntry(entry)) continue;

			analysis.totalToolCalls++;

			const toolName = entry.toolName ?? "unknown";

			// Track command patterns
			if (toolName === "bash" && entry.input?.command) {
				const cmd = (entry.input.command as string).split(/\s+/)[0] ?? "unknown";
				commandCounts[cmd] = (commandCounts[cmd] ?? 0) + 1;
			}

			// Check for errors
			if (entry.isError || entry.details?.exitCode !== 0) {
				const errorMsg = extractErrorText(entry.content);
				analysis.failedTools.push({
					tool: toolName,
					error: errorMsg.slice(0, 200),
					timestamp: entry.timestamp ?? "",
				});
				toolErrors[toolName] = (toolErrors[toolName] ?? 0) + 1;
			}
		} catch {
			// Skip malformed lines
		}
	}

	// Detect patterns
	for (const [tool, count] of Object.entries(toolErrors)) {
		if (count >= 2) {
			analysis.patterns.push(`${tool} failed ${count} times`);
		}
	}
	for (const [cmd, count] of Object.entries(commandCounts)) {
		if (count >= 5) {
			analysis.patterns.push(`frequently used: ${cmd} (${count} times)`);
		}
	}

	// Generate suggestions
	analysis.suggestions = generateSuggestions(analysis);

	return analysis;
}

/**
 * Save analysis findings to memory.
 *
 * @param analysis - Session analysis result
 * @param db - Knapsack database
 * @param store - Runtime store
 * @returns Number of memories saved
 */
export function saveAnalysisToMemory(
	analysis: SessionAnalysis,
	db: KnapsackDB,
	store: KnapsackStore,
): number {
	let saved = 0;

	for (const suggestion of analysis.suggestions) {
		db.saveMemory({
			content: suggestion.content,
			type: suggestion.type as
				| "decision"
				| "fact"
				| "gotcha"
				| "convention"
				| "preference"
				| "command"
				| "constraint"
				| "hypothesis",
			scope: "project",
			project: store.projectRoot ?? undefined,
			importance: suggestion.importance,
			sourceSession: store.sessionId ?? undefined,
		});
		saved++;
	}

	return saved;
}

/**
 * Format analysis for display in `/knapsack-learn` command.
 */
export function formatAnalysis(analysis: SessionAnalysis): string {
	const lines: string[] = [
		"🎒 Knapsack Session Analysis",
		"────────────────────────────",
		`Total tool calls: ${analysis.totalToolCalls}`,
		`Failed calls: ${analysis.failedTools.length}`,
		"",
	];

	if (analysis.patterns.length > 0) {
		lines.push("Patterns:");
		for (const p of analysis.patterns) {
			lines.push(`  • ${p}`);
		}
		lines.push("");
	}

	if (analysis.suggestions.length > 0) {
		lines.push(`Saved ${analysis.suggestions.length} memories:`);
		for (const s of analysis.suggestions) {
			lines.push(`  • [${s.type}] ${s.content.slice(0, 80)}`);
		}
	} else {
		lines.push("No new learnings to save.");
	}

	return lines.join("\n");
}

// ── Helpers ─────────────────────────────────────────────

function isToolResultEntry(entry: unknown): boolean {
	if (typeof entry !== "object" || entry === null) return false;
	const e = entry as Record<string, unknown>;
	return (
		e.role === "toolResult" ||
		e.type === "toolResult" ||
		(e.toolName !== undefined && e.content !== undefined)
	);
}

function extractErrorText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b): b is { text: string } => b?.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join(" ");
	}
	return "Unknown error";
}

function generateSuggestions(
	analysis: SessionAnalysis,
): Array<{ content: string; type: string; importance: number }> {
	const suggestions: Array<{ content: string; type: string; importance: number }> = [];

	// Deduplicate failed tools by error pattern
	const seenErrors = new Set<string>();

	for (const fail of analysis.failedTools) {
		const key = `${fail.tool}:${fail.error.slice(0, 50)}`;
		if (seenErrors.has(key)) continue;
		seenErrors.add(key);

		suggestions.push({
			content: `${fail.tool} error: ${fail.error}`,
			type: "gotcha",
			importance: 0.7,
		});
	}

	// Limit to avoid flooding
	return suggestions.slice(0, 5);
}
