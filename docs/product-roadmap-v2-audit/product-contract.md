# Phase 0 — قرارداد محصول

## North Star

کاربر از داخل plugin Chat به فارسی یا انگلیسی، برنامهٔ UI جدیدی را توصیف می‌کند؛ agent هدف، زبان، پلتفرم، تعداد و نقش صفحه‌ها را درمی‌آورد؛ Figma screens منسجم و ویرایش‌پذیر می‌سازد؛ ساختار native را بررسی می‌کند؛ و در پیام بعدی می‌تواند یک صفحهٔ مشخص را با حفظ سایر محتوا و بدون root تکراری ویرایش کند.

**موفقیت محصول** با تعداد node، پاس شدن mock، یا موفقیت یک storefront برابر نیست. شواهد بصری، native، cross-domain و recovery لازم‌اند.

## Journeyهای مشمول قرارداد

| Journey | انتظار محصول | وضعیت قابل اثبات فعلی |
|---|---|---|
| Create 1 screen | یک prompt در Chat، صفحهٔ native با محتوای کامل و QA | مسیر Chat و renderer در source؛ live در Desktop این ممیزی اندازه‌گیری نشد |
| Create 3 screens | یک prompt، نام/ترتیب/سبک منسجم، root مستقل برای هر screen | handoff و mock integration در اسناد قبلی؛ کیفیت و native Desktop تأیید نشده |
| Create 10 screens | یک prompt در Chat، 10 screen در همان task، پیشرفت تدریجی و rootهای یکتا | schema و handoff به 10 محدود شده‌اند؛ خروجی زندهٔ 10-screen موجود نیست |
| Edit one existing screen | ارجاع طبیعی به screen یا بخش، inspect و edit در محدوده، حفظ سایر frameها | ابزارهای Chat برای inspect/edit و آزمون‌های mock وجود دارند؛ پذیرش زنده ندارد |
| Pause / resume | ادامه از checkpoint با همان identity و بدون replay/duplicate | storage، draft و idempotent executor در source؛ Desktop reload اینجا اجرا نشد |

## قرارداد خروجی

- **Native/editable:** Figma frame، text، vector/shape، image یا placeholder مجاز، layout؛ component/instance/style/tokens وقتی قرارداد و API پشتیبانی کنند. تصویر تخت جایگزین یک screen نیست.
- **Visual:** hierarchy قابل دفاع، ترکیب‌بندی و density متناسب با brief، محتوای معنادار، تنوع بین صفحه‌ها، consistency در محصول، و دارایی با provenance روشن.
- **Language/layout:** فارسی با RTL و shaping/فونت واقعی، انگلیسی با LTR؛ اعداد/واحد/ارز متناسب با brief؛ mobile و desktop در scope آزمون.
- **Edit/safety:** read-only context در دامنهٔ لازم؛ ارجاع target باید از evidence بیاید؛ mutation محدود به هدف کاربر؛ حفظ override و ساختارهای نامرتبط؛ حذف یا تغییر مخرب نیازمند preview/تأیید.
- **Recovery:** checkpoint پیش از mutation، identity پایدار، cancel/pause/resume، reconcile بعد از partial commit و عدم ساخت مجدد عملیات تأییدشده.
- **Performance:** ثبت زمان تا اولین native screen، زمان هر screen، زمان کل، model rounds، native batches، wait/retry و QA؛ SLA فقط پس از baseline تکرارشدهٔ زنده تعیین شود.

## محدوده و محدودیت‌های فعلی که باید آشکار بمانند

Chat handoff فعلی 1–10 screen و یک device family در هر task می‌پذیرد؛ viewportهایش 390×844 و 1440×900 هستند (`src/shared/chat-generation.ts`). قرارداد عمومی JSON دامنهٔ بزرگ‌تری دارد، ولی کاربر برای آن باید JSON/import را بشناسد. این ممیزی تضمین رفتار برای درخواست دلخواه، interaction اجرایی در محصول نهایی، یا ساخت 10 screen حرفه‌ای را نمی‌دهد.

Figma MCP remote، API subscription، مدل account-visible و قابلیت image generation entitlement پیش‌فرض محصول نیستند. Capability و هزینه باید بر اساس حساب/پلن واقعی کاربر سنجیده شود؛ هیچ دسترسی رایگان یا API پولی جداگانه وعده داده نمی‌شود.

## تعریف پذیرش در این milestone

Phase 0/1 فقط قرارداد، inventory، baseline و مقایسهٔ capability را تحویل می‌دهد. **هیچ acceptance product یا live برای این milestone ادعا نمی‌شود.** معیار Gate بعدی و evidence لازم در [طرح spike](phase-2-spike-plan.md) است.
