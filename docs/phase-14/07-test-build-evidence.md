# Test and build evidence

Acceptance brief and node counts originate from the same Persian Moonwear fixture. Counts below are prepared screen nodes, including artwork instances and excluding their master definitions and internal descendants. Heights are section heights plus viewport gutters and gaps. These are offline measurements.

| Role | Composition | Prepared nodes | Artwork instances | Controls | Content height |
| --- | --- | ---: | ---: | ---: | ---: |
| Home | Editorial campaign, category controls, 2×2 product grid, trust row and footer navigation | 74 | 5 | 14 | 1263 px |
| Details | Large gallery, three thumbnails, color and size rows, stock, CTA and product information | 62 | 4 | 11 | 1219 px |
| Cart | Two line items, separate steppers, voucher, breakdown, checkout and delivery | 73 | 2 | 10 | 909 px |

Phase 13 user evidence showed sparse canvas previews and a separate run with 3/3 stages and 42 confirmed native mutations. That count measures mutations and cannot serve as an apples-to-apples layer count. The current output demonstrates fuller role coverage, 11 labeled vector assets and exact cross-screen prices. Every prepared role exceeds its 844 px viewport and passed offline preflight and touch/contrast checks. The mock ran nine render transactions and replayed each one without adding nodes, reusing artwork masters. It also rejected a deliberately missing master.

The remaining LIVE measurements are visual before/after comparison at 100%, native text geometry, actual scroll behavior, first-visible time, duration and fresh Desktop layer counts. No live provider or disposable file was used.

SHA-256 of the local verified build:

| File | SHA-256 |
| --- | --- |
| dist/plugin.js | BE34DF736CC5F252E74E6C86C6F2176505AD92710A432F12971D0CD01A27A56A |
| dist/ui.html | 493816780A84EFBBA8EC1213FF70C938C8502B9B50F8A0B73D128F6D2366348A |
| dist-companion/companion/main.js | E6B78B796FA2FC2BF247B9AEA983C03080105E85FF20D0CC9CADA2C8FED018D7 |

## Checks

- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm test -- --maxWorkers=1` passed with 658 tests across 38 files. The parallel run hit four timeouts in existing Windows persistence and credential tests. A serial rerun of the full suite passed.
- `npm run build` and `npx tsc -p tsconfig.companion.json` passed.
- `npm run verify:phase5` matched the registered manifest to this checkout and verified that the compiled Companion boots on loopback.
- `git diff --check` passed.
