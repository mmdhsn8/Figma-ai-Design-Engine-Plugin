# پروتکل پذیرش در Figma Desktop — هنوز اجرا نشده

**LIVE BLOCKED.** هیچ فایل واقعی باز یا تغییر داده نشده و هیچ account/model انتخاب نشده است. پیش از اجرای این پروتکل باید کاربر به‌طور جداگانه scope مجاز را تعیین کند.

## فرم مجوز/محیط

- فایل آزمایشی disposable (URL/ID): `________________`
- صفحهٔ خالی و مجاز: `________________`
- مدل قابل مشاهده و انتخاب‌شده در plugin: `________________`
- مجاز به ساخت در همین فایل/صفحه: `بله / خیر`
- زمان و operator: `________________`
- build/manifest تأییدشده: `________________`

## Promptهای کم‌ریسک نماینده

1. **Education / فارسی:** «یک داشبورد موبایل 390×844 راست‌به‌چپ برای دانش‌آموز بساز؛ درصد پیشرفت یک دوره، فهرست درس‌ها، نام مدرس و دکمهٔ ادامهٔ یادگیری داشته باشد. اطلاعات نمونه باشند.»
2. **Booking / فارسی:** «یک صفحهٔ موبایل 390×844 راست‌به‌چپ برای انتخاب زمان مشاوره طراحی کن؛ تاریخ، چند زمان نمونه، خلاصهٔ انتخاب و دکمهٔ تأیید داشته باشد. هیچ ظرفیت واقعی را ادعا نکن.»
3. **SaaS / English:** “Create a 1440×900 LTR analytics workspace with a sidebar, KPI cards, a native chart placeholder, date filter and editable report table. Use synthetic values.”

فقط یکی برای حداقل acceptance اجرا شود؛ بقیه پس از بررسی مجوز/نتیجه و تصمیم کاربر. این promptها به‌تنهایی مجوز mutation نیستند.

## روش ثبت evidence

1. از صفحهٔ خالی screenshot قبل از شروع بگیرید و ID صفحه را ثبت کنید.
2. root Frame را با نام/ابعاد دقیق در Layers panel پیدا کنید؛ text را انتخاب و ویرایش‌پذیری آن را تأیید کنید.
3. viewport ثابت، vertical scroll/clipping، خارج‌زدگی افقی، touch targetهای تعاملی و contrast متن معمولی را بررسی کنید.
4. screenshot نهایی + layer outline، build/manifest hash، prompt/model، مدت parse/render/QA (با تفکیک انتظار مدل)، تعداد root/node، QA findings و هر repair/retry را ثبت کنید.
5. همان task را resume/replay کنید؛ root/node تکراری یا تغییر در صفحهٔ نامرتبط نباید باشد. سپس یک heading را در همان task edit کنید و تأیید کنید دیگر nodeها ثابت‌اند.
6. ثبت را با برچسب `LIVE / Figma Desktop`، تاریخ و فایل disposable نگه دارید؛ محتوای خصوصی/token را در گزارش کپی نکنید.

Desktop UI automation یا MCP parity در این turn فراهم/اجرا نشد. تا وقتی شواهد این protocol ثبت نشده، status همان **LOCAL SPIKE COMPLETE / LIVE BLOCKED** می‌ماند.
