# پیاده‌سازی adapter و محدودهٔ اتصال

## فایل‌ها و نقش‌ها

| فایل | نقش |
|---|---|
| `src/shared/design-program.ts` | Zod schema، limits، validator، canonical JSON و fingerprint |
| `src/shared/design-program-adapter.ts` | تبدیل عمومی به `MultiScreenSpec`، semantic sidecar، token resolution و quality preflight |
| `src/shared/design-program-operations.ts` | تبدیل همان ورودی‌ها به B: عملیات whitelistشده و batchهای حداکثر ۱۰تایی |
| `src/plugin/design-program-spike.ts` | seam محلی A/H: parse/compile، renderer، readback ریشه و subtree، stable refs و ثبت scope |
| `src/plugin/figma-tool-executor.ts` | متد additive و gated به نام `registerRenderedGeneration` برای adopt کردن subtree کامل renderer در ref ledger موجود |
| `tests/figma-mock.ts` | پشتیبانی mock از plugin data و styleهای محلی موردنیاز renderer |
| `tests/fixtures/design-programs.ts` | چهار brief داده‌ای مستقل |
| `tests/design-program.test.ts` | contract، adapter، A/B/H، recovery، mock readback و یک نمونه‌گیری اندازه‌گیری |

Adapter روی رشتهٔ `semanticRole`, جهت، viewport و semanticRefs نگه می‌دارد؛ هندسه/auto-layout/style/render از schema و renderer موجود reuse می‌شود. RTL، text alignment پیش‌فرض راست و ترتیب فرزندهای row را برعکس می‌کند. محتوای بلند، viewport ثابت دارد و scroll vertical روی root فعال می‌شود؛ scroll افقی رد است. Placeholder تصویر یک frame دارای متن اعلام placeholder است.

Candidate B فقط operationهای typed موجود را تولید می‌کند. Refها، task/document/page، order و idempotency صریح‌اند؛ هیچ کد قابل اجرا یا حذف node در plan وجود ندارد. Vector برای adapter A پشتیبانی می‌شود اما در Candidate B فعلاً `unsupported_tool_primitive` می‌گیرد؛ این اختلاف در comparison ثبت شده است.

## H و مالکیت

H ابتدا A را به renderer موجود می‌دهد. سپس seam جدید فقط ریشهٔ بالای page با batch/screen ID یکتا، وضعیت `complete` و فهرست کامل descendantهای readbackشده را می‌پذیرد. همهٔ refها، برخوردها و تعلق به همان page/root بررسی می‌شوند؛ سقف adopt برابر ۲۰۰ node در task است. Seam nodeها را به state/ref ledger executor فعلی اضافه می‌کند تا inspect و `set_properties` با قواعد scope موجود اجرا شوند. این کار checkpoint schema را تغییر نمی‌دهد، اما ledger موجود را با رکورد synthetic completed-create برای renderer output آشنا می‌کند؛ به همین دلیل seam باید فقط با adapter همان task استفاده شود.

اتصال فقط در `renderDesignProgramLocal` تستی/آزمایشی است. از App، Chat router یا structured-generation route فراخوانی نمی‌شود؛ feature flag پیش‌فرض یا fallback production اضافه نشده است. دسترسی method در bundle buildشده به‌تنهایی محصول را به این مسیر route نمی‌کند.

## بازتولید

```powershell
npx vitest run tests/design-program.test.ts --maxWorkers=1 --silent=false --reporter=verbose
npm test -- --maxWorkers=1
npm run typecheck
npm run lint
npx tsc -p tsconfig.companion.json --noEmit
npm run build
npm run verify:phase5
```

## سازگاری

هیچ UI، `src/ui/App.tsx`، `src/ui/chat-task.ts`، مسیر generation، import، manifest identity، permission/network allowlist یا format checkpoint تغییر نکرده است. bundle plugin در build جدید تغییر می‌کند چون executor به صورت additive توسعه یافته؛ `dist/ui.html` و manifest بدون تغییرند. پذیرش و migration در [تصمیم معماری](07-architecture-decision-and-rollback.md) باز است.
