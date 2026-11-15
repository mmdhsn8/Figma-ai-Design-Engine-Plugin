# Phase 12 delivery

## Status

**CODE COMPLETE — LIVE ACCEPTANCE NOT RUN.** The Phase 12 implementation was authorized. The implementation uses a bounded Chat adapter over the existing structured generation and native rendering pipelines. Local unit, integration, fault-path, type, lint, build and Phase 5 verifier checks pass. This does not claim live provider or Figma Desktop acceptance, production visual quality, or a speed improvement.

## Revision and build identity

- Git HEAD: `8088aa08c61cef750c843394ddaf0bab94eb75ed`, branch `main`.
- Working tree: Phase 12 implementation and required docs are dirty/uncommitted. The preexisting untracked `docs/phase-11/` tree was not edited.
- Manifest: registered Figma AI Design Engine manifest, ID `1574493506249715820`, `main: dist/plugin.js`, `ui: dist/ui.html`, `documentAccess: dynamic-page`, production `allowedDomains: ["none"]`, development Companion `http://localhost:1455`.
- The manifest was unchanged. Final built identity (UTC timestamps, SHA-256):

| Artifact | Last modified | Size | SHA-256 |
|---|---|---:|---|
| `manifest.json` | 2026-11-08 07:39:57 | 325 B | `01D4429B1D421FDD9F0A24EFCA793EF9FD912E2AD559D1505EC4A5FCB1A2934A` |
| `dist/plugin.js` | 2026-11-15 06:14:25 | 1,885,046 B | `E6E42CE0BAE8E61059D403DC6CB467C531A1C518C33CDF2BC2A9E0ADF57C873F` |
| `dist/ui.html` | 2026-11-15 06:14:19 | 1,371,614 B | `8E82B6522DE932309E3071BEF5F1E287F82EFD2DC35A1354AED3FB9071BCCECF` |
| `dist-companion/companion/main.js` | 2026-11-15 06:14:53 | 2,563 B | `E6B78B796FA2FC2BF247B9AEA983C03080105E85FF20D0CC9CADA2C8FED018D7` |

## Changed files

- `src/shared/chat-generation.ts`: versioned request/plan, count and dependency validation, deterministic IDs/fingerprint, bounded intent parsing and native-root identity contract.
- `src/ui/App.tsx`, `src/ui/chat-task.ts`, `src/shared/chat-task.ts`, `src/shared/chat-tools.ts`, `src/companion/server.ts`: route one explicit Chat create task through the pinned structured generator and persist progress, correlation, failure and recovery. Existing Chat JSX and visual styles are unchanged.
- `src/shared/generation-draft.ts`, `src/shared/design-generation.ts`, `src/shared/messages.ts`: correlate the generation draft to its Chat task and enforce the bounded prompt/native-root result contract.
- `src/plugin/generation-controller.ts`, `src/plugin/figma-tool-executor.ts`: attach and restore verified task-owned screen root references using the existing native generation and task-ref systems.
- `src/plugin/renderer.ts`, `src/shared/visual-design-spec.ts`, `src/ui/design-generation.ts`: reuse pinned background and stable section references in composed/native visual verification.
- `tests/chat-generation.test.ts`, `tests/chat-task.test.ts`, `tests/figma-tool-executor.test.ts`: request, task, mocked generation-to-native integration, fault recovery and stable root reference evidence.
- `docs/phase-12/`: architecture, contract, handoff, test evidence, live gate and delivery record.

## Handoff evidence

The mock integration test passes one three-screen Chat task through the real typed plan adapter, mocked provider section responses, nine durable section saves, a draft reload between save and render, the existing native controller/renderer and native verifier. It confirms verified native root IDs and stable task logical references are recorded. Contract tests cover the 1- and 10-screen bounds, and a fault test confirms missing native QA cannot complete the Chat task. This is mocked local evidence, not a live call or performance measurement.

## Tests and remaining boundary

See [test-evidence.md](test-evidence.md) for commands and counts. Provider response timings, Figma Desktop render timings and visual acceptance are **NOT MEASURED**. See [live-acceptance.md](live-acceptance.md) for the authorization and access blockers.

Phase 13–17 work is not started. A proposed next sequence is: live two-screen acceptance and serial baseline; native layout/visual-quality refinements from measured findings; measured three-/ten-screen scale and recovery; bounded concurrency only if data supports it; then cross-screen navigation/component reuse and broader follow-up edit coverage. These are follow-on proposals, not commitments or Phase 12 claims.

## تحویل کوتاه

پیاده‌سازی فاز ۱۲ در مسیر Chat به تولید ساختاریافته و لایه‌های بومی فیگما انجام شد و آزمون‌های محلی و شبیه‌سازی‌شده موفق‌اند. آزمون زنده با مدل واقعی و Figma Desktop اجرا نشده است؛ برای آن هنوز تأیید جداگانه و یک فایل آزمایشیِ جدید لازم است.
