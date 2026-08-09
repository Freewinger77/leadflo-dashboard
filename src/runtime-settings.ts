/**
 * Settings that can be changed while the service is running.
 *
 * Everything here also exists as an environment variable, and the environment
 * remains the durable answer. This overlay exists because the feeder runs on an
 * App Service nobody on the delivery side can reach: without it, switching
 * outbound on for a single test number requires someone with Azure rights, and
 * the practice waits.
 *
 * An override is only consulted when it has been deliberately stored, so an
 * untouched deployment behaves exactly as its environment says.
 */

/** The only keys that may be overridden. Anything else is ignored on load. */
export const OVERRIDABLE_KEYS = [
  "OUTBOUND_ENABLED",
  "OUTBOUND_ALLOWLIST",
  "WEBHOOK_URL",
] as const;

export type OverridableKey = (typeof OVERRIDABLE_KEYS)[number];

const overrides = new Map<string, string>();

export function isOverridableKey(key: string): key is OverridableKey {
  return (OVERRIDABLE_KEYS as readonly string[]).includes(key);
}

/** Replace the whole overlay, dropping keys that are not overridable. */
export function loadOverrides(stored: Record<string, string>): void {
  overrides.clear();
  for (const [key, value] of Object.entries(stored)) {
    if (isOverridableKey(key)) overrides.set(key, value);
  }
}

export function setOverride(key: OverridableKey, value: string): void {
  overrides.set(key, value);
}

export function clearOverride(key: OverridableKey): void {
  overrides.delete(key);
}

/** The stored override, or undefined to fall through to the environment. */
export function readOverride(key: OverridableKey): string | undefined {
  return overrides.get(key);
}

/** Effective value with its origin, for showing what is actually in force. */
export function effective(key: OverridableKey): {
  value: string | undefined;
  source: "runtime" | "environment" | "default";
} {
  const override = overrides.get(key);
  if (override !== undefined) return { value: override, source: "runtime" };
  const fromEnv = process.env[key];
  if (fromEnv !== undefined && fromEnv !== "") {
    return { value: fromEnv, source: "environment" };
  }
  return { value: undefined, source: "default" };
}
