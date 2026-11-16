# Phase 0 — قرارداد عدم رگرسیون

این قرارداد برای spikeها و تغییرات آتی است. این ممیزی فقط اسناد audit را می‌افزاید؛ implementation و data کاربر را تغییر نمی‌دهد.

## Protected Areas

1. **Chat visuals و flow:** `.chat-*` در `src/ui/styles.css`، composer/messages، navigation، account/auth، مدل‌ها و workspace views.
2. **History/checkpoints/storage:** conversation history، chat task، generation drafts، checkpoint، task refs/ledger، Companion persistence.
3. **Brand Kit و Skills:** manager UI، revisions، token/skill pinning و selection semantics.
4. **User Figma documents:** صفحات، nodeها، selection، variables/styles، overrides و file metadata؛ هیچ test/live write مگر disposable file مشخص و مجوز جداگانه.
5. **Source/manifest/build registration:** plugin ID، root manifest path، registration settings، bundleهای Figma/Companion و feature flags.
6. **Access/cost/privacy:** account scope، OAuth/credential stores، model availability، production network allowlist، asset provenance و عدم افشای canvas data.

## Invariants برای هر تغییر بعدی

- فقط Chat intent به create اجازه می‌دهد؛ edit/inspect/continue به create تبدیل نشوند.
- هر task، root و operation شناسهٔ پایدار و مالکیت قابل‌بررسی داشته باشد؛ replay، pause/resume و partial commit نباید duplicate بسازد.
- edit فقط در scope تأییدشده انجام شود و readback نشان دهد frameها و layerهای خارج از scope بدون تغییر مانده‌اند.
- renderer و preflight از یک geometry/layout contract استفاده کنند؛ QA ناقص یا over-budget به موفقیت تبدیل نشود.
- UI را برای حل bottleneck فنی تغییر ندهید؛ تنظیمات و ویژگی‌های موجود قابل دسترسی بمانند.
- fixture commerce مجاز است، اما composer عمومی نباید آن را به‌عنوان fallback برای education، booking، finance یا پروژهٔ ناشناخته اعمال کند.
- mock، local، provider و Desktop evidence با برچسب روشن بمانند؛ هیچ latency یا visual claim از mock ساخته نشود.
- قبل از mutation: دامنه، target، layout plan، budget، asset provenance و rollback/reconciliation روشن باشند.

## Evidence لازم برای تأیید عدم رگرسیون

| سطح | شواهد لازم |
|---|---|
| Source change | protected-area diff، schema compatibility، existing contract regression review |
| Mock/local | خروجی هر سه دامنه با identity ثابت، geometry findings و replay check؛ به‌تنهایی live pass نیست |
| Figma Desktop | manifest/hash واقعی، فایل disposable، screenshot و readback، بدون collateral change |
| Account/provider | مدل و scope قابل‌مشاهده، هزینه/entitlement بررسی‌شده، trace بدون token/raw canvas data |
| Release | regressionهای قبلی، rollback، install/reload، resume/edit acceptance و وضعیت دقیق NOT MEASURED برای gaps |

این سند هیچ feature flag یا migration را روشن نمی‌کند و مجوز اجرای Phase 2 نیست.
