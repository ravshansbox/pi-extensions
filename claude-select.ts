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
interface UsageWindow {
	utilization?: number;
	resets_at?: string;
}
interface QuotaInfo {
	five_hour?: UsageWindow;
	seven_day?: UsageWindow;
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
function getAnthropicEntries(auth: AuthJson): { [key: string]: AuthEntry } {
	const entries: { [key: string]: AuthEntry } = {};
	for (const [key, value] of Object.entries(auth)) {
		if (key.startsWith("anthropic")) {
			entries[key] = value;
		}
	}
	return entries;
}
function getAuthPath(): string {
	return path.join(process.env.HOME || "/root", ".pi", "agent", "auth.json");
}
async function fetchQuotaInfo(accessToken: string): Promise<QuotaInfo | null> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);
		const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"anthropic-beta": "oauth-2025-04-20",
			},
			signal: controller.signal,
		});
		clearTimeout(timeout);
		if (!res.ok) {
			return null;
		}
		return (await res.json()) as QuotaInfo;
	} catch (error) {
		return null;
	}
}
async function fetchProfileInfo(accessToken: string): Promise<ProfileInfo | null> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);
		const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
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
function loadAuth(): AuthJson {
	const authPath = getAuthPath();
	if (!fs.existsSync(authPath)) {
		return {};
	}
	const content = fs.readFileSync(authPath, "utf-8");
	return JSON.parse(content);
}
function saveAuth(auth: AuthJson): void {
	const authPath = getAuthPath();
	fs.writeFileSync(authPath, JSON.stringify(auth, null, 2));
}
function reorganizeKeys(auth: AuthJson, selectedKey: string): AuthJson {
	const result = { ...auth };
	const anthropicKeys = Object.keys(result).filter((k) => k.startsWith("anthropic"));
	for (const key of anthropicKeys) {
		delete result[key];
	}
	let counter = 1;
	const usedNumbers = new Set<number>();
	const selectedAuth = getAnthropicEntries(auth)[selectedKey];
	if (selectedAuth) {
		result["anthropic"] = selectedAuth;
	}
	for (const [key, value] of Object.entries(getAnthropicEntries(auth))) {
		if (key !== selectedKey) {
			while (usedNumbers.has(counter)) {
				counter++;
			}
			result[`anthropic-${counter}`] = value;
			usedNumbers.add(counter);
			counter++;
		}
	}
	return result;
}

