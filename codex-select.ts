import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface AuthEntry {
	type: "oauth" | "api_key";
	refresh?: string;
	access?: string;
	key?: string;
	expires?: number;
	accountId?: string;
}

interface AuthJson {
	[key: string]: AuthEntry;
}

interface RateLimitWindow {
	used_percent: number;
	reset_at: number;
	limit_window_seconds: number;
}

interface RateLimit {
	primary_window?: RateLimitWindow;
	secondary_window?: RateLimitWindow;
}

interface CreditsInfo {
	balance?: string | number;
}

interface CodexUsageData {
	rate_limit?: RateLimit;
	credits?: CreditsInfo;
	plan_type?: string;
}

interface ProfileInfo {
	account?: {
		email?: string;
		full_name?: string;
		uuid?: string;
	};
}

interface APIError {
	error: {
		message: string;
	};
}

function getCodexEntries(auth: AuthJson): { [key: string]: AuthEntry } {
	const entries: { [key: string]: AuthEntry } = {};
	for (const [key, value] of Object.entries(auth)) {
		if (key.startsWith("openai-codex")) {
			entries[key] = value;
		}
	}
	return entries;
}

function getAuthPath(): string {
	return path.join(process.env.HOME || "/root", ".pi", "agent", "auth.json");
}

async function fetchCodexUsage(accessToken: string, accountId?: string): Promise<CodexUsageData | null> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);
		const headers: Record<string, string> = {
			Authorization: `Bearer ${accessToken}`,
			"User-Agent": "CodexBar",
			Accept: "application/json",
		};
		if (accountId) {
			headers["ChatGPT-Account-Id"] = accountId;
		}
		const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		clearTimeout(timeout);
		if (!res.ok) {
			if (res.status === 401 || res.status === 403) {
				return null;
			}
			return null;
		}
		return (await res.json()) as CodexUsageData;
	} catch (error) {
		return null;
	}
}

async function fetchAccountEmail(accountId: string, accessToken?: string): Promise<string | null> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);
		const headers: Record<string, string> = {
			Authorization: `Bearer ${accessToken}`,
			"User-Agent": "CodexBar",
			Accept: "application/json",
		};
		if (accountId) {
			headers["ChatGPT-Account-Id"] = accountId;
		}
		const res = await fetch("https://chatgpt.com/backend-api/wham/profile", {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		clearTimeout(timeout);
		if (!res.ok) {
			return null;
		}
		const profile = await res.json();
		return profile?.account?.email || null;
	} catch (error) {
		return null;
	}
}

async function fetchCodexProfile(accessToken: string, accountId?: string): Promise<ProfileInfo | null> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);
		const headers: Record<string, string> = {
			Authorization: `Bearer ${accessToken}`,
			"User-Agent": "CodexBar",
			Accept: "application/json",
		};
		if (accountId) {
			headers["ChatGPT-Account-Id"] = accountId;
		}
		const res = await fetch("https://chatgpt.com/backend-api/wham/profile", {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		clearTimeout(timeout);
		if (!res.ok) {
			return null;
		}
		return (await res.json()) as ProfileInfo;
	} catch (error) {
		return null;
	}
}

function migrateCodexKeys(auth: AuthJson): { auth: AuthJson; migrated: boolean } {
	const result: AuthJson = { ...auth };
	const hasOpenaiCodex = Object.keys(result).some((k) => k.startsWith("openai-codex"));
	const codexKeys = Object.keys(result).filter((k) => k.startsWith("codex"));
	if (hasOpenaiCodex || codexKeys.length === 0) {
		return { auth: result, migrated: false };
	}
	for (const key of codexKeys) {
		const value = result[key];
		delete result[key];
		const suffix = key === "codex" ? "" : key.replace(/^codex/, "");
		const newKey = `openai-codex${suffix}`;
		result[newKey] = value;
	}
	return { auth: result, migrated: true };
}

