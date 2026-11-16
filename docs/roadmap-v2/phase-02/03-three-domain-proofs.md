# اثبات دامنه‌ها و تعمیم به دامنهٔ نادیده

همهٔ نمونه‌ها دادهٔ synthetic، یک صفحه و یک schema/adapter هستند. هیچکدام ۳-page pack نیستند. adapter هیچ switch بر اساس ID پروژه، عنوان، کلمهٔ فارسی یا صنعت ندارد.

| Fixture / screen ID | زبان و viewport | ساختار/محتوا | شواهد mock |
|---|---|---|---|
| Education / `student-home` | Persian `fa-IR`, RTL, 390×844 | پیشرفت دوره، ناوبری درس، مدرس، اقدام ادامهٔ یادگیری | در مجموعهٔ سه screen رندر شد؛ root/frame و text قابل ویرایش؛ محتوای بلند با vertical overflow |
| Booking / `appointment` | Persian `fa-IR`, RTL, 390×844 | خلاصهٔ انتخاب، گزینه‌های تاریخ و ساعت، CTA؛ ظرفیت داده‌ها صرفاً synthetic است | در همان renderer؛ root مستقل و scroll عمودی |
| SaaS / `workspace-report` | English `en-US`, LTR, 1440×900 | sidebar، KPI grouping، placeholder نمودار بومی، filters/table rows | root افقی desktop؛ text/frame/rectangle قابل ویرایش |
| Civic / `resident-dashboard` | English `en-US`, LTR, 390×844 | checklist مدارک/status و گام بعدی خدمت شهری | دامنهٔ جدید بدون branch؛ همان adapter در metric run رندر، ساختاری inspect و با ۰ finding خوانده شد |

Semantic role sidecarها نیز متناسب با درخت‌اند: `lesson-navigation`; `date-options` و `time-options`; `navigation-region`, `kpi-group`, `data-table`; و `document-checklist`. placeholder image assertion بررسی می‌کند که خروجی frame+متن «Placeholder · …» باشد؛ asset واقعی دانلود یا خوانده نمی‌شود.

## ساختار native و ویرایش

تست، tree را از Mock Figma API می‌خواند، نه screenshot. H سه root اصلی Education/Booking/SaaS را در یک page mock ثبت می‌کند؛ rootها در `FRAME` هستند و فرزندان در Frame/Text/Rectangleهای قابل ویرایش. سپس executor فقط ref مربوط به «Welcome heading» را inspect و با operation `set_properties` عوض می‌کند. Snapshot ساختاری دو root دیگر قبل/بعد برابر می‌ماند. اجرای دوبارهٔ Education root اضافه نمی‌سازد.

در Candidate B همان fixtureها به ترتیب ۱۸، ۲۱، ۳۷ و ۱۴ operation typed تولید کردند. B واقعاً در mock executor اجرا شده است، اما عمق بصری/layer equivalence با A از screenshot مقایسه نشده.

### محدودیت تعمیم

چهار fixture نمونهٔ کوچک و دست‌سازند؛ property-based یا ارزیابی کیفیت محصول در دامنه‌های نامحدود انجام نشده. civic fixture در mock metric مسیر A و inspect ساختاری کامل دارد؛ H edit انجام‌شده فقط روی Education انجام شده است. هیچ ادعای ۱۰-screen، ۳-screen continuity یا production Chat generation در این مرحله وجود ندارد.
