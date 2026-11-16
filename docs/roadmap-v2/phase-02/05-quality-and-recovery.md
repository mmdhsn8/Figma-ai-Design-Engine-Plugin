# کیفیت بومی، دامنهٔ mutation و recovery

## آنچه در spike اندازه‌گیری شد

- Adapter quality preflight برای ۴ fixture اجرا شد؛ هیچ diagnostic contrast یا control-size ثبت نشد.
- Mock readback structural QA برای هر ۴ fixture: `complete=true`, `truncated=false`, finding count برابر صفر. تعداد nodeهای خوانده‌شده: ۱۵، ۱۸، ۲۸، ۱۲.
- Geometry traversal برای سه screen اصلی Education/Booking/SaaS در مختصات محلی parent اجرا شد و هیچ child از padding/bounds خارج نبود. Education و Booking content بلندتر از viewport داشتند؛ root با `clipsContent` و `overflowDirection=VERTICAL` readback شد. SaaS viewport desktop 1440×900 است.
- Schema هر interaction target زیر 44×44 را رد می‌کند؛ کیفیت local test نیز finding مربوط به small target نداشت. نمونه‌های fixture عنصر تعاملی زیر این حد ندارند.
- RTL Mobile و LTR Desktop به شکل جهت/alignment/order قراردادی بررسی شدند؛ شکل‌دهی واقعی فارسی، فونت میزبان، line wrapping در Desktop و screenshot هنوز اندازه‌گیری نشده.
- H فقط یک heading در محدودهٔ Education را تغییر داد؛ native snapshot دو صفحهٔ دیگر عیناً برابر ماند.
- Resume Education root تکراری نساخت. Candidate B پس از نخستین native write، همان batch با executor instance تازه و storage مشترک replay شد؛ پاسخ replayed و تعداد node ثابت ماند.
- adoption seam ورودی forged خارج از subtree را رد کرد، plugin data/ref و storage را بدون collateral write حفظ کرد.
- B cross-document scope attempt شکست خورد و هیچ node ایجاد نکرد.

## رگرسیون‌های موجود

کل suite موجود و جدید اجرا شد: **۳۹ فایل، ۶۶۵ تست پاس**؛ شامل تست‌های قبلی برای Chat create/edit routing فارسی، native contrast/clipping، repair/recovery 350/504 layout، 44px controls، cancellation/partial commit، ambiguous create و resume/checkpoint collision. منطق/حدهای آن تست‌ها تغییر نکرده‌اند. هفت تست هدفمند DesignProgram نیز پاس شدند.

این suite مانع خطای تازه در covered mock cases می‌شود، اما فرسودگی real Desktop، nested transform host behavior و هر edge case فهرست‌نشده را ثابت نمی‌کند.

## fault coverage که هنوز لازم است

Phase 2 test، restart/replay پس از اولین operation و forged ref/cross-document را مستقیماً به مسیرهای spike وصل کرده است. آزمون adoption persistence rejection نیز مستقیم اضافه شد: plugin-data/refها به حالت قبلی برگشتند و resume همان root را بدون duplicate ثبت کرد. تغییر page بین verification و commit و لغو H بین دو batch هنوز در این seam جدید به‌طور مستقل تزریق نشده‌اند؛ قبولی تست‌های قدیمی executor جایگزین این بررسی اختصاصی نیست.

هیچ QA ناقصی به success تبدیل نمی‌شود: H فقط پس از render موفق، rootهای یکتا و ثبت همهٔ refها success می‌دهد؛ inspect ساختاری جداگانه coverage کامل را بررسی می‌کند.
