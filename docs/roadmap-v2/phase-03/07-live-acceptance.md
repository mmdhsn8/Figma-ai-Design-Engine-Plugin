# پذیرش زنده — نیازمند scope مجاز

**LIVE PENDING.** در این پیاده‌سازی مدل یا account واقعی فراخوانی نشد و هیچ Figma document/pageای باز یا تغییر داده نشد. برای Gate C، کاربر باید فایل و صفحهٔ disposable خالی و مجاز، مدل account-visible انتخاب‌شده و اجازهٔ ساخت را مشخص کند. فایل مشتری/محافظت‌شده پذیرفته نیست.

## محیط و قبل/بعد

قبل از شروع، در UI پلاگین hash/manifest build و model slug/account را کنترل کنید؛ انتخاب engine باید در Settings → Design Engine روی Universal باشد. انتخاب و page ID، node count، screenshot و وضعیت task را ثبت کنید. مسیر Universal برای taskهای تازه به‌طور پیش‌فرض فعال است؛ taskهای edit و inspect از ابزارهای scoped موجود استفاده می‌کنند و taskهای resume شده route checkpoint خود را حفظ می‌کنند.

دو prompt نمونه:

1. فارسی: «برای یادگیری دانش‌آموزان سه صفحهٔ موبایل بساز: خانهٔ یادگیری، جزئیات درس، پیشرفت و آزمون. فارسی و راست‌چین باشد؛ از اطلاعات نمونه استفاده کن.»
2. English: “Design four desktop screens for a marine specimen archive: accession, provenance, conservation, and loan readiness. Keep specimen identifiers consistent and use illustrative records.”

فقط پس از مجوز دقیق، هر prompt را از input عادی Chat وارد کنید؛ JSON یا tool نام نبرید. حداقل prompt فارسی سه screen باید plan، native frameها و text قابل‌ویرایش بسازد و readback همه را تأیید کند.

## چک‌لیست بررسی انسانی

- تعداد، نام، ترتیب و هدف screenها با خواستهٔ کاربر یکی است و flow به‌هم‌پیوسته است.
- فارسی RTL / انگلیسی LTR، ترتیب متن، فونت و wrapping روی خود Figma canvas صحیح است.
- rootها viewport درست، vertical scroll/clipping لازم و محتوای قابل پیمایش دارند؛ بیرون‌زدگی افقی ندارند.
- محتوای هر screen با دامنه و مقصدش جور است؛ hierarchy، density، تیپوگرافی، فاصله‌گذاری و تنوع layout بررسی می‌شود.
- Text و vectorها native و editable هستند؛ placeholderها با asset واقعی اشتباه نمی‌شوند. Contrast، targetهای تعاملی و selection بررسی می‌شوند.
- Chat را reload/resume کنید: root تکراری نباشد. سپس یک screen grounded را تغییر دهید؛ سایر screenها و selection/page نامرتبط ثابت بمانند.

مدت مدل، زمان اولین native progress، زمان آخرین screen، request count، اندازهٔ سند، یافته‌های QA، screenshot و build hash را با برچسب `LIVE / Figma Desktop` ثبت کنید. تا آن زمان ادعای کیفیت بصری یا latency زنده نکنید.
