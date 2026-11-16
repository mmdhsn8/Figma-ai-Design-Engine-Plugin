# قرارداد فهم پروژه و screen planning

## نسخه و دامنه

مدل از طریق ابزار strict planning یک draft ساختاریافته برمی‌گرداند؛ validator محلی آن را به `ProjectPlanV1` با `version: 1`, `plannerVersion: universal-planner-v1` و نسخهٔ جاری `DesignProgramV1` تبدیل می‌کند. schema draft خودش فیلد version جدا ندارد؛ نسخه روی plan نرمال‌شده ثبت می‌شود. حوزه‌ها رشته/داده‌اند (`domainTags`, `keyEntities`) و enum صنعت یا composer مخصوص حوزه ندارند.

طرح عمومی شامل هدف محصول، narrative، audience، goalها، capabilityها، موجودیت‌ها و provenance آن‌ها، locale/direction، platform، density، style direction، قیود طراحی، accessibility، فرصت component، سیاست نمونه‌داده، facts/assumptions/non-goals و sitemap پیوسته است. هر screen شامل ID پایدار `screen-01`…`screen-10`، ترتیب، نام/role/purpose، task، entry/exit، ۳–۶ region، روابط داده، action/state، target/dependency، scroll و viewport است.

## اندازه‌ها و پذیرش

- ۱–۱۰ صفحه؛ اندازهٔ پشتیبانی‌شده: mobile `390×844` یا desktop `1440×900`.
- تعداد/دستگاه/locale صریح کاربر از intent parser استخراج و با خروجی planner تطبیق داده می‌شود؛ اختلاف به اصلاح محدود مدل یا خطای typed منتهی می‌شود، نه truncation خاموش.
- `ProjectPlanV1Schema` ترتیب و ID پیوسته، نام‌های متمایز، روابط موجود و DAG بدون چرخه را اعمال می‌کند. Fingerprint canonical برابر `ppv1-…` است.
- صفحه‌ها جداگانه compose می‌شوند تا failure روی یک screen checkpointهای قبلی را پاک نکند. وابستگی بین screenها در `ProjectPlanV1` می‌ماند؛ چون `DesignProgramV1` هر بار تک‌صفحه‌ای است، `dependsOn` بین‌صفحه‌ای هنگام compile محلی خالی می‌شود.
- در هر برنامه حداکثر ۳۰۰ node و depth برابر سقف schema است؛ مسیر Chat حداکثر ۲۰۰ node بومیِ پذیرفته‌شده در کل task را قبول می‌کند.

## Provenance و فرض‌ها

`source` صفحه requested یا inferred است؛ `knownFacts`, `assumptions`, `nonGoals`, `contentSamplePolicy`, و provenance موجودیت‌ها جدا هستند. دادهٔ خصوصی یا مشتری از فایل خوانده نمی‌شود. نمونهٔ ساخته‌شده باید طبق plan آشکارا illustrative باشد. Locale فارسی direction راست‌به‌چپ و سایر localeهای این پیاده‌سازی چپ‌به‌راست را می‌گیرد؛ target responsive همزمان پشتیبانی نمی‌شود.

Brand Kit و حداکثر سه Skill با revision/token hash به task pin و در context planner و composer فرستاده می‌شوند. tokenهای برند روی DesignProgramV1 اعمال می‌شوند؛ انتخاب ذخیره‌شدهٔ کاربر تغییر نمی‌کند.

## مثال‌های تست

یک schema/adapter یکسان روی education، appointment booking، SaaS analytics، civic services، building maintenance و brief تازهٔ marine specimen custody اجرا شد. این‌ها پاسخ mock هستند و کیفیت مدل زنده را اثبات نمی‌کنند؛ [ماتریس شواهد](04-generalization-proofs.md) را ببینید.
