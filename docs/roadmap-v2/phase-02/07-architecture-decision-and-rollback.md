# تصمیم معماری، migration boundary و rollback

## تصمیم

**GO محدود برای adapter محلی A + scoped operation B/H. NO-GO برای migration/فعال‌سازی production.** شواهد مثبت: چهار domain fixture با یک contract و adapter، native mock readback ساختاری کامل/بدون finding، عملیات typed B قابل اجرا و H ویرایش یک node با حفظ دو root دیگر. محدودیت تعیین‌کننده: Desktop visual/native acceptance و fault injection کامل adoption هنوز نداریم؛ چهار brief نیز 1-screen هستند.

## مرز پیشنهادی برای مرحلهٔ اتصال بعدی

در صورت مجوز جداگانه، Chat-to-generation interface موجود باید در مرز adapter ورودی نسخه‌دار بگیرد و به همان مسیر structured generation فعلی برسد؛ Chat UX، provider/account choice و checkpoint state فعلی منبع حقیقت بمانند. Converter باید در مرز ورودی `DesignProgramV1 → current generation contract` نسخه‌دار و مستقل باشد. عملیات ویرایش باید همچنان از executor و task/document/page scope موجود عبور کند.

پیش از عرضه لازم است:

1. disposable Figma file/page و model صریحاً مشخص و مجاز شوند.
2. Desktop با build/manifest تأییدشده، 1 screen نماینده را create کند؛ layer، text، dimension، RTL/scroll و screenshot ثبت شود.
3. adoption boundary failure persistence/page-switch/cancel و repair/QA complete fault-injection شود.
4. بعد از موفقیت، feature flag جدا و خاموش به‌طور پیش‌فرض، version adapter و یک route opt-in برای rollout محدود تعریف شود. Chat UI تغییر نکند.
5. compatibility تست کند draft/task/history/checkpointهای نسخهٔ فعلی بدون rewrite حفظ می‌شوند؛ migration خودکار مجاز نیست.

## Rollback

در این checkout rollback برای spike یعنی route production همچنان به کد قبلی اشاره کند، import آزمایشی حذف/خاموش شود و `registerRenderedGeneration` تنها برای seam آزمایشی قابل دسترسی باشد. هیچ ذخیرهٔ قدیمی پاک/تبدیل نمی‌شود. اگر future rollout feature-flagged شود، flag خاموش‌کردن مسیر جدید را برمی‌گرداند؛ ledger/checkpoint format باید با نسخهٔ قبلی سازگار باقی بماند یا قبل از rollout converter برگشت‌پذیر/نسخه‌دار ارائه شود. این run commit/reset انجام نداد.

## ریسک‌ها

- adoption، native renderer output را به ledger typed operation موجود معرفی می‌کند؛ failure atomicity در تمام boundaryها هنوز ثابت نشده.
- FNV fingerprint رمزنگاری‌شده نیست.
- primitive coverage و native style/asset fidelity از محصول نهایی کمتر است.
- مدل عمومی، کیفیت حرفه‌ای arbitrary prompt یا 10-screen result را تضمین نمی‌کند.
- build `dist/plugin.js` را تغییر می‌دهد، چون bundle از executor توسعه‌یافته ساخته می‌شود؛ manifest و UI bundle ثابت ماندند.

برای دسترسی به rollback و ادامهٔ شواهد live، [پروتکل پذیرش](08-live-acceptance-protocol.md) را دنبال کنید.
