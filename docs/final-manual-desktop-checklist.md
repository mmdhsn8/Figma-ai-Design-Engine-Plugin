# Final Manual Desktop Acceptance Checklist

Use this only with a clearly confirmed disposable Figma document or a safe user-approved duplicate. Do not use Charm Home, Test Shop, or any valuable existing file. The checklist does not authorize a canvas edit by itself. If a safe file/session is not available, leave mutation items BLOCKED and preserve that status.

## Before opening the canvas

- [ ] Confirm the registered path is `C:\Users\rayan-it\Desktop\figma ai engine v2\Figma Plugin Updated\manifest.json`; run `npm run verify:phase5` after the final build.
- [ ] Start the existing local Companion with `npm run companion`. Confirm its health state on loopback; do not expose or record credentials.
- [ ] Open the approved disposable document and record its name, current page, initial frame count, selection, and task history. Confirm the original document is not active.
- [ ] Authenticate through the existing approved flow. Record only sanitized account/model state and the model selected for this task.
- [ ] Capture a baseline screenshot with canvas and Layers panel visible. Save it with the sanitized evidence set.

## UI, account, and task pins

- [ ] At the default 440×720 panel size, open Home, History, More, Settings, Brand Kit, Skills, Chat, and task progress/error views. Resize and scroll the panel; verify no clipped or inaccessible controls.
- [ ] Check RTL/Persian and English/LTR reading order, keyboard focus, visible focus state, screen-reader labels, drawer navigation, and empty/loading/error states.
- [ ] Select a known available model, create a Brand Kit revision and one imported or locally created Skill revision, and begin a task. Record task/model/kit/skill IDs and revisions.
- [ ] Change the default Brand Kit or disable/archive the Skill after task creation. Reload and resume; verify the task still has its exact original model and immutable revisions.
- [ ] Attempt a safe account switch only if the account already has an authorized session. Confirm a stale response cannot change the task identity or output destination.

## Visual/design scenarios

- [ ] Generate a Persian RTL commerce home for a 390 px-class viewport. Inspect header, hero, categories, image area, product cards, toman pricing, CTA, typography, spacing, contrast, clipping, and editable native layers.
- [ ] Generate an English LTR SaaS/dashboard screen. Inspect hierarchy, navigation, labels, data components, spacing, and editable native layers.
- [ ] Generate mobile and desktop variants of the same experience. Verify shared tokens and responsive layout changes; confirm clusters are side-by-side with the established 6,000 px wrap width and 120 px gap unless task settings explicitly override them.
- [ ] On a safe existing screen, perform one requested visual improvement. Compare target ID, page, bounds, child identities, and total node count before/after; confirm no duplicate root frame.
- [ ] Create a root with a full-bleed covering child, then change the visible background. Inspect both the root fill and visible child fill; the visible appearance and reported native target must agree.
- [ ] Create a controlled ten-screen project. Verify deterministic names/order, progress, unique roots, no unintended overlaps, consistent type/color/navigation, reusable patterns, pause/resume, and history result. Review screenshots and Layers for every screen.
- [ ] Run one controlled Skill before/after fixture and verify the selected pattern changes only the expected allowed visual structure. Confirm it cannot change the selected model, tools, Brand Kit, user colors, or safety rules.
- [ ] For semantic Brand Kit actions, verify actual native fill/text/stroke hex values match the pinned revision. Repeat with an explicitly requested user color and verify it wins. Read back values after the write.
- [ ] Use only authorized local/document image assets with source and rights recorded. If absent, verify every fallback is clearly an editable illustration/placeholder and not represented as photography.

## Recovery, history, and resilience

- [ ] Start a task that has more than one native operation. Pause after one confirmed mutation, reload/restart the plugin and Companion through normal controls, then resume once.
- [ ] Compare operation IDs, node IDs, root count, and ledger state before and after resume. Confirm committed work is not replayed, duplicated, or marked green before fresh native verification.
- [ ] Check partial commit, blocked verification, safe no-op, retry, failure, and completion states in task status and History.
- [ ] If safe and authorized, briefly exercise Companion offline/restart and normal reconnect. Confirm the saved task retains the same model/brand/skill pins and output destination.
- [ ] Review model catalog refresh/cancellation and a removed/unavailable selected model. The task must block inference rather than silently choose another model.

## Scale and evidence capture

- [ ] Capture a sanitized screenshot for Persian commerce, English dashboard, responsive pair, edit/background, and ten-screen project with Layers visible.
- [ ] Save native-tree snapshots and readback values for exact target IDs, fill/text values, parent-child structure, bounds, quality coverage, and task revision IDs. Redact account identifiers, prompts, tokens, and provider payloads.
- [ ] Record separate wall time, model latency, Companion transport, native render, persistence, verification, memory, and observed UI responsiveness where measurable. State fixture size and environment.
- [ ] Only run a 100-screen stress task if the disposable file, model/session capacity, and local resources are available. Do not run a 300–400-screen native task in a valuable file; planning limits are not render evidence.
- [ ] Store artifacts under `docs/evidence/final-live-acceptance/` only after the live run actually occurs. Update the acceptance matrix and regression ledger with evidence paths and PASS/FAIL; keep all unperformed checks BLOCKED or NOT RUN.

## Stop and preserve

Stop the affected scenario if the target is ambiguous, a page/document changes, a saved checkpoint cannot be written, operation acknowledgement is ambiguous, native readback is incomplete, the model/account identity changes unexpectedly, or the selected file is not disposable. Preserve committed work and diagnostics; do not reset storage or clean up by deleting nodes to make the test appear green.
