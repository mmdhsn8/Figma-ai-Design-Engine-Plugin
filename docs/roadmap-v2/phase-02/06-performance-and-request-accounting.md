# کارایی و شمارش درخواست‌ها — فقط روی mock محلی

مقادیر زیر خروجی یک اجرای مشخص `tests/design-program.test.ts` در 2026-11-16 هستند؛ زمان‌ها millisecond با سه رقم اعشار. هر مورد یک نمونه است، نه median یا SLA. سیستم میزبان/CPU در این فایل ثبت نشده است.

## اندازه و nodeها

| Fixture | bytes خام / canonical Program | node / container region | A batch bytes | A/B native node count | B operations / batches / plan bytes |
|---|---:|---:|---:|---:|---:|
| Education | 4,159 / 4,511 | 13 / 3 | 5,161 | 15 / 15 | 18 / 2 / 11,622 |
| Booking | 5,089 / 5,494 | 16 / 3 | 6,494 | 18 / 18 | 21 / 3 / 14,208 |
| SaaS | 7,622 / 8,360 | 26 / 9 | 8,956 | 28 / 28 | 37 / 4 / 22,891 |
| Civic | 3,425 / 3,738 | 10 / 2 | 4,507 | 12 / 12 | 14 / 2 / 9,700 |

در هر چهار local fixture، provider request = 0؛ تمام B operations اجرا و commit شدند. A local token style count در هر fixture برابر ۱۰ paint و ۴ text style بود. QA structural coverage کامل بود و finding count صفر.

## زمان‌های مرحله‌ای (ms)

| Fixture | A parse | canonical | adapter compile | normalize | quality preflight | renderer | ownership registration | persistence | structural verify | B plan compile | B executor apply | B persistence |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Education | 0.768 | 0.230 | 1.472 | 0.485 | 0.074 | 3.243 | 1.939 | 0.071 | 5.283 | 1.225 | 20.937 | 0.572 |
| Booking | 0.618 | 0.166 | 1.375 | 0.659 | 0.120 | 6.544 | 2.301 | 0.091 | 3.029 | 1.236 | 23.737 | 0.481 |
| SaaS | 0.986 | 0.334 | 1.970 | 0.817 | 0.203 | 4.760 | 3.011 | 0.064 | 2.795 | 1.802 | 57.944 | 1.343 |
| Civic | 0.613 | 0.140 | 1.497 | 0.686 | 0.058 | 5.563 | 1.769 | 0.066 | 1.721 | 0.975 | 14.772 | 0.447 |

H در mock جداگانه، یک `set_properties` روی heading و مرحلهٔ edit+persist برابر **3.7227 ms** داشت؛ ۳ screen root قبل/بعد برقرار و دو screen دیگر برابر snapshot بودند.

## اندازه‌گیری‌نشده

Provider/model request و round عمداً صفر بود؛ بنابراین latency، هزینه و prompt context مدل **NOT MEASURED** هستند. Figma Desktop native time، font shaping/wrapping واقعی، screenshot/visual score، render parity با MCP، حافظهٔ host، نرخ خطا، retry توزیعی، p50/p95، ۳-screen یا ۱۰-screen package، first-use latency کاربر و throughput نیز **NOT MEASURED** هستند. از یک نمونه هیچ p50/p95 یا وعدهٔ عملکردی استنتاج نمی‌شود.