function loadAuth(): AuthJson {
	const authPath = getAuthPath();
	if (!fs.existsSync(authPath)) {
		return {};
	}
	const content = fs.readFileSync(authPath, "utf-8");
	const parsed = JSON.parse(content) as AuthJson;
	const migrated = migrateCodexKeys(parsed);
	if (migrated.migrated) {
		saveAuth(migrated.auth);
	}
	return migrated.auth;
}

function saveAuth(auth: AuthJson): void {
	const authPath = getAuthPath();
	fs.writeFileSync(authPath, JSON.stringify(auth, null, 2));
}

async function tryGetAccountEmail(entry: AuthEntry): Promise<string | null> {
	try {
		if (!entry.access) {
			return null;
		}

		// Try OpenAI API /v1/me endpoint - this actually returns email
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 3000);
			const res = await fetch("https://api.openai.com/v1/me", {
				method: "GET",
				headers: {
					Authorization: `Bearer ${entry.access}`,
				},
				signal: controller.signal,
			});
			clearTimeout(timeout);

			if (res.ok) {
				const data = await res.json();
				if (data?.email) {
					return data.email;
				}
			}
		} catch (err) {
			// Continue to other methods
		}

		return null;
	} catch {
		return null;
	}
}

function formatReset(resetAt: number): string {
	const resetDate = new Date(resetAt * 1000);
	const diffMs = resetDate.getTime() - Date.now();
	if (diffMs < 0) return "now";
	const diffMins = Math.floor(diffMs / 60000);
	if (diffMins < 60) return `${diffMins}m`;
	const hours = Math.floor(diffMins / 60);
	const mins = diffMins % 60;
	if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}d ${hours % 24}h`;
}

function formatWindowLimit(windowSeconds: number): string {
	const hours = Math.round(windowSeconds / 3600);
	if (hours < 24) return `${hours}h`;
	const days = Math.round(hours / 24);
	return `${days}d`;
}

function getUsagePercent(usedPercent: number): number {
	return Math.round(usedPercent);
}

function getUrgencyScore(usage: CodexUsageData): number {
	if (!usage.rate_limit) return 0;
	let maxUrgency = 0;
	if (usage.rate_limit.primary_window && usage.rate_limit.primary_window.reset_at) {
		const resetsAt = usage.rate_limit.primary_window.reset_at;
		const hoursLeft = Math.max(0.1, (resetsAt - Date.now()) / (1000 * 60 * 60));
		const urgency = (usage.rate_limit.primary_window.used_percent || 0) / hoursLeft;
		maxUrgency = Math.max(maxUrgency, urgency);
	}
	if (usage.rate_limit.secondary_window && usage.rate_limit.secondary_window.reset_at) {
		const resetsAt = usage.rate_limit.secondary_window.reset_at;
		const hoursLeft = Math.max(0.1, (resetsAt - Date.now()) / (1000 * 60 * 60));
		const urgency = (usage.rate_limit.secondary_window.used_percent || 0) / hoursLeft;
		maxUrgency = Math.max(maxUrgency, urgency);
	}
	return maxUrgency;
}

function getUsageWarning(usage: CodexUsageData): string {
	if (!usage.rate_limit) return "";
	const CRITICAL_THRESHOLD = 85;
	const WARNING_THRESHOLD = 70;
	let warning = "";
	if (usage.rate_limit.primary_window) {
		const util = usage.rate_limit.primary_window.used_percent || 0;
		if (util >= CRITICAL_THRESHOLD) {
			return "!!";
		} else if (util >= WARNING_THRESHOLD) {
			warning = "!";
		}
	}
	if (!warning && usage.rate_limit.secondary_window) {
		const util = usage.rate_limit.secondary_window.used_percent || 0;
		if (util >= CRITICAL_THRESHOLD) {
			return "!!";
		} else if (util >= WARNING_THRESHOLD) {
			warning = "!";
		}
	}
	return warning;
}

function getEntryLabel(key: string, entry: AuthEntry, usage: CodexUsageData | null, profile: ProfileInfo | null, isBest?: boolean, isSelected?: boolean): string {
	let label = profile?.account?.email || profile?.account?.full_name || (entry as any).email;
	if (!label) {
		label = key;
	}
	const warning = getUsageWarning(usage);
	if (warning) {
		label = `${warning} ${label}`;
	}
	if (usage) {
		const parts: string[] = [];
		if (usage.rate_limit?.primary_window) {
			const pw = usage.rate_limit.primary_window;
			const util = getUsagePercent(pw.used_percent);
			const resetStr = pw.reset_at ? ` ${formatReset(pw.reset_at)}` : "";
			parts.push(`${util}% ${resetStr}`);
		}
		if (usage.rate_limit?.secondary_window) {
			const sw = usage.rate_limit.secondary_window;
			const util = getUsagePercent(sw.used_percent);
			const resetStr = sw.reset_at ? ` ${formatReset(sw.reset_at)}` : "";
			parts.push(`${util}% ${resetStr}`);
		}
		if (usage.credits?.balance !== undefined && usage.credits.balance !== null) {
			const balance = typeof usage.credits.balance === 'number'
				? usage.credits.balance
				: parseFloat(usage.credits.balance) || 0;
			parts.push(`$${balance.toFixed(2)}`);
		}
		if (parts.length > 0) {
			label += ` | ${parts.join(" | ")}`;
		}
	}
	if (entry.expires) {
		const daysUntilExpiry = Math.ceil((entry.expires - Date.now()) / (1000 * 60 * 60 * 24));
		if (daysUntilExpiry > 0) {
			label += ` [${daysUntilExpiry}d]`;
		} else {
			label += ` [EXPIRED]`;
		}
	}
	if (isBest) {
		label += ` (recommended)`;
	}
	return label;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		await updateUsageWidget(ctx, pi);
	});

	pi.on("model_select", async (_event, ctx) => {
		await updateUsageWidget(ctx, pi);
	});

	pi.registerCommand("codex-select", {
		description: "Select a Codex account to use",
		handler: async (_args, ctx) => {
			try {
				const auth = loadAuth();
				const codexEntries = getCodexEntries(auth);
				if (Object.keys(codexEntries).length === 0) {
					ctx.ui.notify("No Codex accounts found in auth.json", "warning");
					return;
				}
				if (Object.keys(codexEntries).length === 1) {
					ctx.ui.notify("Only one Codex account available", "info");
					return;
				}
				const usageMap = new Map<string, CodexUsageData | null>();
				const profileMap = new Map<string, ProfileInfo | null>();
				const accountIds = new Map<string, string | undefined>();
				await Promise.all(
					Object.entries(codexEntries).map(async ([key, entry]) => {
						if ((entry.type === "oauth" || entry.type === "api_key") && (entry.access || entry.key)) {
							const accessToken = entry.access || entry.key;
							const accountId = entry.type === "oauth" && (entry as any).accountId;
							accountIds.set(key, accountId);
							const [usage, profile] = await Promise.all([
								fetchCodexUsage(accessToken, accountId),
								fetchCodexProfile(accessToken, accountId),
							]);
							usageMap.set(key, usage);
							profileMap.set(key, profile);
						}
					})
				);
				const seenUUIDs = new Set<string>();
				const uniqueEntries = Object.entries(codexEntries).filter(([_key, entry]) => {
					const profile = profileMap.get(_key);
					const uuid = profile?.account?.uuid;
					if (!uuid) return true;
					if (seenUUIDs.has(uuid)) return false;
					seenUUIDs.add(uuid);
					return true;
				});

				// Try to get email for each account using account ID if available
				let authUpdated = false;
				for (const [key, accountId] of accountIds.entries()) {
					const profile = profileMap.get(key);
					const entry = codexEntries[key];

					// Try to get email from API if not in profile
					let email = profile?.account?.email;
					if (!email && entry) {
						email = await tryGetAccountEmail(entry);
						if (email) {
							// Store email in auth.json for future use
							if (!(entry as any).email) {
								(entry as any).email = email;
								authUpdated = true;
							}
						}
					}

					if (email && !profile?.account?.email) {
						profileMap.set(key, {
							account: {
								email,
								full_name: profile?.account?.full_name,
								uuid: profile?.account?.uuid,
							}
						});
					}
				}

				// Save updated auth with emails
				if (authUpdated) {
					const updatedAuth = { ...auth };
					for (const [key, entry] of Object.entries(codexEntries)) {
						updatedAuth[key] = entry;
					}
					saveAuth(updatedAuth);
				}
				let bestKey: string | null = null;
				let lowestUrgency = Infinity;
				for (const [key, usage] of usageMap.entries()) {
					if (usage) {
						const urgency = getUrgencyScore(usage);
						if (urgency < lowestUrgency) {
							lowestUrgency = urgency;
							bestKey = key;
						}
					}
				}

				// For accounts without emails, try to get them from other sources
				for (const [key, entry] of uniqueEntries) {
					const profile = profileMap.get(key);
					const email = await tryGetAccountEmail(entry);
					if (email && !profile?.account?.email) {
						profileMap.set(key, {
							account: {
								email,
								full_name: profile?.account?.full_name,
								uuid: profile?.account?.uuid,
							}
						});
					}
				}

				// Build label to key mapping for easy lookup
				const labelToKey = new Map<string, string>();
				const items = uniqueEntries.map(([key, entry]) => {
					const usage = usageMap.get(key);
					const profile = profileMap.get(key);
					const isBest = key === bestKey;
					const label = getEntryLabel(key, entry, usage || null, profile || null, isBest);
					labelToKey.set(label, key);
					return label;
				});

				const selectedLabel = await ctx.ui.select("Select Codex Account", items);
				if (!selectedLabel) {
					return;
				}

				const selectedKey = labelToKey.get(selectedLabel);
				if (!selectedKey) {
					ctx.ui.notify("Could not identify selected account", "error");
					return;
				}
				const updated = reorganizeKeys(auth, selectedKey);
				saveAuth(updated);
				const newAuth = loadAuth();
				const newCodexAuth = newAuth["openai-codex"];
				if (newCodexAuth && (newCodexAuth.type === "oauth" || newCodexAuth.type === "api_key") && (newCodexAuth.access || newCodexAuth.key)) {
					const accessToken = newCodexAuth.access || newCodexAuth.key;
					const accountId = newCodexAuth.type === "oauth" && (newCodexAuth as any).accountId;
					const [newUsage, newProfile] = await Promise.all([
						fetchCodexUsage(accessToken, accountId),
						fetchCodexProfile(accessToken, accountId),
					]);
					if (newUsage && newProfile) {
						const parts: string[] = [];
						if (newUsage.rate_limit?.primary_window) {
							const pw = newUsage.rate_limit.primary_window;
							const util = getUsagePercent(pw.used_percent);
							const resetStr = pw.reset_at ? ` ${formatReset(pw.reset_at)}` : "";
							parts.push(`${util}% ${resetStr}`);
						}
						if (newUsage.rate_limit?.secondary_window) {
							const sw = newUsage.rate_limit.secondary_window;
							const util = getUsagePercent(sw.used_percent);
							const resetStr = sw.reset_at ? ` ${formatReset(sw.reset_at)}` : "";
							parts.push(`${util}% ${resetStr}`);
						}
						if (newUsage.credits?.balance !== undefined && newUsage.credits.balance !== null) {
							const balance = typeof newUsage.credits.balance === 'number'
								? newUsage.credits.balance
								: parseFloat(newUsage.credits.balance) || 0;
							parts.push(`$${balance.toFixed(2)}`);
						}
						const email = newProfile.account?.email || newProfile.account?.full_name;
						if (!email) {
							const accountEmail = await tryGetAccountEmail(newCodexAuth);
							if (accountEmail) {
								email = accountEmail;
							} else {
								email = "Codex";
							}
						}
						const line = `${email} • ${parts.join(" • ")}`;
						ctx.ui.setWidget("codex-usage", [line]);
					}
				}
				await ctx.reload();
				const selectedEntry = codexEntries[selectedKey];
				const selectedProfile = profileMap.get(selectedKey);
				const selectedEmail = selectedProfile?.account?.email || selectedProfile?.account?.full_name || (selectedEntry as any)?.email || selectedKey;
				ctx.ui.notify(`Account switched to ${selectedEmail}`, "success");
			} catch (error) {
				ctx.ui.notify(`Error: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}

