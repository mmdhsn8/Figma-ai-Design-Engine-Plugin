# 07 — Security, license, and compatibility

## License and pinned source

Figwright v0.8.0 is pinned to source commit 458e3dfa5da5d5c53f1fd5334a35754ffb2a66ca. The root LICENSE is MIT and the MCP package declares MIT. Any later code copy must retain the upstream copyright and permission notice and be reviewed for third-party notices. No code was copied.

References: [v0.8.0 release and commit](https://github.com/awdr74100/figwright/releases/tag/v0.8.0), [pinned README](https://github.com/awdr74100/figwright/blob/458e3dfa5da5d5c53f1fd5334a35754ffb2a66ca/README.md), [pinned MIT license](https://github.com/awdr74100/figwright/blob/458e3dfa5da5d5c53f1fd5334a35754ffb2a66ca/LICENSE).

The repository uses pnpm lockfile format 9.0 and pins pnpm 12.21.0. The local machine has pnpm 11.25.0, so no source dependency install/build was attempted. The MCP package requires Node ^20.19.0 or >=22.12.0; local Node v24.21.0 satisfies that package range. The monorepo root requires Node ^24.11.0 or >=26.0.0; local Node also satisfies it.

No transitive license inventory, dependency vulnerability audit, npm package installation, or plugin build was performed. These remain required before any future code port. A release pin and version string do not substitute for an installed package hash or captured connected tool catalog.

## Data flow and permissions

Figwright's documented architecture runs the MCP server and relay locally on 127.0.0.1:3055, checks Host and Origin on the relay, and connects to the Figma plugin over loopback. Its connected tool results are returned through the MCP client to the selected model provider; the source setup therefore does not prove that synthetic canvas data remains on the local machine. Do not use private canvas content in this benchmark.

The Figwright v0.8.0 plugin manifest allows all network domains because image import tools may fetch user-supplied URLs. The current plugin manifest allows no production network domains and permits localhost:1455 only in development. This is a meaningful permission difference for the plugin sandbox.

The Figwright registry includes broad native writes, including deletion tools. Its batch handler attempts only supported reversible operations and reports residue on rollback failure, but a native partial write remains a reason to stop, inspect read-only state, and reconcile IDs before another write. Its local file claim does not replace the existing Universal task/checkpoint ownership ledger.

The current plugin uses typed DesignProgramV1 validation, bounded operation budgets, per-screen transaction identities, ownership checks, and native readback. This phase adds no arbitrary JavaScript evaluator, execution relay, credential exchange, global MCP setting, plugin ID change, port change, cache reset, or checkpoint modification.

## Cost and entitlement

No account/model/provider setting was inspected and no provider request was made. Figma's release README says Figwright can run on the free Figma tier; the user's exact plan and entitlement were not verified. The selected MCP model's price, rate limits, privacy terms, image generation costs, and account approval remain unknown.

The in-plugin model, Figwright MCP client/provider, Figma seat or plan, and any image generation must each be recorded and explicitly authorized per approved run window. Do not infer that a ChatGPT subscription pays for external provider APIs, MCP usage, Figma seats, or image generation.

## Compatibility verdict

Source versions and required menu names are pinned in the baseline and manual procedure. No Figwright dependency was installed, plugin registered, MCP client configured, server started, or tool request issued. Exact runtime compatibility, exact server/plugin pair behavior, and the actual advertised tool list are therefore NOT MEASURED.
