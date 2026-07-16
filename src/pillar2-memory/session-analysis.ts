/**
 * Session analysis — Headroom-style failure learning with success correlation.
 *
 * ## Two-pass parsing
 *
 * Pass 1: Collect toolCall entries from assistant messages (id → {tool, args})
 * Pass 2: Collect toolResult entries (toolCallId → {success, error})
 * Merge into timeline with full arguments.
 *
 * ## What it extracts
 *
 * 1. File path corrections (failed read → successful read of same file)
 * 2. Command corrections (failed bash → what worked instead)
 * 3. User corrections ("no, use X instead of Y")
 * 4. Repeated failures (same error 3+ times)
 * 5. File access frequency (files accessed often = project structure knowledge)
 *
 * @module session-analysis
 */

import { existsSync, readFileSync } from "node:fs";
import type { KnapsackDB } from "../core/database";
import type { KnapsackStore } from "../core/types";

interface ToolEvent {
	id: string;
	tool: string;
	args: Record<string, unknown>;
	success: boolean;
	error?: string;
	timestamp: string;
}

export interface SessionAnalysis {
	totalToolCalls: number;
	failedTools: Array<{ tool: string; error: string; timestamp: string }>;
	patterns: string[];
	suggestions: Array<{ content: string; type: string; importance: number }>;
}

