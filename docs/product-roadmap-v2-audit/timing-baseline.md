# Phase 1 — baseline زمان و تعداد round

## داده‌های موجود

| Measurement | نتیجهٔ ثبت‌شده | Evidence level / حد |
|---|---:|---|
| JSON parse fixture، 200 دور | میانگین 0.0255ms | LOCAL microbenchmark؛ provider/host شامل نیست |
| normalize + schema validate، 200 دور | میانگین 0.2563ms؛ 200/200 accepted | LOCAL microbenchmark |
| draft write، payload آزمایشی | 2,299 writes/152.65ms در یک run؛ یک buffered write/0.66ms | LOCAL؛ یک نمونه و نویز runner؛ SLA یا speedup تضمینی نیست |
| mock renderer، 100 screens/300 nodes | 30.2ms در Phase 11 report | MOCK؛ Figma Desktop نیست |
| mock renderer، 10 screens/325 nodes | 149.5ms در final integration report | MOCK؛ fixture/runner با مورد بالا یکسان فرض نشود |
| Figma MCP versus plugin | — | NOT MEASURED |
| Provider wait، first native screen، 1/3/10-screen live total | — | NOT MEASURED |

جزئیات و caveatهای اعداد local در `docs/phase-11/performance-baseline.md`، `docs/final-integration-readiness.md` و `docs/phase-14/07-test-build-evidence.md` آمده‌اند.

## Work-count از source، نه زمان پیش‌بینی‌شده

- Chat برای create، اول intent را classify و سپس plan/stages را می‌گیرد؛ تعداد ادامه‌ها به task و مدل بستگی دارد (`src/companion/server.ts`).
- Handoff Chat به structured generator برای هر screen سه section ordered می‌سازد. `src/ui/App.tsx` منتظر هر screen و سپس هر section می‌ماند و persisted section را قبل از render بازیابی می‌کند.
- در مسیر model-driven، هر section یک repair attempt مجاز دارد: **3N** baseline section responses؛ **تا 6N** اگر همه repair شوند، به‌علاوهٔ planning، progress/verification و retryهای transport که متفاوت‌اند.
- Persian Moonwear local composer exception دارد: در `storefrontLayoutVersion === 1` section از `composeStorefrontSection` می‌آید و provider section request صفر است. این عدد، latency کل Chat نیست؛ Chat plan همچنان مدل می‌خواهد.
- Chat granular tool workflow سقف‌های بودجه دارد؛ تا 100 model turns برای task در معماری گزارش‌شده، batch حداکثر 10 function call، mutationهای native serial؛ این سقف‌ها تعداد واقعی round را نشان نمی‌دهند.

## Gaps و روش benchmark بعدی

هیچ trace هم‌بسته‌ای از UI → Companion → model → native batch → readback وجود ندارد که در این audit قابل‌تأیید باشد. ادعای «سریع‌تر از MCP» یا زمان ثابت برای 10 screen فعلاً رد می‌شود.

در spike، برای briefهای ثابت و disposable اندازه بگیرید: model/plan roundها؛ زمان تا first visible native screen؛ response first-byte/complete و wait/retry؛ section compose/validate/persist/render؛ native batch count و node coverage؛ QA و total elapsed؛ pause/resume duration جدا؛ p50/p95 فقط پس از چند run قابل‌مقایسه. Model slug، build hashes، screen count و fixture identity ثبت شود؛ raw prompt/private canvas/credentials در log ذخیره نشود.
