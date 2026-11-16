# شکاف‌های باقی‌مانده و handoff فاز ۴

## موارد باز با شواهد

1. **کیفیت بصری واقعی:** mock ثابت نمی‌کند مدل زنده hierarchy، density، typographic rhythm یا تنوع چیدمان حرفه‌ای تولید می‌کند. نیازمند screenshot و human review در Gate C؛ composition عمومی و visual polish هدف Phase 4 است.
2. **پوشش native محدود:** adapter فعلی frame/text/basic vector و placeholder را ثابت کرد؛ asset واقعی، component library binding، chart/calendar پیچیده و responsive multi-viewport خارج از این قراردادند.
3. **مقیاس:** ۱–۱۰ screen در قرارداد عمومی است ولی route فعلی برای سقف ۲۰۰ native node/task fail می‌کند؛ ده screen، سرعت و SLA تضمین نشده‌اند. هر screen یک model composition call دارد و repair اضافی فقط در خطا.
4. **Live stability:** هیچ provider rate limit، pause وسط stream، Desktop crash، page switch یا خطای storage واقعی inject نشده. Mock replay و ownership coverage وجود دارد اما Gate C لازم است.
5. **Follow-up edit:** route پیش‌فرض Universal، create را به planner/composer همگانی می‌دهد و edit همچنان از مسیر bounded scoped toolchain موجود استفاده می‌کند. تست mock برای classification و کشف هدف edit اضافه شده؛ Live test باید همان ChatTask/refs را با یک تغییر محدود ثابت کند؛ این گزارش آن رفتار را Desktop نساخته است.

## Handoff

Phase 4 باید با screenshot/evaluation corpus و human review روی screen variety, semantic fit, hierarchy, density, type, spacing, RTL wrapping, scroll و safe sample data شروع شود؛ یافته‌ها را به composition model/adapter عمومی ببرد، نه domain enumهای جدید. قبل از ادعای کیفیت زنده، Gate C و failure/recoveryهای Desktop را اجرا کنید. حفظ `DesignProgramV1`, انتخاب پایدار موتور برای taskهای جدید، route ذخیره‌شدهٔ checkpointها و renderer موجود لازمه است.
