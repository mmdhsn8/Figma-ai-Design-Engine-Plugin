# DesignProgramV1 — قرارداد و مرزها

تعریف اجرایی در `src/shared/design-program.ts` است. قرارداد داده‌ای برای ساخت صفحه است؛ renderer دوم، JavaScript اجرایی یا مسیر ذخیره‌سازی جدید نیست.

## شکل قرارداد

ریشه شامل `programVersion`, `id`, `revision`, `goal`, `audience`, `locale`, `visualIntent`, `contentProvenance`, `requiredCapabilities`, `tokens`, `references` و `screens` است. صفحه‌ها دارای ID/title/purpose/order، viewport، scroll intent، dependencies و یک root node هستند. `DesignProgramNodeSchema` بازگشتی و strict است و نوع‌های `container`, `text`, `rectangle`, `ellipse`, `vector`, `image` را می‌پذیرد. هر node شناسه، نام، semantic role، تعامل، عرض/ارتفاع و sizing دارد.

Containerها row/column، gap، padding و alignment می‌گیرند. اندازه‌ها `fixed`, `hug`, `fill` با مقدار محدود و min/max هستند. Reference viewportهای mobile برابر 390×844 و desktop برابر 1440×900 است؛ custom viewport هم کران دارد. زبان/direction صریح است. توکن رنگ و فونت به schema موجود Design System و سپس renderer داده می‌شود.

حدود اجرایی: ۱۰ صفحه، ۳۰۰ node در برنامه، عمق ۸، حداکثر ۱۰۰ فرزند در هر container، متن ۵۰۰۰ نویسه، مسیر vector تا ۸۱۹۲ نویسه و dimension تا ۲۰٬۰۰۰. رنگ فقط hex یا token تعریف‌شده است. schema با `.strict()` کلید ناشناخته را رد می‌کند.

## اعتبارسنجی و fingerprint

`parseDesignProgram` یکتایی screen/node ID و order، dependency مفقود/تکراری/چرخه‌ای، depth/node limit، touch target تعامل‌دار زیر 44×44، token رنگ مفقود، scroll افقی، capability لازم برای scroll عمودی موبایل و provenance دارایی را بررسی می‌کند. خطاها finding ساخت‌یافته با code/path/message هستند. متن یا node ناشناخته بی‌صدا حذف نمی‌شود.

هر reference از component/variable/style—even اگر verified و authorized باشد—فعلاً صریحاً رد می‌شود چون binding در spike وجود ندارد. دارایی‌های غیر-placeholder نیز در این adapter پشتیبانی نمی‌شوند؛ assetRef تأییدشده مجوز عمومی برای خواندن دارایی ایجاد نمی‌کند. Placeholder به frame و متن disclosure قابل ویرایش تبدیل می‌شود. URL دلخواه در schema وجود ندارد و کلید اضافه باعث رد می‌شود.

Canonical serialization کلیدهای object را مرتب می‌کند؛ `fingerprintDesignProgram` خروجی `dpv1-` به‌همراه ۶۴ بیت FNV-1a روی UTF-16 code unit می‌دهد. این fingerprint برای determinism/replay محلی است، نه امضای امنیتی یا hash ضدبرخورد رمزنگاری‌شده.

## نسخه‌گذاری

V1 فقط `programVersion: 1` را می‌پذیرد. تغییر ناسازگار باید schema/adapter نسخهٔ جدید و converter صریح داشته باشد؛ reader قدیمی دادهٔ آینده را با خطای schema رد می‌کند. هیچ ذخیرهٔ draft یا checkpoint قدیمی خوانده، تبدیل یا بازنویسی نشده است. این spike هیچ migration adapter دائمی برای دادهٔ ذخیره‌شده اضافه نمی‌کند.

## آگاهانه خارج از V1

Component/style/variable binding، assets واقعی، effects و border کامل، overlay، grid/responsive breakpoints، interaction اجرایی، inline positioned constraints، horizontal scroll و arbitrary user code. لیست layoutهای تکراری/table/chart با container و shape/text قابل توصیف است، اما grid معنایی مستقل یا chart واقعی ایجاد نمی‌شود.
