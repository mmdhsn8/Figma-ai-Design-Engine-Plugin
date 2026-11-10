# Phase 5.9.3 — Progressive Figma Discovery

## Execution model

`createProgressiveDiscoveryScanner` in `src/plugin/document-discovery.ts` owns read-only page and frame discovery. `get_document_context` invokes it directly; the `INSPECTING` controller chooses the scan and decides completion from native evidence. After one intent classification, the model does not choose each page, cursor, or frame operation.

The scanner enumerates page IDs once per reconciliation, loads one page at a time with `PageNode.loadAsync`, and walks its tree with a validated ID/child-index DFS cursor. It does not change the active page or selection. Node slices yield with a zero-delay task; otherwise the loop yields at least every four completed pages or when the 100 ms ceiling is approached. Progress is sent at most every 750 ms (plus each ten completed pages). The work budget adapts between 16 and 128 units to keep traversal near the 35 ms target.

The scan has no fixed total page, node, or matching-frame cap. A tool response contains at most eight frame samples and 24 page samples. Full counts and coverage state remain in the compact cursor. An individual cursor is limited to 256 KiB; the discovery namespace is capped at 12 entries / 1.5 MiB. On empty-page runs, checkpoints commit every 32 pages; pause, cancellation, partial node slices, and the final page commit immediately. A crash can therefore replay at most 31 completed empty pages; a user pause or cancellation commits before returning. If a limit prevents a safe checkpoint, the result is `PARTIAL` with a precise reason and no false completeness claim.

## Resume, invalidation, and cache

Cursor keys include a hash of document identity, query, page scope, and task/read-only mode. The versioned index is limited to discovery-owned keys and migrates legacy discovery entries using `clientStorage.keysAsync`. It evicts the least recently used completed cursor only; paused or unfinished task cursors and all non-discovery task checkpoints are preserved. The in-memory loaded-page ID cache and page-level change listeners are each capped at 64 entries. After the listener cap is reached, a single document-change listener invalidates all cached page summaries on the next scan reconciliation. Cache counts, bytes, listener counts, and fallback state are included in the report.

During one plugin session, `nodechange` events invalidate only affected pages. Page additions, removals, renames, and reordered root children reconcile against stable page IDs. A mid-page stack is reconstructed by node ID and validated against its saved parent and child position; if that fails, the affected page is rescanned. A plugin restart has no durable Figma document revision to prove that earlier pages stayed unchanged, so the old completeness claim is discarded and the requested scope is revalidated. This is deliberate: reused evidence cannot authorize an edit or establish current exhaustive coverage.

Exact numeric node IDs and explicit page IDs take a targeted path before whole-document traversal. Name and project searches include frame/page names and existing ownership and generation metadata. Inspection-only refs live in client storage and are never written onto Figma nodes. A cross-page edit target can be returned only when it has ownership metadata; before mutation, the executor verifies the live node ID, page ancestry, parent, type, and ownership fingerprint. Existing native identity and operation-ledger checks remain in force.

## Cancellation and limits

Cancellation and pause are checked during node traversal and while awaiting page loads. A page load is treated as unresponsive after ten seconds. Figma does not expose an abort signal for `PageNode.loadAsync`; if cancelled during that API call, the scanner stops waiting and schedules no later pages, while the already-started Figma load may finish in the background. The active page and selection are not changed by discovery.

Figma page loading is asynchronous and only pages loaded in this runtime are traversed; the plugin does not call `loadAllPagesAsync`. Figma may retain loaded page data for the document session, and the plugin API does not provide a page-unload operation. The scanner bounds plugin traversal, result payloads, and checkpoint memory, but cannot promise constant Figma-owned memory for a document whose pages the host has loaded.

Native previews verify each matching frame's identity and geometry and include up to three direct-child samples. Full matching counts are exhaustive when `complete: true`; returned detailed frame samples remain bounded to eight. This is a lightweight inspection inventory, not a complete export of every descendant property.

## Acceptance protocol for Figma Desktop

After importing the registered `manifest.json` with the built `dist/plugin.js` and `dist/ui.html`:

1. Run: “Inspect all existing Charm frames across accessible pages without selecting anything or modifying the canvas.”
2. Compare the saved current page and selection before and after. Confirm the report's page count, matching count, native inspection count, coverage flag, timings, payload sizes, model request count, and `Canvas mutations: 0`.
3. Repeat on a 300–400 page test file. Observe progress, pause, resume, and cancellation; confirm the last page is reached or a precise partial reason is reported.
4. Restart the plugin during an incomplete scan. Confirm the stored task remains visible and the fresh run reports revalidation rather than claiming the old cursor is current.
5. Compare `nativeExecutionMs`, `pageLoadMs`, `scanElapsedMs`, transfer bytes, UI render commits/duration, and Companion/model time from the task report against the pre-change live trace.

The automated scale suite uses mocks; it does not establish live Desktop latency or the memory behavior of Figma's own page loader.

## Mock measurements

On the local test runner, a 400-page mock with the only Charm frame on the last page completed in about 1.49 s native execution, with 400 pages loaded, 2 scene nodes visited, 1 matching frame inspected, and 3,858 transfer bytes. It made 28 discovery-storage writes. Before checkpoint batching, the same mock took about 6.15 s and made 162 discovery-storage writes. A separate mock with 1,000 matching frames and 4,000 total nodes completed in about 0.91 s native execution across 56 bounded slices; the maximum observed slice was 24 ms and transfer size was 7,069 bytes. These values are regression measurements for the mock environment, not live Figma hardware benchmarks.
