# معماری و اتصال Chat

## مسیر اجرا

`Chat input → local intent/flag route → existing ChatTask → authenticated Companion + selected model → ProjectPlanDraftV1 → ProjectPlanV1 → one DesignProgramV1 per screen → existing declarative adapter/renderer → task-owned native registration → task-native readback → ChatTask completion`.

مسیر create از داخل submit موجود در `src/ui/App.tsx` انتخاب می‌شود؛ controller یا markup جدیدی ساخته نشده است. وقتی flag خاموش است، درخواست به مسیر قبلی می‌رود. وقتی روشن است فقط درخواست create روشن و بدون فرمان edit به `universal-design-v1` می‌رود. edit، inspect، resume و درخواست mixed create/edit به legacy می‌روند. بعد از checkpoint مسیر یا model task عوض نمی‌شود.

Classification، planning، composition و semantic repair ابزارهای typed در lifecycleهای `UNIVERSAL_CLASSIFY`, `UNIVERSAL_PLANNING`, `UNIVERSAL_COMPOSING`, `UNIVERSAL_REPAIR` هستند. درخواست مدل از همان Companion/account authorization و مدل pinned در ChatTask استفاده می‌کند. برنامهٔ native از route جدید مستقل ساخته نمی‌شود؛ `renderDesignProgramLocal` به adapter Phase 2 و `renderMultiScreenDesign` موجود تحویل می‌دهد.

## Rollout و rollback

کلید محلی `fad.universal-design-chat.v1` فقط وقتی دقیقاً `enabled` باشد فعال است؛ نبودن storage یا مقدار دیگر یعنی legacy. برای rollout محدود، آن را از DevTools کنسول UI پلاگین فعال کنید؛ برای بازگشت `localStorage.removeItem("fad.universal-design-chat.v1")` اجرا و task تازه‌ای شروع کنید. task در حال اجرا route ذخیره‌شدهٔ خودش را نگه می‌دارد. Manifest، شناسه، Chat appearance، CSS، legacy structured generation و JSON import تغییر نکرده‌اند.

## نقاط scope

- هیچ محتوای فایل Figma برای planning خوانده نمی‌شود؛ planner فقط brief و Brand Kit/Skills محلیِ انتخاب‌شده و pinned را می‌بیند.
- bridgeهای جدید فقط request/response typed برای render هستند؛ native inspection از bridge task-native موجود استفاده می‌کند.
- ثبت ownership از executor موجود است و operation IDهای adoption و fingerprint برنامه به task نگه داشته می‌شود.
- Route diagnostic فقط enum مسیر، fingerprint و آمار محدود را ثبت می‌کند؛ متن brief را وارد telemetry تشخیصی نمی‌کند.

## منبع و verification

ورود: `src/ui/App.tsx`, `src/ui/universal-design-route.ts`, `src/ui/chat-task.ts`. Provider/tools: `src/companion/server.ts`, `src/shared/chat-tools.ts`. Plugin: `src/plugin/main.ts`, `src/plugin/design-program-spike.ts`, `src/plugin/figma-tool-executor.ts`. پروتکل native: `src/shared/messages.ts` و `src/ui/design-program-bridge.ts`. بررسی build ثبت‌شدهٔ manifest و artifactها با `npm run verify:phase5` موفق شد؛ Figma Desktop acceptance انجام نشده است.
