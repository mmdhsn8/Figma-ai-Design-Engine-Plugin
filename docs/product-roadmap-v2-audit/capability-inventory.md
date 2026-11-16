# Phase 0 — inventory قابلیت‌ها

## ساختار و مرز runtime

```text
Plugin Chat/UI (src/ui/App.tsx)
  ├─ JSON/import → MultiScreenSpec → plugin renderer
  ├─ structured generation → local Companion /v1/design → section draft → renderer
  └─ Chat → local Companion /v1/chat → typed Figma tool executor → native QA

Figma plugin controller (src/plugin/*) owns Figma API calls.
Local Companion (src/companion/*) owns auth/provider calls and durable drafts.
```

این سه مسیر قراردادهای جدا دارند؛ JSON/import یک مسیر آفلاین و deterministic است، structured generation strict schema و section transaction دارد، و Chat مسیر stage/tool با inspect/edit و recovery است. منبع map: `docs/phase-11/architecture-map.md` و `docs/phase-12/architecture-and-reuse.md`؛ مسیر Chat-to-generation نیز در `src/shared/chat-generation.ts` و `src/ui/App.tsx` است.

## Inventory بر پایهٔ source

| قابلیت | Source evidence | برآورد این ممیزی |
|---|---|---|
| Plugin Chat و model selector | `src/ui/App.tsx`, `src/ui/companion-client.ts`, `src/companion/server.ts` | موجود؛ routing به model زنده اجرا نشد |
| 1–10 screen Chat create | `src/shared/chat-generation.ts` (`MultiScreenDesignRequestSchema` تا 10 screen)، `src/ui/App.tsx` handoff | قرارداد و مسیر موجود؛ live 10-screen اثبات نشده |
| Multi-screen JSON/import | `src/shared/multi-screen-schema.ts`, `src/ui/App.tsx`, `src/plugin/renderer.ts` | موجود و مستقل از مدل؛ کاربرساختار JSON لازم دارد |
| Structured generation | `src/shared/design-generation.ts`, `src/ui/design-generation.ts`, `/v1/design` در `src/companion/server.ts` | موجود؛ 3 section ordered برای هر screen؛ repair bounded |
| Chat native tools | `src/shared/figma-tools.ts`, `src/plugin/figma-tool-executor.ts`, `src/ui/chat-task.ts` | bounded, typed, task-owned; به roundها و mutationهای متعدد وابسته |
| Native render/layout | `src/plugin/renderer.ts`, `src/plugin/visual-rendering.ts`, `src/plugin/canvas-placement.ts` | frames/text/vector/assets/Auto Layout از schema موجود؛ host behavior نیازمند Desktop |
| Design system | `src/shared/schema.ts`, `src/shared/design-system-schema.ts`, `src/plugin/design-system/*` | schema، token resolution، native style/component registries موجود؛ feature availability و readback واقعی باید جدا سنجیده شود |
| Variables | `src/plugin/design-system/variable-adapter.ts`; README.md بخش Variables | adapter وجود دارد؛ README صریحاً می‌گوید ایجاد collection و live binding تا Desktop acceptance ثابت نشده و ادعا نمی‌شود |
| Brand Kit | `src/shared/brand-kit.ts`, `src/ui/brand-kit-manager.tsx`, storage/bridge files | موجود؛ pin/revision و style context در task؛ UI نباید بازطراحی شود |
| Skills | `src/shared/design-skill.ts`, `src/ui/design-skills-manager.tsx`, selection storage | موجود و task-pinned؛ پوشش واقعی domainهای ناآشنا اثبات نشده |
| History/checkpoints | `src/shared/chat-history.ts`, `src/plugin/chat-history-storage.ts`, `src/shared/chat-task.ts`, draft store | موجود؛ mock persistence evidence وجود دارد؛ Figma reload زنده اجرا نشد |
| Existing screen inspect/edit | `src/plugin/document-discovery.ts`, `src/plugin/figma-tool-executor.ts`, Chat tool protocol | source و تست‌های recovery/targeting موجود؛ collateral-free live edit اثبات نشده |
| Visual/native QA | `src/shared/native-visual-quality.ts`, `src/plugin/native-design-verification.ts` | ساختاری، اندازه‌گیری و محدود به node/depth budget؛ review انسانی و native rendering زنده لازم است |
| Asset control | `src/shared/visual-schema.ts`, `src/shared/visual-assets.ts`, `src/shared/chat-generation.ts` | provenance/schema موجود؛ Chat multi-screen عمدتاً Brand Kit asset یا placeholder مجاز می‌کند |

## General-purpose در برابر commerce-specific

**عمومی/قابل‌استفاده:** design nodes، multi-screen schema، composition patterns با چند domain، style tokens، renderer، layout placement، tool protocol و checkpoint/reconciliation.

**ویژه/ریسک bias:** project type فقط `auto | storefront | dashboard | product` است (`src/shared/design-generation.ts`). prompt classifier فقط storefront و dashboard را صریح تشخیص می‌دهد و بقیه را product می‌گذارد. Screen defaults و aliasها در همان فایل domain-specific هستند. `src/shared/storefront-layout.ts` composer محلی اختصاصی دارد؛ `src/ui/design-generation.ts` برای `storefrontLayoutVersion` استایل/components ویژه اعمال می‌کند؛ `src/companion/server.ts` نیز Persian fashion storefront recipe داخل instructions دارد. Commerce یک fixture معتبر است، اما شاهد generality نیست.

## Build، manifest و Companion

- `manifest.json`: plugin ID `1574493506249715820`، `api: 1.0.0`، `main: dist/plugin.js`، `ui: dist/ui.html`، `documentAccess: dynamic-page`؛ production `allowedDomains: ["none"]` و development فقط `http://localhost:1455`.
- `package.json`: Companion از `dist-companion/companion/main.js` اجرا می‌شود؛ توسعه و build اسکریپت local دارد.
- SHA-256های فایل‌های حاضر با گزارش build در `docs/phase-14/07-test-build-evidence.md` مطابق‌اند؛ manifest hash در `docs/final-integration-readiness.md` ثبت است. خود build hash به تنهایی ثابت نمی‌کند چه نسخه‌ای همین حالا در Figma اجرا است.
- آن گزارش قبلی می‌گوید `npm run verify:phase5` مسیر manifest ثبت‌شده را match کرده؛ این ممیزی settings فعلی Figma یا runtime را دوباره نخواند. اسکریپت فقط وقتی `APPDATA` و registration موجود باشند مسیر را assert می‌کند.
- Local Companion، OAuth/account scope و model selector پیاده شده‌اند؛ OAuth، account-visible model، billing/entitlement و provider call در این ممیزی فعال یا تأیید نشدند.
