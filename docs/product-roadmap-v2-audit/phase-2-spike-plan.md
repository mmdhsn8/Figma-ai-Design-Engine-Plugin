# طرح محدود Phase 2 — Universal Design Program spike

**این سند طرح است؛ اجرای spike، build migration یا Figma write را شروع نمی‌کند. Phase 2 به مجوز جداگانه نیاز دارد.**

## پرسش

آیا یک versioned Design Program واحد می‌تواند سه محصول متفاوت را از یک brief بسازد، به native Figma بسط یابد، قابل‌ویرایش/قابل‌پیمایش بماند و با safety/latency قابل‌اندازه‌گیری به مسیر فعلی متصل شود؟

## Fixture domains

| Domain | Example screen(s) | علت انتخاب |
|---|---|---|
| Education | lesson dashboard، lesson detail، progress | hierarchy محتوا، یادگیری و پیشرفت؛ بدون cart/catalog |
| Booking | appointment search/details، confirmation | search/filter، زمان/ظرفیت، فرم و summary |
| SaaS analytics | workspace overview، report detail/settings | data grid/chart/stat، navigation و dense desktop layout |

این سه از commerce متفاوت‌اند و هم mobile (390×844) و هم desktop (1440×900) را در صورت ظرفیت پوشش می‌دهند. Fixtureها deterministic و دارای copy/brand/asset policy ثابت باشند؛ briefهای benchmark نباید نام class یا known template را prompt کنند.

## قراردادهایی که باید مقایسه شوند

1. **A — Declarative IR:** screen tree و semantic roles، layout/constraints، design tokens، component refs، asset provenance، responsive/RTL metadata، stable IDs.
2. **B — Bounded programmatic operations:** plan و operationهای typed روی target/page مجاز، schema/tool allowlist، resource budget، no arbitrary JS/eval، idempotency/reconciliation.
3. **Hybrid candidate:** A برای composition/creation، B فقط برای scoped document context، existing-node edit و bounded host operations.

همهٔ گزینه‌ها باید به renderer/executor موجود adapter شوند و از validator/geometry/QA contract واحد عبور کنند. Spike هر گزینه را در branch یا harness جدا نگه دارد؛ هیچ migration اصلی پیش از نتایج و rollback plan.

## پروتکل کوچک

1. در mock harness، برای هر domain یک brief مشترک تعریف و یک screen بسازید؛ بعد سه-screen pack بسازید تا continuity و variation بررسی شود.
2. برای هر گزینه ثبت کنید: schema/operation size، model rounds، repair/rejection، زمان local compose/validate، native operation count، geometry/QA findings، deterministic replay و task-owned unique roots.
3. ارزیاب‌ها source/contract را برای هر variant ثابت نگه دارند؛ human rubric را پیش از rendering تعیین کنند و screenshots/results را anonymize کنند.
4. A/B/hybrid را با domain switch/hardcode audit بررسی کنید؛ commerce fixture را negative control بگذارید که pattern فروشگاهی وارد سه domain دیگر نشود.
5. هیچ current user file را هدف نگیرید. برای Desktop validation بعدی باید پس از مجوز جداگانه یک فایل disposable، manifest/build hash، account-visible model/entitlement و acceptance observer تأیید شوند.

## موفقیت و خروجی

- همان contract و adapter در هر سه domain، بدون domain-specific composer در core.
- سه fixture در schema، hierarchy و page purpose با copy و asset provenance معتبر parse شوند.
- هر screen native/editable باشد؛ completion بر پایهٔ readback/coverage باشد، نه count.
- هیچ duplicate root یا mutation بیرون از task scope؛ replay deterministically همان نتیجه را بدهد.
- آزادی ترکیب‌بندی و human rubric با نمونهٔ commerce رقابت کند؛ speed فقط از trace واقعی report شود.
- security review: input untrusted، refs validated، budgets bounded، no arbitrary code، no cross-file access، cancellation و failure semantics.

**خروجی:** `design-program-v1.md` proposal، adapter prototype، three-domain comparison، call/timing table، limitations، test evidence (MOCK/LOCAL)، migration/rollback recommendation، و فهرست live evidence مفقود. Desktop write فقط در gate بعدی و با مجوز جداگانه.

## Stop conditions

اگر یک domain contract را مجبور به hardcode جدید کند، geometry/QA خروجی را بی‌پایان reject کند، operationها arbitrary/over-budget شوند، replay duplicate بسازد یا یکی از قابلیت‌های protected آسیب ببیند، spike همان‌جا متوقف و یافته ثبت شود. Mock نتیجه به LIVE ارتقا داده نشود.
