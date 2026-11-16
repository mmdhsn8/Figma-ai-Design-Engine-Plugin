# قرارداد خروجی مدل و امنیت

## مدل و ابزارها

هیچ provider جدیدی اضافه نشده است. ChatTask همان model slug و account scope انتخاب‌شده را نگه می‌دارد؛ درخواست‌ها از Companion احراز‌شده و `streamAuthorizedChat` موجود عبور می‌کنند. `assertAuthorized` وضعیت Companion را پیش از هر مرحله دوباره بررسی می‌کند. قطع ارتباط، مدل ناموجود یا تغییر account نباید به native mutation منتهی شود.

هر lifecycle تنها ابزار مورد انتظار را می‌پذیرد: classify، `plan_universal_project`، `compose_design_program` برای یک screen یا `repair_design_program` برای screen و findingهای ذخیره‌شده. ورودی پاسخ با parser فعلی و Zod schemaهای strict بررسی می‌شود. JSON یا کد دلخواه اجرا نمی‌شود. planner count/device/locale را به خواستهٔ کاربر bind می‌کند؛ composer از یک schema مشترک `DesignProgramV1` عبور می‌کند.

## مرز ورودی و asset

- حداکثر payload مدل ۵۶ KiB است؛ prompt/context در draft موجود ذخیره می‌شود، اما diagnostic امن متن brief را شامل نمی‌شود.
- برنامه asset خارجی یا remote URL را نمی‌پذیرد. local spike فقط placeholder بومی برچسب‌دار را رندر می‌کند؛ asset دیگری به provenance و allowlist معتبر نیاز دارد و این adapter فعلاً آن را رد می‌کند.
- متن گره‌ها به node typeهای بومی محدود است؛ هیچ JS، URL قابل اجرا، Figma plugin script یا network allowlist جدیدی از خروجی مدل پذیرفته نیست.
- task به سند/صفحهٔ ثبت‌شده bind است؛ پیش از render، ثبت مالکیت و readback scope جاری دوباره بررسی می‌شوند.
- native output حداکثر ۲۰۰ node/task می‌پذیرد؛ حداکثر یک repair معنایی و correctionهای schema محدود است. تمام صفحه‌ها باید readback شوند تا task موفق اعلام شود.

## حریم خصوصی و شواهد

Planner دسترسی read-only به محتوای موجود Figma ندارد؛ این واقعیت صریحاً در context مدل بیان می‌شود. telemetry شامل route enum، fingerprint، وضعیت screen و شمارنده/زمان‌های محدود است. زمان مدل/renderer و mock علامت مجزا دارند؛ mock هرگز live timing محسوب نمی‌شود. فراخوانی مدل واقعی در این اجرا: **۰**؛ تغییر بومی Figma: **۰**.
