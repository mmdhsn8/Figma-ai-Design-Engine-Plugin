# تست، build و حسابداری عملکرد

## نتیجهٔ نهایی محلی

| فرمان | نتیجه |
|---|---|
| `npm test -- --maxWorkers=1` | ۴۱ فایل، ۶۹۹ تست پاس؛ ۰ شکست، ۰ skip |
| `npm run typecheck` | موفق |
| `npm run lint` | موفق، بدون warning |
| `npx tsc -p tsconfig.companion.json --noEmit` | موفق |
| `npx tsc -p tsconfig.companion.json` | موفق؛ artifactهای Companion کامپایل شدند |
| `npm run build` | موفق؛ UI و Plugin build شدند |
| `npm run verify:phase5` | موفق؛ manifest ثبت‌شده با checkout یکسان و entrypointهای UI/Plugin/Companion جاری تأیید شدند |

نقطهٔ مبنا HEAD: `64692e76a5b0697a3c2687b3612744dd483a582f`; branch `main`; تغییرات source/tests/docs همچنان uncommitted است. Manifest ID `1574493506249715820` و hash برابر فایل مبناست.

| Artifact | Hash نهایی SHA-256 | مبنای Phase 2 در صورت ثبت |
|---|---|---|
| `manifest.json` | `01D4429B1D421FDD9F0A24EFCA793EF9FD912E2AD559D1505EC4A5FCB1A2934A` | همان |
| `dist/plugin.js` | `CA624E94000B073DAF8BA5B9A65BD93C3E1D52336408DDADE23526F8F2755F99` | `BE34DF736CC5F252E74E6C86C6F2176505AD92710A432F12971D0CD01A27A56A` |
| `dist/ui.html` | `91D28F3210D6C5C938CF5900FA98E49FD4C0B3F7B5751E2118FB02782DB30CC7` | `493816780A84EFBBA8EC1213FF70C938C8502B9B50F8A0B73D128F6D2366348A` |
| `dist-companion/companion/server.js` | `99C1B5F0B14113FECA1E38E2A81FBEC5E766A2F344A21A12B8B16E4A2D8A98EB` | Phase 2 hash not recorded |
| `dist-companion/companion/main.js` | `E6B78B796FA2FC2BF247B9AEA983C03080105E85FF20D0CC9CADA2C8FED018D7` | همان |

## درخواست و زمان

Mock integration هر screen را با یک compose درخواست کرد؛ یک تست هدفمند یک semantic repair هم اعمال کرد. پنج مسیر اصلی ۱۶ screen و یک brief نادیدهٔ دریایی ۴ screen را readback کردند. این اعداد fixture/mock هستند، نه اندازه‌گیری provider یا Figma زنده. counters و زمان‌ها از هم جدا و evidence آن‌ها `mock` است؛ benchmark قابل‌مقایسه، model slug واقعی، first-native time واقعی، p50/p95 و SLA **NOT MEASURED** هستند. فراخوانی مدل/account واقعی: صفر؛ Figma write: صفر.

Verifier گفت artifactهای فعلی از checkout حاضر هستند و Figma Desktop همین manifest ثبت‌شده را از همین مسیر بارگذاری می‌کند. انتخاب Universal پیش‌فرض، preference migration/storage، حفظ routeهای checkpoint، و استمرار markup چت با regression tests تأیید شدند. هیچ commit/push یا Figma document mutation انجام نشد. Artifactهای build خروجی محلی هستند؛ manifest و package دست‌نخورده ماندند.
