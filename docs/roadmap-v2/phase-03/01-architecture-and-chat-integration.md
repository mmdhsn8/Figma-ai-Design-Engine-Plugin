# معماری و اتصال Chat

## مسیر اجرا

`Chat input → persisted engine preference → existing ChatTask → intent classification → authenticated Companion + selected model → Universal project plan for new designs / existing scoped tools for edits and inspection → task-owned native registration → task-native readback → ChatTask completion`.

همهٔ taskهای تازه با انتخاب Universal (مقدار پیش‌فرض) در همان submit موجود `src/ui/App.tsx` ساخته می‌شوند؛ این شامل promptهای edit و inspect هم هست. بعد از classification، create از Universal planner/composer استفاده می‌کند و edit/inspect/explain به ابزارهای scoped و جریان اجرایی موجود می‌روند. انتخاب Legacy مسیر قدیمی را برای taskهای تازه نگه می‌دارد. انتخاب در `figma.clientStorage` پایدار می‌ماند؛ task فعال یا resume شده فقط از route ذخیره‌شده در `ChatTask` پیروی می‌کند و انتخاب فعلی Settings آن را تغییر نمی‌دهد.

Classification، planning، composition و semantic repair ابزارهای typed در lifecycleهای `UNIVERSAL_CLASSIFY`, `UNIVERSAL_PLANNING`, `UNIVERSAL_COMPOSING`, `UNIVERSAL_REPAIR` هستند. درخواست مدل از همان Companion/account authorization و مدل pinned در ChatTask استفاده می‌کند. برنامهٔ native از route جدید مستقل ساخته نمی‌شود؛ `renderDesignProgramLocal` به adapter Phase 2 و `renderMultiScreenDesign` موجود تحویل می‌دهد.

## تنظیم و سازگاری

Settings → Design Engine دو گزینهٔ `Universal Engine (New)` و `Legacy Engine (Old)` دارد. انتخاب صریح در `fad.design-engine-preference.v1` در Figma `clientStorage` ذخیره می‌شود. نصب خالی و کاربر موجود بدون انتخاب صریح Legacy به Universal مهاجرت می‌کند. flag آزمایشی `fad.universal-design-chat.v1` فقط برای مهاجرت یک‌باره خوانده می‌شود؛ مقادیر آن هیچ‌وقت به‌تنهایی انتخاب Legacy محسوب نمی‌شوند و بعد از ذخیرهٔ انتخاب جدید پاک می‌شود. Manifest، شناسه و Chat UI تغییر نکرده‌اند؛ History، Brand Kit، Skills، Login و Native Renderer از bridgeها و مسیرهای موجود استفاده می‌کنند.

## نقاط scope

- هیچ محتوای فایل Figma برای planning خوانده نمی‌شود؛ planner فقط brief و Brand Kit/Skills محلیِ انتخاب‌شده و pinned را می‌بیند.
- bridgeهای جدید فقط request/response typed برای render هستند؛ native inspection از bridge task-native موجود استفاده می‌کند.
- ثبت ownership از executor موجود است و operation IDهای adoption و fingerprint برنامه به task نگه داشته می‌شود.
- Route diagnostic فقط enum مسیر، fingerprint و آمار محدود را ثبت می‌کند؛ متن brief را وارد telemetry تشخیصی نمی‌کند.

## منبع و verification

ورود: `src/ui/App.tsx`, `src/ui/universal-design-route.ts`, `src/ui/chat-task.ts`. Provider/tools: `src/companion/server.ts`, `src/shared/chat-tools.ts`. Plugin: `src/plugin/main.ts`, `src/plugin/design-program-spike.ts`, `src/plugin/figma-tool-executor.ts`. پروتکل native: `src/shared/messages.ts` و `src/ui/design-program-bridge.ts`. بررسی build ثبت‌شدهٔ manifest و artifactها با `npm run verify:phase5` موفق شد؛ Figma Desktop acceptance انجام نشده است.
