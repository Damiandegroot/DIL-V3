const STORAGE_KEY = "red-sync-v1-items";
const STORAGE_DATASET_VERSION_KEY = "red-sync-v1-dataset-version";
const CURRENT_DATASET_VERSION = "real-data-v2";
const MEETING_LINK_STORAGE_KEY = "red-sync-v1-meeting-link";
const DEFAULT_MEETING_LINK = "";
const MEETING_GATE_SIMILARITY_THRESHOLD = 0.23;
const MEETING_GATE_MIN_SOLUTION_CHARS = 40;
const RULE_ALERT_STORAGE_KEY = "red-sync-v1-rule-alerts";
const KNOWLEDGE_REUSE_THRESHOLD = 0.60;   // Feature 1: meeting decision engine
const RECURRING_WINDOW_DAYS = 60;         // Feature 7: recurring challenge window
const RECURRING_MIN_COUNT = 3;            // Feature 7: minimum recurrences
const LEFT_RAIL_COLLAPSE_KEY = "red-sync-v2-left-rail-collapsed";
const meetingLog = [];
const assistantThread = [];

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

function getAllowedScreensForRole() {
  return isSupervisorView()
    ? ["dashboard", "meeting", "create", "archive", "analytics", "notifications"]
    : ["dashboard", "create", "archive"];
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
  items.forEach((item) => {
    if (item.type !== "challenge") return;
    const rc = (item.solutionTemplate?.rootCause || "").toLowerCase().trim();
    if (rc) {
      counts[rc] = (counts[rc] || 0) + 1;
      return;
    }
    // Infer from corpus keywords
    const corpus = buildItemCorpus(item).toLowerCase();
    for (const [key] of Object.entries(ROOT_CAUSE_LABELS)) {
      if (corpus.includes(key)) {
        counts[key] = (counts[key] || 0) + 1;
        break;
      }
    }
  });
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([key, count]) => ({ label: ROOT_CAUSE_LABELS[key] || toLabel(key), count }));
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

// ── Feature 10: Meeting Efficiency Metrics ────────────────────────────────────

function buildEfficiencyMetrics() {
  const skippedMeetings = items.filter((i) => i.meetingNeeded === false).length;
  const reuseItems = items.filter((i) => i.details?.knowledgeReused).length;
  const total = items.filter((i) => i.type === "challenge").length || 1;
  const reuseRate = Math.round((reuseItems / total) * 100);
  const recurring = items.filter((i) => i.details?.isRecurring).length;
  return {
    skippedMeetings: skippedMeetings + meetingsAvoidedCount,
    reuseItems: reuseItems + knowledgeReuseCount,
    reuseRate,
    recurring,
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

function inferChallengeIntent(query) {
  return /challenge|challnge|chalenge|issue|problem|probleem|problm|recurr|escalat|block|bottleneck|uitdaging|escalatie|blokkade|vertraging|pricing|price|stock|delivery|service|oos|stockout|dc|depot/i.test(
    query
  );
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
  }));
}

function isActionableAssistantAnswer(text, query) {
  const value = String(text || "");
  if (!value) return false;
  if (!inferChallengeIntent(query || "")) return value.length > 0;
  const lowered = value.toLowerCase();
  const hasActionsSection =
    lowered.includes("recommended actions") || lowered.includes("aanbevolen acties");
  const hasParallelsSection =
    lowered.includes("historical") || lowered.includes("historische") || lowered.includes("relevant");
  const hasNumberedSteps = /\n1\.\s.+/m.test(value) && /\n2\.\s.+/m.test(value);
  const genericNoise = /libraries organize|in various industries|across industries|general best practice/i.test(
    value
  );
  return hasActionsSection && hasParallelsSection && hasNumberedSteps && !genericNoise;
}

