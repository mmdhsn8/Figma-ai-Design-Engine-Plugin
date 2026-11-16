# Phase 1 — مقایسه قابلیت‌های Figma MCP و پلاگین

این یک capability comparison بر پایهٔ مستند رسمی و source است؛ **مقایسهٔ زنده، زمان‌گیری یا Figma MCP execution انجام نشده است.**

| محور | Figma MCP رسمی | Figma AI Design Engine در source | شکاف/تصمیم |
|---|---|---|---|
| Agent UX | کاربر intent طبیعی می‌دهد؛ agent tool را انتخاب می‌کند، لازم نیست نام tool را prompt کند | Chat intent classification و tool routing؛ به‌علاوه مسیر جداگانهٔ structured generation و JSON/import | UX نزدیک است؛ کاربر هنوز می‌تواند وارد مسیرهای مستقل شود. لاگ live لازم است |
| نوشتن روی Canvas | `use_figma` اجرای code از مسیر Figma Plugin API برای ساخت/ویرایش محتوای native است | plugin controller مستقیماً Figma Plugin API را با renderer یا allowlisted typed operations صدا می‌زند | قابلیت پایه قابل انتقال از راه API است؛ MCP endpoint یا entitlement به plugin منتقل نمی‌شود |
| Native elements | docs: frames, components, variants, variables, Auto Layout، text و styles | schema/renderer ساختار native؛ Chat tool schema ابزارهای محدود؛ component/style registry و variable adapter | `variables` و component/library reuse در workflow عمومی نیازمند native Desktop evidence و domain spike است |
| Read-before-write | Agent می‌تواند ساختار فایل conventions/design system را بخواند و بعد تغییر دهد؛ file/selection link مشخص است | Chat دارای document context, progressive discovery, inspect_nodes و ref targeting؛ create handoff فعلی به‌طور پیش‌فرض document scan لازم ندارد | Context reader در creation برای reuse سیستم موجود کامل/اثبات‌شده نیست؛ محدودیت read scope باید حفظ شود |
| Design system | استفاده از local components، variables و layout rules را هدف می‌گیرد | Brand Kit، Skills، schemas/tokens/styles و task pinning؛ Chat component references بدون supported manifest مجاز نیستند | source capability دارد اما مسیر عمومی Chat به library component access parity ندارد |
| Assets | `use_figma` از تصویرهای حاضر استفاده می‌کند؛ `upload_assets` برای upload و ابزارهای جداگانه برای generate image/vector. Image generation از Figma AI credits استفاده می‌کند | approved Brand Kit assets یا editable placeholders؛ renderer image/vector; no MCP asset service | asset source/entitlement باید explicit باشد؛ صورتحساب/credits گمانه‌زنی نشود |
| Edit/follow-up | همان conversation/file؛ can edit/create/delete/inspect، با user review | Chat task supports create/edit/inspect/continue، checkpoint، idempotency و native verification | رفتار و agent quality بین دو سیستم مقایسه نشده؛ destructive operations باید محدود بمانند |
| Multi-screen / batching | ابزار عمومی `use_figma` و agent workflow؛ مستندات این صفحه SLA یا تعداد page per call تضمین نمی‌کند | Chat schema 1–10 pages؛ structured generator سه serial sections per screen؛ model turns/batches variable | هیچ latency/parity نتیجه‌گیری نمی‌شود؛ طرح benchmark در timing-baseline است |
| اجرای plugin | remote MCP از راه hosted Figma MCP، خارج از plugin | UI داخل Figma؛ `figma.*` فقط controller/plugin sandbox؛ Companion local برای provider traffic | جداسازی runtime حفظ شود؛ arbitrary remote JS در plugin اضافه نشود |
| مجوز و هزینه | Write to canvas نیازمند supported remote MCP client، edit access و پلن Professional/Education/Organization/Enterprise است؛ مستند معرفی، Full seat را برای نوشتن بیرون از drafts ذکر می‌کند. Beta فعلاً free است و بعداً usage-based می‌شود | این repository از plugin API و Companion محلی طراحی شده؛ active account, model eligibility و plan برای این بررسی تأیید نشد | ادعای no-cost یا parity با remote MCP مجاز نیست؛ assessment حساب/seat/پلن لازم است |

## منبع رسمی

- [Write to canvas](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas/) توضیح می‌دهد `use_figma` کد را از مسیر Plugin API اجرا می‌کند و محتوای native می‌سازد؛ شرایط دسترسی/plan و beta را نیز مشخص می‌کند.
- [Figma MCP server](https://developers.figma.com/docs/figma-mcp-server/) نقش remote/desktop server و agent skills را شرح می‌دهد.
- [Tools and prompts](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) `use_figma` را remote-only معرفی می‌کند و می‌گوید tools capability می‌دهند، درحالی‌که skills workflow را هدایت می‌کنند.
- [Figma Plugin API](https://developers.figma.com/docs/plugins/api/figma/) عملیات `createFrame`, `createText`, `createComponent`, `createImage` و موارد دیگر را فهرست می‌کند.

## نتیجهٔ قابلیت‌محور

مرجع، این الگو است: agent اول context محدود و design system را می‌خواند؛ سپس با برنامه/عملیات مجاز Figma native می‌سازد، نتیجه را inspect می‌کند و در همان conversation ادامه می‌دهد. این رفتار را می‌توان روی plugin API محلی پیاده کرد، اما MCP hosting، دسترسی remote، seat entitlement، file-link context و image credits را نمی‌توان فرض یا embed کرد. مقایسهٔ واقعی برای Phase 2 فقط در صورت دسترسی و با فایل آزمایشی جداگانه انجام شود.
