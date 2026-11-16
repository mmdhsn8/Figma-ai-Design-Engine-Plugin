# Phase 1 — native capability gap

## آنچه اکنون قابل استفاده است

- `manifest.json` روی Figma Plugin API v1.0.0 و `documentAccess: dynamic-page` است؛ controller در `src/plugin/*` صاحب Figma API است.
- `src/shared/schema.ts` و `src/shared/multi-screen-schema.ts` توصیف declarative صفحه، node، component، design system و assets دارند؛ `src/plugin/renderer.ts` و `visual-rendering.ts` آن‌ها را به native Figma nodes تبدیل می‌کنند.
- `src/shared/figma-tools.ts` و `src/plugin/figma-tool-executor.ts` ابزارهای typed و bounded برای خواندن/ساخت/ویرایش و کنترل target/parent/reference دارند. Executor task/operation identity، acknowledgement و reconciliation برای idempotency ثبت می‌کند.
- `src/plugin/design-system/*` style/component registries و token resolution دارد. `variable-adapter.ts` وجود دارد؛ اما `README.md` می‌گوید collection/variable creation و live bindings تا Desktop acceptance ادعا نمی‌شوند.
- Native verification از Figma readback برای ساختار/geometry و برخی موارد contrast استفاده می‌کند و budget/coverage محدود دارد (`src/shared/native-visual-quality.ts`). این با screenshot review انسانی برابر نیست.

## شکاف نسبت به تجربهٔ مرجع

| قابلیت | شکاف اثبات‌شده/باز |
|---|---|
| Context | Chat می‌تواند discovery/inspect محدود داشته باشد، ولی create handoff مسیر document scan را الزام نمی‌کند. Reuse امن از components/styles/variables موجود در file برای creation عمومی ثابت نشده است. |
| Components/instances | schema و native registry موجودند؛ Chat generation contract می‌گوید component reference نیازمند explicit supported manifest است و فعلاً چنین manifestی مجاز نشده. |
| Variables | adapter و types موجودند؛ actual account plan، creation، binding و Desktop behavior تأیید نشده؛ claim ندهید. |
| Images/assets | plugin route به assets مجاز/Brand Kit/placeholder محدود است؛ upload/generation service رسمی MCP در این محصول موجود نیست. Provenance و credit/plan را جدا کنید. |
| Text/RTL/fonts | code normalization و font preflight دارد؛ font availability، shaping، mixed digits، wrapping و Persian RTL روی host واقعی دیده نشده است. |
| Layout/scroll | Auto Layout, clipping, size, overflow و repair logic هست؛ host settle، actual long-scroll behavior و child bounds live readback مفقود است. |
| Safe edit | discovery/ref/ownership/checkpoint code و mock evidence وجود دارد؛ selected target edit با preserved overrides و unchanged neighbors در Desktop اثبات نشده. |
| Throughput | typed operations usable؛ Chat runner serialized native executor و bounded batches دارد. Operation-level plan در screen composition می‌تواند تعداد model/native round را زیاد کند؛ spike باید اندازه بگیرد. |

## قرارداد موردنیاز برای spike

Creation candidate: versioned declarative tree/constraints/tokens/assets/semantic role/IDs؛ mutation candidate: bounded operations روی refs و page scope تأییدشده. Preflight و host readback باید از یک geometry contract استفاده کنند. `Auto Layout`، text sizing، fixed viewport همراه با scrollable content، reusable components/styles، RTL/LTR و asset provenance لازم‌اند. هر featureای که `dynamic-page` یا پلن/API در آن محدودیت دارد، capability-gated بماند.

Figma docs `use_figma` را راه remote اجرای code از مسیر Plugin API معرفی می‌کنند؛ Plugin API itself عملیات native لازم را فهرست کرده است. Parity به معنی reuse ابزار، billing، context model یا entitlement نیست.