export function analyzeSession(sessionPath: string): SessionAnalysis {
	const analysis: SessionAnalysis = {
		totalToolCalls: 0,
		failedTools: [],
		patterns: [],
		suggestions: [],
	};

	if (!existsSync(sessionPath)) return analysis;

	const lines = readFileSync(sessionPath, "utf-8").split("\n").filter(Boolean);

	// Pass 1: collect toolCall → toolResult pairs
	const toolCalls = new Map<string, { tool: string; args: Record<string, unknown> }>();
	const toolResults: Array<{
		id: string;
		tool: string;
		success: boolean;
		error?: string;
		timestamp: string;
	}> = [];
	const userMessages: string[] = [];

	for (const line of lines) {
		try {
			const entry = JSON.parse(line);
			const msg = (entry.message ?? entry) as Record<string, unknown>;
			const role = msg.role as string;

			if (role === "assistant") {
				const content = msg.content;
				if (!Array.isArray(content)) continue;
				for (const block of content) {
					if (typeof block !== "object" || block === null) continue;
					const b = block as Record<string, unknown>;
					if (b.type === "toolCall") {
						toolCalls.set(String(b.id ?? ""), {
							tool: String(b.name ?? "unknown"),
							args: (b.arguments ?? b.input ?? {}) as Record<string, unknown>,
						});
					}
				}
			} else if (role === "toolResult") {
				toolResults.push({
					id: String(msg.toolCallId ?? ""),
					tool: String(msg.toolName ?? "unknown"),
					success: !msg.isError,
					error: msg.isError ? extractErrorText(msg.content) : undefined,
					timestamp: String(msg.timestamp ?? entry.timestamp ?? ""),
				});
			} else if (role === "user") {
				const text = extractText(msg.content);
				if (text) userMessages.push(text);
			}
		} catch {
			// skip
		}
	}

	// Build timeline: merge toolCalls + toolResults
	const timeline: ToolEvent[] = toolResults.map((r) => {
		const call = toolCalls.get(r.id);
		return {
			id: r.id,
			tool: call?.tool ?? r.tool,
			args: call?.args ?? {},
			success: r.success,
			error: r.error,
			timestamp: r.timestamp,
		};
	});

	analysis.totalToolCalls = timeline.length;
	analysis.failedTools = timeline
		.filter((t) => !t.success)
		.map((t) => ({
			tool: t.tool,
			error: (t.error ?? "unknown").slice(0, 200),
			timestamp: t.timestamp,
		}));

	// 1. File path corrections
	for (const c of findPathCorrections(timeline)) {
		analysis.suggestions.push({ content: c, type: "gotcha", importance: 0.8 });
	}

	// 2. Command corrections
	for (const c of findCommandCorrections(timeline)) {
		analysis.suggestions.push({ content: c, type: "command", importance: 0.7 });
	}

	// 3. User corrections
	for (const p of findUserCorrections(userMessages)) {
		analysis.suggestions.push({ content: p, type: "preference", importance: 0.6 });
	}

	// 4. Repeated failures
	analysis.patterns = findRepeatedFailures(timeline);

	// 5. Frequently accessed files
	for (const f of findFrequentFiles(timeline)) {
		analysis.suggestions.push({ content: f, type: "fact", importance: 0.4 });
	}

	// Deduplicate
	const seen = new Set<string>();
	analysis.suggestions = analysis.suggestions
		.filter((s) => {
			const key = s.content.slice(0, 50);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, 10);

	return analysis;
}

/**
 * Find file path corrections: failed read/edit → successful read/edit of similar file.
 */
function findPathCorrections(timeline: ToolEvent[]): string[] {
	const corrections: string[] = [];

	for (let i = 0; i < timeline.length; i++) {
		const fail = timeline[i];
		if (!fail || fail.success) continue;
		if (fail.tool !== "read" && fail.tool !== "edit") continue;

		const failedPath = String(fail.args.path ?? fail.args.file ?? "");
		if (!failedPath) continue;
		const fileName = failedPath.split("/").pop() ?? failedPath;

		// Look ahead for a successful read/edit of the same filename
		for (let j = i + 1; j < Math.min(i + 20, timeline.length); j++) {
			const next = timeline[j];
			if (!next?.success) continue;
			if (next.tool !== "read" && next.tool !== "edit") continue;

			const successPath = String(next.args.path ?? next.args.file ?? "");
			if (!successPath?.endsWith(fileName)) continue;
			if (successPath === failedPath) continue;

			corrections.push(`${fileName} is at ${successPath}, not ${failedPath}`);
			break;
		}
	}

	return [...new Set(corrections)];
}

/**
 * Find command corrections: failed bash → successful bash with similar command.
 */
function findCommandCorrections(timeline: ToolEvent[]): string[] {
	const corrections: string[] = [];

	for (let i = 0; i < timeline.length; i++) {
		const fail = timeline[i];
		if (!fail || fail.success || fail.tool !== "bash") continue;

		const failedCmd = String(fail.args.command ?? "");
		if (!failedCmd) continue;
		const cmdBase = failedCmd.split(/\s+/)[0] ?? failedCmd;

		for (let j = i + 1; j < Math.min(i + 10, timeline.length); j++) {
			const next = timeline[j];
			if (!next?.success || next.tool !== "bash") continue;

			const successCmd = String(next.args.command ?? "");
			if (!successCmd.startsWith(cmdBase) || successCmd === failedCmd) continue;

			corrections.push(
				`Use \`${successCmd.slice(0, 80)}\` instead of \`${failedCmd.slice(0, 60)}\``,
			);
			break;
		}
	}

	return [...new Set(corrections)].slice(0, 5);
}

/**
 * Detect user corrections: "no, use X instead of Y" patterns.
 */
function findUserCorrections(messages: string[]): string[] {
	const corrections: string[] = [];

	for (const msg of messages) {
		if (msg.length > 300) continue;
		const _lower = msg.toLowerCase();

		const isCorrection =
			/\b(no|don'?t|stop|wrong|instead|actually)\b/i.test(msg) ||
			/\buse\s+.+\s+(?:instead|not)\b/i.test(msg) ||
			/\bi\s+(?:prefer|want|need)\b/i.test(msg);

		if (isCorrection && msg.length > 5) {
			corrections.push(msg.slice(0, 150));
		}
	}

	return [...new Set(corrections)].slice(0, 3);
}

/**
 * Find tools that failed repeatedly with the same error.
 */
function findRepeatedFailures(timeline: ToolEvent[]): string[] {
	const counts: Record<string, number> = {};

	for (const t of timeline) {
		if (t.success || !t.error) continue;
		const key = `${t.tool}:${t.error.slice(0, 40)}`;
		counts[key] = (counts[key] ?? 0) + 1;
	}

	const results: string[] = [];
	for (const [key, count] of Object.entries(counts)) {
		if (count >= 2) {
			const [tool, ...errorParts] = key.split(":");
			results.push(`${tool} failed ${count}x: ${errorParts.join(":")}`);
		}
	}

	return results;
}

/**
 * Find files accessed frequently — project structure knowledge.
 */
function findFrequentFiles(timeline: ToolEvent[]): string[] {
	const counts: Record<string, number> = {};

	for (const t of timeline) {
		if (t.tool !== "read" && t.tool !== "edit") continue;
		const path = String(t.args.path ?? t.args.file ?? "");
		if (!path) continue;
		counts[path] = (counts[path] ?? 0) + 1;
	}

	return Object.entries(counts)
		.filter(([, count]) => count >= 3)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([path, count]) => `Frequently accessed (${count}x): ${path}`);
}

// ── Helpers ─────────────────────────────────────────────

function extractErrorText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(b): b is { text: string } =>
					typeof b === "object" && b !== null && b.type === "text" && typeof b.text === "string",
			)
			.map((b) => b.text)
			.join(" ");
	}
	return "Unknown error";
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(b): b is { text: string } =>
					typeof b === "object" && b !== null && b.type === "text" && typeof b.text === "string",
			)
			.map((b) => b.text)
			.join(" ");
	}
	return "";
}

export function saveAnalysisToMemory(
	analysis: SessionAnalysis,
	db: KnapsackDB,
	store: KnapsackStore,
): number {
	let saved = 0;

	for (const suggestion of analysis.suggestions) {
		db.saveMemory({
			content: suggestion.content,
			type: suggestion.type as "gotcha" | "command" | "preference" | "fact",
			scope: "project",
			project: store.projectRoot ?? undefined,
			importance: suggestion.importance,
			sourceSession: store.sessionId ?? undefined,
		});
		saved++;
	}

	return saved;
}

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
		lines.push(`Saved ${analysis.suggestions.length} learnings:`);
		for (const s of analysis.suggestions) {
			lines.push(`  • [${s.type}] ${s.content.slice(0, 80)}`);
		}
	} else {
		lines.push("No new learnings found.");
	}

	return lines.join("\n");
}
