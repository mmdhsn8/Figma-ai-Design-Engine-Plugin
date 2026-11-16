# فاز ۳ — تحویل و وضعیت

**وضعیت: CODE COMPLETE / LIVE PENDING.** Gate A و B با مسیر واقعی هماهنگ‌کنندهٔ Chat، provider شبیه‌سازی‌شده، adapter و renderer بومی mock گذشتند. Gate C اجرا نشده است: هیچ فراخوانی مدل واقعی و هیچ نوشتنی در Figma انجام نشد.

## هویت و دامنه

- Checkout: شاخهٔ `main`، مبنای source برابر `64692e76a5b0697a3c2687b3612744dd483a582f`؛ تغییرات این تحویل commit نشده‌اند.
- Manifest: `manifest.json`، شناسهٔ `1574493506249715820`؛ ورودی‌های `dist/plugin.js` و `dist/ui.html`، دسترسی `dynamic-page`.
- تمام source تغییرکرده مربوط به Phase 3 است؛ تغییر از پیش موجود یا تغییر manifest/CSS/markup در این checkout مشاهده نشد.
- مسیر جدید از Chat قابل دسترسی است اما پشت opt-in محلی و خاموش به‌طور پیش‌فرض می‌ماند. برای فعال‌سازی آزمایشی در کنسول همان UI پلاگین: `localStorage.setItem("fad.universal-design-chat.v1", "enabled")`. بازنشانی: `localStorage.removeItem("fad.universal-design-chat.v1")`. کارهای ذخیره‌شده بین مسیرها جابه‌جا نمی‌شوند.

## نقشهٔ اجرایی منبع

1. ورودی و انتخاب مسیر Chat: `src/ui/App.tsx` → `selectChatExecutionRoute` در `src/ui/universal-design-route.ts`.
2. مدل/account انتخاب‌شده و مجوز: task موجود در `src/ui/App.tsx` و Companion احراز‌شده در `src/companion/server.ts`؛ قبل از هر درخواست/نوشتن، scope دوباره بررسی می‌شود.
3. پاسخ مدل: `parseResponsesFunctionCalls` و schemaهای strict lifecycle در `src/shared/chat-tools.ts`.
4. پذیرش برنامه: `src/ui/universal-design-task.ts` → `ProjectPlanV1` → `parseDesignProgram`/adapter مشترک.
5. رندر و مالکیت: پیام typed در `src/shared/messages.ts` → `src/plugin/main.ts` → `src/plugin/design-program-spike.ts` → renderer و ثبت scoped در executor موجود.
6. checkpoint و موفقیت: همان `ChatTask` و storage موجود؛ native readback فقط پس از resolve مالکیت task و اندازه‌گیری subtree در `verifyNativeReadback` صفحه را تأیید می‌کند.

## نقاط عطف

| نقطه | وضعیت | شواهد |
|---|---|---|
| مسیر Chat و fallback legacy، بدون تغییر ظاهر | IMPLEMENTED / TESTED MOCK | route و intent regressions |
| plan بازدامنه، screen ID/fingerprint پایدار، schema strict | IMPLEMENTED / TESTED MOCK | ۵ حوزه + brief تازه |
| DesignProgramV1 → adapter و renderer موجود → مالکیت/readback | IMPLEMENTED / TESTED MOCK | Chat integration و mock native tree |
| checkpoint، repair محدود و replay بدون root تکراری | TESTED MOCK | fault/replay و semantic-repair tests |
| build، typecheck، lint، verifier | TESTED MOCK | همهٔ فرمان‌های گزارش‌شده موفق |
| حساب/مدل واقعی و Figma Desktop | PENDING | هیچ فراخوانی مدل یا mutation مجاز/انجام نشده |

## پیشنهاد

**GO به Phase 4 برای بهبود composition بصری و بررسی کاربری؛ NO-GO برای عرضهٔ عمومی یا ادعای کیفیت حرفه‌ای.** مسیر عمومی و ایمن به‌صورت کد قابل اجراست، اما فقط mock را دیده‌ایم. پیش از انتشار مسیر opt-in نیز Gate C باید در فایل disposable مجاز انجام شود.

جزئیات build و hashها در [گزارش شواهد](06-test-build-performance-evidence.md)، ماتریس دامنه در [اثبات generalization](04-generalization-proofs.md) و روش زنده در [پروتکل پذیرش](07-live-acceptance.md) است.
