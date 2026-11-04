import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPANION_BASE_URL,
  COMPANION_BIND_ADDRESSES,
  COMPANION_DEV_DOMAIN,
  COMPANION_HOSTNAME,
  COMPANION_OAUTH_HOST,
  COMPANION_PORT,
  configuredTimeoutMs,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_OVERALL_TIMEOUT_MS,
  MAX_STREAM_IDLE_TIMEOUT_MS,
  MAX_STREAM_OVERALL_TIMEOUT_MS,
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

  it("runs the companion entrypoint emitted by the shared-source TypeScript root", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: { companion: string } };
    const companionMain = readFileSync(
      new URL("../src/companion/main.ts", import.meta.url),
      "utf8",
    );
    const companionConfig = JSON.parse(
      readFileSync(new URL("../tsconfig.companion.json", import.meta.url), "utf8"),
    ) as { compilerOptions: { rootDir: string; outDir: string } };

    expect(companionConfig.compilerOptions.rootDir).toBe("src");
    expect(companionConfig.compilerOptions.outDir).toBe("dist-companion");
    expect(packageJson.scripts.companion).toContain("node dist-companion/companion/main.js");
    expect(packageJson.scripts.companion).not.toContain("node dist-companion/main.js");
    expect(companionMain).toContain("FAD_STREAM_IDLE_TIMEOUT_MS");
    expect(companionMain).toContain("FAD_STREAM_OVERALL_TIMEOUT_MS");
  });

  it("clamps environment-provided stream deadlines to safe maximums", () => {
    expect(
      configuredTimeoutMs("90000", DEFAULT_STREAM_IDLE_TIMEOUT_MS, MAX_STREAM_IDLE_TIMEOUT_MS),
    ).toBe(90_000);
    expect(
      configuredTimeoutMs("999999999", DEFAULT_STREAM_IDLE_TIMEOUT_MS, MAX_STREAM_IDLE_TIMEOUT_MS),
    ).toBe(MAX_STREAM_IDLE_TIMEOUT_MS);
    expect(
      configuredTimeoutMs(
        "invalid",
        DEFAULT_STREAM_OVERALL_TIMEOUT_MS,
        MAX_STREAM_OVERALL_TIMEOUT_MS,
      ),
    ).toBe(DEFAULT_STREAM_OVERALL_TIMEOUT_MS);
    expect(
      configuredTimeoutMs("5", DEFAULT_STREAM_OVERALL_TIMEOUT_MS, MAX_STREAM_OVERALL_TIMEOUT_MS),
    ).toBe(DEFAULT_STREAM_OVERALL_TIMEOUT_MS);
  });
});
