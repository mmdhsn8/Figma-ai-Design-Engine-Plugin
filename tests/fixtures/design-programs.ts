const fixed = (value: number) => ({ mode: "fixed" as const, value });
const frame = (id: string, name: string, role: string, width: number, height: number, axis: "row" | "column", children: unknown[], options: Record<string, unknown> = {}) => ({
  type: "container", id, name, semanticRole: role, width: fixed(width), height: fixed(height),
  layout: { axis, gap: 12, padding: { top: 12, right: 12, bottom: 12, left: 12 }, crossAlign: "stretch" }, children, ...options,
});
const text = (id: string, name: string, role: string, value: string, width: number, height: number, options: Record<string, unknown> = {}) => ({
  type: "text", id, name, semanticRole: role, width: fixed(width), height: fixed(height), text: value, color: "token:ink", fontSize: 16, ...options,
});
const card = (id: string, name: string, width: number, height: number, fillColor = "token:surface") => ({
  type: "rectangle", id, name, semanticRole: "content-card", width: fixed(width), height: fixed(height), fill: fillColor, cornerRadius: 16,
});

export const designProgramFixtures = [
  {
    programVersion: 1, id: "learning-overview", revision: 1,
    goal: "Create a student learning overview with clear next-lesson progress.", audience: "Persian-speaking students",
    locale: { language: "fa-IR", direction: "rtl" }, visualIntent: "Calm, encouraging, editorial learning dashboard.", contentProvenance: "synthetic-fixture",
    requiredCapabilities: ["native-text", "auto-layout", "rtl", "vertical-scroll"],
    tokens: { colors: { ink: "#20283A", brand: "#6558D3", surface: "#FFFFFF", canvas: "#F5F4FA", accent: "#DDF4E8" }, spacing: [8, 12, 16, 24], headingFont: "Inter", bodyFont: "Inter" },
    screens: [{ id: "student-home", title: "Learning overview", purpose: "Resume learning and review course progress.", order: 0, viewport: { preset: "mobile", width: 390, height: 844 }, scroll: "vertical", dependsOn: [], root: frame("overview", "Learning overview content", "learning-dashboard", 342, 1040, "column", [
      text("welcome", "Welcome heading", "heading", "سلام، نازنین", 318, 40, { color: "token:ink", fontSize: 28, weight: "bold" }),
      text("course-title", "Course title", "course-heading", "طراحی تجربه کاربری", 318, 32, { color: "token:ink", fontSize: 20, weight: "semibold" }),
      card("progress-card", "Course progress card", 318, 84, "token:accent"),
      frame("instructor", "Instructor panel", "instructor-information", 318, 72, "row", [text("instructor-name", "Instructor name", "instructor", "مدرس: سارا محمدی", 230, 48, { color: "#FFFFFF" }), text("instructor-avatar", "Instructor initial", "avatar-label", "س", 40, 48, { color: "#FFFFFF", align: "center", interaction: "none" })], { background: "token:brand" }),
      frame("next-lesson", "Next lesson card", "lesson-navigation", 318, 120, "column", [text("lesson-label", "Next lesson", "lesson-meta", "درس بعدی · ۱۲ دقیقه", 280, 32, { color: "#FFFFFF" }), text("continue", "Continue learning", "action", "ادامه یادگیری", 280, 48, { color: "#FFFFFF", interaction: "button", weight: "semibold" })], { background: "token:brand" }),
      text("lesson-list", "Lesson list heading", "section-heading", "مسیر یادگیری", 318, 32, { color: "token:ink", weight: "bold" }),
      card("lesson-one", "Lesson one item", 318, 72), card("lesson-two", "Lesson two item", 318, 72),
    ]) }],
  },
  {
    programVersion: 1, id: "appointment-booking", revision: 1,
    goal: "Let a visitor find a service, choose a time, and review an appointment.", audience: "Persian-speaking service visitors",
    locale: { language: "fa-IR", direction: "rtl" }, visualIntent: "Trustworthy, spacious booking flow with clear time choices.", contentProvenance: "synthetic-fixture",
    requiredCapabilities: ["native-text", "auto-layout", "rtl", "vertical-scroll"],
    tokens: { colors: { ink: "#1D2B38", brand: "#147D72", surface: "#FFFFFF", canvas: "#F1F7F6", selected: "#D9F1EC" }, spacing: [8, 12, 16, 24], headingFont: "Inter", bodyFont: "Inter" },
    screens: [{ id: "appointment", title: "Choose an appointment", purpose: "Select date and time, then confirm the synthetic booking summary.", order: 0, viewport: { preset: "mobile", width: 390, height: 844 }, scroll: "vertical", dependsOn: [], root: frame("booking-content", "Booking details", "appointment-booking", 342, 1020, "column", [
      text("booking-title", "Booking title", "heading", "رزرو نوبت", 318, 40, { color: "token:ink", fontSize: 26, weight: "bold" }),
      text("service", "Service selection", "service", "مشاوره اولیه · ۳۰ دقیقه", 318, 48, { color: "token:ink" }),
      text("date-heading", "Date selection heading", "date-group", "انتخاب روز", 318, 32, { color: "token:ink", weight: "semibold" }),
      frame("dates", "Date choices", "date-options", 318, 72, "row", [text("date-1", "Date Tuesday", "date-option", "سه‌شنبه", 82, 48, { color: "token:ink", interaction: "button", align: "center" }), text("date-2", "Date Wednesday", "date-option", "چهارشنبه", 92, 48, { color: "token:ink", interaction: "button", align: "center" }), text("date-3", "Date Thursday", "date-option", "پنج‌شنبه", 82, 48, { color: "token:ink", interaction: "button", align: "center" })], { background: "token:selected" }),
      text("time-heading", "Time selection heading", "time-group", "ساعت‌های پیشنهادی", 318, 32, { color: "token:ink", weight: "semibold" }),
      frame("times", "Available time choices", "time-options", 318, 72, "row", [text("time-1", "Time 10", "time-option", "۱۰:۰۰", 88, 48, { color: "token:ink", interaction: "button", align: "center" }), text("time-2", "Time 11", "time-option", "۱۱:۳۰", 88, 48, { color: "token:ink", interaction: "button", align: "center" }), text("time-3", "Time 13", "time-option", "۱۳:۰۰", 88, 48, { color: "token:ink", interaction: "button", align: "center" })], { background: "token:surface" }),
      card("summary", "Appointment summary", 318, 116, "token:selected"),
      text("synthetic-note", "Synthetic availability note", "disclosure", "نمونه نمایشی؛ موجودی واقعی بررسی نشده است.", 318, 42, { color: "token:ink", fontSize: 13 }),
      text("confirm", "Confirm appointment", "action", "تأیید و ادامه", 318, 52, { color: "token:brand", interaction: "button", weight: "bold", align: "center" }),
    ]) }],
  },
  {
    programVersion: 1, id: "team-analytics", revision: 1,
    goal: "Summarize team workspace activity with KPIs, a trend chart, filters, and a report table.", audience: "Operations and product teams",
    locale: { language: "en-US", direction: "ltr" }, visualIntent: "Precise, information-dense analytics workspace with calm neutral surfaces.", contentProvenance: "synthetic-fixture",
    requiredCapabilities: ["native-text", "auto-layout"],
    tokens: { colors: { ink: "#18212F", brand: "#3457D5", surface: "#FFFFFF", canvas: "#F4F6FA", chart: "#82A6F4" }, spacing: [8, 12, 16, 24, 32], headingFont: "Inter", bodyFont: "Inter" },
    screens: [{ id: "workspace-report", title: "Workspace analytics", purpose: "Review team activity, performance trends, and a report table.", order: 0, viewport: { preset: "desktop", width: 1440, height: 900 }, scroll: "none", dependsOn: [], root: frame("analytics-shell", "Analytics workspace shell", "workspace-layout", 1392, 852, "row", [
      frame("sidebar", "Workspace navigation", "navigation-region", 216, 804, "column", [text("workspace-name", "Workspace name", "workspace-identity", "Northstar team", 184, 48, { color: "token:ink", weight: "bold" }), text("nav-overview", "Overview navigation", "navigation-item", "Overview", 184, 48, { color: "token:brand", interaction: "navigation" }), text("nav-reports", "Reports navigation", "navigation-item", "Reports", 184, 48, { color: "token:ink", interaction: "navigation" })], { background: "token:surface" }),
      frame("main-report", "Analytics main region", "report-region", 1128, 804, "column", [
        frame("report-header", "Report title and filters", "report-header", 1080, 72, "row", [text("report-title", "Report title", "heading", "Team activity", 720, 48, { color: "token:ink", fontSize: 26, weight: "bold" }), text("date-filter", "Date filter", "filter", "Last 30 days", 220, 48, { color: "token:ink", interaction: "button", align: "center" })], { background: "token:surface" }),
        frame("kpis", "Key performance indicators", "kpi-group", 1080, 144, "row", [card("active-kpi", "Active members KPI", 252, 112), card("sessions-kpi", "Sessions KPI", 252, 112), card("completion-kpi", "Completion KPI", 252, 112)], { background: "token:canvas" }),
        frame("trend", "Activity trend chart", "analytics-visualization", 1080, 250, "column", [text("trend-title", "Activity trend title", "section-heading", "Weekly activity trend", 1020, 32, { color: "token:ink", weight: "semibold" }), frame("chart-bars", "Native chart bars", "chart-plot", 1020, 176, "row", [card("bar-1", "Week one bar", 80, 76, "token:chart"), card("bar-2", "Week two bar", 80, 112, "token:brand"), card("bar-3", "Week three bar", 80, 90, "token:chart"), card("bar-4", "Week four bar", 80, 144, "token:brand"), card("bar-5", "Week five bar", 80, 128, "token:chart")], { background: "token:surface" })], { background: "token:surface" }),
        frame("report-table", "Workspace report table", "data-table", 1080, 220, "column", [text("table-heading", "Report table title", "section-heading", "Team report", 1020, 32, { color: "token:ink", weight: "semibold" }), frame("table-row-1", "Report row one", "data-row", 1020, 72, "row", [text("row-one-name", "Member row one", "data-cell", "Alex Morgan", 430, 44, { color: "token:ink" }), text("row-one-value", "Sessions row one", "data-cell", "48 sessions", 240, 44, { color: "token:ink" })], { background: "token:canvas" })], { background: "token:surface" }),
      ], { background: "token:canvas" }),
    ], { background: "token:canvas" }) }],
  },
  {
    programVersion: 1, id: "civic-service-portal", revision: 1,
    goal: "Help residents track permit requests and find the next required action.", audience: "Residents using local public services",
    locale: { language: "en-US", direction: "ltr" }, visualIntent: "Clear, approachable civic information with transparent status and next steps.", contentProvenance: "synthetic-fixture",
    requiredCapabilities: ["native-text", "auto-layout", "vertical-scroll"],
    tokens: { colors: { ink: "#20313B", brand: "#185E86", surface: "#FFFFFF", canvas: "#F3F7F9", status: "#E4F2EA" }, spacing: [8, 12, 16, 24], headingFont: "Inter", bodyFont: "Inter" },
    screens: [{ id: "resident-dashboard", title: "Resident services", purpose: "Review service requests, status, and next actions.", order: 0, viewport: { preset: "mobile", width: 390, height: 844 }, scroll: "vertical", dependsOn: [], root: frame("resident-content", "Resident service dashboard", "service-dashboard", 342, 930, "column", [
      text("resident-title", "Resident dashboard title", "heading", "Your service requests", 318, 40, { color: "token:ink", fontSize: 25, weight: "bold" }),
      text("permit-number", "Permit reference", "request-reference", "Permit · REF-2048", 318, 48, { color: "token:ink" }),
      card("status", "Request status panel", 318, 84, "token:status"),
      text("next-step-heading", "Next step heading", "next-step", "Next step", 318, 32, { color: "token:ink", weight: "semibold" }),
      frame("required-documents", "Required documents group", "document-checklist", 318, 128, "column", [text("document-one", "Proof of residence", "checklist-item", "Proof of residence", 282, 44, { color: "token:ink" }), text("document-two", "Site plan", "checklist-item", "Site plan", 282, 44, { color: "token:ink" })], { background: "token:surface" }),
      text("upload-action", "Upload documents", "action", "Upload documents", 318, 52, { color: "token:brand", interaction: "button", weight: "bold", align: "center" }),
      text("help", "Service help contact", "support", "Need help? View service guidance", 318, 48, { color: "token:brand" }),
    ]) }],
  },
] as const;