async function askLLMForAssistantAnswer(query, matches) {
  if (!ASSISTANT_LLM_CONFIG.enabled) return null;

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), ASSISTANT_LLM_CONFIG.timeoutMs);
  const roleLabel = assistantRoleLabel();
  const challengeIntent = inferChallengeIntent(query || "");

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
  const challengeIntent = inferChallengeIntent(query || "");
  const archivePool = getArchiveFilteredItems({ useQuery: false });
  const matches = findSimilarCases(query, ASSISTANT_LLM_CONFIG.contextCaseLimit, archivePool);
  const fallback = buildAssistantFallbackAdvice(matches.slice(0, ASSISTANT_LLM_CONFIG.uiMatchLimit));
  const caseLinks = buildAssistantCaseLinks(matches, 3);

  const llmAnswer = await askLLMForAssistantAnswer(query, matches);
  const useLlmAnswer = isActionableAssistantAnswer(llmAnswer, query);
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
    text: "Hey! I am your smart archive assistant. Tell me your challenge and I will find similar cases and practical next steps.",
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
      "Agenda for " + (meetingWeekView === "next" ? "next" : "current") + " RED IN-SYNCC meeting";
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
  document.querySelector("#metric-open").textContent = String(openItems.length);
  document.querySelector("#metric-overdue").textContent = String(overdue);

  const kpis = [
    { label: "New", value: getStatusCount("new") },
    { label: "Assigned", value: getStatusCount("assigned") },
    { label: "Escalated", value: getStatusCount("escalated") },
    { label: "Resolved", value: getStatusCount("resolved") },
  ];

  const kpiGrid = document.querySelector("#kpi-grid");
  kpiGrid.innerHTML = "";
  kpis.forEach((kpi, idx) => {
    const card = document.createElement("article");
    card.className = "kpi-card";
    card.style.setProperty("--delay", `${idx * 0.06}s`);
    card.innerHTML = `<h3>${kpi.label}</h3><p>${kpi.value}</p>`;
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
  renderDashNotifications();
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

function renderPersonalPanel() {
  const panel = document.querySelector("#left-rail");
  if (!panel) return;

  const user = _currentUser();
  const roleLabel = isSupervisorView() ? "Supervisor" : "Sales Representative";
  const relevant = items.filter((item) => item.createdBy === user || item.assignedTo === user || item.stakeholders?.includes(user));
  const openItems = relevant.filter((item) => isOpenStatus(item.status));
  const resolvedItems = relevant.filter((item) => item.status === "resolved" || item.status === "closed");
  const likesGiven = items.filter((item) => (item.type === "celebration" || item.type === "contribution") && uniqueList(item.likedBy || []).includes(user)).length;
  const deptCandidates = uniqueList(relevant.map((item) => item.department));
  const deptLabel = activeDeptFilter !== "all" ? activeDeptFilter : (deptCandidates[0] || "Cross-functional");
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

function _currentUser() { const el = document.querySelector('[name="createdBy"]'); return (el?.value || "Name Employer").trim(); }

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

function renderDashNotifications() {
  const el = document.querySelector("#dash-notif-items"); if (!el) return;
  const notifs = loadNotifications().slice(0, 8);
  _setBadge("badge-notif-center", notifs.filter(n => !n.read).length);
  if (!notifs.length) { el.innerHTML = '<p class="dash-empty">No notifications yet.</p>'; return; }
  const im = {assign:"\uD83D\uDCCB",escalate:"\u26A1",resolve:"\u2705",overdue:"\u23F0",info:"\u2139\uFE0F"};
  el.innerHTML = notifs.map(n => `<div class="notif-mini"><span class="notif-mini-icon">${im[n.type]||"\uD83D\uDCCC"}</span><div class="notif-mini-body"><strong>${escapeHtml(n.title)}</strong><p>${escapeHtml(n.body)}</p></div><span class="notif-mini-time">${getTimeAgo(n.timestamp)}</span></div>`).join("");
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
      const quickEscalateBtn = canManage && escalationSuggestion
        ? `<button class="mini-btn mini-btn-warn" data-action="quick-escalate" data-item-id="${item.id}">Quick Escalate</button>`
        : "";
      const actionsHTML = canManage
        ? `
          <button class="mini-btn" data-action="assign" data-item-id="${item.id}">Assign</button>
          <button class="mini-btn" data-action="escalate" data-item-id="${item.id}">Escalate</button>
          ${quickEscalateBtn}
          <button class="mini-btn" data-action="resolve" data-item-id="${item.id}">Resolve</button>
          <button class="mini-btn" data-action="defer" data-item-id="${item.id}">Defer to next week</button>
          <button class="mini-btn" data-action="details" data-item-id="${item.id}">Details</button>
        `
        : `<button class="mini-btn" data-action="details" data-item-id="${item.id}">Details</button>`;

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
  const icon = diffMs < 0 ? "&#x1F534;" : diffDays <= 2 ? "&#x1F7E1;" : "&#x1F7E2;";
  const pct = Math.max(0, Math.min(100, diffMs < 0 ? 100 : (1 - diffDays / 21) * 100));
  return `<div class="sla-timer ${cls}"><div class="sla-icon">${icon}</div><div class="sla-info"><strong>${label}</strong><span>Due: ${item.dueDate}</span></div><div class="sla-bar-wrap"><div class="sla-bar" style="width:${pct}%"></div></div></div>`;
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

// ═══ V3 Benchmark: SLA Countdown Timer (Jira SM) ════════════════════════
function buildSLATimerHTML(item) {
  if (!item.dueDate || !isOpenStatus(item.status)) return "";
  const now = new Date(), due = new Date(item.dueDate + "T23:59:59");
  const diffMs = due - now, diffDays = Math.ceil(diffMs / 864e5);
  let cls, label;
  if (diffMs < 0) { cls = "sla-breached"; label = `BREACHED ${Math.abs(diffDays)}d ago`; }
  else if (diffDays <= 2) { cls = "sla-warning"; label = diffDays === 0 ? "Due TODAY" : `${diffDays}d remaining`; }
  else { cls = "sla-ok"; label = `${diffDays}d remaining`; }
  const icon = diffMs < 0 ? "&#x1F534;" : diffDays <= 2 ? "&#x1F7E1;" : "&#x1F7E2;";
  const pct = Math.max(0, Math.min(100, diffMs < 0 ? 100 : (1 - diffDays / 21) * 100));
  return `<div class="sla-timer ${cls}"><div class="sla-icon">${icon}</div><div class="sla-info"><strong>${label}</strong><span>Due: ${item.dueDate}</span></div><div class="sla-bar-wrap"><div class="sla-bar" style="width:${pct}%"></div></div></div>`;
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

function openDetailDrawer(itemId) {
  const item = items.find((entry) => entry.id === itemId);
  if (!item) return;
  const canManage = isSupervisorView();

  const solutionText = item.solution && item.solution.trim().length > 0 ? item.solution : "Not documented yet";
  const solutionActionHTML =
    canManage && item.type === "challenge" && item.status === "resolved"
      ? `<p><button type="button" class="mini-btn" data-action="edit-solution" data-item-id="${item.id}">Add or Edit Solution</button></p>`
      : "";
  const resolvedMeta =
    item.status === "resolved" || item.status === "closed"
      ? `<p><strong>Resolved by:</strong> ${item.resolvedBy || "Not recorded"}${item.resolvedAt ? ` on ${item.resolvedAt}` : ""}</p>`
      : "";
  const escalationMeta = item.details?.escalationTargetMeeting
    ? `<p><strong>Escalated to meeting:</strong> ${meetingLayerLabel(item.details.escalationTargetMeeting)}${
        item.details?.escalationMeetingDate ? ` on ${item.details.escalationMeetingDate}` : ""
      }</p>`
    : "";
  const escalationOwnerMeta = item.details?.escalatedTo
    ? `<p><strong>Escalated to:</strong> ${item.details.escalatedTo}</p>`
    : "";
  const escalationReasonMeta = item.details?.escalationReason
    ? `<p><strong>Escalation reason:</strong> ${item.details.escalationReason}</p>`
    : "";

  const meetingGateMeta = item.details?.meetingGate?.matchedItemId
    ? `<p><strong>Meeting gate:</strong> matched ${item.details.meetingGate.matchedItemId} (${Math.round(
        (item.details.meetingGate.similarity || 0) * 100
      )}%). ${item.meetingNeeded === false ? "Meeting skipped" : "Kept for meeting"}.</p>`
    : "";

  const solutionTemplateMeta = item.solutionTemplate
    ? `
      <div class="solution-template">
        <h4>Solution template</h4>
        ${item.solutionTemplate.rootCause ? `<p><strong>Root cause:</strong> ${item.solutionTemplate.rootCause}</p>` : ""}
        ${item.solutionTemplate.actionSteps ? `<p><strong>Action steps:</strong> ${item.solutionTemplate.actionSteps}</p>` : ""}
        ${item.solutionTemplate.prevention ? `<p><strong>Prevention:</strong> ${item.solutionTemplate.prevention}</p>` : ""}
        ${item.solutionTemplate.validatedBy ? `<p><strong>Validated by:</strong> ${item.solutionTemplate.validatedBy}</p>` : ""}
        ${item.solutionTemplate.reusableTags ? `<p><strong>Tags:</strong> ${item.solutionTemplate.reusableTags}</p>` : ""}
      </div>
    `
    : "";

  const meetingNeededMeta =
    item.meetingNeeded === false
      ? `<p><strong>Meeting needed:</strong> No (handled via meeting gate / owner follow-up)</p>`
      : `<p><strong>Meeting needed:</strong> Yes</p>`;

  const escalationSuggestion = getEscalationSuggestion(item);
  const recurringEscSuggestion = item.type === "challenge" ? getRecurringEscalationSuggestion(item) : null;
  const escalationSuggestionMeta = escalationSuggestion
    ? `<p><strong>Rule trigger:</strong> overdue + high priority. Consider escalation.</p>
       ${canManage ? `<p><button type="button" class="mini-btn" data-action="quick-escalate" data-item-id="${item.id}">Open escalation with suggested values</button></p>` : ""}`
    : "";
  const recurringEscMeta = recurringEscSuggestion
    ? `<div class="recurring-esc-alert">
        <strong>⚠ Escalation Suggestion</strong>
        <p>${escapeHtml(recurringEscSuggestion.reason)}</p>
        <p><em>${escapeHtml(recurringEscSuggestion.ruleLabel)}</em></p>
        ${canManage ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
          <button type="button" class="btn-primary" style="font-size:0.82rem;padding:7px 14px" data-action="quick-escalate" data-item-id="${item.id}">Escalate</button>
          <button type="button" class="mini-btn" data-action="ignore-recurring-esc" data-item-id="${item.id}">Ignore suggestion</button>
        </div>` : ""}
       </div>`
    : "";

  const similarityExplorerHTML = item.type === "challenge" ? renderSimilarityExplorer(item) : "";

  // V2: Department assignment + email button
  const deptEmail = item.assignedToDept ? (DEPARTMENT_EMAILS[item.assignedToDept] || "") : "";
  const mailSubj = item.assignedToDept ? encodeURIComponent(`[${item.id}] ${item.title}`) : "";
  const mailBody = item.assignedToDept ? encodeURIComponent(
    `Hi ${item.assignedToDept} team,\n\nChallenge details:\n\nItem: ${item.id}\nTitle: ${item.title}\nDepartment: ${item.department}\nPriority: ${item.priority}\nStatus: ${toLabel(item.status)}\nDue: ${item.dueDate || "Not set"}\nCreated by: ${item.createdBy} (${item.createdAt})\n\nDescription:\n${item.description}\n\nStakeholders: ${item.stakeholders.join(", ") || "None"}${item.solution ? "\n\nSolution:\n" + item.solution : ""}\n\n---\nSent from RED in-SYNCC`
  ) : "";
  const deptAssignMeta = item.assignedToDept
    ? `<p><strong>Assigned to support department:</strong> ${item.assignedToDept}</p>
       ${deptEmail ? `<div class="dept-email-row"><span class="dept-email-badge">${deptEmail}</span><a href="mailto:${deptEmail}?subject=${mailSubj}&body=${mailBody}" class="dept-email-btn">&#x2709; Send Email to ${item.assignedToDept}</a></div>` : ""}`
    : "";

  const externalEmailMeta = item.externalEmail
    ? `<p><strong>External contact:</strong> ${item.externalEmail} (responds via email)</p>` : "";

  const hierarchyHTML = buildHierarchyHTML(item.meetingLevel || "team_weekly");
  const statusWorkflowHTML = buildStatusWorkflowHTML(item.status);

  // V3 Benchmark: SLA Timer
  const slaHTML = buildSLATimerHTML(item);

  // V3 Benchmark: Quick Actions Bar
  const quickActionsHTML = canManage && isOpenStatus(item.status) ? `<div class="quick-actions-bar">
    ${item.status === "new" ? `<button class="qa-btn qa-assign" data-qa="assign" data-item-id="${item.id}">&#x1F464; Assign</button>` : ""}
    ${item.status !== "escalated" ? `<button class="qa-btn qa-escalate" data-qa="escalate" data-item-id="${item.id}">&#x26A1; Escalate</button>` : ""}
    <button class="qa-btn qa-resolve" data-qa="resolve" data-item-id="${item.id}">&#x2705; Resolve</button>
    <button class="qa-btn qa-defer" data-qa="defer" data-item-id="${item.id}">&#x23ED; Defer</button>
  </div>` : "";

  const solutionEditorHTML = canManage
    ? `<div class="inline-sol">
      <h4>&#x1F4DD; Solution</h4>
      <textarea class="inline-sol-area" id="inline-sol-text" data-item-id="${item.id}" placeholder="Enter solution...">${escapeHtml(item.solution || "")}</textarea>
      <div class="inline-sol-actions">
        <button class="btn-primary" style="font-size:0.82rem;padding:7px 14px" data-action="save-inline-solution" data-item-id="${item.id}">&#x2705; Save Solution</button>
        ${isOpenStatus(item.status) && item.type === "challenge" ? `<button class="qa-btn qa-resolve" data-action="mark-solved-inline" data-item-id="${item.id}">&#x2705; Mark Solved</button>` : ""}
        ${item.status !== "escalated" && isOpenStatus(item.status) ? `<button class="qa-btn qa-escalate" data-action="escalate-inline" data-item-id="${item.id}">&#x26A1; Escalate to Next Meeting</button>` : ""}
      </div>
    </div>`
    : `<div class="inline-sol">
      <h4>&#x1F4DD; Solution</h4>
      <p>${escapeHtml(solutionText)}</p>
    </div>`;
  const commentInputHTML = canManage
    ? `<div class="cmt-input-row">
        <input class="cmt-input" id="cmt-input-${item.id}" placeholder="Add a comment..." />
        <button class="btn-primary" style="font-size:0.82rem;padding:7px 14px" data-action="add-comment" data-item-id="${item.id}">Post</button>
      </div>`
    : `<p class="dash-empty" style="text-align:left;padding:8px 0 0">Commenting is available for supervisors.</p>`;

  // V3 Benchmark: Activity Timeline
  const timelineHTML = buildActivityTimeline(item);

  // Known Error Tag
  const rootCauseTag = item.solutionTemplate?.rootCause ? `<span class="known-error-tag">&#x1F3F7; Known Error: ${escapeHtml(item.solutionTemplate.rootCause)}</span>` : "";

  const detail = document.querySelector("#detail-content");
  detail.innerHTML = `
    <h3>${item.id} &middot; ${item.title}</h3>
    <div class="item-meta">
      <span class="chip chip-type-${item.type}">${toLabel(item.type)}</span>
      <span class="chip chip-status">${toLabel(item.status)}</span>
      <span class="chip chip-priority-${item.priority}">${toLabel(item.priority)}</span>
      ${item.assignedToDept ? `<span class="chip chip-assigned-dept">&rarr; ${item.assignedToDept}</span>` : ""}
      ${item.meetingLevel ? `<span class="chip chip-meeting-level">${meetingLayerLabel(item.meetingLevel).replace(/ Meeting.*/, "")}</span>` : ""}
      ${rootCauseTag}
    </div>
    ${slaHTML}
    ${quickActionsHTML}
    ${statusWorkflowHTML}
    <p>${item.description}</p>
    <p><strong>Department:</strong> ${item.department}</p>
    ${deptAssignMeta}
    ${externalEmailMeta}
    <p><strong>Created by:</strong> ${item.createdBy} (${item.createdAt})</p>
    <p><strong>Due date:</strong> ${item.dueDate || "Not set"}</p>
    <p><strong>Owner:</strong> ${getOwnerName(item) || "Unassigned"}</p>
    ${meetingNeededMeta}
    ${meetingGateMeta}
    <p><strong>Stakeholders:</strong> ${item.stakeholders.join(", ") || "None listed"}</p>
    ${escalationMeta}
    ${escalationOwnerMeta}
    ${escalationReasonMeta}
    ${escalationSuggestionMeta}
    ${recurringEscMeta}
    ${solutionTemplateMeta}
    ${resolvedMeta}

    ${solutionEditorHTML}
    ${solutionActionHTML}

    <div class="inline-comments">
      <h4>&#x1F4AC; Comments</h4>
      <div class="cmt-list" id="cmt-list-${item.id}">
        ${(item.comments || []).map(c => `<div class="cmt-item"><div class="cmt-head"><span class="cmt-author">${escapeHtml(c.author)}</span><span class="cmt-date">${c.date}</span></div><p class="cmt-text">${escapeHtml(c.text)}</p></div>`).join("") || '<p class="dash-empty">No comments yet.</p>'}
      </div>
      ${commentInputHTML}
    </div>

    <h4>Meeting Level Hierarchy</h4>
    ${hierarchyHTML}
    <h4>Activity Timeline</h4>
    ${timelineHTML}
    ${similarityExplorerHTML}
    ${canManage ? `<div class="drawer-delete-zone">
      <button type="button" class="drawer-delete-btn" data-action="delete-item" data-item-id="${item.id}">Delete this item</button>
    </div>` : ""}
  `;

  const drawer = document.querySelector("#detail-drawer");
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
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
  const supervisor = isSupervisorView();
  const roleSelector = document.querySelector("#role-selector");
  if (roleSelector && roleSelector.value !== activeRoleView) roleSelector.value = activeRoleView;

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

  const note = document.querySelector("#role-permission-note");
  if (note) {
    note.textContent = supervisor
      ? "Supervisor mode: full access and editing enabled."
      : "Sales representative mode: dashboard + create + archive (read-only).";
  }

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
  form.querySelector('[name="createdBy"]').value = "Name Employer";
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

// ── Feature 8 & 9 & 10: Analytics Dashboard Rendering ────────────────────────

function renderAnalyticsDashboard() {
  const container = document.querySelector("#screen-analytics");
  if (!container) return;

  const metrics = buildEfficiencyMetrics();
  const rootCauses = buildRootCauseAnalytics();
  const clusters = buildChallengeClusters();
  const maxRc = rootCauses[0]?.count || 1;
  const maxCl = clusters[0]?.count || 1;

  // V2: Department breakdown
  const deptCounts = {};
  items.filter((i) => i.type === "challenge").forEach((item) => {
    deptCounts[item.department] = (deptCounts[item.department] || 0) + 1;
  });
  const deptBreakdown = Object.entries(deptCounts).sort((a, b) => b[1] - a[1]);
  const maxDept = deptBreakdown[0]?.[1] || 1;

  // V2: Meeting level distribution
  const levelCounts = {};
  items.filter((i) => i.type === "challenge" && isOpenStatus(i.status)).forEach((item) => {
    const lvl = item.meetingLevel || "team_weekly";
    levelCounts[lvl] = (levelCounts[lvl] || 0) + 1;
  });

  // V2: Assignment department stats
  const assignDeptCounts = {};
  items.filter((i) => i.assignedToDept).forEach((item) => {
    assignDeptCounts[item.assignedToDept] = (assignDeptCounts[item.assignedToDept] || 0) + 1;
  });
  const assignDeptBreakdown = Object.entries(assignDeptCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxAssign = assignDeptBreakdown[0]?.[1] || 1;

  // V2: Supervisor-only note
  const accessNote = isSupervisorView()
    ? '<p style="color:var(--coke-red-dark);font-weight:600;font-size:0.82rem;margin:0 0 10px">🔒 Supervisor view — full metrics visible</p>'
    : '<p style="color:var(--ink-soft);font-weight:500;font-size:0.82rem;margin:0 0 10px">📊 Sales representative view — read-only analytics summary</p>';

  container.innerHTML = `
    ${accessNote}
    <!-- Feature 10: Efficiency Metrics -->
    <div class="panel">
      <div class="panel-header">
        <h2>Meeting Efficiency Metrics</h2>
        <p>Impact of knowledge reuse on meeting load this period</p>
      </div>
      <div class="kpi-grid" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        <article class="kpi-card analytics-kpi">
          <h3>Meetings Avoided</h3>
          <p class="kpi-big">${metrics.skippedMeetings}</p>
          <small>via knowledge reuse</small>
        </article>
        <article class="kpi-card analytics-kpi">
          <h3>Items Solved Without Meeting</h3>
          <p class="kpi-big">${metrics.reuseItems}</p>
          <small>knowledge reuse applied</small>
        </article>
        <article class="kpi-card analytics-kpi">
          <h3>Knowledge Reuse Rate</h3>
          <p class="kpi-big">${metrics.reuseRate}%</p>
          <small>of all challenges</small>
        </article>
        <article class="kpi-card analytics-kpi">
          <h3>Recurring Challenges</h3>
          <p class="kpi-big">${metrics.recurring}</p>
          <small>flagged as recurring</small>
        </article>
      </div>
    </div>

    <!-- V2: Meeting Level Distribution -->
    <div class="panel">
      <div class="panel-header">
        <h2>Meeting Level Distribution</h2>
        <p>Open challenges by escalation meeting level</p>
      </div>
      <div class="kpi-grid" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        ${MEETING_HIERARCHY.map(({ key, label, time }) => `
          <article class="kpi-card analytics-kpi">
            <h3>${label.replace(" Meeting", "")}</h3>
            <p class="kpi-big">${levelCounts[key] || 0}</p>
            <small>${time}</small>
          </article>`).join("")}
      </div>
    </div>

    <!-- V2: Department Assignment Overview (Tutor Feedback §3) -->
    <div class="panel">
      <div class="panel-header">
        <h2>Department Assignment Overview</h2>
        <p>Challenges assigned to back-office and support departments via group email</p>
      </div>
      <div class="analytics-bar-list">
        ${assignDeptBreakdown.length ? assignDeptBreakdown.map(([dept, count]) => `
          <div class="analytics-bar-row">
            <span class="analytics-bar-label">${escapeHtml(dept)}</span>
            <div class="analytics-bar-track">
              <div class="analytics-bar-fill" style="width:${Math.round((count / maxAssign) * 100)}%"></div>
            </div>
            <span class="analytics-bar-count">${count}</span>
          </div>`).join("") : '<p class="sim-empty">No department assignments yet.</p>'}
      </div>
    </div>

    <!-- Feature 8: Root Cause Analytics -->
    <div class="panel">
      <div class="panel-header">
        <h2>Top Root Causes</h2>
        <p>Organisational learning — what keeps coming back</p>
      </div>
      <div class="analytics-bar-list">
        ${rootCauses.length ? rootCauses.map(({ label, count }) => `
          <div class="analytics-bar-row">
            <span class="analytics-bar-label">${escapeHtml(label)}</span>
            <div class="analytics-bar-track">
              <div class="analytics-bar-fill" style="width:${Math.round((count / maxRc) * 100)}%"></div>
            </div>
            <span class="analytics-bar-count">${count}</span>
          </div>`).join("") : '<p class="sim-empty">No root cause data yet. Resolve challenges with the solution template to populate this.</p>'}
      </div>
    </div>

    <!-- V2: Department Breakdown -->
    <div class="panel">
      <div class="panel-header">
        <h2>Challenges by Originating Department</h2>
        <p>Where challenges are being raised</p>
      </div>
      <div class="analytics-bar-list">
        ${deptBreakdown.map(([dept, count]) => `
          <div class="analytics-bar-row">
            <span class="analytics-bar-label">${escapeHtml(dept)}</span>
            <div class="analytics-bar-track">
              <div class="analytics-bar-fill" style="width:${Math.round((count / maxDept) * 100)}%"></div>
            </div>
            <span class="analytics-bar-count">${count}</span>
          </div>`).join("")}
      </div>
    </div>

    <!-- Feature 9: Challenge Clusters -->
    <div class="panel">
      <div class="panel-header">
        <h2>Challenge Clusters</h2>
        <p>Grouped by operational category</p>
      </div>
      <div class="cluster-grid">
        ${clusters.map(({ label, count, items: clusterItems }) => `
          <div class="cluster-card">
            <div class="cluster-label">${escapeHtml(label)}</div>
            <div class="cluster-count">${count}</div>
            <div class="cluster-bar-wrap">
              <div class="cluster-bar" style="width:${Math.round((count / maxCl) * 100)}%"></div>
            </div>
            <div class="cluster-ids">${clusterItems.slice(0, 4).map((id) => `<span class="cluster-id-chip">${id}</span>`).join("")}${clusterItems.length > 4 ? `<span class="cluster-id-chip">+${clusterItems.length - 4}</span>` : ""}</div>
          </div>`).join("")}
      </div>
    </div>

    <!-- V2: Improvements Overview Table (Tutor Feedback §4 Notes) -->
    <div class="panel">
      <div class="panel-header">
        <h2>V2 Improvements Overview</h2>
        <p>Summary of system improvements based on feedback</p>
      </div>
      <table class="improvements-table">
        <thead>
          <tr>
            <th>Area</th>
            <th>Improvement</th>
            <th>Status</th>
            <th>Priority</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Challenge Assignment</td>
            <td>Department-based dropdown with group email notifications (replaces free text)</td>
            <td>✅ Implemented</td>
            <td><span class="improvement-badge high">High</span></td>
          </tr>
          <tr>
            <td>Department Filtering</td>
            <td>Weekly view filtered by own department; archive shows all departments</td>
            <td>✅ Implemented</td>
            <td><span class="improvement-badge high">High</span></td>
          </tr>
          <tr>
            <td>Meeting Hierarchy</td>
            <td>4-level escalation: Senior Manager → Associate Director → Director → Leadership</td>
            <td>✅ Implemented</td>
            <td><span class="improvement-badge high">High</span></td>
          </tr>
          <tr>
            <td>Notification System</td>
            <td>Jira-style notifications for assignments, escalations, and overdue items</td>
            <td>✅ Implemented</td>
            <td><span class="improvement-badge medium">Medium</span></td>
          </tr>
          <tr>
            <td>Status Workflow</td>
            <td>Visual status pipeline: New → Assigned → In Discussion → Escalated → Resolved</td>
            <td>✅ Implemented</td>
            <td><span class="improvement-badge medium">Medium</span></td>
          </tr>
          <tr>
            <td>Role-Based Views</td>
            <td>All Participants view vs. Supervisor view for different access levels</td>
            <td>✅ Implemented</td>
            <td><span class="improvement-badge medium">Medium</span></td>
          </tr>
          <tr>
            <td>External Involvement</td>
            <td>Invite people outside the system via email; submitter updates status</td>
            <td>✅ Implemented</td>
            <td><span class="improvement-badge low">Low</span></td>
          </tr>
          <tr>
            <td>Metrics Dashboard</td>
            <td>Meetings avoided, knowledge reuse rate, department breakdown, meeting level distribution</td>
            <td>✅ Implemented</td>
            <td><span class="improvement-badge medium">Medium</span></td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
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

// ═══ V2: Render Notifications Screen (Tutor Feedback §1 Notes) ══════════

function renderNotifications() {
  const container = document.querySelector("#notifications-list");
  if (!container) return;

  const notifs = loadNotifications();
  if (!notifs.length) {
    container.innerHTML = '<p style="color:var(--ink-soft);font-weight:500">No notifications yet. Notifications appear when challenges are assigned to departments, escalated, or resolved.</p>';
    return;
  }

  container.innerHTML = notifs.map((notif) => {
    const iconClass = notif.type || "info";
    const iconEmoji = { assign: "📋", escalate: "⬆️", resolve: "✅", overdue: "⏰", info: "ℹ️" }[iconClass] || "📌";
    const timeAgo = getTimeAgo(notif.timestamp);
    return `
      <div class="notif-item ${notif.read ? "" : "unread"}" data-notif-id="${notif.id}">
        <div class="notif-icon ${iconClass}">${iconEmoji}</div>
        <div class="notif-body">
          <h4>${escapeHtml(notif.title)}</h4>
          <p>${escapeHtml(notif.body)}</p>
          ${notif.itemId ? `<p class="notif-meta">Item: ${notif.itemId}${notif.department ? " · " + notif.department : ""}</p>` : ""}
        </div>
        <div class="notif-actions">
          <span class="notif-time">${timeAgo}</span>
        </div>
      </div>`;
  }).join("");

  // Mark as read
  notifs.forEach((n) => n.read = true);
  saveNotifications(notifs);
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
  renderNotifications();
  showNotificationBanner();
  applyRolePermissions();
  saveItems();
}

function updateTypeFields() {
  const type = document.querySelector("#item-type").value;
  document.querySelector("#challenge-fields").classList.toggle("is-hidden", type !== "challenge");
  document.querySelector("#contribution-fields").classList.toggle("is-hidden", type !== "contribution");
  document.querySelector("#celebration-fields").classList.toggle("is-hidden", type !== "celebration");
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
  if (!requireSupervisorAccess("Meeting actions")) return;
  const item = items.find((entry) => entry.id === itemId);
  if (!item) return;

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
    const resolvedByInput = window.prompt(
      "Resolved by (name):",
      item.resolvedBy || item.stakeholders[0] || ""
    );
    if (resolvedByInput === null) return;
    const resolvedBy = resolvedByInput.trim();
    if (!resolvedBy) {
      showToast("Please enter who resolved this item.");
      return;
    }

    let solutionText = item.solution || "";

    if (item.type === "challenge") {
      const built = buildSolutionTemplate(item.solutionTemplate || {});
      if (!built) return;
      solutionText = built.solutionText.trim();
      if (solutionText.length < 20) {
        showToast("Please provide specific action steps and context (solution too short).");
        return;
      }
      item.solutionTemplate = built.template;
    } else {
      const entered = window.prompt("Optional: add a solution or learning note:", item.solution || "");
      if (entered !== null) solutionText = entered.trim();
    }

    item.resolvedBy = resolvedBy;
    item.updates.push({ type: "meeting_note", note: `Resolved by ${resolvedBy}.` });

    if (solutionText) {
      item.solution = solutionText;
      item.updates.push({ type: "solution_note", note: `Solution documented: ${solutionText}` });
    }

    updateItemStatus(itemId, "resolved");
    meetingLog.unshift(
      `${item.id}: Marked as resolved by ${resolvedBy}${item.solution ? " with documented solution." : "."}`
    );
    showToast(`${item.id} resolved by ${resolvedBy}`);

    // V2: Generate resolution notification (Tutor Feedback §4)
    addNotification({
      type: "resolve",
      itemId: item.id,
      title: `Challenge resolved: ${item.title}`,
      body: `Resolved by ${resolvedBy}. ${item.assignedToDept ? `Originally assigned to ${item.assignedToDept} department.` : ""} The submitter has updated the status.`,
      department: item.department,
    });
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
      const focusButton = event.target.closest(".personal-focus-item[data-item-id]");
      if (focusButton) {
        openDetailDrawer(focusButton.dataset.itemId);
        return;
      }
      const jumpButton = event.target.closest("[data-personal-target]");
      if (jumpButton) {
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
        '[data-action="save-inline-solution"], [data-action="mark-solved-inline"], [data-action="escalate-inline"], [data-action="add-comment"], [data-action="delete-item"], [data-action="quick-escalate"], [data-action="ignore-recurring-esc"], [data-action="edit-solution"], [data-qa]'
      );
      if (supervisorOnlyControl && !requireSupervisorAccess("Edit actions")) return;

      // Inline Solution: Save
      const saveBtn = event.target.closest('[data-action="save-inline-solution"]');
      if (saveBtn) {
        const itemId = saveBtn.dataset.itemId;
        const item = items.find(e => e.id === itemId);
        const textarea = document.querySelector("#inline-sol-text");
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

      // V3: Quick Actions Bar
      const qaBtn = event.target.closest("[data-qa]");
      if (qaBtn && qaBtn.dataset.itemId) { handleMeetingAction(qaBtn.dataset.qa, qaBtn.dataset.itemId); return; }
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
        showToast("Escalation suggestion ignored.");
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

  // Analytics tab
  const analyticsTab = document.querySelector("[data-screen='analytics']");
  if (analyticsTab) analyticsTab.addEventListener("click", renderAnalyticsDashboard);
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

  // V2: Role selector (Tutor Feedback §1)
  const roleSelector = document.querySelector("#role-selector");
  if (roleSelector) {
    activeRoleView = normalizeRoleView(roleSelector.value);
    roleSelector.value = activeRoleView;
    roleSelector.addEventListener("change", () => {
      activeRoleView = normalizeRoleView(roleSelector.value);
      roleSelector.value = activeRoleView;
      refreshAll();
    });
  }

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

function init() {
  meetingWeekView = "current";
  activeMeetingWeek = upcomingMeetingMondayISO();
  normalizeOpenItemsForCurrentWeek();
  registerEvents();
  initDropdowns();
  updateTypeFields();
  seedAssistantThread();
  switchTab("dashboard");
  refreshAll();
}

init();
