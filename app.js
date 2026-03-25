const STORAGE_KEY = "red-sync-v1-items";
const STORAGE_DATASET_VERSION_KEY = "red-sync-v1-dataset-version";
const CURRENT_DATASET_VERSION = "real-data-v4";
const MEETING_LINK_STORAGE_KEY = "red-sync-v1-meeting-link";
const DEFAULT_MEETING_LINK = "";
const MEETING_GATE_SIMILARITY_THRESHOLD = 0.23;
const MEETING_GATE_MIN_SOLUTION_CHARS = 40;
const CREATE_SIMILAR_MIN_WORDS = 3;
const CREATE_SIMILAR_THRESHOLD = 0.14;
const CREATE_SIMILAR_LIMIT = 4;
const RULE_ALERT_STORAGE_KEY = "red-sync-v1-rule-alerts";
const KNOWLEDGE_REUSE_THRESHOLD = 0.60;   // Feature 1: meeting decision engine
const RECURRING_WINDOW_DAYS = 60;         // Feature 7: recurring challenge window
const RECURRING_MIN_COUNT = 3;            // Feature 7: minimum recurrences
const LEFT_RAIL_COLLAPSE_KEY = "red-sync-v2-left-rail-collapsed";
const meetingLog = [];
const assistantThread = [];

// ═══ Analytics: Meeting Cost Model (for man-hours / meetings avoided KPI) ═
const MEETING_COST_MODEL = {
  team_weekly:     { avgAttendees: 3, durationMin: 45, label: "Senior Manager" },
  regional_red:    { avgAttendees: 5, durationMin: 45, label: "Assoc. Director" },
  national_red:    { avgAttendees: 7, durationMin: 60, label: "Director" },
  leadership_sync: { avgAttendees: 8, durationMin: 60, label: "Leadership" },
};
const MEETING_PREP_MULTIPLIER = 1.5; // prep + follow-up overhead factor

// ═══ V2: Department Email Mapping (Tutor Feedback §2, §3) ════════════════
const DEPARTMENT_EMAILS = {
  "Legal": "legal@company.com",
  "Finance": "finance@company.com",
  "Operations": "operations@company.com",
  "IT": "it@company.com",
  "Supply Chain": "supplychain@company.com",
  "HR": "hr@company.com",
  "Field Sales North": "fieldsales.north@company.com",
  "Field Sales South": "fieldsales.south@company.com",
  "Key Accounts Supermarkets": "keyaccounts@company.com",
  "Convenience & Petrol": "convenience@company.com",
  "E-commerce Sales": "ecommerce@company.com",
  "Wholesalers": "wholesalers@company.com",
  "Sales Operations": "salesops@company.com",
  "Trade Marketing": "trademarketing@company.com",
  "Revenue Growth Management": "rgm@company.com",
  "Shopper Marketing": "shoppermarketing@company.com",
};

// ═══ V2: Meeting Hierarchy (Tutor Feedback §6) ══════════════════════════
const MEETING_HIERARCHY = [
  { key: "team_weekly", label: "Senior Manager Meeting", time: "09:45", deptScope: "own" },
  { key: "regional_red", label: "Associate Director Meeting", time: "10:30", deptScope: "region" },
  { key: "national_red", label: "Director Meeting", time: "11:00", deptScope: "multi" },
  { key: "leadership_sync", label: "Leadership Team Meeting", time: "15:00", deptScope: "all" },
];

// ═══ V2: Notification Storage (Tutor Feedback §1 Notes) ═════════════════
const NOTIFICATION_STORAGE_KEY = "red-sync-v2-notifications";

function loadNotifications() {
  try {
    return JSON.parse(localStorage.getItem(NOTIFICATION_STORAGE_KEY) || "[]");
  } catch { return []; }
}

function saveNotifications(notifs) {
  localStorage.setItem(NOTIFICATION_STORAGE_KEY, JSON.stringify(notifs));
}

function addNotification(notif) {
  const notifs = loadNotifications();
  notifs.unshift({
    id: "N" + Date.now(),
    timestamp: new Date().toISOString(),
    read: false,
    ...notif,
  });
  // Keep max 50
  if (notifs.length > 50) notifs.length = 50;
  saveNotifications(notifs);
}

// ═══ V2: Active filters state ═══════════════════════════════════════════
let activeDeptFilter = "all";
let activeMeetingLevelFilter = "all";
let activeRoleView = "sales_rep";

function normalizeRoleView(value) {
  return value === "supervisor" ? "supervisor" : "sales_rep";
}

function isSupervisorView() {
  return normalizeRoleView(activeRoleView) === "supervisor";
}

function canCollaborateOnItem(item) {
  return isSupervisorView() || item?.type === "challenge";
}

function canCommentOnItem(item) {
  return Boolean(item);
}

function getAllowedScreensForRole() {
  return isSupervisorView()
    ? ["dashboard", "meeting", "create", "archive", "analytics", "settings"]
    : ["dashboard", "meeting", "create", "archive"];
}

// Tracks meetings avoided by knowledge reuse (session counter, persisted)
let meetingsAvoidedCount = Number(localStorage.getItem("red-sync-v1-meetings-avoided") || "0");
let knowledgeReuseCount = Number(localStorage.getItem("red-sync-v1-knowledge-reuse") || "0");

const ASSISTANT_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "have",
  "has",
  "had",
  "are",
  "was",
  "were",
  "you",
  "your",
  "our",
  "can",
  "but",
  "not",
  "just",
  "into",
  "about",
  "before",
  "after",
  "then",
  "als",
  "een",
  "het",
  "met",
  "van",
  "voor",
  "dat",
  "dit",
  "zijn",
  "was",
  "werd",
  "nog",
  "ook",
  "door",
  "bij",
  "op",
  "in",
  "de",
  "te",
  "en",
  "of",
]);

// Query alias map for offline "NotebookLM-like" matching (abbreviations + jargon)
const ASSISTANT_TERM_ALIASES = {
  oos: ["outofstock", "stockout", "availability", "stock"],
  dc: ["distribution", "centre", "center", "warehouse", "depot"],
  sku: ["product", "item", "assortment"],
  pos: ["pointofsale", "display", "shelf"],
  rgm: ["revenue", "growth", "management", "pricing"],
  promo: ["promotion", "promotional", "campaign", "discount"],
  qa: ["quality", "assurance"],
  cx: ["customer", "experience"],
  voorraad: ["stock", "inventory", "availability"],
  vertraging: ["delay", "late", "slow"],
  fout: ["error", "issue", "problem"],
  uitdaging: ["challenge", "issue", "problem"],
  probleem: ["challenge", "issue", "problem"],
};

const ASSISTANT_LLM_CONFIG = {
  enabled: true,
  provider: "openai-proxy", // "openai-proxy" or "ollama"
  endpoint: "/api/openai-assistant", // Expected response: { answer: "..." } or OpenAI Responses payload
  model: "gpt-4o-mini",
  temperature: 0.2,
  timeoutMs: 18000,
  contextCaseLimit: 6,
  uiMatchLimit: 5,
};

let assistantLlmUnavailableNotified = false;

const MEETING_LAYERS = {
  team_weekly: "Senior Manager Meeting (09:45)",
  regional_red: "Associate Director Meeting",
  national_red: "Director Meeting (11:00)",
  leadership_sync: "Leadership Team Meeting (15:00)",
};

const initialItems = [
  {
    id: "HJD00001",
    type: "challenge",
    title: "Temperature excursion reported during last-mile delivery",
    description: "Two delivery routes recorded temperature excursions above threshold, potentially affecting product quality for chilled beverages.",
    department: "Field Sales North",
    assignedToDept: "",
    meetingLevel: "national_red",
    externalEmail: "",
    createdBy: "Alex Vermeer",
    createdAt: "2026-02-03",
    weekStart: "2026-02-02",
    status: "resolved",
    meetingNeeded: false,
    priority: "high",
    dueDate: "2026-02-16",
    resolvedBy: "Tom Bakker",
    resolvedAt: "2026-02-11",
    solution: "Implemented standardized correction flow with automated price verification at POS.",
    solutionTemplate: null,
    assignedTo: "Tom Bakker",
    stakeholders: ["Regional Sales Lead", "Tom Bakker"],
    details: { isRecurring: true, escalationLevel: "team_lead", relatedItemCode: "HJD00001" },
    updates: [{ type: "feedback", note: "Monitoring ongoing, early improvements visible. (Regional Sales Lead, 2026-02-07)" }, { type: "solution_note", note: "Solution: Implemented standardized correction flow with automated price verification at PO..." }],
  },
  {
    id: "HJD00002",
    type: "challenge",
    title: "Cross-docking errors at distribution centre increasing returns",
    description: "Cross-docking process at central DC has a 4 percent error rate, resulting in wrong deliveries and costly returns from retailers.",
    department: "Key Accounts Supermarkets",
    assignedToDept: "Operations",
    meetingLevel: "regional_red",
    externalEmail: "",
    createdBy: "Mila Janssen",
    createdAt: "2026-02-04",
    weekStart: "2026-02-02",
    status: "assigned",
    meetingNeeded: true,
    priority: "high",
    dueDate: "2026-02-22",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Laura de Vries",
    stakeholders: ["Mark Jansen", "Laura de Vries"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Data analysis completed, presenting findings next Monday. (Mark Jansen, 2026-02-06)" }],
  },
  {
    id: "HJD00003",
    type: "challenge",
    title: "Zero Sugar multipack stock-out in top urban stores",
    description: "Urban convenience stores reported repeated out-of-stocks on Zero Sugar multipacks across weekends. Demand pattern exceeds current replenishment settings.",
    department: "Jumbo & Discounters",
    assignedToDept: "Legal",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Sophie van Dijk",
    createdAt: "2026-02-05",
    weekStart: "2026-02-02",
    status: "assigned",
    meetingNeeded: true,
    priority: "medium",
    dueDate: "2026-02-20",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Supply Planning",
    stakeholders: ["Supply Planning"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Pilot initiated in two regions for validation. (Supply Planning, 2026-02-10)" }],
  },
  {
    id: "HJD00004",
    type: "celebration",
    title: "Successful promotion campaign with double digit uplift",
    description: "Summer campaign for Zero Sugar multipack delivered 14 percent volume uplift and 8 percent value share gain in participating stores.",
    department: "E-commerce Sales",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Jade Mulder",
    createdAt: "2026-02-06",
    weekStart: "2026-02-02",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "David Meijer",
    resolvedAt: "2026-02-22",
    solution: "Transport capacity contract renegotiated with backup carrier on standby.",
    solutionTemplate: null,
    assignedTo: "David Meijer",
    stakeholders: ["David Meijer", "Emma Visser"],
    details: { milestoneType: "Promo effectiveness", audienceNote: "Field teams and leadership" },
    updates: [{ type: "feedback", note: "Data analysis completed, presenting findings next Monday. (Emma Visser, 2026-02-10)" }, { type: "solution_note", note: "Solution: Transport capacity contract renegotiated with backup carrier on standby...." }],
  },
  {
    id: "HJD00005",
    type: "celebration",
    title: "Strong cross-functional collaboration achieved on launch",
    description: "New product launch was executed flawlessly across all channels thanks to aligned planning between trade marketing, supply chain and field sales.",
    department: "Key Accounts Supermarkets",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Kai van Ommen",
    createdAt: "2026-02-07",
    weekStart: "2026-02-02",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "David Meijer",
    resolvedAt: "2026-02-14",
    solution: "Transport capacity contract renegotiated with backup carrier on standby.",
    solutionTemplate: null,
    assignedTo: "David Meijer",
    stakeholders: ["Tom Bakker", "David Meijer"],
    details: { milestoneType: "Execution KPI", audienceNote: "Field teams and leadership" },
    updates: [{ type: "feedback", note: "Cross-functional task force assembled to address root cause. (Tom Bakker, 2026-02-09)" }, { type: "solution_note", note: "Solution: Transport capacity contract renegotiated with backup carrier on standby...." }],
  },
  {
    id: "HJD00006",
    type: "challenge",
    title: "Planogram compliance audit shows 58 percent adherence",
    description: "Latest audit reveals only 58 percent planogram compliance in the north region. Main issues are shelf-space allocation and facing direction.",
    department: "E-commerce Sales",
    assignedToDept: "",
    meetingLevel: "regional_red",
    externalEmail: "",
    createdBy: "Jade Mulder",
    createdAt: "2026-02-08",
    weekStart: "2026-02-02",
    status: "closed",
    meetingNeeded: false,
    priority: "high",
    dueDate: "2026-02-28",
    resolvedBy: "IT Support",
    resolvedAt: "2026-02-16",
    solution: "Accrual validation template distributed; monthly reconciliation meeting scheduled.",
    solutionTemplate: null,
    assignedTo: "IT Support",
    stakeholders: ["RGM Analyst", "IT Support"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Vendor contacted, awaiting SLA revision proposal. (RGM Analyst, 2026-02-11)" }, { type: "solution_note", note: "Solution: Accrual validation template distributed; monthly reconciliation meeting schedule..." }],
  },
  {
    id: "HJD00007",
    type: "celebration",
    title: "Digital coupon activation delivered basket uplift",
    description: "Targeted digital coupon execution in two chains delivered a measurable basket-size uplift and stronger repeat purchase in the trial period.",
    department: "Sales Operations",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Laura de Vries",
    createdAt: "2026-02-09",
    weekStart: "2026-02-09",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "Sophie van Dijk",
    resolvedAt: "2026-02-17",
    solution: "Asset pipeline audit completed; dedicated content QA step added before publication.",
    solutionTemplate: null,
    assignedTo: "Sophie van Dijk",
    stakeholders: ["Operations Lead", "Sophie van Dijk"],
    details: { milestoneType: "Volume growth", audienceNote: "Field teams and leadership" },
    updates: [{ type: "feedback", note: "Pilot initiated in two regions for validation. (Operations Lead, 2026-02-13)" }, { type: "solution_note", note: "Solution: Asset pipeline audit completed; dedicated content QA step added before publicati..." }],
  },
  {
    id: "HJD00008",
    type: "celebration",
    title: "Improved on-time delivery KPI to 97 percent",
    description: "On-time delivery rate improved from 91 to 97 percent after introducing route optimization and early-morning dispatch windows.",
    department: "Key Accounts Supermarkets",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Kai van Ommen",
    createdAt: "2026-02-10",
    weekStart: "2026-02-09",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "Mark Jansen",
    resolvedAt: "2026-02-21",
    solution: "Route optimization applied with priority windows for top-tier accounts.",
    solutionTemplate: null,
    assignedTo: "Mark Jansen",
    stakeholders: ["Mark Jansen", "IT Support"],
    details: { milestoneType: "Execution KPI", audienceNote: "Key Accounts Supermarkets" },
    updates: [{ type: "feedback", note: "Vendor contacted, awaiting SLA revision proposal. (IT Support, 2026-02-14)" }, { type: "solution_note", note: "Solution: Route optimization applied with priority windows for top-tier accounts...." }],
  },
  {
    id: "HJD00009",
    type: "challenge",
    title: "EDI order rejections from supermarket DC after packaging code update",
    description: "Automatic EDI rejections increased for small-format SKUs after packaging code updates. Team needs master-data validation and temporary manual fallback.",
    department: "Revenue Growth Management",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Laura de Vries",
    createdAt: "2026-02-11",
    weekStart: "2026-02-09",
    status: "new",
    meetingNeeded: true,
    priority: "medium",
    dueDate: "2026-02-26",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "",
    stakeholders: ["Operations Lead", "Supply Planning"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Escalated and temporary solution implemented. (Operations Lead, 2026-02-16)" }],
  },
  {
    id: "HJD00010",
    type: "challenge",
    title: "Recurring stock-out issue in regional warehouse",
    description: "Regional warehouse faces weekly stock-outs on three core SKUs due to forecast lag and minimum order quantity constraints with suppliers.",
    department: "Field Sales South",
    assignedToDept: "",
    meetingLevel: "regional_red",
    externalEmail: "",
    createdBy: "Lotte Willems",
    createdAt: "2026-02-12",
    weekStart: "2026-02-09",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "2026-03-03",
    resolvedBy: "David Meijer",
    resolvedAt: "2026-03-02",
    solution: "Implemented standardized correction flow with automated price verification at POS.",
    solutionTemplate: null,
    assignedTo: "David Meijer",
    stakeholders: ["David Meijer", "Emma Visser"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Vendor contacted, awaiting SLA revision proposal. (Emma Visser, 2026-02-17)" }, { type: "solution_note", note: "Solution: Implemented standardized correction flow with automated price verification at PO..." }],
  },
  {
    id: "HJD00011",
    type: "challenge",
    title: "Competitor exclusivity at checkout zone in two stores",
    description: "Two stores shifted checkout coolers to competitor-only placement, reducing Coca-Cola visibility during afternoon peak traffic.",
    department: "Field Sales North",
    assignedToDept: "Supply Chain",
    meetingLevel: "regional_red",
    externalEmail: "",
    createdBy: "Bram de Roo",
    createdAt: "2026-02-13",
    weekStart: "2026-02-09",
    status: "escalated",
    meetingNeeded: true,
    priority: "high",
    dueDate: "2026-02-24",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Emma Visser",
    stakeholders: ["David Meijer", "Emma Visser"],
    details: { isRecurring: false, escalationLevel: "senior_leadership", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Escalated and temporary solution implemented. (David Meijer, 2026-02-17)" }, { type: "status_change", note: "Escalated for structural resolution." }],
  },
  {
    id: "HJD00012",
    type: "challenge",
    title: "Competitor exclusivity at checkout zone in two stores",
    description: "Two stores shifted checkout coolers to competitor-only placement, reducing Coca-Cola visibility during afternoon peak traffic.",
    department: "Field Sales North",
    assignedToDept: "",
    meetingLevel: "leadership_sync",
    externalEmail: "",
    createdBy: "Bram de Roo",
    createdAt: "2026-02-14",
    weekStart: "2026-02-09",
    status: "new",
    meetingNeeded: true,
    priority: "high",
    dueDate: "2026-02-26",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "",
    stakeholders: ["Operations Lead", "Emma Visser"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Data analysis completed, presenting findings next Monday. (Emma Visser, 2026-02-17)" }],
  },
  {
    id: "HJD00013",
    type: "celebration",
    title: "Strong cross-functional collaboration achieved on launch",
    description: "New product launch was executed flawlessly across all channels thanks to aligned planning between trade marketing, supply chain and field sales.",
    department: "E-commerce Sales",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Jade Mulder",
    createdAt: "2026-02-15",
    weekStart: "2026-02-09",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "Supply Planning",
    resolvedAt: "2026-02-21",
    solution: "Supplier committed to four-week lead time for promo packaging; buffer ordered.",
    solutionTemplate: null,
    assignedTo: "Supply Planning",
    stakeholders: ["Regional Sales Lead", "Supply Planning"],
    details: { milestoneType: "Volume growth", audienceNote: "Field teams and leadership" },
    updates: [{ type: "feedback", note: "Added to monthly performance dashboard. (Regional Sales Lead, 2026-02-17)" }, { type: "solution_note", note: "Solution: Supplier committed to four-week lead time for promo packaging; buffer ordered...." }],
  },
  {
    id: "HJD00014",
    type: "contribution",
    title: "Introduced structured tagging for challenges",
    description: "Proposed and tested a tagging taxonomy for RED challenges, enabling faster filtering and knowledge retrieval for recurring topics.",
    department: "Trade Marketing",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Noah Kuiper",
    createdAt: "2026-02-16",
    weekStart: "2026-02-16",
    status: "closed",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "Emma Visser",
    resolvedAt: "2026-02-28",
    solution: "Event-driven overlay added to forecast model; weekend accuracy improved to 89 percent.",
    solutionTemplate: null,
    assignedTo: "Emma Visser",
    stakeholders: ["Mark Jansen", "Emma Visser"],
    details: { topicTag: "Best Practice", targetAudience: "Cross-functional" },
    updates: [{ type: "feedback", note: "Root cause identified and corrective action defined. (Mark Jansen, 2026-02-19)" }, { type: "solution_note", note: "Solution: Event-driven overlay added to forecast model; weekend accuracy improved to 89 pe..." }],
  },
  {
    id: "HJD00015",
    type: "challenge",
    title: "Late depot departure affecting first-wave store visits",
    description: "Monday route departures from one depot shifted by 45 minutes for two consecutive weeks, reducing execution time in top-priority stores.",
    department: "E-commerce Sales",
    assignedToDept: "",
    meetingLevel: "regional_red",
    externalEmail: "",
    createdBy: "Jade Mulder",
    createdAt: "2026-02-17",
    weekStart: "2026-02-16",
    status: "new",
    meetingNeeded: true,
    priority: "low",
    dueDate: "2026-02-28",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "",
    stakeholders: ["Regional Sales Lead", "Mark Jansen"],
    details: { isRecurring: true, escalationLevel: "team_lead", relatedItemCode: "HJD00009" },
    updates: [{ type: "feedback", note: "Root cause identified and corrective action defined. (Mark Jansen, 2026-02-22)" }],
  },
  {
    id: "HJD00016",
    type: "challenge",
    title: "Cooler outages at petrol locations during peak hours",
    description: "Three high-traffic stations had intermittent cooler failures, causing warm products and missed impulse sales. Maintenance SLA review is required.",
    department: "Jumbo & Discounters",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Tom Bakker",
    createdAt: "2026-02-18",
    weekStart: "2026-02-16",
    status: "resolved",
    meetingNeeded: false,
    priority: "high",
    dueDate: "2026-03-03",
    resolvedBy: "Mark Jansen",
    resolvedAt: "2026-02-26",
    solution: "Supplier committed to four-week lead time for promo packaging; buffer ordered.",
    solutionTemplate: null,
    assignedTo: "Mark Jansen",
    stakeholders: ["Mark Jansen", "Emma Visser"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Best practice shared across channels. (Emma Visser, 2026-02-20)" }, { type: "solution_note", note: "Solution: Supplier committed to four-week lead time for promo packaging; buffer ordered...." }],
  },
  {
    id: "HJD00017",
    type: "celebration",
    title: "Improved on-time delivery KPI to 97 percent",
    description: "On-time delivery rate improved from 91 to 97 percent after introducing route optimization and early-morning dispatch windows.",
    department: "Trade Marketing",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Noah Kuiper",
    createdAt: "2026-02-19",
    weekStart: "2026-02-16",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "Tom Bakker",
    resolvedAt: "2026-03-05",
    solution: "Meeting agenda template enforced; maximum eight attendees with pre-read requirement.",
    solutionTemplate: null,
    assignedTo: "Tom Bakker",
    stakeholders: ["RGM Analyst", "Tom Bakker"],
    details: { milestoneType: "Volume growth", audienceNote: "Field teams and leadership" },
    updates: [{ type: "feedback", note: "Owner assigned, tracking weekly progress. (RGM Analyst, 2026-02-24)" }, { type: "solution_note", note: "Solution: Meeting agenda template enforced; maximum eight attendees with pre-read requirem..." }],
  },
  {
    id: "HJD00018",
    type: "contribution",
    title: "Shared improved forecasting model increasing accuracy",
    description: "Updated the demand forecasting model with event-driven variables, improving weekly accuracy from 72 to 85 percent for top 20 SKUs.",
    department: "Sales Operations",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Ruben Maas",
    createdAt: "2026-02-20",
    weekStart: "2026-02-16",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "Emma Visser",
    resolvedAt: "2026-03-03",
    solution: "Master data validation automated; manual fallback documented for edge cases.",
    solutionTemplate: null,
    assignedTo: "Emma Visser",
    stakeholders: ["Mark Jansen", "Emma Visser"],
    details: { topicTag: "Data", targetAudience: "RED participants" },
    updates: [{ type: "feedback", note: "Cross-functional task force assembled to address root cause. (Mark Jansen, 2026-02-22)" }, { type: "solution_note", note: "Solution: Master data validation automated; manual fallback documented for edge cases...." }],
  },
  {
    id: "HJD00019",
    type: "celebration",
    title: "Display compliance reached 96 percent in pilot cluster",
    description: "Pilot cluster achieved 96 percent display compliance after introducing a pre-weekend audit and explicit owner assignment.",
    department: "Field Sales South",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Mason Drent",
    createdAt: "2026-02-21",
    weekStart: "2026-02-16",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "RGM Analyst",
    resolvedAt: "2026-03-02",
    solution: "Implemented standardized correction flow with automated price verification at POS.",
    solutionTemplate: null,
    assignedTo: "RGM Analyst",
    stakeholders: ["Operations Lead", "RGM Analyst"],
    details: { milestoneType: "Service improvement", audienceNote: "Field teams and leadership" },
    updates: [{ type: "feedback", note: "Vendor contacted, awaiting SLA revision proposal. (Operations Lead, 2026-02-26)" }, { type: "solution_note", note: "Solution: Implemented standardized correction flow with automated price verification at PO..." }],
  },
  {
    id: "HJD00020",
    type: "contribution",
    title: "Provided benchmark analysis from AFH channel",
    description: "Delivered a cross-channel benchmark comparing AFH performance metrics with retail, identifying three areas for improvement in outlet coverage.",
    department: "Key Accounts Supermarkets",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Mila Janssen",
    createdAt: "2026-02-22",
    weekStart: "2026-02-16",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "Tom Bakker",
    resolvedAt: "2026-03-06",
    solution: "Wholesaler agreed to daily POS data feed via EDI; integrated into planning workflow.",
    solutionTemplate: null,
    assignedTo: "Tom Bakker",
    stakeholders: ["Operations Lead", "Tom Bakker"],
    details: { topicTag: "Data", targetAudience: "Cross-functional" },
    updates: [{ type: "feedback", note: "Best practice shared across channels. (Operations Lead, 2026-02-27)" }, { type: "solution_note", note: "Solution: Wholesaler agreed to daily POS data feed via EDI; integrated into planning workf..." }],
  },
  {
    id: "HJD00021",
    type: "challenge",
    title: "Cooler outages at petrol locations during peak hours",
    description: "Three high-traffic stations had intermittent cooler failures, causing warm products and missed impulse sales. Maintenance SLA review is required.",
    department: "Wholesalers",
    assignedToDept: "",
    meetingLevel: "regional_red",
    externalEmail: "",
    createdBy: "Yara Meinen",
    createdAt: "2026-02-23",
    weekStart: "2026-02-23",
    status: "resolved",
    meetingNeeded: false,
    priority: "high",
    dueDate: "2026-03-08",
    resolvedBy: "Sophie van Dijk",
    resolvedAt: "2026-03-10",
    solution: "SLA updated with vendor; penalty clause added for repeat failures. Monitoring active.",
    solutionTemplate: null,
    assignedTo: "Sophie van Dijk",
    stakeholders: ["Operations Lead", "Sophie van Dijk"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Monitoring ongoing, early improvements visible. (Operations Lead, 2026-02-26)" }, { type: "solution_note", note: "Solution: SLA updated with vendor; penalty clause added for repeat failures. Monitoring ac..." }],
  },
  {
    id: "HJD00022",
    type: "challenge",
    title: "Competitor exclusivity at checkout zone in two stores",
    description: "Two stores shifted checkout coolers to competitor-only placement, reducing Coca-Cola visibility during afternoon peak traffic.",
    department: "Sales Operations",
    assignedToDept: "Finance",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Ruben Maas",
    createdAt: "2026-02-24",
    weekStart: "2026-02-23",
    status: "assigned",
    meetingNeeded: true,
    priority: "high",
    dueDate: "2026-03-14",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Supply Planning",
    stakeholders: ["Supply Planning", "Tom Bakker"],
    details: { isRecurring: true, escalationLevel: "team_lead", relatedItemCode: "HJD00008" },
    updates: [{ type: "feedback", note: "Data analysis completed, presenting findings next Monday. (Tom Bakker, 2026-02-26)" }],
  },
  {
    id: "HJD00023",
    type: "celebration",
    title: "E-commerce conversion rate improved by 18 percent",
    description: "Optimized product imagery and description copy on quick-commerce platforms led to 18 percent conversion rate improvement over six weeks.",
    department: "Revenue Growth Management",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Supply Planning",
    createdAt: "2026-02-25",
    weekStart: "2026-02-23",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "Sophie van Dijk",
    resolvedAt: "2026-03-08",
    solution: "Asset pipeline audit completed; dedicated content QA step added before publication.",
    solutionTemplate: null,
    assignedTo: "Sophie van Dijk",
    stakeholders: ["RGM Analyst", "Sophie van Dijk"],
    details: { milestoneType: "Customer retention", audienceNote: "Field teams and leadership" },
    updates: [{ type: "feedback", note: "Root cause identified and corrective action defined. (RGM Analyst, 2026-02-27)" }, { type: "solution_note", note: "Solution: Asset pipeline audit completed; dedicated content QA step added before publicati..." }],
  },
  {
    id: "HJD00024",
    type: "challenge",
    title: "Late depot departure affecting first-wave store visits",
    description: "Monday route departures from one depot shifted by 45 minutes for two consecutive weeks, reducing execution time in top-priority stores.",
    department: "Field Sales South",
    assignedToDept: "",
    meetingLevel: "regional_red",
    externalEmail: "",
    createdBy: "Lotte Willems",
    createdAt: "2026-02-26",
    weekStart: "2026-02-23",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "2026-03-15",
    resolvedBy: "Supply Planning",
    resolvedAt: "2026-03-13",
    solution: "Safety stock parameters updated for weekend windows; automated low-stock alerts active.",
    solutionTemplate: null,
    assignedTo: "Supply Planning",
    stakeholders: ["Supply Planning"],
    details: { isRecurring: true, escalationLevel: "team_lead", relatedItemCode: "HJD00019" },
    updates: [{ type: "feedback", note: "Vendor contacted, awaiting SLA revision proposal. (Supply Planning, 2026-03-02)" }, { type: "solution_note", note: "Solution: Safety stock parameters updated for weekend windows; automated low-stock alerts ..." }],
  },
  {
    id: "HJD00025",
    type: "celebration",
    title: "Complaint rate reduced after process optimization",
    description: "Customer complaint rate dropped by 22 percent in the south region following implementation of improved delivery notification workflow.",
    department: "Convenience & Petrol",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Finn Koopman",
    createdAt: "2026-02-27",
    weekStart: "2026-02-23",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "David Meijer",
    resolvedAt: "2026-03-06",
    solution: "Knowledge base created in dashboard archive with tagging and similarity search.",
    solutionTemplate: null,
    assignedTo: "David Meijer",
    stakeholders: ["David Meijer", "Emma Visser"],
    details: { milestoneType: "Execution KPI", audienceNote: "Convenience & Petrol" },
    updates: [{ type: "feedback", note: "Data analysis completed, presenting findings next Monday. (Emma Visser, 2026-03-03)" }, { type: "solution_note", note: "Solution: Knowledge base created in dashboard archive with tagging and similarity search...." }],
  },
  {
    id: "HJD00026",
    type: "challenge",
    title: "Display compliance below target in discounter cluster",
    description: "Secondary display compliance dropped to 68 percent in a key discounter cluster. Root cause appears to be missing POS kit handover and unclear ownership.",
    department: "Trade Marketing",
    assignedToDept: "Finance",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Operations Lead",
    createdAt: "2026-02-28",
    weekStart: "2026-02-23",
    status: "assigned",
    meetingNeeded: true,
    priority: "high",
    dueDate: "2026-03-12",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "David Meijer",
    stakeholders: ["David Meijer"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Data analysis completed, presenting findings next Monday. (David Meijer, 2026-03-02)" }],
  },
  {
    id: "HJD00027",
    type: "contribution",
    title: "Store visit script for faster issue triage",
    description: "Shared a 6-question script for sales reps to classify issues in-store within five minutes and route them to the right function the same day.",
    department: "E-commerce Sales",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Owen van Dijk",
    createdAt: "2026-03-01",
    weekStart: "2026-02-23",
    status: "closed",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "Operations Lead",
    resolvedAt: "2026-03-18",
    solution: "Master data validation automated; manual fallback documented for edge cases.",
    solutionTemplate: null,
    assignedTo: "Operations Lead",
    stakeholders: ["Operations Lead"],
    details: { topicTag: "Governance", targetAudience: "E-commerce Sales" },
    updates: [{ type: "feedback", note: "Owner assigned, tracking weekly progress. (Operations Lead, 2026-03-05)" }, { type: "solution_note", note: "Solution: Master data validation automated; manual fallback documented for edge cases...." }],
  },
  {
    id: "HJD00028",
    type: "celebration",
    title: "Successful promotion campaign with double digit uplift",
    description: "Summer campaign for Zero Sugar multipack delivered 14 percent volume uplift and 8 percent value share gain in participating stores.",
    department: "Convenience & Petrol",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Finn Koopman",
    createdAt: "2026-03-02",
    weekStart: "2026-03-02",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "Emma Visser",
    resolvedAt: "2026-03-19",
    solution: "Transport capacity contract renegotiated with backup carrier on standby.",
    solutionTemplate: null,
    assignedTo: "Emma Visser",
    stakeholders: ["IT Support", "Emma Visser"],
    details: { milestoneType: "Volume growth", audienceNote: "Field teams and leadership" },
    updates: [{ type: "feedback", note: "Monitoring ongoing, early improvements visible. (IT Support, 2026-03-07)" }, { type: "solution_note", note: "Solution: Transport capacity contract renegotiated with backup carrier on standby...." }],
  },
  {
    id: "HJD00029",
    type: "challenge",
    title: "Delayed delivery to warehouse due to transport capacity shortage",
    description: "Recurring transport capacity issues are delaying warehouse deliveries by one to two days, impacting store replenishment for high-rotation SKUs.",
    department: "Trade Marketing",
    assignedToDept: "HR",
    meetingLevel: "regional_red",
    externalEmail: "",
    createdBy: "Noah Kuiper",
    createdAt: "2026-03-03",
    weekStart: "2026-03-02",
    status: "escalated",
    meetingNeeded: true,
    priority: "medium",
    dueDate: "2026-03-15",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Sophie van Dijk",
    stakeholders: ["Operations Lead", "Sophie van Dijk"],
    details: { isRecurring: false, escalationLevel: "senior_leadership", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Root cause identified and corrective action defined. (Operations Lead, 2026-03-08)" }, { type: "status_change", note: "Escalated for structural resolution." }],
  },
  {
    id: "HJD00030",
    type: "celebration",
    title: "Improved on-time delivery KPI to 97 percent",
    description: "On-time delivery rate improved from 91 to 97 percent after introducing route optimization and early-morning dispatch windows.",
    department: "Key Accounts Supermarkets",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Kai van Ommen",
    createdAt: "2026-03-04",
    weekStart: "2026-03-02",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "Tom Bakker",
    resolvedAt: "2026-03-20",
    solution: "Joint business plan presented to buyer; shared cooler agreement renewed for 12 months.",
    solutionTemplate: null,
    assignedTo: "Tom Bakker",
    stakeholders: ["IT Support", "Tom Bakker"],
    details: { milestoneType: "Execution KPI", audienceNote: "Field teams and leadership" },
    updates: [{ type: "feedback", note: "Monitoring ongoing, early improvements visible. (IT Support, 2026-03-06)" }, { type: "solution_note", note: "Solution: Joint business plan presented to buyer; shared cooler agreement renewed for 12 m..." }],
  },
  {
    id: "HJD00031",
    type: "challenge",
    title: "New product listing delay due to master data backlog",
    description: "Three new SKU listings are stuck in master data processing for over two weeks, delaying availability on retailer online platforms.",
    department: "E-commerce Sales",
    assignedToDept: "",
    meetingLevel: "leadership_sync",
    externalEmail: "",
    createdBy: "Jade Mulder",
    createdAt: "2026-03-05",
    weekStart: "2026-03-02",
    status: "new",
    meetingNeeded: true,
    priority: "high",
    dueDate: "2026-03-19",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "",
    stakeholders: ["Mark Jansen", "Laura de Vries"],
    details: { isRecurring: true, escalationLevel: "team_lead", relatedItemCode: "HJD00002" },
    updates: [{ type: "feedback", note: "Root cause identified and corrective action defined. (Laura de Vries, 2026-03-08)" }],
  },
  {
    id: "HJD00032",
    type: "challenge",
    title: "Planogram compliance audit shows 58 percent adherence",
    description: "Latest audit reveals only 58 percent planogram compliance in the north region. Main issues are shelf-space allocation and facing direction.",
    department: "Sales Operations",
    assignedToDept: "HR",
    meetingLevel: "regional_red",
    externalEmail: "",
    createdBy: "Laura de Vries",
    createdAt: "2026-03-06",
    weekStart: "2026-03-02",
    status: "escalated",
    meetingNeeded: true,
    priority: "high",
    dueDate: "2026-03-19",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "David Meijer",
    stakeholders: ["Supply Planning", "David Meijer"],
    details: { isRecurring: true, escalationLevel: "senior_leadership", relatedItemCode: "HJD00009" },
    updates: [{ type: "feedback", note: "Owner assigned, tracking weekly progress. (Supply Planning, 2026-03-10)" }, { type: "status_change", note: "Escalated for structural resolution." }],
  },
  {
    id: "HJD00033",
    type: "challenge",
    title: "Quick-commerce product photo quality still inconsistent",
    description: "Hero image quality for key SKUs is inconsistent across quick-commerce apps, lowering conversion during campaigns and creating repetitive manual fixes.",
    department: "Trade Marketing",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Operations Lead",
    createdAt: "2026-03-07",
    weekStart: "2026-03-02",
    status: "new",
    meetingNeeded: true,
    priority: "medium",
    dueDate: "2026-03-17",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "",
    stakeholders: ["Regional Sales Lead", "Supply Planning"],
    details: { isRecurring: true, escalationLevel: "team_lead", relatedItemCode: "HJD00003" },
    updates: [{ type: "feedback", note: "Pilot initiated in two regions for validation. (Supply Planning, 2026-03-11)" }],
  },
  {
    id: "HJD00034",
    type: "celebration",
    title: "Display compliance reached 96 percent in pilot cluster",
    description: "Pilot cluster achieved 96 percent display compliance after introducing a pre-weekend audit and explicit owner assignment.",
    department: "E-commerce Sales",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Jade Mulder",
    createdAt: "2026-03-08",
    weekStart: "2026-03-02",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "Operations Lead",
    resolvedAt: "2026-03-24",
    solution: "Implemented standardized correction flow with automated price verification at POS.",
    solutionTemplate: null,
    assignedTo: "Operations Lead",
    stakeholders: ["Operations Lead", "David Meijer"],
    details: { milestoneType: "Service improvement", audienceNote: "Field teams and leadership" },
    updates: [{ type: "feedback", note: "Pilot initiated in two regions for validation. (David Meijer, 2026-03-13)" }, { type: "solution_note", note: "Solution: Implemented standardized correction flow with automated price verification at PO..." }],
  },
  {
    id: "HJD00035",
    type: "challenge",
    title: "Planogram compliance audit shows 58 percent adherence",
    description: "Latest audit reveals only 58 percent planogram compliance in the north region. Main issues are shelf-space allocation and facing direction.",
    department: "Trade Marketing",
    assignedToDept: "Supply Chain",
    meetingLevel: "national_red",
    externalEmail: "",
    createdBy: "Noah Kuiper",
    createdAt: "2026-03-09",
    weekStart: "2026-03-09",
    status: "escalated",
    meetingNeeded: true,
    priority: "low",
    dueDate: "2026-03-25",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Supply Planning",
    stakeholders: ["Supply Planning", "RGM Analyst"],
    details: { isRecurring: false, escalationLevel: "senior_leadership", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Best practice shared across channels. (RGM Analyst, 2026-03-13)" }, { type: "status_change", note: "Escalated to higher meeting for structural resolution." }],
  },
  {
    id: "HJD00036",
    type: "celebration",
    title: "Successful promotion campaign with double digit uplift",
    description: "Summer campaign for Zero Sugar multipack delivered 14 percent volume uplift and 8 percent value share gain in participating stores.",
    department: "Convenience & Petrol",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Iris de Graaf",
    createdAt: "2026-03-10",
    weekStart: "2026-03-09",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "Tom Bakker",
    resolvedAt: "2026-03-26",
    solution: "Seasonal event calendar integrated into forecast model; regional adjustments automated.",
    solutionTemplate: null,
    assignedTo: "Tom Bakker",
    stakeholders: ["RGM Analyst", "Tom Bakker"],
    details: { milestoneType: "Execution KPI", audienceNote: "Convenience & Petrol" },
    updates: [{ type: "feedback", note: "Escalated and temporary solution implemented. (RGM Analyst, 2026-03-14)" }, { type: "solution_note", note: "Solution: Seasonal event calendar integrated into forecast model; regional adjustments aut..." }],
  },
  {
    id: "HJD00037",
    type: "challenge",
    title: "Multiple stakeholders attending RED causing longer discussions",
    description: "RED meetings are running 30 minutes over schedule because too many stakeholders attend without clear agenda ownership.",
    department: "Convenience & Petrol",
    assignedToDept: "IT",
    meetingLevel: "regional_red",
    externalEmail: "",
    createdBy: "Iris de Graaf",
    createdAt: "2026-03-11",
    weekStart: "2026-03-09",
    status: "assigned",
    meetingNeeded: true,
    priority: "high",
    dueDate: "2026-03-25",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Sophie van Dijk",
    stakeholders: ["RGM Analyst", "Sophie van Dijk"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Cross-functional task force assembled to address root cause. (RGM Analyst, 2026-03-13)" }],
  },
  {
    id: "HJD00038",
    type: "challenge",
    title: "Late depot departure affecting first-wave store visits",
    description: "Monday route departures from one depot shifted by 45 minutes for two consecutive weeks, reducing execution time in top-priority stores.",
    department: "Sales Operations",
    assignedToDept: "Finance",
    meetingLevel: "national_red",
    externalEmail: "",
    createdBy: "Ruben Maas",
    createdAt: "2026-03-12",
    weekStart: "2026-03-09",
    status: "assigned",
    meetingNeeded: true,
    priority: "medium",
    dueDate: "2026-04-02",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Mark Jansen",
    stakeholders: ["Supply Planning", "Mark Jansen"],
    details: { isRecurring: true, escalationLevel: "team_lead", relatedItemCode: "HJD00022" },
    updates: [{ type: "feedback", note: "Best practice shared across channels. (Supply Planning, 2026-03-17)" }],
  },
  {
    id: "HJD00039",
    type: "challenge",
    title: "Promotion execution delay due to supply constraints",
    description: "Planned promotion for energy drinks was delayed by two weeks because the supplier could not confirm delivery of promotional packaging.",
    department: "Key Accounts Supermarkets",
    assignedToDept: "",
    meetingLevel: "leadership_sync",
    externalEmail: "",
    createdBy: "Mila Janssen",
    createdAt: "2026-03-13",
    weekStart: "2026-03-09",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "2026-03-23",
    resolvedBy: "Laura de Vries",
    resolvedAt: "2026-03-21",
    solution: "POS delivery calendar synchronized with promotion calendar; two-week lead enforced.",
    solutionTemplate: null,
    assignedTo: "Laura de Vries",
    stakeholders: ["Supply Planning", "Laura de Vries"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Pilot initiated in two regions for validation. (Supply Planning, 2026-03-15)" }, { type: "solution_note", note: "Solution: POS delivery calendar synchronized with promotion calendar; two-week lead enforc..." }],
  },
  {
    id: "HJD00040",
    type: "challenge",
    title: "New product listing delay due to master data backlog",
    description: "Three new SKU listings are stuck in master data processing for over two weeks, delaying availability on retailer online platforms.",
    department: "Wholesalers",
    assignedToDept: "",
    meetingLevel: "leadership_sync",
    externalEmail: "",
    createdBy: "Yara Meinen",
    createdAt: "2026-03-14",
    weekStart: "2026-03-09",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "2026-03-27",
    resolvedBy: "Mark Jansen",
    resolvedAt: "2026-03-29",
    solution: "Knowledge base created in dashboard archive with tagging and similarity search.",
    solutionTemplate: null,
    assignedTo: "Mark Jansen",
    stakeholders: ["Mark Jansen", "Tom Bakker"],
    details: { isRecurring: true, escalationLevel: "team_lead", relatedItemCode: "HJD00007" },
    updates: [{ type: "feedback", note: "Escalated and temporary solution implemented. (Tom Bakker, 2026-03-19)" }, { type: "solution_note", note: "Solution: Knowledge base created in dashboard archive with tagging and similarity search...." }],
  },
  {
    id: "HJD00041",
    type: "contribution",
    title: "Optimized reporting template for faster review",
    description: "Redesigned the weekly RED reporting template to cut preparation time from 90 to 30 minutes while adding automated trend indicators.",
    department: "Jumbo & Discounters",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "David Meijer",
    createdAt: "2026-03-15",
    weekStart: "2026-03-09",
    status: "assigned",
    meetingNeeded: true,
    priority: "low",
    dueDate: "",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Laura de Vries",
    stakeholders: ["Laura de Vries", "Emma Visser"],
    details: { topicTag: "Governance", targetAudience: "Cross-functional" },
    updates: [{ type: "feedback", note: "Escalated and temporary solution implemented. (Emma Visser, 2026-03-18)" }],
  },
  {
    id: "HJD00042",
    type: "celebration",
    title: "Strong cross-functional collaboration achieved on launch",
    description: "New product launch was executed flawlessly across all channels thanks to aligned planning between trade marketing, supply chain and field sales.",
    department: "Sales Operations",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Laura de Vries",
    createdAt: "2026-03-16",
    weekStart: "2026-03-16",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "Supply Planning",
    resolvedAt: "2026-03-27",
    solution: "Accrual validation template distributed; monthly reconciliation meeting scheduled.",
    solutionTemplate: null,
    assignedTo: "Supply Planning",
    stakeholders: ["Supply Planning", "Laura de Vries"],
    details: { milestoneType: "Execution KPI", audienceNote: "Sales Operations" },
    updates: [{ type: "feedback", note: "Best practice shared across channels. (Laura de Vries, 2026-03-20)" }, { type: "solution_note", note: "Solution: Accrual validation template distributed; monthly reconciliation meeting schedule..." }],
  },
  {
    id: "HJD00043",
    type: "challenge",
    title: "Recurring stock-out issue in regional warehouse",
    description: "Regional warehouse faces weekly stock-outs on three core SKUs due to forecast lag and minimum order quantity constraints with suppliers.",
    department: "E-commerce Sales",
    assignedToDept: "IT",
    meetingLevel: "national_red",
    externalEmail: "",
    createdBy: "Jade Mulder",
    createdAt: "2026-03-17",
    weekStart: "2026-03-16",
    status: "assigned",
    meetingNeeded: true,
    priority: "medium",
    dueDate: "2026-03-29",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Supply Planning",
    stakeholders: ["Supply Planning", "Mark Jansen"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Pilot initiated in two regions for validation. (Mark Jansen, 2026-03-19)" }],
  },
  {
    id: "HJD00044",
    type: "challenge",
    title: "Multiple stakeholders attending RED causing longer discussions",
    description: "RED meetings are running 30 minutes over schedule because too many stakeholders attend without clear agenda ownership.",
    department: "E-commerce Sales",
    assignedToDept: "IT",
    meetingLevel: "regional_red",
    externalEmail: "",
    createdBy: "Jade Mulder",
    createdAt: "2026-03-18",
    weekStart: "2026-03-16",
    status: "escalated",
    meetingNeeded: true,
    priority: "medium",
    dueDate: "2026-03-28",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Operations Lead",
    stakeholders: ["Operations Lead", "Regional Sales Lead"],
    details: { isRecurring: false, escalationLevel: "senior_leadership", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Data analysis completed, presenting findings next Monday. (Regional Sales Lead, 2026-03-23)" }, { type: "status_change", note: "Escalated for structural resolution." }],
  },
  {
    id: "HJD00045",
    type: "celebration",
    title: "Improved on-time delivery KPI to 97 percent",
    description: "On-time delivery rate improved from 91 to 97 percent after introducing route optimization and early-morning dispatch windows.",
    department: "Sales Operations",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Ruben Maas",
    createdAt: "2026-03-19",
    weekStart: "2026-03-16",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "Tom Bakker",
    resolvedAt: "2026-04-01",
    solution: "Implemented standardized correction flow with automated price verification at POS.",
    solutionTemplate: null,
    assignedTo: "Tom Bakker",
    stakeholders: ["David Meijer", "Tom Bakker"],
    details: { milestoneType: "Promo effectiveness", audienceNote: "Field teams and leadership" },
    updates: [{ type: "feedback", note: "Cross-functional task force assembled to address root cause. (David Meijer, 2026-03-23)" }, { type: "solution_note", note: "Solution: Implemented standardized correction flow with automated price verification at PO..." }],
  },
  {
    id: "HJD00046",
    type: "celebration",
    title: "E-commerce conversion rate improved by 18 percent",
    description: "Optimized product imagery and description copy on quick-commerce platforms led to 18 percent conversion rate improvement over six weeks.",
    department: "E-commerce Sales",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Jade Mulder",
    createdAt: "2026-03-20",
    weekStart: "2026-03-16",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "RGM Analyst",
    resolvedAt: "2026-04-05",
    solution: "Route schedule adjusted and validated. Departure checklist introduced at depot.",
    solutionTemplate: null,
    assignedTo: "RGM Analyst",
    stakeholders: ["Regional Sales Lead", "RGM Analyst"],
    details: { milestoneType: "Promo effectiveness", audienceNote: "Cross-functional teams" },
    updates: [{ type: "feedback", note: "Monitoring ongoing, early improvements visible. (Regional Sales Lead, 2026-03-23)" }, { type: "solution_note", note: "Solution: Route schedule adjusted and validated. Departure checklist introduced at depot...." }],
  },
  {
    id: "HJD00047",
    type: "challenge",
    title: "Recurring stock-out issue in regional warehouse",
    description: "Regional warehouse faces weekly stock-outs on three core SKUs due to forecast lag and minimum order quantity constraints with suppliers.",
    department: "Wholesalers",
    assignedToDept: "",
    meetingLevel: "regional_red",
    externalEmail: "",
    createdBy: "Liam Noor",
    createdAt: "2026-03-21",
    weekStart: "2026-03-16",
    status: "in_discussion",
    meetingNeeded: true,
    priority: "high",
    dueDate: "2026-04-02",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Tom Bakker",
    stakeholders: ["Sophie van Dijk", "Tom Bakker"],
    details: { isRecurring: true, escalationLevel: "team_lead", relatedItemCode: "HJD00021" },
    updates: [{ type: "feedback", note: "Best practice shared across channels. (Sophie van Dijk, 2026-03-26)" }],
  },
  {
    id: "HJD00048",
    type: "contribution",
    title: "Shared improved forecasting model increasing accuracy",
    description: "Updated the demand forecasting model with event-driven variables, improving weekly accuracy from 72 to 85 percent for top 20 SKUs.",
    department: "Field Sales North",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Sara van Lee",
    createdAt: "2026-03-22",
    weekStart: "2026-03-16",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "Mark Jansen",
    resolvedAt: "2026-04-05",
    solution: "Implemented standardized correction flow with automated price verification at POS.",
    solutionTemplate: null,
    assignedTo: "Mark Jansen",
    stakeholders: ["Operations Lead", "Mark Jansen"],
    details: { topicTag: "Process", targetAudience: "All field sales reps" },
    updates: [{ type: "feedback", note: "Root cause identified and corrective action defined. (Operations Lead, 2026-03-24)" }, { type: "solution_note", note: "Solution: Implemented standardized correction flow with automated price verification at PO..." }],
  },
  {
    id: "HJD00049",
    type: "celebration",
    title: "E-commerce conversion rate improved by 18 percent",
    description: "Optimized product imagery and description copy on quick-commerce platforms led to 18 percent conversion rate improvement over six weeks.",
    department: "Field Sales South",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Daan Peeters",
    createdAt: "2026-03-23",
    weekStart: "2026-03-23",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "Sophie van Dijk",
    resolvedAt: "2026-04-07",
    solution: "Seasonal event calendar integrated into forecast model; regional adjustments automated.",
    solutionTemplate: null,
    assignedTo: "Sophie van Dijk",
    stakeholders: ["Sophie van Dijk", "David Meijer"],
    details: { milestoneType: "Promo effectiveness", audienceNote: "Cross-functional teams" },
    updates: [{ type: "feedback", note: "Escalated and temporary solution implemented. (David Meijer, 2026-03-26)" }, { type: "solution_note", note: "Solution: Seasonal event calendar integrated into forecast model; regional adjustments aut..." }],
  },
  {
    id: "HJD00050",
    type: "contribution",
    title: "Shared best practice from previous campaign execution",
    description: "Documented step-by-step approach from last quarter successful multipack campaign, including timing, allocation and in-store execution checklist.",
    department: "Field Sales North",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Nina Vos",
    createdAt: "2026-03-24",
    weekStart: "2026-03-23",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "Regional Sales Lead",
    resolvedAt: "2026-04-11",
    solution: "POS kit handover process redesigned with explicit ownership and sign-off.",
    solutionTemplate: null,
    assignedTo: "Regional Sales Lead",
    stakeholders: ["Regional Sales Lead", "Supply Planning"],
    details: { topicTag: "Governance", targetAudience: "RED participants" },
    updates: [{ type: "feedback", note: "Root cause identified and corrective action defined. (Supply Planning, 2026-03-28)" }, { type: "solution_note", note: "Solution: POS kit handover process redesigned with explicit ownership and sign-off...." }],
  },
  {
    id: "HJD00051",
    type: "contribution",
    title: "Built automated stock alert for high-rotation SKUs",
    description: "Developed an automated email alert triggered when safety stock for top-10 SKUs drops below threshold at regional warehouse level.",
    department: "Convenience & Petrol",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Finn Koopman",
    createdAt: "2026-03-25",
    weekStart: "2026-03-23",
    status: "assigned",
    meetingNeeded: true,
    priority: "low",
    dueDate: "",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Tom Bakker",
    stakeholders: ["Operations Lead", "Tom Bakker"],
    details: { topicTag: "Process", targetAudience: "Convenience & Petrol" },
    updates: [{ type: "feedback", note: "Cross-functional task force assembled to address root cause. (Operations Lead, 2026-03-27)" }],
  },
  {
    id: "HJD00052",
    type: "celebration",
    title: "Positive customer feedback received for service improvement",
    description: "Two key accounts provided written positive feedback praising improved service responsiveness and proactive issue resolution by field team.",
    department: "Field Sales North",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Sara van Lee",
    createdAt: "2026-03-26",
    weekStart: "2026-03-23",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "RGM Analyst",
    resolvedAt: "2026-04-10",
    solution: "Seasonal event calendar integrated into forecast model; regional adjustments automated.",
    solutionTemplate: null,
    assignedTo: "RGM Analyst",
    stakeholders: ["RGM Analyst", "Emma Visser"],
    details: { milestoneType: "Promo effectiveness", audienceNote: "Field teams and leadership" },
    updates: [{ type: "feedback", note: "Best practice shared across channels. (Emma Visser, 2026-03-30)" }, { type: "solution_note", note: "Solution: Seasonal event calendar integrated into forecast model; regional adjustments aut..." }],
  },
  {
    id: "HJD00053",
    type: "contribution",
    title: "Shared improved forecasting model increasing accuracy",
    description: "Updated the demand forecasting model with event-driven variables, improving weekly accuracy from 72 to 85 percent for top 20 SKUs.",
    department: "Sales Operations",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Laura de Vries",
    createdAt: "2026-03-27",
    weekStart: "2026-03-23",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "Mark Jansen",
    resolvedAt: "2026-04-13",
    solution: "POS delivery calendar synchronized with promotion calendar; two-week lead enforced.",
    solutionTemplate: null,
    assignedTo: "Mark Jansen",
    stakeholders: ["Mark Jansen", "Laura de Vries"],
    details: { topicTag: "Process", targetAudience: "Sales Operations" },
    updates: [{ type: "feedback", note: "Cross-functional task force assembled to address root cause. (Laura de Vries, 2026-04-01)" }, { type: "solution_note", note: "Solution: POS delivery calendar synchronized with promotion calendar; two-week lead enforc..." }],
  },
  {
    id: "HJD00054",
    type: "celebration",
    title: "Win-back of previously inactive wholesaler account",
    description: "A previously inactive wholesaler resumed weekly ordering after a joint commercial plan and improved service-level communication.",
    department: "Wholesalers",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Yara Meinen",
    createdAt: "2026-03-28",
    weekStart: "2026-03-23",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "Sophie van Dijk",
    resolvedAt: "2026-04-13",
    solution: "Seasonal event calendar integrated into forecast model; regional adjustments automated.",
    solutionTemplate: null,
    assignedTo: "Sophie van Dijk",
    stakeholders: ["Sophie van Dijk", "David Meijer"],
    details: { milestoneType: "Execution KPI", audienceNote: "Wholesalers" },
    updates: [{ type: "feedback", note: "Best practice shared across channels. (David Meijer, 2026-03-30)" }, { type: "solution_note", note: "Solution: Seasonal event calendar integrated into forecast model; regional adjustments aut..." }],
  },
  {
    id: "HJD00055",
    type: "challenge",
    title: "Multiple stakeholders attending RED causing longer discussions",
    description: "RED meetings are running 30 minutes over schedule because too many stakeholders attend without clear agenda ownership.",
    department: "Convenience & Petrol",
    assignedToDept: "IT",
    meetingLevel: "leadership_sync",
    externalEmail: "",
    createdBy: "Finn Koopman",
    createdAt: "2026-03-29",
    weekStart: "2026-03-23",
    status: "assigned",
    meetingNeeded: true,
    priority: "low",
    dueDate: "2026-04-09",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Laura de Vries",
    stakeholders: ["Mark Jansen", "Laura de Vries"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Cross-functional task force assembled to address root cause. (Mark Jansen, 2026-04-01)" }],
  },
  {
    id: "HJD00056",
    type: "contribution",
    title: "Escalation template for recurring store-level blockers",
    description: "Shared a compact escalation template with impact score, owner and due date fields to reduce open-loop discussions in Monday RED meetings.",
    department: "Jumbo & Discounters",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Tom Bakker",
    createdAt: "2026-03-30",
    weekStart: "2026-03-30",
    status: "assigned",
    meetingNeeded: true,
    priority: "low",
    dueDate: "",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Emma Visser",
    stakeholders: ["Laura de Vries", "Emma Visser"],
    details: { topicTag: "Execution", targetAudience: "Jumbo & Discounters" },
    updates: [{ type: "feedback", note: "Vendor contacted, awaiting SLA revision proposal. (Laura de Vries, 2026-04-03)" }],
  },
  {
    id: "HJD00057",
    type: "celebration",
    title: "Strong cross-functional collaboration achieved on launch",
    description: "New product launch was executed flawlessly across all channels thanks to aligned planning between trade marketing, supply chain and field sales.",
    department: "E-commerce Sales",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Jade Mulder",
    createdAt: "2026-03-31",
    weekStart: "2026-03-30",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "Mark Jansen",
    resolvedAt: "2026-04-18",
    solution: "POS kit handover process redesigned with explicit ownership and sign-off.",
    solutionTemplate: null,
    assignedTo: "Mark Jansen",
    stakeholders: ["Supply Planning", "Mark Jansen"],
    details: { milestoneType: "Customer retention", audienceNote: "Field teams and leadership" },
    updates: [{ type: "feedback", note: "Owner assigned, tracking weekly progress. (Supply Planning, 2026-04-04)" }, { type: "solution_note", note: "Solution: POS kit handover process redesigned with explicit ownership and sign-off...." }],
  },
  {
    id: "HJD00058",
    type: "celebration",
    title: "Strong cross-functional collaboration achieved on launch",
    description: "New product launch was executed flawlessly across all channels thanks to aligned planning between trade marketing, supply chain and field sales.",
    department: "Trade Marketing",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Noah Kuiper",
    createdAt: "2026-04-01",
    weekStart: "2026-03-30",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "Mark Jansen",
    resolvedAt: "2026-04-11",
    solution: "Joint business plan presented to buyer; shared cooler agreement renewed for 12 months.",
    solutionTemplate: null,
    assignedTo: "Mark Jansen",
    stakeholders: ["Mark Jansen", "David Meijer"],
    details: { milestoneType: "Volume growth", audienceNote: "Field teams and leadership" },
    updates: [{ type: "feedback", note: "Owner assigned, tracking weekly progress. (David Meijer, 2026-04-04)" }, { type: "solution_note", note: "Solution: Joint business plan presented to buyer; shared cooler agreement renewed for 12 m..." }],
  },
  {
    id: "HJD00059",
    type: "challenge",
    title: "Cooler outages at petrol locations during peak hours",
    description: "Three high-traffic stations had intermittent cooler failures, causing warm products and missed impulse sales. Maintenance SLA review is required.",
    department: "Jumbo & Discounters",
    assignedToDept: "Legal",
    meetingLevel: "national_red",
    externalEmail: "",
    createdBy: "David Meijer",
    createdAt: "2026-04-02",
    weekStart: "2026-03-30",
    status: "assigned",
    meetingNeeded: true,
    priority: "medium",
    dueDate: "2026-04-16",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "RGM Analyst",
    stakeholders: ["RGM Analyst", "IT Support"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Cross-functional task force assembled to address root cause. (IT Support, 2026-04-05)" }],
  },
  {
    id: "HJD00060",
    type: "contribution",
    title: "Shared improved forecasting model increasing accuracy",
    description: "Updated the demand forecasting model with event-driven variables, improving weekly accuracy from 72 to 85 percent for top 20 SKUs.",
    department: "Jumbo & Discounters",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "David Meijer",
    createdAt: "2026-04-03",
    weekStart: "2026-03-30",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "Supply Planning",
    resolvedAt: "2026-04-17",
    solution: "Min order quantities renegotiated; buffer stock policy updated for core SKUs.",
    solutionTemplate: null,
    assignedTo: "Supply Planning",
    stakeholders: ["Supply Planning", "Laura de Vries"],
    details: { topicTag: "Process", targetAudience: "Jumbo & Discounters" },
    updates: [{ type: "feedback", note: "Added to monthly performance dashboard. (Laura de Vries, 2026-04-07)" }, { type: "solution_note", note: "Solution: Min order quantities renegotiated; buffer stock policy updated for core SKUs...." }],
  },
  {
    id: "HJD00061",
    type: "celebration",
    title: "Strong cross-functional collaboration achieved on launch",
    description: "New product launch was executed flawlessly across all channels thanks to aligned planning between trade marketing, supply chain and field sales.",
    department: "Field Sales North",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Alex Vermeer",
    createdAt: "2026-04-04",
    weekStart: "2026-03-30",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "Tom Bakker",
    resolvedAt: "2026-04-19",
    solution: "Seasonal event calendar integrated into forecast model; regional adjustments automated.",
    solutionTemplate: null,
    assignedTo: "Tom Bakker",
    stakeholders: ["Tom Bakker", "Emma Visser"],
    details: { milestoneType: "Execution KPI", audienceNote: "Field teams and leadership" },
    updates: [{ type: "feedback", note: "Data analysis completed, presenting findings next Monday. (Emma Visser, 2026-04-07)" }, { type: "solution_note", note: "Solution: Seasonal event calendar integrated into forecast model; regional adjustments aut..." }],
  },
  {
    id: "HJD00062",
    type: "celebration",
    title: "Strong cross-functional collaboration achieved on launch",
    description: "New product launch was executed flawlessly across all channels thanks to aligned planning between trade marketing, supply chain and field sales.",
    department: "Key Accounts Supermarkets",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Kai van Ommen",
    createdAt: "2026-04-05",
    weekStart: "2026-03-30",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "Operations Lead",
    resolvedAt: "2026-04-16",
    solution: "POS kit handover process redesigned with explicit ownership and sign-off.",
    solutionTemplate: null,
    assignedTo: "Operations Lead",
    stakeholders: ["Operations Lead", "Regional Sales Lead"],
    details: { milestoneType: "Customer retention", audienceNote: "Cross-functional teams" },
    updates: [{ type: "feedback", note: "Data analysis completed, presenting findings next Monday. (Regional Sales Lead, 2026-04-10)" }, { type: "solution_note", note: "Solution: POS kit handover process redesigned with explicit ownership and sign-off...." }],
  },
  {
    id: "HJD00063",
    type: "challenge",
    title: "Customer complaint rate increased after route change",
    description: "After rerouting field sales visits in the east region, customer complaint rate rose by 15 percent due to missed service windows.",
    department: "Key Accounts Supermarkets",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Eva Broek",
    createdAt: "2026-04-06",
    weekStart: "2026-04-06",
    status: "in_discussion",
    meetingNeeded: true,
    priority: "medium",
    dueDate: "2026-04-18",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Regional Sales Lead",
    stakeholders: ["Regional Sales Lead", "Laura de Vries"],
    details: { isRecurring: true, escalationLevel: "team_lead", relatedItemCode: "HJD00027" },
    updates: [{ type: "feedback", note: "Cross-functional task force assembled to address root cause. (Laura de Vries, 2026-04-08)" }],
  },
  {
    id: "HJD00064",
    type: "celebration",
    title: "Display compliance reached 96 percent in pilot cluster",
    description: "Pilot cluster achieved 96 percent display compliance after introducing a pre-weekend audit and explicit owner assignment.",
    department: "Key Accounts Supermarkets",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Eva Broek",
    createdAt: "2026-04-07",
    weekStart: "2026-04-06",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "RGM Analyst",
    resolvedAt: "2026-04-15",
    solution: "Meeting agenda template enforced; maximum eight attendees with pre-read requirement.",
    solutionTemplate: null,
    assignedTo: "RGM Analyst",
    stakeholders: ["Regional Sales Lead", "RGM Analyst"],
    details: { milestoneType: "Customer retention", audienceNote: "Cross-functional teams" },
    updates: [{ type: "feedback", note: "Root cause identified and corrective action defined. (Regional Sales Lead, 2026-04-11)" }, { type: "solution_note", note: "Solution: Meeting agenda template enforced; maximum eight attendees with pre-read requirem..." }],
  },
  {
    id: "HJD00065",
    type: "celebration",
    title: "Display compliance reached 96 percent in pilot cluster",
    description: "Pilot cluster achieved 96 percent display compliance after introducing a pre-weekend audit and explicit owner assignment.",
    department: "Trade Marketing",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Noah Kuiper",
    createdAt: "2026-04-08",
    weekStart: "2026-04-06",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "Regional Sales Lead",
    resolvedAt: "2026-04-15",
    solution: "Wholesaler agreed to daily POS data feed via EDI; integrated into planning workflow.",
    solutionTemplate: null,
    assignedTo: "Regional Sales Lead",
    stakeholders: ["Regional Sales Lead"],
    details: { milestoneType: "Execution KPI", audienceNote: "Trade Marketing" },
    updates: [{ type: "feedback", note: "Best practice shared across channels. (Regional Sales Lead, 2026-04-11)" }, { type: "solution_note", note: "Solution: Wholesaler agreed to daily POS data feed via EDI; integrated into planning workf..." }],
  },
  {
    id: "HJD00066",
    type: "contribution",
    title: "Optimized reporting template for faster review",
    description: "Redesigned the weekly RED reporting template to cut preparation time from 90 to 30 minutes while adding automated trend indicators.",
    department: "Sales Operations",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Laura de Vries",
    createdAt: "2026-04-09",
    weekStart: "2026-04-06",
    status: "assigned",
    meetingNeeded: true,
    priority: "low",
    dueDate: "",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Sophie van Dijk",
    stakeholders: ["Sophie van Dijk", "Tom Bakker"],
    details: { topicTag: "Process", targetAudience: "All field sales reps" },
    updates: [{ type: "feedback", note: "Data analysis completed, presenting findings next Monday. (Tom Bakker, 2026-04-14)" }],
  },
  {
    id: "HJD00067",
    type: "celebration",
    title: "E-commerce conversion rate improved by 18 percent",
    description: "Optimized product imagery and description copy on quick-commerce platforms led to 18 percent conversion rate improvement over six weeks.",
    department: "Convenience & Petrol",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Finn Koopman",
    createdAt: "2026-04-10",
    weekStart: "2026-04-06",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "IT Support",
    resolvedAt: "2026-04-25",
    solution: "Knowledge base created in dashboard archive with tagging and similarity search.",
    solutionTemplate: null,
    assignedTo: "IT Support",
    stakeholders: ["Operations Lead", "IT Support"],
    details: { milestoneType: "Customer retention", audienceNote: "Cross-functional teams" },
    updates: [{ type: "feedback", note: "Cross-functional task force assembled to address root cause. (Operations Lead, 2026-04-12)" }, { type: "solution_note", note: "Solution: Knowledge base created in dashboard archive with tagging and similarity search...." }],
  },
  {
    id: "HJD00068",
    type: "contribution",
    title: "Optimized reporting template for faster review",
    description: "Redesigned the weekly RED reporting template to cut preparation time from 90 to 30 minutes while adding automated trend indicators.",
    department: "Sales Operations",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Laura de Vries",
    createdAt: "2026-04-11",
    weekStart: "2026-04-06",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "Sophie van Dijk",
    resolvedAt: "2026-04-19",
    solution: "POS kit handover process redesigned with explicit ownership and sign-off.",
    solutionTemplate: null,
    assignedTo: "Sophie van Dijk",
    stakeholders: ["Sophie van Dijk", "Tom Bakker"],
    details: { topicTag: "Governance", targetAudience: "Sales Operations" },
    updates: [{ type: "feedback", note: "Owner assigned, tracking weekly progress. (Tom Bakker, 2026-04-14)" }, { type: "solution_note", note: "Solution: POS kit handover process redesigned with explicit ownership and sign-off...." }],
  },
  {
    id: "HJD00069",
    type: "celebration",
    title: "Improved on-time delivery KPI to 97 percent",
    description: "On-time delivery rate improved from 91 to 97 percent after introducing route optimization and early-morning dispatch windows.",
    department: "E-commerce Sales",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Jade Mulder",
    createdAt: "2026-04-12",
    weekStart: "2026-04-06",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "David Meijer",
    resolvedAt: "2026-04-26",
    solution: "POS kit handover process redesigned with explicit ownership and sign-off.",
    solutionTemplate: null,
    assignedTo: "David Meijer",
    stakeholders: ["Sophie van Dijk", "David Meijer"],
    details: { milestoneType: "Promo effectiveness", audienceNote: "Field teams and leadership" },
    updates: [{ type: "feedback", note: "Owner assigned, tracking weekly progress. (Sophie van Dijk, 2026-04-17)" }, { type: "solution_note", note: "Solution: POS kit handover process redesigned with explicit ownership and sign-off...." }],
  },
  {
    id: "HJD00070",
    type: "challenge",
    title: "Difficulty retrieving historical solutions for recurring pricing issue",
    description: "Teams spend significant time searching for past solutions to recurring pricing disputes. There is no structured knowledge base to reference.",
    department: "Trade Marketing",
    assignedToDept: "",
    meetingLevel: "leadership_sync",
    externalEmail: "",
    createdBy: "Noah Kuiper",
    createdAt: "2026-04-13",
    weekStart: "2026-04-13",
    status: "in_discussion",
    meetingNeeded: true,
    priority: "low",
    dueDate: "2026-04-29",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "RGM Analyst",
    stakeholders: ["RGM Analyst", "Laura de Vries"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Cross-functional task force assembled to address root cause. (Laura de Vries, 2026-04-18)" }],
  },
  {
    id: "HJD00071",
    type: "challenge",
    title: "Weekend demand spikes not reflected in store forecasts",
    description: "Sports-event weekends create demand spikes that are under-forecast in several urban supermarkets, causing repeated same-SKU stock-outs.",
    department: "Jumbo & Discounters",
    assignedToDept: "",
    meetingLevel: "national_red",
    externalEmail: "",
    createdBy: "Sophie van Dijk",
    createdAt: "2026-04-14",
    weekStart: "2026-04-13",
    status: "new",
    meetingNeeded: true,
    priority: "high",
    dueDate: "2026-05-02",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "",
    stakeholders: ["Supply Planning", "Laura de Vries"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Monitoring ongoing, early improvements visible. (Laura de Vries, 2026-04-18)" }],
  },
  {
    id: "HJD00072",
    type: "contribution",
    title: "Introduced structured tagging for challenges",
    description: "Proposed and tested a tagging taxonomy for RED challenges, enabling faster filtering and knowledge retrieval for recurring topics.",
    department: "Revenue Growth Management",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Supply Planning",
    createdAt: "2026-04-15",
    weekStart: "2026-04-13",
    status: "closed",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "Laura de Vries",
    resolvedAt: "2026-04-28",
    solution: "Master data validation automated; manual fallback documented for edge cases.",
    solutionTemplate: null,
    assignedTo: "Laura de Vries",
    stakeholders: ["Supply Planning", "Laura de Vries"],
    details: { topicTag: "Process", targetAudience: "RED participants" },
    updates: [{ type: "feedback", note: "Added to monthly performance dashboard. (Supply Planning, 2026-04-18)" }, { type: "solution_note", note: "Solution: Master data validation automated; manual fallback documented for edge cases...." }],
  },
  {
    id: "HJD00073",
    type: "celebration",
    title: "Digital coupon activation delivered basket uplift",
    description: "Targeted digital coupon execution in two chains delivered a measurable basket-size uplift and stronger repeat purchase in the trial period.",
    department: "Convenience & Petrol",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Iris de Graaf",
    createdAt: "2026-04-16",
    weekStart: "2026-04-13",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "Mark Jansen",
    resolvedAt: "2026-05-05",
    solution: "Knowledge base created in dashboard archive with tagging and similarity search.",
    solutionTemplate: null,
    assignedTo: "Mark Jansen",
    stakeholders: ["Mark Jansen", "Tom Bakker"],
    details: { milestoneType: "Service improvement", audienceNote: "Field teams and leadership" },
    updates: [{ type: "feedback", note: "Data analysis completed, presenting findings next Monday. (Tom Bakker, 2026-04-21)" }, { type: "solution_note", note: "Solution: Knowledge base created in dashboard archive with tagging and similarity search...." }],
  },
  {
    id: "HJD00074",
    type: "challenge",
    title: "Difficulty retrieving historical solutions for recurring pricing issue",
    description: "Teams spend significant time searching for past solutions to recurring pricing disputes. There is no structured knowledge base to reference.",
    department: "Field Sales South",
    assignedToDept: "",
    meetingLevel: "national_red",
    externalEmail: "",
    createdBy: "Daan Peeters",
    createdAt: "2026-04-17",
    weekStart: "2026-04-13",
    status: "escalated",
    meetingNeeded: true,
    priority: "medium",
    dueDate: "2026-05-03",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Regional Sales Lead",
    stakeholders: ["Regional Sales Lead"],
    details: { isRecurring: true, escalationLevel: "senior_leadership", relatedItemCode: "HJD00039" },
    updates: [{ type: "feedback", note: "Cross-functional task force assembled to address root cause. (Regional Sales Lead, 2026-04-21)" }, { type: "status_change", note: "Escalated to higher meeting for structural resolution." }],
  },
  {
    id: "HJD00075",
    type: "challenge",
    title: "Customer complaint rate increased after route change",
    description: "After rerouting field sales visits in the east region, customer complaint rate rose by 15 percent due to missed service windows.",
    department: "Field Sales South",
    assignedToDept: "IT",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Mason Drent",
    createdAt: "2026-04-18",
    weekStart: "2026-04-13",
    status: "assigned",
    meetingNeeded: true,
    priority: "low",
    dueDate: "2026-05-03",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Mark Jansen",
    stakeholders: ["Mark Jansen"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Data analysis completed, presenting findings next Monday. (Mark Jansen, 2026-04-23)" }],
  },
  {
    id: "HJD00076",
    type: "celebration",
    title: "Wholesaler satisfaction score reached all-time high",
    description: "Quarterly wholesaler satisfaction survey showed highest-ever score of 8.7 out of 10, driven by faster issue resolution and better communication.",
    department: "Key Accounts Supermarkets",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Eva Broek",
    createdAt: "2026-04-19",
    weekStart: "2026-04-13",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "IT Support",
    resolvedAt: "2026-04-26",
    solution: "SLA updated with vendor; penalty clause added for repeat failures. Monitoring active.",
    solutionTemplate: null,
    assignedTo: "IT Support",
    stakeholders: ["RGM Analyst", "IT Support"],
    details: { milestoneType: "Promo effectiveness", audienceNote: "Cross-functional teams" },
    updates: [{ type: "feedback", note: "Cross-functional task force assembled to address root cause. (RGM Analyst, 2026-04-21)" }, { type: "solution_note", note: "Solution: SLA updated with vendor; penalty clause added for repeat failures. Monitoring ac..." }],
  },
  {
    id: "HJD00077",
    type: "challenge",
    title: "Late feedback from wholesaler impacting weekly planning",
    description: "Key wholesaler provides sell-through data with a five-day delay, making it difficult to adjust weekly promotional plans in time.",
    department: "Trade Marketing",
    assignedToDept: "IT",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Operations Lead",
    createdAt: "2026-04-20",
    weekStart: "2026-04-20",
    status: "in_discussion",
    meetingNeeded: true,
    priority: "high",
    dueDate: "2026-05-07",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "IT Support",
    stakeholders: ["RGM Analyst", "IT Support"],
    details: { isRecurring: true, escalationLevel: "team_lead", relatedItemCode: "HJD00053" },
    updates: [{ type: "feedback", note: "Added to monthly performance dashboard. (RGM Analyst, 2026-04-22)" }],
  },
  {
    id: "HJD00078",
    type: "challenge",
    title: "Salesforce data mismatch between order intake and shipment confirmation",
    description: "Field reps report discrepancies between Salesforce order data and actual warehouse shipment confirmations, leading to inaccurate customer reporting.",
    department: "Convenience & Petrol",
    assignedToDept: "",
    meetingLevel: "leadership_sync",
    externalEmail: "",
    createdBy: "Iris de Graaf",
    createdAt: "2026-04-21",
    weekStart: "2026-04-20",
    status: "in_discussion",
    meetingNeeded: true,
    priority: "medium",
    dueDate: "2026-05-11",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Tom Bakker",
    stakeholders: ["Tom Bakker", "Emma Visser"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Owner assigned, tracking weekly progress. (Emma Visser, 2026-04-26)" }],
  },
  {
    id: "HJD00079",
    type: "contribution",
    title: "Shared best practice from previous campaign execution",
    description: "Documented step-by-step approach from last quarter successful multipack campaign, including timing, allocation and in-store execution checklist.",
    department: "Jumbo & Discounters",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "David Meijer",
    createdAt: "2026-04-22",
    weekStart: "2026-04-20",
    status: "closed",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "RGM Analyst",
    resolvedAt: "2026-04-29",
    solution: "Wholesaler agreed to daily POS data feed via EDI; integrated into planning workflow.",
    solutionTemplate: null,
    assignedTo: "RGM Analyst",
    stakeholders: ["RGM Analyst", "Supply Planning"],
    details: { topicTag: "Process", targetAudience: "Cross-functional" },
    updates: [{ type: "feedback", note: "Added to monthly performance dashboard. (Supply Planning, 2026-04-24)" }, { type: "solution_note", note: "Solution: Wholesaler agreed to daily POS data feed via EDI; integrated into planning workf..." }],
  },
  {
    id: "HJD00080",
    type: "celebration",
    title: "Strong cross-functional collaboration achieved on launch",
    description: "New product launch was executed flawlessly across all channels thanks to aligned planning between trade marketing, supply chain and field sales.",
    department: "Convenience & Petrol",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Finn Koopman",
    createdAt: "2026-04-23",
    weekStart: "2026-04-20",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "Mark Jansen",
    resolvedAt: "2026-05-07",
    solution: "Meeting agenda template enforced; maximum eight attendees with pre-read requirement.",
    solutionTemplate: null,
    assignedTo: "Mark Jansen",
    stakeholders: ["Mark Jansen", "IT Support"],
    details: { milestoneType: "Customer retention", audienceNote: "Convenience & Petrol" },
    updates: [{ type: "feedback", note: "Vendor contacted, awaiting SLA revision proposal. (IT Support, 2026-04-25)" }, { type: "solution_note", note: "Solution: Meeting agenda template enforced; maximum eight attendees with pre-read requirem..." }],
  },
  {
    id: "HJD00081",
    type: "contribution",
    title: "Provided benchmark analysis from AFH channel",
    description: "Delivered a cross-channel benchmark comparing AFH performance metrics with retail, identifying three areas for improvement in outlet coverage.",
    department: "Field Sales South",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Daan Peeters",
    createdAt: "2026-04-24",
    weekStart: "2026-04-20",
    status: "assigned",
    meetingNeeded: true,
    priority: "medium",
    dueDate: "",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Laura de Vries",
    stakeholders: ["Mark Jansen", "Laura de Vries"],
    details: { topicTag: "Governance", targetAudience: "RED participants" },
    updates: [{ type: "feedback", note: "Best practice shared across channels. (Mark Jansen, 2026-04-27)" }],
  },
  {
    id: "HJD00082",
    type: "celebration",
    title: "First-time perfect store score in east cluster",
    description: "East cluster achieved perfect store score for the first time, with all 24 stores meeting all five KPI thresholds simultaneously.",
    department: "Sales Operations",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Laura de Vries",
    createdAt: "2026-04-25",
    weekStart: "2026-04-20",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "Regional Sales Lead",
    resolvedAt: "2026-05-11",
    solution: "Meeting agenda template enforced; maximum eight attendees with pre-read requirement.",
    solutionTemplate: null,
    assignedTo: "Regional Sales Lead",
    stakeholders: ["Regional Sales Lead", "Sophie van Dijk"],
    details: { milestoneType: "Volume growth", audienceNote: "Sales Operations" },
    updates: [{ type: "feedback", note: "Best practice shared across channels. (Sophie van Dijk, 2026-04-27)" }, { type: "solution_note", note: "Solution: Meeting agenda template enforced; maximum eight attendees with pre-read requirem..." }],
  },
  {
    id: "HJD00083",
    type: "celebration",
    title: "Positive customer feedback received for service improvement",
    description: "Two key accounts provided written positive feedback praising improved service responsiveness and proactive issue resolution by field team.",
    department: "Convenience & Petrol",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Iris de Graaf",
    createdAt: "2026-04-26",
    weekStart: "2026-04-20",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "Sophie van Dijk",
    resolvedAt: "2026-05-14",
    solution: "Event-driven overlay added to forecast model; weekend accuracy improved to 89 percent.",
    solutionTemplate: null,
    assignedTo: "Sophie van Dijk",
    stakeholders: ["Regional Sales Lead", "Sophie van Dijk"],
    details: { milestoneType: "Execution KPI", audienceNote: "Convenience & Petrol" },
    updates: [{ type: "feedback", note: "Data analysis completed, presenting findings next Monday. (Regional Sales Lead, 2026-04-30)" }, { type: "solution_note", note: "Solution: Event-driven overlay added to forecast model; weekend accuracy improved to 89 pe..." }],
  },
  {
    id: "HJD00084",
    type: "challenge",
    title: "Planogram compliance audit shows 58 percent adherence",
    description: "Latest audit reveals only 58 percent planogram compliance in the north region. Main issues are shelf-space allocation and facing direction.",
    department: "Convenience & Petrol",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Finn Koopman",
    createdAt: "2026-04-27",
    weekStart: "2026-04-27",
    status: "assigned",
    meetingNeeded: true,
    priority: "medium",
    dueDate: "2026-05-11",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Laura de Vries",
    stakeholders: ["Regional Sales Lead", "Laura de Vries"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Best practice shared across channels. (Regional Sales Lead, 2026-05-02)" }],
  },
  {
    id: "HJD00085",
    type: "contribution",
    title: "Standardized promotion briefing format across channels",
    description: "Created a unified promotion brief template adopted by all channels, ensuring consistent information flow from trade marketing to field.",
    department: "Key Accounts Supermarkets",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Kai van Ommen",
    createdAt: "2026-04-28",
    weekStart: "2026-04-27",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "RGM Analyst",
    resolvedAt: "2026-05-12",
    solution: "Event-driven overlay added to forecast model; weekend accuracy improved to 89 percent.",
    solutionTemplate: null,
    assignedTo: "RGM Analyst",
    stakeholders: ["RGM Analyst"],
    details: { topicTag: "Data", targetAudience: "All field sales reps" },
    updates: [{ type: "feedback", note: "Monitoring ongoing, early improvements visible. (RGM Analyst, 2026-05-02)" }, { type: "solution_note", note: "Solution: Event-driven overlay added to forecast model; weekend accuracy improved to 89 pe..." }],
  },
  {
    id: "HJD00086",
    type: "challenge",
    title: "Weekend demand spikes not reflected in store forecasts",
    description: "Sports-event weekends create demand spikes that are under-forecast in several urban supermarkets, causing repeated same-SKU stock-outs.",
    department: "Jumbo & Discounters",
    assignedToDept: "",
    meetingLevel: "regional_red",
    externalEmail: "",
    createdBy: "David Meijer",
    createdAt: "2026-04-29",
    weekStart: "2026-04-27",
    status: "new",
    meetingNeeded: true,
    priority: "high",
    dueDate: "2026-05-20",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "",
    stakeholders: ["IT Support", "Mark Jansen"],
    details: { isRecurring: true, escalationLevel: "team_lead", relatedItemCode: "HJD00023" },
    updates: [{ type: "feedback", note: "Vendor contacted, awaiting SLA revision proposal. (Mark Jansen, 2026-05-03)" }],
  },
  {
    id: "HJD00087",
    type: "celebration",
    title: "Positive customer feedback received for service improvement",
    description: "Two key accounts provided written positive feedback praising improved service responsiveness and proactive issue resolution by field team.",
    department: "E-commerce Sales",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Jade Mulder",
    createdAt: "2026-04-30",
    weekStart: "2026-04-27",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "Supply Planning",
    resolvedAt: "2026-05-16",
    solution: "Accrual validation template distributed; monthly reconciliation meeting scheduled.",
    solutionTemplate: null,
    assignedTo: "Supply Planning",
    stakeholders: ["Supply Planning", "Laura de Vries"],
    details: { milestoneType: "Customer retention", audienceNote: "Field teams and leadership" },
    updates: [{ type: "feedback", note: "Escalated and temporary solution implemented. (Laura de Vries, 2026-05-03)" }, { type: "solution_note", note: "Solution: Accrual validation template distributed; monthly reconciliation meeting schedule..." }],
  },
  {
    id: "HJD00088",
    type: "challenge",
    title: "Customer complaint rate increased after route change",
    description: "After rerouting field sales visits in the east region, customer complaint rate rose by 15 percent due to missed service windows.",
    department: "Wholesalers",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Yara Meinen",
    createdAt: "2026-05-01",
    weekStart: "2026-04-27",
    status: "new",
    meetingNeeded: true,
    priority: "medium",
    dueDate: "2026-05-17",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "",
    stakeholders: ["RGM Analyst", "David Meijer"],
    details: { isRecurring: true, escalationLevel: "team_lead", relatedItemCode: "HJD00087" },
    updates: [{ type: "feedback", note: "Data analysis completed, presenting findings next Monday. (RGM Analyst, 2026-05-03)" }],
  },
  {
    id: "HJD00089",
    type: "challenge",
    title: "Promo price mismatch between shelf label and scanner at multiple stores",
    description: "Multiple stores reported promo price differences for 1.5L multipacks. Store teams need a standard correction flow to avoid customer complaints and margin leakage.",
    department: "Wholesalers",
    assignedToDept: "HR",
    meetingLevel: "national_red",
    externalEmail: "",
    createdBy: "Yara Meinen",
    createdAt: "2026-05-02",
    weekStart: "2026-04-27",
    status: "escalated",
    meetingNeeded: true,
    priority: "medium",
    dueDate: "2026-05-22",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Mark Jansen",
    stakeholders: ["Regional Sales Lead", "Mark Jansen"],
    details: { isRecurring: false, escalationLevel: "senior_leadership", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Added to monthly performance dashboard. (Regional Sales Lead, 2026-05-04)" }, { type: "status_change", note: "Escalated to higher meeting for structural resolution." }],
  },
  {
    id: "HJD00090",
    type: "challenge",
    title: "Cooler outages at petrol locations during peak hours",
    description: "Three high-traffic stations had intermittent cooler failures, causing warm products and missed impulse sales. Maintenance SLA review is required.",
    department: "Sales Operations",
    assignedToDept: "Finance",
    meetingLevel: "regional_red",
    externalEmail: "",
    createdBy: "Laura de Vries",
    createdAt: "2026-05-03",
    weekStart: "2026-04-27",
    status: "assigned",
    meetingNeeded: true,
    priority: "low",
    dueDate: "2026-05-14",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Mark Jansen",
    stakeholders: ["Supply Planning", "Mark Jansen"],
    details: { isRecurring: true, escalationLevel: "team_lead", relatedItemCode: "HJD00015" },
    updates: [{ type: "feedback", note: "Vendor contacted, awaiting SLA revision proposal. (Supply Planning, 2026-05-08)" }],
  },
  {
    id: "HJD00091",
    type: "celebration",
    title: "Wholesaler satisfaction score reached all-time high",
    description: "Quarterly wholesaler satisfaction survey showed highest-ever score of 8.7 out of 10, driven by faster issue resolution and better communication.",
    department: "Wholesalers",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Yara Meinen",
    createdAt: "2026-05-04",
    weekStart: "2026-05-04",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "Tom Bakker",
    resolvedAt: "2026-05-20",
    solution: "Supplier committed to four-week lead time for promo packaging; buffer ordered.",
    solutionTemplate: null,
    assignedTo: "Tom Bakker",
    stakeholders: ["IT Support", "Tom Bakker"],
    details: { milestoneType: "Service improvement", audienceNote: "Cross-functional teams" },
    updates: [{ type: "feedback", note: "Added to monthly performance dashboard. (IT Support, 2026-05-08)" }, { type: "solution_note", note: "Solution: Supplier committed to four-week lead time for promo packaging; buffer ordered...." }],
  },
  {
    id: "HJD00092",
    type: "challenge",
    title: "Late feedback from wholesaler impacting weekly planning",
    description: "Key wholesaler provides sell-through data with a five-day delay, making it difficult to adjust weekly promotional plans in time.",
    department: "Wholesalers",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Yara Meinen",
    createdAt: "2026-05-05",
    weekStart: "2026-05-04",
    status: "new",
    meetingNeeded: true,
    priority: "high",
    dueDate: "2026-05-26",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "",
    stakeholders: ["Supply Planning", "Sophie van Dijk"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Owner assigned, tracking weekly progress. (Sophie van Dijk, 2026-05-07)" }],
  },
  {
    id: "HJD00093",
    type: "challenge",
    title: "Display compliance below target in discounter cluster",
    description: "Secondary display compliance dropped to 68 percent in a key discounter cluster. Root cause appears to be missing POS kit handover and unclear ownership.",
    department: "Trade Marketing",
    assignedToDept: "",
    meetingLevel: "leadership_sync",
    externalEmail: "",
    createdBy: "Operations Lead",
    createdAt: "2026-05-06",
    weekStart: "2026-05-04",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "2026-05-22",
    resolvedBy: "Supply Planning",
    resolvedAt: "2026-05-11",
    solution: "Seasonal event calendar integrated into forecast model; regional adjustments automated.",
    solutionTemplate: null,
    assignedTo: "Supply Planning",
    stakeholders: ["Supply Planning", "Laura de Vries"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Root cause identified and corrective action defined. (Laura de Vries, 2026-05-08)" }, { type: "solution_note", note: "Solution: Seasonal event calendar integrated into forecast model; regional adjustments aut..." }],
  },
  {
    id: "HJD00094",
    type: "celebration",
    title: "Digital coupon activation delivered basket uplift",
    description: "Targeted digital coupon execution in two chains delivered a measurable basket-size uplift and stronger repeat purchase in the trial period.",
    department: "Jumbo & Discounters",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Mark Jansen",
    createdAt: "2026-05-07",
    weekStart: "2026-05-04",
    status: "resolved",
    meetingNeeded: false,
    priority: "medium",
    dueDate: "",
    resolvedBy: "Mark Jansen",
    resolvedAt: "2026-05-15",
    solution: "Salesforce integration patched; daily reconciliation report created for field managers.",
    solutionTemplate: null,
    assignedTo: "Mark Jansen",
    stakeholders: ["Regional Sales Lead", "Mark Jansen"],
    details: { milestoneType: "Service improvement", audienceNote: "Field teams and leadership" },
    updates: [{ type: "feedback", note: "Root cause identified and corrective action defined. (Regional Sales Lead, 2026-05-10)" }, { type: "solution_note", note: "Solution: Salesforce integration patched; daily reconciliation report created for field ma..." }],
  },
  {
    id: "HJD00095",
    type: "celebration",
    title: "Successful promotion campaign with double digit uplift",
    description: "Summer campaign for Zero Sugar multipack delivered 14 percent volume uplift and 8 percent value share gain in participating stores.",
    department: "Revenue Growth Management",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Supply Planning",
    createdAt: "2026-05-08",
    weekStart: "2026-05-04",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "Operations Lead",
    resolvedAt: "2026-05-20",
    solution: "Implemented standardized correction flow with automated price verification at POS.",
    solutionTemplate: null,
    assignedTo: "Operations Lead",
    stakeholders: ["Operations Lead", "RGM Analyst"],
    details: { milestoneType: "Execution KPI", audienceNote: "Field teams and leadership" },
    updates: [{ type: "feedback", note: "Escalated and temporary solution implemented. (RGM Analyst, 2026-05-12)" }, { type: "solution_note", note: "Solution: Implemented standardized correction flow with automated price verification at PO..." }],
  },
  {
    id: "HJD00096",
    type: "challenge",
    title: "Cooler outages at petrol locations during peak hours",
    description: "Three high-traffic stations had intermittent cooler failures, causing warm products and missed impulse sales. Maintenance SLA review is required.",
    department: "Key Accounts Supermarkets",
    assignedToDept: "IT",
    meetingLevel: "regional_red",
    externalEmail: "",
    createdBy: "Kai van Ommen",
    createdAt: "2026-05-09",
    weekStart: "2026-05-04",
    status: "assigned",
    meetingNeeded: true,
    priority: "high",
    dueDate: "2026-05-19",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Supply Planning",
    stakeholders: ["Supply Planning"],
    details: { isRecurring: true, escalationLevel: "team_lead", relatedItemCode: "HJD00068" },
    updates: [{ type: "feedback", note: "Cross-functional task force assembled to address root cause. (Supply Planning, 2026-05-13)" }],
  },
  {
    id: "HJD00097",
    type: "challenge",
    title: "Forecasting model not accounting for seasonal events",
    description: "Current forecasting model does not include regional event calendars, causing under-supply during local festivals and sports events.",
    department: "E-commerce Sales",
    assignedToDept: "",
    meetingLevel: "leadership_sync",
    externalEmail: "",
    createdBy: "Owen van Dijk",
    createdAt: "2026-05-10",
    weekStart: "2026-05-04",
    status: "resolved",
    meetingNeeded: false,
    priority: "high",
    dueDate: "2026-05-28",
    resolvedBy: "David Meijer",
    resolvedAt: "2026-05-18",
    solution: "Implemented standardized correction flow with automated price verification at POS.",
    solutionTemplate: null,
    assignedTo: "David Meijer",
    stakeholders: ["David Meijer", "Emma Visser"],
    details: { isRecurring: true, escalationLevel: "team_lead", relatedItemCode: "HJD00085" },
    updates: [{ type: "feedback", note: "Cross-functional task force assembled to address root cause. (Emma Visser, 2026-05-15)" }, { type: "solution_note", note: "Solution: Implemented standardized correction flow with automated price verification at PO..." }],
  },
  {
    id: "HJD00098",
    type: "challenge",
    title: "New product listing delay due to master data backlog",
    description: "Three new SKU listings are stuck in master data processing for over two weeks, delaying availability on retailer online platforms.",
    department: "Sales Operations",
    assignedToDept: "Finance",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Laura de Vries",
    createdAt: "2026-05-11",
    weekStart: "2026-05-11",
    status: "assigned",
    meetingNeeded: true,
    priority: "medium",
    dueDate: "2026-05-31",
    resolvedBy: "",
    resolvedAt: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "Sophie van Dijk",
    stakeholders: ["Supply Planning", "Sophie van Dijk"],
    details: { isRecurring: false, escalationLevel: "team_lead", relatedItemCode: "" },
    updates: [{ type: "feedback", note: "Data analysis completed, presenting findings next Monday. (Supply Planning, 2026-05-16)" }],
  },
  {
    id: "HJD00099",
    type: "contribution",
    title: "Introduced structured tagging for challenges",
    description: "Proposed and tested a tagging taxonomy for RED challenges, enabling faster filtering and knowledge retrieval for recurring topics.",
    department: "Field Sales North",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Nina Vos",
    createdAt: "2026-05-12",
    weekStart: "2026-05-11",
    status: "closed",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "Emma Visser",
    resolvedAt: "2026-05-20",
    solution: "Meeting agenda template enforced; maximum eight attendees with pre-read requirement.",
    solutionTemplate: null,
    assignedTo: "Emma Visser",
    stakeholders: ["Laura de Vries", "Emma Visser"],
    details: { topicTag: "Governance", targetAudience: "Field Sales North" },
    updates: [{ type: "feedback", note: "Data analysis completed, presenting findings next Monday. (Laura de Vries, 2026-05-16)" }, { type: "solution_note", note: "Solution: Meeting agenda template enforced; maximum eight attendees with pre-read requirem..." }],
  },
  {
    id: "HJD00100",
    type: "celebration",
    title: "Improved on-time delivery KPI to 97 percent",
    description: "On-time delivery rate improved from 91 to 97 percent after introducing route optimization and early-morning dispatch windows.",
    department: "Field Sales North",
    assignedToDept: "",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Nina Vos",
    createdAt: "2026-05-13",
    weekStart: "2026-05-11",
    status: "resolved",
    meetingNeeded: false,
    priority: "low",
    dueDate: "",
    resolvedBy: "Supply Planning",
    resolvedAt: "2026-05-26",
    solution: "Meeting agenda template enforced; maximum eight attendees with pre-read requirement.",
    solutionTemplate: null,
    assignedTo: "Supply Planning",
    stakeholders: ["Supply Planning", "Tom Bakker"],
    details: { milestoneType: "Promo effectiveness", audienceNote: "Field Sales North" },
    updates: [{ type: "feedback", note: "Owner assigned, tracking weekly progress. (Tom Bakker, 2026-05-18)" }, { type: "solution_note", note: "Solution: Meeting agenda template enforced; maximum eight attendees with pre-read requirem..." }],
  },
  // ── Resolution Time benchmark items (knowledge reuse = fast resolution) ──
  {
    id: "HJD00101",
    type: "challenge",
    title: "Pricing accrual error causing double invoicing at key account",
    description: "A pricing accrual misalignment caused two retailers to receive duplicate invoices. Finance and Sales Operations flagged the discrepancy.",
    department: "Key Accounts Supermarkets",
    assignedToDept: "Finance",
    meetingLevel: "regional_red",
    externalEmail: "",
    createdBy: "Mila Janssen",
    createdAt: "2026-02-10",
    weekStart: "2026-02-09",
    status: "resolved",
    meetingNeeded: false,
    priority: "high",
    dueDate: "2026-02-17",
    resolvedBy: "Laura de Vries",
    resolvedAt: "2026-02-13",
    solution: "Applied standard accrual correction template from HJD00022. Finance reversed duplicate entries within 24h.",
    solutionTemplate: { rootCause: "pricing" },
    assignedTo: "Laura de Vries",
    stakeholders: ["Laura de Vries", "Mark Jansen"],
    details: { isRecurring: false, knowledgeReused: true, knowledgeReuseSource: "HJD00022", knowledgeReuseTimestamp: "2026-02-10T09:15:00.000Z", meetingGate: { matchedItemId: "HJD00022", similarity: 0.78, appliedAt: "2026-02-10" } },
    updates: [{ type: "meeting_note", note: "Knowledge reuse applied from HJD00022. Meeting skipped. Assigned to Laura de Vries." }, { type: "solution_note", note: "Solution: Applied standard accrual correction template." }],
  },
  {
    id: "HJD00102",
    type: "challenge",
    title: "Out-of-stock on energy multipack in convenience cluster",
    description: "Five convenience stores reported zero stock on 4-pack energy cans over a long weekend. Replenishment cycle did not trigger correctly.",
    department: "Convenience & Petrol",
    assignedToDept: "Supply Chain",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Jonas Smit",
    createdAt: "2026-02-18",
    weekStart: "2026-02-16",
    status: "resolved",
    meetingNeeded: false,
    priority: "high",
    dueDate: "2026-02-25",
    resolvedBy: "Supply Planning",
    resolvedAt: "2026-02-21",
    solution: "Reused replenishment buffer solution from HJD00003. Min-max thresholds adjusted for weekend demand peaks.",
    solutionTemplate: { rootCause: "stock" },
    assignedTo: "Supply Planning",
    stakeholders: ["Supply Planning"],
    details: { isRecurring: false, knowledgeReused: true, knowledgeReuseSource: "HJD00003", knowledgeReuseTimestamp: "2026-02-18T10:30:00.000Z", meetingGate: { matchedItemId: "HJD00003", similarity: 0.81, appliedAt: "2026-02-18" } },
    updates: [{ type: "meeting_note", note: "Knowledge reuse applied from HJD00003. Meeting skipped." }, { type: "solution_note", note: "Solution: Replenishment buffer adjusted for weekend peaks." }],
  },
  {
    id: "HJD00103",
    type: "challenge",
    title: "EDI feed failure causing order gaps for e-commerce partner",
    description: "EDI integration with a major e-commerce platform dropped orders for 48 hours due to schema mismatch after a platform update.",
    department: "E-commerce Sales",
    assignedToDept: "IT",
    meetingLevel: "regional_red",
    externalEmail: "",
    createdBy: "Sophie van Dijk",
    createdAt: "2026-03-03",
    weekStart: "2026-03-02",
    status: "resolved",
    meetingNeeded: false,
    priority: "high",
    dueDate: "2026-03-10",
    resolvedBy: "IT Support",
    resolvedAt: "2026-03-06",
    solution: "Reapplied EDI schema mapping fix from previous incident HJD00047. IT patched connector within 4h.",
    solutionTemplate: { rootCause: "system" },
    assignedTo: "IT Support",
    stakeholders: ["IT Support", "Sophie van Dijk"],
    details: { isRecurring: false, knowledgeReused: true, knowledgeReuseSource: "HJD00047", knowledgeReuseTimestamp: "2026-03-03T08:00:00.000Z", meetingGate: { matchedItemId: "HJD00047", similarity: 0.74, appliedAt: "2026-03-03" } },
    updates: [{ type: "meeting_note", note: "Knowledge reuse applied from HJD00047. Meeting skipped." }, { type: "solution_note", note: "Solution: EDI schema mapping corrected." }],
  },
  {
    id: "HJD00104",
    type: "challenge",
    title: "Delivery route disruption causing missed SLA at northern depot",
    description: "Road closures rerouted three delivery vehicles, causing 14 stores to miss their SLA window by more than 4 hours.",
    department: "Field Sales North",
    assignedToDept: "Operations",
    meetingLevel: "national_red",
    externalEmail: "",
    createdBy: "Alex Vermeer",
    createdAt: "2026-03-10",
    weekStart: "2026-03-09",
    status: "resolved",
    meetingNeeded: true,
    priority: "high",
    dueDate: "2026-03-17",
    resolvedBy: "Tom Bakker",
    resolvedAt: "2026-03-24",
    solution: "Escalated to Director level. New depot contingency routing protocol agreed in meeting. Took 3 meetings to align all stakeholders.",
    solutionTemplate: { rootCause: "logistics" },
    assignedTo: "Tom Bakker",
    stakeholders: ["Tom Bakker", "Regional Sales Lead"],
    details: { isRecurring: true, escalationLevel: "senior_leadership" },
    updates: [{ type: "feedback", note: "Under investigation. Multiple stakeholders needed. (Alex Vermeer, 2026-03-12)" }, { type: "feedback", note: "Second meeting scheduled. (Tom Bakker, 2026-03-17)" }, { type: "solution_note", note: "Solution: Contingency routing protocol established after Director meeting." }],
  },
  {
    id: "HJD00105",
    type: "challenge",
    title: "Compliance gap in secondary display execution across discounters",
    description: "Audit revealed that 38% of secondary display locations were not correctly activated in the discounter cluster due to unclear POS instructions.",
    department: "Trade Marketing",
    assignedToDept: "Operations",
    meetingLevel: "regional_red",
    externalEmail: "",
    createdBy: "Emma Peters",
    createdAt: "2026-03-15",
    weekStart: "2026-03-14",
    status: "resolved",
    meetingNeeded: true,
    priority: "medium",
    dueDate: "2026-03-29",
    resolvedBy: "Trade Marketing",
    resolvedAt: "2026-04-01",
    solution: "Cross-functional meeting with field and trade marketing to rewrite POS briefing materials. New one-pager distributed.",
    solutionTemplate: { rootCause: "compliance" },
    assignedTo: "Trade Marketing",
    stakeholders: ["Trade Marketing", "Field Sales North"],
    details: { isRecurring: false },
    updates: [{ type: "feedback", note: "Root cause confirmed: briefing materials unclear. (Emma Peters, 2026-03-18)" }, { type: "feedback", note: "Cross-functional meeting held. Materials rewritten. (Trade Marketing, 2026-03-25)" }, { type: "solution_note", note: "Solution: POS briefing materials revised and distributed." }],
  },
  {
    id: "HJD00106",
    type: "challenge",
    title: "Promo accrual mismatch on summer campaign — wholesaler segment",
    description: "Three wholesaler accounts flagged incorrect promotional accruals for the summer campaign, leading to disputed credit notes totalling €14k.",
    department: "Wholesalers",
    assignedToDept: "Finance",
    meetingLevel: "regional_red",
    externalEmail: "",
    createdBy: "Lars de Jong",
    createdAt: "2026-04-07",
    weekStart: "2026-04-06",
    status: "resolved",
    meetingNeeded: true,
    priority: "high",
    dueDate: "2026-04-14",
    resolvedBy: "Finance",
    resolvedAt: "2026-04-22",
    solution: "Finance convened review meeting with Sales Operations. Accrual methodology recalibrated. Credit notes reissued after two rounds of alignment.",
    solutionTemplate: { rootCause: "pricing" },
    assignedTo: "Finance",
    stakeholders: ["Finance", "Lars de Jong", "Sales Operations"],
    details: { isRecurring: false },
    updates: [{ type: "feedback", note: "Finance reviewing accrual logic. (Lars de Jong, 2026-04-09)" }, { type: "feedback", note: "Second review needed — wholesaler disputed figures again. (Finance, 2026-04-16)" }, { type: "solution_note", note: "Solution: Accrual methodology corrected and credit notes reissued." }],
  },
  {
    id: "HJD00107",
    type: "challenge",
    title: "Master data error causing wrong shelf price display at supermarket",
    description: "A master data update pushed an incorrect price for a 1.5L SKU to POS systems across 22 supermarket locations, causing customer complaints.",
    department: "Key Accounts Supermarkets",
    assignedToDept: "IT",
    meetingLevel: "national_red",
    externalEmail: "",
    createdBy: "Mila Janssen",
    createdAt: "2026-04-14",
    weekStart: "2026-04-13",
    status: "resolved",
    meetingNeeded: false,
    priority: "high",
    dueDate: "2026-04-18",
    resolvedBy: "IT Support",
    resolvedAt: "2026-04-16",
    solution: "Reapplied master data correction protocol from HJD00031. IT pushed corrected price file within 2h of ticket.",
    solutionTemplate: { rootCause: "data" },
    assignedTo: "IT Support",
    stakeholders: ["IT Support", "Mila Janssen"],
    details: { isRecurring: false, knowledgeReused: true, knowledgeReuseSource: "HJD00031", knowledgeReuseTimestamp: "2026-04-14T11:00:00.000Z", meetingGate: { matchedItemId: "HJD00031", similarity: 0.82, appliedAt: "2026-04-14" } },
    updates: [{ type: "meeting_note", note: "Knowledge reuse applied from HJD00031. Meeting skipped. Assigned to IT Support." }, { type: "solution_note", note: "Solution: Master data correction protocol applied." }],
  },
  {
    id: "HJD00108",
    type: "challenge",
    title: "Stock replenishment failure for chilled range at petrol forecourts",
    description: "Chilled SKUs at 8 forecourt locations were not replenished over a bank holiday weekend, resulting in 48h out-of-stock and lost sales.",
    department: "Convenience & Petrol",
    assignedToDept: "Supply Chain",
    meetingLevel: "team_weekly",
    externalEmail: "",
    createdBy: "Jonas Smit",
    createdAt: "2026-04-22",
    weekStart: "2026-04-21",
    status: "resolved",
    meetingNeeded: true,
    priority: "medium",
    dueDate: "2026-04-29",
    resolvedBy: "Supply Planning",
    resolvedAt: "2026-05-06",
    solution: "Root cause was a gap in bank holiday delivery schedule. Supply Planning and logistics aligned on a dedicated holiday replenishment run.",
    solutionTemplate: { rootCause: "stock" },
    assignedTo: "Supply Planning",
    stakeholders: ["Supply Planning", "Jonas Smit"],
    details: { isRecurring: false },
    updates: [{ type: "feedback", note: "Supply chain investigating. (Jonas Smit, 2026-04-24)" }, { type: "feedback", note: "Holiday delivery schedule gap confirmed. Meeting scheduled. (Supply Planning, 2026-04-28)" }, { type: "solution_note", note: "Solution: Bank holiday replenishment run established." }],
  },
  {"id":"HJD00109","type":"contribution","title":"Shared best practice for promo execution across regions","description":"Shared best practice for promo execution across regions. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Convenience & Petrol","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Bram de Jong","createdAt":"2026-01-23","weekStart":"2026-01-19","status":"closed","meetingNeeded":false,"priority":"medium","dueDate":"","resolvedBy":"Tom Bakker","resolvedAt":"2026-04-11","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":null,"assignedTo":"","stakeholders":["Femke de Graaf","Fleur Hendriks"],"details":{"isRecurring":false},"updates":[{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00110","type":"challenge","title":"Delayed shipment notifications causing retailer complaints","description":"Delayed shipment notifications causing retailer complaints. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Key Accounts Supermarkets","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Daan Meijer","createdAt":"2026-04-29","weekStart":"2026-04-27","status":"new","meetingNeeded":true,"priority":"low","dueDate":"2026-04-30","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Jonas Smit","Tom Bakker"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00111","type":"celebration","title":"Record quarterly volume in convenience channel","description":"Record quarterly volume in convenience channel. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales South","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Mila Janssen","createdAt":"2026-03-21","weekStart":"2026-03-16","status":"in_discussion","meetingNeeded":false,"priority":"low","dueDate":"","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Joost Jacobs","Anna Peters"],"details":{"isRecurring":true},"updates":[]},
  {"id":"HJD00112","type":"challenge","title":"Incorrect promotional pricing in POS systems across region","description":"Incorrect promotional pricing in POS systems across region. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Revenue Growth Management","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Sanne Mulder","createdAt":"2026-03-05","weekStart":"2026-03-02","status":"assigned","meetingNeeded":true,"priority":"high","dueDate":"2026-03-07","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Eva Bosman","stakeholders":["Anna Peters","Niels Kuiper"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Alex Vermeer, 2026-03-05)"}]},
  {"id":"HJD00113","type":"challenge","title":"Pallet damage during cross-dock operations at DC South","description":"Pallet damage during cross-dock operations at DC South. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales South","assignedToDept":"","meetingLevel":"national_red","externalEmail":"","createdBy":"Emma Visser","createdAt":"2026-01-22","weekStart":"2026-01-19","status":"new","meetingNeeded":true,"priority":"medium","dueDate":"2026-03-22","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Luuk van den Berg","Alex Vermeer"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00114","type":"challenge","title":"EDI integration failure with new wholesaler platform","description":"EDI integration failure with new wholesaler platform. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Trade Marketing","assignedToDept":"Key Accounts Supermarkets","meetingLevel":"regional_red","externalEmail":"","createdBy":"Rosa Brouwer","createdAt":"2026-02-02","weekStart":"2026-02-02","status":"assigned","meetingNeeded":true,"priority":"medium","dueDate":"2026-06-12","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Jade Mulder","stakeholders":["Lisa Dekker"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Jonas Smit, 2026-02-28)"}]},
  {"id":"HJD00115","type":"contribution","title":"Created automated reporting template for weekly sales review","description":"Created automated reporting template for weekly sales review. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Revenue Growth Management","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Femke de Graaf","createdAt":"2026-02-24","weekStart":"2026-02-23","status":"assigned","meetingNeeded":false,"priority":"high","dueDate":"","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Eva Bosman","Sanne Mulder"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00116","type":"challenge","title":"Weekend replenishment gap for energy drink SKUs","description":"Weekend replenishment gap for energy drink SKUs. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Trade Marketing","assignedToDept":"HR","meetingLevel":"national_red","externalEmail":"","createdBy":"Alex Vermeer","createdAt":"2026-01-15","weekStart":"2026-01-12","status":"resolved","meetingNeeded":true,"priority":"medium","dueDate":"2026-04-25","resolvedBy":"Emma Visser","resolvedAt":"2026-01-26","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"logistics"},"assignedTo":"Pieter Vos","stakeholders":["Anna Peters","Jonas Smit"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Tom Bakker, 2026-03-22)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00117","type":"challenge","title":"Customer service response time exceeding SLA targets","description":"Customer service response time exceeding SLA targets. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Convenience & Petrol","assignedToDept":"HR","meetingLevel":"regional_red","externalEmail":"","createdBy":"Femke de Graaf","createdAt":"2026-04-03","weekStart":"2026-03-30","status":"new","meetingNeeded":true,"priority":"low","dueDate":"2026-05-24","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Ruben Smeets","Lisa Dekker"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00118","type":"celebration","title":"Team achieved highest NPS score in company history","description":"Team achieved highest NPS score in company history. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Jumbo & Discounters","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Damian de Groot","createdAt":"2026-02-04","weekStart":"2026-02-02","status":"resolved","meetingNeeded":false,"priority":"low","dueDate":"","resolvedBy":"Ruben Smeets","resolvedAt":"2026-02-05","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"pricing"},"assignedTo":"","stakeholders":["Ruben Smeets","Luuk van den Berg"],"details":{"isRecurring":false},"updates":[{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00119","type":"challenge","title":"Missing product images on retailer e-commerce portals","description":"Missing product images on retailer e-commerce portals. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Jumbo & Discounters","assignedToDept":"HR","meetingLevel":"national_red","externalEmail":"","createdBy":"Sanne Mulder","createdAt":"2026-02-02","weekStart":"2026-02-02","status":"in_discussion","meetingNeeded":true,"priority":"medium","dueDate":"2026-05-11","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Alex Vermeer","stakeholders":["Joost Jacobs","Mila Janssen"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Laura de Vries, 2026-02-06)"}]},
  {"id":"HJD00120","type":"contribution","title":"Documented standard operating procedure for returns handling","description":"Documented standard operating procedure for returns handling. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Convenience & Petrol","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Joost Jacobs","createdAt":"2026-01-25","weekStart":"2026-01-19","status":"new","meetingNeeded":false,"priority":"medium","dueDate":"","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Laura de Vries","Mark Jansen"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00121","type":"challenge","title":"Invoice discrepancy for promotional volume rebates","description":"Invoice discrepancy for promotional volume rebates. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Wholesalers","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Anna Peters","createdAt":"2026-02-28","weekStart":"2026-02-23","status":"escalated","meetingNeeded":true,"priority":"low","dueDate":"2026-06-03","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Ruben Smeets","stakeholders":["Bram de Jong","Fleur Hendriks"],"details":{"isRecurring":false,"escalationLevel":"senior_leadership","escalationTargetMeeting":"leadership_sync","escalationMeetingDate":"2026-05-17","escalatedTo":"Daan Meijer","escalationReason":"Requires higher-level coordination and cross-departmental alignment."},"updates":[{"type":"feedback","note":"Initial review completed. (Lisa Dekker, 2026-03-07)"}]},
  {"id":"HJD00122","type":"challenge","title":"Forecasting accuracy below target for seasonal launches","description":"Forecasting accuracy below target for seasonal launches. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Key Accounts Supermarkets","assignedToDept":"Operations","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Bram de Jong","createdAt":"2026-04-11","weekStart":"2026-04-06","status":"resolved","meetingNeeded":false,"priority":"high","dueDate":"2026-04-26","resolvedBy":"Mila Janssen","resolvedAt":"2026-05-28","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"Process"},"assignedTo":"Bram de Jong","stakeholders":["Bram de Jong","Joost Jacobs"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Damian de Groot, 2026-04-13)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00123","type":"contribution","title":"Built knowledge base article for EDI troubleshooting","description":"Built knowledge base article for EDI troubleshooting. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Jumbo & Discounters","assignedToDept":"","meetingLevel":"national_red","externalEmail":"","createdBy":"Luuk van den Berg","createdAt":"2026-01-31","weekStart":"2026-01-26","status":"in_discussion","meetingNeeded":false,"priority":"high","dueDate":"","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Jade Mulder","Daan Meijer"],"details":{"isRecurring":true},"updates":[]},
  {"id":"HJD00124","type":"contribution","title":"Shared cross-functional escalation protocol improvement","description":"Shared cross-functional escalation protocol improvement. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Trade Marketing","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Thijs Willems","createdAt":"2026-02-01","weekStart":"2026-01-26","status":"resolved","meetingNeeded":false,"priority":"high","dueDate":"","resolvedBy":"Rosa Brouwer","resolvedAt":"2026-02-17","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"compliance"},"assignedTo":"","stakeholders":["Joost Jacobs","Sanne Mulder"],"details":{"isRecurring":false},"updates":[{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00125","type":"challenge","title":"Warehouse capacity constraint during peak promotion weeks","description":"Warehouse capacity constraint during peak promotion weeks. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales South","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Laura de Vries","createdAt":"2026-02-21","weekStart":"2026-02-16","status":"resolved","meetingNeeded":false,"priority":"low","dueDate":"2026-04-29","resolvedBy":"Eva Bosman","resolvedAt":"2026-04-29","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"pricing"},"assignedTo":"Mark Jansen","stakeholders":["Mila Janssen","Mark Jansen"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Femke de Graaf, 2026-03-10)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00126","type":"challenge","title":"Returns processing backlog at central distribution centre","description":"Returns processing backlog at central distribution centre. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Jumbo & Discounters","assignedToDept":"Trade Marketing","meetingLevel":"regional_red","externalEmail":"","createdBy":"Niels Kuiper","createdAt":"2026-05-10","weekStart":"2026-05-04","status":"resolved","meetingNeeded":false,"priority":"low","dueDate":"2026-05-13","resolvedBy":"Mark Jansen","resolvedAt":"2026-05-29","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"External partner"},"assignedTo":"Pieter Vos","stakeholders":["Joost Jacobs","Lisa Dekker"],"details":{"isRecurring":false,"knowledgeReused":true,"knowledgeReuseSource":"HJD00072","knowledgeReuseTimestamp":"2026-05-10T10:00:00.000Z","meetingGate":{"matchedItemId":"HJD00072","similarity":0.81,"appliedAt":"2026-05-10"}},"updates":[{"type":"feedback","note":"Initial review completed. (Jade Mulder, 2026-05-11)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00127","type":"challenge","title":"New SKU listing delays in national supermarket chains","description":"New SKU listing delays in national supermarket chains. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales South","assignedToDept":"Field Sales North","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Luuk van den Berg","createdAt":"2026-02-18","weekStart":"2026-02-16","status":"new","meetingNeeded":true,"priority":"high","dueDate":"2026-03-27","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Bram de Jong","Sophie van Dijk"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00128","type":"challenge","title":"Price label mismatch at shelf level in convenience stores","description":"Price label mismatch at shelf level in convenience stores. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales North","assignedToDept":"","meetingLevel":"national_red","externalEmail":"","createdBy":"Rosa Brouwer","createdAt":"2026-04-13","weekStart":"2026-04-13","status":"escalated","meetingNeeded":true,"priority":"low","dueDate":"2026-06-07","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Emma Visser","stakeholders":["Ruben Smeets","Niels Kuiper"],"details":{"isRecurring":false,"escalationLevel":"team_lead","escalationTargetMeeting":"regional_red","escalationMeetingDate":"2026-05-07","escalatedTo":"Alex Vermeer","escalationReason":"Requires higher-level coordination and cross-departmental alignment."},"updates":[{"type":"feedback","note":"Initial review completed. (Mila Janssen, 2026-05-03)"}]},
  {"id":"HJD00129","type":"challenge","title":"Delivery window violations at key account warehouses","description":"Delivery window violations at key account warehouses. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Trade Marketing","assignedToDept":"Field Sales South","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Daan Meijer","createdAt":"2026-04-26","weekStart":"2026-04-20","status":"resolved","meetingNeeded":false,"priority":"low","dueDate":"2026-06-12","resolvedBy":"Niels Kuiper","resolvedAt":"2026-05-17","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"People"},"assignedTo":"Jonas Smit","stakeholders":["Daan Meijer","Niels Kuiper"],"details":{"isRecurring":false,"knowledgeReused":true,"knowledgeReuseSource":"HJD00077","knowledgeReuseTimestamp":"2026-04-26T10:00:00.000Z","meetingGate":{"matchedItemId":"HJD00077","similarity":0.8,"appliedAt":"2026-04-26"}},"updates":[{"type":"feedback","note":"Initial review completed. (Bram de Jong, 2026-05-31)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00130","type":"challenge","title":"Stock allocation imbalance between urban and rural stores","description":"Stock allocation imbalance between urban and rural stores. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Convenience & Petrol","assignedToDept":"","meetingLevel":"national_red","externalEmail":"","createdBy":"Niels Kuiper","createdAt":"2026-04-08","weekStart":"2026-04-06","status":"new","meetingNeeded":true,"priority":"medium","dueDate":"2026-06-10","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Mila Janssen"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00131","type":"challenge","title":"Promotional display compliance below 60 percent target","description":"Promotional display compliance below 60 percent target. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Key Accounts Supermarkets","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Daan Meijer","createdAt":"2026-05-01","weekStart":"2026-04-27","status":"closed","meetingNeeded":true,"priority":"high","dueDate":"2026-05-07","resolvedBy":"Luuk van den Berg","resolvedAt":"2026-05-16","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":null,"assignedTo":"Fleur Hendriks","stakeholders":["Emma Visser","Femke de Graaf"],"details":{"isRecurring":true},"updates":[{"type":"feedback","note":"Initial review completed. (Thijs Willems, 2026-05-06)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00132","type":"challenge","title":"Cold chain monitoring gaps during overnight transport","description":"Cold chain monitoring gaps during overnight transport. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Trade Marketing","assignedToDept":"","meetingLevel":"national_red","externalEmail":"","createdBy":"Jade Mulder","createdAt":"2026-04-13","weekStart":"2026-04-13","status":"new","meetingNeeded":true,"priority":"low","dueDate":"2026-04-28","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Laura de Vries","Bram de Jong"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00133","type":"celebration","title":"Successful zero waste initiative at southern DC","description":"Successful zero waste initiative at southern DC. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"E-commerce Sales","assignedToDept":"","meetingLevel":"national_red","externalEmail":"","createdBy":"Bram de Jong","createdAt":"2026-04-30","weekStart":"2026-04-27","status":"new","meetingNeeded":false,"priority":"low","dueDate":"","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Niels Kuiper","Mila Janssen"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00134","type":"celebration","title":"Regional team won internal innovation challenge","description":"Regional team won internal innovation challenge. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales North","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Mark Jansen","createdAt":"2026-04-08","weekStart":"2026-04-06","status":"in_discussion","meetingNeeded":false,"priority":"high","dueDate":"","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Sophie van Dijk","Mila Janssen"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00135","type":"contribution","title":"Developed new onboarding checklist for field sales reps","description":"Developed new onboarding checklist for field sales reps. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Key Accounts Supermarkets","assignedToDept":"","meetingLevel":"national_red","externalEmail":"","createdBy":"Pieter Vos","createdAt":"2026-02-17","weekStart":"2026-02-16","status":"closed","meetingNeeded":false,"priority":"medium","dueDate":"","resolvedBy":"Emma Visser","resolvedAt":"2026-03-05","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":null,"assignedTo":"","stakeholders":["Lisa Dekker","Sanne Mulder"],"details":{"isRecurring":false},"updates":[{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00136","type":"challenge","title":"Trade spend reconciliation errors in Q1 close","description":"Trade spend reconciliation errors in Q1 close. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"E-commerce Sales","assignedToDept":"Supply Chain","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Thijs Willems","createdAt":"2026-01-28","weekStart":"2026-01-26","status":"in_discussion","meetingNeeded":true,"priority":"high","dueDate":"2026-05-30","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Laura de Vries","stakeholders":["Luuk van den Berg","Jade Mulder"],"details":{"isRecurring":true},"updates":[{"type":"feedback","note":"Initial review completed. (Lisa Dekker, 2026-03-22)"}]},
  {"id":"HJD00137","type":"contribution","title":"Created store visit efficiency playbook for team","description":"Created store visit efficiency playbook for team. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Revenue Growth Management","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Damian de Groot","createdAt":"2026-02-02","weekStart":"2026-02-02","status":"closed","meetingNeeded":false,"priority":"high","dueDate":"","resolvedBy":"Mila Janssen","resolvedAt":"2026-03-21","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":null,"assignedTo":"","stakeholders":["Femke de Graaf","Luuk van den Berg"],"details":{"isRecurring":false},"updates":[{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00138","type":"celebration","title":"100 percent SLA compliance achievement for three months","description":"100 percent SLA compliance achievement for three months. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Key Accounts Supermarkets","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Eva Bosman","createdAt":"2026-03-26","weekStart":"2026-03-23","status":"assigned","meetingNeeded":false,"priority":"high","dueDate":"","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Emma Visser","Ruben Smeets"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00139","type":"challenge","title":"Competitor pricing intelligence data feed interruption","description":"Competitor pricing intelligence data feed interruption. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Wholesalers","assignedToDept":"","meetingLevel":"national_red","externalEmail":"","createdBy":"Emma Visser","createdAt":"2026-04-17","weekStart":"2026-04-13","status":"resolved","meetingNeeded":true,"priority":"high","dueDate":"2026-05-13","resolvedBy":"Tom Bakker","resolvedAt":"2026-05-29","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"Customer"},"assignedTo":"Mila Janssen","stakeholders":["Bram de Jong","Thijs Willems"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Eva Bosman, 2026-04-29)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00140","type":"challenge","title":"Digital coupon redemption failures on mobile app","description":"Digital coupon redemption failures on mobile app. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Jumbo & Discounters","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Daan Meijer","createdAt":"2026-04-28","weekStart":"2026-04-27","status":"closed","meetingNeeded":true,"priority":"high","dueDate":"2026-06-12","resolvedBy":"Jade Mulder","resolvedAt":"2026-04-29","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":null,"assignedTo":"Rosa Brouwer","stakeholders":["Femke de Graaf","Anna Peters"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Damian de Groot, 2026-05-07)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00141","type":"contribution","title":"Documented pricing exception workflow for reference","description":"Documented pricing exception workflow for reference. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Sales Operations","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Jonas Smit","createdAt":"2026-01-16","weekStart":"2026-01-12","status":"resolved","meetingNeeded":false,"priority":"low","dueDate":"","resolvedBy":"Damian de Groot","resolvedAt":"2026-05-02","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"Data"},"assignedTo":"","stakeholders":["Anna Peters","Damian de Groot"],"details":{"isRecurring":false},"updates":[{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00142","type":"challenge","title":"Master data synchronisation lag between ERP and WMS","description":"Master data synchronisation lag between ERP and WMS. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Trade Marketing","assignedToDept":"","meetingLevel":"national_red","externalEmail":"","createdBy":"Eva Bosman","createdAt":"2026-01-18","weekStart":"2026-01-12","status":"closed","meetingNeeded":true,"priority":"high","dueDate":"2026-04-16","resolvedBy":"Anna Peters","resolvedAt":"2026-02-12","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":null,"assignedTo":"Alex Vermeer","stakeholders":["Anna Peters","Sanne Mulder"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Rosa Brouwer, 2026-03-09)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00143","type":"challenge","title":"Planogram compliance audit revealing 30 percent deviation","description":"Planogram compliance audit revealing 30 percent deviation. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"E-commerce Sales","assignedToDept":"Finance","meetingLevel":"regional_red","externalEmail":"","createdBy":"Anna Peters","createdAt":"2026-02-15","weekStart":"2026-02-09","status":"new","meetingNeeded":true,"priority":"low","dueDate":"2026-03-13","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Eva Bosman","Bram de Jong"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00144","type":"challenge","title":"Route optimisation causing missed delivery windows","description":"Route optimisation causing missed delivery windows. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Trade Marketing","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Femke de Graaf","createdAt":"2026-01-20","weekStart":"2026-01-19","status":"resolved","meetingNeeded":true,"priority":"low","dueDate":"2026-04-22","resolvedBy":"Ruben Smeets","resolvedAt":"2026-04-11","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"Customer"},"assignedTo":"Bram de Jong","stakeholders":["Lisa Dekker","Fleur Hendriks"],"details":{"isRecurring":true},"updates":[{"type":"feedback","note":"Initial review completed. (Mark Jansen, 2026-02-02)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00145","type":"celebration","title":"New product launch exceeded target by 20 percent","description":"New product launch exceeded target by 20 percent. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Jumbo & Discounters","assignedToDept":"","meetingLevel":"national_red","externalEmail":"","createdBy":"Thijs Willems","createdAt":"2026-03-14","weekStart":"2026-03-09","status":"resolved","meetingNeeded":false,"priority":"high","dueDate":"","resolvedBy":"Thijs Willems","resolvedAt":"2026-05-26","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"System"},"assignedTo":"","stakeholders":["Mark Jansen","Jonas Smit"],"details":{"isRecurring":false},"updates":[{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00146","type":"celebration","title":"Cross-functional project completed ahead of schedule","description":"Cross-functional project completed ahead of schedule. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales North","assignedToDept":"","meetingLevel":"national_red","externalEmail":"","createdBy":"Niels Kuiper","createdAt":"2026-02-19","weekStart":"2026-02-16","status":"new","meetingNeeded":false,"priority":"high","dueDate":"","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Niels Kuiper","Joost Jacobs"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00147","type":"challenge","title":"Shelf-ready packaging quality issues from co-packer","description":"Shelf-ready packaging quality issues from co-packer. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"E-commerce Sales","assignedToDept":"","meetingLevel":"national_red","externalEmail":"","createdBy":"Luuk van den Berg","createdAt":"2026-05-05","weekStart":"2026-05-04","status":"resolved","meetingNeeded":false,"priority":"medium","dueDate":"2026-05-11","resolvedBy":"Emma Visser","resolvedAt":"2026-05-07","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"Customer"},"assignedTo":"Alex Vermeer","stakeholders":["Mark Jansen","Tom Bakker"],"details":{"isRecurring":false,"knowledgeReused":true,"knowledgeReuseSource":"HJD00087","knowledgeReuseTimestamp":"2026-05-05T10:00:00.000Z","meetingGate":{"matchedItemId":"HJD00087","similarity":0.85,"appliedAt":"2026-05-05"}},"updates":[{"type":"feedback","note":"Initial review completed. (Jade Mulder, 2026-05-10)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00148","type":"challenge","title":"Retailer portal access issues after system migration","description":"Retailer portal access issues after system migration. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Wholesalers","assignedToDept":"IT","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Femke de Graaf","createdAt":"2026-03-20","weekStart":"2026-03-16","status":"resolved","meetingNeeded":false,"priority":"high","dueDate":"2026-05-28","resolvedBy":"Daan Meijer","resolvedAt":"2026-04-28","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"External partner"},"assignedTo":"Rosa Brouwer","stakeholders":["Fleur Hendriks","Alex Vermeer"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Tom Bakker, 2026-04-23)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00149","type":"challenge","title":"Seasonal stock build-up exceeding warehouse capacity","description":"Seasonal stock build-up exceeding warehouse capacity. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Trade Marketing","assignedToDept":"Finance","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Luuk van den Berg","createdAt":"2026-04-10","weekStart":"2026-04-06","status":"resolved","meetingNeeded":true,"priority":"low","dueDate":"2026-06-02","resolvedBy":"Lisa Dekker","resolvedAt":"2026-04-19","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"External partner"},"assignedTo":"Luuk van den Berg","stakeholders":["Joost Jacobs","Lisa Dekker"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Eva Bosman, 2026-05-17)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00150","type":"challenge","title":"Vending machine telemetry data gaps in northern region","description":"Vending machine telemetry data gaps in northern region. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Convenience & Petrol","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Jade Mulder","createdAt":"2026-01-23","weekStart":"2026-01-19","status":"new","meetingNeeded":true,"priority":"medium","dueDate":"2026-04-17","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Alex Vermeer","Daan Meijer"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00151","type":"challenge","title":"Category review preparation data incomplete for buyer meeting","description":"Category review preparation data incomplete for buyer meeting. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Revenue Growth Management","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Mark Jansen","createdAt":"2026-03-16","weekStart":"2026-03-16","status":"new","meetingNeeded":true,"priority":"medium","dueDate":"2026-04-17","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Luuk van den Berg","Bram de Jong"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00152","type":"contribution","title":"Built reusable promotional compliance checklist","description":"Built reusable promotional compliance checklist. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Wholesalers","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Sanne Mulder","createdAt":"2026-05-13","weekStart":"2026-05-11","status":"closed","meetingNeeded":false,"priority":"high","dueDate":"","resolvedBy":"Thijs Willems","resolvedAt":"2026-05-14","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":null,"assignedTo":"","stakeholders":["Mila Janssen","Niels Kuiper"],"details":{"isRecurring":true},"updates":[{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00153","type":"challenge","title":"New product launch sampling distribution behind schedule","description":"New product launch sampling distribution behind schedule. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Revenue Growth Management","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Tom Bakker","createdAt":"2026-02-05","weekStart":"2026-02-02","status":"resolved","meetingNeeded":false,"priority":"high","dueDate":"2026-05-21","resolvedBy":"Laura de Vries","resolvedAt":"2026-04-27","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"System"},"assignedTo":"Fleur Hendriks","stakeholders":["Eva Bosman","Daan Meijer"],"details":{"isRecurring":false,"knowledgeReused":true,"knowledgeReuseSource":"HJD00075","knowledgeReuseTimestamp":"2026-02-05T10:00:00.000Z","meetingGate":{"matchedItemId":"HJD00075","similarity":0.86,"appliedAt":"2026-02-05"}},"updates":[{"type":"feedback","note":"Initial review completed. (Thijs Willems, 2026-03-20)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00154","type":"challenge","title":"Cross-border order fulfilment delays due to customs changes","description":"Cross-border order fulfilment delays due to customs changes. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Jumbo & Discounters","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Anna Peters","createdAt":"2026-03-01","weekStart":"2026-02-23","status":"escalated","meetingNeeded":false,"priority":"medium","dueDate":"2026-04-03","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Sophie van Dijk","stakeholders":["Jonas Smit","Pieter Vos"],"details":{"isRecurring":false,"escalationLevel":"senior_leadership","escalationTargetMeeting":"leadership_sync","escalationMeetingDate":"2026-04-04","escalatedTo":"Ruben Smeets","escalationReason":"Requires higher-level coordination and cross-departmental alignment."},"updates":[{"type":"feedback","note":"Initial review completed. (Joost Jacobs, 2026-03-05)"}]},
  {"id":"HJD00155","type":"challenge","title":"Promotion mechanic error causing double discount at checkout","description":"Promotion mechanic error causing double discount at checkout. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Sales Operations","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Sophie van Dijk","createdAt":"2026-03-24","weekStart":"2026-03-23","status":"resolved","meetingNeeded":true,"priority":"medium","dueDate":"2026-04-24","resolvedBy":"Pieter Vos","resolvedAt":"2026-05-17","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"Process"},"assignedTo":"Anna Peters","stakeholders":["Laura de Vries","Lisa Dekker"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Damian de Groot, 2026-04-09)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00156","type":"challenge","title":"Field team tablet app sync failures in low connectivity areas","description":"Field team tablet app sync failures in low connectivity areas. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Jumbo & Discounters","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Sophie van Dijk","createdAt":"2026-01-27","weekStart":"2026-01-26","status":"new","meetingNeeded":true,"priority":"medium","dueDate":"2026-03-10","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Rosa Brouwer","Sophie van Dijk"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00157","type":"celebration","title":"Field team achieved zero safety incidents for quarter","description":"Field team achieved zero safety incidents for quarter. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Convenience & Petrol","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Luuk van den Berg","createdAt":"2026-02-05","weekStart":"2026-02-02","status":"resolved","meetingNeeded":false,"priority":"low","dueDate":"","resolvedBy":"Luuk van den Berg","resolvedAt":"2026-05-29","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"stock"},"assignedTo":"","stakeholders":["Rosa Brouwer","Lisa Dekker"],"details":{"isRecurring":false},"updates":[{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00158","type":"challenge","title":"Product recall communication chain incomplete at store level","description":"Product recall communication chain incomplete at store level. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Wholesalers","assignedToDept":"Field Sales North","meetingLevel":"national_red","externalEmail":"","createdBy":"Laura de Vries","createdAt":"2026-02-09","weekStart":"2026-02-09","status":"assigned","meetingNeeded":true,"priority":"medium","dueDate":"2026-02-11","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Emma Visser","stakeholders":["Jonas Smit","Sophie van Dijk"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Niels Kuiper, 2026-02-09)"}]},
  {"id":"HJD00159","type":"challenge","title":"Revenue leakage from untracked off-invoice deductions","description":"Revenue leakage from untracked off-invoice deductions. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Key Accounts Supermarkets","assignedToDept":"Key Accounts Supermarkets","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Thijs Willems","createdAt":"2026-04-06","weekStart":"2026-04-06","status":"assigned","meetingNeeded":false,"priority":"medium","dueDate":"2026-04-16","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Anna Peters","stakeholders":["Mila Janssen","Tom Bakker"],"details":{"isRecurring":true},"updates":[{"type":"feedback","note":"Initial review completed. (Daan Meijer, 2026-04-15)"}]},
  {"id":"HJD00160","type":"challenge","title":"Sustainability reporting data collection gaps in supply chain","description":"Sustainability reporting data collection gaps in supply chain. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales South","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Laura de Vries","createdAt":"2026-03-23","weekStart":"2026-03-23","status":"new","meetingNeeded":true,"priority":"medium","dueDate":"2026-03-24","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Bram de Jong","Ruben Smeets"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00161","type":"challenge","title":"E-commerce product content not meeting retailer specifications","description":"E-commerce product content not meeting retailer specifications. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"E-commerce Sales","assignedToDept":"Operations","meetingLevel":"national_red","externalEmail":"","createdBy":"Rosa Brouwer","createdAt":"2026-01-27","weekStart":"2026-01-26","status":"new","meetingNeeded":true,"priority":"high","dueDate":"2026-01-28","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Sanne Mulder","Alex Vermeer"],"details":{"isRecurring":true},"updates":[]},
  {"id":"HJD00162","type":"challenge","title":"Trade marketing budget tracking spreadsheet errors","description":"Trade marketing budget tracking spreadsheet errors. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Key Accounts Supermarkets","assignedToDept":"Operations","meetingLevel":"national_red","externalEmail":"","createdBy":"Femke de Graaf","createdAt":"2026-03-12","weekStart":"2026-03-09","status":"assigned","meetingNeeded":true,"priority":"medium","dueDate":"2026-06-03","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Jonas Smit","stakeholders":["Luuk van den Berg","Daan Meijer"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Sanne Mulder, 2026-04-15)"}]},
  {"id":"HJD00163","type":"challenge","title":"Store-level sales data feed delay affecting dashboards","description":"Store-level sales data feed delay affecting dashboards. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Jumbo & Discounters","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Mila Janssen","createdAt":"2026-05-14","weekStart":"2026-05-11","status":"new","meetingNeeded":true,"priority":"low","dueDate":"2026-05-31","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Damian de Groot","Tom Bakker"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00164","type":"challenge","title":"Damaged goods claim process taking over 30 days","description":"Damaged goods claim process taking over 30 days. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Jumbo & Discounters","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Tom Bakker","createdAt":"2026-04-30","weekStart":"2026-04-27","status":"new","meetingNeeded":true,"priority":"medium","dueDate":"2026-05-05","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Rosa Brouwer","Mark Jansen"],"details":{"isRecurring":true},"updates":[]},
  {"id":"HJD00165","type":"challenge","title":"New distributor onboarding documentation incomplete","description":"New distributor onboarding documentation incomplete. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales North","assignedToDept":"Finance","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Tom Bakker","createdAt":"2026-01-18","weekStart":"2026-01-12","status":"resolved","meetingNeeded":false,"priority":"medium","dueDate":"2026-04-08","resolvedBy":"Laura de Vries","resolvedAt":"2026-04-09","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"stock"},"assignedTo":"Alex Vermeer","stakeholders":["Rosa Brouwer","Jade Mulder"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Tom Bakker, 2026-04-06)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00166","type":"challenge","title":"Promotional gondola end allocation conflict between brands","description":"Promotional gondola end allocation conflict between brands. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Trade Marketing","assignedToDept":"Legal","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Fleur Hendriks","createdAt":"2026-01-23","weekStart":"2026-01-19","status":"resolved","meetingNeeded":false,"priority":"medium","dueDate":"2026-05-17","resolvedBy":"Femke de Graaf","resolvedAt":"2026-01-25","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"System"},"assignedTo":"Fleur Hendriks","stakeholders":["Lisa Dekker","Damian de Groot"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Lisa Dekker, 2026-04-03)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00167","type":"challenge","title":"Night delivery noise complaints at urban store locations","description":"Night delivery noise complaints at urban store locations. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Revenue Growth Management","assignedToDept":"Finance","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Ruben Smeets","createdAt":"2026-04-13","weekStart":"2026-04-13","status":"assigned","meetingNeeded":true,"priority":"low","dueDate":"2026-04-14","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Anna Peters","stakeholders":["Bram de Jong","Sophie van Dijk"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Emma Visser, 2026-04-13)"}]},
  {"id":"HJD00168","type":"challenge","title":"Product shelf life concern for slow-moving SKUs","description":"Product shelf life concern for slow-moving SKUs. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales North","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Sophie van Dijk","createdAt":"2026-05-04","weekStart":"2026-05-04","status":"new","meetingNeeded":true,"priority":"high","dueDate":"2026-05-14","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Laura de Vries","Mark Jansen"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00169","type":"challenge","title":"Regional sales target misalignment after territory restructure","description":"Regional sales target misalignment after territory restructure. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"E-commerce Sales","assignedToDept":"","meetingLevel":"national_red","externalEmail":"","createdBy":"Laura de Vries","createdAt":"2026-03-01","weekStart":"2026-02-23","status":"resolved","meetingNeeded":true,"priority":"high","dueDate":"2026-03-12","resolvedBy":"Lisa Dekker","resolvedAt":"2026-03-19","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"compliance"},"assignedTo":"Thijs Willems","stakeholders":["Daan Meijer","Mark Jansen"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Pieter Vos, 2026-03-11)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00170","type":"challenge","title":"Loyalty programme integration issues with retailer app","description":"Loyalty programme integration issues with retailer app. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Revenue Growth Management","assignedToDept":"Trade Marketing","meetingLevel":"regional_red","externalEmail":"","createdBy":"Jonas Smit","createdAt":"2026-03-15","weekStart":"2026-03-09","status":"assigned","meetingNeeded":true,"priority":"high","dueDate":"2026-04-09","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Femke de Graaf","stakeholders":["Thijs Willems","Femke de Graaf"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Anna Peters, 2026-03-23)"}]},
  {"id":"HJD00171","type":"contribution","title":"Shared competitive intelligence collection methodology","description":"Shared competitive intelligence collection methodology. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Revenue Growth Management","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Daan Meijer","createdAt":"2026-02-17","weekStart":"2026-02-16","status":"assigned","meetingNeeded":false,"priority":"low","dueDate":"","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Bram de Jong","Anna Peters"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00172","type":"challenge","title":"Packaging artwork error on limited edition product","description":"Packaging artwork error on limited edition product. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Revenue Growth Management","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Anna Peters","createdAt":"2026-02-06","weekStart":"2026-02-02","status":"resolved","meetingNeeded":false,"priority":"high","dueDate":"2026-04-14","resolvedBy":"Fleur Hendriks","resolvedAt":"2026-05-30","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"Process"},"assignedTo":"Thijs Willems","stakeholders":["Pieter Vos","Niels Kuiper"],"details":{"isRecurring":false,"knowledgeReused":true,"knowledgeReuseSource":"HJD00013","knowledgeReuseTimestamp":"2026-02-06T10:00:00.000Z","meetingGate":{"matchedItemId":"HJD00013","similarity":0.86,"appliedAt":"2026-02-06"}},"updates":[{"type":"feedback","note":"Initial review completed. (Bram de Jong, 2026-03-02)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00173","type":"celebration","title":"E-commerce growth milestone reaching double digits","description":"E-commerce growth milestone reaching double digits. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Revenue Growth Management","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Laura de Vries","createdAt":"2026-04-16","weekStart":"2026-04-13","status":"resolved","meetingNeeded":false,"priority":"high","dueDate":"","resolvedBy":"Mark Jansen","resolvedAt":"2026-05-24","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"System"},"assignedTo":"","stakeholders":["Sophie van Dijk","Pieter Vos"],"details":{"isRecurring":true},"updates":[{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00174","type":"celebration","title":"Customer satisfaction index highest in five years","description":"Customer satisfaction index highest in five years. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"E-commerce Sales","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Jade Mulder","createdAt":"2026-04-19","weekStart":"2026-04-13","status":"resolved","meetingNeeded":false,"priority":"low","dueDate":"","resolvedBy":"Eva Bosman","resolvedAt":"2026-05-08","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"pricing"},"assignedTo":"","stakeholders":["Anna Peters","Sophie van Dijk"],"details":{"isRecurring":false},"updates":[{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00175","type":"celebration","title":"Record quarterly volume in convenience channel","description":"Record quarterly volume in convenience channel. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Convenience & Petrol","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Lisa Dekker","createdAt":"2026-02-14","weekStart":"2026-02-09","status":"escalated","meetingNeeded":false,"priority":"medium","dueDate":"","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Fleur Hendriks","Sanne Mulder"],"details":{"isRecurring":false,"escalationLevel":"team_lead","escalationTargetMeeting":"regional_red","escalationMeetingDate":"2026-04-22","escalatedTo":"Laura de Vries","escalationReason":"Requires higher-level coordination and cross-departmental alignment."},"updates":[]},
  {"id":"HJD00176","type":"challenge","title":"Store execution audit scoring inconsistency between regions","description":"Store execution audit scoring inconsistency between regions. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Revenue Growth Management","assignedToDept":"Legal","meetingLevel":"national_red","externalEmail":"","createdBy":"Eva Bosman","createdAt":"2026-04-16","weekStart":"2026-04-13","status":"resolved","meetingNeeded":false,"priority":"high","dueDate":"2026-05-02","resolvedBy":"Pieter Vos","resolvedAt":"2026-04-18","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"pricing"},"assignedTo":"Sanne Mulder","stakeholders":["Rosa Brouwer","Joost Jacobs"],"details":{"isRecurring":true,"knowledgeReused":true,"knowledgeReuseSource":"HJD00046","knowledgeReuseTimestamp":"2026-04-16T10:00:00.000Z","meetingGate":{"matchedItemId":"HJD00046","similarity":0.66,"appliedAt":"2026-04-16"}},"updates":[{"type":"feedback","note":"Initial review completed. (Mark Jansen, 2026-04-20)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00177","type":"challenge","title":"Supply chain visibility gap for imported ingredients","description":"Supply chain visibility gap for imported ingredients. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Wholesalers","assignedToDept":"Trade Marketing","meetingLevel":"regional_red","externalEmail":"","createdBy":"Bram de Jong","createdAt":"2026-02-21","weekStart":"2026-02-16","status":"resolved","meetingNeeded":true,"priority":"low","dueDate":"2026-05-19","resolvedBy":"Rosa Brouwer","resolvedAt":"2026-03-08","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"stock"},"assignedTo":"Femke de Graaf","stakeholders":["Eva Bosman","Mila Janssen"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Pieter Vos, 2026-04-02)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00178","type":"celebration","title":"Team achieved highest NPS score in company history","description":"Team achieved highest NPS score in company history. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Convenience & Petrol","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Daan Meijer","createdAt":"2026-04-29","weekStart":"2026-04-27","status":"resolved","meetingNeeded":false,"priority":"medium","dueDate":"","resolvedBy":"Rosa Brouwer","resolvedAt":"2026-05-01","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"Process"},"assignedTo":"","stakeholders":["Jade Mulder","Lisa Dekker"],"details":{"isRecurring":false},"updates":[{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00179","type":"challenge","title":"Credit note processing delay affecting retailer relationship","description":"Credit note processing delay affecting retailer relationship. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Sales Operations","assignedToDept":"Field Sales North","meetingLevel":"national_red","externalEmail":"","createdBy":"Thijs Willems","createdAt":"2026-03-25","weekStart":"2026-03-23","status":"resolved","meetingNeeded":true,"priority":"medium","dueDate":"2026-05-22","resolvedBy":"Mark Jansen","resolvedAt":"2026-05-05","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"People"},"assignedTo":"Daan Meijer","stakeholders":["Niels Kuiper","Anna Peters"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Sanne Mulder, 2026-04-27)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00180","type":"challenge","title":"Field sales routing algorithm not considering store priorities","description":"Field sales routing algorithm not considering store priorities. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Sales Operations","assignedToDept":"Field Sales North","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Sophie van Dijk","createdAt":"2026-04-24","weekStart":"2026-04-20","status":"assigned","meetingNeeded":true,"priority":"high","dueDate":"2026-06-14","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Sophie van Dijk","stakeholders":["Tom Bakker","Emma Visser"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Sophie van Dijk, 2026-05-20)"}]},
  {"id":"HJD00181","type":"contribution","title":"Shared best practice for promo execution across regions","description":"Shared best practice for promo execution across regions. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Revenue Growth Management","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Laura de Vries","createdAt":"2026-03-31","weekStart":"2026-03-30","status":"resolved","meetingNeeded":false,"priority":"low","dueDate":"","resolvedBy":"Laura de Vries","resolvedAt":"2026-03-31","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"External partner"},"assignedTo":"","stakeholders":["Rosa Brouwer","Pieter Vos"],"details":{"isRecurring":false},"updates":[{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00182","type":"challenge","title":"POS material delivery timing misaligned with promo start","description":"POS material delivery timing misaligned with promo start. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Trade Marketing","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Niels Kuiper","createdAt":"2026-04-15","weekStart":"2026-04-13","status":"resolved","meetingNeeded":false,"priority":"medium","dueDate":"2026-04-26","resolvedBy":"Lisa Dekker","resolvedAt":"2026-04-23","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"pricing"},"assignedTo":"Anna Peters","stakeholders":["Laura de Vries","Sanne Mulder"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Fleur Hendriks, 2026-04-21)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00183","type":"challenge","title":"Stock transfer between DCs causing phantom inventory","description":"Stock transfer between DCs causing phantom inventory. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales South","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Anna Peters","createdAt":"2026-01-15","weekStart":"2026-01-12","status":"resolved","meetingNeeded":false,"priority":"low","dueDate":"2026-05-06","resolvedBy":"Rosa Brouwer","resolvedAt":"2026-04-18","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"pricing"},"assignedTo":"Daan Meijer","stakeholders":["Mila Janssen","Tom Bakker"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Pieter Vos, 2026-02-11)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00184","type":"contribution","title":"Created automated reporting template for weekly sales review","description":"Created automated reporting template for weekly sales review. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Wholesalers","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Niels Kuiper","createdAt":"2026-03-14","weekStart":"2026-03-09","status":"new","meetingNeeded":false,"priority":"low","dueDate":"","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Lisa Dekker","Thijs Willems"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00185","type":"celebration","title":"Successful zero waste initiative at southern DC","description":"Successful zero waste initiative at southern DC. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Trade Marketing","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Sanne Mulder","createdAt":"2026-04-26","weekStart":"2026-04-20","status":"assigned","meetingNeeded":false,"priority":"high","dueDate":"","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Sanne Mulder","Eva Bosman"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00186","type":"challenge","title":"Retailer compliance penalty for delivery appointment violations","description":"Retailer compliance penalty for delivery appointment violations. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Convenience & Petrol","assignedToDept":"Field Sales North","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Laura de Vries","createdAt":"2026-05-09","weekStart":"2026-05-04","status":"assigned","meetingNeeded":false,"priority":"low","dueDate":"2026-05-12","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Anna Peters","stakeholders":["Niels Kuiper","Damian de Groot"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Mila Janssen, 2026-05-09)"}]},
  {"id":"HJD00187","type":"challenge","title":"Category space reduction at key account without prior notice","description":"Category space reduction at key account without prior notice. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Convenience & Petrol","assignedToDept":"Field Sales North","meetingLevel":"national_red","externalEmail":"","createdBy":"Luuk van den Berg","createdAt":"2026-01-25","weekStart":"2026-01-19","status":"resolved","meetingNeeded":false,"priority":"high","dueDate":"2026-04-02","resolvedBy":"Damian de Groot","resolvedAt":"2026-02-08","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"pricing"},"assignedTo":"Alex Vermeer","stakeholders":["Mark Jansen","Luuk van den Berg"],"details":{"isRecurring":false,"knowledgeReused":true,"knowledgeReuseSource":"HJD00033","knowledgeReuseTimestamp":"2026-01-25T10:00:00.000Z","meetingGate":{"matchedItemId":"HJD00033","similarity":0.94,"appliedAt":"2026-01-25"}},"updates":[{"type":"feedback","note":"Initial review completed. (Femke de Graaf, 2026-03-17)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00188","type":"challenge","title":"Seasonal demand spike not reflected in production planning","description":"Seasonal demand spike not reflected in production planning. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales North","assignedToDept":"Trade Marketing","meetingLevel":"regional_red","externalEmail":"","createdBy":"Sanne Mulder","createdAt":"2026-01-24","weekStart":"2026-01-19","status":"new","meetingNeeded":true,"priority":"medium","dueDate":"2026-03-31","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Rosa Brouwer","Damian de Groot"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00189","type":"challenge","title":"E-commerce order cancellation rate increasing beyond threshold","description":"E-commerce order cancellation rate increasing beyond threshold. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Jumbo & Discounters","assignedToDept":"Finance","meetingLevel":"national_red","externalEmail":"","createdBy":"Sophie van Dijk","createdAt":"2026-04-20","weekStart":"2026-04-20","status":"resolved","meetingNeeded":true,"priority":"medium","dueDate":"2026-05-16","resolvedBy":"Anna Peters","resolvedAt":"2026-04-23","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"External partner"},"assignedTo":"Ruben Smeets","stakeholders":["Mila Janssen","Damian de Groot"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Jonas Smit, 2026-04-29)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00190","type":"challenge","title":"Wholesaler minimum order quantity causing small store stockouts","description":"Wholesaler minimum order quantity causing small store stockouts. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Convenience & Petrol","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Niels Kuiper","createdAt":"2026-04-20","weekStart":"2026-04-20","status":"assigned","meetingNeeded":false,"priority":"medium","dueDate":"2026-05-12","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Fleur Hendriks","stakeholders":["Sophie van Dijk","Ruben Smeets"],"details":{"isRecurring":true},"updates":[{"type":"feedback","note":"Initial review completed. (Jonas Smit, 2026-04-22)"}]},
  {"id":"HJD00191","type":"challenge","title":"Trade promotion ROI calculation methodology inconsistency","description":"Trade promotion ROI calculation methodology inconsistency. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Wholesalers","assignedToDept":"Supply Chain","meetingLevel":"regional_red","externalEmail":"","createdBy":"Sanne Mulder","createdAt":"2026-03-28","weekStart":"2026-03-23","status":"escalated","meetingNeeded":true,"priority":"high","dueDate":"2026-04-02","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Thijs Willems","stakeholders":["Niels Kuiper","Jonas Smit"],"details":{"isRecurring":false,"escalationLevel":"senior_leadership","escalationTargetMeeting":"regional_red","escalationMeetingDate":"2026-05-28","escalatedTo":"Luuk van den Berg","escalationReason":"Requires higher-level coordination and cross-departmental alignment."},"updates":[{"type":"feedback","note":"Initial review completed. (Femke de Graaf, 2026-04-01)"}]},
  {"id":"HJD00192","type":"challenge","title":"Field team overtime hours exceeding budget by 15 percent","description":"Field team overtime hours exceeding budget by 15 percent. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Convenience & Petrol","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Sanne Mulder","createdAt":"2026-03-16","weekStart":"2026-03-16","status":"in_discussion","meetingNeeded":true,"priority":"medium","dueDate":"2026-03-31","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Bram de Jong","stakeholders":["Sanne Mulder","Tom Bakker"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Mila Janssen, 2026-03-24)"}]},
  {"id":"HJD00193","type":"challenge","title":"New hire onboarding gap for sales technology tools","description":"New hire onboarding gap for sales technology tools. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Jumbo & Discounters","assignedToDept":"Field Sales South","meetingLevel":"regional_red","externalEmail":"","createdBy":"Sophie van Dijk","createdAt":"2026-04-22","weekStart":"2026-04-20","status":"new","meetingNeeded":true,"priority":"low","dueDate":"2026-05-12","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Ruben Smeets","Luuk van den Berg"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00194","type":"challenge","title":"Product availability dashboard showing incorrect real-time data","description":"Product availability dashboard showing incorrect real-time data. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"E-commerce Sales","assignedToDept":"IT","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Mila Janssen","createdAt":"2026-03-06","weekStart":"2026-03-02","status":"resolved","meetingNeeded":true,"priority":"high","dueDate":"2026-05-21","resolvedBy":"Ruben Smeets","resolvedAt":"2026-03-13","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"Data"},"assignedTo":"Pieter Vos","stakeholders":["Daan Meijer","Sanne Mulder"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Laura de Vries, 2026-04-04)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00195","type":"challenge","title":"Customer complaint resolution SLA breach at contact centre","description":"Customer complaint resolution SLA breach at contact centre. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales North","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Jade Mulder","createdAt":"2026-01-31","weekStart":"2026-01-26","status":"new","meetingNeeded":true,"priority":"high","dueDate":"2026-02-27","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Jade Mulder","Eva Bosman"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00196","type":"challenge","title":"Distributor invoice payment terms dispute resolution needed","description":"Distributor invoice payment terms dispute resolution needed. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Trade Marketing","assignedToDept":"HR","meetingLevel":"regional_red","externalEmail":"","createdBy":"Femke de Graaf","createdAt":"2026-05-10","weekStart":"2026-05-04","status":"resolved","meetingNeeded":false,"priority":"high","dueDate":"2026-05-27","resolvedBy":"Anna Peters","resolvedAt":"2026-05-30","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"compliance"},"assignedTo":"Bram de Jong","stakeholders":["Damian de Groot","Rosa Brouwer"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Lisa Dekker, 2026-05-14)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00197","type":"celebration","title":"Regional team won internal innovation challenge","description":"Regional team won internal innovation challenge. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Sales Operations","assignedToDept":"","meetingLevel":"national_red","externalEmail":"","createdBy":"Sophie van Dijk","createdAt":"2026-02-23","weekStart":"2026-02-23","status":"resolved","meetingNeeded":false,"priority":"low","dueDate":"","resolvedBy":"Luuk van den Berg","resolvedAt":"2026-04-11","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"compliance"},"assignedTo":"","stakeholders":["Ruben Smeets","Emma Visser"],"details":{"isRecurring":false},"updates":[{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00198","type":"celebration","title":"100 percent SLA compliance achievement for three months","description":"100 percent SLA compliance achievement for three months. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Jumbo & Discounters","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Eva Bosman","createdAt":"2026-04-20","weekStart":"2026-04-20","status":"resolved","meetingNeeded":false,"priority":"low","dueDate":"","resolvedBy":"Daan Meijer","resolvedAt":"2026-05-26","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"stock"},"assignedTo":"","stakeholders":["Fleur Hendriks","Mila Janssen"],"details":{"isRecurring":false},"updates":[{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00199","type":"celebration","title":"New product launch exceeded target by 20 percent","description":"New product launch exceeded target by 20 percent. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Trade Marketing","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Alex Vermeer","createdAt":"2026-05-10","weekStart":"2026-05-04","status":"in_discussion","meetingNeeded":false,"priority":"medium","dueDate":"","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Bram de Jong","Daan Meijer"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00200","type":"challenge","title":"In-store demo staffing shortage for weekend activations","description":"In-store demo staffing shortage for weekend activations. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Jumbo & Discounters","assignedToDept":"","meetingLevel":"national_red","externalEmail":"","createdBy":"Rosa Brouwer","createdAt":"2026-04-16","weekStart":"2026-04-13","status":"new","meetingNeeded":true,"priority":"high","dueDate":"2026-06-12","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Daan Meijer","Thijs Willems"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00201","type":"challenge","title":"Export documentation errors causing shipment holds","description":"Export documentation errors causing shipment holds. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Trade Marketing","assignedToDept":"Key Accounts Supermarkets","meetingLevel":"regional_red","externalEmail":"","createdBy":"Sophie van Dijk","createdAt":"2026-03-16","weekStart":"2026-03-16","status":"in_discussion","meetingNeeded":true,"priority":"high","dueDate":"2026-05-04","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Laura de Vries","stakeholders":["Lisa Dekker","Damian de Groot"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Luuk van den Berg, 2026-04-01)"}]},
  {"id":"HJD00202","type":"challenge","title":"Regional pricing strategy misalignment with national guidelines","description":"Regional pricing strategy misalignment with national guidelines. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Sales Operations","assignedToDept":"IT","meetingLevel":"national_red","externalEmail":"","createdBy":"Lisa Dekker","createdAt":"2026-02-19","weekStart":"2026-02-16","status":"in_discussion","meetingNeeded":false,"priority":"high","dueDate":"2026-05-04","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Emma Visser","stakeholders":["Pieter Vos"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Tom Bakker, 2026-04-16)"}]},
  {"id":"HJD00203","type":"challenge","title":"Supply chain carbon footprint reporting inconsistency","description":"Supply chain carbon footprint reporting inconsistency. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales North","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Ruben Smeets","createdAt":"2026-02-21","weekStart":"2026-02-16","status":"resolved","meetingNeeded":true,"priority":"high","dueDate":"2026-03-12","resolvedBy":"Daan Meijer","resolvedAt":"2026-05-29","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"compliance"},"assignedTo":"Mila Janssen","stakeholders":["Fleur Hendriks","Joost Jacobs"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Jonas Smit, 2026-02-21)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00204","type":"challenge","title":"Retailer data sharing agreement renewal deadline approaching","description":"Retailer data sharing agreement renewal deadline approaching. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Sales Operations","assignedToDept":"IT","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Jade Mulder","createdAt":"2026-04-25","weekStart":"2026-04-20","status":"escalated","meetingNeeded":false,"priority":"medium","dueDate":"2026-05-25","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Jade Mulder","stakeholders":["Luuk van den Berg","Bram de Jong"],"details":{"isRecurring":false,"escalationLevel":"senior_leadership","escalationTargetMeeting":"leadership_sync","escalationMeetingDate":"2026-04-26","escalatedTo":"Daan Meijer","escalationReason":"Requires higher-level coordination and cross-departmental alignment."},"updates":[{"type":"feedback","note":"Initial review completed. (Lisa Dekker, 2026-05-16)"}]},
  {"id":"HJD00205","type":"challenge","title":"Display fridge temperature monitoring system offline at stores","description":"Display fridge temperature monitoring system offline at stores. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Revenue Growth Management","assignedToDept":"Finance","meetingLevel":"national_red","externalEmail":"","createdBy":"Niels Kuiper","createdAt":"2026-05-14","weekStart":"2026-05-11","status":"assigned","meetingNeeded":true,"priority":"high","dueDate":"2026-05-25","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Bram de Jong","stakeholders":["Damian de Groot","Bram de Jong"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Jonas Smit, 2026-05-21)"}]},
  {"id":"HJD00206","type":"challenge","title":"Sales incentive calculation error in monthly payout","description":"Sales incentive calculation error in monthly payout. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"E-commerce Sales","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Niels Kuiper","createdAt":"2026-02-22","weekStart":"2026-02-16","status":"resolved","meetingNeeded":true,"priority":"high","dueDate":"2026-06-12","resolvedBy":"Sanne Mulder","resolvedAt":"2026-04-28","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"logistics"},"assignedTo":"Alex Vermeer","stakeholders":["Mila Janssen","Pieter Vos"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Bram de Jong, 2026-03-02)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00207","type":"contribution","title":"Documented standard operating procedure for returns handling","description":"Documented standard operating procedure for returns handling. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Jumbo & Discounters","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Damian de Groot","createdAt":"2026-03-25","weekStart":"2026-03-23","status":"resolved","meetingNeeded":false,"priority":"medium","dueDate":"","resolvedBy":"Lisa Dekker","resolvedAt":"2026-04-27","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"compliance"},"assignedTo":"","stakeholders":["Lisa Dekker","Daan Meijer"],"details":{"isRecurring":false},"updates":[{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00208","type":"challenge","title":"Cross-functional alignment gap on NPD launch timeline","description":"Cross-functional alignment gap on NPD launch timeline. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Key Accounts Supermarkets","assignedToDept":"IT","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Tom Bakker","createdAt":"2026-02-12","weekStart":"2026-02-09","status":"resolved","meetingNeeded":true,"priority":"high","dueDate":"2026-02-21","resolvedBy":"Daan Meijer","resolvedAt":"2026-03-15","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"Customer"},"assignedTo":"Fleur Hendriks","stakeholders":["Lisa Dekker","Mark Jansen"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Mila Janssen, 2026-02-16)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00209","type":"challenge","title":"Warehouse picking error rate above acceptable threshold","description":"Warehouse picking error rate above acceptable threshold. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Key Accounts Supermarkets","assignedToDept":"IT","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Ruben Smeets","createdAt":"2026-01-15","weekStart":"2026-01-12","status":"assigned","meetingNeeded":false,"priority":"medium","dueDate":"2026-05-14","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Rosa Brouwer","stakeholders":["Damian de Groot","Joost Jacobs"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Laura de Vries, 2026-01-21)"}]},
  {"id":"HJD00210","type":"challenge","title":"Retailer markdown request for slow-moving seasonal stock","description":"Retailer markdown request for slow-moving seasonal stock. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"E-commerce Sales","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Femke de Graaf","createdAt":"2026-04-17","weekStart":"2026-04-13","status":"resolved","meetingNeeded":true,"priority":"low","dueDate":"2026-05-23","resolvedBy":"Emma Visser","resolvedAt":"2026-05-15","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"stock"},"assignedTo":"Mark Jansen","stakeholders":["Pieter Vos","Eva Bosman"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Eva Bosman, 2026-05-02)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00211","type":"challenge","title":"Digital shelf analytics tool subscription renewal decision","description":"Digital shelf analytics tool subscription renewal decision. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Revenue Growth Management","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Fleur Hendriks","createdAt":"2026-02-17","weekStart":"2026-02-16","status":"new","meetingNeeded":true,"priority":"medium","dueDate":"2026-03-04","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Luuk van den Berg","Ruben Smeets"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00212","type":"challenge","title":"Field force CRM data quality degradation over past quarter","description":"Field force CRM data quality degradation over past quarter. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales South","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Tom Bakker","createdAt":"2026-03-22","weekStart":"2026-03-16","status":"assigned","meetingNeeded":true,"priority":"low","dueDate":"2026-05-29","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Laura de Vries","stakeholders":["Mila Janssen","Luuk van den Berg"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Bram de Jong, 2026-04-26)"}]},
  {"id":"HJD00213","type":"challenge","title":"Promotional volume forecast variance exceeding 25 percent","description":"Promotional volume forecast variance exceeding 25 percent. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Trade Marketing","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Eva Bosman","createdAt":"2026-04-29","weekStart":"2026-04-27","status":"resolved","meetingNeeded":false,"priority":"medium","dueDate":"2026-05-29","resolvedBy":"Anna Peters","resolvedAt":"2026-05-01","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"logistics"},"assignedTo":"Jade Mulder","stakeholders":["Anna Peters","Damian de Groot"],"details":{"isRecurring":false,"knowledgeReused":true,"knowledgeReuseSource":"HJD00014","knowledgeReuseTimestamp":"2026-04-29T10:00:00.000Z","meetingGate":{"matchedItemId":"HJD00014","similarity":0.73,"appliedAt":"2026-04-29"}},"updates":[{"type":"feedback","note":"Initial review completed. (Damian de Groot, 2026-05-05)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00214","type":"challenge","title":"Inter-company transfer pricing audit finding resolution needed","description":"Inter-company transfer pricing audit finding resolution needed. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Key Accounts Supermarkets","assignedToDept":"Field Sales South","meetingLevel":"regional_red","externalEmail":"","createdBy":"Pieter Vos","createdAt":"2026-01-25","weekStart":"2026-01-19","status":"resolved","meetingNeeded":true,"priority":"medium","dueDate":"2026-02-26","resolvedBy":"Mila Janssen","resolvedAt":"2026-01-30","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"Customer"},"assignedTo":"Sophie van Dijk","stakeholders":["Eva Bosman","Bram de Jong"],"details":{"isRecurring":true},"updates":[{"type":"feedback","note":"Initial review completed. (Sanne Mulder, 2026-02-10)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00215","type":"challenge","title":"Customer master data duplication causing order processing issues","description":"Customer master data duplication causing order processing issues. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales South","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Ruben Smeets","createdAt":"2026-05-12","weekStart":"2026-05-11","status":"new","meetingNeeded":true,"priority":"low","dueDate":"2026-05-26","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Eva Bosman","Anna Peters"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00216","type":"challenge","title":"Regional depot consolidation impact on delivery lead times","description":"Regional depot consolidation impact on delivery lead times. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Trade Marketing","assignedToDept":"Field Sales North","meetingLevel":"national_red","externalEmail":"","createdBy":"Jade Mulder","createdAt":"2026-02-06","weekStart":"2026-02-02","status":"in_discussion","meetingNeeded":false,"priority":"medium","dueDate":"2026-05-23","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Rosa Brouwer","stakeholders":["Fleur Hendriks"],"details":{"isRecurring":true},"updates":[{"type":"feedback","note":"Initial review completed. (Lisa Dekker, 2026-05-21)"}]},
  {"id":"HJD00217","type":"contribution","title":"Built knowledge base article for EDI troubleshooting","description":"Built knowledge base article for EDI troubleshooting. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Revenue Growth Management","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Fleur Hendriks","createdAt":"2026-03-14","weekStart":"2026-03-09","status":"assigned","meetingNeeded":false,"priority":"low","dueDate":"","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Jade Mulder","Laura de Vries"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00218","type":"challenge","title":"Trade terms renegotiation preparation for annual review","description":"Trade terms renegotiation preparation for annual review. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Key Accounts Supermarkets","assignedToDept":"Supply Chain","meetingLevel":"national_red","externalEmail":"","createdBy":"Damian de Groot","createdAt":"2026-01-19","weekStart":"2026-01-19","status":"new","meetingNeeded":true,"priority":"high","dueDate":"2026-04-08","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Femke de Graaf","Joost Jacobs"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00219","type":"challenge","title":"Store cluster analysis outdated after demographic shifts","description":"Store cluster analysis outdated after demographic shifts. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"E-commerce Sales","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Fleur Hendriks","createdAt":"2026-02-15","weekStart":"2026-02-09","status":"resolved","meetingNeeded":true,"priority":"medium","dueDate":"2026-04-27","resolvedBy":"Mark Jansen","resolvedAt":"2026-05-25","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"External partner"},"assignedTo":"Joost Jacobs","stakeholders":["Mark Jansen","Alex Vermeer"],"details":{"isRecurring":true},"updates":[{"type":"feedback","note":"Initial review completed. (Lisa Dekker, 2026-04-04)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00220","type":"challenge","title":"Product registration delay in new market causing launch slip","description":"Product registration delay in new market causing launch slip. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales South","assignedToDept":"Key Accounts Supermarkets","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Femke de Graaf","createdAt":"2026-02-01","weekStart":"2026-01-26","status":"closed","meetingNeeded":true,"priority":"medium","dueDate":"2026-02-10","resolvedBy":"Anna Peters","resolvedAt":"2026-02-05","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":null,"assignedTo":"Bram de Jong","stakeholders":["Joost Jacobs","Sophie van Dijk"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Ruben Smeets, 2026-02-03)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00221","type":"challenge","title":"Sales force effectiveness metrics dashboard latency issues","description":"Sales force effectiveness metrics dashboard latency issues. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Sales Operations","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Femke de Graaf","createdAt":"2026-03-01","weekStart":"2026-02-23","status":"resolved","meetingNeeded":false,"priority":"high","dueDate":"2026-04-21","resolvedBy":"Tom Bakker","resolvedAt":"2026-03-18","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"People"},"assignedTo":"Bram de Jong","stakeholders":["Alex Vermeer","Mark Jansen"],"details":{"isRecurring":true,"knowledgeReused":true,"knowledgeReuseSource":"HJD00041","knowledgeReuseTimestamp":"2026-03-01T10:00:00.000Z","meetingGate":{"matchedItemId":"HJD00041","similarity":0.83,"appliedAt":"2026-03-01"}},"updates":[{"type":"feedback","note":"Initial review completed. (Pieter Vos, 2026-03-14)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00222","type":"challenge","title":"Retailer collaboration portal performance degradation","description":"Retailer collaboration portal performance degradation. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Revenue Growth Management","assignedToDept":"Operations","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Mila Janssen","createdAt":"2026-04-29","weekStart":"2026-04-27","status":"in_discussion","meetingNeeded":true,"priority":"medium","dueDate":"2026-05-25","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Sophie van Dijk","stakeholders":["Jonas Smit","Rosa Brouwer"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Pieter Vos, 2026-05-15)"}]},
  {"id":"HJD00223","type":"challenge","title":"Supply disruption contingency plan not tested since last year","description":"Supply disruption contingency plan not tested since last year. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales North","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Emma Visser","createdAt":"2026-04-08","weekStart":"2026-04-06","status":"resolved","meetingNeeded":true,"priority":"low","dueDate":"2026-06-11","resolvedBy":"Eva Bosman","resolvedAt":"2026-05-27","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"Customer"},"assignedTo":"Eva Bosman","stakeholders":["Ruben Smeets","Rosa Brouwer"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Fleur Hendriks, 2026-05-16)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00224","type":"celebration","title":"Cross-functional project completed ahead of schedule","description":"Cross-functional project completed ahead of schedule. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Trade Marketing","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Jonas Smit","createdAt":"2026-02-19","weekStart":"2026-02-16","status":"new","meetingNeeded":false,"priority":"low","dueDate":"","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Jade Mulder","Lisa Dekker"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00225","type":"challenge","title":"Category advisory report data visualisation errors","description":"Category advisory report data visualisation errors. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales South","assignedToDept":"Legal","meetingLevel":"national_red","externalEmail":"","createdBy":"Ruben Smeets","createdAt":"2026-02-20","weekStart":"2026-02-16","status":"in_discussion","meetingNeeded":false,"priority":"medium","dueDate":"2026-03-25","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Emma Visser","stakeholders":["Lisa Dekker","Jonas Smit"],"details":{"isRecurring":true},"updates":[{"type":"feedback","note":"Initial review completed. (Luuk van den Berg, 2026-03-14)"}]},
  {"id":"HJD00226","type":"challenge","title":"Frozen range space reduction at convenience stores","description":"Frozen range space reduction at convenience stores. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Revenue Growth Management","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Jade Mulder","createdAt":"2026-05-05","weekStart":"2026-05-04","status":"resolved","meetingNeeded":false,"priority":"high","dueDate":"2026-05-18","resolvedBy":"Laura de Vries","resolvedAt":"2026-05-18","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"compliance"},"assignedTo":"Sophie van Dijk","stakeholders":["Eva Bosman","Alex Vermeer"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Damian de Groot, 2026-05-14)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00227","type":"challenge","title":"Promotional calendar conflict between national and regional teams","description":"Promotional calendar conflict between national and regional teams. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Jumbo & Discounters","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Sanne Mulder","createdAt":"2026-04-29","weekStart":"2026-04-27","status":"resolved","meetingNeeded":true,"priority":"low","dueDate":"2026-06-09","resolvedBy":"Eva Bosman","resolvedAt":"2026-05-19","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"External partner"},"assignedTo":"Eva Bosman","stakeholders":["Emma Visser","Laura de Vries"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Emma Visser, 2026-05-15)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00228","type":"challenge","title":"Delivery vehicle fleet maintenance backlog increasing","description":"Delivery vehicle fleet maintenance backlog increasing. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Revenue Growth Management","assignedToDept":"HR","meetingLevel":"regional_red","externalEmail":"","createdBy":"Mark Jansen","createdAt":"2026-03-13","weekStart":"2026-03-09","status":"escalated","meetingNeeded":true,"priority":"medium","dueDate":"2026-06-08","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Jonas Smit","stakeholders":["Mark Jansen","Joost Jacobs"],"details":{"isRecurring":false,"escalationLevel":"senior_leadership","escalationTargetMeeting":"national_red","escalationMeetingDate":"2026-04-10","escalatedTo":"Daan Meijer","escalationReason":"Requires higher-level coordination and cross-departmental alignment."},"updates":[{"type":"feedback","note":"Initial review completed. (Tom Bakker, 2026-05-08)"}]},
  {"id":"HJD00229","type":"challenge","title":"B2B portal order tracking functionality not meeting expectations","description":"B2B portal order tracking functionality not meeting expectations. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Convenience & Petrol","assignedToDept":"","meetingLevel":"national_red","externalEmail":"","createdBy":"Mark Jansen","createdAt":"2026-03-08","weekStart":"2026-03-02","status":"resolved","meetingNeeded":false,"priority":"low","dueDate":"2026-05-09","resolvedBy":"Rosa Brouwer","resolvedAt":"2026-05-30","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"logistics"},"assignedTo":"Pieter Vos","stakeholders":["Fleur Hendriks","Luuk van den Berg"],"details":{"isRecurring":false,"knowledgeReused":true,"knowledgeReuseSource":"HJD00022","knowledgeReuseTimestamp":"2026-03-08T10:00:00.000Z","meetingGate":{"matchedItemId":"HJD00022","similarity":0.75,"appliedAt":"2026-03-08"}},"updates":[{"type":"feedback","note":"Initial review completed. (Sophie van Dijk, 2026-04-06)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00230","type":"contribution","title":"Shared cross-functional escalation protocol improvement","description":"Shared cross-functional escalation protocol improvement. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Trade Marketing","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Tom Bakker","createdAt":"2026-03-15","weekStart":"2026-03-09","status":"assigned","meetingNeeded":false,"priority":"medium","dueDate":"","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Bram de Jong","Thijs Willems"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00231","type":"challenge","title":"Store-level inventory accuracy below target in pilot region","description":"Store-level inventory accuracy below target in pilot region. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Wholesalers","assignedToDept":"Field Sales South","meetingLevel":"national_red","externalEmail":"","createdBy":"Laura de Vries","createdAt":"2026-03-12","weekStart":"2026-03-09","status":"resolved","meetingNeeded":true,"priority":"high","dueDate":"2026-03-20","resolvedBy":"Mark Jansen","resolvedAt":"2026-05-28","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"Customer"},"assignedTo":"Anna Peters","stakeholders":["Emma Visser","Thijs Willems"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Damian de Groot, 2026-03-12)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00232","type":"challenge","title":"New sustainability packaging transition timeline at risk","description":"New sustainability packaging transition timeline at risk. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Convenience & Petrol","assignedToDept":"","meetingLevel":"national_red","externalEmail":"","createdBy":"Eva Bosman","createdAt":"2026-03-21","weekStart":"2026-03-16","status":"resolved","meetingNeeded":false,"priority":"medium","dueDate":"2026-05-22","resolvedBy":"Rosa Brouwer","resolvedAt":"2026-05-10","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"logistics"},"assignedTo":"Fleur Hendriks","stakeholders":["Sophie van Dijk","Pieter Vos"],"details":{"isRecurring":false,"knowledgeReused":true,"knowledgeReuseSource":"HJD00040","knowledgeReuseTimestamp":"2026-03-21T10:00:00.000Z","meetingGate":{"matchedItemId":"HJD00040","similarity":0.82,"appliedAt":"2026-03-21"}},"updates":[{"type":"feedback","note":"Initial review completed. (Anna Peters, 2026-03-29)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00233","type":"contribution","title":"Developed new onboarding checklist for field sales reps","description":"Developed new onboarding checklist for field sales reps. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Convenience & Petrol","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Sanne Mulder","createdAt":"2026-03-21","weekStart":"2026-03-16","status":"resolved","meetingNeeded":false,"priority":"medium","dueDate":"","resolvedBy":"Damian de Groot","resolvedAt":"2026-04-16","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"pricing"},"assignedTo":"","stakeholders":["Laura de Vries","Pieter Vos"],"details":{"isRecurring":false},"updates":[{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00234","type":"challenge","title":"Field execution photo verification system latency issues","description":"Field execution photo verification system latency issues. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"E-commerce Sales","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Anna Peters","createdAt":"2026-03-23","weekStart":"2026-03-23","status":"closed","meetingNeeded":false,"priority":"high","dueDate":"2026-05-27","resolvedBy":"Jonas Smit","resolvedAt":"2026-05-14","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":null,"assignedTo":"Joost Jacobs","stakeholders":["Thijs Willems","Joost Jacobs"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Joost Jacobs, 2026-04-30)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00235","type":"challenge","title":"Retailer annual business plan presentation content gaps","description":"Retailer annual business plan presentation content gaps. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales South","assignedToDept":"Trade Marketing","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Daan Meijer","createdAt":"2026-04-13","weekStart":"2026-04-13","status":"closed","meetingNeeded":false,"priority":"high","dueDate":"2026-05-24","resolvedBy":"Laura de Vries","resolvedAt":"2026-04-14","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":null,"assignedTo":"Damian de Groot","stakeholders":["Eva Bosman","Thijs Willems"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Jade Mulder, 2026-04-30)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00236","type":"challenge","title":"Supply chain cost-to-serve analysis data incomplete","description":"Supply chain cost-to-serve analysis data incomplete. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Convenience & Petrol","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Femke de Graaf","createdAt":"2026-04-16","weekStart":"2026-04-13","status":"resolved","meetingNeeded":false,"priority":"high","dueDate":"2026-05-22","resolvedBy":"Damian de Groot","resolvedAt":"2026-04-28","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"pricing"},"assignedTo":"Ruben Smeets","stakeholders":["Joost Jacobs","Sophie van Dijk"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Fleur Hendriks, 2026-04-30)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00237","type":"challenge","title":"Trade marketing material waste reduction initiative stalled","description":"Trade marketing material waste reduction initiative stalled. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Jumbo & Discounters","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Fleur Hendriks","createdAt":"2026-04-16","weekStart":"2026-04-13","status":"resolved","meetingNeeded":false,"priority":"high","dueDate":"2026-05-26","resolvedBy":"Rosa Brouwer","resolvedAt":"2026-05-23","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"External partner"},"assignedTo":"Alex Vermeer","stakeholders":["Damian de Groot","Jade Mulder"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Daan Meijer, 2026-04-18)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00238","type":"challenge","title":"Regional team communication gap on pricing policy changes","description":"Regional team communication gap on pricing policy changes. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Trade Marketing","assignedToDept":"","meetingLevel":"national_red","externalEmail":"","createdBy":"Jonas Smit","createdAt":"2026-02-23","weekStart":"2026-02-23","status":"assigned","meetingNeeded":true,"priority":"low","dueDate":"2026-04-09","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Pieter Vos","stakeholders":["Jade Mulder","Emma Visser"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Sophie van Dijk, 2026-02-28)"}]},
  {"id":"HJD00239","type":"challenge","title":"E-commerce flash sale stock allocation process undefined","description":"E-commerce flash sale stock allocation process undefined. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Jumbo & Discounters","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Laura de Vries","createdAt":"2026-03-26","weekStart":"2026-03-23","status":"resolved","meetingNeeded":false,"priority":"high","dueDate":"2026-04-18","resolvedBy":"Jade Mulder","resolvedAt":"2026-04-20","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"stock"},"assignedTo":"Luuk van den Berg","stakeholders":["Fleur Hendriks","Anna Peters"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Luuk van den Berg, 2026-04-17)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00240","type":"challenge","title":"Retailer scorecard metrics disagreement on fill rate calculation","description":"Retailer scorecard metrics disagreement on fill rate calculation. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Wholesalers","assignedToDept":"Field Sales South","meetingLevel":"national_red","externalEmail":"","createdBy":"Femke de Graaf","createdAt":"2026-03-30","weekStart":"2026-03-30","status":"in_discussion","meetingNeeded":true,"priority":"medium","dueDate":"2026-05-06","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Ruben Smeets","stakeholders":["Emma Visser","Anna Peters"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Jonas Smit, 2026-04-07)"}]},
  {"id":"HJD00241","type":"challenge","title":"Distribution centre labour scheduling inefficiency during peaks","description":"Distribution centre labour scheduling inefficiency during peaks. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"E-commerce Sales","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Jonas Smit","createdAt":"2026-03-26","weekStart":"2026-03-23","status":"resolved","meetingNeeded":true,"priority":"high","dueDate":"2026-04-22","resolvedBy":"Thijs Willems","resolvedAt":"2026-05-05","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"External partner"},"assignedTo":"Luuk van den Berg","stakeholders":["Sanne Mulder","Joost Jacobs"],"details":{"isRecurring":true},"updates":[{"type":"feedback","note":"Initial review completed. (Rosa Brouwer, 2026-04-03)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00242","type":"challenge","title":"Promotional compliance monitoring automation project delayed","description":"Promotional compliance monitoring automation project delayed. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Sales Operations","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Alex Vermeer","createdAt":"2026-04-01","weekStart":"2026-03-30","status":"assigned","meetingNeeded":true,"priority":"low","dueDate":"2026-04-18","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Rosa Brouwer","stakeholders":["Mila Janssen","Eva Bosman"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Luuk van den Berg, 2026-04-07)"}]},
  {"id":"HJD00243","type":"challenge","title":"Customer segmentation model refresh overdue for targeting","description":"Customer segmentation model refresh overdue for targeting. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Convenience & Petrol","assignedToDept":"","meetingLevel":"regional_red","externalEmail":"","createdBy":"Eva Bosman","createdAt":"2026-05-06","weekStart":"2026-05-04","status":"new","meetingNeeded":true,"priority":"medium","dueDate":"2026-05-11","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Femke de Graaf","Jade Mulder"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00244","type":"challenge","title":"Sales territory boundary dispute between two regions","description":"Sales territory boundary dispute between two regions. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Key Accounts Supermarkets","assignedToDept":"Trade Marketing","meetingLevel":"regional_red","externalEmail":"","createdBy":"Emma Visser","createdAt":"2026-05-08","weekStart":"2026-05-04","status":"escalated","meetingNeeded":true,"priority":"high","dueDate":"2026-05-13","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"Thijs Willems","stakeholders":["Lisa Dekker","Ruben Smeets"],"details":{"isRecurring":false,"escalationLevel":"senior_leadership","escalationTargetMeeting":"national_red","escalationMeetingDate":"2026-05-25","escalatedTo":"Sanne Mulder","escalationReason":"Requires higher-level coordination and cross-departmental alignment."},"updates":[{"type":"feedback","note":"Initial review completed. (Emma Visser, 2026-05-11)"}]},
  {"id":"HJD00245","type":"celebration","title":"Field team achieved zero safety incidents for quarter","description":"Field team achieved zero safety incidents for quarter. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Sales Operations","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Jade Mulder","createdAt":"2026-05-06","weekStart":"2026-05-04","status":"resolved","meetingNeeded":false,"priority":"high","dueDate":"","resolvedBy":"Sophie van Dijk","resolvedAt":"2026-05-26","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"compliance"},"assignedTo":"","stakeholders":["Mark Jansen","Jonas Smit"],"details":{"isRecurring":false},"updates":[{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00246","type":"challenge","title":"Product quality complaint trend increasing in eastern region","description":"Product quality complaint trend increasing in eastern region. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Wholesalers","assignedToDept":"Operations","meetingLevel":"national_red","externalEmail":"","createdBy":"Joost Jacobs","createdAt":"2026-04-13","weekStart":"2026-04-13","status":"resolved","meetingNeeded":true,"priority":"high","dueDate":"2026-05-23","resolvedBy":"Thijs Willems","resolvedAt":"2026-05-14","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":{"rootCause":"People"},"assignedTo":"Niels Kuiper","stakeholders":["Ruben Smeets","Femke de Graaf"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Joost Jacobs, 2026-04-26)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00247","type":"challenge","title":"Direct store delivery pilot evaluation metrics not defined","description":"Direct store delivery pilot evaluation metrics not defined. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Field Sales South","assignedToDept":"IT","meetingLevel":"regional_red","externalEmail":"","createdBy":"Ruben Smeets","createdAt":"2026-03-04","weekStart":"2026-03-02","status":"new","meetingNeeded":true,"priority":"high","dueDate":"2026-03-08","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Mark Jansen","Joost Jacobs"],"details":{"isRecurring":false},"updates":[]},
  {"id":"HJD00248","type":"challenge","title":"Annual promotional effectiveness review preparation behind schedule","description":"Annual promotional effectiveness review preparation behind schedule. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Revenue Growth Management","assignedToDept":"","meetingLevel":"team_weekly","externalEmail":"","createdBy":"Pieter Vos","createdAt":"2026-05-13","weekStart":"2026-05-11","status":"closed","meetingNeeded":true,"priority":"medium","dueDate":"2026-05-18","resolvedBy":"Pieter Vos","resolvedAt":"2026-05-19","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":null,"assignedTo":"Mila Janssen","stakeholders":["Damian de Groot","Tom Bakker"],"details":{"isRecurring":true},"updates":[{"type":"feedback","note":"Initial review completed. (Niels Kuiper, 2026-05-13)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
  {"id":"HJD00249","type":"challenge","title":"Wholesale channel price parity concern with retail pricing","description":"Wholesale channel price parity concern with retail pricing. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"Sales Operations","assignedToDept":"","meetingLevel":"leadership_sync","externalEmail":"","createdBy":"Fleur Hendriks","createdAt":"2026-04-28","weekStart":"2026-04-27","status":"new","meetingNeeded":true,"priority":"medium","dueDate":"2026-05-26","resolvedBy":"","resolvedAt":"","solution":"","solutionTemplate":null,"assignedTo":"","stakeholders":["Niels Kuiper","Damian de Groot"],"details":{"isRecurring":true},"updates":[]},
  {"id":"HJD00250","type":"challenge","title":"Field force mobile reporting tool battery drain issue","description":"Field force mobile reporting tool battery drain issue. Further investigation and cross-functional alignment required to address root cause and prevent recurrence.","department":"E-commerce Sales","assignedToDept":"Legal","meetingLevel":"regional_red","externalEmail":"","createdBy":"Lisa Dekker","createdAt":"2026-04-16","weekStart":"2026-04-13","status":"closed","meetingNeeded":true,"priority":"high","dueDate":"2026-06-01","resolvedBy":"Mila Janssen","resolvedAt":"2026-05-05","solution":"Resolved through cross-functional coordination and standard process application.","solutionTemplate":null,"assignedTo":"Fleur Hendriks","stakeholders":["Mark Jansen","Eva Bosman"],"details":{"isRecurring":false},"updates":[{"type":"feedback","note":"Initial review completed. (Mark Jansen, 2026-05-01)"},{"type":"solution_note","note":"Solution: Resolved through cross-functional coordination and standard process application."}]},
];

let items = loadItems();
let meetingWeekView = "current";
let activeMeetingWeek = upcomingMeetingMondayISO();

function loadItems() {
  const storedVersion = localStorage.getItem(STORAGE_DATASET_VERSION_KEY);
  if (storedVersion !== CURRENT_DATASET_VERSION) {
    localStorage.setItem(STORAGE_DATASET_VERSION_KEY, CURRENT_DATASET_VERSION);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(initialItems));
    return normalizeItemFields(structuredClone(initialItems));
  }

  const fromStorage = localStorage.getItem(STORAGE_KEY);
  if (!fromStorage) return normalizeItemFields(structuredClone(initialItems));
  try {
    const parsed = JSON.parse(fromStorage);
    return Array.isArray(parsed) && parsed.length ? normalizeItemFields(parsed) : normalizeItemFields(structuredClone(initialItems));
  } catch {
    return normalizeItemFields(structuredClone(initialItems));
  }
}

// V2: Ensure all items have new fields
function normalizeItemFields(itemList) {
  const deptToMeetingLevel = {
    "Field Sales North": "team_weekly",
    "Field Sales South": "team_weekly",
    "Key Accounts Supermarkets": "regional_red",
    "Convenience & Petrol": "regional_red",
    "E-commerce Sales": "regional_red",
    "Wholesalers": "team_weekly",
    "Sales Operations": "national_red",
    "Trade Marketing": "team_weekly",
    "Revenue Growth Management": "national_red",
    "Shopper Marketing": "regional_red",
  };
  itemList.forEach((item) => {
    if (!item.assignedToDept) item.assignedToDept = "";
    if (!item.meetingLevel) {
      item.meetingLevel = item.details?.escalationTargetMeeting || deptToMeetingLevel[item.department] || "team_weekly";
    }
    if (!item.externalEmail) item.externalEmail = "";
    const likes = Array.isArray(item.likedBy) ? item.likedBy : (Array.isArray(item.likesBy) ? item.likesBy : []);
    item.likedBy = uniqueList(likes);
  });
  return itemList;
}

function saveItems() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  localStorage.setItem(STORAGE_DATASET_VERSION_KEY, CURRENT_DATASET_VERSION);
}

function toLabel(value) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function meetingLayerLabel(value) {
  if (!value) return "Not set";
  return MEETING_LAYERS[value] || toLabel(value);
}

function truncate(text, max = 150) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatMessageText(text) {
  return escapeHtml(text).replace(/\n/g, "<br>");
}

function formatAssistantMessageText(text) {
  let safe = escapeHtml(text || "");
  safe = safe.replace(
    /\*\*(.+?)\*\*/g,
    '<strong class="assistant-inline-strong">$1</strong>'
  );
  safe = safe.replace(
    /^(Quick assessment:|Relevant historical cases:|What worked before:|Recommended actions for[^:\n]*:|Escalate when:)/gim,
    '<strong class="assistant-section-title">$1</strong>'
  );
  return safe.replace(/\n/g, "<br>");
}

function normalizeSearchText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeText(text) {
  return normalizeSearchText(text)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !ASSISTANT_STOP_WORDS.has(token));
}

function stemToken(token) {
  if (!token) return "";
  let value = token;
  if (value.endsWith("ies") && value.length > 4) value = value.slice(0, -3) + "y";
  else if (/(ing|ers|er|ed|en|es|s)$/.test(value) && value.length > 4) {
    value = value.replace(/(ing|ers|er|ed|en|es|s)$/, "");
  }
  return value;
}

function tokenizeAssistantText(text) {
  const normalized = normalizeSearchText(text);
  if (!normalized) return [];

  const tokens = [];
  normalized.split(/\s+/).forEach((rawToken) => {
    const token = rawToken.trim();
    if (!token) return;
    const stemmed = stemToken(token);
    const keepToken = token.length > 2 || Object.prototype.hasOwnProperty.call(ASSISTANT_TERM_ALIASES, token);
    const keepStemmed = stemmed.length > 2 || Object.prototype.hasOwnProperty.call(ASSISTANT_TERM_ALIASES, stemmed);

    if (keepToken && !ASSISTANT_STOP_WORDS.has(token)) tokens.push(token);
    if (keepStemmed && stemmed !== token && !ASSISTANT_STOP_WORDS.has(stemmed)) tokens.push(stemmed);

    const aliases = ASSISTANT_TERM_ALIASES[token] || ASSISTANT_TERM_ALIASES[stemmed] || [];
    aliases.forEach((alias) => {
      const cleaned = stemToken(alias);
      if (cleaned.length > 2 && !ASSISTANT_STOP_WORDS.has(cleaned)) tokens.push(cleaned);
    });
  });

  return Array.from(new Set(tokens));
}

function buildNgramProfile(text, size = 3) {
  const normalized = normalizeSearchText(text).replace(/\s+/g, " ");
  if (!normalized) return { counts: new Map(), total: 0 };
  const padded = ` ${normalized} `;
  const counts = new Map();
  for (let i = 0; i <= padded.length - size; i += 1) {
    const gram = padded.slice(i, i + size);
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  let total = 0;
  counts.forEach((count) => {
    total += count;
  });
  return { counts, total };
}

function diceFromProfiles(profileA, profileB) {
  if (!profileA.total || !profileB.total) return 0;
  let overlap = 0;
  profileA.counts.forEach((countA, gram) => {
    const countB = profileB.counts.get(gram) || 0;
    overlap += Math.min(countA, countB);
  });
  return (2 * overlap) / (profileA.total + profileB.total);
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => new Array(cols).fill(0));

  for (let i = 0; i < rows; i += 1) matrix[i][0] = i;
  for (let j = 0; j < cols; j += 1) matrix[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[rows - 1][cols - 1];
}

function tokenEditSimilarity(a, b) {
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 0;
  return 1 - (levenshteinDistance(a, b) / maxLen);
}

function fuzzyTokenSimilarity(queryTokens, itemTokens) {
  if (!queryTokens.length || !itemTokens.length) return 0;
  const itemSet = new Set(itemTokens);
  const uniqueItems = Array.from(itemSet);
  let score = 0;

  queryTokens.forEach((queryToken) => {
    if (itemSet.has(queryToken)) {
      score += 1;
      return;
    }

    let best = 0;
    for (let i = 0; i < uniqueItems.length; i += 1) {
      const itemToken = uniqueItems[i];
      const lengthDiff = Math.abs(queryToken.length - itemToken.length);
      if (lengthDiff > 2) continue;

      const qPrefix = queryToken.slice(0, 2);
      const iPrefix = itemToken.slice(0, 2);
      if (queryToken[0] !== itemToken[0] && qPrefix !== iPrefix) continue;

      const similarity = tokenEditSimilarity(queryToken, itemToken);
      if (similarity > best) best = similarity;
      if (best >= 0.92) break;
    }

    if (best >= 0.70) score += best;
  });

  return score / queryTokens.length;
}

function buildAssistantQueryProfile(query) {
  const normalized = normalizeSearchText(query);
  return {
    normalized,
    tokens: tokenizeAssistantText(normalized),
    ngrams: buildNgramProfile(normalized, 3),
  };
}

function scoreAssistantCase(profile, item) {
  const detailsText = Object.values(item.details || {}).join(" ");
  const updatesText = (item.updates || []).map((update) => update.note).join(" ");

  const fields = {
    header: `${item.id || ""} ${item.title || ""}`,
    body: `${item.description || ""} ${item.solution || ""}`,
    context: `${item.department || ""} ${item.assignedToDept || ""} ${(item.stakeholders || []).join(" ")} ${detailsText} ${updatesText}`,
  };

  const weights = {
    header: 0.46,
    body: 0.38,
    context: 0.16,
  };

  let totalScore = 0;
  Object.entries(fields).forEach(([field, value]) => {
    const fieldTokens = tokenizeAssistantText(value);
    const lexical = similarityScore(profile.tokens, fieldTokens);
    const fuzzy = fuzzyTokenSimilarity(profile.tokens, fieldTokens);
    const ngram = diceFromProfiles(profile.ngrams, buildNgramProfile(value, 3));
    const combined = (lexical * 0.45) + (fuzzy * 0.40) + (ngram * 0.15);
    totalScore += (weights[field] || 0) * combined;
  });

  const normalizedId = normalizeSearchText(item.id || "");
  if (normalizedId && profile.normalized.includes(normalizedId)) totalScore += 0.25;
  return totalScore;
}

function buildItemCorpus(item) {
  return [
    item.id,
    item.type,
    item.title,
    item.description,
    item.solution || "",
    item.solutionTemplate ? Object.values(item.solutionTemplate).join(" ") : "",
    item.department,
    Object.values(item.details || {}).join(" "),
    item.stakeholders.join(" "),
    item.updates.map((update) => update.note).join(" "),
  ].join(" ");
}

// ── Feature 2: Expert Recommendation Engine ──────────────────────────────────

function findSuggestedExperts(sourceItem, similarCases) {
  const expertMap = {};
  similarCases.forEach(({ item }) => {
    const candidates = [
      item.resolvedBy,
      item.assignedTo,
      item.createdBy,
      ...(item.stakeholders || []),
    ].filter(Boolean);
    candidates.forEach((name) => {
      if (!expertMap[name]) expertMap[name] = 0;
      expertMap[name] += 1;
    });
  });
  // Remove the current item's creator so we don't self-recommend
  delete expertMap[sourceItem.createdBy];
  return Object.entries(expertMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, count]) => ({ name, count }));
}

// ── Feature 7: Recurring Challenge Detection ──────────────────────────────────

function detectRecurringChallenges(sourceItem) {
  const now = new Date(todayISO());
  const windowMs = RECURRING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const sourceTokens = tokenizeText(buildItemCorpus(sourceItem));
  const recent = items.filter((item) => {
    if (item.id === sourceItem.id) return false;
    if (item.type !== "challenge") return false;
    const created = new Date(item.createdAt || "2000-01-01");
    return now - created <= windowMs;
  });
  const similar = recent.filter((item) => {
    const score = similarityScore(sourceTokens, tokenizeText(buildItemCorpus(item)));
    return score >= 0.25;
  });
  return similar.length >= RECURRING_MIN_COUNT - 1 ? similar : [];
}

// ── Feature 4: Escalation Intelligence Engine ─────────────────────────────────

function getRecurringEscalationSuggestion(item) {
  if (item.details?.recurringEscSuggestionIgnored) return null;
  // Rule 2: same challenge type ≥3 times in 60 days
  const recurring = detectRecurringChallenges(item);
  if (recurring.length >= RECURRING_MIN_COUNT - 1) {
    return {
      reason: `This type of challenge has appeared ${recurring.length + 1} times in the last ${RECURRING_WINDOW_DAYS} days. Escalation to a higher meeting is recommended.`,
      targetMeeting: "regional_red",
      escalationLevel: "senior_leadership",
      nextMeetingDate: addDaysISO(activeMeetingWeek, 7),
      escalatedTo: item.stakeholders[0] || item.createdBy || "",
      escalationReason: `Recurring pattern detected: ${recurring.length + 1} similar challenges in ${RECURRING_WINDOW_DAYS} days. Requires structural resolution, not case-by-case fixing.`,
      ruleLabel: "Recurring pattern (Rule 2)",
    };
  }
  return null;
}

// ── Feature 8: Root Cause Analytics ──────────────────────────────────────────

const ROOT_CAUSE_LABELS = {
  "supply chain": "Supply Chain",
  "pricing": "Pricing",
  "logistics": "Logistics",
  "contract": "Contract Issue",
  "system": "System Error",
  "inventory": "Inventory Mismatch",
  "promo": "Promo / Marketing",
  "data": "Data Quality",
  "stock": "Stock / Replenishment",
  "cooler": "Equipment / Cooler",
  "delivery": "Delivery",
  "compliance": "Compliance",
};

function buildRootCauseAnalytics() {
  const counts = {};
  const itemIds = {};
  items.forEach((item) => {
    if (item.type !== "challenge") return;
    const rc = (item.solutionTemplate?.rootCause || "").toLowerCase().trim();
    if (rc) {
      counts[rc] = (counts[rc] || 0) + 1;
      itemIds[rc] = itemIds[rc] || [];
      itemIds[rc].push(item.id);
      return;
    }
    // Infer from corpus keywords
    const corpus = buildItemCorpus(item).toLowerCase();
    for (const [key] of Object.entries(ROOT_CAUSE_LABELS)) {
      if (corpus.includes(key)) {
        counts[key] = (counts[key] || 0) + 1;
        itemIds[key] = itemIds[key] || [];
        itemIds[key].push(item.id);
        break;
      }
    }
  });
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([key, count]) => ({ label: ROOT_CAUSE_LABELS[key] || toLabel(key), count, itemIds: itemIds[key] || [] }));
}

// ── Feature 9: Challenge Clustering ──────────────────────────────────────────

function buildChallengeClusters() {
  const clusters = {};
  items.filter((i) => i.type === "challenge").forEach((item) => {
    const corpus = buildItemCorpus(item).toLowerCase();
    const clusterDefs = [
      { key: "logistics", label: "🚚 Logistics & Delivery", terms: ["logistics", "delivery", "depot", "route", "transport"] },
      { key: "pricing", label: "💰 Pricing & Promo", terms: ["price", "promo", "pricing", "discount", "accrual", "invoice"] },
      { key: "stock", label: "📦 Stock & Replenishment", terms: ["stock", "replenishment", "inventory", "out-of-stock", "fill", "supply"] },
      { key: "compliance", label: "📋 Shelf & Compliance", terms: ["compliance", "display", "shelf", "pos", "placement", "cooler"] },
      { key: "digital", label: "💻 Digital & Data", terms: ["edi", "digital", "data", "system", "master", "photo", "app"] },
      { key: "customer", label: "🤝 Customer & Contract", terms: ["customer", "account", "contract", "buyer", "wholesaler"] },
    ];
    let matched = false;
    for (const cluster of clusterDefs) {
      if (cluster.terms.some((term) => corpus.includes(term))) {
        clusters[cluster.key] = clusters[cluster.key] || { label: cluster.label, count: 0, items: [] };
        clusters[cluster.key].count += 1;
        clusters[cluster.key].items.push(item.id);
        matched = true;
        break;
      }
    }
    if (!matched) {
      clusters["other"] = clusters["other"] || { label: "📌 Other", count: 0, items: [] };
      clusters["other"].count += 1;
      clusters["other"].items.push(item.id);
    }
  });
  return Object.values(clusters).sort((a, b) => b.count - a.count);
}

// ── Feature 10: Meeting Efficiency Metrics (expanded KPI engine) ─────────────

function calcItemManHours(item) {
  const model = MEETING_COST_MODEL[item.meetingLevel] || MEETING_COST_MODEL.team_weekly;
  return (model.durationMin / 60) * MEETING_PREP_MULTIPLIER * model.avgAttendees;
}

function buildEfficiencyMetrics() {
  const challenges = items.filter((i) => i.type === "challenge");
  const total = challenges.length || 1;

  // ── Meetings Avoided: items where meetingNeeded===false (from data) + session counter
  const skippedFromData = challenges.filter((i) => i.meetingNeeded === false);
  const skippedMeetings = skippedFromData.length + meetingsAvoidedCount;

  // ── Man-Hours Saved: computed per item using meeting level cost model
  const manHoursSaved = skippedFromData.reduce((sum, i) => sum + calcItemManHours(i), 0)
    + (meetingsAvoidedCount * calcItemManHours({ meetingLevel: "regional_red" }));

  // ── Knowledge Reuse: items with knowledgeReused flag (permanent) + session counter
  const reuseItemsFromData = challenges.filter((i) => i.details?.knowledgeReused);
  const reuseItems = reuseItemsFromData.length + knowledgeReuseCount;
  const reuseRate = Math.round((reuseItems / total) * 100);

  // ── Resolution Time: reused vs. fresh (traceable from timestamps)
  const resolved = challenges.filter((i) => i.resolvedAt && i.createdAt);
  const calcDays = (i) => Math.max(0, Math.ceil((new Date(i.resolvedAt) - new Date(i.createdAt)) / 864e5));
  const reuseResolved = resolved.filter((i) => i.details?.knowledgeReused);
  const freshResolved = resolved.filter((i) => !i.details?.knowledgeReused);
  const avgReuseRes = reuseResolved.length
    ? Math.round(reuseResolved.reduce((s, i) => s + calcDays(i), 0) / reuseResolved.length)
    : null;
  const avgFreshRes = freshResolved.length
    ? Math.round(freshResolved.reduce((s, i) => s + calcDays(i), 0) / freshResolved.length)
    : null;
  const accelerationDays = (avgReuseRes !== null && avgFreshRes !== null)
    ? avgFreshRes - avgReuseRes : null;

  // ── First-Touch Resolution Rate: resolved without needing a meeting, ≤2 updates
  const ftrrItems = resolved.filter((i) => i.meetingNeeded === false && (i.updates || []).length <= 2);
  const ftrr = Math.round((ftrrItems.length / (resolved.length || 1)) * 100);

  // ── Escalation Avoidance Rate: stayed at team_weekly or regional_red
  const lowLevels = ["team_weekly", "regional_red"];
  const escalAvoid = resolved.filter((i) => lowLevels.includes(i.meetingLevel));
  const ear = Math.round((escalAvoid.length / (resolved.length || 1)) * 100);

  // ── Knowledge Compounding Index: solutions reused as source by other items
  const sourcedIds = new Set(
    challenges
      .filter((i) => i.details?.knowledgeReuseSource)
      .map((i) => i.details.knowledgeReuseSource)
  );
  const resolvedWithSolution = resolved.filter((i) => i.solution && i.solution.length > 10);
  const kci = resolvedWithSolution.length
    ? Math.round((sourcedIds.size / resolvedWithSolution.length) * 100) : 0;

  // ── Meeting Level Breakdown (open items)
  const levelCounts = {};
  challenges.filter((i) => i.status === "new" || i.status === "assigned" || i.status === "in_discussion").forEach((i) => {
    const lvl = i.meetingLevel || "team_weekly";
    levelCounts[lvl] = (levelCounts[lvl] || 0) + 1;
  });

  // ── Root Cause top 3
  const rcData = buildRootCauseAnalytics().slice(0, 3);

  // ── Recurring
  const recurring = challenges.filter((i) => i.details?.isRecurring).length;

  return {
    skippedMeetings,
    manHoursSaved: Math.round(manHoursSaved * 10) / 10,
    reuseItems,
    reuseRate,
    avgReuseRes,
    avgFreshRes,
    accelerationDays,
    ftrr,
    ear,
    kci,
    levelCounts,
    rcData,
    recurring,
    totalChallenges: total,
    resolvedCount: resolved.length,
    reuseSourceCount: sourcedIds.size,
  };
}

function getOwnerName(item) {
  return (
    item.details?.escalatedTo ||
    item.assignedTo ||
    item.stakeholders?.[0] ||
    item.createdBy ||
    ""
  );
}

function uniqueList(values) {
  const cleaned = values
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return Array.from(new Set(cleaned));
}

function getAgendaItemsForWeek(weekStartISO) {
  return items
    .filter((item) => isOpenStatus(item.status))
    .filter((item) => item.meetingNeeded !== false)
    .filter((item) => (item.weekStart || weekStartISO) === weekStartISO);
}

function buildRecipientsForWeek(weekStartISO) {
  const agendaItems = getAgendaItemsForWeek(weekStartISO);
  const attendees = uniqueList(
    agendaItems.flatMap((item) => [item.createdBy, getOwnerName(item), ...(item.stakeholders || [])])
  );

  const broader = uniqueList(
    items.flatMap((item) => [item.createdBy, getOwnerName(item), ...(item.stakeholders || [])])
  );

  const summaryOnly = broader.filter((name) => !attendees.includes(name));
  return { attendees, summaryOnly };
}

function buildEmailFromRecipients(attendees, summaryOnly, recapText) {
  const subject = `RED in-SYNCC recap - ${new Date().toLocaleDateString("en-GB")}`;
  const footerLines = [
    "Generated from RED in-SYNCC Meeting Mode.",
    summaryOnly.length ? "" : "",
    summaryOnly.length ? "Summary-only recipients (not required to attend):" : "",
    summaryOnly.length ? summaryOnly.map((name) => `- ${name}`).join("\n") : "",
  ].filter(Boolean);

  const footer = "\n\n" + footerLines.join("\n");
  const to = attendees.join(",");
  const cc = summaryOnly.join(",");
  return `mailto:${to}?cc=${encodeURIComponent(cc)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(
    `${recapText}${footer}`
  )}`;
}

function isHighPriorityOverdueChallenge(item) {
  return (
    item.type === "challenge" &&
    isOpenStatus(item.status) &&
    item.priority === "high" &&
    isOverdue(item)
  );
}

function getEscalationSuggestion(item) {
  if (!isHighPriorityOverdueChallenge(item)) return null;

  const suggestedTarget = item.details?.escalationTargetMeeting || "regional_red";
  const suggestedLevel = item.details?.escalationLevel || "team_lead";
  const suggestedDate = item.details?.escalationMeetingDate || activeMeetingWeek;
  const suggestedOwner = item.details?.escalatedTo || item.stakeholders?.[0] || "Team Lead";
  const suggestedReason =
    item.details?.escalationReason ||
    `High priority and overdue (due ${item.dueDate}). Suggest escalation to unblock execution.`;

  return {
    targetMeeting: suggestedTarget,
    escalationLevel: suggestedLevel,
    nextMeetingDate: suggestedDate,
    escalatedTo: suggestedOwner,
    escalationReason: suggestedReason,
  };
}

function loadRuleAlerts() {
  try {
    return JSON.parse(localStorage.getItem(RULE_ALERT_STORAGE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveRuleAlerts(state) {
  localStorage.setItem(RULE_ALERT_STORAGE_KEY, JSON.stringify(state || {}));
}

function runRuleChecksAndNotify() {
  const alerts = loadRuleAlerts();
  const candidates = items.filter((item) => getEscalationSuggestion(item));
  if (!candidates.length) return;

  const today = todayISO();
  const lastAlertDay = alerts.lastEscalationAlertDay;
  if (lastAlertDay === today) return;

  alerts.lastEscalationAlertDay = today;
  saveRuleAlerts(alerts);
  showToast(`${candidates.length} overdue high-priority challenge(s) need escalation review.`);
}

function buildSolutionTemplate(existing = {}) {
  const rootCause = window.prompt(
    "Root cause category (example: Data, Process, System, People, External partner, Customer):",
    existing.rootCause || ""
  );
  if (rootCause === null) return null;

  const actionSteps = window.prompt(
    "Action steps taken (brief, but specific):",
    existing.actionSteps || ""
  );
  if (actionSteps === null) return null;

  const prevention = window.prompt(
    "Prevention or standardization (how to avoid recurrence):",
    existing.prevention || ""
  );
  if (prevention === null) return null;

  const validatedBy = window.prompt(
    "Validated by (name or role, optional):",
    existing.validatedBy || ""
  );
  if (validatedBy === null) return null;

  const reusableTags = window.prompt(
    "Reusable tags (comma separated, example: pricing, EDI, promo, stock):",
    existing.reusableTags || ""
  );
  if (reusableTags === null) return null;

  const template = {
    rootCause: String(rootCause || "").trim(),
    actionSteps: String(actionSteps || "").trim(),
    prevention: String(prevention || "").trim(),
    validatedBy: String(validatedBy || "").trim(),
    reusableTags: String(reusableTags || "").trim(),
  };

  const solutionText = [
    template.actionSteps ? `Action: ${template.actionSteps}` : "",
    template.rootCause ? `Root cause: ${template.rootCause}` : "",
    template.prevention ? `Prevention: ${template.prevention}` : "",
    template.validatedBy ? `Validated by: ${template.validatedBy}` : "",
    template.reusableTags ? `Tags: ${template.reusableTags}` : "",
  ]
    .filter(Boolean)
    .join(" | ");

  return { template, solutionText };
}

function similarityScore(queryTokens, itemTokens) {
  const querySet = new Set(queryTokens);
  const itemSet = new Set(itemTokens);
  if (!querySet.size || !itemSet.size) return 0;

  let overlap = 0;
  querySet.forEach((token) => {
    if (itemSet.has(token)) overlap += 1;
  });

  return overlap / Math.sqrt(querySet.size * itemSet.size);
}

function inferChallengeIntent(query, matches = []) {
  const value = String(query || "").trim();
  if (!value) return false;

  const explicitSignal = /challenge|challange|challnge|chalenge|issue|problem|probleem|problm|recurr|escalat|block|bottleneck|uitdaging|escalatie|blokkade|vertraging|pricing|price|stock|delivery|service|oos|stockout|dc|depot/i.test(
    value
  );
  if (explicitSignal) return true;

  const normalized = normalizeSearchText(value);
  const helpSignal = /\b(help|advice|advise|info|information|support|guidance|similar|before|insight|tips|any info)\b/i.test(
    value
  );
  const questionSignal = /\?$/.test(value) || /\b(how|what|why|which|where|when|can|do you have)\b/i.test(value);
  const operationalSignal = /\b(missing|image|images|portal|retailer|invoice|edi|shipment|delay|delayed|returns|warehouse|forecast|promotion|promo|availability|sla|complaint|allocation|label|sku|distribution|integration)\b/i.test(
    normalized
  );

  if (operationalSignal && (helpSignal || questionSignal)) return true;

  const topSimilarity = Array.isArray(matches) && matches.length ? Number(matches[0].similarity) || 0 : 0;
  return topSimilarity >= 0.30;
}

function isLikelyDutchText(text) {
  return /\b(hoi|hallo|goedemorgen|goedemiddag|goedenavond|hoe|gaat|dank|bedankt|kun|jij|ik|wat|met|uitdaging)\b/i.test(
    text || ""
  );
}

function buildAssistantOfflineChatFallback(query) {
  const isDutch = isLikelyDutchText(query);
  return isDutch
    ? "Hoi! Ik help je graag. Beschrijf je challenge kort (wat, waar, impact), dan zoek ik vergelijkbare cases met praktische vervolgstappen."
    : "Hey! Happy to help. Share your challenge in 1-2 lines (what, where, impact), and I will find relevant historical cases with practical next steps.";
}

function findSimilarCases(query, limit = 3, candidateItems = items) {
  const profile = buildAssistantQueryProfile(query);
  if (!profile.tokens.length) return [];

  const challengeIntent = inferChallengeIntent(query);
  const scope = Array.isArray(candidateItems) && candidateItems.length ? candidateItems : items;

  return scope
    .map((item) => {
      const base = scoreAssistantCase(profile, item);
      let adjusted = base;
      if (challengeIntent && item.type === "challenge") adjusted += 0.06;
      if (["resolved", "closed"].includes(item.status)) adjusted += 0.05;
      if ((item.solution || "").trim().length > 24) adjusted += 0.03;
      return { ...item, similarity: adjusted };
    })
    .filter((item) => item.similarity > 0.15)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

function findMeetingGateMatch(candidateText) {
  const queryTokens = tokenizeText(candidateText);
  if (!queryTokens.length) return null;

  const scored = items
    .filter((item) => ["resolved", "closed"].includes(item.status))
    .filter((item) => (item.solution || "").trim().length >= MEETING_GATE_MIN_SOLUTION_CHARS)
    .map((item) => {
      const base = similarityScore(queryTokens, tokenizeText(buildItemCorpus(item)));
      return { item, similarity: base };
    })
    .sort((a, b) => b.similarity - a.similarity);

  if (!scored.length) return null;
  const best = scored[0];
  if (best.similarity < MEETING_GATE_SIMILARITY_THRESHOLD) return null;
  return best;
}

function getCreateSimilarPool() {
  return items.filter((item) => (
    item.type === "challenge" &&
    ["resolved", "closed"].includes(item.status) &&
    (item.solution || "").trim().length >= 12
  ));
}

function findCreateSimilarCases(query, limit = CREATE_SIMILAR_LIMIT) {
  const profile = buildAssistantQueryProfile(query);
  const pool = getCreateSimilarPool();
  if (!pool.length) return [];
  if (!profile.tokens.length) {
    return pool.slice(0, limit).map((item) => ({ item, score: 0.05 }));
  }

  const scored = pool
    .map((item) => {
      const base = scoreAssistantCase(profile, item);
      let score = base;
      if (["resolved", "closed"].includes(item.status)) score += 0.04;
      if ((item.solution || "").trim().length >= 24) score += 0.03;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score);

  const strongMatches = scored
    .filter(({ score }) => score >= CREATE_SIMILAR_THRESHOLD)
    .slice(0, limit);

  if (strongMatches.length) return strongMatches;
  return scored.slice(0, limit);
}

function clearCreateDescriptionSuggestions() {
  const host = document.querySelector("#create-similar-cases");
  if (!host) return;
  host.innerHTML = "";
  host.classList.add("is-hidden");
}

function hasDescriptionTimeline(text) {
  return /\b(today|yesterday|tomorrow|week|weeks|month|months|quarter|q[1-4]|since|deadline|due|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/i.test(text || "");
}

function hasDescriptionOwner(text) {
  return /\b(owner|responsible|assigned|team|lead|manager|contact|stakeholder)\b/i.test(text || "");
}

function buildDescriptionAssistantSuggestions({ title, description, stakeholders, assignedDept }) {
  const combined = `${title} ${description}`.trim();
  const charCount = description.length;
  const suggestions = [];

  if (charCount < 120) {
    suggestions.push({
      title: "Add more detail",
      body: `Current description length is ${charCount} characters. Challenges work best with at least 120 characters. Add what started the issue, business impact, and actions already tried.`,
    });
  }

  if (!/\d/.test(combined)) {
    suggestions.push({
      title: "Include quantitative impact",
      body: "Add numbers where possible, for example affected volume, delayed weeks, or revenue impact. Concrete numbers improve prioritization.",
    });
  }

  if (!hasDescriptionOwner(combined) && !stakeholders.length && !assignedDept) {
    suggestions.push({
      title: "Name an owner",
      body: "Mention who is responsible or which team is leading the resolution so routing and follow-up are clear.",
    });
  }

  if (!hasDescriptionTimeline(combined)) {
    suggestions.push({
      title: "Add timeline context",
      body: "Include timing details such as when the issue started, deadline expectations, or whether the trend is increasing.",
    });
  }

  if (!suggestions.length) {
    suggestions.push({
      title: "Description quality is strong",
      body: "The current description has useful depth and structure. You can proceed or refine wording further.",
    });
  }

  return suggestions;
}

function renderCreateDescriptionSuggestions() {
  const typeSelect = document.querySelector("#item-type");
  const descriptionInput = document.querySelector("#create-description-input");
  const host = document.querySelector("#create-similar-cases");
  if (!typeSelect || !descriptionInput || !host) return;

  const type = typeSelect.value;
  const description = String(descriptionInput.value || "").trim();
  const descriptionWordCount = normalizeSearchText(description).split(/\s+/).filter(Boolean).length;
  if (type !== "challenge" || descriptionWordCount < CREATE_SIMILAR_MIN_WORDS) {
    clearCreateDescriptionSuggestions();
    return;
  }

  const titleInput = document.querySelector('#new-item-form [name="title"]');
  const stakeholderInput = document.querySelector('#new-item-form [name="stakeholders"]');
  const assignedDeptSelect = document.querySelector("#assign-to-dept");
  const title = String(titleInput?.value || "").trim();
  const stakeholders = uniqueList(String(stakeholderInput?.value || "").split(","));
  const assignedDept = String(assignedDeptSelect?.value || "").trim();
  const query = `${title} ${description}`.trim();
  const queryWordCount = normalizeSearchText(query).split(/\s+/).filter(Boolean).length;
  const matches = queryWordCount >= CREATE_SIMILAR_MIN_WORDS
    ? findCreateSimilarCases(query)
    : [];
  const suggestions = buildDescriptionAssistantSuggestions({ title, description, stakeholders, assignedDept });
  const totalSuggestionCount = suggestions.length + (matches.length ? 1 : 0);
  const similarCasesHTML = matches.length
    ? matches.map(({ item, score }) => {
      const matchPct = Math.max(1, Math.round(Math.min(score, 0.99) * 100));
      const statusLabel = item.status === "closed" ? "Closed" : "Resolved";
      return `
        <button type="button" class="desc-assistant-case" data-action="open-create-similar" data-item-id="${item.id}">
          <div class="desc-assistant-case-head">
            <span class="desc-assistant-case-id">${escapeHtml(item.id)}</span>
            <span class="desc-assistant-case-score">${matchPct}% match</span>
          </div>
          <p class="desc-assistant-case-title">${escapeHtml(item.title)}</p>
          <p class="desc-assistant-case-meta">${statusLabel} · ${escapeHtml(item.department)}</p>
          ${(item.solution || "").trim()
            ? `<p class="desc-assistant-case-solution">${escapeHtml(truncate(item.solution, 140))}</p>`
            : ""}
        </button>
      `;
    }).join("")
    : `<p class="desc-assistant-empty">No strong resolved matches yet. Add more specific context to improve matching.</p>`;

  host.innerHTML = `
    <div class="desc-assistant-panel">
      <div class="desc-assistant-head">
        <p class="desc-assistant-title">Description Assistant</p>
        <span class="desc-assistant-count">${totalSuggestionCount} suggestion${totalSuggestionCount === 1 ? "" : "s"}</span>
      </div>
      <div class="desc-assistant-list">
        ${suggestions.map((entry) => `
          <article class="desc-assistant-item">
            <h4>${escapeHtml(entry.title)}</h4>
            <p>${escapeHtml(entry.body)}</p>
          </article>
        `).join("")}
      </div>
      <div class="desc-assistant-similar">
        <div class="desc-assistant-similar-head">
          <p>Similar resolved cases</p>
          <span>${matches.length} match${matches.length === 1 ? "" : "es"}</span>
        </div>
        <div class="desc-assistant-cases">
          ${similarCasesHTML}
        </div>
        <p class="desc-assistant-foot">Click a case to open details and reuse context.</p>
      </div>
    </div>
  `;
  host.classList.remove("is-hidden");
}

// ── Similarity Explorer ──────────────────────────────────────────────────────

const SIMILARITY_LEVELS = [
  { key: "very-high", label: "Very High", min: 0.60, max: Infinity },
  { key: "high",      label: "High",      min: 0.45, max: 0.5999 },
  { key: "medium",    label: "Medium",    min: 0.30, max: 0.4499 },
  { key: "low",       label: "Low",       min: 0.18, max: 0.2999 },
  { key: "very-low",  label: "Very Low",  min: 0.08, max: 0.1799 },
];

function computeSimilarityForItem(sourceItem) {
  const sourceTokens = tokenizeText(buildItemCorpus(sourceItem));
  return items
    .filter((item) => item.id !== sourceItem.id)
    .map((item) => {
      const score = similarityScore(sourceTokens, tokenizeText(buildItemCorpus(item)));
      return { item, score };
    })
    .filter(({ score }) => score >= 0.08)
    .sort((a, b) => b.score - a.score);
}

function renderSimilarityExplorer(sourceItem) {
  const scored = computeSimilarityForItem(sourceItem);

  const buckets = SIMILARITY_LEVELS.map((level) => ({
    ...level,
    cases: scored.filter(({ score }) => score >= level.min && score <= level.max),
  }));

  const buttonsHTML = buckets
    .map(
      ({ key, label, cases }) =>
        `<button type="button" class="sim-level-btn" data-sim-level="${key}">
          ${label} <span class="sim-level-count">${cases.length}</span>
        </button>`
    )
    .join("");

  return `
    <div class="sim-explorer" id="sim-explorer" data-item-id="${sourceItem.id}">
      <h4 class="sim-explorer-title">Similarity Explorer</h4>
      <p class="sim-explorer-sub">Click a level to see matching cases from the archive.</p>
      <div class="sim-level-bar">${buttonsHTML}</div>
      <div id="sim-results" class="sim-results" aria-live="polite"></div>
    </div>
  `;
}

function handleSimilarityLevelClick(levelKey, sourceItemId) {
  const sourceItem = items.find((entry) => entry.id === sourceItemId);
  if (!sourceItem) return;

  const level = SIMILARITY_LEVELS.find((l) => l.key === levelKey);
  if (!level) return;

  const scored = computeSimilarityForItem(sourceItem);
  const matches = scored.filter(({ score }) => score >= level.min && score <= level.max);

  // Toggle active state on buttons
  document.querySelectorAll(".sim-level-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.simLevel === levelKey);
  });

  const resultsEl = document.querySelector("#sim-results");
  if (!resultsEl) return;

  if (!matches.length) {
    resultsEl.innerHTML = `<p class="sim-empty">No cases found at this similarity level.</p>`;
    return;
  }

  const rowsHTML = matches
    .map(
      ({ item, score }) => `
      <div class="sim-case-row" data-item-id="${item.id}" role="button" tabindex="0" title="Open ${item.id}">
        <div class="sim-case-head">
          <span class="sim-case-id">${item.id}</span>
          <span class="sim-case-pct">${Math.round(score * 100)}% match</span>
        </div>
        <div class="sim-case-meta">
          <span class="chip chip-type-${item.type}">${toLabel(item.type)}</span>
          <span class="chip chip-status">${toLabel(item.status)}</span>
        </div>
        <p class="sim-case-title">${escapeHtml(item.title)}</p>
      </div>`
    )
    .join("");

  resultsEl.innerHTML = rowsHTML;
}

// ── End Similarity Explorer ──────────────────────────────────────────────────

function assistantRoleLabel() {
  return isSupervisorView() ? "supervisor" : "sales representative";
}

function isResolvedLikeStatus(status) {
  return status === "resolved" || status === "closed";
}

function buildAssistantFallbackAdvice(matches) {
  const roleLabel = assistantRoleLabel();

  if (!matches.length) {
    return {
      answer: [
        "Quick assessment:",
        "No close resolved match found in the selected archive scope.",
        "",
        "Relevant historical cases:",
        "1. No high-confidence case match yet.",
        "",
        "What worked before:",
        "- No documented fix available for this query in the current selection.",
        "",
        `Recommended actions for ${roleLabel}:`,
        "1. Log the challenge with concrete facts (what, where, when, impact).",
        "2. Assign one owner and set a due date before the next meeting.",
        "3. Add an update after first action so similar cases become reusable.",
        "",
        "Escalate when:",
        "- Customer impact is increasing or SLA risk is visible.",
        "- No clear root cause is found within one working day.",
      ].join("\n"),
      matches: [],
    };
  }

  const topCases = matches.slice(0, 3);
  const solvedWithSolution = topCases.filter(
    (item) => isResolvedLikeStatus(item.status) && (item.solution || "").trim().length > 0
  );

  const lines = [];
  lines.push("Quick assessment:");
  lines.push(
    solvedWithSolution.length
      ? "There is a relevant historical solution you can reuse with minor adaptation."
      : "There are similar cases, but no fully documented resolved solution in the closest matches."
  );
  lines.push("");
  lines.push("Relevant historical cases:");
  topCases.forEach((item, index) => {
    lines.push(`${index + 1}. ${truncate(item.title, 98)} (${toLabel(item.type)}, ${toLabel(item.status)}).`);
  });
  lines.push("");
  lines.push("What worked before:");
  if (solvedWithSolution.length) {
    solvedWithSolution.slice(0, 2).forEach((item) => {
      lines.push(`- ${truncate(item.solution, 170)}`);
    });
  } else {
    lines.push("- No documented fix yet in the top matched cases.");
  }
  lines.push("");
  lines.push(`Recommended actions for ${roleLabel}:`);
  if (isSupervisorView()) {
    lines.push("1. Reuse the closest proven action and assign one accountable owner now.");
    lines.push("2. Confirm cross-functional dependencies and set an update checkpoint within 24 hours.");
    lines.push("3. Decide upfront whether this stays local or needs escalation in the next meeting.");
  } else {
    lines.push("1. Apply the closest proven action in your store/account context.");
    lines.push("2. Capture result evidence (impact, blockers, timing) and post one clear update.");
    lines.push("3. Escalate early if impact grows or ownership is unclear.");
  }
  lines.push("");
  lines.push("Escalate when:");
  lines.push("- Impact is high and the first corrective step does not improve results.");
  lines.push("- Another department is needed and no owner confirms support.");

  return {
    answer: lines.join("\n"),
    matches: [],
  };
}

function buildAssistantCaseContext(matches) {
  return matches
    .map((item, index) => {
      const similarity = `${Math.max(0, Math.min(99, Math.round((item.similarity || 0) * 100)))}%`;
      const solution = item.solution ? truncate(item.solution, 320) : "No documented solution yet.";
      return [
        `${index + 1}. ID: ${item.id}`,
        `Type: ${toLabel(item.type)}`,
        `Status: ${toLabel(item.status)}`,
        `Department: ${item.department}`,
        `Title: ${item.title}`,
        `Description: ${truncate(item.description || "", 320)}`,
        `Solution: ${solution}`,
        `Similarity: ${similarity}`,
      ].join("\n");
    })
    .join("\n\n");
}

function extractOpenAITextFromResponse(payload) {
  if (!payload) return "";
  if (typeof payload.answer === "string") return payload.answer.trim();
  if (typeof payload.output_text === "string") return payload.output_text.trim();
  if (typeof payload.text === "string") return payload.text.trim();
  if (payload.message && typeof payload.message.content === "string") return payload.message.content.trim();

  const segments = [];
  if (Array.isArray(payload.output)) {
    payload.output.forEach((entry) => {
      if (Array.isArray(entry.content)) {
        entry.content.forEach((part) => {
          if (typeof part?.text === "string") segments.push(part.text);
        });
      }
    });
  }
  return segments.join("\n").trim();
}

function sanitizeAssistantAnswer(rawText) {
  return String(rawText || "")
    .replace(/\bHJD\d{3,}\b/gi, "a similar historical case")
    .replace(/\bsource(?:s)?\s*:\s*[^\n]+/gi, "")
    .replace(/\breference(?:s)?\s*:\s*[^\n]+/gi, "")
    .replace(/\b(in many|across|in various)\s+industr(?:y|ies)\b/gi, "")
    .replace(/\bakin to\b/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildAssistantCaseLinks(matches, limit = 3) {
  if (!Array.isArray(matches) || !matches.length) return [];

  const ranked = [...matches].sort((a, b) => {
    const scoreA =
      (a.similarity || 0) +
      (isResolvedLikeStatus(a.status) ? 0.12 : 0) +
      ((a.solution || "").trim().length > 0 ? 0.08 : 0);
    const scoreB =
      (b.similarity || 0) +
      (isResolvedLikeStatus(b.status) ? 0.12 : 0) +
      ((b.solution || "").trim().length > 0 ? 0.08 : 0);
    return scoreB - scoreA;
  });

  return ranked.slice(0, limit).map((item) => ({
    id: item.id,
    title: truncate(item.title || "Untitled case", 88),
    issue: truncate(item.description || "", 90),
    resolution:
      (item.solution || "").trim().length > 0
        ? truncate(item.solution, 105)
        : "No documented solution yet.",
    status: item.status,
    type: item.type,
    department: item.department,
    match: Math.max(1, Math.round(Math.min(item.similarity || 0, 0.99) * 100)),
  }));
}

function isActionableAssistantAnswer(text, challengeIntent) {
  const value = String(text || "");
  if (!value) return false;
  if (!challengeIntent) return value.length > 0;
  const lowered = value.toLowerCase();
  const hasQuickAssessmentSection = lowered.includes("quick assessment:");
  const hasHistoricalCasesSection = lowered.includes("relevant historical cases:");
  const hasWorkedBeforeSection = lowered.includes("what worked before:");
  const hasActionsSection = lowered.includes("recommended actions");
  const hasEscalateSection = lowered.includes("escalate when:");
  const hasNumberedSteps = /\n1\.\s.+/m.test(value) && /\n2\.\s.+/m.test(value);
  const genericNoise = /libraries organize|in various industries|across industries|general best practice/i.test(
    value
  );
  return hasQuickAssessmentSection && hasHistoricalCasesSection && hasWorkedBeforeSection && hasActionsSection && hasEscalateSection && hasNumberedSteps && !genericNoise;
}

async function askLLMForAssistantAnswer(query, matches, challengeIntent) {
  if (!ASSISTANT_LLM_CONFIG.enabled) return null;

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), ASSISTANT_LLM_CONFIG.timeoutMs);
  const roleLabel = assistantRoleLabel();

  const systemPrompt = [
    "You are the RED in-SYNCC Smart Assistant.",
    "If archive cases are provided, only use those for historical facts; do not invent facts.",
    "Answer in the same language as the user question.",
    "Be practical and concise. Avoid generic theory, analogies, and external industry examples.",
    `The user role is: ${roleLabel}. Tailor recommendations to this role.`,
    "Do NOT include case IDs, source citations, references, confidence percentages, or retrieval details.",
    challengeIntent
      ? [
          "This is a challenge-related request.",
          "Prioritize resolved/closed cases with documented solutions.",
          "If no documented solution exists, state that clearly.",
          "Output with these headings in this order:",
          "Quick assessment:",
          "Relevant historical cases:",
          "What worked before:",
          `Recommended actions for ${roleLabel}:`,
          "Escalate when:",
          "Use max 3 historical cases and max 3 action steps.",
          "Keep the total answer under 180 words.",
          "Action steps must be specific and executable in a weekly sales workflow.",
          "Use numbered steps for actions:",
          "1. ...",
          "2. ...",
          "3. ...",
        ].join("\n")
      : [
          "This is casual conversation or a general question.",
          "Reply naturally like a human teammate in 1-3 short sentences.",
          "Do not force structured headings for casual chat.",
          "Offer to help with a concrete challenge when relevant.",
        ].join("\n"),
  ].join("\n");

  const casesContext = matches.length
    ? buildAssistantCaseContext(matches)
    : "No candidate archive cases found for this question.";

  const userPrompt = [
    `User question: ${query}`,
    "",
    "Candidate archive cases:",
    casesContext,
    "",
    challengeIntent
      ? "Give a concise practical answer for this specific challenge. Prefer resolved/closed cases with clear documented solutions."
      : "Reply naturally and helpfully to the user message.",
    "No IDs or source citations.",
    "Do not include generic best-practice text that is not directly grounded in the provided cases.",
  ].join("\n");

  try {
    let response;
    if (ASSISTANT_LLM_CONFIG.provider === "openai-proxy") {
      response = await fetch(ASSISTANT_LLM_CONFIG.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: ASSISTANT_LLM_CONFIG.model,
          temperature: ASSISTANT_LLM_CONFIG.temperature,
          systemPrompt,
          query,
          cases: matches.map((item) => ({
            id: item.id,
            type: item.type,
            status: item.status,
            department: item.department,
            title: item.title,
            description: item.description,
            solution: item.solution || "",
            similarity: item.similarity || 0,
          })),
          userPrompt,
        }),
      });
    } else {
      // Optional local fallback provider
      response = await fetch(ASSISTANT_LLM_CONFIG.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: ASSISTANT_LLM_CONFIG.model,
          stream: false,
          options: { temperature: ASSISTANT_LLM_CONFIG.temperature },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });
    }

    if (!response.ok) return null;
    const data = await response.json();
    const text = extractOpenAITextFromResponse(data);
    if (!text) return null;
    return text;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function buildAssistantAdvice(query) {
  const archivePool = getArchiveFilteredItems({ useQuery: false });
  const matches = findSimilarCases(query, ASSISTANT_LLM_CONFIG.contextCaseLimit, archivePool);
  const challengeIntent = inferChallengeIntent(query || "", matches);
  const fallback = buildAssistantFallbackAdvice(matches.slice(0, ASSISTANT_LLM_CONFIG.uiMatchLimit));
  const caseLinks = buildAssistantCaseLinks(matches, 3);

  const llmAnswer = await askLLMForAssistantAnswer(query, matches, challengeIntent);
  const useLlmAnswer = isActionableAssistantAnswer(llmAnswer, challengeIntent);
  if (!llmAnswer && !assistantLlmUnavailableNotified) {
    assistantLlmUnavailableNotified = true;
    showToast("LLM API not available. Using built-in assistant logic.");
  }

  if (useLlmAnswer) {
    return {
      answer: sanitizeAssistantAnswer(llmAnswer),
      matches: challengeIntent ? caseLinks : [],
    };
  }

  return {
    answer: challengeIntent ? sanitizeAssistantAnswer(fallback.answer) : buildAssistantOfflineChatFallback(query),
    matches: challengeIntent ? caseLinks : [],
  };
}

function renderAssistantMessages() {
  const container = document.querySelector("#assistant-messages");
  if (!container) return;

  if (!assistantThread.length) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = assistantThread
    .map((message) => {
      if (message.role === "user") {
        return `
          <article class="assistant-message user">
            <p>${formatMessageText(message.text)}</p>
          </article>
        `;
      }

      const matchesMarkup = (message.matches || [])
        .map(
          (item) => `
          <article class="assistant-case-card">
            <p class="assistant-case-title">${escapeHtml(item.title || "")}</p>
            <p class="assistant-case-line"><strong>Issue:</strong> ${escapeHtml(item.issue || "")}</p>
            <p class="assistant-case-line"><strong>Solved:</strong> ${escapeHtml(item.resolution || "")}</p>
            <button type="button" class="assistant-case-btn" data-item-id="${item.id}">Open full case</button>
          </article>
        `
        )
        .join("");

      return `
        <article class="assistant-message bot">
          <p>${formatAssistantMessageText(message.text)}</p>
          ${matchesMarkup ? `<div class="assistant-cases">${matchesMarkup}</div>` : ""}
        </article>
      `;
    })
    .join("");

  container.scrollTop = container.scrollHeight;
}

function seedAssistantThread() {
  if (assistantThread.length) return;
  assistantThread.push({
    role: "assistant",
    text: "Hey! I am your smart archive assistant. Share your challenge and I will return a short summary, practical advice based on similar cases, and direct case links.",
    matches: [],
  });
}

async function runAssistantTurn(question) {
  assistantThread.push({ role: "user", text: question });
  const pending = { role: "assistant", text: "Analyzing archive cases...", matches: [] };
  assistantThread.push(pending);
  renderAssistantMessages();

  try {
    const response = await buildAssistantAdvice(question);
    pending.text = response.answer;
    pending.matches = response.matches;
  } catch {
    pending.text = "I hit an error while generating advice. Please try again.";
    pending.matches = [];
  }

  renderAssistantMessages();
}

async function handleAssistantSubmit(event) {
  event.preventDefault();
  const input = document.querySelector("#assistant-input");
  if (!input) return;

  const question = input.value.trim();
  if (!question) return;
  input.value = "";
  await runAssistantTurn(question);
}

function isOpenStatus(status) {
  return !["resolved", "closed"].includes(status);
}

function isOverdue(item) {
  if (!item.dueDate || !isOpenStatus(item.status)) return false;
  const due = new Date(item.dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return due < today;
}

function getStatusCount(status) {
  return items.filter((item) => item.status === status).length;
}

function sortedAgendaItems() {
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  return items
    .filter((item) => isOpenStatus(item.status))
    .filter((item) => item.meetingNeeded !== false)
    .filter((item) => (item.weekStart || activeMeetingWeek) === activeMeetingWeek)
    // V2: Department filter (Tutor Feedback §5)
    .filter((item) => activeDeptFilter === "all" || item.department === activeDeptFilter || item.assignedToDept === activeDeptFilter)
    // V2: Meeting level filter (Tutor Feedback §6)
    .filter((item) => activeMeetingLevelFilter === "all" || item.meetingLevel === activeMeetingLevelFilter)
    .sort((a, b) => {
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      }
      return new Date(a.createdAt) - new Date(b.createdAt);
    });
}

function formatMeetingWeekLabel(dateISO) {
  const date = new Date(dateISO + "T12:00:00");
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function renderMeetingWeekContext() {
  const mondayLabel = formatMeetingWeekLabel(activeMeetingWeek);

  const dashboardTitle = document.querySelector("#dashboard-agenda-title");
  if (dashboardTitle) {
    dashboardTitle.textContent =
      "Agenda - " + (meetingWeekView === "next" ? "next" : "") + " RED IN-SYNCC meeting";
  }

  const dashboardSubtitle = document.querySelector("#dashboard-agenda-subtitle");
  if (dashboardSubtitle) dashboardSubtitle.textContent = "Meeting Monday: " + mondayLabel;

  const meetingLabel = document.querySelector("#meeting-week-label");
  if (meetingLabel) {
    meetingLabel.textContent =
      (meetingWeekView === "next" ? "Previewing next meeting" : "Current meeting") + " · " + mondayLabel;
  }

  ["#view-current-meeting-week", "#view-current-dashboard-week"].forEach((selector) => {
    const button = document.querySelector(selector);
    if (button) button.classList.toggle("is-week-active", meetingWeekView === "current");
  });

  ["#view-next-meeting-week", "#view-next-dashboard-week"].forEach((selector) => {
    const button = document.querySelector(selector);
    if (button) button.classList.toggle("is-week-active", meetingWeekView === "next");
  });
}

function renderStats() {
  const openItems = items.filter((item) => isOpenStatus(item.status));
  const overdue = openItems.filter((item) => isOverdue(item)).length;

  // Hero metrics — only visible for supervisor
  const heroMetrics = document.querySelector(".hero-metrics");
  if (heroMetrics) heroMetrics.style.display = isSupervisorView() ? "" : "none";

  if (isSupervisorView()) {
    const metricOpen = document.querySelector("#metric-open");
    const metricOverdue = document.querySelector("#metric-overdue");
    if (metricOpen) metricOpen.textContent = String(openItems.length);
    if (metricOverdue) metricOverdue.textContent = String(overdue);

    // Make hero metric tiles clickable
    document.querySelectorAll(".metric-tile[data-metric-key]").forEach((tile) => {
      tile.style.cursor = "pointer";
    });
    const tileOpen = document.querySelector(".metric-tile[data-metric-key='open']");
    const tileOverdue = document.querySelector(".metric-tile[data-metric-key='overdue']");
    if (tileOpen) {
      tileOpen._metricIds = openItems.map((i) => i.id);
    }
    if (tileOverdue) {
      tileOverdue._metricIds = openItems.filter((i) => isOverdue(i)).map((i) => i.id);
    }
  }

  // KPI grid — only for supervisor
  const kpiPanel = document.querySelector(".dashboard-kpi-panel");
  if (kpiPanel) kpiPanel.style.display = isSupervisorView() ? "" : "none";

  if (!isSupervisorView()) return;

  const statusGroups = {
    "new":      { label: "New",      ids: items.filter((i) => i.status === "new").map((i) => i.id) },
    "assigned": { label: "Assigned", ids: items.filter((i) => i.status === "assigned").map((i) => i.id) },
    "escalated":{ label: "Escalated",ids: items.filter((i) => i.status === "escalated").map((i) => i.id) },
    "resolved": { label: "Resolved", ids: items.filter((i) => i.status === "resolved").map((i) => i.id) },
  };

  const kpiGrid = document.querySelector("#kpi-grid");
  kpiGrid.innerHTML = "";
  Object.entries(statusGroups).forEach(([key, { label, ids }], idx) => {
    const card = document.createElement("article");
    card.className = "kpi-card kpi-card-clickable";
    card.style.setProperty("--delay", `${idx * 0.06}s`);
    card.title = `Click to view ${label} cases`;
    card.innerHTML = `<h3>${label}</h3><p>${ids.length}</p><span class="kpi-card-hint">View cases →</span>`;
    card.addEventListener("click", () => openAnalyticsPopup(`${label} Cases`, ids));
    kpiGrid.appendChild(card);
  });
}

function itemCardMarkup(item) {
  const escalationSuggestion = getEscalationSuggestion(item);
  const suggestionChip = escalationSuggestion ? `<span class="chip chip-alert">Escalation suggested</span>` : "";
  const deptChip = item.assignedToDept ? `<span class="chip chip-assigned-dept">→ ${item.assignedToDept}</span>` : "";
  const levelChip = item.meetingLevel ? `<span class="chip chip-meeting-level">${meetingLayerLabel(item.meetingLevel).replace(/ Meeting.*/, "")}</span>` : "";
  return `
    <article class="item-card" data-item-id="${item.id}">
      <div class="item-meta">
        <span class="chip chip-type-${item.type}">${toLabel(item.type)}</span>
        <span class="chip chip-status">${toLabel(item.status)}</span>
        <span class="chip chip-priority-${item.priority}">${toLabel(item.priority)}</span>
        ${deptChip}
        ${levelChip}
        ${suggestionChip}
      </div>
      <h3>${item.title}</h3>
      <p class="item-byline">Added by ${item.createdBy || "Unknown"} · ${item.department}</p>
      <p class="item-summary">${truncate(item.description)}</p>
    </article>
  `;
}

function renderDashboard() {
  const container = document.querySelector("#dashboard-items");
  const agendaItems = sortedAgendaItems();
  container.innerHTML = agendaItems.length ? agendaItems.map(itemCardMarkup).join("") : '<p class="dash-empty">No open items for ' + (meetingWeekView === "next" ? "next" : "current") + ' week.</p>';
  _setBadge("badge-agenda", agendaItems.length);
  renderPreviousWeekSummary();
  renderCelebrationCards();
  renderMyFocus();
  renderMyDeptFocus();
  renderRecommendations();
  renderRailNotifications();
  renderDashFavorites();
  renderPersonalPanel();
}

function openDashboardDropdown(sectionKey) {
  const dashboardScreen = document.querySelector("#screen-dashboard");
  if (!dashboardScreen?.classList.contains("is-visible")) switchTab("dashboard");
  const list = document.querySelector("#dash-dropdowns");
  if (!list) return;
  const toggle = list.querySelector(`.dd-toggle[data-dd="${sectionKey}"]`);
  if (!toggle) return;
  const card = toggle.closest(".dd-card");
  if (!card) return;
  card.classList.add("is-open");
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function syncSettingsNavLabel() {
  const settingsLabel = document.querySelector("#settings-nav-label");
  if (!settingsLabel) return;
  settingsLabel.textContent = isSupervisorView() ? "Admin Settings" : "Settings";
}

function renderPersonalPanel() {
  const panel = document.querySelector("#left-rail");
  if (!panel) return;

  const user = _currentUser();
  const roleLabel = isSupervisorView() ? "Supervisor" : "Sales Representative";
  const deptLabelForSupervisor = "All Departments";
  const relevant = isSupervisorView()
    ? items
    : items.filter((item) => item.createdBy === user || item.assignedTo === user || item.stakeholders?.includes(user));
  const openItems = relevant.filter((item) => isOpenStatus(item.status));
  const resolvedItems = relevant.filter((item) => item.status === "resolved" || item.status === "closed");
  const likesGiven = items.filter((item) => (item.type === "celebration" || item.type === "contribution") && uniqueList(item.likedBy || []).includes(user)).length;
  const deptCandidates = uniqueList(relevant.map((item) => item.department));
  const deptLabel = isSupervisorView() ? deptLabelForSupervisor : (activeDeptFilter !== "all" ? activeDeptFilter : (deptCandidates[0] || "Cross-functional"));
  const initials = user
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("") || "CU";

  const nameEl = document.querySelector("#personal-name");
  const roleEl = document.querySelector("#personal-role");
  const deptEl = document.querySelector("#personal-dept");
  const avatarEl = document.querySelector("#personal-avatar");
  const openEl = document.querySelector("#personal-open-count");
  const resolvedEl = document.querySelector("#personal-resolved-count");
  const likesEl = document.querySelector("#personal-likes-count");
  const focusEl = document.querySelector("#personal-focus-list");

  if (nameEl) nameEl.textContent = user;
  if (roleEl) roleEl.textContent = roleLabel;
  if (deptEl) deptEl.textContent = deptLabel;
  if (avatarEl) avatarEl.textContent = initials;
  if (openEl) openEl.textContent = String(openItems.length);
  if (resolvedEl) resolvedEl.textContent = String(resolvedItems.length);
  if (likesEl) likesEl.textContent = String(likesGiven);
  syncSettingsNavLabel();

  if (!focusEl) return;
  const priorityRank = { high: 0, medium: 1, low: 2 };
  const focusItems = openItems
    .slice()
    .sort((a, b) => {
      const pDiff = (priorityRank[a.priority] ?? 3) - (priorityRank[b.priority] ?? 3);
      if (pDiff !== 0) return pDiff;
      return (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31");
    })
    .slice(0, 4);

  focusEl.innerHTML = focusItems.length
    ? focusItems.map((item) => `
      <button type="button" class="personal-focus-item" data-item-id="${item.id}">
        <span class="personal-focus-title">${escapeHtml(truncate(item.title, 54))}</span>
        <span class="personal-focus-meta">${escapeHtml(item.id)} &middot; ${escapeHtml(toLabel(item.status))}</span>
      </button>
    `).join("")
    : '<p class="dash-empty">No personal open items.</p>';
}

// ═══ Summary of Previous Week ═══════════════════════════════════════════

function renderPreviousWeekSummary() {
  const el = document.querySelector("#prev-week-items");
  if (!el) return;
  const prevMonday = addDaysISO(activeMeetingWeek, -7);
  const prevSunday = addDaysISO(prevMonday, 6);

  // Items from previous week (fallback to recent if none)
  let pool = items.filter(i => i.type === "challenge" && i.createdAt >= prevMonday && i.createdAt <= prevSunday);
  if (!pool.length) pool = items.filter(i => i.type === "challenge").slice(0, 20);

  const resolved = pool.filter(i => i.status === "resolved" || i.status === "closed");
  const openEsc = pool.filter(i => isOpenStatus(i.status));
  const celebContrib = items.filter(i => (i.type === "celebration" || i.type === "contribution") && i.createdAt >= prevMonday && i.createdAt <= prevSunday);

  _setBadge("badge-prev-week", resolved.length + openEsc.length || "");

  let h = '<div class="pw-grid"><div>';
  h += '<h4 class="pw-col-title">&#x2705; Solved (' + resolved.length + ')</h4>';
  h += resolved.length ? resolved.slice(0, 6).map(i =>
    `<div class="pw-item pw-resolved" data-item-id="${i.id}"><strong>${i.id} &middot; ${escapeHtml(truncate(i.title, 45))}</strong><div class="pw-item-meta">${escapeHtml(i.department)}${i.resolvedBy ? " &middot; " + escapeHtml(i.resolvedBy) : ""}</div></div>`
  ).join("") : '<p class="dash-empty">None last week.</p>';
  h += '</div><div>';
  h += '<h4 class="pw-col-title">&#x1F7E0; Still Open / Escalated (' + openEsc.length + ')</h4>';
  h += openEsc.length ? openEsc.slice(0, 6).map(i => {
    const cls = i.status === "escalated" ? "pw-escalated" : "pw-open";
    return `<div class="pw-item ${cls}" data-item-id="${i.id}"><strong>${i.id} &middot; ${escapeHtml(truncate(i.title, 45))}</strong><div class="pw-item-meta">${toLabel(i.status)}${getOwnerName(i) ? " &middot; " + escapeHtml(getOwnerName(i)) : ""}</div></div>`;
  }).join("") : '<p class="dash-empty">All resolved!</p>';
  h += '</div></div>';

  if (celebContrib.length) {
    h += '<div class="pw-celeb"><h4 class="pw-col-title">&#x1F389; Celebrations &amp; Contributions</h4><div class="celeb-grid">';
    h += celebContrib.slice(0, 4).map(i =>
      `<div class="pw-item" data-item-id="${i.id}"><strong>${escapeHtml(i.createdBy)}</strong><div class="pw-item-meta">${escapeHtml(truncate(i.title, 50))}</div></div>`
    ).join("") + '</div></div>';
  }
  el.innerHTML = h;
}

// ═══ Celebrations & Contributions Pop-up Cards ══════════════════════════

function renderCelebrationCards() {
  const el = document.querySelector("#celebration-cards");
  if (!el) return;
  const viewer = _currentUser();
  const celebs = items.filter(i => i.type === "celebration" || i.type === "contribution")
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 12);
  _setBadge("badge-celebrations", celebs.length || "");
  if (!celebs.length) { el.innerHTML = '<p class="dash-empty">No celebrations yet.</p>'; return; }

  el.innerHTML = '<div class="celeb-grid">' + celebs.map(i => {
    const chip = i.type === "celebration" ? "chip-type-celebration" : "chip-type-contribution";
    const likes = uniqueList(i.likedBy || []);
    const likedByViewer = likes.includes(viewer);
    const likesCountLabel = `${likes.length} like${likes.length === 1 ? "" : "s"}`;
    const likesTitle = likes.length ? `Liked by ${likes.join(", ")}` : "No likes yet";
    const likesPreview = likes.length ? `Liked by ${truncate(likes.join(", "), 48)}` : "No likes yet";
    return `<div class="celeb-card" data-item-id="${i.id}">
      <div class="celeb-card-top"><span class="celeb-card-name">${escapeHtml(i.createdBy)}</span><span class="chip ${chip}">${toLabel(i.type)}</span></div>
      <p class="celeb-card-id">${i.id}</p>
      <p class="celeb-card-desc">${escapeHtml(i.description)}</p>
      <div class="celeb-card-footer">
        <div class="celeb-card-actions">
          <button class="celeb-congrats-btn" data-celeb-congrats="${i.id}">
            <span class="celeb-pill-icon" aria-hidden="true">&#x1F389;</span>
            <span class="celeb-pill-label">Congrats</span>
          </button>
          <button
            class="celeb-like-btn ${likedByViewer ? "is-liked" : ""}"
            data-celeb-like="${i.id}"
            aria-pressed="${likedByViewer}"
            title="${escapeHtml(likesTitle)}"
          >
            <span class="celeb-pill-icon" aria-hidden="true">&#x1F44D;</span>
            <span class="celeb-pill-label">${likesCountLabel}</span>
          </button>
        </div>
        <p class="celeb-like-meta" title="${escapeHtml(likesTitle)}">${escapeHtml(likesPreview)}</p>
      </div>
    </div>`;
  }).join("") + '</div>';
}

function toggleCelebrationLike(itemId) {
  const item = items.find((entry) => entry.id === itemId);
  if (!item) return;
  const actor = _currentUser();
  const likes = new Set(uniqueList(item.likedBy || []));
  const alreadyLiked = likes.has(actor);
  if (alreadyLiked) likes.delete(actor);
  else likes.add(actor);
  item.likedBy = Array.from(likes);
  if (!alreadyLiked && actor !== item.createdBy) {
    addNotification({
      type: "like",
      itemId: item.id,
      title: `New like on ${item.id}`,
      body: `${actor} liked your ${toLabel(item.type).toLowerCase()}: "${item.title}".`,
      department: item.department,
    });
  }
  saveItems();
  renderCelebrationCards();
  showToast(alreadyLiked ? `Removed your like from ${item.id}` : `${actor} liked ${item.id}`);
}

function openCongratsModal(itemId) {
  const item = items.find(i => i.id === itemId);
  if (!item) return;
  let modal = document.querySelector("#congrats-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "congrats-modal";
    modal.className = "congrats-overlay";
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal || e.target.closest(".cg-cancel")) { modal.classList.remove("is-open"); return; }
      const ob = e.target.closest(".cg-outlook");
      if (ob) {
        const s = encodeURIComponent("Congratulations! - " + ob.dataset.title);
        const b = encodeURIComponent("Hi " + ob.dataset.person + ",\n\nCongratulations on: " + ob.dataset.title + "\n\n" + ob.dataset.desc + "\n\nBest regards");
        window.location.href = "mailto:?subject=" + s + "&body=" + b;
        modal.classList.remove("is-open");
      }
      const tb = e.target.closest(".cg-teams");
      if (tb) {
        const msg = encodeURIComponent("Congratulations on: " + tb.dataset.title + "! \uD83C\uDF89");
        window.open("https://teams.microsoft.com/l/chat/0/0?message=" + msg, "_blank");
        modal.classList.remove("is-open");
        showToast("Opening Teams chat...");
      }
    });
  }
  modal.innerHTML = `<div class="cg-card">
    <h3>&#x1F389; Send Congratulations</h3>
    <p>How would you like to congratulate <strong>${escapeHtml(item.createdBy)}</strong>?</p>
    <div class="cg-btns">
      <button class="cg-outlook" data-person="${escapeHtml(item.createdBy)}" data-title="${escapeHtml(item.title)}" data-desc="${escapeHtml(item.description)}">&#x2709; Outlook</button>
      <button class="cg-teams" data-title="${escapeHtml(item.title)}">&#x1F4AC; Teams</button>
    </div>
    <button class="cg-cancel">Cancel</button>
  </div>`;
  modal.classList.add("is-open");
}

function initDropdowns() {
  const list = document.querySelector("#dash-dropdowns");
  if (!list) return;
  list.addEventListener("click", (e) => {
    const tog = e.target.closest(".dd-toggle");
    if (tog) { tog.closest(".dd-card").classList.toggle("is-open"); return; }
    const quickUnfav = e.target.closest("[data-fav-quick]");
    if (quickUnfav) { toggleFavorite(quickUnfav.dataset.favQuick); return; }
    const congratsBtn = e.target.closest("[data-celeb-congrats]");
    if (congratsBtn) { openCongratsModal(congratsBtn.dataset.celebCongrats); return; }
    const likeBtn = e.target.closest("[data-celeb-like]");
    if (likeBtn) { toggleCelebrationLike(likeBtn.dataset.celebLike); return; }
    const card = e.target.closest("[data-item-id]");
    if (card && !e.target.closest(".dd-toggle")) openDetailDrawer(card.dataset.itemId);
  });
}

function _setBadge(id, n) { const el = document.querySelector("#" + id); if (el) el.textContent = n || ""; }

function focusItemHTML(item) {
  const bar = item.status === "escalated" ? "bar-escalated" : item.status === "new" ? "bar-new" : item.priority === "high" ? "bar-high" : item.priority === "medium" ? "bar-medium" : "bar-low";
  return `<div class="focus-item" data-item-id="${item.id}"><div class="focus-bar ${bar}"></div><div class="focus-content"><div class="focus-top"><span class="focus-id">${item.id}</span><span class="chip chip-type-${item.type}">${toLabel(item.type)}</span><span class="chip chip-status">${toLabel(item.status)}</span><span class="chip chip-priority-${item.priority}">${toLabel(item.priority)}</span></div><p class="focus-title">${escapeHtml(item.title)}</p><p class="focus-meta">${item.department}${item.dueDate ? " &middot; Due " + item.dueDate : ""}</p></div></div>`;
}

function favoriteFocusItemHTML(item) {
  const bar = item.status === "escalated" ? "bar-escalated" : item.status === "new" ? "bar-new" : item.priority === "high" ? "bar-high" : item.priority === "medium" ? "bar-medium" : "bar-low";
  return `<div class="focus-item focus-item-favorite" data-item-id="${item.id}">
    <div class="focus-bar ${bar}"></div>
    <div class="focus-content">
      <div class="focus-content-head">
        <div class="focus-top">
          <span class="focus-id">${item.id}</span>
          <span class="chip chip-type-${item.type}">${toLabel(item.type)}</span>
          <span class="chip chip-status">${toLabel(item.status)}</span>
          <span class="chip chip-priority-${item.priority}">${toLabel(item.priority)}</span>
        </div>
        <button type="button" class="focus-unfav-btn" data-fav-quick="${item.id}" title="Remove from favorites">&#x2605; Unfavorite</button>
      </div>
      <p class="focus-title">${escapeHtml(item.title)}</p>
      <p class="focus-meta">${item.department}${item.dueDate ? " &middot; Due " + item.dueDate : ""}</p>
    </div>
  </div>`;
}

const SALES_REP_NAME = "Damian de Groot";
const SUPERVISOR_NAME = "Nadia van der Berg";

function _currentUser() {
  if (isSupervisorView()) return SUPERVISOR_NAME;
  const el = document.querySelector('[name="createdBy"]');
  return (el?.value || SALES_REP_NAME).trim();
}

function renderMyFocus() {
  const el = document.querySelector("#my-focus-items"); if (!el) return;
  const u = _currentUser();
  const my = items.filter(i => isOpenStatus(i.status) && (i.assignedTo === u || i.createdBy === u || i.stakeholders?.includes(u)))
    .sort((a, b) => ({high:0,medium:1,low:2}[a.priority]||2) - ({high:0,medium:1,low:2}[b.priority]||2)).slice(0, 8);
  _setBadge("badge-my-focus", my.length);
  el.innerHTML = my.length ? my.map(focusItemHTML).join("") : '<p class="dash-empty">No items assigned to you.</p>';
}

function renderMyDeptFocus() {
  const el = document.querySelector("#my-dept-items"); if (!el) return;
  const dept = activeDeptFilter !== "all" ? activeDeptFilter : "";
  let list = dept ? items.filter(i => isOpenStatus(i.status) && (i.department === dept || i.assignedToDept === dept)) : items.filter(i => isOpenStatus(i.status));
  list = list.sort((a, b) => ({high:0,medium:1,low:2}[a.priority]||2) - ({high:0,medium:1,low:2}[b.priority]||2)).slice(0, 8);
  _setBadge("badge-my-dept", list.length);
  el.innerHTML = (!dept ? '<p class="dash-empty" style="margin-bottom:8px">Select a department filter above, or showing top open items:</p>' : "") + (list.length ? list.map(focusItemHTML).join("") : '<p class="dash-empty">No open items.</p>');
}

function renderRecommendations() {
  const el = document.querySelector("#recommendation-items"); if (!el) return;
  const recs = [];
  items.filter(i => isHighPriorityOverdueChallenge(i)).slice(0,2).forEach(i => recs.push({icon:"warn",emoji:"\u26A0\uFE0F",title:`Escalate ${i.id}: overdue`,body:`"${truncate(i.title,50)}" overdue (due ${i.dueDate}).`,itemId:i.id}));
  items.filter(i => i.type==="challenge" && i.details?.isRecurring && isOpenStatus(i.status) && i.status!=="escalated").slice(0,2).forEach(i => recs.push({icon:"info",emoji:"\uD83D\uDD04",title:`Recurring: ${i.id}`,body:`"${truncate(i.title,50)}" recurring pattern.`,itemId:i.id}));
  items.filter(i => i.type==="challenge" && i.status==="new").slice(0,3).forEach(i => { const m = findMeetingGateMatch(`${i.title} ${i.description}`); if (m?.item) recs.push({icon:"tip",emoji:"\uD83D\uDCA1",title:`Reuse from ${m.item.id}`,body:`${Math.round(m.similarity*100)}% match for ${i.id}.`,itemId:i.id}); });
  items.filter(i => i.type==="challenge" && i.status==="new" && !i.assignedTo).slice(0,2).forEach(i => recs.push({icon:"warn",emoji:"\uD83D\uDCCB",title:`${i.id} needs owner`,body:`"${truncate(i.title,50)}" unassigned.`,itemId:i.id}));
  _setBadge("badge-recommendations", recs.length);
  el.innerHTML = recs.length ? '<div class="rec-list">' + recs.slice(0,6).map(r => `<div class="rec-card" data-item-id="${r.itemId}"><div class="rec-icon ${r.icon}">${r.emoji}</div><div class="rec-body"><h4>${escapeHtml(r.title)}</h4><p>${escapeHtml(r.body)}</p></div><div class="rec-action"><button class="mini-btn" data-item-id="${r.itemId}">View</button></div></div>`).join("") + '</div>' : '<p class="dash-empty">All items on track.</p>';
}

function renderRailNotifications() {
  const el = document.querySelector("#left-rail-notification-list");
  const badge = document.querySelector("#left-rail-notif-badge");
  if (!el) return;

  const unreadAll = loadNotifications().filter((n) => !n.read);
  const unread = unreadAll.slice(0, 24);
  if (badge) badge.textContent = unreadAll.length ? String(unreadAll.length) : "";
  if (!unread.length) {
    el.innerHTML = '<p class="dash-empty">No new notifications.</p>';
    return;
  }

  const iconByType = {
    assign: "\uD83D\uDCCB",
    escalate: "\u26A1",
    resolve: "\u2705",
    overdue: "\u23F0",
    like: "\uD83D\uDC4D",
    info: "\u2139\uFE0F",
  };

  el.innerHTML = unread.map((notif) => `
    <article class="left-rail-notif-item" data-notif-id="${notif.id}">
      <div class="left-rail-notif-top">
        <span class="left-rail-notif-icon">${iconByType[notif.type] || "\uD83D\uDCCC"}</span>
        <strong class="left-rail-notif-title">${escapeHtml(notif.title)}</strong>
      </div>
      <p class="left-rail-notif-body">${escapeHtml(truncate(notif.body, 78))}</p>
      <div class="left-rail-notif-footer">
        <span class="left-rail-notif-time">${getTimeAgo(notif.timestamp)}</span>
        <button type="button" class="left-rail-notif-read" data-notif-read="${notif.id}">Read</button>
      </div>
    </article>
  `).join("");
}

function renderMeeting() {
  const agenda = document.querySelector("#meeting-agenda");
  const canManage = isSupervisorView();
  const agendaItems = sortedAgendaItems();
  if (!agendaItems.length) {
    agenda.innerHTML = "<p>Agenda is clear for this meeting week. No open items.</p>";
    renderRecap();
    return;
  }

  agenda.innerHTML = agendaItems
    .map((item) => {
      const escalationSuggestion = getEscalationSuggestion(item);
      const suggestionHTML = escalationSuggestion
        ? `<p class="meeting-suggestion">Suggestion: overdue + high priority. Consider escalation.</p>`
        : "";
      const quickEscalateBtn = escalationSuggestion
        ? `<button class="mini-btn mini-btn-warn" data-action="quick-escalate" data-item-id="${item.id}">Quick Escalate</button>`
        : "";
      const editBtn = canManage
        ? `<button class="mini-btn mini-btn-edit" data-action="edit" data-item-id="${item.id}">✎ Edit</button>`
        : "";
      const actionsHTML = `
          <button class="mini-btn" data-action="assign" data-item-id="${item.id}">Assign</button>
          <button class="mini-btn" data-action="escalate" data-item-id="${item.id}">Escalate</button>
          ${quickEscalateBtn}
          <button class="mini-btn" data-action="resolve" data-item-id="${item.id}">Resolve</button>
          <button class="mini-btn" data-action="defer" data-item-id="${item.id}">Defer to next week</button>
          <button class="mini-btn" data-action="details" data-item-id="${item.id}">Details</button>
          ${editBtn}
        `;

      return `
      <article class="meeting-item">
        <div class="meeting-head">
          <div>
            <div class="item-meta">
              <span class="chip chip-type-${item.type}">${toLabel(item.type)}</span>
              <span class="chip chip-status">${toLabel(item.status)}</span>
              <span class="chip chip-priority-${item.priority}">${toLabel(item.priority)}</span>
              ${item.assignedToDept ? `<span class="chip chip-assigned-dept">→ ${item.assignedToDept}</span>` : ""}
              ${item.meetingLevel ? `<span class="chip chip-meeting-level">${meetingLayerLabel(item.meetingLevel).replace(/ Meeting.*/, "")}</span>` : ""}
              ${escalationSuggestion ? '<span class="chip chip-alert">Escalation suggested</span>' : ""}
            </div>
            <strong>${item.id} · ${item.title}</strong>
            <p>${truncate(item.description, 120)}</p>
            ${suggestionHTML}
          </div>
        </div>
        <div class="meeting-actions">
          ${actionsHTML}
        </div>
      </article>
    `;
    })
    .join("");
}

function renderArchive() {
  const filtered = getArchiveFilteredItems({ useQuery: true });

  const container = document.querySelector("#archive-results");
  if (!filtered.length) {
    container.innerHTML = "<p>No results match these filters.</p>";
  } else {
    container.innerHTML = filtered.map((item) => {
      const support = item.assignedToDept ? `<span class="arch-support-tag">&rarr; ${escapeHtml(item.assignedToDept)}</span>` : "";
      const isFav = _getFavorites().includes(item.id);
      const editBtn = isSupervisorView()
        ? `<button class="arc-mini arc-mini-edit" data-arc="edit" data-item-id="${item.id}" title="Edit">&#9998;</button>`
        : "";
      const desc = truncate(item.description, 80);
      return `<div class="archive-card" data-item-id="${item.id}">
        <div class="archive-card-top"><div class="item-meta">
          <span class="chip chip-type-${item.type}">${toLabel(item.type)}</span>
          <span class="chip chip-status">${toLabel(item.status)}</span>
          <span class="chip chip-priority-${item.priority}">${toLabel(item.priority)}</span>
        </div></div>
        <p class="archive-card-title">${item.id} &middot; ${escapeHtml(item.title)}</p>
        <div class="archive-card-info"><span>${escapeHtml(item.department)}</span>${support}</div>
        <div class="archive-card-bottom">
          <div class="archive-card-btns">
            <button class="arc-mini ${isFav ? "is-fav" : ""}" data-arc="fav" data-item-id="${item.id}" title="Favorite">${isFav ? "&#x2605;" : "&#x2606;"}</button>
            <button class="arc-mini" data-arc="detail" data-item-id="${item.id}" title="Detail">&#x1F50D;</button>
            ${editBtn}
            <button class="arc-mini" data-arc="assistant" data-item-id="${item.id}" title="Ask AI">&#x1F4AC;</button>
          </div>
          <p class="archive-card-desc">${escapeHtml(desc)}</p>
        </div>
      </div>`;
    }).join("");
  }

  renderFavorites();
}

function getArchiveFilteredItems({ useQuery = true } = {}) {
  const query = (document.querySelector("#archive-query")?.value || "").trim().toLowerCase();
  const selectedType = document.querySelector("#archive-type")?.value || "all";
  const selectedStatus = document.querySelector("#archive-status")?.value || "all";
  const selectedDept = document.querySelector("#archive-dept-filter")?.value || "all";

  let filtered = [...items];
  if (selectedType !== "all") filtered = filtered.filter((item) => item.type === selectedType);
  if (selectedStatus !== "all") filtered = filtered.filter((item) => item.status === selectedStatus);
  if (selectedDept !== "all") filtered = filtered.filter((item) => item.department === selectedDept);

  if (useQuery && query) {
    filtered = filtered.filter((item) =>
      [item.id, item.title, item.description, item.assignedToDept || ""].join(" ").toLowerCase().includes(query)
    );
  }

  return filtered;
}

// ═══ Favorites System ═══════════════════════════════════════════════════

function _getFavorites() {
  if (!window._favCache) {
    try { window._favCache = JSON.parse(localStorage.getItem("red-sync-v2-favorites") || "[]"); } catch { window._favCache = []; }
  }
  return window._favCache;
}

function _saveFavorites() {
  localStorage.setItem("red-sync-v2-favorites", JSON.stringify(window._favCache || []));
}

function toggleFavorite(itemId) {
  const favs = _getFavorites();
  const idx = favs.indexOf(itemId);
  if (idx >= 0) { favs.splice(idx, 1); showToast("Removed from favorites"); }
  else { favs.push(itemId); showToast("Added to favorites"); }
  _saveFavorites();
  renderArchive();
  renderDashFavorites();
}

function renderFavorites() {
  const section = document.querySelector("#fav-section");
  const list = document.querySelector("#fav-list");
  if (!section || !list) return;
  const favs = _getFavorites();
  const favItems = favs.map(id => items.find(i => i.id === id)).filter(Boolean);
  if (!favItems.length) { section.style.display = "none"; return; }
  section.style.display = "block";
  list.innerHTML = favItems.map(item => `
    <div class="fav-item" data-item-id="${item.id}">
      <span class="fav-item-star">&#x2605;</span>
      <span class="fav-item-id">${item.id}</span>
      <span class="fav-item-title">${escapeHtml(item.title)}</span>
      <button class="fav-item-remove" data-fav-remove="${item.id}" title="Remove">&times;</button>
    </div>`).join("");
}

function renderDashFavorites() {
  const el = document.querySelector("#my-favs-items");
  if (!el) return;
  const favs = _getFavorites();
  const favItems = favs.map(id => items.find(i => i.id === id)).filter(Boolean);
  _setBadge("badge-my-favs", favItems.length);
  if (!favItems.length) { el.innerHTML = '<p class="dash-empty">No favorites yet. Star cases from the Archive.</p>'; return; }
  el.innerHTML = favItems.map(favoriteFocusItemHTML).join("");
}

function deleteArchiveItem(itemId) {
  if (!requireSupervisorAccess("Delete")) return;
  const item = items.find((entry) => entry.id === itemId);
  if (!item) return;

  const approved = window.confirm(`Delete ${item.id} from the archive? This cannot be undone.`);
  if (!approved) return;

  items = items.filter((entry) => entry.id !== itemId);
  closeDetailDrawer();
  meetingLog.unshift(`${item.id}: Deleted from archive.`);
  refreshAll();
  showToast(`${item.id} deleted`);
}
function renderRecap() {
  const recap = document.querySelector("#recap-draft");
  const lines = [];
  lines.push("RED in-SYNCC Monday Recap");
  lines.push("Date: " + new Date().toLocaleDateString("en-GB"));
  lines.push("Meeting: Monday " + activeMeetingWeek);
  lines.push("");
  if (!meetingLog.length) {
    lines.push("No decisions captured yet in this session.");
    recap.value = lines.join("\n");
    return;
  }
  meetingLog.forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry}`);
  });
  recap.value = lines.join("\n");
}

function parseRecipients(rawValue) {
  return String(rawValue || "")
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeMeetingLink(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

function getMeetingLink() {
  const stored = localStorage.getItem(MEETING_LINK_STORAGE_KEY);
  return normalizeMeetingLink(stored || DEFAULT_MEETING_LINK);
}

function handleOpenMeetingLink() {
  let link = getMeetingLink();

  if (!link) {
    const entered = window.prompt("Paste the RED meeting URL (Teams/Zoom):", "https://");
    if (entered === null) return;

    link = normalizeMeetingLink(entered);
    if (!link || link === "https://") {
      showToast("Please add a valid meeting URL.");
      return;
    }

    localStorage.setItem(MEETING_LINK_STORAGE_KEY, link);
  }

  const popup = window.open(link, "_blank", "noopener,noreferrer");
  if (!popup) window.location.href = link;
  showToast("Meeting link opened");
}

function handleSendRecapEmail() {
  const toInput = document.querySelector("#recap-email-to");
  const recap = document.querySelector("#recap-draft");
  if (!toInput || !recap) return;

  let recipients = parseRecipients(toInput.value);
  const { attendees, summaryOnly } = buildRecipientsForWeek(activeMeetingWeek);
  if (!recipients.length) recipients = attendees;
  if (!recipients.length) {
    showToast("No recipients found. Add recipients or ensure there are agenda items.");
    return;
  }

  if (!meetingLog.length) {
    showToast("No meeting actions captured yet.");
    return;
  }

  const recapText = recap.value.trim();
  if (!recapText) {
    showToast("Recap is empty. Capture meeting actions first.");
    return;
  }


  const mailto = buildEmailFromRecipients(recipients, summaryOnly, recapText);
  window.location.href = mailto;
  showToast("Email draft opened in your mail app.");
}
// ═══ Benchmark: SLA Timer (Jira SM) ═════════════════════════════════════
function buildSLATimerHTML(item) {
  if (!item.dueDate || !isOpenStatus(item.status)) return "";
  const now = new Date(), due = new Date(item.dueDate + "T23:59:59");
  const diffMs = due - now, diffDays = Math.ceil(diffMs / 864e5);
  let cls, label;
  if (diffMs < 0) { cls = "sla-breached"; label = `BREACHED ${Math.abs(diffDays)}d ago`; }
  else if (diffDays <= 2) { cls = "sla-warning"; label = diffDays === 0 ? "Due TODAY" : `${diffDays}d remaining`; }
  else { cls = "sla-ok"; label = `${diffDays}d remaining`; }
  const iconClass = diffMs < 0 ? "is-breached" : diffDays <= 2 ? "is-warning" : "is-ok";
  const pct = Math.max(0, Math.min(100, diffMs < 0 ? 100 : (1 - diffDays / 21) * 100));
  return `<div class="sla-timer ${cls}"><div class="sla-icon ${iconClass}" aria-hidden="true"></div><div class="sla-info"><strong>${label}</strong><span>Due: ${item.dueDate}</span></div><div class="sla-bar-wrap"><div class="sla-bar" style="width:${pct}%"></div></div></div>`;
}

// ═══ Benchmark: Activity Timeline (ServiceNow) ══════════════════════════
function buildActivityTimeline(item) {
  const ev = [];
  ev.push({date:item.createdAt, icon:"&#x1F4DD;", text:`Created by ${item.createdBy}`, type:"create"});
  if (item.assignedTo && item.status !== "new") ev.push({date:item.createdAt, icon:"&#x1F464;", text:`Assigned to ${item.assignedTo}`, type:"assign"});
  if (item.assignedToDept) ev.push({date:item.createdAt, icon:"&#x1F3E2;", text:`Dept assignment: ${item.assignedToDept}`, type:"dept"});
  (item.updates||[]).forEach(u => {
    const dm = u.note.match(/(\d{4}-\d{2}-\d{2})/);
    const d = dm ? dm[1] : item.createdAt;
    const im = {feedback:"&#x1F4AC;",status_change:"&#x1F504;",meeting_note:"&#x1F4CB;",solution_note:"&#x2705;"};
    ev.push({date:d, icon:im[u.type]||"&#x1F4CC;", text:u.note, type:u.type});
  });
  if (item.details?.escalationReason) ev.push({date:item.details?.escalationMeetingDate||item.createdAt, icon:"&#x26A1;", text:`Escalated: ${item.details.escalationReason}`, type:"escalate"});
  if (item.resolvedAt) ev.push({date:item.resolvedAt, icon:"&#x2705;", text:`Resolved by ${item.resolvedBy||"unknown"}`, type:"resolve"});
  ev.sort((a,b) => a.date.localeCompare(b.date));
  if (!ev.length) return '<p style="color:var(--ink-soft)">No activity.</p>';
  return `<div class="activity-timeline">${ev.map(e => `<div class="tl-item tl-${e.type}"><div class="tl-dot">${e.icon}</div><div class="tl-content"><span class="tl-date">${e.date}</span><p class="tl-text">${escapeHtml(e.text)}</p></div></div>`).join("")}</div>`;
}

// ═══ Benchmark: Resolution Time Analytics (ServiceNow PA) ═══════════════
function buildResolutionTimeAnalytics() {
  const res = items.filter(i => i.type==="challenge" && i.resolvedAt && i.createdAt);
  if (!res.length) return {avgDays:0,slaMetPct:0,fastest:0,slowest:0,total:0};
  const times = res.map(i => Math.max(0, Math.ceil((new Date(i.resolvedAt) - new Date(i.createdAt)) / 864e5)));
  const avg = Math.round(times.reduce((s,t) => s+t, 0) / times.length);
  const met = res.filter(i => !i.dueDate || new Date(i.resolvedAt) <= new Date(i.dueDate+"T23:59:59")).length;
  return {avgDays:avg, slaMetPct:Math.round((met/res.length)*100), fastest:Math.min(...times), slowest:Math.max(...times), total:res.length};
}

// ═══ V3: Drawer SLA Header Pill ══════════════════════════════════════════
function buildDrawerSLAPillHTML(item) {
  if (!item.dueDate || !isOpenStatus(item.status)) return "";
  const now = new Date(), due = new Date(item.dueDate + "T23:59:59");
  const diffMs = due - now, diffDays = Math.ceil(diffMs / 864e5);
  let cls, label;
  if (diffMs < 0) { cls = "sla-breached"; label = `BREACHED ${Math.abs(diffDays)}d ago`; }
  else if (diffDays <= 2) { cls = "sla-warning"; label = diffDays === 0 ? "Due TODAY" : `${diffDays}d remaining`; }
  else { cls = "sla-ok"; label = `${diffDays}d remaining`; }
  return `<div class="drawer-sla-pill ${cls}"><span class="drawer-sla-dot" aria-hidden="true"></span><span class="drawer-sla-label">${label}</span><span class="drawer-sla-due">Due ${item.dueDate}</span></div>`;
}

// ═══ V3 Benchmark: Activity Timeline (ServiceNow) ═══════════════════════
function buildActivityTimeline(item) {
  const ev = [];
  ev.push({ date: item.createdAt, icon: "&#x1F4DD;", text: `Created by ${item.createdBy}`, type: "create" });
  if (item.assignedTo && item.status !== "new") ev.push({ date: item.createdAt, icon: "&#x1F464;", text: `Assigned to ${item.assignedTo}`, type: "assign" });
  if (item.assignedToDept) ev.push({ date: item.createdAt, icon: "&#x1F3E2;", text: `Dept assignment: ${item.assignedToDept}`, type: "dept" });
  (item.updates || []).forEach((u) => {
    const dm = u.note.match(/(\d{4}-\d{2}-\d{2})/);
    const d = dm ? dm[1] : item.createdAt;
    const im = { feedback: "&#x1F4AC;", status_change: "&#x1F504;", meeting_note: "&#x1F4CB;", solution_note: "&#x2705;" };
    ev.push({ date: d, icon: im[u.type] || "&#x1F4CC;", text: u.note, type: u.type });
  });
  if (item.details?.escalationReason) ev.push({ date: item.details?.escalationMeetingDate || item.createdAt, icon: "&#x26A1;", text: `Escalated: ${item.details.escalationReason}`, type: "escalate" });
  if (item.resolvedAt) ev.push({ date: item.resolvedAt, icon: "&#x2705;", text: `Resolved by ${item.resolvedBy || "unknown"}`, type: "resolve" });
  ev.sort((a, b) => a.date.localeCompare(b.date));
  if (!ev.length) return '<p style="color:var(--ink-soft)">No activity.</p>';
  return `<div class="activity-timeline">${ev.map((e) => `<div class="tl-item tl-${e.type}"><div class="tl-dot">${e.icon}</div><div class="tl-content"><span class="tl-date">${e.date}</span><p class="tl-text">${escapeHtml(e.text)}</p></div></div>`).join("")}</div>`;
}

// ═══ V3 Benchmark: Resolution Time Analytics (ServiceNow PA) ════════════
function buildResolutionTimeAnalytics() {
  const res = items.filter((i) => i.type === "challenge" && i.resolvedAt && i.createdAt);
  if (!res.length) return { avgDays: 0, slaMetPct: 0, fastest: 0, slowest: 0, total: 0 };
  const times = res.map((i) => Math.max(0, Math.ceil((new Date(i.resolvedAt) - new Date(i.createdAt)) / 864e5)));
  const avg = Math.round(times.reduce((s, t) => s + t, 0) / times.length);
  const met = res.filter((i) => !i.dueDate || new Date(i.resolvedAt) <= new Date(i.dueDate + "T23:59:59")).length;
  return { avgDays: avg, slaMetPct: Math.round((met / res.length) * 100), fastest: Math.min(...times), slowest: Math.max(...times), total: res.length };
}

function getAdminEditDepartmentOptions() {
  const fromCreateForm = Array.from(document.querySelectorAll("#create-department option"))
    .map((option) => ({ value: option.value, label: option.textContent?.trim() || option.value }));
  const fromItems = uniqueList(items.map((item) => item.department))
    .map((value) => ({ value, label: value }));
  const map = new Map();
  [...fromCreateForm, ...fromItems].forEach((entry) => {
    if (!entry.value) return;
    if (!map.has(entry.value)) map.set(entry.value, entry.label || entry.value);
  });
  return Array.from(map.entries()).map(([value, label]) => ({ value, label }));
}

function getAdminEditSupportDepartmentOptions() {
  const fromCreateForm = Array.from(document.querySelectorAll("#assign-to-dept option"))
    .map((option) => ({ value: option.value, label: option.textContent?.trim() || option.value }));
  const fromItems = uniqueList(items.map((item) => item.assignedToDept || ""))
    .map((value) => ({ value, label: value || "-- No assignment yet --" }));
  const map = new Map();
  map.set("", "-- No assignment yet --");
  [...fromCreateForm, ...fromItems].forEach((entry) => {
    if (!map.has(entry.value)) map.set(entry.value, entry.label || entry.value);
  });
  return Array.from(map.entries()).map(([value, label]) => ({ value, label }));
}

function getAdminEditMeetingOptions() {
  return Object.entries(MEETING_LAYERS).map(([value, label]) => ({
    value,
    label: label.replace(/\s+Meeting(?:\s*\([^)]+\))?/i, "").trim(),
  }));
}

function populateAdminEditSelect(selectEl, options, selectedValue) {
  if (!selectEl) return;
  selectEl.innerHTML = "";
  options.forEach((entry) => {
    const option = document.createElement("option");
    option.value = entry.value;
    option.textContent = entry.label;
    selectEl.appendChild(option);
  });
  const selected = String(selectedValue || "");
  if (selected && !options.some((entry) => entry.value === selected)) {
    const fallback = document.createElement("option");
    fallback.value = selected;
    fallback.textContent = selected;
    selectEl.appendChild(fallback);
  }
  selectEl.value = selected;
}

function setAdminEditTypeState(modal, itemType) {
  if (!modal) return;
  modal.querySelectorAll("[data-edit-type-panel]").forEach((panel) => {
    panel.classList.toggle("is-hidden", panel.dataset.editTypePanel !== itemType);
  });
  const heading = modal.querySelector("#admin-edit-type-heading");
  if (heading) heading.textContent = `${toLabel(itemType)} Details`;
}

function closeAdminEditModal() {
  const modal = document.querySelector("#item-edit-modal");
  if (!modal) return;
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
}

function ensureAdminEditModal() {
  let modal = document.querySelector("#item-edit-modal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.className = "modal admin-edit-modal";
  modal.id = "item-edit-modal";
  modal.setAttribute("aria-hidden", "true");
  modal.innerHTML = `
    <div class="modal-card admin-edit-card">
      <div class="admin-edit-header">
        <div class="admin-edit-header-copy">
          <span class="admin-settings-badge">Admin Settings</span>
          <h3 id="admin-edit-title">Edit Item</h3>
        </div>
        <button type="button" class="admin-edit-close" id="admin-edit-close" aria-label="Close">✕</button>
      </div>
      <div class="admin-edit-divider"></div>
      <form id="admin-edit-form" class="admin-edit-form">
        <div class="admin-edit-grid">
          <section class="admin-edit-col">
            <h4 class="admin-edit-section-title">Core Details</h4>
            <label>Type
              <select name="itemType" id="admin-edit-type">
                <option value="challenge">Challenge</option>
                <option value="contribution">Contribution</option>
                <option value="celebration">Celebration</option>
              </select>
            </label>
            <label>Title
              <input name="title" id="admin-edit-title-input" type="text" required />
            </label>
            <label>Description
              <textarea name="description" id="admin-edit-description" rows="4" required></textarea>
            </label>
            <label>Status
              <select name="status" id="admin-edit-status">
                <option value="new">New</option>
                <option value="assigned">Assigned</option>
                <option value="in_discussion">In Discussion</option>
                <option value="escalated">Escalated</option>
                <option value="resolved">Resolved</option>
                <option value="closed">Closed</option>
              </select>
            </label>
            <label>Priority
              <select name="priority" id="admin-edit-priority">
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
            <label>Due Date
              <input name="dueDate" id="admin-edit-due-date" type="date" />
            </label>
            <label>Meeting Level
              <select name="meetingLevel" id="admin-edit-meeting-level"></select>
            </label>
          </section>
          <section class="admin-edit-col">
            <h4 class="admin-edit-section-title">People &amp; Assignment</h4>
            <label>Created By
              <input name="createdBy" id="admin-edit-created-by" type="text" />
            </label>
            <label>Owner / Assigned To
              <input name="assignedTo" id="admin-edit-assigned-to" type="text" />
            </label>
            <label>Stakeholders
              <input name="stakeholders" id="admin-edit-stakeholders" type="text" />
            </label>
            <label>Department
              <select name="department" id="admin-edit-department"></select>
            </label>
            <label>Assign to Support Dept
              <select name="assignedToDept" id="admin-edit-assigned-dept"></select>
            </label>
            <label>External Email
              <input name="externalEmail" id="admin-edit-external-email" type="email" placeholder="Optional external contact" />
            </label>
            <h4 class="admin-edit-section-title">Solution</h4>
            <label>Solution / Resolution Notes
              <textarea name="solution" id="admin-edit-solution" rows="4" placeholder="Documented solution or outcome"></textarea>
            </label>
          </section>
        </div>

        <section class="admin-edit-type-panel">
          <h4 class="admin-edit-section-title" id="admin-edit-type-heading">Challenge Details</h4>

          <div data-edit-type-panel="challenge" class="admin-edit-type-grid">
            <label>Recurring?
              <select name="isRecurring" id="admin-edit-recurring">
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </label>
            <label>Escalation Level
              <select name="escalationLevel" id="admin-edit-escalation-level">
                <option value="none">None</option>
                <option value="team_lead">Team Lead</option>
                <option value="senior_leadership">Senior Leadership</option>
              </select>
            </label>
            <label class="admin-edit-full">Related Item Code
              <input name="relatedItemCode" id="admin-edit-related-item" type="text" placeholder="Optional" />
            </label>
          </div>

          <div data-edit-type-panel="contribution" class="admin-edit-type-grid is-hidden">
            <label>Topic Tag
              <input name="topicTag" id="admin-edit-topic-tag" type="text" />
            </label>
            <label>Target Audience
              <input name="targetAudience" id="admin-edit-target-audience" type="text" />
            </label>
          </div>

          <div data-edit-type-panel="celebration" class="admin-edit-type-grid is-hidden">
            <label>Milestone Type
              <input name="milestoneType" id="admin-edit-milestone-type" type="text" />
            </label>
            <label>Audience Note
              <input name="audienceNote" id="admin-edit-audience-note" type="text" />
            </label>
          </div>
        </section>

        <div class="admin-edit-footer">
          <button type="button" class="mini-btn" id="admin-edit-cancel">Cancel</button>
          <button type="submit" class="admin-btn-primary">Save Changes</button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(modal);

  const closeBtn = modal.querySelector("#admin-edit-close");
  if (closeBtn) closeBtn.addEventListener("click", closeAdminEditModal);
  const cancelBtn = modal.querySelector("#admin-edit-cancel");
  if (cancelBtn) cancelBtn.addEventListener("click", closeAdminEditModal);

  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeAdminEditModal();
  });

  const typeSelect = modal.querySelector("#admin-edit-type");
  if (typeSelect) {
    typeSelect.addEventListener("change", () => {
      setAdminEditTypeState(modal, typeSelect.value);
    });
  }

  const form = modal.querySelector("#admin-edit-form");
  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const itemId = form.dataset.itemId;
      const item = items.find((entry) => entry.id === itemId);
      if (!item) return;

      const data = new FormData(form);
      const nextType = String(data.get("itemType") || item.type);
      const nextTitle = String(data.get("title") || "").trim();
      const nextDescription = String(data.get("description") || "").trim();
      const nextStatus = String(data.get("status") || item.status);
      const nextPriority = String(data.get("priority") || item.priority);
      const nextDueDate = String(data.get("dueDate") || "").trim();
      const nextMeetingLevel = String(data.get("meetingLevel") || item.meetingLevel || "team_weekly");
      const nextCreatedBy = String(data.get("createdBy") || "").trim();
      const nextAssignedTo = String(data.get("assignedTo") || "").trim();
      const nextStakeholders = uniqueList(String(data.get("stakeholders") || "").split(","));
      const nextDepartment = String(data.get("department") || "").trim();
      const nextAssignedDept = String(data.get("assignedToDept") || "").trim();
      const nextExternalEmail = String(data.get("externalEmail") || "").trim();
      const nextSolution = String(data.get("solution") || "").trim();

      if (!nextTitle || !nextDescription || !nextDepartment) {
        showToast("Please complete title, description, and department.");
        return;
      }
      if (!["challenge", "contribution", "celebration"].includes(nextType)) {
        showToast("Type is not valid.");
        return;
      }
      if (!["new", "assigned", "in_discussion", "escalated", "resolved", "closed"].includes(nextStatus)) {
        showToast("Status is not valid.");
        return;
      }
      if (!["high", "medium", "low"].includes(nextPriority)) {
        showToast("Priority is not valid.");
        return;
      }
      if (nextDueDate && !/^\d{4}-\d{2}-\d{2}$/.test(nextDueDate)) {
        showToast("Due date must use YYYY-MM-DD.");
        return;
      }
      if (nextExternalEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextExternalEmail)) {
        showToast("External email format is not valid.");
        return;
      }

      const details = { ...(item.details || {}) };
      if (nextType === "challenge") {
        details.isRecurring = String(data.get("isRecurring") || "no") === "yes";
        details.escalationLevel = String(data.get("escalationLevel") || "none");
        details.relatedItemCode = String(data.get("relatedItemCode") || "").trim();
        delete details.topicTag;
        delete details.targetAudience;
        delete details.milestoneType;
        delete details.audienceNote;
      } else if (nextType === "contribution") {
        details.topicTag = String(data.get("topicTag") || "").trim();
        details.targetAudience = String(data.get("targetAudience") || "").trim();
        delete details.isRecurring;
        delete details.escalationLevel;
        delete details.relatedItemCode;
        delete details.milestoneType;
        delete details.audienceNote;
      } else {
        details.milestoneType = String(data.get("milestoneType") || "").trim();
        details.audienceNote = String(data.get("audienceNote") || "").trim();
        delete details.isRecurring;
        delete details.escalationLevel;
        delete details.relatedItemCode;
        delete details.topicTag;
        delete details.targetAudience;
      }

      const wasResolved = item.status === "resolved" || item.status === "closed";
      const isResolved = nextStatus === "resolved" || nextStatus === "closed";

      item.type = nextType;
      item.title = nextTitle;
      item.description = nextDescription;
      item.status = nextStatus;
      item.priority = nextPriority;
      item.dueDate = nextDueDate;
      item.meetingLevel = nextMeetingLevel;
      item.createdBy = nextCreatedBy || item.createdBy || _currentUser();
      item.assignedTo = nextAssignedTo;
      item.stakeholders = nextStakeholders;
      item.department = nextDepartment;
      item.assignedToDept = nextAssignedDept;
      item.externalEmail = nextExternalEmail;
      item.solution = nextSolution;
      item.details = details;
      if (nextType !== "challenge") item.meetingNeeded = false;

      if (isResolved && !item.resolvedAt) item.resolvedAt = todayISO();
      if (isResolved && !item.resolvedBy) item.resolvedBy = nextAssignedTo || _currentUser();
      if (!isResolved && wasResolved) {
        item.resolvedAt = "";
        item.resolvedBy = "";
      }

      item.updates = item.updates || [];
      item.updates.push({ type: "meeting_note", note: `Item edited by ${_currentUser()} via Admin Settings.` });
      meetingLog.unshift(`${item.id}: Edited by ${_currentUser()}.`);

      const drawerOpen = document.querySelector("#detail-drawer")?.classList.contains("is-open");
      saveItems();
      closeAdminEditModal();
      refreshAll();
      if (drawerOpen) openDetailDrawer(item.id);
      showToast(`${item.id} updated`);
    });
  }

  return modal;
}

function openEditItemPrompt(itemId) {
  if (!requireSupervisorAccess("Item editing")) return;
  const item = items.find((entry) => entry.id === itemId);
  if (!item) return;

  const modal = ensureAdminEditModal();
  const form = modal.querySelector("#admin-edit-form");
  if (!form) return;
  form.dataset.itemId = item.id;

  const deptSelect = modal.querySelector("#admin-edit-department");
  const supportSelect = modal.querySelector("#admin-edit-assigned-dept");
  const meetingSelect = modal.querySelector("#admin-edit-meeting-level");

  populateAdminEditSelect(deptSelect, getAdminEditDepartmentOptions(), item.department);
  populateAdminEditSelect(supportSelect, getAdminEditSupportDepartmentOptions(), item.assignedToDept || "");
  populateAdminEditSelect(meetingSelect, getAdminEditMeetingOptions(), item.meetingLevel || "team_weekly");

  const details = item.details || {};
  modal.querySelector("#admin-edit-title").textContent = `Edit: ${item.id}`;
  modal.querySelector("#admin-edit-type").value = item.type;
  modal.querySelector("#admin-edit-title-input").value = item.title || "";
  modal.querySelector("#admin-edit-description").value = item.description || "";
  modal.querySelector("#admin-edit-status").value = item.status || "new";
  modal.querySelector("#admin-edit-priority").value = item.priority || "medium";
  modal.querySelector("#admin-edit-due-date").value = item.dueDate || "";
  modal.querySelector("#admin-edit-created-by").value = item.createdBy || "";
  modal.querySelector("#admin-edit-assigned-to").value = item.assignedTo || "";
  modal.querySelector("#admin-edit-stakeholders").value = (item.stakeholders || []).join(", ");
  modal.querySelector("#admin-edit-external-email").value = item.externalEmail || "";
  modal.querySelector("#admin-edit-solution").value = item.solution || "";

  const recurringSelect = modal.querySelector("#admin-edit-recurring");
  if (recurringSelect) recurringSelect.value = details.isRecurring ? "yes" : "no";
  const escalationLevelSelect = modal.querySelector("#admin-edit-escalation-level");
  if (escalationLevelSelect) escalationLevelSelect.value = details.escalationLevel || "none";
  const relatedItemInput = modal.querySelector("#admin-edit-related-item");
  if (relatedItemInput) relatedItemInput.value = details.relatedItemCode || "";

  const topicTagInput = modal.querySelector("#admin-edit-topic-tag");
  if (topicTagInput) topicTagInput.value = details.topicTag || "";
  const targetAudienceInput = modal.querySelector("#admin-edit-target-audience");
  if (targetAudienceInput) targetAudienceInput.value = details.targetAudience || "";
  const milestoneTypeInput = modal.querySelector("#admin-edit-milestone-type");
  if (milestoneTypeInput) milestoneTypeInput.value = details.milestoneType || "";
  const audienceNoteInput = modal.querySelector("#admin-edit-audience-note");
  if (audienceNoteInput) audienceNoteInput.value = details.audienceNote || "";

  setAdminEditTypeState(modal, item.type);
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
}

function openDetailDrawer(itemId) {
  const item = items.find((entry) => entry.id === itemId);
  if (!item) return;
  const canManage = isSupervisorView();
  const isChallenge = item.type === "challenge";
  const canEditSolution = isChallenge && canCollaborateOnItem(item);
  const canComment = canCommentOnItem(item);

  const hasSolution = Boolean(item.solution && item.solution.trim().length > 0);
  const solutionText = hasSolution ? item.solution.trim() : "Not documented yet";
  const ownerValue = getOwnerName(item) || "Unassigned";
  const meetingNeededValue = item.meetingNeeded === false ? "No (handled via gate/follow-up)" : "Yes";
  const resolvedValue =
    item.status === "resolved" || item.status === "closed"
      ? `${item.resolvedBy || "Not recorded"}${item.resolvedAt ? ` (${item.resolvedAt})` : ""}`
      : "Not resolved yet";

  const recurringEscSuggestion = item.type === "challenge" ? getRecurringEscalationSuggestion(item) : null;
  const canShowEscalationSuggestions = canManage && isChallenge && item.status !== "escalated";
  const recurringEscMeta = recurringEscSuggestion && canShowEscalationSuggestions
    ? `<div class="recurring-esc-alert">
        <strong>Escalation Suggestion</strong>
        <p>${escapeHtml(recurringEscSuggestion.reason)}</p>
        <p><em>${escapeHtml(recurringEscSuggestion.ruleLabel)}</em></p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
          <button type="button" class="btn-primary" style="font-size:0.82rem;padding:7px 14px" data-action="quick-escalate" data-item-id="${item.id}">Escalate</button>
          <button type="button" class="mini-btn" data-action="ignore-recurring-esc" data-item-id="${item.id}">Ignore suggestion</button>
        </div>
       </div>`
    : "";

  const similarityExplorerHTML = isChallenge ? renderSimilarityExplorer(item) : "";

  // V2: Department assignment + email button
  const deptEmail = item.assignedToDept ? (DEPARTMENT_EMAILS[item.assignedToDept] || "") : "";
  const mailSubj = item.assignedToDept ? encodeURIComponent(`[${item.id}] ${item.title}`) : "";
  const mailBody = item.assignedToDept ? encodeURIComponent(
    `Hi ${item.assignedToDept} team,\n\nChallenge details:\n\nItem: ${item.id}\nTitle: ${item.title}\nDepartment: ${item.department}\nPriority: ${item.priority}\nStatus: ${toLabel(item.status)}\nDue: ${item.dueDate || "Not set"}\nCreated by: ${item.createdBy} (${item.createdAt})\n\nDescription:\n${item.description}\n\nStakeholders: ${item.stakeholders.join(", ") || "None"}${item.solution ? "\n\nSolution:\n" + item.solution : ""}\n\n---\nSent from RED in-SYNCC`
  ) : "";
  const deptAssignMeta = isChallenge && item.assignedToDept
    ? `<div class="detail-section">
        <h4>Support Department ${infoIcon("The back-office department assigned to help resolve this challenge. A group email is available to notify them directly.")}</h4>
        <div class="detail-kv-grid">
          <div class="detail-kv-row">
            <span class="detail-kv-label">Assigned to</span>
            <span class="detail-kv-value">${escapeHtml(item.assignedToDept)}</span>
          </div>
          ${deptEmail ? `<div class="detail-kv-row">
            <span class="detail-kv-label">Email</span>
            <span class="detail-kv-value">${escapeHtml(deptEmail)}</span>
          </div>` : ""}
        </div>
        ${deptEmail ? `<div class="dept-email-row"><a href="mailto:${deptEmail}?subject=${mailSubj}&body=${mailBody}" class="dept-email-btn">Send Email to ${item.assignedToDept}</a></div>` : ""}
      </div>`
    : "";

  const externalEmailMeta = item.externalEmail ? `${item.externalEmail} (email)` : "None";

  const hierarchyHTML = buildHierarchyHTML(item.meetingLevel || "team_weekly");
  const statusWorkflowHTML = buildStatusWorkflowHTML(item.status);

  // Drawer header: compact SLA pill left of close button
  const statusPillHost = document.querySelector("#detail-status-pill");
  if (statusPillHost) statusPillHost.innerHTML = buildDrawerSLAPillHTML(item);

  // V3 Benchmark: Quick Actions Bar
  const quickActionsHTML = isChallenge && isOpenStatus(item.status) ? `<div class="quick-actions-bar">
    ${item.status === "new" ? `<button class="qa-btn qa-assign" data-qa="assign" data-item-id="${item.id}">Assign</button>` : ""}
    ${item.status !== "escalated" ? `<button class="qa-btn qa-escalate" data-qa="escalate" data-item-id="${item.id}">Escalate</button>` : ""}
    <button class="qa-btn qa-resolve" data-qa="resolve" data-item-id="${item.id}">Resolve</button>
    <button class="qa-btn qa-defer" data-qa="defer" data-item-id="${item.id}">Defer</button>
  </div>` : "";

  const solutionEditorHTML = isChallenge
    ? canEditSolution
      ? `<section class="detail-section inline-sol">
      <h4>Solution ${infoIcon("Document the steps taken to resolve this challenge. A good solution enables future knowledge reuse and can skip new meetings.")}</h4>
      <textarea class="inline-sol-area" id="inline-sol-text" data-item-id="${item.id}" placeholder="Enter solution...">${escapeHtml(item.solution || "")}</textarea>
      <div class="inline-sol-actions">
        <button class="btn-primary" style="font-size:0.82rem;padding:7px 14px" data-action="save-inline-solution" data-item-id="${item.id}">Save Solution</button>
        ${isOpenStatus(item.status) ? `<button class="btn-primary rw-resolve-btn" style="font-size:0.82rem;padding:7px 14px" data-action="open-resolve-wizard" data-item-id="${item.id}">Resolve Challenge</button>` : ""}
      </div>
    </section>`
      : `<section class="detail-section inline-sol">
      <h4>Solution ${infoIcon("The documented resolution for this challenge. This solution is searchable and can be reused by future similar cases.")}</h4>
      <p class="${hasSolution ? "detail-solution-text" : "detail-solution-empty"}">${escapeHtml(solutionText)}</p>
      ${isOpenStatus(item.status) ? `<div class="inline-sol-actions"><button class="btn-primary rw-resolve-btn" style="font-size:0.82rem;padding:7px 14px;margin-top:8px" data-action="open-resolve-wizard" data-item-id="${item.id}">Resolve Challenge</button></div>` : ""}
    </section>`
    : "";
  const commentInputHTML = canComment
    ? `<div class="cmt-input-row">
        <input class="cmt-input" id="cmt-input-${item.id}" placeholder="Add a comment..." />
        <button class="btn-primary" style="font-size:0.82rem;padding:7px 14px" data-action="add-comment" data-item-id="${item.id}">Post</button>
      </div>`
    : "";
  const commentsSectionHTML = canComment
    ? `<section class="detail-section inline-comments">
        <h4>Comments ${infoIcon("Threaded comments from team members. Use to share context, ask questions or flag blockers without sending emails.")}</h4>
        <div class="cmt-list" id="cmt-list-${item.id}">
          ${(item.comments || []).map((c, index) => `<div class="cmt-item"><div class="cmt-head"><span class="cmt-author">${escapeHtml(c.author)}</span><span class="cmt-head-meta"><span class="cmt-date">${c.date}</span>${canManage ? `<button type="button" class="cmt-delete-btn" data-action="delete-comment" data-item-id="${item.id}" data-comment-index="${index}">Delete</button>` : ""}</span></div><p class="cmt-text">${escapeHtml(c.text)}</p></div>`).join("") || '<p class="dash-empty">No comments yet.</p>'}
        </div>
        ${commentInputHTML}
      </section>`
    : "";

  // V3 Benchmark: Activity Timeline
  const timelineHTML = isChallenge ? buildActivityTimeline(item) : "";

  // Known Error Tag
  const rootCauseTag = isChallenge && item.solutionTemplate?.rootCause ? `<span class="known-error-tag">Known Error: ${escapeHtml(item.solutionTemplate.rootCause)}</span>` : "";
  const solutionTemplateMeta = isChallenge && item.solutionTemplate
    ? `
      <section class="detail-section solution-template">
        <h4>Solution template</h4>
        ${item.solutionTemplate.rootCause ? `<p><strong>Root cause:</strong> ${item.solutionTemplate.rootCause}</p>` : ""}
        ${item.solutionTemplate.actionSteps ? `<p><strong>Action steps:</strong> ${item.solutionTemplate.actionSteps}</p>` : ""}
        ${item.solutionTemplate.prevention ? `<p><strong>Prevention:</strong> ${item.solutionTemplate.prevention}</p>` : ""}
        ${item.solutionTemplate.validatedBy ? `<p><strong>Validated by:</strong> ${item.solutionTemplate.validatedBy}</p>` : ""}
        ${item.solutionTemplate.reusableTags ? `<p><strong>Tags:</strong> ${item.solutionTemplate.reusableTags}</p>` : ""}
      </section>
    `
    : "";

  const LABEL_TIPS = {
    "Status": "Current stage in the resolution workflow.",
    "Department": "The team that raised or owns this item.",
    "Owner": "Person responsible for driving resolution.",
    "Due date": "Target date for resolving this challenge.",
    "Meeting level": "Which RED meeting tier this item is assigned to.",
    "Resolved": "Who resolved the item and when.",
    "Created by": "The person who logged this item.",
    "Meeting needed": "Whether a cross-functional meeting is required to resolve this.",
    "Stakeholders": "People with a direct interest in this item's outcome.",
    "External contact": "Person outside the team invited to contribute.",
    "Meeting gate": "Whether a similar past case was found that could allow skipping a meeting.",
    "Escalated meeting": "The meeting level this item was escalated to.",
    "Escalation date": "When the escalation was scheduled.",
    "Escalated to": "Person or department that received the escalation.",
    "Reason": "Stated reason for escalating this item.",
  };

  const buildMetaGrid = (rows) => `
    <div class="detail-kv-grid">
      ${rows
        .filter((row) => row.value !== undefined && row.value !== null && String(row.value).trim() !== "")
        .map(
          (row) => `
            <div class="detail-kv-row">
              <span class="detail-kv-label">${escapeHtml(row.label)}${LABEL_TIPS[row.label] ? " " + infoIcon(LABEL_TIPS[row.label]) : ""}</span>
              <span class="detail-kv-value">${escapeHtml(String(row.value))}</span>
            </div>
          `
        )
        .join("")}
    </div>
  `;

  const salesMetaHTML = buildMetaGrid([
    { label: "Status", value: toLabel(item.status) },
    { label: "Department", value: item.department },
    { label: "Owner", value: ownerValue },
    { label: "Due date", value: item.dueDate || "Not set" },
    { label: "Meeting level", value: meetingLayerLabel(item.meetingLevel || "team_weekly").replace(/ Meeting.*/, "") },
    { label: "Resolved", value: resolvedValue },
  ]);

  const supervisorMetaHTML = buildMetaGrid([
    { label: "Department", value: item.department },
    { label: "Created by", value: `${item.createdBy} (${item.createdAt})` },
    { label: "Status", value: toLabel(item.status) },
    { label: "Owner", value: ownerValue },
    { label: "Due date", value: item.dueDate || "Not set" },
    { label: "Meeting needed", value: meetingNeededValue },
    { label: "Stakeholders", value: item.stakeholders.join(", ") || "None listed" },
    { label: "External contact", value: externalEmailMeta },
    { label: "Meeting gate", value: item.details?.meetingGate?.matchedItemId
      ? `Matched ${item.details.meetingGate.matchedItemId} (${Math.round((item.details.meetingGate.similarity || 0) * 100)}%)`
      : "No gate match" },
  ]);
  const supervisorLiteMetaHTML = buildMetaGrid([
    { label: "Department", value: item.department },
    { label: "Created by", value: `${item.createdBy} (${item.createdAt})` },
    { label: "Status", value: toLabel(item.status) },
    { label: "Owner", value: ownerValue },
    { label: "Meeting level", value: item.meetingLevel ? meetingLayerLabel(item.meetingLevel).replace(/ Meeting.*/, "") : "Not set" },
  ]);

  const escalationDetailsGrid = buildMetaGrid([
        { label: "Escalated meeting", value: item.details?.escalationTargetMeeting ? meetingLayerLabel(item.details.escalationTargetMeeting) : "Not escalated" },
        { label: "Escalation date", value: item.details?.escalationMeetingDate || "-" },
        { label: "Escalated to", value: item.details?.escalatedTo || "-" },
        { label: "Reason", value: item.details?.escalationReason || "-" },
      ]);
  const detailIdLabel = item.type === "challenge" ? `Challenge ${item.id}` : item.id;

  const detail = document.querySelector("#detail-content");
  detail.innerHTML = `
    <div class="detail-primary-header">
      <h3 class="detail-title">${escapeHtml(item.title)}</h3>
      <p class="detail-id">${escapeHtml(detailIdLabel)}</p>
    </div>
    <div class="item-meta">
      <span class="chip chip-type-${item.type}">${toLabel(item.type)}</span>
      <span class="chip chip-status">${toLabel(item.status)}</span>
      <span class="chip chip-priority-${item.priority}">${toLabel(item.priority)}</span>
      ${item.assignedToDept ? `<span class="chip chip-assigned-dept">&rarr; ${item.assignedToDept}</span>` : ""}
      ${item.meetingLevel ? `<span class="chip chip-meeting-level">${meetingLayerLabel(item.meetingLevel).replace(/ Meeting.*/, "")}</span>` : ""}
      ${rootCauseTag}
    </div>
    <section class="detail-section detail-sales-focus">
      <h4>${item.type === "challenge" ? "Challenge" : "Case Summary"} ${infoIcon("The original description of this item as submitted by the reporter.")}</h4>
      <p class="detail-lead">${escapeHtml(item.description)}</p>
    </section>

    ${solutionEditorHTML}

    ${commentsSectionHTML}

    ${isChallenge
      ? `<section class="detail-section detail-quick-context">
          <h4>${canManage ? "Case Details" : "Quick Context"} ${infoIcon(canManage ? "Full case metadata including meeting gate status, stakeholders and external contacts." : "Key facts about this challenge.")}</h4>
          ${canManage ? supervisorMetaHTML : salesMetaHTML}
        </section>`
      : canManage
        ? `<section class="detail-section detail-quick-context">
            <h4>Case Details ${infoIcon("Key metadata for this item.")}</h4>
            ${supervisorLiteMetaHTML}
          </section>`
        : ""
    }

    ${deptAssignMeta}

    ${isChallenge ? `
      <section class="detail-section detail-quick-context supervisor-extra-section">
        <h4>Workflow &amp; Escalation ${infoIcon("Current status in the resolution workflow. Use actions to assign, escalate or resolve.", "left")}</h4>
        ${quickActionsHTML}
        ${statusWorkflowHTML}
        ${escalationDetailsGrid}
        ${recurringEscMeta}
      </section>

      ${solutionTemplateMeta}

      <section class="detail-section detail-quick-context supervisor-extra-section">
        <h4>Meeting Level Hierarchy ${infoIcon("Shows which meeting level this case is currently assigned to in the escalation chain.", "left")}</h4>
        ${hierarchyHTML}
      </section>

      <section class="detail-section detail-quick-context supervisor-extra-section">
        <h4>Activity Timeline ${infoIcon("Chronological log of all updates, assignments, escalations and resolutions for this case.", "left")}</h4>
        ${timelineHTML}
      </section>

      ${similarityExplorerHTML}
    ` : ``}

    ${canManage ? `
      <div class="drawer-admin-actions">
        <button type="button" class="mini-btn mini-btn-edit" data-action="edit-item" data-item-id="${item.id}">✎ Edit</button>
      </div>
      <div class="drawer-delete-zone">
        <button type="button" class="drawer-delete-btn" data-action="delete-item" data-item-id="${item.id}">Delete this item</button>
      </div>
    ` : ``}
  `;
  const drawer = document.querySelector("#detail-drawer");
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
  drawer.scrollTop = 0;
}

function closeDetailDrawer() {
  const drawer = document.querySelector("#detail-drawer");
  drawer.classList.remove("is-open");
  drawer.setAttribute("aria-hidden", "true");
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast._timer);
  showToast._timer = window.setTimeout(() => toast.classList.remove("is-visible"), 1700);
}

function syncLeftRailActive(screenId) {
  document.querySelectorAll(".left-rail-nav-btn[data-rail-screen]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.railScreen === screenId);
  });
}

function setLeftRailCollapsed(collapsed) {
  document.body.classList.toggle("left-rail-collapsed", collapsed);
  const rail = document.querySelector("#left-rail");
  if (rail) rail.setAttribute("aria-expanded", String(!collapsed));
  const toggle = document.querySelector("#left-rail-toggle");
  if (toggle) {
    toggle.textContent = collapsed ? "›" : "‹";
    toggle.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  }
  localStorage.setItem(LEFT_RAIL_COLLAPSE_KEY, collapsed ? "1" : "0");
}

function applyRolePermissions() {
  const allowed = new Set(getAllowedScreensForRole());
  const roleSelector = document.querySelector("#role-selector");
  if (roleSelector) {
    if (roleSelector.value !== activeRoleView) roleSelector.value = activeRoleView;
    roleSelector.disabled = false;
  }

  document.querySelectorAll(".tab[data-screen]").forEach((button) => {
    const screen = button.dataset.screen;
    const visible = allowed.has(screen);
    button.classList.toggle("is-role-hidden", !visible);
    button.disabled = !visible;
    button.tabIndex = visible ? 0 : -1;
  });

  document.querySelectorAll(".left-rail-nav-btn[data-rail-screen]").forEach((button) => {
    const screen = button.dataset.railScreen;
    const visible = allowed.has(screen);
    button.classList.toggle("is-role-hidden", !visible);
    button.disabled = !visible;
    button.tabIndex = visible ? 0 : -1;
  });

  const activeScreen = document.querySelector(".screen.is-visible")?.id?.replace("screen-", "");
  if (activeScreen && !allowed.has(activeScreen)) {
    switchTab("dashboard");
  }
}

function switchTab(screenId) {
  const allowed = new Set(getAllowedScreensForRole());
  const targetScreen = allowed.has(screenId) ? screenId : "dashboard";

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.screen === targetScreen);
  });
  document.querySelectorAll(".screen").forEach((screen) => {
    screen.classList.toggle("is-visible", screen.id === `screen-${targetScreen}`);
  });
  syncLeftRailActive(targetScreen);
}

function nextItemCode() {
  const max = items
    .map((item) => Number.parseInt(item.id.replace(/[^\d]/g, ""), 10))
    .filter((value) => !Number.isNaN(value))
    .reduce((acc, value) => Math.max(acc, value), 100);
  return `HJD${String(max + 1).padStart(5, "0")}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function mondayOfWeek(dateISO) {
  const date = new Date(dateISO);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function nextMondayISO(baseDateISO = todayISO()) {
  const date = new Date(baseDateISO);
  const day = date.getDay() || 7;
  const daysUntilNextMonday = day === 1 ? 7 : 8 - day;
  date.setDate(date.getDate() + daysUntilNextMonday);
  return date.toISOString().slice(0, 10);
}

function addDaysISO(dateISO, days) {
  const date = new Date(dateISO + "T12:00:00");
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function upcomingMeetingMondayISO(baseDateISO = todayISO()) {
  const date = new Date(baseDateISO);
  const day = date.getDay() || 7;
  return day === 1 ? mondayOfWeek(baseDateISO) : nextMondayISO(baseDateISO);
}

function switchMeetingWeek(view) {
  meetingWeekView = view === "next" ? "next" : "current";
  const currentMeetingWeek = upcomingMeetingMondayISO();
  activeMeetingWeek = meetingWeekView === "next" ? addDaysISO(currentMeetingWeek, 7) : currentMeetingWeek;
  refreshAll();
}

function normalizeOpenItemsForCurrentWeek() {
  let changed = false;

  items.forEach((item) => {
    if (!isOpenStatus(item.status)) return;
    if (!item.weekStart || item.weekStart < activeMeetingWeek) {
      item.weekStart = activeMeetingWeek;
      changed = true;
    }
  });

  if (changed) saveItems();
}

function handleCreateItem(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);

  const type = String(formData.get("itemType"));
  const description = String(formData.get("description") || "").trim();
  if (type === "challenge" && description.length < 120) {
    showToast("Challenge descriptions should be at least 120 characters.");
    return;
  }

  const stakeholderNames = String(formData.get("stakeholders") || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  const item = {
    id: nextItemCode(),
    type,
    title: String(formData.get("title")).trim(),
    description,
    department: String(formData.get("department")),
    assignedToDept: String(formData.get("assignToDept") || "").trim(),
    meetingLevel: String(formData.get("targetMeetingLevel") || "team_weekly"),
    externalEmail: String(formData.get("externalEmail") || "").trim(),
    createdBy: String(formData.get("createdBy")).trim(),
    createdAt: todayISO(),
    weekStart: activeMeetingWeek,
    status: "new",
    meetingNeeded: true,
    priority: String(formData.get("priority")),
    dueDate: String(formData.get("dueDate") || ""),
    resolvedBy: "",
    solution: "",
    solutionTemplate: null,
    assignedTo: "",
    stakeholders: stakeholderNames,
    likedBy: [],
    details: {},
    updates: [{ type: "feedback", note: "Item created via V2 interface." }],
  };

  if (type === "challenge") {
    item.details = {
      isRecurring: String(formData.get("isRecurring")) === "yes",
      escalationLevel: String(formData.get("escalationLevel")),
      relatedItemCode: String(formData.get("relatedItemCode") || "").trim(),
    };
  }

  if (type === "contribution") {
    item.details = {
      topicTag: String(formData.get("topicTag") || "").trim(),
      targetAudience: String(formData.get("targetAudience") || "").trim(),
    };
  }

  if (type === "celebration") {
    item.details = {
      milestoneType: String(formData.get("milestoneType") || "").trim(),
      audienceNote: String(formData.get("audienceNote") || "").trim(),
    };
  }

  // Add item to list
  items.unshift(item);

  // V2: Generate notification for department assignment (Tutor Feedback §3)
  if (item.assignedToDept) {
    const deptEmail = DEPARTMENT_EMAILS[item.assignedToDept] || "";
    addNotification({
      type: "assign",
      itemId: item.id,
      title: `New challenge assigned to ${item.assignedToDept}`,
      body: `"${item.title}" has been assigned to the ${item.assignedToDept} department.${deptEmail ? ` Notification sent to ${deptEmail}.` : ""}`,
      department: item.assignedToDept,
    });
  }

  // V2: Generate notification for external email involvement (Tutor Feedback §4 Notes)
  if (item.externalEmail) {
    addNotification({
      type: "info",
      itemId: item.id,
      title: `External person involved: ${item.externalEmail}`,
      body: `${item.externalEmail} has been notified about "${item.title}". They can respond via email.`,
      department: item.department,
    });
  }

  refreshAll();
  showToast(`Created ${item.id}`);
  form.reset();
  const createdByInput = form.querySelector('[name="createdBy"]');
  if (createdByInput) createdByInput.value = _currentUser();
  updateTypeFields();

  if (type === "challenge") {
    // Feature 1: Meeting Necessity Decision Engine — show recommendation panel
    const candidateText = `${item.title} ${item.description}`;
    const match = findMeetingGateMatch(candidateText);
    if (match && match.item && isSupervisorView()) {
      openMeetingRecommendationPanel(item, match);
      return; // Don't switch tab yet — panel will handle it
    }

    // Feature 7: Recurring challenge detection alert
    const recurring = detectRecurringChallenges(item);
    if (isSupervisorView() && recurring.length >= RECURRING_MIN_COUNT - 1) {
      openRecurringAlert(item, recurring);
      return;
    }
  }

  switchTab("dashboard");
}

// ── Feature 1: Meeting Recommendation Panel ───────────────────────────────────

function openMeetingRecommendationPanel(item, match) {
  if (!isSupervisorView()) return;
  const modal = document.querySelector("#meeting-rec-modal");
  if (!modal) return;

  const matchedItem = match.item;
  const similarCases = computeSimilarityForItem(item);
  const experts = findSuggestedExperts(item, similarCases.slice(0, 5));

  // Feature 2: Expert panel HTML
  const expertsHTML = experts.length
    ? `<div class="rec-experts">
        <h4 class="rec-section-label">Suggested Experts</h4>
        ${experts.map((e) => `
          <div class="rec-expert-row">
            <span class="rec-expert-name">${escapeHtml(e.name)}</span>
            <span class="rec-expert-count">${e.count} similar case${e.count > 1 ? "s" : ""}</span>
            <div class="rec-expert-actions">
              <button type="button" class="mini-btn" data-expert-action="assign" data-item-id="${item.id}" data-expert-name="${escapeHtml(e.name)}">Assign as owner</button>
              <button type="button" class="mini-btn" data-expert-action="stakeholder" data-item-id="${item.id}" data-expert-name="${escapeHtml(e.name)}">Add as stakeholder</button>
            </div>
          </div>`).join("")}
       </div>`
    : "";

  // Feature 3: Auto participants
  const participants = uniqueList([
    item.createdBy,
    matchedItem.resolvedBy || "",
    matchedItem.assignedTo || "",
    ...experts.map((e) => e.name),
    ...item.stakeholders,
  ]).filter(Boolean);

  const participantsHTML = `
    <div class="rec-participants">
      <h4 class="rec-section-label">Meeting Participants (auto-generated)</h4>
      <p class="rec-participants-list" id="rec-participants-edit" contenteditable="true">${participants.join(", ")}</p>
      <p class="rec-note">Everyone else receives recap email only. Click to edit.</p>
    </div>`;

  document.querySelector("#rec-item-id").value = item.id;
  document.querySelector("#rec-matched-id").value = matchedItem.id;
  document.querySelector("#rec-body").innerHTML = `
    <div class="rec-match-card">
      <div class="rec-match-header">
        <span class="rec-match-id">${escapeHtml(matchedItem.id)}</span>
        <span class="rec-match-pct">${Math.round(match.similarity * 100)}% similarity</span>
      </div>
      <p class="rec-match-title">${escapeHtml(matchedItem.title)}</p>
      ${matchedItem.solution ? `<div class="rec-solution-box"><strong>Documented solution:</strong><br>${escapeHtml(matchedItem.solution)}</div>` : ""}
    </div>
    ${expertsHTML}
    ${participantsHTML}
  `;

  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
}

function closeMeetingRecModal() {
  const modal = document.querySelector("#meeting-rec-modal");
  if (!modal) return;
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
}

function applyKnowledgeReuse(itemId, matchedId) {
  if (!requireSupervisorAccess("Knowledge reuse")) return;
  const item = items.find((e) => e.id === itemId);
  const matched = items.find((e) => e.id === matchedId);
  if (!item || !matched) return;

  const owner = window.prompt("Assign owner for this item:", item.stakeholders[0] || item.createdBy || "");
  if (owner === null) return;
  const ownerTrimmed = owner.trim();
  if (!ownerTrimmed) { showToast("Owner required to apply knowledge reuse."); return; }

  const dueDate = window.prompt("Set due date (YYYY-MM-DD):", item.dueDate || addDaysISO(todayISO(), 7));
  if (dueDate === null) return;

  item.meetingNeeded = false;
  item.status = "assigned";
  item.assignedTo = ownerTrimmed;
  item.dueDate = String(dueDate || item.dueDate);
  item.solution = matched.solution || "";
  if (matched.solutionTemplate) item.solutionTemplate = { ...matched.solutionTemplate };
  if (!item.stakeholders.includes(ownerTrimmed)) item.stakeholders.unshift(ownerTrimmed);
  item.details = {
    ...item.details,
    knowledgeReused: true,
    knowledgeReuseSource: matched.id,
    knowledgeReuseTimestamp: new Date().toISOString(),
    meetingGate: { matchedItemId: matched.id, similarity: 0, appliedAt: todayISO() },
  };
  item.updates.push({
    type: "meeting_note",
    note: `Knowledge reuse applied from ${matched.id}. Meeting skipped. Assigned to ${ownerTrimmed}.`,
  });

  // Increment reuse counter on source
  matched.reuseCount = (matched.reuseCount || 0) + 1;

  meetingsAvoidedCount += 1;
  knowledgeReuseCount += 1;
  localStorage.setItem("red-sync-v1-meetings-avoided", String(meetingsAvoidedCount));
  localStorage.setItem("red-sync-v1-knowledge-reuse", String(knowledgeReuseCount));

  meetingLog.unshift(
    `${item.id}: Meeting skipped via knowledge reuse from ${matched.id}. Assigned to ${ownerTrimmed}.`
  );

  closeMeetingRecModal();
  refreshAll();
  showToast(`${item.id}: solution reused from ${matched.id}, meeting skipped`);
  switchTab("dashboard");
}

// ── Feature 7: Recurring Alert Panel ─────────────────────────────────────────

function openRecurringAlert(item, recurringCases) {
  const modal = document.querySelector("#recurring-alert-modal");
  if (!modal) return;

  document.querySelector("#recurring-item-id").value = item.id;
  const listHTML = recurringCases.slice(0, 5).map((rc) =>
    `<div class="rec-match-card" style="margin-bottom:8px">
      <span class="rec-match-id">${escapeHtml(rc.id)}</span>
      <p class="rec-match-title">${escapeHtml(rc.title)}</p>
      <small style="color:var(--ink-soft)">${rc.createdAt}</small>
    </div>`
  ).join("");

  document.querySelector("#recurring-body").innerHTML = listHTML;
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
}

function closeRecurringModal() {
  const modal = document.querySelector("#recurring-alert-modal");
  if (!modal) return;
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  switchTab("dashboard");
}

function handleRecurringEscalate() {
  const itemId = document.querySelector("#recurring-item-id").value;
  const item = items.find((e) => e.id === itemId);
  if (!item) return;
  const suggestion = getRecurringEscalationSuggestion(item) || getEscalationSuggestion(item);
  closeRecurringModal();
  openEscalateModal(itemId, suggestion);
}

// ── Analytics Drill-Down Popup ────────────────────────────────────────────────

function openAnalyticsPopup(title, itemIdList) {
  let popup = document.querySelector("#analytics-popup");
  if (!popup) {
    popup = document.createElement("div");
    popup.id = "analytics-popup";
    popup.className = "an-popup";
    popup.innerHTML = `
      <div class="an-popup-inner" id="analytics-popup-inner">
        <div class="an-popup-header">
          <span class="an-popup-title" id="analytics-popup-title"></span>
          <button class="an-popup-close" id="analytics-popup-close" aria-label="Close">&#x2715;</button>
        </div>
        <div class="an-popup-body" id="analytics-popup-body"></div>
        <div class="an-popup-resize-handle" id="analytics-popup-resize"></div>
      </div>`;
    document.body.appendChild(popup);

    // Close button
    popup.querySelector("#analytics-popup-close").addEventListener("click", () => {
      popup.classList.remove("is-open");
    });
    // Click backdrop to close
    popup.addEventListener("click", (e) => {
      if (e.target === popup) popup.classList.remove("is-open");
    });

    // Drag to move
    const inner = popup.querySelector("#analytics-popup-inner");
    const header = popup.querySelector(".an-popup-header");
    let dragging = false, dx = 0, dy = 0;
    header.addEventListener("mousedown", (e) => {
      if (e.target.closest(".an-popup-close")) return;
      dragging = true;
      const rect = inner.getBoundingClientRect();
      dx = e.clientX - rect.left;
      dy = e.clientY - rect.top;
      inner.style.transition = "none";
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      inner.style.left = (e.clientX - dx) + "px";
      inner.style.top = (e.clientY - dy) + "px";
      inner.style.transform = "none";
    });
    document.addEventListener("mouseup", () => { dragging = false; });

    // Resize handle
    const resizeHandle = popup.querySelector("#analytics-popup-resize");
    let resizing = false, startX, startY, startW, startH;
    resizeHandle.addEventListener("mousedown", (e) => {
      resizing = true;
      startX = e.clientX; startY = e.clientY;
      startW = inner.offsetWidth; startH = inner.offsetHeight;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!resizing) return;
      const newW = Math.max(320, startW + (e.clientX - startX));
      const newH = Math.max(200, startH + (e.clientY - startY));
      inner.style.width = newW + "px";
      inner.style.height = newH + "px";
    });
    document.addEventListener("mouseup", () => { resizing = false; });
  }

  // Populate
  const popupTitle = popup.querySelector("#analytics-popup-title");
  const popupBody = popup.querySelector("#analytics-popup-body");
  const popupInner = popup.querySelector("#analytics-popup-inner");

  // Reset position when opening fresh
  popupInner.style.left = "";
  popupInner.style.top = "";
  popupInner.style.transform = "";
  popupInner.style.width = "";
  popupInner.style.height = "";

  popupTitle.textContent = title;

  const matchedItems = itemIdList
    .map((id) => items.find((i) => i.id === id))
    .filter(Boolean);

  if (!matchedItems.length) {
    popupBody.innerHTML = `<p class="an-popup-empty">No matching items found.</p>`;
  } else {
    const statusColors = {
      new: "#6366f1", assigned: "#f59e0b", in_discussion: "#3b82f6",
      escalated: "#ef4444", resolved: "#22c55e", closed: "#9ca3af",
    };
    popupBody.innerHTML = matchedItems.map((item) => {
      const sColor = statusColors[item.status] || "#9ca3af";
      const priorityIcon = item.priority === "high" ? "🔴" : item.priority === "medium" ? "🟡" : "🟢";
      const reuseTag = item.details?.knowledgeReused
        ? `<span class="an-popup-tag an-popup-tag-reuse">Reuse</span>` : "";
      const meetingTag = item.meetingNeeded === false
        ? `<span class="an-popup-tag an-popup-tag-skipped">No meeting</span>` : "";
      return `<div class="an-popup-item">
        <div class="an-popup-item-head">
          <span class="an-popup-item-id">${escapeHtml(item.id)}</span>
          <span class="an-popup-status-dot" style="background:${sColor}" title="${item.status}"></span>
          <span class="an-popup-item-status">${toLabel(item.status)}</span>
          <span style="margin-left:auto;display:flex;gap:4px;align-items:center">${reuseTag}${meetingTag}</span>
        </div>
        <p class="an-popup-item-title">${escapeHtml(item.title)}</p>
        <div class="an-popup-item-meta">
          <span>${priorityIcon} ${toLabel(item.priority || "medium")}</span>
          <span>📁 ${escapeHtml(item.department)}</span>
          ${item.assignedTo ? `<span>👤 ${escapeHtml(item.assignedTo)}</span>` : ""}
          ${item.resolvedAt ? `<span>✅ ${item.resolvedAt}</span>` : item.dueDate ? `<span>📅 Due ${item.dueDate}</span>` : ""}
        </div>
        ${item.solution ? `<p class="an-popup-item-solution">${escapeHtml(item.solution.slice(0, 120))}${item.solution.length > 120 ? "…" : ""}</p>` : ""}
        <div class="an-popup-item-actions">
          <button class="mini-btn an-popup-detail-btn" data-item-id="${escapeHtml(item.id)}">Details →</button>
          ${isSupervisorView() ? `<button class="mini-btn mini-btn-edit an-popup-edit-btn" data-item-id="${escapeHtml(item.id)}">✎ Edit</button>` : ""}
        </div>
      </div>`;
    }).join("");

    // Wire up Details buttons
    popupBody.querySelectorAll(".an-popup-detail-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        popup.classList.remove("is-open");
        openDetailDrawer(btn.dataset.itemId);
      });
    });
    popupBody.querySelectorAll(".an-popup-edit-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        popup.classList.remove("is-open");
        openEditItemPrompt(btn.dataset.itemId);
      });
    });
  }

  popup.classList.add("is-open");
}

// ── Feature 8 & 9 & 10: Analytics Dashboard Rendering ────────────────────────

let analyticsTimeFilter = "all"; // all | 7d | 30d | 90d | custom
let analyticsCustomStart = "";
let analyticsCustomEnd = "";
let systemOverviewTimeFilter = "all";
let systemOverviewCustomStart = "";
let systemOverviewCustomEnd = "";
let systemOverviewDeptFilter = "all";

function getAnalyticsFilteredItems() {
  if (analyticsTimeFilter === "all") return items;
  const now = new Date();
  let startDate;
  if (analyticsTimeFilter === "today") {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (analyticsTimeFilter === "7d") {
    startDate = new Date(now); startDate.setDate(startDate.getDate() - 7);
  } else if (analyticsTimeFilter === "30d") {
    startDate = new Date(now); startDate.setDate(startDate.getDate() - 30);
  } else if (analyticsTimeFilter === "90d") {
    startDate = new Date(now); startDate.setDate(startDate.getDate() - 90);
  } else if (analyticsTimeFilter === "custom" && analyticsCustomStart && analyticsCustomEnd) {
    startDate = new Date(analyticsCustomStart + "T00:00:00");
    const endDate = new Date(analyticsCustomEnd + "T23:59:59");
    return items.filter(i => {
      const d = new Date(i.createdAt);
      return d >= startDate && d <= endDate;
    });
  } else {
    return items;
  }
  return items.filter(i => new Date(i.createdAt) >= startDate);
}

function buildEfficiencyMetricsFiltered(filteredItems) {
  const challenges = filteredItems.filter((i) => i.type === "challenge");
  const total = challenges.length || 1;
  const skippedFromData = challenges.filter((i) => i.meetingNeeded === false);
  const skippedMeetings = skippedFromData.length + (analyticsTimeFilter === "all" ? meetingsAvoidedCount : 0);
  const manHoursSaved = skippedFromData.reduce((sum, i) => sum + calcItemManHours(i), 0)
    + (analyticsTimeFilter === "all" ? (meetingsAvoidedCount * calcItemManHours({ meetingLevel: "regional_red" })) : 0);
  const reuseItemsFromData = challenges.filter((i) => i.details?.knowledgeReused);
  const reuseItems = reuseItemsFromData.length + (analyticsTimeFilter === "all" ? knowledgeReuseCount : 0);
  const reuseRate = Math.round((reuseItems / total) * 100);
  const reuseItemIds = reuseItemsFromData.map(i => i.id);
  const resolved = challenges.filter((i) => i.resolvedAt && i.createdAt);
  const calcDays = (i) => Math.max(0, Math.ceil((new Date(i.resolvedAt) - new Date(i.createdAt)) / 864e5));
  const reuseResolved = resolved.filter((i) => i.details?.knowledgeReused);
  const freshResolved = resolved.filter((i) => !i.details?.knowledgeReused);
  const avgReuseRes = reuseResolved.length
    ? Math.round(reuseResolved.reduce((s, i) => s + calcDays(i), 0) / reuseResolved.length) : null;
  const avgFreshRes = freshResolved.length
    ? Math.round(freshResolved.reduce((s, i) => s + calcDays(i), 0) / freshResolved.length) : null;
  const accelerationDays = (avgReuseRes !== null && avgFreshRes !== null) ? avgFreshRes - avgReuseRes : null;
  const ftrrItems = resolved.filter((i) => i.meetingNeeded === false && (i.updates || []).length <= 2);
  const ftrrItemIds = ftrrItems.map(i => i.id);
  const ftrr = Math.round((ftrrItems.length / (resolved.length || 1)) * 100);
  const lowLevels = ["team_weekly", "regional_red"];
  const escalAvoid = resolved.filter((i) => lowLevels.includes(i.meetingLevel));
  const escalAvoidIds = escalAvoid.map(i => i.id);
  const ear = Math.round((escalAvoid.length / (resolved.length || 1)) * 100);
  const sourcedIds = new Set(challenges.filter((i) => i.details?.knowledgeReuseSource).map((i) => i.details.knowledgeReuseSource));
  const resolvedWithSolution = resolved.filter((i) => i.solution && i.solution.length > 10);
  const kciSourceItems = resolvedWithSolution.filter(i => sourcedIds.has(i.id));
  const kciItemIds = kciSourceItems.map(i => i.id);
  const kci = resolvedWithSolution.length ? Math.round((sourcedIds.size / resolvedWithSolution.length) * 100) : 0;
  const levelCounts = {};
  challenges.filter((i) => i.status === "new" || i.status === "assigned" || i.status === "in_discussion").forEach((i) => {
    const lvl = i.meetingLevel || "team_weekly";
    levelCounts[lvl] = (levelCounts[lvl] || 0) + 1;
  });
  const rcData = buildRootCauseAnalytics().slice(0, 3);
  const recurring = challenges.filter((i) => i.details?.isRecurring).length;
  return {
    skippedMeetings, manHoursSaved: Math.round(manHoursSaved * 10) / 10,
    reuseItems, reuseRate, reuseItemIds,
    avgReuseRes, avgFreshRes, accelerationDays,
    ftrr, ftrrItemIds,
    ear, escalAvoidIds,
    kci, kciItemIds,
    levelCounts, rcData, recurring,
    totalChallenges: total, resolvedCount: resolved.length, reuseSourceCount: sourcedIds.size,
  };
}

function renderAnalyticsDashboard() {
  const root = document.querySelector("#screen-analytics");
  if (!root) return;

  if (!root.querySelector("#analytics-performance-content") || !root.querySelector("#analytics-system-content")) {
    root.innerHTML = `
      <div class="dd-list analytics-dd-list" id="analytics-dropdowns">
        <div class="dd-card is-open">
          <button class="dd-toggle" type="button" data-an-dd="performance-overview">
            <div class="dd-text">
              <strong>Performance Overview</strong>
              <span>Core performance metrics and efficiency KPIs</span>
            </div>
            <span class="dd-chevron">&#x25BE;</span>
          </button>
          <div class="dd-body">
            <div id="analytics-performance-content"></div>
          </div>
        </div>
        <div class="dd-card">
          <button class="dd-toggle" type="button" data-an-dd="system-overview">
            <div class="dd-text">
              <strong>System Overview</strong>
              <span>Status pipeline, workload, and operational diagnostics</span>
            </div>
            <span class="dd-chevron">&#x25BE;</span>
          </button>
          <div class="dd-body">
            <div id="analytics-system-content"></div>
          </div>
        </div>
      </div>
    `;
  }

  const container = root.querySelector("#analytics-performance-content");
  const systemContainer = root.querySelector("#analytics-system-content");
  if (!container || !systemContainer) return;

  const filteredItems = getAnalyticsFilteredItems();
  const m = buildEfficiencyMetricsFiltered(filteredItems);
  const challenges = filteredItems.filter(i => i.type === "challenge");

  // Health Score
  const totalAll = filteredItems.length || 1;
  const resolvedAll = filteredItems.filter(i => i.status === "resolved" || i.status === "closed").length;
  const openAll = filteredItems.filter(i => isOpenStatus(i.status)).length;
  const overdueAll = filteredItems.filter(i => i.dueDate && isOpenStatus(i.status) && new Date(i.dueDate+"T23:59:59") < new Date()).length;
  const resolvedWithDue = filteredItems.filter(i => (i.status==="resolved"||i.status==="closed") && i.dueDate && i.resolvedAt);
  const slaMet = resolvedWithDue.filter(i => new Date(i.resolvedAt) <= new Date(i.dueDate+"T23:59:59")).length;
  const slaRate = resolvedWithDue.length ? Math.round((slaMet/resolvedWithDue.length)*100) : 0;
  const resolvedChallenges = challenges.filter(i => i.resolvedAt && i.createdAt);
  const avgResDays = resolvedChallenges.length ? Math.round(resolvedChallenges.reduce((s,i) => s+Math.max(0,Math.ceil((new Date(i.resolvedAt)-new Date(i.createdAt))/864e5)),0)/resolvedChallenges.length) : 0;
  const resRate = Math.round((resolvedAll/totalAll)*100);
  const overdueScore = Math.round(Math.min(100-(overdueAll/(openAll||1))*100,100));
  const krPct = challenges.length>0 ? (challenges.filter(i=>i.details?.knowledgeReused).length/challenges.length)*100 : 0;
  const reuseScore = Math.round(Math.min(krPct*2,100));
  const systemHealth = Math.round((resRate+overdueScore+slaRate+reuseScore)/4);
  const hClr = systemHealth>=70?"#22c55e":systemHealth>=40?"#f59e0b":"#ef4444";
  const hLbl = systemHealth>=70?"Healthy":systemHealth>=40?"Needs Attention":"Critical";
  const healthBreakdown = {overall:systemHealth, components:[
    {label:"Resolution Rate",value:resRate,max:100,detail:`${resolvedAll} of ${totalAll} items resolved`},
    {label:"Overdue Score",value:overdueScore,max:100,detail:`${overdueAll} overdue out of ${openAll} open items`},
    {label:"SLA Compliance",value:slaRate,max:100,detail:`${slaMet} of ${resolvedWithDue.length} items met SLA deadline`},
    {label:"Knowledge Reuse",value:reuseScore,max:100,detail:`${challenges.filter(i=>i.details?.knowledgeReused).length} of ${challenges.length} challenges reused knowledge (×2 weight)`},
  ]};

  const resolutionSection = (m.accelerationDays !== null)
    ? `<div class="an-res-row">
        <div class="an-res-cell an-res-good"><span class="an-res-val">${m.avgReuseRes}d</span><span class="an-res-lbl">Avg. resolution<br><strong>with reuse</strong></span></div>
        <div class="an-res-arrow">→</div>
        <div class="an-res-cell an-res-base"><span class="an-res-val">${m.avgFreshRes}d</span><span class="an-res-lbl">Avg. resolution<br><strong>without reuse</strong></span></div>
        <div class="an-res-delta"><span class="an-res-delta-val">${m.accelerationDays>0?"-"+m.accelerationDays:"~0"}d</span><span class="an-res-delta-lbl">faster via<br>knowledge reuse</span></div>
      </div>`
    : `<p class="an-empty">Not enough resolved items with timestamps yet.</p>`;

  const timeFilterLabels = {all:"All Time",today:"Today","7d":"Last 7 Days","30d":"Last 30 Days","90d":"Last 90 Days",custom:"Custom Range"};

  container.innerHTML = `
    <div class="an-time-filter-bar">
      <div class="an-time-filter-row">
        <span class="an-time-filter-label">Period</span>
        <div class="an-time-filter-btns">
          ${["all","today","7d","30d","90d","custom"].map(k =>
            `<button class="an-time-btn${analyticsTimeFilter===k?" is-active":""}" data-time-filter="${k}">${timeFilterLabels[k]}</button>`
          ).join("")}
        </div>
      </div>
      <div class="an-time-custom-row" style="display:${analyticsTimeFilter==="custom"?"flex":"none"}">
        <label class="an-time-custom-label">From <input type="date" class="an-time-custom-input" id="an-custom-start" value="${analyticsCustomStart}"/></label>
        <label class="an-time-custom-label">To <input type="date" class="an-time-custom-input" id="an-custom-end" value="${analyticsCustomEnd}"/></label>
        <button class="an-time-btn an-time-apply-btn" id="an-custom-apply">Apply</button>
      </div>
      <span class="an-time-filter-summary">Showing <strong>${filteredItems.length}</strong> of ${items.length} items · ${timeFilterLabels[analyticsTimeFilter]}</span>
    </div>

    <!-- Health Score + SLA + Avg Resolution -->
    <div class="an-health-row">
      <div class="so-health-card so-health-clickable" id="an-health-card-btn">
        <div class="so-health-ring-wrap">
          <svg class="so-health-ring" viewBox="0 0 120 120">
            <circle cx="60" cy="60" r="52" fill="none" stroke="#f0f0f0" stroke-width="10"/>
            <circle cx="60" cy="60" r="52" fill="none" stroke="${hClr}" stroke-width="10"
              stroke-dasharray="${Math.round(326.7*systemHealth/100)} 326.7"
              stroke-linecap="round" transform="rotate(-90 60 60)" style="transition:stroke-dasharray .6s ease"/>
          </svg>
          <div class="so-health-center">
            <span class="so-health-score" style="color:${hClr}">${systemHealth}</span>
            <span class="so-health-label">${hLbl}</span>
          </div>
        </div>
        <div class="so-health-title">System Health Score ${infoIcon("Composite score: average of Resolution Rate, Overdue Score, SLA Compliance, and Knowledge Reuse (×2 weight). Range 0–100.")}</div>
        <button class="an-kpi-view-btn" id="health-view-details-btn" style="margin-top:4px">View Details</button>
      </div>
      <div class="an-kpi-card" style="text-align:center;justify-content:center;align-items:center">
        <span class="an-kpi-label">SLA Compliance ${infoIcon("Percentage of resolved items with a due date that were closed on or before their deadline. Higher is better.","left")}</span>
        <span class="an-kpi-val">${slaRate}%</span>
        <span class="an-kpi-sub">${slaMet} of ${resolvedWithDue.length} met deadline</span>
        <button class="an-kpi-view-btn" id="sla-view-details-btn" style="margin-top:4px">View Details</button>
      </div>
      <div class="an-kpi-card" style="text-align:center;justify-content:center;align-items:center">
        <span class="an-kpi-label">Avg. Resolution Time ${infoIcon("Average number of days between createdAt and resolvedAt for resolved challenges. Lower is better.","left")}</span>
        <span class="an-kpi-val">${avgResDays}d</span>
        <span class="an-kpi-sub">${resolvedChallenges.length} resolved challenges</span>
      </div>
    </div>

    <!-- KPI Cards -->
    <div class="an-kpi-grid-4">
      <div class="an-kpi-card">
        <span class="an-kpi-label">Knowledge Reuse Count ${infoIcon("Number of challenges resolved by reusing an existing solution.","left")}</span>
        <span class="an-kpi-val">${m.reuseItems}</span>
        <span class="an-kpi-sub">${m.reuseRate}% of all challenges</span>
        <button class="an-kpi-view-btn" data-kpi-title="Knowledge Reuse Cases" data-kpi-ids='${JSON.stringify(m.reuseItemIds)}'>View cases →</button>
      </div>
      <div class="an-kpi-card">
        <span class="an-kpi-label">First-Touch Resolution ${infoIcon("% of resolved challenges closed without a meeting and ≤2 updates.","left")}</span>
        <span class="an-kpi-val">${m.ftrr}%</span>
        <span class="an-kpi-sub">${m.ftrrItemIds.length} resolved without a meeting</span>
        <button class="an-kpi-view-btn" data-kpi-title="First-Touch Resolution Cases" data-kpi-ids='${JSON.stringify(m.ftrrItemIds)}'>View cases →</button>
      </div>
      <div class="an-kpi-card">
        <span class="an-kpi-label">Escalation Avoidance ${infoIcon("% of resolved challenges that stayed ≤ regional level.","left")}</span>
        <span class="an-kpi-val">${m.ear}%</span>
        <span class="an-kpi-sub">${m.escalAvoidIds.length} stayed ≤ regional level</span>
        <button class="an-kpi-view-btn" data-kpi-title="Escalation Avoidance Cases" data-kpi-ids='${JSON.stringify(m.escalAvoidIds)}'>View cases →</button>
      </div>
      <div class="an-kpi-card">
        <span class="an-kpi-label">Knowledge Compound Index ${infoIcon("% of solutions reused as source by another challenge.","left")}</span>
        <span class="an-kpi-val">${m.kci}%</span>
        <span class="an-kpi-sub">${m.reuseSourceCount} solutions reused as source</span>
        <button class="an-kpi-view-btn" data-kpi-title="Knowledge Compound — Reused Solutions" data-kpi-ids='${JSON.stringify(m.kciItemIds)}'>View cases →</button>
      </div>
    </div>

    <!-- Resolution Time -->
    <div class="panel an-panel-compact">
      <div class="an-section-head">
        <span class="an-section-title">Resolution Time — Reuse vs. Fresh ${infoIcon("Compares average days-to-resolve for challenges with knowledge reuse vs. fresh resolution. Computed from createdAt/resolvedAt timestamps.")}</span>
        <span class="an-section-note">${m.resolvedCount} resolved items</span>
      </div>
      ${resolutionSection}
    </div>
  `;

  // Wire Health Score popup (both card click and View Details button)
  const hBtn = container.querySelector("#an-health-card-btn");
  if (hBtn) hBtn.addEventListener("click", (e) => {
    if (e.target.closest(".an-kpi-view-btn") || e.target.closest(".info-icon")) return;
    openHealthBreakdownPopup(healthBreakdown);
  });
  const hDetailBtn = container.querySelector("#health-view-details-btn");
  if (hDetailBtn) hDetailBtn.addEventListener("click", (e) => { e.stopPropagation(); openHealthBreakdownPopup(healthBreakdown); });

  // Wire SLA View Details button
  const slaDetailBtn = container.querySelector("#sla-view-details-btn");
  if (slaDetailBtn) slaDetailBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openHealthBreakdownPopup({
      overall: slaRate,
      components: [
        {label:"SLA Met",value:slaMet,max:resolvedWithDue.length||1,detail:`${slaMet} items resolved before or on due date`},
        {label:"SLA Breached",value:resolvedWithDue.length-slaMet,max:resolvedWithDue.length||1,detail:`${resolvedWithDue.length-slaMet} items resolved after due date`},
        {label:"Compliance Rate",value:slaRate,max:100,detail:`${slaRate}% of items with due dates met SLA`},
      ],
      title: "SLA Compliance Breakdown"
    });
  });

  // Wire View Cases buttons ONLY (not whole card)
  container.querySelectorAll(".an-kpi-view-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const ids = JSON.parse(btn.dataset.kpiIds || "[]");
      if (ids.length) openAnalyticsPopup(btn.dataset.kpiTitle, ids);
      else showToast("No cases for this metric yet.");
    });
  });

  // Wire time filter
  container.querySelectorAll(".an-time-btn[data-time-filter]").forEach(btn => {
    btn.addEventListener("click", () => { analyticsTimeFilter = btn.dataset.timeFilter; renderAnalyticsDashboard(); });
  });
  const ca = container.querySelector("#an-custom-apply");
  if (ca) ca.addEventListener("click", () => {
    analyticsCustomStart = container.querySelector("#an-custom-start")?.value || "";
    analyticsCustomEnd = container.querySelector("#an-custom-end")?.value || "";
    renderAnalyticsDashboard();
  });

  renderSystemOverview(systemContainer);
  initAnalyticsDropdowns();
}

function initAnalyticsDropdowns() {
  const list = document.querySelector("#analytics-dropdowns");
  if (!list || list.dataset.bound === "1") return;
  list.dataset.bound = "1";
  list.addEventListener("click", (event) => {
    const toggle = event.target.closest(".dd-toggle[data-an-dd]");
    if (!toggle || !list.contains(toggle)) return;
    const card = toggle.closest(".dd-card");
    if (card) card.classList.toggle("is-open");
  });
}

// ═══ System Overview Dashboard (Supervisor Only) ═════════════════════════════

function renderSystemOverview(targetContainer = document.querySelector("#screen-system-overview")) {
  const container = targetContainer;
  if (!container) return;

  // SO time filter
  const soTF = systemOverviewTimeFilter;
  let allItems = items;
  if (soTF === "today") {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    allItems = items.filter(i => new Date(i.createdAt) >= todayStart);
  } else if (soTF !== "all" && soTF !== "custom") {
    const now = new Date();
    let sd = new Date(now);
    if (soTF === "7d") sd.setDate(sd.getDate()-7);
    else if (soTF === "30d") sd.setDate(sd.getDate()-30);
    else if (soTF === "90d") sd.setDate(sd.getDate()-90);
    allItems = items.filter(i => new Date(i.createdAt) >= sd);
  } else if (soTF === "custom" && systemOverviewCustomStart && systemOverviewCustomEnd) {
    const sd = new Date(systemOverviewCustomStart + "T00:00:00");
    const ed = new Date(systemOverviewCustomEnd + "T23:59:59");
    allItems = items.filter(i => { const d = new Date(i.createdAt); return d >= sd && d <= ed; });
  }
  // Department filter
  const soDeptVal = systemOverviewDeptFilter;
  if (soDeptVal !== "all") {
    allItems = allItems.filter(i => i.department === soDeptVal);
  }

  const challenges = allItems.filter(i => i.type === "challenge");
  const contributions = allItems.filter(i => i.type === "contribution");
  const celebrations = allItems.filter(i => i.type === "celebration");

  const openItemIds = allItems.filter(i => isOpenStatus(i.status)).map(i => i.id);
  const resolvedItemIds = allItems.filter(i => i.status === "resolved" || i.status === "closed").map(i => i.id);
  const escalatedItemIds = challenges.filter(i => i.status === "escalated").map(i => i.id);
  const overdueItemIds = allItems.filter(i => i.dueDate && isOpenStatus(i.status) && new Date(i.dueDate + "T23:59:59") < new Date()).map(i => i.id);
  const challengeIds = challenges.map(i => i.id);

  const totalItems = allItems.length;
  const openItems = openItemIds.length;
  const resolvedItems = resolvedItemIds.length;
  const escalatedItems = escalatedItemIds.length;
  const overdueItems = overdueItemIds.length;

  // Department workload
  const deptWorkload = {};
  const deptItemIdsMap = {};
  challenges.forEach(i => {
    const dept = i.department || "Unknown";
    if (!deptWorkload[dept]) deptWorkload[dept] = { total:0,open:0,resolved:0,escalated:0,overdue:0 };
    if (!deptItemIdsMap[dept]) deptItemIdsMap[dept] = { total:[],open:[],resolved:[],escalated:[],overdue:[] };
    deptWorkload[dept].total++; deptItemIdsMap[dept].total.push(i.id);
    if (isOpenStatus(i.status)) { deptWorkload[dept].open++; deptItemIdsMap[dept].open.push(i.id); }
    if (i.status==="resolved"||i.status==="closed") { deptWorkload[dept].resolved++; deptItemIdsMap[dept].resolved.push(i.id); }
    if (i.status==="escalated") { deptWorkload[dept].escalated++; deptItemIdsMap[dept].escalated.push(i.id); }
    if (i.dueDate && isOpenStatus(i.status) && new Date(i.dueDate+"T23:59:59")<new Date()) { deptWorkload[dept].overdue++; deptItemIdsMap[dept].overdue.push(i.id); }
  });
  const deptWorkloadArr = Object.entries(deptWorkload).sort((a,b) => b[1].total - a[1].total);

  // User activity
  const userActivity = {};
  const userItemIds = {};
  allItems.forEach(i => {
    const user = i.createdBy || "Unknown";
    if (!userActivity[user]) userActivity[user] = { created:0, resolved:0 };
    if (!userItemIds[user]) userItemIds[user] = [];
    userActivity[user].created++; userItemIds[user].push(i.id);
    if (i.resolvedBy === user) userActivity[user].resolved++;
  });
  const topContributors = Object.entries(userActivity).sort((a,b) => (b[1].created+b[1].resolved)-(a[1].created+a[1].resolved)).slice(0,8);

  // Priority
  const priorityCounts = { high:0, medium:0, low:0 };
  const priorityIds = { high:[], medium:[], low:[] };
  challenges.filter(i => isOpenStatus(i.status)).forEach(i => {
    const p = i.priority || "medium";
    priorityCounts[p]++; priorityIds[p].push(i.id);
  });

  // Status funnel
  const statusCounts = {};
  const statusItemIds = {};
  allItems.forEach(i => {
    statusCounts[i.status] = (statusCounts[i.status]||0)+1;
    if (!statusItemIds[i.status]) statusItemIds[i.status] = [];
    statusItemIds[i.status].push(i.id);
  });
  const statusOrder = ["new","assigned","in_discussion","escalated","resolved","closed"];
  const statusLabels = {new:"New",assigned:"Assigned",in_discussion:"In Discussion",escalated:"Escalated",resolved:"Resolved",closed:"Closed"};

  // Bar chart data: Meeting Level
  const levelData = MEETING_HIERARCHY.map(({key,label}) => {
    const ch = challenges.filter(i => isOpenStatus(i.status) && (i.meetingLevel||"team_weekly")===key);
    return { label: label.replace(" Meeting",""), count: ch.length, ids: ch.map(i=>i.id) };
  });
  const maxLvl = Math.max(...levelData.map(d=>d.count),1);

  // Root causes
  const rcMap = {};
  challenges.filter(i => i.solutionTemplate?.rootCause).forEach(i => {
    const rc = i.solutionTemplate.rootCause;
    if (!rcMap[rc]) rcMap[rc] = {count:0,ids:[]};
    rcMap[rc].count++; rcMap[rc].ids.push(i.id);
  });
  const rcArr = Object.entries(rcMap).sort((a,b)=>b[1].count-a[1].count).slice(0,5);
  const maxRc = rcArr[0]?.[1]?.count||1;

  // Dept breakdown for bar chart
  const deptBarMap = {};
  challenges.forEach(i => {
    const d = i.department;
    if (!deptBarMap[d]) deptBarMap[d] = {count:0,ids:[]};
    deptBarMap[d].count++; deptBarMap[d].ids.push(i.id);
  });
  const deptBarArr = Object.entries(deptBarMap).sort((a,b)=>b[1].count-a[1].count).slice(0,6);
  const maxDB = deptBarArr[0]?.[1]?.count||1;

  // Clusters
  const clusters = buildChallengeClusters();
  const maxCl = clusters[0]?.count||1;

  // Activity
  const recentActivity = [];
  allItems.forEach(i => {
    if (i.createdAt) recentActivity.push({date:i.createdAt,icon:"📝",text:`<strong>${escapeHtml(i.createdBy||"Unknown")}</strong> created ${escapeHtml(i.type)} <em>${escapeHtml(i.title)}</em>`,id:i.id});
    if (i.resolvedAt) recentActivity.push({date:i.resolvedAt,icon:"✅",text:`<strong>${escapeHtml(i.resolvedBy||"Unknown")}</strong> resolved <em>${escapeHtml(i.title)}</em>`,id:i.id});
    if (i.status==="escalated"&&i.details?.escalationMeetingDate) recentActivity.push({date:i.details.escalationMeetingDate,icon:"⚡",text:`<em>${escapeHtml(i.title)}</em> was escalated`,id:i.id});
  });
  recentActivity.sort((a,b)=>b.date.localeCompare(a.date));
  const recentSlice = recentActivity.slice(0,15);

  const maxDeptTotal = deptWorkloadArr[0]?.[1]?.total||1;

  // SO filters state from container
  const soDept = systemOverviewDeptFilter;
  const soCustomStart = systemOverviewCustomStart;
  const soCustomEnd = systemOverviewCustomEnd;
  const allDepts = [...new Set(items.map(i => i.department))].sort();

  container.innerHTML = `
    <!-- Time + Dept Filter -->
    <div class="an-time-filter-bar">
      <div class="an-time-filter-row">
        <span class="an-time-filter-label">Period</span>
        <div class="an-time-filter-btns">
          ${["all","today","7d","30d","90d","custom"].map(k =>
            `<button class="an-time-btn so-tf-btn${soTF===k?" is-active":""}" data-so-tf="${k}">${({all:"All Time",today:"Today","7d":"7 Days","30d":"30 Days","90d":"90 Days",custom:"Custom"})[k]}</button>`
          ).join("")}
        </div>
        <select class="so-dept-filter-select" id="so-dept-filter-sel">
          <option value="all"${soDept==="all"?" selected":""}>All Departments</option>
          ${allDepts.map(d => `<option value="${escapeHtml(d)}"${soDept===d?" selected":""}>${escapeHtml(d)}</option>`).join("")}
        </select>
      </div>
      <div class="so-custom-row" style="display:${soTF==="custom"?"flex":"none"}">
        <label class="an-time-custom-label">From <input type="date" class="an-time-custom-input" id="so-custom-start" value="${soCustomStart}"/></label>
        <label class="an-time-custom-label">To <input type="date" class="an-time-custom-input" id="so-custom-end" value="${soCustomEnd}"/></label>
        <button class="an-time-btn an-time-apply-btn" id="so-custom-apply">Apply</button>
      </div>
    </div>

    <!-- Core Stats -->
    <div class="so-stats-grid" style="margin-bottom:14px">
      <div class="so-stat-card so-stat-clickable" data-so-popup-title="All Items" data-so-popup-ids='${JSON.stringify(allItems.map(i=>i.id))}'><span class="so-stat-val">${totalItems}</span><span class="so-stat-lbl">Total Items</span></div>
      <div class="so-stat-card so-stat-open so-stat-clickable" data-so-popup-title="Open Items" data-so-popup-ids='${JSON.stringify(openItemIds)}'><span class="so-stat-val">${openItems}</span><span class="so-stat-lbl">Open</span></div>
      <div class="so-stat-card so-stat-resolved so-stat-clickable" data-so-popup-title="Resolved Items" data-so-popup-ids='${JSON.stringify(resolvedItemIds)}'><span class="so-stat-val">${resolvedItems}</span><span class="so-stat-lbl">Resolved</span></div>
      <div class="so-stat-card so-stat-escalated so-stat-clickable" data-so-popup-title="Escalated Items" data-so-popup-ids='${JSON.stringify(escalatedItemIds)}'><span class="so-stat-val">${escalatedItems}</span><span class="so-stat-lbl">Escalated</span></div>
      <div class="so-stat-card so-stat-overdue so-stat-clickable" data-so-popup-title="Overdue Items" data-so-popup-ids='${JSON.stringify(overdueItemIds)}'><span class="so-stat-val">${overdueItems}</span><span class="so-stat-lbl">Overdue</span></div>
      <div class="so-stat-card so-stat-clickable" data-so-popup-title="All Challenges" data-so-popup-ids='${JSON.stringify(challengeIds)}'><span class="so-stat-val">${challenges.length}/${contributions.length}/${celebrations.length}</span><span class="so-stat-lbl">Ch / Co / Ce</span></div>
    </div>

    <!-- Status + Priority -->
    <div class="so-mid-grid">
      <div class="panel an-panel-compact">
        <div class="an-section-head"><span class="an-section-title">Status Pipeline</span></div>
        <div class="so-funnel">
          ${statusOrder.map(s => {
            const cnt = statusCounts[s]||0;
            const pct = totalItems ? Math.round((cnt/totalItems)*100) : 0;
            const ids = JSON.stringify(statusItemIds[s]||[]);
            return `<div class="so-funnel-step${cnt>0?"":" so-funnel-empty"} so-funnel-clickable" data-so-popup-title="${statusLabels[s]} Items" data-so-popup-ids='${ids}'>
              <div class="so-funnel-bar-wrap"><div class="so-funnel-bar" data-status="${s}" style="width:${Math.max(pct,3)}%"></div></div>
              <div class="so-funnel-info"><span class="so-funnel-count">${cnt}</span><span class="so-funnel-name">${statusLabels[s]}</span><span class="so-funnel-pct">${pct}%</span></div>
            </div>`;
          }).join("")}
        </div>
      </div>
      <div class="panel an-panel-compact">
        <div class="an-section-head"><span class="an-section-title">Open Priority Matrix</span></div>
        <div class="so-priority-grid">
          ${[{k:"high",label:"High",clr:"#ef4444"},{k:"medium",label:"Medium",clr:"#f59e0b"},{k:"low",label:"Low",clr:"#22c55e"}].map(p => {
            const cnt = priorityCounts[p.k]||0;
            const oc = challenges.filter(i=>isOpenStatus(i.status)).length||1;
            const pct = Math.round((cnt/oc)*100);
            const ids = JSON.stringify(priorityIds[p.k]||[]);
            return `<div class="so-priority-item so-priority-clickable" data-so-popup-title="${p.label} Priority" data-so-popup-ids='${ids}'>
              <div class="so-priority-header"><span class="so-priority-dot" style="background:${p.clr}"></span><span class="so-priority-label">${p.label}</span><span class="so-priority-count">${cnt}</span></div>
              <div class="so-priority-track"><div class="so-priority-fill" style="width:${pct}%;background:${p.clr}"></div></div>
              <span class="so-priority-pct">${pct}%</span>
            </div>`;
          }).join("")}
        </div>
      </div>
    </div>

    <!-- 4 Bar Chart Panels -->
    <div class="an-lower-grid">
      <div class="panel an-panel-compact">
        <div class="an-section-head"><span class="an-section-title">Open Challenges by Meeting Level</span><span class="an-section-hint">Click a row to see cases</span></div>
        <div class="an-bar-list">
          ${levelData.map(d => `<div class="an-bar-row an-bar-clickable" data-popup-title="Open Challenges — ${d.label}" data-popup-ids='${JSON.stringify(d.ids)}'>
            <span class="an-bar-lbl">${d.label}</span><div class="an-bar-track"><div class="an-bar-fill" style="width:${Math.round((d.count/maxLvl)*100)}%"></div></div><span class="an-bar-cnt">${d.count}</span>
          </div>`).join("")}
        </div>
      </div>
      <div class="panel an-panel-compact">
        <div class="an-section-head"><span class="an-section-title">Top Root Causes</span><span class="an-section-hint">Click a row to see cases</span></div>
        <div class="an-bar-list">
          ${rcArr.length ? rcArr.map(([label,{count,ids}]) => `<div class="an-bar-row an-bar-clickable" data-popup-title="Root Cause: ${escapeHtml(label)}" data-popup-ids='${JSON.stringify(ids)}'>
            <span class="an-bar-lbl">${escapeHtml(label)}</span><div class="an-bar-track"><div class="an-bar-fill" style="width:${Math.round((count/maxRc)*100)}%"></div></div><span class="an-bar-cnt">${count}</span>
          </div>`).join("") : '<p class="an-empty">No root cause data yet.</p>'}
        </div>
      </div>
      <div class="panel an-panel-compact">
        <div class="an-section-head"><span class="an-section-title">Challenges by Department</span><span class="an-section-hint">Click a row to see cases</span></div>
        <div class="an-bar-list">
          ${deptBarArr.map(([dept,{count,ids}]) => `<div class="an-bar-row an-bar-clickable" data-popup-title="Department: ${escapeHtml(dept)}" data-popup-ids='${JSON.stringify(ids)}'>
            <span class="an-bar-lbl">${escapeHtml(dept)}</span><div class="an-bar-track"><div class="an-bar-fill" style="width:${Math.round((count/maxDB)*100)}%"></div></div><span class="an-bar-cnt">${count}</span>
          </div>`).join("")}
        </div>
      </div>
      <div class="panel an-panel-compact">
        <div class="an-section-head"><span class="an-section-title">Challenge Clusters</span><span class="an-section-hint">Click a row to see cases</span></div>
        <div class="an-bar-list">
          ${clusters.map(({label,count,items:cIds}) => `<div class="an-bar-row an-bar-clickable" data-popup-title="Cluster: ${escapeHtml(label.replace(/^\S+\s/,''))}" data-popup-ids='${JSON.stringify(cIds||[])}'>
            <span class="an-bar-lbl">${escapeHtml(label)}</span><div class="an-bar-track"><div class="an-bar-fill" style="width:${Math.round((count/maxCl)*100)}%"></div></div><span class="an-bar-cnt">${count}</span>
          </div>`).join("")}
        </div>
      </div>
    </div>

    <!-- Dept Table -->
    <div class="panel an-panel-compact">
      <div class="an-section-head"><span class="an-section-title">Department Workload</span></div>
      <div class="so-dept-table-wrap">
        <table class="so-dept-table"><thead><tr><th>Department</th><th>Total</th><th>Open</th><th>Resolved</th><th>Escalated</th><th>Overdue</th><th>Workload</th></tr></thead>
        <tbody>${deptWorkloadArr.map(([dept,d]) => {
          const di = deptItemIdsMap[dept]||{total:[],open:[],resolved:[],escalated:[],overdue:[]};
          return `<tr>
            <td class="so-dept-name so-dept-clickable" data-so-popup-title="${escapeHtml(dept)} — All" data-so-popup-ids='${JSON.stringify(di.total)}'>${escapeHtml(dept)}</td>
            <td class="so-dept-clickable" data-so-popup-title="${escapeHtml(dept)} — All" data-so-popup-ids='${JSON.stringify(di.total)}'><strong>${d.total}</strong></td>
            <td class="so-dept-clickable" data-so-popup-title="${escapeHtml(dept)} — Open" data-so-popup-ids='${JSON.stringify(di.open)}'>${d.open}</td>
            <td class="so-dept-clickable" data-so-popup-title="${escapeHtml(dept)} — Resolved" data-so-popup-ids='${JSON.stringify(di.resolved)}'>${d.resolved}</td>
            <td class="so-dept-clickable" data-so-popup-title="${escapeHtml(dept)} — Escalated" data-so-popup-ids='${JSON.stringify(di.escalated)}'>${d.escalated>0?`<span class="so-dept-esc">${d.escalated}</span>`:"0"}</td>
            <td class="so-dept-clickable" data-so-popup-title="${escapeHtml(dept)} — Overdue" data-so-popup-ids='${JSON.stringify(di.overdue)}'>${d.overdue>0?`<span class="so-dept-overdue">${d.overdue}</span>`:"0"}</td>
            <td><div class="so-dept-bar-track"><div class="so-dept-bar-fill" style="width:${Math.round((d.total/maxDeptTotal)*100)}%"></div></div></td>
          </tr>`; }).join("")}</tbody></table>
      </div>
    </div>

    <!-- Contributors + Activity -->
    <div class="so-bottom-grid">
      <div class="panel an-panel-compact">
        <div class="an-section-head"><span class="an-section-title">Top Contributors</span></div>
        <div class="so-contrib-list">
          ${topContributors.map(([user,stats],idx) => {
            const ini = user.split(" ").map(w=>w[0]||"").join("").toUpperCase().slice(0,2);
            const ta = stats.created+stats.resolved;
            const ma = (topContributors[0]?.[1]?.created||0)+(topContributors[0]?.[1]?.resolved||0)||1;
            const ids = JSON.stringify(userItemIds[user]||[]);
            return `<div class="so-contrib-row so-contrib-clickable" data-so-popup-title="Items by ${escapeHtml(user)}" data-so-popup-ids='${ids}'>
              <span class="so-contrib-rank">${idx+1}</span><span class="so-contrib-avatar">${ini}</span>
              <div class="so-contrib-info"><span class="so-contrib-name">${escapeHtml(user)}</span><span class="so-contrib-detail">${stats.created} created · ${stats.resolved} resolved</span></div>
              <div class="so-contrib-bar-track"><div class="so-contrib-bar-fill" style="width:${Math.round((ta/ma)*100)}%"></div></div>
            </div>`;
          }).join("")}
        </div>
      </div>
      <div class="panel an-panel-compact">
        <div class="an-section-head"><span class="an-section-title">Recent Activity Stream</span></div>
        <div class="so-activity-stream">
          ${recentSlice.length ? recentSlice.map(a =>
            `<div class="so-activity-item" data-activity-id="${a.id}"><span class="so-activity-icon">${a.icon}</span><div class="so-activity-body"><span class="so-activity-text">${a.text}</span><span class="so-activity-date">${a.date}</span></div></div>`
          ).join("") : '<p class="an-empty">No recent activity.</p>'}
        </div>
      </div>
    </div>
  `;

  // Wire clickable stats/funnel/priority/dept/contrib
  container.querySelectorAll("[data-so-popup-title]").forEach(el => {
    el.style.cursor = "pointer";
    el.addEventListener("click", e => {
      e.stopPropagation();
      const ids = JSON.parse(el.dataset.soPopupIds||"[]");
      if (ids.length) openAnalyticsPopup(el.dataset.soPopupTitle, ids);
      else showToast("No items for this metric.");
    });
  });

  // Wire bar chart rows
  container.querySelectorAll(".an-bar-clickable").forEach(row => {
    row.addEventListener("click", () => {
      const ids = JSON.parse(row.dataset.popupIds||"[]");
      openAnalyticsPopup(row.dataset.popupTitle, ids);
    });
  });

  // Wire activity
  container.querySelectorAll(".so-activity-item[data-activity-id]").forEach(el => {
    el.addEventListener("click", () => openDetailDrawer(el.dataset.activityId));
  });

  // Wire SO time filter
  container.querySelectorAll(".so-tf-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      systemOverviewTimeFilter = btn.dataset.soTf;
      renderSystemOverview(container);
    });
  });
  const soCustomApply = container.querySelector("#so-custom-apply");
  if (soCustomApply) soCustomApply.addEventListener("click", () => {
    systemOverviewCustomStart = container.querySelector("#so-custom-start")?.value || "";
    systemOverviewCustomEnd = container.querySelector("#so-custom-end")?.value || "";
    renderSystemOverview(container);
  });
  const soDeptSel = container.querySelector("#so-dept-filter-sel");
  if (soDeptSel) soDeptSel.addEventListener("change", () => {
    systemOverviewDeptFilter = soDeptSel.value;
    renderSystemOverview(container);
  });
}



// ═══ V2: Meeting Hierarchy Visual (Tutor Feedback §6) ═══════════════════

function buildHierarchyHTML(currentLevel) {
  return `<div class="escalation-hierarchy">
    ${MEETING_HIERARCHY.map((level) => {
      const isActive = level.key === currentLevel;
      return `<div class="hierarchy-step">
        <div class="hierarchy-dot ${isActive ? "active" : ""}"></div>
        <span class="hierarchy-label ${isActive ? "active" : ""}">${escapeHtml(level.label)}</span>
        <span class="hierarchy-time">${level.time}</span>
      </div>`;
    }).join("")}
  </div>`;
}

// ═══ V2: Status Workflow Visual (Tutor Feedback §4) ═════════════════════

function buildStatusWorkflowHTML(currentStatus) {
  const steps = ["new", "assigned", "in_discussion", "escalated", "resolved"];
  const currentIdx = steps.indexOf(currentStatus);
  return `<div class="status-workflow">
    ${steps.map((step, idx) => {
      let cls = "";
      if (idx < currentIdx) cls = "done";
      else if (idx === currentIdx) cls = "current";
      const arrow = idx < steps.length - 1 ? '<span class="status-arrow">→</span>' : "";
      return `<span class="status-step ${cls}">${toLabel(step)}</span>${arrow}`;
    }).join("")}
  </div>`;
}

// ═══ V2: Populate Department Filter Dropdowns ════════════════════════════

function populateDeptFilters() {
  const depts = [...new Set(items.map((item) => item.department))].sort();
  const selectors = ["#dept-filter", "#archive-dept-filter"];
  selectors.forEach((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const current = el.value;
    el.innerHTML = '<option value="all">All Departments</option>';
    depts.forEach((dept) => {
      el.innerHTML += `<option value="${escapeHtml(dept)}">${escapeHtml(dept)}</option>`;
    });
    el.value = current || "all";
  });
}

// ═══ Settings Screen (role-aware) ════════════════════════════════════════

function notificationIconForType(type) {
  return {
    assign: "📌",
    escalate: "📌",
    resolve: "📌",
    overdue: "📌",
    like: "📌",
    info: "📌",
  }[type] || "📌";
}

function renderSettings() {
  const container = document.querySelector("#screen-settings");
  if (!container) return;
  const supervisor = isSupervisorView();
  syncSettingsNavLabel();
  if (!supervisor) {
    container.innerHTML = `
      <div class="panel">
        <div class="panel-header">
          <h2>Settings</h2>
          <p>Settings are available in supervisor view.</p>
        </div>
      </div>
    `;
    return;
  }

  const totalItems = items.length;
  const openItems = items.filter((item) => isOpenStatus(item.status)).length;
  const resolvedItems = items.filter((item) => item.status === "resolved").length;
  const closedItems = items.filter((item) => item.status === "closed").length;
  const escalatedItems = items.filter((item) => item.status === "escalated").length;
  const overdueItems = items.filter((item) => item.dueDate && isOpenStatus(item.status) && isOverdue(item)).length;
  const challenges = items.filter((item) => item.type === "challenge").length;
  const contributions = items.filter((item) => item.type === "contribution").length;
  const celebrations = items.filter((item) => item.type === "celebration").length;
  const notifications = loadNotifications();
  const statusOptions = ["new", "assigned", "in_discussion", "escalated", "resolved", "closed"];

  const currentUser = _currentUser();
  const logPreview = meetingLog.length
    ? meetingLog.slice(0, 24).map((entry) => `<div class="admin-log-item">${escapeHtml(entry)}</div>`).join("")
    : '<p class="dash-empty">No audit entries yet in this session.</p>';

      const notifRows = notifications.length
    ? notifications.slice(0, 28).map((notif) => `
        <div class="admin-notif-item ${notif.read ? "" : "is-unread"}" data-notif-id="${notif.id}">
          <div class="admin-notif-main">
            <span class="admin-notif-icon">${notificationIconForType(notif.type)}</span>
            <div class="admin-notif-copy">
              <p class="admin-notif-title">${escapeHtml(notif.title)}</p>
              <p class="admin-notif-body">${escapeHtml(truncate(notif.body, 120))}</p>
            </div>
          </div>
          <div class="admin-notif-actions">
            <button type="button" class="admin-pill-btn" data-admin-notif-read="${notif.id}">Read</button>
            <button type="button" class="admin-notif-remove" data-admin-notif-remove="${notif.id}" aria-label="Remove notification">&times;</button>
          </div>
        </div>
      `).join("")
    : '<p class="dash-empty">No notifications yet.</p>';

  container.innerHTML = `
    <div class="admin-settings-stack">
      <div class="panel admin-portal-hero">
        <div class="panel-header">
          <h2>Admin Settings</h2>
          <p>Supervisor-only controls for managing the RED in-SYNCC system.</p>
        </div>
      </div>

      <div class="panel admin-settings-section">
        <div class="admin-section-head"><h3>Notifications</h3></div>
        <div class="admin-section-body">
          <div id="settings-notifications-list" class="admin-notif-list">${notifRows}</div>
          <div class="admin-action-row">
            <button type="button" class="admin-btn-outline" data-settings-action="clear-notifs">Clear All Notifications</button>
            <button type="button" class="admin-btn-outline" data-settings-action="mark-all-read">Mark All Read</button>
          </div>
          <form id="settings-manual-notif-form" class="admin-manual-form">
            <h4>Send Manual Notification</h4>
            <input id="settings-manual-title" type="text" placeholder="Notification title" required />
            <input id="settings-manual-body" type="text" placeholder="Notification body text" required />
            <select id="settings-manual-type">
              <option value="info">Info</option>
              <option value="assign">Assignment</option>
              <option value="escalate">Escalation</option>
              <option value="resolve">Resolution</option>
              <option value="overdue">Overdue</option>
            </select>
            <button type="submit" class="admin-btn-primary">Send Notification</button>
          </form>
        </div>
      </div>

      <div class="panel admin-settings-section">
        <div class="admin-section-head"><h3>Items &amp; Data</h3></div>
        <div class="admin-section-body">
          <div class="admin-metric-grid">
            <div class="admin-metric-card"><strong>${totalItems}</strong><span>Total Items</span></div>
            <div class="admin-metric-card"><strong class="metric-open">${openItems}</strong><span>Open</span></div>
            <div class="admin-metric-card"><strong class="metric-resolved">${resolvedItems}</strong><span>Resolved</span></div>
            <div class="admin-metric-card"><strong>${closedItems}</strong><span>Closed</span></div>
            <div class="admin-metric-card"><strong class="metric-escalated">${escalatedItems}</strong><span>Escalated</span></div>
            <div class="admin-metric-card"><strong class="metric-overdue">${overdueItems}</strong><span>Overdue</span></div>
            <div class="admin-metric-card"><strong>${challenges}</strong><span>Challenges</span></div>
            <div class="admin-metric-card"><strong>${contributions}</strong><span>Contributions</span></div>
            <div class="admin-metric-card"><strong>${celebrations}</strong><span>Celebrations</span></div>
          </div>

          <h4 class="admin-subhead">Bulk Actions</h4>
          <div class="admin-action-row">
            <button type="button" class="admin-btn-outline" id="settings-close-resolved">Close All Resolved Items</button>
            <button type="button" class="admin-btn-outline" id="settings-reevaluate-overdue">Re-evaluate Overdue Flags</button>
            <button type="button" class="admin-btn-outline" id="settings-export-data">Export All Data (JSON)</button>
          </div>

          <h4 class="admin-subhead">Delete by Status</h4>
          <div class="admin-delete-row">
            <select id="settings-delete-status">
              <option value="">-- Select status --</option>
              ${statusOptions.map((status) => `<option value="${status}">${toLabel(status)}</option>`).join("")}
            </select>
            <button type="button" class="admin-btn-danger" id="settings-delete-by-status">Delete Items with Status</button>
          </div>
        </div>
      </div>

      <div class="panel admin-settings-section">
        <div class="admin-section-head"><h3>System Settings</h3></div>
        <div class="admin-section-body">
          <h4 class="admin-subhead">Current User Name</h4>
          <div class="admin-inline-controls">
            <input id="settings-user-name" type="text" value="${escapeHtml(currentUser)}" />
            <button type="button" class="admin-btn-primary" id="settings-apply-name">Apply Name</button>
          </div>

          <h4 class="admin-subhead">Meeting Week Override</h4>
          <div class="admin-inline-controls">
            <input id="settings-meeting-week" type="date" value="${activeMeetingWeek}" />
            <button type="button" class="admin-btn-primary" id="settings-set-week">Set Meeting Week</button>
            <button type="button" class="admin-btn-outline" id="settings-reset-week">Reset to Current</button>
          </div>

          <h4 class="admin-subhead">Danger Zone</h4>
          <div class="admin-action-row">
            <button type="button" class="admin-btn-danger" id="settings-reset-data">Reset All Data to Default</button>
            <button type="button" class="admin-btn-danger" id="settings-clear-storage">Clear All Local Storage</button>
          </div>
        </div>
      </div>

      <div class="panel admin-settings-section">
        <div class="admin-section-head"><h3>Audit Log</h3></div>
        <div class="admin-section-body">
          <div class="admin-action-row">
            <button type="button" class="admin-btn-outline" id="settings-clear-log">Clear Log</button>
            <button type="button" class="admin-btn-outline" id="settings-export-log">Export Log</button>
          </div>
          <div class="admin-log-list">${logPreview}</div>
        </div>
      </div>
    </div>
  `;

  container.querySelectorAll("[data-admin-notif-read]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const notifId = String(btn.dataset.adminNotifRead || "");
      if (!notifId) return;
      const updated = loadNotifications().map((n) => n.id === notifId ? { ...n, read: true } : n);
      saveNotifications(updated);
      refreshAll();
      showToast("Notification marked as read.");
    });
  });

  container.querySelectorAll("[data-admin-notif-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const notifId = String(btn.dataset.adminNotifRemove || "");
      if (!notifId) return;
      const updated = loadNotifications().filter((n) => n.id !== notifId);
      saveNotifications(updated);
      refreshAll();
      showToast("Notification removed.");
    });
  });

  const clearNotifsBtn = container.querySelector('[data-settings-action="clear-notifs"]');
  if (clearNotifsBtn) {
    clearNotifsBtn.addEventListener("click", () => {
      saveNotifications([]);
      refreshAll();
      showToast("All notifications cleared.");
    });
  }

  const markAllReadBtn = container.querySelector('[data-settings-action="mark-all-read"]');
  if (markAllReadBtn) {
    markAllReadBtn.addEventListener("click", () => {
      const updated = loadNotifications().map((n) => ({ ...n, read: true }));
      saveNotifications(updated);
      refreshAll();
      showToast("All notifications marked as read.");
    });
  }

  const manualForm = container.querySelector("#settings-manual-notif-form");
  if (manualForm) {
    manualForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const title = String(container.querySelector("#settings-manual-title")?.value || "").trim();
      const body = String(container.querySelector("#settings-manual-body")?.value || "").trim();
      const type = String(container.querySelector("#settings-manual-type")?.value || "info");
      if (!title || !body) {
        showToast("Please enter title and body.");
        return;
      }
      addNotification({ type, title, body, department: "System" });
      refreshAll();
      showToast("Manual notification sent.");
    });
  }

  const closeResolvedBtn = container.querySelector("#settings-close-resolved");
  if (closeResolvedBtn) {
    closeResolvedBtn.addEventListener("click", () => {
      const target = items.filter((item) => item.status === "resolved");
      if (!target.length) {
        showToast("No resolved items to close.");
        return;
      }
      target.forEach((item) => {
        item.status = "closed";
        item.updates = item.updates || [];
        item.updates.push({ type: "status_change", note: `Closed via Admin Settings by ${_currentUser()}.` });
      });
      meetingLog.unshift(`${target.length} resolved item(s) closed by ${_currentUser()}.`);
      refreshAll();
      showToast(`${target.length} resolved item(s) moved to closed.`);
    });
  }

  const reevaluateOverdueBtn = container.querySelector("#settings-reevaluate-overdue");
  if (reevaluateOverdueBtn) {
    reevaluateOverdueBtn.addEventListener("click", () => {
      const overdueCount = items.filter((item) => item.dueDate && isOpenStatus(item.status) && isOverdue(item)).length;
      meetingLog.unshift(`Overdue flags re-evaluated by ${_currentUser()} (${overdueCount} currently overdue).`);
      refreshAll();
      showToast(`Overdue check complete: ${overdueCount} item(s) overdue.`);
    });
  }

  const exportDataBtn = container.querySelector("#settings-export-data");
  if (exportDataBtn) {
    exportDataBtn.addEventListener("click", () => {
      const payload = JSON.stringify(items, null, 2);
      const blob = new Blob([payload], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `red-sync-items-${todayISO()}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showToast("Data export generated.");
    });
  }

  const deleteByStatusBtn = container.querySelector("#settings-delete-by-status");
  if (deleteByStatusBtn) {
    deleteByStatusBtn.addEventListener("click", () => {
      const selected = String(container.querySelector("#settings-delete-status")?.value || "");
      if (!selected) {
        showToast("Select a status first.");
        return;
      }
      const matching = items.filter((item) => item.status === selected).length;
      if (!matching) {
        showToast(`No items found with status ${toLabel(selected)}.`);
        return;
      }
      const approved = window.confirm(`Delete ${matching} item(s) with status ${toLabel(selected)}?`);
      if (!approved) return;
      items = items.filter((item) => item.status !== selected);
      meetingLog.unshift(`${matching} item(s) deleted by status (${toLabel(selected)}) by ${_currentUser()}.`);
      saveItems();
      refreshAll();
      showToast(`${matching} item(s) deleted.`);
    });
  }

  const applyNameBtn = container.querySelector("#settings-apply-name");
  if (applyNameBtn) {
    applyNameBtn.addEventListener("click", () => {
      const nextName = String(container.querySelector("#settings-user-name")?.value || "").trim();
      if (!nextName) {
        showToast("Please enter a valid name.");
        return;
      }
      const createdByInput = document.querySelector('#new-item-form [name="createdBy"]');
      if (createdByInput) createdByInput.value = nextName;
      refreshAll();
      showToast("User name updated.");
    });
  }

  const setWeekBtn = container.querySelector("#settings-set-week");
  if (setWeekBtn) {
    setWeekBtn.addEventListener("click", () => {
      const selected = String(container.querySelector("#settings-meeting-week")?.value || "");
      if (!selected) {
        showToast("Select a meeting week date first.");
        return;
      }
      meetingWeekView = "current";
      activeMeetingWeek = mondayOfWeek(selected);
      refreshAll();
      showToast(`Meeting week set to ${activeMeetingWeek}.`);
    });
  }

  const resetWeekBtn = container.querySelector("#settings-reset-week");
  if (resetWeekBtn) {
    resetWeekBtn.addEventListener("click", () => {
      meetingWeekView = "current";
      activeMeetingWeek = upcomingMeetingMondayISO();
      refreshAll();
      showToast("Meeting week reset to current.");
    });
  }

  const resetDataBtn = container.querySelector("#settings-reset-data");
  if (resetDataBtn) {
    resetDataBtn.addEventListener("click", () => {
      if (!window.confirm("Reset all items to default dataset? This will overwrite current local data.")) return;
      items = normalizeItemFields(structuredClone(initialItems));
      meetingLog.length = 0;
      saveItems();
      refreshAll();
      showToast("Data reset to default.");
    });
  }

  const clearStorageBtn = container.querySelector("#settings-clear-storage");
  if (clearStorageBtn) {
    clearStorageBtn.addEventListener("click", () => {
      if (!window.confirm("Clear local RED in-SYNCC storage and reload?")) return;
      Object.keys(localStorage)
        .filter((key) => key.startsWith("red-sync-"))
        .forEach((key) => localStorage.removeItem(key));
      window.location.reload();
    });
  }

  const clearLogBtn = container.querySelector("#settings-clear-log");
  if (clearLogBtn) {
    clearLogBtn.addEventListener("click", () => {
      meetingLog.length = 0;
      refreshAll();
      showToast("Audit log cleared.");
    });
  }

  const exportLogBtn = container.querySelector("#settings-export-log");
  if (exportLogBtn) {
    exportLogBtn.addEventListener("click", () => {
      const payload = meetingLog.length ? meetingLog.join("\n") : "No audit entries.";
      const blob = new Blob([payload], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `red-sync-audit-log-${todayISO()}.txt`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showToast("Audit log exported.");
    });
  }
}

function getTimeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ═══ V2: Show notification banner for unread items ══════════════════════

function showNotificationBanner() {
  const notifs = loadNotifications();
  const unread = notifs.filter((n) => !n.read);
  const banner = document.querySelector("#notification-banner");
  if (!banner) return;
  if (unread.length > 0) {
    banner.style.display = "block";
    document.querySelector("#notification-text").textContent =
      `You have ${unread.length} new notification${unread.length > 1 ? "s" : ""}. ${unread[0].title}`;
  } else {
    banner.style.display = "none";
  }
}

// ═══ V2: Enhanced Analytics with Improvements Table ═════════════════════

function refreshAll() {
  populateDeptFilters();
  renderMeetingWeekContext();
  renderStats();
  runRuleChecksAndNotify();
  renderDashboard();
  renderMeeting();
  renderArchive();
  renderAssistantMessages();
  renderRecap();
  renderAnalyticsDashboard();
  renderSettings();
  showNotificationBanner();
  applyRolePermissions();
  saveItems();
}

function updateTypeFields() {
  const type = document.querySelector("#item-type").value;
  document.querySelector("#challenge-fields").classList.toggle("is-hidden", type !== "challenge");
  document.querySelector("#contribution-fields").classList.toggle("is-hidden", type !== "contribution");
  document.querySelector("#celebration-fields").classList.toggle("is-hidden", type !== "celebration");
  renderCreateDescriptionSuggestions();
}

function openEscalateModal(itemId, prefills = null) {
  if (!isSupervisorView()) return;
  const item = items.find((entry) => entry.id === itemId);
  if (!item) return;

  const modal = document.querySelector("#escalate-modal");
  const form = document.querySelector("#escalate-form");
  if (!modal || !form) return;

  const suggestion = prefills || getEscalationSuggestion(item);

  const targetMeeting = suggestion?.targetMeeting || item.details?.escalationTargetMeeting || "regional_red";
  const escalationLevelRaw = suggestion?.escalationLevel || item.details?.escalationLevel || "team_lead";
  const escalationLevel = escalationLevelRaw === "senior_leadership" ? "senior_leadership" : "team_lead";
  const meetingDate = suggestion?.nextMeetingDate || item.details?.escalationMeetingDate || activeMeetingWeek;

  form.querySelector("#escalate-item-id").value = item.id;
  form.querySelector("#escalate-target-meeting").value = targetMeeting;
  form.querySelector("#escalate-level").value = escalationLevel;
  form.querySelector("#escalate-meeting-date").value = meetingDate;
  form.querySelector("#escalate-owner").value =
    suggestion?.escalatedTo || item.details?.escalatedTo || item.stakeholders[0] || "";
  form.querySelector("#escalate-reason").value =
    suggestion?.escalationReason || item.details?.escalationReason || "";

  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
}

function closeEscalateModal() {
  const modal = document.querySelector("#escalate-modal");
  const form = document.querySelector("#escalate-form");
  if (!modal || !form) return;

  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  form.reset();
  form.querySelector("#escalate-item-id").value = "";
}

function handleEscalateSubmit(event) {
  event.preventDefault();
  if (!requireSupervisorAccess("Escalation")) return;
  const formData = new FormData(event.currentTarget);

  const itemId = String(formData.get("itemId") || "");
  const targetMeeting = String(formData.get("targetMeeting") || "");
  const escalationLevel = String(formData.get("escalationLevel") || "team_lead");
  const nextMeetingDate = String(formData.get("nextMeetingDate") || "");
  const escalatedTo = String(formData.get("escalatedTo") || "").trim();
  const escalationReason = String(formData.get("escalationReason") || "").trim();

  const item = items.find((entry) => entry.id === itemId);
  if (!item) return;

  if (!targetMeeting || !nextMeetingDate || !escalatedTo || escalationReason.length < 12) {
    showToast("Please complete escalation target, date, owner, and reason.");
    return;
  }

  updateItemStatus(itemId, "escalated");
  item.details = {
    ...item.details,
    escalationLevel,
    escalationTargetMeeting: targetMeeting,
    escalationMeetingDate: nextMeetingDate,
    escalatedTo,
    escalationReason,
  };

  if (!item.stakeholders.includes(escalatedTo)) item.stakeholders.unshift(escalatedTo);

  const escalationText = `${meetingLayerLabel(targetMeeting)} on ${nextMeetingDate}`;
  item.updates.push({
    type: "status_change",
    note: `Escalated to ${escalationText} (owner: ${escalatedTo}). Reason: ${escalationReason}`
  });
  meetingLog.unshift(`${item.id}: Escalated to ${escalationText} and assigned to ${escalatedTo}.`);

  closeEscalateModal();
  refreshAll();
  showToast(`${item.id} escalated`);

  // V2: Generate escalation notification
  addNotification({
    type: "escalate",
    itemId: item.id,
    title: `Challenge escalated to ${meetingLayerLabel(targetMeeting)}`,
    body: `"${item.title}" was escalated by ${item.createdBy}. Owner: ${escalatedTo}. Reason: ${escalationReason}`,
    department: item.department,
  });
}

function updateItemStatus(itemId, status) {
  const item = items.find((entry) => entry.id === itemId);
  if (!item) return;
  item.status = status;
  item.updates.push({ type: "status_change", note: `Status set to ${toLabel(status)}.` });
  if (status === "resolved") item.resolvedAt = todayISO();
}

function requireSupervisorAccess(actionLabel = "This action") {
  if (isSupervisorView()) return true;
  showToast(`${actionLabel} is only available for supervisors.`);
  return false;
}

function handleMeetingAction(action, itemId) {
  const item = items.find((entry) => entry.id === itemId);
  if (!item) return;

  if (action === "edit") {
    openEditItemPrompt(itemId);
    return;
  }

  if (action === "assign") {
    const owner = window.prompt("Assign owner (name):", item.stakeholders[0] || "");
    if (!owner) return;
    const dueDate = window.prompt("Set due date (YYYY-MM-DD):", item.dueDate || "");
    item.status = "assigned";
    item.assignedTo = owner;
    item.dueDate = dueDate || item.dueDate;
    if (!item.stakeholders.includes(owner)) item.stakeholders.unshift(owner);
    item.updates.push({ type: "meeting_note", note: `Assigned to ${owner}.` });
    meetingLog.unshift(`${item.id}: Assigned to ${owner}${item.dueDate ? ` (due ${item.dueDate})` : ""}.`);
    showToast(`${item.id} assigned`);
    addNotification({
      type: "assign",
      itemId: item.id,
      title: `Assigned: ${item.id}`,
      body: `"${item.title}" is assigned to ${owner}${item.dueDate ? ` (due ${item.dueDate})` : ""}.`,
      department: item.department,
    });
  }

  if (action === "escalate") {
    openEscalateModal(itemId);
    return;
  }

  if (action === "quick-escalate") {
    const suggestion = getEscalationSuggestion(item);
    openEscalateModal(itemId, suggestion);
    return;
  }

  if (action === "resolve") {
    if (item.type === "challenge") {
      openResolveWizard(itemId);
      return;
    }
    const resolvedByInput = window.prompt("Resolved by (name):", item.resolvedBy || item.stakeholders[0] || "");
    if (resolvedByInput === null) return;
    const resolvedBy = resolvedByInput.trim();
    if (!resolvedBy) { showToast("Please enter who resolved this item."); return; }
    let solutionText = item.solution || "";
    const entered = window.prompt("Optional: add a solution or learning note:", item.solution || "");
    if (entered !== null) solutionText = entered.trim();
    item.resolvedBy = resolvedBy;
    item.updates.push({ type: "meeting_note", note: `Resolved by ${resolvedBy}.` });
    if (solutionText) { item.solution = solutionText; item.updates.push({ type: "solution_note", note: `Solution documented: ${solutionText}` }); }
    updateItemStatus(itemId, "resolved");
    meetingLog.unshift(`${item.id}: Marked as resolved by ${resolvedBy}${item.solution ? " with documented solution." : "."}`);
    showToast(`${item.id} resolved by ${resolvedBy}`);
    addNotification({ type: "resolve", itemId: item.id, title: `Challenge resolved: ${item.title}`, body: `Resolved by ${resolvedBy}.`, department: item.department });
  }

  if (action === "defer") {
    const deferredWeek = addDaysISO(activeMeetingWeek, 7);
    item.weekStart = deferredWeek;
    updateItemStatus(itemId, "in_discussion");
    meetingLog.unshift(item.id + ": Deferred to next meeting (Monday " + deferredWeek + ").");
    showToast(item.id + " moved to next meeting");
  }

  refreshAll();
}

function registerEvents() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.screen));
  });

  // Left rail collapsible sections (My Focus, Notifications)
  document.querySelectorAll(".left-rail-section-toggle[data-lr-toggle]").forEach(head => {
    head.addEventListener("click", (e) => {
      // Don't toggle if clicking the Open button
      if (e.target.closest(".left-rail-link-btn")) return;
      const section = document.querySelector("#" + head.dataset.lrToggle);
      if (section) section.classList.toggle("is-collapsed");
    });
  });

  // Hero metric tiles — supervisor click to drill down
  document.querySelectorAll(".metric-tile[data-metric-key]").forEach((tile) => {
    tile.addEventListener("click", () => {
      if (!isSupervisorView()) return;
      const ids = tile._metricIds || [];
      const key = tile.dataset.metricKey;
      const title = key === "open" ? "Open Items" : "Overdue Items";
      openAnalyticsPopup(title, ids);
    });
  });

  const leftRail = document.querySelector("#left-rail");
  if (leftRail) {
    const storedCollapsed = localStorage.getItem(LEFT_RAIL_COLLAPSE_KEY) === "1";
    setLeftRailCollapsed(storedCollapsed);

    const toggle = document.querySelector("#left-rail-toggle");
    if (toggle) {
      toggle.addEventListener("click", () => {
        const isCollapsed = document.body.classList.contains("left-rail-collapsed");
        setLeftRailCollapsed(!isCollapsed);
      });
    }

    leftRail.querySelectorAll(".left-rail-nav-btn[data-rail-screen]").forEach((button) => {
      button.addEventListener("click", () => switchTab(button.dataset.railScreen));
    });
  }

  document.querySelector("#new-item-form").addEventListener("submit", handleCreateItem);
  document.querySelector("#item-type").addEventListener("change", updateTypeFields);
  const createDescriptionInput = document.querySelector("#create-description-input");
  if (createDescriptionInput) {
    createDescriptionInput.addEventListener("input", renderCreateDescriptionSuggestions);
  }
  const createTitleInput = document.querySelector('#new-item-form [name="title"]');
  if (createTitleInput) {
    createTitleInput.addEventListener("input", renderCreateDescriptionSuggestions);
  }
  const createStakeholdersInput = document.querySelector('#new-item-form [name="stakeholders"]');
  if (createStakeholdersInput) {
    createStakeholdersInput.addEventListener("input", renderCreateDescriptionSuggestions);
  }
  const createAssignedDeptSelect = document.querySelector("#assign-to-dept");
  if (createAssignedDeptSelect) {
    createAssignedDeptSelect.addEventListener("change", renderCreateDescriptionSuggestions);
  }
  const createSimilarCases = document.querySelector("#create-similar-cases");
  if (createSimilarCases) {
    createSimilarCases.addEventListener("click", (event) => {
      const button = event.target.closest('[data-action="open-create-similar"][data-item-id]');
      if (!button) return;
      openDetailDrawer(button.dataset.itemId);
    });
  }

  const sendRecapButton = document.querySelector("#send-recap-email");
  if (sendRecapButton) sendRecapButton.addEventListener("click", handleSendRecapEmail);

  const autoFillRecipients = document.querySelector("#auto-fill-recipients");
  if (autoFillRecipients) {
    autoFillRecipients.addEventListener("click", () => {
      const toInput = document.querySelector("#recap-email-to");
      if (!toInput) return;
      const { attendees, summaryOnly } = buildRecipientsForWeek(activeMeetingWeek);
      if (!attendees.length) {
        showToast("No agenda-based recipients found for this week.");
        return;
      }
      toInput.value = attendees.join(", ");
      showToast(
        summaryOnly.length
          ? `Filled ${attendees.length} attendee(s). ${summaryOnly.length} will be added as summary-only (CC).`
          : `Filled ${attendees.length} attendee(s).`
      );
    });
  }

  ["#open-dashboard-meeting-link", "#open-meeting-page-link"].forEach((selector) => {
    const button = document.querySelector(selector);
    if (button) button.addEventListener("click", handleOpenMeetingLink);
  });

  ["#view-current-meeting-week", "#view-current-dashboard-week"].forEach((selector) => {
    const button = document.querySelector(selector);
    if (button) button.addEventListener("click", () => switchMeetingWeek("current"));
  });

  ["#view-next-meeting-week", "#view-next-dashboard-week"].forEach((selector) => {
    const button = document.querySelector(selector);
    if (button) button.addEventListener("click", () => switchMeetingWeek("next"));
  });

  const escalateForm = document.querySelector("#escalate-form");
  if (escalateForm) escalateForm.addEventListener("submit", handleEscalateSubmit);

  const escalateModal = document.querySelector("#escalate-modal");
  if (escalateModal) {
    escalateModal.addEventListener("click", (event) => {
      if (event.target === escalateModal) closeEscalateModal();
    });
  }

  const closeEscalateButton = document.querySelector("#close-escalate-modal");
  if (closeEscalateButton) closeEscalateButton.addEventListener("click", closeEscalateModal);

  const cancelEscalateButton = document.querySelector("#cancel-escalate");
  if (cancelEscalateButton) cancelEscalateButton.addEventListener("click", closeEscalateModal);

  const assistantForm = document.querySelector("#assistant-form");
  if (assistantForm) assistantForm.addEventListener("submit", handleAssistantSubmit);

  document.querySelector("#meeting-agenda").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const { action, itemId } = button.dataset;
    if (action === "details") {
      openDetailDrawer(itemId);
      return;
    }
    handleMeetingAction(action, itemId);
  });

  document.querySelector("#dashboard-items").addEventListener("click", (event) => {
    const card = event.target.closest("[data-item-id]");
    if (!card) return;
    openDetailDrawer(card.dataset.itemId);
  });

  const personalPanel = document.querySelector("#left-rail");
  if (personalPanel) {
    personalPanel.addEventListener("click", (event) => {
      const readBtn = event.target.closest("[data-notif-read]");
      if (readBtn) {
        const notifId = String(readBtn.dataset.notifRead || "");
        if (!notifId) return;
        const notifs = loadNotifications().filter((n) => n.id !== notifId);
        saveNotifications(notifs);
        renderRailNotifications();
        showNotificationBanner();
        return;
      }

      const focusButton = event.target.closest(".personal-focus-item[data-item-id]");
      if (focusButton) {
        openDetailDrawer(focusButton.dataset.itemId);
        return;
      }
      const jumpButton = event.target.closest("[data-personal-target]");
      if (jumpButton) {
        if (jumpButton.dataset.personalTarget === "notif-center") {
          if (isSupervisorView()) {
            switchTab("settings");
            const notifSection = document.querySelector("#settings-notifications-list");
            notifSection?.scrollIntoView({ behavior: "smooth", block: "start" });
          } else {
            const notifSection = document.querySelector("#lr-section-notifs");
            if (notifSection) notifSection.classList.remove("is-collapsed");
            notifSection?.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
          return;
        }
        openDashboardDropdown(jumpButton.dataset.personalTarget);
      }
    });
  }

  document.querySelector("#archive-results").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-arc]");
    if (btn) {
      const action = btn.dataset.arc;
      const itemId = btn.dataset.itemId;
      if (action === "detail") { openDetailDrawer(itemId); }
      else if (action === "fav") { toggleFavorite(itemId); }
      else if (action === "edit") { openEditItemPrompt(itemId); }
      else if (action === "assistant") {
        const item = items.find(i => i.id === itemId);
        if (!item) return;
        void runAssistantTurn(`${item.id} ${item.title} ${item.description}`);
        const inp = document.querySelector("#assistant-input");
        if (inp) inp.placeholder = `Follow up on ${item.id}...`;
        showToast(`${item.id} sent to Assistant`);
      }
      return;
    }
    const card = event.target.closest(".archive-card[data-item-id]");
    if (card && !event.target.closest(".archive-card-actions")) openDetailDrawer(card.dataset.itemId);
  });

  // Favorites section click handlers
  const favSection = document.querySelector("#fav-section");
  if (favSection) {
    favSection.addEventListener("click", (e) => {
      const removeBtn = e.target.closest("[data-fav-remove]");
      if (removeBtn) { toggleFavorite(removeBtn.dataset.favRemove); return; }
      const favItem = e.target.closest(".fav-item[data-item-id]");
      if (favItem) openDetailDrawer(favItem.dataset.itemId);
    });
  }
  const favClearBtn = document.querySelector("#fav-clear-btn");
  if (favClearBtn) {
    favClearBtn.addEventListener("click", () => {
      window._favCache = [];
      _saveFavorites();
      renderArchive();
      renderDashFavorites();
      showToast("All favorites cleared");
    });
  }

  const assistantMessages = document.querySelector("#assistant-messages");
  if (assistantMessages) {
    assistantMessages.addEventListener("click", (event) => {
      const button = event.target.closest(".assistant-case-btn[data-item-id]");
      if (!button) return;
      openDetailDrawer(button.dataset.itemId);
    });
  }

  const detailContent = document.querySelector("#detail-content");
  if (detailContent) {
    detailContent.addEventListener("click", (event) => {
      const supervisorOnlyControl = event.target.closest(
        '[data-action="mark-solved-inline"], [data-action="escalate-inline"], [data-action="delete-item"], [data-action="delete-comment"], [data-action="quick-escalate"], [data-action="ignore-recurring-esc"], [data-action="edit-solution"], [data-action="edit-item"], [data-qa]'
      );
      if (supervisorOnlyControl && !requireSupervisorAccess("Edit actions")) return;

      // Inline Solution: Save
      const resolveWizBtn = event.target.closest('[data-action="open-resolve-wizard"]');
      if (resolveWizBtn) {
        openResolveWizard(resolveWizBtn.dataset.itemId);
        return;
      }
      const saveBtn = event.target.closest('[data-action="save-inline-solution"]');
      if (saveBtn) {
        const itemId = saveBtn.dataset.itemId;
        const item = items.find(e => e.id === itemId);
        const textarea = document.querySelector("#inline-sol-text");
        if (item && !canCollaborateOnItem(item)) {
          showToast("Solution updates are not available for this item in sales view.");
          return;
        }
        if (item && textarea) {
          item.solution = textarea.value.trim();
          item.updates.push({ type: "solution_note", note: "Solution updated: " + truncate(item.solution, 60) });
          saveItems();
          showToast("Solution saved");
        }
        return;
      }
      // Inline: Mark Solved
      const solveBtn = event.target.closest('[data-action="mark-solved-inline"]');
      if (solveBtn) {
        const itemId = solveBtn.dataset.itemId;
        const item = items.find(e => e.id === itemId);
        const textarea = document.querySelector("#inline-sol-text");
        if (item && textarea) {
          const sol = textarea.value.trim();
          if (sol.length < 10) { showToast("Please enter a solution first (min 10 chars)"); return; }
          item.solution = sol;
          const who = window.prompt("Resolved by:", getOwnerName(item) || _currentUser());
          if (!who) return;
          item.resolvedBy = who.trim();
          item.resolvedAt = todayISO();
          item.status = "resolved";
          item.updates.push({ type: "solution_note", note: "Resolved by " + who + ": " + truncate(sol, 60) });
          meetingLog.unshift(item.id + ": Marked as resolved by " + who);
          refreshAll();
          openDetailDrawer(itemId);
          showToast(itemId + " resolved");
        }
        return;
      }
      // Inline: Escalate
      const escBtn = event.target.closest('[data-action="escalate-inline"]');
      if (escBtn) {
        openEscalateModal(escBtn.dataset.itemId);
        return;
      }
      // Inline: Add Comment
      const cmtBtn = event.target.closest('[data-action="add-comment"]');
      if (cmtBtn) {
        const itemId = cmtBtn.dataset.itemId;
        const item = items.find(e => e.id === itemId);
        const input = document.querySelector("#cmt-input-" + itemId);
        if (item && !canCommentOnItem(item)) {
          showToast("Comments are not available for this item in sales view.");
          return;
        }
        if (item && input && input.value.trim()) {
          if (!item.comments) item.comments = [];
          item.comments.push({ author: _currentUser(), date: todayISO(), text: input.value.trim() });
          item.updates.push({ type: "feedback", note: "Comment by " + _currentUser() + ": " + truncate(input.value.trim(), 60) });
          saveItems();
          openDetailDrawer(itemId);
          showToast("Comment added");
        }
        return;
      }
      const deleteCommentBtn = event.target.closest('[data-action="delete-comment"][data-item-id][data-comment-index]');
      if (deleteCommentBtn) {
        const itemId = deleteCommentBtn.dataset.itemId;
        const commentIndex = Number(deleteCommentBtn.dataset.commentIndex);
        const item = items.find((entry) => entry.id === itemId);
        if (!item || !Array.isArray(item.comments) || Number.isNaN(commentIndex)) return;
        if (commentIndex < 0 || commentIndex >= item.comments.length) return;
        const [removed] = item.comments.splice(commentIndex, 1);
        item.updates.push({
          type: "feedback",
          note: `Comment removed by ${_currentUser()}${removed?.text ? ": " + truncate(removed.text, 60) : ""}`,
        });
        saveItems();
        openDetailDrawer(itemId);
        showToast("Comment deleted");
        return;
      }

      // V3: Quick Actions Bar
      const qaBtn = event.target.closest("[data-qa]");
      if (qaBtn && qaBtn.dataset.itemId) { handleMeetingAction(qaBtn.dataset.qa, qaBtn.dataset.itemId); return; }
      const editItemBtn = event.target.closest('button[data-action="edit-item"][data-item-id]');
      if (editItemBtn) {
        openEditItemPrompt(editItemBtn.dataset.itemId);
        return;
      }
      // V3: Delete from detail drawer
      const delBtn = event.target.closest('button[data-action="delete-item"][data-item-id]');
      if (delBtn) { deleteArchiveItem(delBtn.dataset.itemId); return; }

      const quickEscalateBtn = event.target.closest('button[data-action="quick-escalate"][data-item-id]');
      if (quickEscalateBtn) {
        const item = items.find((entry) => entry.id === quickEscalateBtn.dataset.itemId);
        if (!item) return;
        const suggestion = getRecurringEscalationSuggestion(item) || getEscalationSuggestion(item);
        openEscalateModal(item.id, suggestion);
        return;
      }

      const ignoreBtn = event.target.closest('button[data-action="ignore-recurring-esc"][data-item-id]');
      if (ignoreBtn) {
        const item = items.find((entry) => entry.id === ignoreBtn.dataset.itemId);
        if (!item) return;
        item.details = item.details || {};
        item.details.recurringEscSuggestionIgnored = true;
        saveItems();
        openDetailDrawer(item.id);
        showToast("Escalation suggestion hidden.");
        return;
      }

      const button = event.target.closest('button[data-action="edit-solution"][data-item-id]');
      if (!button) return;

      const item = items.find((entry) => entry.id === button.dataset.itemId);
      if (!item) return;

      const built = buildSolutionTemplate(item.solutionTemplate || {});
      if (!built) return;
      const solution = built.solutionText.trim();

      if (solution.length < 20) {
        showToast("Please provide specific action steps and context (solution too short).");
        return;
      }

      item.solutionTemplate = built.template;
      item.solution = solution;
      item.updates.push({ type: "solution_note", note: `Solution documented: ${solution}` });
      refreshAll();
      openDetailDrawer(item.id);
      showToast(`${item.id} solution saved`);
    });
  }

  document.querySelector("#close-drawer").addEventListener("click", closeDetailDrawer);
  document.addEventListener(
    "mousedown",
    (event) => {
      const drawer = document.querySelector("#detail-drawer");
      if (!drawer || !drawer.classList.contains("is-open")) return;
      if (event.target.closest("#detail-drawer")) return;
      const activeModal = document.querySelector(".modal.is-open");
      if (activeModal && activeModal.contains(event.target)) return;
      closeDetailDrawer();
    },
    true
  );

  // Feature 1: Meeting Recommendation Modal
  const meetingRecModal = document.querySelector("#meeting-rec-modal");
  if (meetingRecModal) {
    meetingRecModal.addEventListener("click", (e) => {
      if (e.target === meetingRecModal) closeMeetingRecModal();
    });
    meetingRecModal.addEventListener("click", (e) => {
      const applyBtn = e.target.closest("#rec-apply-btn");
      if (applyBtn) {
        const itemId = document.querySelector("#rec-item-id").value;
        const matchedId = document.querySelector("#rec-matched-id").value;
        applyKnowledgeReuse(itemId, matchedId);
        return;
      }
      const skipBtn = e.target.closest("#rec-skip-btn");
      if (skipBtn) { closeMeetingRecModal(); switchTab("dashboard"); return; }
      const closeBtn = e.target.closest("#rec-close-btn");
      if (closeBtn) { closeMeetingRecModal(); switchTab("dashboard"); return; }
      // Feature 2: Expert assign / stakeholder buttons
      const expertBtn = e.target.closest("[data-expert-action]");
      if (expertBtn) {
        if (!requireSupervisorAccess("Expert assignment")) return;
        const { expertAction, itemId: eid, expertName } = expertBtn.dataset;
        const targetItem = items.find((i) => i.id === eid);
        if (!targetItem) return;
        if (expertAction === "assign") {
          targetItem.assignedTo = expertName;
          if (!targetItem.stakeholders.includes(expertName)) targetItem.stakeholders.unshift(expertName);
          showToast(`${expertName} assigned as owner`);
        } else if (expertAction === "stakeholder") {
          if (!targetItem.stakeholders.includes(expertName)) targetItem.stakeholders.push(expertName);
          showToast(`${expertName} added as stakeholder`);
        }
        saveItems();
      }
    });
  }

  // Feature 7: Recurring Alert Modal
  const recurringModal = document.querySelector("#recurring-alert-modal");
  if (recurringModal) {
    recurringModal.addEventListener("click", (e) => {
      if (e.target === recurringModal) closeRecurringModal();
      if (e.target.closest("#recurring-close-btn") || e.target.closest("#recurring-close-btn-2")) closeRecurringModal();
      if (e.target.closest("#recurring-escalate-btn")) handleRecurringEscalate();
    });
  }

  document.querySelector("#detail-content").addEventListener("click", (event) => {
    const levelBtn = event.target.closest(".sim-level-btn[data-sim-level]");
    if (levelBtn) {
      const explorer = levelBtn.closest(".sim-explorer[data-item-id]");
      if (explorer) handleSimilarityLevelClick(levelBtn.dataset.simLevel, explorer.dataset.itemId);
      return;
    }
    // Clicking a result row opens the drawer for that case
    const caseRow = event.target.closest(".sim-case-row[data-item-id]");
    if (caseRow) openDetailDrawer(caseRow.dataset.itemId);
  });

  ["#archive-query", "#archive-type", "#archive-status"].forEach((selector) => {
    document.querySelector(selector).addEventListener("input", renderArchive);
    document.querySelector(selector).addEventListener("change", renderArchive);
  });

  // V2: Archive department filter
  const archiveDeptFilter = document.querySelector("#archive-dept-filter");
  if (archiveDeptFilter) {
    archiveDeptFilter.addEventListener("change", renderArchive);
  }

  // V2: Department filter in hero (Tutor Feedback §5)
  const deptFilter = document.querySelector("#dept-filter");
  if (deptFilter) {
    deptFilter.addEventListener("change", () => {
      activeDeptFilter = deptFilter.value;
      refreshAll();
    });
  }

  // V2: Meeting level filter (Tutor Feedback §6, §7)
  const meetingLevelFilter = document.querySelector("#meeting-level-filter");
  if (meetingLevelFilter) {
    meetingLevelFilter.addEventListener("change", () => {
      activeMeetingLevelFilter = meetingLevelFilter.value;
      refreshAll();
    });
  }

  // Role toggle buttons (replaces old role selector)
  const roleToggle = document.querySelector("#role-toggle");
  const heroToggle = document.querySelector("#role-toggle-hero");
  const roleSelector = document.querySelector("#role-selector");

  function syncRoleToggles(role) {
    [roleToggle, heroToggle].forEach((tog) => {
      if (!tog) return;
      tog.querySelectorAll(".role-toggle-btn").forEach((btn) => {
        btn.classList.toggle("is-active", btn.dataset.role === role);
      });
    });
    if (roleSelector) roleSelector.value = role;
    syncSettingsNavLabel();
  }

  function handleRoleChange(newRole) {
    if (newRole === activeRoleView) return;
    activeRoleView = newRole;
    syncRoleToggles(newRole);
    document.body.classList.toggle("sales-rep-view", newRole === "sales_rep");
    switchTab(newRole === "supervisor" ? "analytics" : "dashboard");
    refreshAll();
    if (!sessionStorage.getItem("ob-role-shown")) {
      sessionStorage.setItem("ob-role-shown", "1");
      openOnboarding(newRole === "supervisor" ? 5 : 0);
    }
  }

  if (roleSelector) {
    activeRoleView = normalizeRoleView(roleSelector.value);
  }
  syncRoleToggles(activeRoleView);

  [roleToggle, heroToggle].forEach((tog) => {
    if (!tog) return;
    tog.addEventListener("click", (e) => {
      const btn = e.target.closest(".role-toggle-btn[data-role]");
      if (!btn) return;
      handleRoleChange(btn.dataset.role);
    });
  });

  const heroObBtn = document.querySelector("#hero-onboarding-btn");
  if (heroObBtn) {
    heroObBtn.addEventListener("click", () => openOnboarding(0));
  }

  // Info tooltips — delegated on document
  document.addEventListener("click", (e) => {
    const ic = e.target.closest(".info-icon");
    if (!ic) {
      // close any open tooltip unless clicking inside it
      if (!e.target.closest(".info-tooltip-bubble")) closeAllTooltips();
      return;
    }
    e.stopPropagation();
    const alreadyOpen = ic.classList.contains("tooltip-open");
    closeAllTooltips();
    if (!alreadyOpen) {
      ic.classList.add("tooltip-open");
      const bubble = ic.querySelector(".info-tooltip-bubble");
      if (bubble) bubble.style.display = "block";
    }
  });

  const userNameInput = document.querySelector('[name="createdBy"]');
  if (userNameInput) {
    userNameInput.addEventListener("input", () => {
      renderMyFocus();
      renderPersonalPanel();
    });
  }

  // V2: Notification dismiss
  const notifDismiss = document.querySelector("#notification-dismiss");
  if (notifDismiss) {
    notifDismiss.addEventListener("click", () => {
      document.querySelector("#notification-banner").style.display = "none";
      // Mark all as read
      const notifs = loadNotifications();
      notifs.forEach((n) => n.read = true);
      saveNotifications(notifs);
    });
  }
}

// ═══ Onboarding Popup ════════════════════════════════════════════════════════

function openOnboarding(startSlide = 0) {
  const overlay = document.querySelector("#ob-overlay");
  if (!overlay) return;
  const slides = overlay.querySelectorAll(".ob-slide");
  const total = slides.length;
  let current = Math.max(0, Math.min(startSlide, total - 1));

  const dotsEl = overlay.querySelector("#ob-dots");
  const prevBtn = overlay.querySelector("#ob-prev");
  const nextBtn = overlay.querySelector("#ob-next");

  function render() {
    slides.forEach((s, i) => s.classList.toggle("is-active", i === current));
    if (dotsEl) {
      dotsEl.innerHTML = Array.from({ length: total }, (_, i) =>
        `<span class="ob-dot${i === current ? " is-active" : ""}"></span>`
      ).join("");
    }
    if (prevBtn) prevBtn.disabled = current === 0;
    if (nextBtn) nextBtn.textContent = current === total - 1 ? "Got it ✓" : "Next →";
  }

  if (prevBtn) {
    const prevClone = prevBtn.cloneNode(true);
    prevBtn.parentNode.replaceChild(prevClone, prevBtn);
    prevClone.addEventListener("click", () => { if (current > 0) { current--; render(); } });
  }
  if (nextBtn) {
    const nextClone = nextBtn.cloneNode(true);
    nextBtn.parentNode.replaceChild(nextClone, nextBtn);
    nextClone.addEventListener("click", () => {
      if (current < total - 1) { current++; render(); }
      else { overlay.classList.remove("is-open"); overlay.setAttribute("aria-hidden", "true"); }
    });
  }

  overlay.querySelector("#ob-close")?.addEventListener("click", () => {
    overlay.classList.remove("is-open"); overlay.setAttribute("aria-hidden", "true");
  }, { once: true });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) { overlay.classList.remove("is-open"); overlay.setAttribute("aria-hidden", "true"); }
  }, { once: true });

  render();
  overlay.classList.add("is-open");
  overlay.setAttribute("aria-hidden", "false");
}

// ═══ Info Tooltips ════════════════════════════════════════════════════════════

function closeAllTooltips() {
  document.querySelectorAll(".info-icon.tooltip-open").forEach((ic) => {
    ic.classList.remove("tooltip-open");
    const b = ic.querySelector(".info-tooltip-bubble");
    if (b) b.style.display = "none";
  });
}

function infoIcon(text, pos = "right") {
  return `<span class="info-icon" data-tip="${escapeHtml(text)}" tabindex="0" role="button" aria-label="More info">
    <span class="info-icon-mark">i</span>
    <span class="info-tooltip-bubble info-tip-${pos}" style="display:none">${escapeHtml(text)}</span>
  </span>`;
}

// ═══ Health / SLA Breakdown Popup ════════════════════════════════════════════

function openHealthBreakdownPopup(breakdown) {
  let popup = document.querySelector("#health-breakdown-popup");
  if (!popup) {
    popup = document.createElement("div");
    popup.id = "health-breakdown-popup";
    popup.className = "modal";
    popup.innerHTML = `
      <div class="modal-card health-popup-card">
        <div class="modal-head">
          <h3 id="hp-title">System Health Score Breakdown</h3>
          <button class="drawer-close" id="health-popup-close">&#x2715;</button>
        </div>
        <div class="health-popup-body" id="health-popup-body"></div>
      </div>`;
    document.body.appendChild(popup);
    popup.querySelector("#health-popup-close").addEventListener("click", () => {
      popup.classList.remove("is-open");
      popup.setAttribute("aria-hidden", "true");
    });
    popup.addEventListener("click", (e) => {
      if (e.target === popup) { popup.classList.remove("is-open"); popup.setAttribute("aria-hidden", "true"); }
    });
  }

  const title = breakdown.title || "System Health Score Breakdown";
  popup.querySelector("#hp-title").textContent = title;

  const overall = breakdown.overall;
  const oc = overall >= 70 ? "#22c55e" : overall >= 40 ? "#f59e0b" : "#ef4444";
  const ol = overall >= 70 ? "Healthy" : overall >= 40 ? "Needs Attention" : "Critical";

  const body = popup.querySelector("#health-popup-body");
  body.innerHTML = `
    <div class="hp-overall">
      <div class="hp-overall-ring">
        <svg viewBox="0 0 100 100" width="90" height="90">
          <circle cx="50" cy="50" r="42" fill="none" stroke="#f0f0f0" stroke-width="8"/>
          <circle cx="50" cy="50" r="42" fill="none" stroke="${oc}" stroke-width="8"
            stroke-dasharray="${Math.round(263.9*overall/100)} 263.9"
            stroke-linecap="round" transform="rotate(-90 50 50)"/>
        </svg>
        <span class="hp-overall-val" style="color:${oc}">${overall}</span>
      </div>
      <div class="hp-overall-info">
        <span class="hp-overall-label" style="color:${oc}">${ol}</span>
        <span class="hp-overall-desc">Average of ${breakdown.components.length} components</span>
      </div>
    </div>
    ${!breakdown.title ? `<div class="hp-formula">Score = ( Resolution Rate + Overdue Score + SLA Compliance + Knowledge Reuse ) ÷ 4</div>` : ""}
    <div class="hp-components">
      ${breakdown.components.map(c => {
        const clr = c.value >= 70 ? "#22c55e" : c.value >= 40 ? "#f59e0b" : "#ef4444";
        return `<div class="hp-comp">
          <div class="hp-comp-head"><span class="hp-comp-label">${c.label}</span><span class="hp-comp-val" style="color:${clr}">${c.value}<small>/${c.max}</small></span></div>
          <div class="hp-comp-track"><div class="hp-comp-fill" style="width:${Math.min(c.max > 0 ? (c.value/c.max)*100 : 0, 100)}%;background:${clr}"></div></div>
          <span class="hp-comp-detail">${c.detail}</span>
        </div>`;
      }).join("")}
    </div>
    <div class="hp-legend">
      <span class="hp-legend-item"><span class="hp-legend-dot" style="background:#22c55e"></span> ≥70 Healthy</span>
      <span class="hp-legend-item"><span class="hp-legend-dot" style="background:#f59e0b"></span> 40–69 Needs Attention</span>
      <span class="hp-legend-item"><span class="hp-legend-dot" style="background:#ef4444"></span> &lt;40 Critical</span>
    </div>
  `;
  popup.classList.add("is-open");
  popup.setAttribute("aria-hidden", "false");
}

// ═══ Resolve Wizard — Multi-Step Modal ═══════════════════════════════════════

function openResolveWizard(itemId) {
  const item = items.find(e => e.id === itemId);
  if (!item) return;

  const modal = document.querySelector("#resolve-wizard-modal");
  if (!modal) return;

  let step = 0;
  const totalSteps = 5;
  const wizardData = {
    knowledgeReused: null,
    reusedCaseIds: "",
    resolvedBy: getOwnerName(item) || _currentUser(),
    rootCause: item.solutionTemplate?.rootCause || "",
    actionSteps: item.solutionTemplate?.actionSteps || "",
    prevention: item.solutionTemplate?.prevention || "",
    solution: item.solution || document.querySelector("#inline-sol-text")?.value || "",
    validatedBy: "",
    reusableTags: item.solutionTemplate?.reusableTags || "",
  };

  function renderStep() {
    const body = modal.querySelector("#rw-body");
    const dots = modal.querySelector("#rw-step-dots");
    const label = modal.querySelector("#rw-step-label");
    const backBtn = modal.querySelector("#rw-back");
    const nextBtn = modal.querySelector("#rw-next");
    const title = modal.querySelector("#resolve-wizard-title");

    dots.innerHTML = Array.from({ length: totalSteps }, (_, i) =>
      `<span class="rw-dot${i === step ? " is-active" : ""}${i < step ? " is-done" : ""}"></span>`
    ).join("");
    label.textContent = `Step ${step + 1} of ${totalSteps}`;
    backBtn.style.display = step === 0 ? "none" : "";
    nextBtn.textContent = step === totalSteps - 1 ? "Resolve ✓" : "Next →";

    if (step === 0) {
      title.textContent = "Knowledge Reuse Check";
      body.innerHTML = `
        <div class="rw-step-content">
          <p class="rw-step-desc">Was this challenge resolved by reusing knowledge from an existing case in the archive?</p>
          <div class="rw-choice-group">
            <button class="rw-choice-btn${wizardData.knowledgeReused === true ? " is-selected" : ""}" data-kr="yes">
              <span class="rw-choice-icon">♻️</span>
              <span class="rw-choice-label">Yes — Knowledge was reused</span>
              <span class="rw-choice-sub">An existing solution helped resolve this case</span>
            </button>
            <button class="rw-choice-btn${wizardData.knowledgeReused === false ? " is-selected" : ""}" data-kr="no">
              <span class="rw-choice-icon">🆕</span>
              <span class="rw-choice-label">No — Fresh resolution</span>
              <span class="rw-choice-sub">This was resolved without reusing past solutions</span>
            </button>
          </div>
        </div>`;
      body.querySelectorAll(".rw-choice-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          wizardData.knowledgeReused = btn.dataset.kr === "yes";
          body.querySelectorAll(".rw-choice-btn").forEach(b => b.classList.remove("is-selected"));
          btn.classList.add("is-selected");
        });
      });
    } else if (step === 1) {
      title.textContent = wizardData.knowledgeReused ? "Reused Case Reference" : "Resolved By";
      if (wizardData.knowledgeReused) {
        body.innerHTML = `
          <div class="rw-step-content">
            <p class="rw-step-desc">Which existing case(s) did you reuse knowledge from? Enter the case ID(s).</p>
            <label class="rw-field-label">Reused Case ID(s)
              <input class="rw-input" id="rw-reuse-ids" value="${escapeHtml(wizardData.reusedCaseIds)}" placeholder="e.g. HJD00012, HJD00045"/>
            </label>
            <p class="rw-hint">Separate multiple IDs with commas. This links the knowledge chain in analytics.</p>
            <label class="rw-field-label" style="margin-top:12px">Resolved by
              <input class="rw-input" id="rw-resolved-by" value="${escapeHtml(wizardData.resolvedBy)}" placeholder="Name of resolver"/>
            </label>
          </div>`;
      } else {
        body.innerHTML = `
          <div class="rw-step-content">
            <p class="rw-step-desc">Who resolved this challenge?</p>
            <label class="rw-field-label">Resolved by
              <input class="rw-input" id="rw-resolved-by" value="${escapeHtml(wizardData.resolvedBy)}" placeholder="Name of resolver"/>
            </label>
          </div>`;
      }
    } else if (step === 2) {
      title.textContent = "Root Cause & Action Steps";
      body.innerHTML = `
        <div class="rw-step-content">
          <p class="rw-step-desc">Document the root cause and the actions taken.</p>
          <label class="rw-field-label">Root Cause Category
            <select class="rw-select" id="rw-root-cause">
              <option value="">-- Select --</option>
              ${["Data","Process","System","People","External partner","Customer","Stock","Pricing","Logistics","Compliance"].map(rc =>
                `<option value="${rc}"${wizardData.rootCause.toLowerCase() === rc.toLowerCase() ? " selected" : ""}>${rc}</option>`
              ).join("")}
            </select>
          </label>
          <label class="rw-field-label">Action Steps Taken
            <textarea class="rw-textarea" id="rw-action-steps" rows="3" placeholder="Describe specific steps taken to resolve...">${escapeHtml(wizardData.actionSteps)}</textarea>
          </label>
          <label class="rw-field-label">Prevention / Standardisation
            <textarea class="rw-textarea" id="rw-prevention" rows="2" placeholder="How to prevent recurrence...">${escapeHtml(wizardData.prevention)}</textarea>
          </label>
        </div>`;
    } else if (step === 3) {
      title.textContent = "Solution Documentation";
      body.innerHTML = `
        <div class="rw-step-content">
          <p class="rw-step-desc">Write the full solution text. This becomes searchable in the archive for future reuse.</p>
          <label class="rw-field-label">Solution
            <textarea class="rw-textarea rw-textarea-lg" id="rw-solution" rows="5" placeholder="Full solution description (min 20 chars)...">${escapeHtml(wizardData.solution)}</textarea>
          </label>
          <label class="rw-field-label">Validated by (optional)
            <input class="rw-input" id="rw-validated-by" value="${escapeHtml(wizardData.validatedBy)}" placeholder="Name or role who verified the solution"/>
          </label>
          <label class="rw-field-label">Reusable Tags
            <input class="rw-input" id="rw-tags" value="${escapeHtml(wizardData.reusableTags)}" placeholder="e.g. pricing, EDI, promo, stock"/>
          </label>
        </div>`;
    } else if (step === 4) {
      title.textContent = "Review & Confirm";
      const reuseLabel = wizardData.knowledgeReused
        ? `<span class="rw-review-reuse-yes">♻️ Knowledge Reused</span> from <strong>${escapeHtml(wizardData.reusedCaseIds || "—")}</strong>`
        : `<span class="rw-review-reuse-no">🆕 Fresh Resolution</span>`;
      body.innerHTML = `
        <div class="rw-step-content">
          <p class="rw-step-desc">Review all details before resolving <strong>${escapeHtml(item.id)}</strong>.</p>
          <div class="rw-review-grid">
            <div class="rw-review-row"><span class="rw-review-label">Knowledge Reuse</span><span class="rw-review-value">${reuseLabel}</span></div>
            <div class="rw-review-row"><span class="rw-review-label">Resolved By</span><span class="rw-review-value">${escapeHtml(wizardData.resolvedBy || "—")}</span></div>
            <div class="rw-review-row"><span class="rw-review-label">Root Cause</span><span class="rw-review-value">${escapeHtml(wizardData.rootCause || "—")}</span></div>
            <div class="rw-review-row"><span class="rw-review-label">Action Steps</span><span class="rw-review-value">${escapeHtml(wizardData.actionSteps || "—")}</span></div>
            <div class="rw-review-row"><span class="rw-review-label">Prevention</span><span class="rw-review-value">${escapeHtml(wizardData.prevention || "—")}</span></div>
            <div class="rw-review-row"><span class="rw-review-label">Solution</span><span class="rw-review-value rw-review-sol">${escapeHtml(wizardData.solution || "—")}</span></div>
            <div class="rw-review-row"><span class="rw-review-label">Tags</span><span class="rw-review-value">${escapeHtml(wizardData.reusableTags || "—")}</span></div>
          </div>
        </div>`;
    }
  }

  function saveStepData() {
    if (step === 1) {
      if (wizardData.knowledgeReused) {
        const reuseInput = modal.querySelector("#rw-reuse-ids");
        if (reuseInput) wizardData.reusedCaseIds = reuseInput.value.trim();
      }
      const resolvedByInput = modal.querySelector("#rw-resolved-by");
      if (resolvedByInput) wizardData.resolvedBy = resolvedByInput.value.trim();
    } else if (step === 2) {
      const rc = modal.querySelector("#rw-root-cause");
      const as = modal.querySelector("#rw-action-steps");
      const pv = modal.querySelector("#rw-prevention");
      if (rc) wizardData.rootCause = rc.value;
      if (as) wizardData.actionSteps = as.value.trim();
      if (pv) wizardData.prevention = pv.value.trim();
    } else if (step === 3) {
      const sol = modal.querySelector("#rw-solution");
      const vb = modal.querySelector("#rw-validated-by");
      const tg = modal.querySelector("#rw-tags");
      if (sol) wizardData.solution = sol.value.trim();
      if (vb) wizardData.validatedBy = vb.value.trim();
      if (tg) wizardData.reusableTags = tg.value.trim();
    }
  }

  function validateStep() {
    if (step === 0 && wizardData.knowledgeReused === null) {
      showToast("Please select whether knowledge was reused.");
      return false;
    }
    if (step === 1 && !wizardData.resolvedBy) {
      showToast("Please enter who resolved this challenge.");
      return false;
    }
    if (step === 1 && wizardData.knowledgeReused && !wizardData.reusedCaseIds) {
      showToast("Please enter the case ID(s) that were reused.");
      return false;
    }
    if (step === 3 && wizardData.solution.length < 20) {
      showToast("Solution must be at least 20 characters.");
      return false;
    }
    return true;
  }

  function finalizeResolve() {
    item.resolvedBy = wizardData.resolvedBy;
    item.resolvedAt = todayISO();
    item.status = "resolved";
    item.solution = wizardData.solution;
    item.meetingNeeded = wizardData.knowledgeReused ? false : item.meetingNeeded;

    item.solutionTemplate = {
      rootCause: wizardData.rootCause,
      actionSteps: wizardData.actionSteps,
      prevention: wizardData.prevention,
      validatedBy: wizardData.validatedBy,
      reusableTags: wizardData.reusableTags,
    };

    if (wizardData.knowledgeReused) {
      item.details = item.details || {};
      item.details.knowledgeReused = true;
      const sourceId = wizardData.reusedCaseIds.split(",")[0].trim();
      item.details.knowledgeReuseSource = sourceId;
      item.details.knowledgeReuseTimestamp = new Date().toISOString();
      if (!item.details.meetingGate) {
        item.details.meetingGate = { matchedItemId: sourceId, similarity: 0.85, appliedAt: todayISO() };
      }
      item.meetingNeeded = false;
      knowledgeReuseCount++;
      localStorage.setItem("red-sync-v1-knowledge-reuse", String(knowledgeReuseCount));
      meetingsAvoidedCount++;
      localStorage.setItem("red-sync-v1-meetings-avoided", String(meetingsAvoidedCount));
      item.updates.push({ type: "meeting_note", note: `Knowledge reuse applied from ${wizardData.reusedCaseIds}. Meeting skipped.` });
    }

    item.updates.push({ type: "solution_note", note: `Resolved by ${wizardData.resolvedBy}: ${truncate(wizardData.solution, 80)}` });
    meetingLog.unshift(`${item.id}: Resolved by ${wizardData.resolvedBy} via resolve wizard.`);

    addNotification({
      type: "resolve",
      itemId: item.id,
      title: `Challenge resolved: ${item.title}`,
      body: `Resolved by ${wizardData.resolvedBy}.${wizardData.knowledgeReused ? ` Knowledge reused from ${wizardData.reusedCaseIds}.` : ""}`,
      department: item.department,
    });

    closeResolveWizard();
    refreshAll();
    openDetailDrawer(item.id);
    showToast(`${item.id} resolved${wizardData.knowledgeReused ? " (knowledge reused)" : ""}`);
  }

  // Wire buttons
  const backBtn = modal.querySelector("#rw-back");
  const nextBtn = modal.querySelector("#rw-next");
  const closeBtn = modal.querySelector("#close-resolve-wizard");

  const backClone = backBtn.cloneNode(true);
  backBtn.parentNode.replaceChild(backClone, backBtn);
  const nextClone = nextBtn.cloneNode(true);
  nextBtn.parentNode.replaceChild(nextClone, nextBtn);
  const closeClone = closeBtn.cloneNode(true);
  closeBtn.parentNode.replaceChild(closeClone, closeBtn);

  backClone.addEventListener("click", () => {
    if (step > 0) { saveStepData(); step--; renderStep(); }
  });
  nextClone.addEventListener("click", () => {
    saveStepData();
    if (!validateStep()) return;
    if (step === totalSteps - 1) { finalizeResolve(); }
    else { step++; renderStep(); }
  });
  closeClone.addEventListener("click", closeResolveWizard);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeResolveWizard(); }, { once: true });

  renderStep();
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
}

function closeResolveWizard() {
  const modal = document.querySelector("#resolve-wizard-modal");
  if (modal) {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
  }
}

function init() {
  meetingWeekView = "current";
  activeMeetingWeek = upcomingMeetingMondayISO();
  normalizeOpenItemsForCurrentWeek();
  registerEvents();
  initDropdowns();
  updateTypeFields();
  seedAssistantThread();
  document.body.classList.toggle("sales-rep-view", activeRoleView === "sales_rep");
  switchTab(isSupervisorView() ? "analytics" : "dashboard");
  refreshAll();
}

init();
