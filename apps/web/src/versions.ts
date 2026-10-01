/** Installed package versions reported by the server in `GET /api/session` (`null` when unknown). */
export type Versions = { aiSdkLetta?: string | null; server?: string | null; lettaSdk?: string | null };

/** One line for the About section and bug reports: "ai-sdk-letta 0.5.0 · server 0.5.0 · Letta SDK 0.8.22". Unknown versions are left out; empty when none is known. */
export function versionLine(versions: Versions | undefined): string {
  return versionParts(versions).join(' · ');
}

/** The known "name version" parts of {@link versionLine}, in order. */
export function versionParts(versions: Versions | undefined): string[] {
  if (!versions) return [];
  const entries: [string, string | null | undefined][] = [['ai-sdk-letta', versions.aiSdkLetta], ['server', versions.server], ['Letta SDK', versions.lettaSdk]];
  return entries.filter(([, version]) => typeof version === 'string' && version).map(([label, version]) => `${label} ${version}`);
}
