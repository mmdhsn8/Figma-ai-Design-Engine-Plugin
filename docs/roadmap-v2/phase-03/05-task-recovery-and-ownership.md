# Checkpoint، recovery و ownership

- هیچ storage موازی ساخته نشده؛ همان `ChatTask` شامل `executionRoute`, plan/fingerprint، model/account pinned، screen checkpointها، status/fingerprint برنامه، batch ID، root ref و adoption operation IDهاست.
- پیش از render، plan و برنامهٔ strict هر screen ذخیره می‌شوند. وضعیت `rendering` قبل از dispatch persist می‌شود؛ success فقط بعد از task-owned native inspection و تطبیق viewport، scroll، نوع root و شمارش کامل subtree ثبت می‌شود.
- provider response قبل از پردازش در `pending` checkpoint می‌شود؛ reload می‌تواند همان پاسخ را مصرف کند. semantic repair فقط یک نوبت و برای findingهای محلی ذخیره‌شده مجاز است.
- پاسخ ambiguous renderer با همان program identity resume/replay می‌شود. تست injected lost acknowledgement پس از create را بازپخش کرد و یک root ماند؛ provider دوباره صدا زده نشد.
- renderer و executor موجود با task/document/page scope استفاده می‌شوند. collision/ambiguity یا تغییر صفحه پاسخ موفق نمی‌دهد. صفحات تاییدشده در خطای بعدی پاک نمی‌شوند.
- completion نیازمند تأیید همهٔ screenها و stageهاست؛ incomplete readback یا ownership باعث failure قابل بازیابی می‌شود، نه پیام موفقیت.

Mock tests در `tests/universal-design-chat.test.ts` route، task scope، ownership/readback، semantic repair و replay را می‌سنجند. Desktop crash/pause/cross-document tests در این مرحله اجرا نشده‌اند؛ دامنهٔ اثبات در [گزارش زنده](07-live-acceptance.md) محدود است.