function getUrgencyScore(quota?: QuotaInfo): number {
	if (!quota) return 0;
	let maxUrgency = 0;
	if (quota.five_hour?.utilization !== undefined && quota.five_hour.resets_at) {
		const resetsAt = new Date(quota.five_hour.resets_at).getTime();
		const hoursLeft = Math.max(0.1, (resetsAt - Date.now()) / (1000 * 60 * 60)); // Min 0.1h to avoid division by zero
		const urgency = quota.five_hour.utilization / hoursLeft;
		maxUrgency = Math.max(maxUrgency, urgency);
	}
	if (quota.seven_day?.utilization !== undefined && quota.seven_day.resets_at) {
		const resetsAt = new Date(quota.seven_day.resets_at).getTime();
		const daysLeft = Math.max(0.1, (resetsAt - Date.now()) / (1000 * 60 * 60 * 24)); // Min 0.1d
		const urgency = quota.seven_day.utilization / daysLeft;
		maxUrgency = Math.max(maxUrgency, urgency);
	}
	return maxUrgency;
}
function getUsageWarning(quota?: QuotaInfo): string {
	if (!quota) return "";
	const CRITICAL_THRESHOLD = 85;
	const WARNING_THRESHOLD = 70;
	let warning = "";
	if (quota.five_hour?.utilization !== undefined) {
		if (quota.five_hour.utilization >= CRITICAL_THRESHOLD) {
			return "!!"; // Critical - 5h limit
		} else if (quota.five_hour.utilization >= WARNING_THRESHOLD) {
			warning = "!"; // Warning - 5h limit
		}
	}
	if (!warning && quota.seven_day?.utilization !== undefined) {
		if (quota.seven_day.utilization >= CRITICAL_THRESHOLD) {
			return "!!"; // Critical - weekly limit
		} else if (quota.seven_day.utilization >= WARNING_THRESHOLD) {
			warning = "!"; // Warning - weekly limit
		}
	}
	return warning;
}
function getEntryLabel(key: string, entry: AuthEntry, quota?: QuotaInfo, profile?: ProfileInfo, isBest?: boolean): string {
	let label = profile?.account?.email || key;
	const warning = getUsageWarning(quota);
	if (warning) {
		label = `${warning} ${label}`;
	}
	if (quota) {
		const parts: string[] = [];
		if (quota.five_hour?.utilization !== undefined) {
			let fiveHourStr = `5h: ${quota.five_hour.utilization}%`;
			if (quota.five_hour.resets_at) {
				const resetsAt = new Date(quota.five_hour.resets_at).getTime();
				const msLeft = resetsAt - Date.now();
				const hoursLeft = Math.floor(msLeft / (1000 * 60 * 60));
				const minutesLeft = Math.floor((msLeft % (1000 * 60 * 60)) / (1000 * 60));
				fiveHourStr += ` (${hoursLeft}h${minutesLeft}m)`;
			}
			parts.push(fiveHourStr);
		}
		if (quota.seven_day?.utilization !== undefined) {
			let weekStr = `week: ${quota.seven_day.utilization}%`;
			if (quota.seven_day.resets_at) {
				const resetsAt = new Date(quota.seven_day.resets_at).getTime();
				const msLeft = resetsAt - Date.now();
				const daysLeft = Math.floor(msLeft / (1000 * 60 * 60 * 24));
				const hoursLeft = Math.floor((msLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
				if (daysLeft > 0) {
					weekStr += ` (${daysLeft}d${hoursLeft}h)`;
				} else {
					weekStr += ` (${hoursLeft}h)`;
				}
			}
			parts.push(weekStr);
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

	pi.registerCommand("claude-select", {
		description: "Select an Anthropic API key to use",
		handler: async (_args, ctx) => {
			try {
				const auth = loadAuth();
				const anthropicEntries = getAnthropicEntries(auth);
				if (Object.keys(anthropicEntries).length === 0) {
					ctx.ui.notify("No Anthropic logins found in auth.json", "warning");
					return;
				}
				if (Object.keys(anthropicEntries).length === 1) {
					ctx.ui.notify("Only one Anthropic login available", "info");
					return;
				}
				const quotaMap = new Map<string, QuotaInfo | null>();
				const profileMap = new Map<string, ProfileInfo | null>();
				await Promise.all(
					Object.entries(anthropicEntries).map(async ([key, entry]) => {
						if (entry.type === "oauth" && entry.access) {
							const [quota, profile] = await Promise.all([
								fetchQuotaInfo(entry.access),
								fetchProfileInfo(entry.access),
							]);
							quotaMap.set(key, quota);
							profileMap.set(key, profile);
						}
					})
				);
				const seenUUIDs = new Set<string>();
				const uniqueEntries = Object.entries(anthropicEntries).filter(([_key, entry]) => {
					const profile = profileMap.get(_key);
					const uuid = profile?.account?.uuid;
					if (!uuid) return true; // Keep entries without UUID
					if (seenUUIDs.has(uuid)) return false; // Skip if we've seen this UUID
					seenUUIDs.add(uuid);
					return true; // Keep first occurrence
				});
				let bestKey: string | null = null;
				let lowestUrgency = Infinity;
				for (const [key, quota] of quotaMap.entries()) {
					if (quota) {
						const urgency = getUrgencyScore(quota);
						if (urgency < lowestUrgency) {
							lowestUrgency = urgency;
							bestKey = key;
						}
					}
				}

				// Build label to key mapping for easy lookup
				const labelToKey = new Map<string, string>();
				const displayItems = uniqueEntries.map(([key, entry]) => {
					const quota = quotaMap.get(key);
					const profile = profileMap.get(key);
					const isBest = key === bestKey;
					const label = getEntryLabel(key, entry, quota || undefined, profile || undefined, isBest);
					labelToKey.set(label, key);
					return label;
				});

				const selectedLabel = await ctx.ui.select("Select Anthropic Login", displayItems);
				if (!selectedLabel) {
					return;
				}

				const selectedKey = labelToKey.get(selectedLabel);
				if (!selectedKey) {
					ctx.ui.notify("Could not identify selected login", "error");
					return;
				}
				const updated = reorganizeKeys(auth, selectedKey);
				saveAuth(updated);
				await ctx.reload();
				const selectedEntry = anthropicEntries[selectedKey];
				const selectedProfile = profileMap.get(selectedKey);
				const selectedEmail = selectedProfile?.account?.email || selectedProfile?.account?.full_name || selectedKey;
				ctx.ui.notify(`Account switched to ${selectedEmail}`, "success");
			} catch (error) {
				ctx.ui.notify(`Error: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
