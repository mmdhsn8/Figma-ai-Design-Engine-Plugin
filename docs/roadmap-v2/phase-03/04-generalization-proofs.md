# شواهد generalization بین‌حوزه‌ای

همهٔ ردیف‌های زیر: **provider mock → parser واقعی → ChatTask واقعی → ProjectPlanV1/DesignProgramV1 → adapter Phase 2 → renderer و executor mock → task-owned readback**. این شواهد source/local test هستند؛ هیچ مدل واقعی یا Figma Desktop درگیر نشده است.

| Brief | شمارش / زبان / هدف | برنامهٔ مورد انتظار |
|---|---|---|
| Education | ۳ mobile، فارسی RTL | خانهٔ یادگیری، جزئیات درس، پیشرفت/آزمون؛ course/instructor/lesson |
| Appointment booking | ۳ mobile، فارسی RTL | جست‌وجو، جزئیات ارائه‌دهنده، تأیید؛ بدون دادهٔ واقعی بیمار |
| SaaS analytics | ۳ desktop، English LTR | overview، report detail، team settings |
| Civic services | ۲ mobile، فارسی RTL | ثبت مسئلهٔ شهری و پیگیری پرونده؛ بدون اطلاعات واقعی شهروند |
| Building maintenance | ۵ mobile، English LTR | intake، work orders، technician، schedule، history؛ بدون composer/enum تازه |
| **Unseen evaluation، پس از پیاده‌سازی** | ۴ desktop، English LTR | marine specimen: accession، provenance، conservation، loan readiness |

برای همهٔ briefها، plan ordered با goal/roleهای متمایز است؛ همان DesignProgram schema و adapter استفاده شد، rootها unique و text قابل‌ویرایش دارند، ownership ثبت و subtree از executor خوانده شد. آزمون‌ها وجود محتوای خارج از commerce را بررسی می‌کنند؛ پنج حوزهٔ اصلی تعداد و device/locale را از درخواست می‌گیرند. Brief دریایی پس از ساخت مسیر انتخاب و بدون keyword branch یا template اختصاصی به همان harness داده شد.

**تفسیر درست:** پاسخ‌های provider در CI شبیه‌سازی شده‌اند؛ این اثبات می‌کند قرارداد مدل و handoff قابل اجراست، نه این‌که مدل واقعی همیشه همین plan یا کیفیت را می‌دهد. تعداد node یا schema pass شاخص زیبایی حرفه‌ای نیست. evidence بصری از فایل disposable هنوز نداریم.
