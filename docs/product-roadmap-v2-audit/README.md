# ممیزی Roadmap محصول‌محور v2 — نتیجه اجرایی

**تاریخ:** 2026-11-16  
**نسخه بررسی‌شده:** branch `main`، commit `1770728` (`phase 14`)  
**دامنه:** قرارداد محصول و baseline (Phase 0)، ممیزی قابلیت‌های Figma MCP در برابر پلاگین (Phase 1).  
**روش:** بررسی source، manifest، build hash و اسناد/diagnosticهای ثبت‌شده؛ بدون اجرای test، provider call یا تغییر در Figma.

## تصمیم

**GO محدود:** تهیه و بررسی طرح Phase 2 برای یک spike سه‌دامنه‌ای، پس از تأیید جداگانه‌ای که در roadmap لازم دانسته شده است.  
**NO-GO:** مهاجرت معماری، جایگزینی composer یا renderer، ادعای آمادگی عمومی/ده‌صفحه‌ای، و اعلام پذیرش زنده.

مخزن از صفر نیست. Chat، سه مسیر generation، قرارداد declarative چندصفحه‌ای، native renderer/executor، history/checkpoints، Brand Kit، Skills، recovery و native QA وجود دارند. اما evidence موجود عمدتاً روی mock و fixture است؛ commerce راهکار ویژه دارد؛ هیچ مقایسه زنده و هم‌brief با Figma MCP در این ممیزی انجام نشد.

## یافته‌های تصمیم‌ساز

1. **Chat تا ۱۰ صفحه را می‌پذیرد، اما به معنی یک درخواست مدل برای همه صفحات نیست.** Chat یک `MultiScreenDesignRequest` تایپ‌شده به generator می‌دهد. مسیر استاندارد برای هر صفحه `identity → primary → supporting` را به ترتیب و serial تولید می‌کند؛ بنابراین حد پایهٔ منبع `3N` پاسخ مدل است، پیش از repair. (کد: `src/shared/chat-generation.ts`، `src/ui/App.tsx` حوالی 3375–3405؛ جزئیات در [timing-baseline](timing-baseline.md).)
2. **تعمیم‌پذیری جزئی است.** الگوهای عمومی و چند دامنه در `design-patterns.ts`/`visual-design-spec.ts` وجود دارند، ولی نوع پروژه به `storefront | dashboard | product` محدود است و تشخیص fallback برای پروژه ناشناخته `product` می‌شود. `storefront-layout.ts` و مسیر `storefrontLayoutVersion` یک composer واقعی و ویژهٔ فروشگاه‌اند. (جزئیات در [quality-baseline](quality-baseline.md).)
3. **هسته native قابل استفادهٔ مجدد است.** multi-screen schema و renderer ساختار Figma را می‌سازند؛ Chat ابزارهای native محدود و task-owned برای inspect/edit دارد. هیچ‌کدام به‌تنهایی اثباتِ کیفیت بصری یا سازگاری زنده نیستند.
4. **Figma MCP الگوی قابلیت و تجربه است، نه dependency قابل‌فرض.** Figma می‌گوید `use_figma` از Figma Plugin API برای ساخت/ویرایش محتوای native استفاده می‌کند؛ این قابلیت remote MCP، client پشتیبانی‌شده، edit access و پلن/seat واجد شرایط می‌خواهد و فعلاً در beta رایگان است اما قرار است usage-based شود. برای جزئیات به [مقایسه MCP](mcp-parity-matrix.md) مراجعه کنید.
5. **سه مانع اصلی:** (الف) کیفیت و عمومیت بین دامنه‌ها اثبات نشده؛ (ب) fanout serial در structured generation و تعداد متغیر roundهای Chat زمان زنده را نامعلوم می‌گذارد؛ (ج) read/edit از سند موجود و استفاده از component library در create مسیرها یک قرارداد یکپارچه و زندهٔ اثبات‌شده ندارند.

## قرارداد پیشنهادی برای ارزیابی Phase 2

یک **hybrid candidate** را با دو قرارداد موجود مقایسه کنید: declarative Design IR برای ساخت screen trees، layout، style و asset reference؛ و bounded typed operations برای خواندن سند، هدف‌یابی، edit و reconciliation. `MultiScreenSpec` و renderer، baseline کم‌ریسک‌تری برای creation هستند؛ `FigmaToolActionSchema`/executor نمونهٔ موجود برای operationهای محدود است. این انتخاب قطعی نیست: Phase 2 باید آزادی طراحی، تعداد roundها، قابلیت audit، safety و native editability را در سه دامنه اندازه بگیرد. اجرای آزاد JavaScript یا دسترسی نامحدود به سند در گزینه‌ها نیست.

## وضعیت مدارک و موارد مفقود

اسناد Phase 0/1 در همین پوشه آمده‌اند: [قرارداد محصول](product-contract.md)، [inventory قابلیت‌ها](capability-inventory.md)، [baseline evidence](baseline-evidence.md)، [قرارداد عدم رگرسیون](non-regression-contract.md)، [مقایسه MCP](mcp-parity-matrix.md)، [baseline زمان](timing-baseline.md)، [شکاف native](native-capability-gap.md)، [baseline کیفیت](quality-baseline.md) و [طرح spike](phase-2-spike-plan.md).

برای Go/No-Go نهایی معماری هنوز این evidence لازم است: سه خروجی غیرتجاری با یک قرارداد واحد؛ بازرسی انسانی در 100%؛ حداقل یک اجرای Desktop در فایل disposable با مدل و دسترسی مجاز؛ readback واقعی لایه‌ها، typography، Auto Layout و scroll؛ زمان تا اولین صفحه و زمان کل؛ و توقف/ادامه یا edit تک‌صفحه‌ای بدون duplicate و collateral change. تا آن زمان وضعیت زنده **NOT MEASURED** است.

## Figma MCP — منبع رسمی

- [Write to canvas](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas/)
- [Figma MCP server](https://developers.figma.com/docs/figma-mcp-server/)
- [Tools and prompts](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/)
- [Figma Plugin API](https://developers.figma.com/docs/plugins/api/figma/)
