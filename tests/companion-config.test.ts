import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPANION_BASE_URL,
  COMPANION_BIND_ADDRESSES,
  COMPANION_DEV_DOMAIN,
  COMPANION_HOSTNAME,
  COMPANION_OAUTH_HOST,
  COMPANION_PORT,
} from "../src/companion/config.js";

describe("Figma loopback companion configuration", () => {
  it("uses the documented localhost development URL and preserves production offline access", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
    ) as {
      networkAccess: { allowedDomains: string[]; devAllowedDomains: string[] };
    };
    const endpoint = new URL(COMPANION_BASE_URL);

    expect(COMPANION_BASE_URL).toBe("http://localhost:1455");
    expect(COMPANION_DEV_DOMAIN).toBe(COMPANION_BASE_URL);
    expect(endpoint.hostname).toBe(COMPANION_HOSTNAME);
    expect(COMPANION_OAUTH_HOST).toBe("127.0.0.1");
    expect(COMPANION_BASE_URL).not.toContain(COMPANION_OAUTH_HOST);
    expect(endpoint.port).toBe(String(COMPANION_PORT));
    expect(manifest.networkAccess.allowedDomains).toEqual(["none"]);
    expect(manifest.networkAccess.devAllowedDomains).toEqual([COMPANION_DEV_DOMAIN]);
    expect(manifest.networkAccess.devAllowedDomains).not.toContain("http://127.0.0.1:1455");
    expect(COMPANION_BIND_ADDRESSES).toEqual(["127.0.0.1", "::1"]);
  });

  it("keeps companion networking out of Figma's document-controller entrypoint", () => {
    const controller = readFileSync(new URL("../src/plugin/main.ts", import.meta.url), "utf8");
    expect(controller).not.toMatch(/companion-client|COMPANION_BASE_URL|fetch\s*\(/iu);
  });
});
