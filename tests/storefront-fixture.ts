import { createDesignPlan } from "../src/shared/design-generation";

export const brief =
  "برای فروشگاه آنلاین پوشاک فارسی «ماه‌پوش» دقیقاً سه صفحه موبایل حرفه‌ای بساز. خانه فروشگاه با هدر، جست‌وجو، بنر، دسته‌بندی‌ها، حداقل چهار محصول با قیمت تومان و نوار ناوبری. جزئیات محصول با گالری و تصاویر بندانگشتی، عنوان، قیمت، رنگ، سایز، توضیحات و افزودن به سبد. سبد خرید با دو محصول، کنترل تعداد برای هر محصول، ارسال، تخفیف، مبلغ نهایی و ادامه خرید. هر صفحه ۳۹۰×۸۴۴، RTL، با محتوای بلند اسکرولی، طراحی هماهنگ زرشکی و کرم و لایه‌های Native قابل‌ویرایش در Figma باشد.";
const planned = createDesignPlan({
  prompt: brief,
  target: "mobile",
  screenCount: 3,
  screenNames: ["خانه فروشگاه", "جزئیات محصول", "سبد خرید"],
  language: "fa",
  style: "زرشکی و کرم",
  professionalVisualVersion: 1,
  storefrontLayoutVersion: 1,
});
if (!planned.success) throw new Error(planned.errors.join(" "));
export const storefrontPlan = planned.data;
