# Phase 1 — baseline کیفیت بصری و domain fit

## آنچه source فراهم می‌کند

`design-patterns.ts`, `visual-composition.ts`, `visual-design-spec.ts`, `professional-visual.ts` و `visual-quality.ts` composition/role، density، assets، palette و QA را مدل می‌کنند. الگوهای چنددامنه‌ای وجود دارند. `native-visual-quality.ts` اندازه‌گیری ساختاری، clipping/geometry/contrast و coverage budget را انجام می‌دهد؛ verifier می‌تواند نتیجهٔ ناقص را pass نکند.

این‌ها **سازوکارهای کیفیت** هستند، نه شاهد قضاوت انسانی دربارهٔ حرفه‌ای بودن طراحی.

## محدودیت‌های cross-domain که در source دیده شد

- `DesignGenerationRequestSchema` نوع project را به `auto | storefront | dashboard | product` محدود کرده است.
- `inferProjectType()` storefront و dashboard را با keyword تشخیص می‌دهد؛ fallback برای حوزهٔ دیگر `product` است. Screen defaultها نیز برای storefront/dashboard/product تعریف شده‌اند. این classification برای آموزش، رزرو یا سلامت taxonomy عمومی محسوب نمی‌شود.
- `storefrontLayoutVersion` opt-in، `storefront-layout.ts`، `applyStorefrontDesignSystem()` و Persian fashion recipe در Companion، ترکیب‌بندی و جزئیات commerce را hardcode می‌کنند. آن‌ها را برای fixture نگه دارید؛ برای core عمومی تعمیم ندهید.
- `design-patterns.ts` domainهای بیشتری دارد، ولی وجود enum/pattern به‌تنهایی ثابت نمی‌کند که planner برای brief ناشناخته screen purpose و content hierarchy درست انتخاب کند.

## Evidence کیفیت فعلی

| Evidence | آنچه نشان می‌دهد | آنچه نشان نمی‌دهد |
|---|---|---|
| Phase 14 Moonwear fixture: 74/62/73 node، 209 total، 11 vector assets | local composer می‌تواند سه role فروشگاهی کامل و معنادار آماده کند | generality، visual acceptability روی canvas واقعی یا ده صفحه |
| 9 mock transactions و idempotent replay | fixture مسیر render/replay خود را در mock پوشش می‌دهد | plugin crash/reload واقعی یا no-duplicate Desktop |
| گزارش قبلی 3/3 و 42 mutations | یک اجرای کاربر تا completion رسیده | quality؛ mutation count لایه و aesthetics نیست |
| preflight touch/contrast و native QA code | برخی معیارهای measurable قابل‌بررسی‌اند | typography، aesthetic hierarchy، readability و domain fit انسانی |

Phase 14 acceptance سند خود را pending می‌داند: 100% visual inspection، text geometry، actual scroll، clipping، first-visible time، total duration و fresh Desktop layer counts. Roadmap ورودی نیز کیفیت اجرای قبلی را ضعیف گزارش می‌کند. هیچ تصویر یا فایل زنده در این ممیزی دیده/تولید نشد.

## Rubric لازم برای مرحلهٔ بعد

برای هر screen، داور انسانی در 100% و overall zoom جداگانه امتیاز دهد: (1) محتوای کامل/مرتبط، (2) hierarchy و scan path، (3) domain appropriateness، (4) composition/density و تنوع، (5) typography/readability و RTL/LTR، (6) consistency، (7) native editability/reuse، (8) clipping/tap target/contrast. معیار threshold را قبل از دیدن خروجی‌ها تعیین کنید. تعداد node/fixture name/validation pass امتیاز نیست.
