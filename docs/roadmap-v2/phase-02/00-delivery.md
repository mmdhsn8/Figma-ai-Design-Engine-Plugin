# Phase 2 — تحویل و وضعیت

**وضعیت: LOCAL SPIKE COMPLETE / LIVE BLOCKED**

این تحویل، spike اجرایی محدود برای قرارداد عمومی طراحی، adapter بومی، برنامهٔ عملیات typed و seam ترکیبی است. مسیر تولید Chat به آن وصل نشده و هیچ فایل یا صفحهٔ واقعی Figma تغییر نکرده است. تمام fixtureها synthetic هستند؛ provider call برابر صفر است.

## مبنا و شواهد

| مورد | نتیجه | نوع شاهد |
|---|---|---|
| Checkout | شاخهٔ `main`، commit `177072856e2157479338debb2b17cdfc4efb6561` | مشاهدهٔ checkout |
| Manifest | شناسهٔ `1574493506249715820`؛ ورودی‌های `dist/plugin.js` و `dist/ui.html`؛ دسترسی سند `dynamic-page` | source/config؛ `verify:phase5` مسیر ثبت manifest در Figma Desktop را با ریشهٔ checkout تطبیق داد |
| حفاظت production | `src/ui/App.tsx`، مسیرهای Chat/structured generation/JSON import و manifest تغییر نکردند | بازبینی diff؛ hashهای UI و manifest |
| اجرای محلی | چهار fixture از schema/adapter و renderer mock عبور کردند؛ سه دامنهٔ اصلی در H هم‌زمان render و یک heading ویرایش شد | local mock؛ نه Figma Desktop |
| تست نهایی | ۳۹ فایل و ۶۶۵ تست پاس؛ ۷ تست هدفمند spike نیز پاس | Vitest محلی |
| ساخت | plugin و UI build شدند؛ Companion با TypeScript کامپایل شد | build/checks محلی |
| اجرای زنده | screenshot، مشاهدهٔ لایه در Desktop، shaping واقعی فونت فارسی و زمان واقعی Figma جمع‌آوری نشد | **NOT MEASURED / LIVE BLOCKED** |

## Hashهای build (قبل ← بعد)

| Artifact | قبل از تغییر | بعد از build نهایی | تفسیر |
|---|---|---|---|
| `manifest.json` | `01D4429B1D421FDD9F0A24EFCA793EF9FD912E2AD559D1505EC4A5FCB1A2934A` | همان | بدون تغییر |
| `dist/plugin.js` | `BE34DF736CC5F252E74E6C86C6F2176505AD92710A432F12971D0CD01A27A56A` | `666AAE7549ED3537B1D10090522F33621D9232C3A4CD8CACF370C44A521FB15E` | build شامل تغییر additive executor است |
| `dist/ui.html` | `493816780A84EFBBA8EC1213FF70C938C8502B9B50F8A0B73D128F6D2366348A` | همان | بدون تغییر |
| `dist-companion/companion/main.js` | `E6B78B796FA2FC2BF247B9AEA983C03080105E85FF20D0CC9CADA2C8FED018D7` | همان | بدون تغییر |

`git diff --stat` برای دو فایل tracked ویرایش‌شده: `174 insertions(+), 4 deletions(-)`؛ فایل‌های تازه و گزارش‌ها هنوز untracked هستند و در آن خلاصه نمی‌آیند. فهرست کامل در پایان [گزارش adapter](02-adapter-implementation.md) و پاسخ تحویل آمده است. Diff حفاظت‌شدهٔ Chat/UI/manifest/package/renderer/Companion خالی بود؛ preexisting `docs/product-roadmap-v2-audit/` نگه داشته شد.

مبنای مستندات موجود، `docs/product-roadmap-v2-audit/product-contract.md`، `capability-inventory.md`، `baseline-evidence.md`، `non-regression-contract.md`، `mcp-parity-matrix.md`، `native-capability-gap.md`، `quality-baseline.md`، `timing-baseline.md` و `phase-2-spike-plan.md` است. نقشه‌های `docs/phase-11/` تا `docs/phase-14/` و schemaها/renderer/executor جاری نیز بررسی شدند. مسیر Chat handoff در source برای ۱ تا ۱۰ صفحه است؛ این spike فقط یک صفحه به‌ازای هر fixture را اثبات می‌کند.

## خروجی

- DesignProgram نسخهٔ ۱ با اعتبارسنجی strict، محدودیت منابع و fingerprint قطعی.
- Adapter مشترک به `MultiScreenSpec` و همان renderer موجود.
- Candidate B با عملیات whitelistشده از schema و executor فعلی.
- Candidate H که screenهای رندرشده را به refهای scoped executor متصل می‌کند و یک ویرایش محدود را نشان می‌دهد.
- چهار fixture (سه دامنهٔ لازم و Civic به‌عنوان دامنهٔ نادیده)؛ هرکدام **یک صفحه**، نه بستهٔ سه‌صفحه‌ای.
- ۹ گزارش در همین پوشه و source/test قابل اجرا.

## موارد توقف live

برای پذیرش زنده باید یک فایل/صفحهٔ disposable مشخص، مدل قابل مشاهده و مجوز صریح برای mutation تعیین شود. این مرحله در این اجرا انجام نشده است. بنابراین برتری بصری یا برابری با MCP/Figma Desktop ادعا نمی‌شود.

فرمان‌های بازتولید و فهرست کامل فایل‌ها در [۰۲](02-adapter-implementation.md) و [۰۷](07-architecture-decision-and-rollback.md) آمده‌اند.