function reorganizeKeys(auth: AuthJson, selectedKey: string): AuthJson {
	const result = { ...auth };
	const codexKeys = Object.keys(result).filter((k) => k.startsWith("openai-codex"));
	for (const key of codexKeys) {
		delete result[key];
	}
	let counter = 1;
	const usedNumbers = new Set<number>();
	const selectedAuth = getCodexEntries(auth)[selectedKey];
	if (selectedAuth) {
		result["openai-codex"] = selectedAuth;
	}
	for (const [key, value] of Object.entries(getCodexEntries(auth))) {
		if (key !== selectedKey) {
			while (usedNumbers.has(counter)) {
				counter++;
			}
			result[`openai-codex-${counter}`] = value;
			usedNumbers.add(counter);
			counter++;
		}
	}
	return result;
}

async function updateUsageWidget(ctx: any, pi: ExtensionAPI): Promise<void> {
	try {
		if (!ctx.model || !ctx.model.provider?.includes("codex") && !ctx.model.provider?.includes("openai")) {
			return;
		}
		const auth = loadAuth();
		const codexAuth = auth["openai-codex"];
		if (!codexAuth || (codexAuth.type !== "oauth" && codexAuth.type !== "api_key") || (!codexAuth.access && !codexAuth.key)) {
			return;
		}
		const accessToken = codexAuth.access || codexAuth.key;
		const accountId = codexAuth.type === "oauth" && (codexAuth as any).accountId;
		const [usage, profile] = await Promise.all([
			fetchCodexUsage(accessToken, accountId),
			fetchCodexProfile(accessToken, accountId),
		]);
		if (!usage || !profile) {
			return;
		}

		// Try to get email if not in profile
		let email = profile.account?.email || profile.account?.full_name || (codexAuth as any).email;
		if (!email) {
			email = await tryGetAccountEmail(codexAuth);
			// Store email in auth for future use
			if (email) {
				(codexAuth as any).email = email;
				const auth = loadAuth();
				auth["openai-codex"] = codexAuth;
				saveAuth(auth);
			}
		}
		email = email || "Codex";

		const parts: string[] = [];
		if (usage.rate_limit?.primary_window) {
			const pw = usage.rate_limit.primary_window;
			const util = getUsagePercent(pw.used_percent);
			const resetStr = pw.reset_at ? ` ${formatReset(pw.reset_at)}` : "";
			parts.push(`${util}% ${resetStr}`);
		}
		if (usage.rate_limit?.secondary_window) {
			const sw = usage.rate_limit.secondary_window;
			const util = getUsagePercent(sw.used_percent);
			const resetStr = sw.reset_at ? ` ${formatReset(sw.reset_at)}` : "";
			parts.push(`${util}% ${resetStr}`);
		}
		if (usage.credits?.balance !== undefined && usage.credits.balance !== null) {
			const balance = typeof usage.credits.balance === 'number'
				? usage.credits.balance
				: parseFloat(usage.credits.balance) || 0;
			parts.push(`$${balance.toFixed(2)}`);
		}
		const line = `${email} • ${parts.join(" • ")}`;
		ctx.ui.setWidget("codex-usage", [line]);
	} catch (error) {
		console.error("Error updating Codex usage widget:", error);
	}
}
