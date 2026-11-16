# Phase 0 — baseline و برچسب evidence

هر گزاره باید یکی از این برچسب‌ها را داشته باشد: **SOURCE** (کد/config حاضر)، **DOC-REPORTED** (گزارش سابق مخزن)، **USER-REPORTED** (گزارش کاربر در roadmap)، **LOCAL/MOCK**، یا **LIVE**. LIVE فقط با Figma Desktop و مدل مجاز/ثبت‌شده پذیرفته می‌شود.

## Snapshot بررسی‌شده

| مورد | Evidence | وضعیت |
|---|---|---|
| Checkout | branch `main`، HEAD `1770728`، tree در آغاز کار clean | SOURCE |
| Plugin identity | manifest ID `1574493506249715820` و entrypointهای `dist/plugin.js` و `dist/ui.html` | SOURCE |
| Build artifacts | `dist/plugin.js` = `BE34DF736CC5F252E74E6C86C6F2176505AD92710A432F12971D0CD01A27A56A`; `dist/ui.html` = `493816780A84EFBBA8EC1213FF70C938C8502B9B50F8A0B73D128F6D2366348A`; `dist-companion/companion/main.js` = `E6B78B796FA2FC2BF247B9AEA983C03080105E85FF20D0CC9CADA2C8FED018D7` | SOURCE؛ با Phase 14 build report مطابق |
| Manifest hash | `01D4429B1D421FDD9F0A24EFCA793EF9FD912E2AD559D1505EC4A5FCB1A2934A` | DOC-REPORTED در `docs/final-integration-readiness.md`؛ hash این ممیزی با آن برابر بود |
| Build/test | Phase 14 سند `typecheck`, `lint`, serial test suite 658 tests/38 files، `build` و `verify:phase5` را PASS گزارش می‌کند | DOC-REPORTED؛ در این ممیزی اجرا/تکرار نشد |
| Figma registration | گزارش قبلی می‌گوید manifest همین checkout با registration مطابقت داشته؛ script مسیر را از Figma settings در صورت وجود می‌خواند | DOC-REPORTED؛ runtime فعلی و active plugin دوباره تأیید نشد |
| Live provider/model | Roadmap نبود evidence زندهٔ عمومی را اعلام می‌کند؛ docs نیز OAuth/provider acceptance را pending می‌دانند | LIVE NOT MEASURED |

## Generation و latency

- **SOURCE:** Chat handoff به 1–10 صفحه محدود است، یک device family می‌پذیرد و برای هر صفحه `identity`, `primary`, `supporting` دارد. generator روی screen و سپس section حلقهٔ ترتیبی دارد.
- **SOURCE:** هر section حداکثر یک repair attempt دارد؛ بدون repair، `3N` پاسخ section لازم است؛ حد نظری `6N` در صورت repair همهٔ sectionهاست. این تعداد، زمان نیست.
- **DOC-REPORTED, LOCAL:** `docs/phase-11/performance-baseline.md` گزارش می‌کند parse میانگین 0.0255ms، normalize+validate 0.2563ms، 100-screen mock render برابر 30.2ms؛ microbenchmark فایل فقط illustrative است.
- **DOC-REPORTED, MOCK:** `docs/final-integration-readiness.md` نمونه‌های دیگری از render mock (10 screens/325 nodes در 149.5ms؛ 100 roots/300 nodes در 91.2ms) می‌دهد. fixtureها و runner متفاوت‌اند؛ اعداد را مستقیم مقایسه یا به user SLA تبدیل نکنید.
- **LIVE NOT MEASURED:** provider wait، first-native-screen، زمان کل Chat یا 10 screen، Desktop layout/font settle، memory واقعی و Figma MCP هم‌brief.

## Native، QA و خروجی

- **DOC-REPORTED, LOCAL/MOCK:** Phase 14 برای fixture فارسی «ماه‌پوش» سه نقش home/detail/cart و 74/62/73 node آماده، مجموع 209 node، 11 labeled vector assets و 9 render transaction گزارش می‌دهد. اینها prepared/mock metrics هستند، نه اندازه‌گیری canvas زنده.
- **USER-REPORTED/DOC-REPORTED:** یک اجرای قبلی 3/3 complete و 42 native mutations در Figma دیده شده؛ roadmap می‌گوید کیفیت بصری ضعیف بوده. تعداد mutation نه node count است نه quality score.
- **DOC-REPORTED:** Phase 14 می‌گوید همان خروجی محلی از viewport 844px بلندتر است و offline preflight/touch/contrast را گذرانده؛ scrolling، clipping، typography و screenshot واقعی هنوز pending است.
- **LIVE NOT MEASURED:** native tree و component propagation، font shaping، RTL، scroll behavior، 44×44 واقعی، clipping/contrast روی Desktop، و human visual rubric.

## Failure/coverage history

Roadmap ورودی و اسناد Phase 13/14 موارد clipped-child، حد tap target، contrast، محدودیت عرض 844، mismatch intent و توقف verification را به‌عنوان سابقه می‌آورند. Source test inventory نیز recovery، duplicate، clipping، contrast و targeting را پوشش می‌دهد. در این کار هیچ‌کدام دوباره reproduce نشده‌اند؛ هر مورد باید در acceptance matrix با artifact و وضعیت باز/بسته ثبت شود، نه اینکه صرف وجود test به معنی رفع live باشد.

## اطلاعاتی که عمداً جمع‌آوری نشد

هیچ canvas یا storage پلاگین باز/ویرایش نشد؛ هیچ Figma MCP remote متصل نشد؛ هیچ OAuth یا model request، screenshot، private canvas text یا credential استخراج نشد؛ هیچ test/build اجرا نشد. برای live acceptance، فایل disposable مشخص، مدل account-visible، مجوز provider/Figma، runtime hashes و trace sanitized لازم است.
