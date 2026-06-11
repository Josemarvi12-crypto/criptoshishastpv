const STORAGE_KEY = "criptoshishas-tpv-v2";
const LEGACY_STORAGE_KEY = "criptoshishas-tpv-v1";
const SESSION_KEY = "criptoshishas-session";

const STATUS = {
  preparation: "preparation",
  paid: "paid",
};

const PAYMENT = {
  cash: "cash",
  card: "card",
};

const PRODUCT = {
  hookah: "hookah",
  vape: "vape",
};

const ROLES = {
  manager: "manager",
  employee: "employee",
};

const defaults = {
  locations: ["Local 1 - Lepe", "Local 2 - Lepe", "Local 3 - Lepe"],
  locationSettings: {
    "Local 1 - Lepe": { hookahRecommendedPrice: 10, vapeRecommendedPrice: 10, commission: 0 },
    "Local 2 - Lepe": { hookahRecommendedPrice: 15, vapeRecommendedPrice: 10, commission: 0 },
    "Local 3 - Lepe": { hookahRecommendedPrice: 10, vapeRecommendedPrice: 10, commission: 0 },
  },
  flavors: ["Dos manzanas", "Menta", "Love 66", "Blue mist", "Sandia ice", "Uva menta"],
  vapers: [
    { id: "vaper-default-1", name: "Vaper mango ice", price: 10, stock: 8 },
    { id: "vaper-default-2", name: "Vaper fresa", price: 10, stock: 8 },
  ],
  orders: [],
  timeEntries: [],
  users: [],
  session: {
    seller: "Jose",
    location: "Local 1 - Lepe",
  },
};

let authEventsBound = false;
let appEventsBound = false;
let firebaseSyncReady = false;
let firebaseUnsubscribers = [];
let firebaseSyncTimer = null;
let state = loadState();
ensureStateIntegrity();
let currentUser = null;
let priceMode = "recommended";
let selectedFlavors = [];
let selectedHookahs = [];
let selectedVapers = [];
let productType = PRODUCT.hookah;
let quickPaymentMethod = "";

// ===== SINCRONIZACIÓN CON FIRESTORE =====
async function syncFirestoreData() {
  if (!window.FirebaseService) {
    console.warn("Firebase no disponible; se usará únicamente el almacenamiento local.");
    setSyncStatus("Datos locales");
    return;
  }

  try {
    setSyncStatus("Conectando...");
    const [remoteOrders, remoteUsers, remoteTimeEntries, config] = await Promise.all([
      FirebaseService.getAllOrders(),
      FirebaseService.getAllUsers(),
      FirebaseService.getAllTimeEntries(),
      FirebaseService.getConfig("app-state"),
    ]);

    state.orders = mergeInitialCloudData(remoteOrders, state.orders);
    state.users = normalizeUsers(remoteUsers);
    state.timeEntries = mergeInitialCloudData(remoteTimeEntries, state.timeEntries);

    if (config?.locations?.length) {
      state.locations = config.locations;
      state.locationSettings = config.locationSettings || state.locationSettings;
      state.flavors = config.flavors || state.flavors;
      state.vapers = config.vapers || state.vapers;
    }

    state = normalizeState(state);
    firebaseSyncReady = true;
    refreshCurrentUser();
    persistLocalState();
    await syncCurrentStateToFirestore();
    subscribeToFirestore();
    setSyncStatus("Sincronizado");
    if (currentUser) renderAll();
  } catch (error) {
    console.error("No se pudo iniciar la sincronización con Firestore:", error);
    setSyncStatus(error?.code === "permission-denied" ? "Firebase sin acceso" : "Datos locales");
  }
}

function mergeInitialCloudData(remoteData, localData) {
  const merged = new Map();
  (Array.isArray(localData) ? localData : []).forEach((item) => merged.set(item.id, item));
  (Array.isArray(remoteData) ? remoteData : []).forEach((item) => merged.set(item.id, item));
  return [...merged.values()];
}

function subscribeToFirestore() {
  const onError = (error) => {
    console.error("Se perdió la conexión en tiempo real con Firestore:", error);
    setSyncStatus(error?.code === "permission-denied" ? "Firebase sin acceso" : "Sin conexión");
  };
  firebaseUnsubscribers.forEach((unsubscribe) => unsubscribe());
  firebaseUnsubscribers = [
    FirebaseService.onOrdersChanged((orders) => applyRemoteCollection("orders", orders), onError),
    FirebaseService.onUsersChanged((users) => applyRemoteCollection("users", normalizeUsers(users)), onError),
    FirebaseService.onTimeEntriesChanged((entries) => applyRemoteCollection("timeEntries", entries), onError),
    FirebaseService.onConfigChanged("app-state", applyRemoteConfig, onError),
  ];
}

function applyRemoteCollection(key, values) {
  if (!firebaseSyncReady) return;
  state[key] = values;
  state = normalizeState(state);
  refreshCurrentUser();
  persistLocalState();
  if (currentUser) renderAll();
}

function applyRemoteConfig(config) {
  if (!firebaseSyncReady || !config?.locations?.length) return;
  state.locations = config.locations;
  state.locationSettings = config.locationSettings || state.locationSettings;
  state.flavors = config.flavors || state.flavors;
  state.vapers = config.vapers || state.vapers;
  state = normalizeState(state);
  persistLocalState();
  if (currentUser) renderAll();
}

function refreshCurrentUser() {
  if (!currentUser) return;
  const remoteUser = state.users.find((user) => user.id === currentUser.id && user.active);
  if (!remoteUser) {
    logout();
    return;
  }
  currentUser = { ...remoteUser };
  delete currentUser.password;
  saveSession();
}

function scheduleFirestoreSync() {
  if (!firebaseSyncReady || !window.FirebaseService) return;
  clearTimeout(firebaseSyncTimer);
  firebaseSyncTimer = setTimeout(() => {
    syncCurrentStateToFirestore().catch((error) => {
      console.error("No se pudieron guardar los cambios en Firestore:", error);
    });
  }, 250);
}

async function syncCurrentStateToFirestore() {
  const writes = [
    ...state.orders.map((order) => FirebaseService.saveOrder(order.id, order)),
    ...state.timeEntries.map((entry) => FirebaseService.saveTimeEntry(entry.id, entry)),
  ];

  if (isManager()) {
    writes.push(...state.users.map((user) => FirebaseService.saveUser(user.id, user)));
    writes.push(FirebaseService.saveConfig("app-state", {
      locations: state.locations,
      locationSettings: state.locationSettings,
      flavors: state.flavors,
      vapers: state.vapers,
      updatedAt: new Date().toISOString(),
    }));
  }
  await Promise.all(writes);
}

function deleteRemoteRecord(methodName, id) {
  if (!firebaseSyncReady || !window.FirebaseService?.[methodName]) return;
  FirebaseService[methodName](id).catch((error) => {
    console.error(`No se pudo completar ${methodName} en Firestore:`, error);
  });
}

function setSyncStatus(message) {
  if (elements?.syncStatus) elements.syncStatus.textContent = message;
}

const elements = {
  loginScreen: document.querySelector("#loginScreen"),
  loginForm: document.querySelector("#loginForm"),
  loginPassword: document.querySelector("#loginPassword"),
  loginError: document.querySelector("#loginError"),
  appShell: document.querySelector("#appShell"),
  sidebarToggle: document.querySelector("#sidebarToggle"),
  userInfo: document.querySelector("#userInfo"),
  syncStatus: document.querySelector("#syncStatus"),
  currentUserName: document.querySelector("#currentUserName"),
  currentUserRole: document.querySelector("#currentUserRole"),
  logoutBtn: document.querySelector("#logoutBtn"),
  userManagementSection: document.querySelector("#userManagementSection"),
  createUserForm: document.querySelector("#createUserForm"),
  newUserName: document.querySelector("#newUserName"),
  newUserRole: document.querySelector("#newUserRole"),
  usersTable: document.querySelector("#usersTable"),
  navTabs: document.querySelectorAll(".nav-tab"),
  views: document.querySelectorAll(".view"),
  viewTitle: document.querySelector("#viewTitle"),
  todayLabel: document.querySelector("#todayLabel"),
  locationSelect: document.querySelector("#locationSelect"),
  todayOpenOrders: document.querySelector("#todayOpenOrders"),
  todayRevenue: document.querySelector("#todayRevenue"),
  todayCardRevenue: document.querySelector("#todayCardRevenue"),
  todayCashRevenue: document.querySelector("#todayCashRevenue"),
  todayVapeRevenue: document.querySelector("#todayVapeRevenue"),
  todayHookahRevenue: document.querySelector("#todayHookahRevenue"),
  orderForm: document.querySelector("#orderForm"),
  orderTitle: document.querySelector("#orderTitle"),
  productTypeButtons: document.querySelectorAll("[data-product-type]"),
  hookahFields: document.querySelector("#hookahFields"),
  vapeFields: document.querySelector("#vapeFields"),
  vapeProductSelect: document.querySelector("#vapeProductSelect"),
  quickPaymentButtons: document.querySelectorAll("[data-payment-option]"),
  priceField: document.querySelector("#priceField"),
  quickPriceButtons: document.querySelector("#quickPriceButtons"),
  priceOptionButtons: document.querySelectorAll("[data-price-option]"),
  recommendedPriceLabel: document.querySelector("#recommendedPriceLabel"),
  flavorInput: document.querySelector("#flavorInput"),
  addFlavorBtn: document.querySelector("#addFlavorBtn"),
  selectedFlavors: document.querySelector("#selectedFlavors"),
  flavorTotal: document.querySelector("#flavorTotal"),
  addHookahItemBtn: document.querySelector("#addHookahItemBtn"),
  hookahItems: document.querySelector("#hookahItems"),
  addVaperItemBtn: document.querySelector("#addVaperItemBtn"),
  vaperItems: document.querySelector("#vaperItems"),
  priceInput: document.querySelector("#priceInput"),
  otherPriceWrap: document.querySelector("#otherPriceWrap"),
  customerField: document.querySelector("#customerField"),
  customerInput: document.querySelector("#customerInput"),
  customerOptions: document.querySelector("#customerOptions"),
  notesInput: document.querySelector("#notesInput"),
  saveOrderBtn: document.querySelector("#saveOrderBtn"),
  lastOrderBox: document.querySelector("#lastOrderBox"),

  preparingCount: document.querySelector("#preparingCount"),
  paidCount: document.querySelector("#paidCount"),
  preparingOrders: document.querySelector("#preparingOrders"),
  paidOrders: document.querySelector("#paidOrders"),
  historyDateFrom: document.querySelector("#historyDateFrom"),
  historyDateTo: document.querySelector("#historyDateTo"),
  historyLocation: document.querySelector("#historyLocation"),
  historyCategory: document.querySelector("#historyCategory"),
  historyPayment: document.querySelector("#historyPayment"),
  historyStatus: document.querySelector("#historyStatus"),
  historyTable: document.querySelector("#historyTable"),
  exportBtn: document.querySelector("#exportBtn"),
  dashboardDateFrom: document.querySelector("#dashboardDateFrom"),
  dashboardDateTo: document.querySelector("#dashboardDateTo"),
  dashboardLocation: document.querySelector("#dashboardLocation"),
  dashboardSeller: document.querySelector("#dashboardSeller"),
  dashboardCategory: document.querySelector("#dashboardCategory"),
  dashboardPayment: document.querySelector("#dashboardPayment"),
  dashboardRangeButtons: document.querySelectorAll("[data-dashboard-range]"),
  dashboardRevenue: document.querySelector("#dashboardRevenue"),
  dashboardRevenueMeta: document.querySelector("#dashboardRevenueMeta"),
  dashboardUnits: document.querySelector("#dashboardUnits"),
  dashboardUnitsMeta: document.querySelector("#dashboardUnitsMeta"),
  dashboardAverageTicket: document.querySelector("#dashboardAverageTicket"),
  dashboardCardRevenue: document.querySelector("#dashboardCardRevenue"),
  dashboardCardMeta: document.querySelector("#dashboardCardMeta"),
  dashboardCashRevenue: document.querySelector("#dashboardCashRevenue"),
  dashboardCashMeta: document.querySelector("#dashboardCashMeta"),
  dashboardPending: document.querySelector("#dashboardPending"),
  dashboardPendingMeta: document.querySelector("#dashboardPendingMeta"),
  dashboardPeriodLabel: document.querySelector("#dashboardPeriodLabel"),
  dashboardTrend: document.querySelector("#dashboardTrend"),
  dashboardCategoryDonut: document.querySelector("#dashboardCategoryDonut"),
  dashboardCategoryTotal: document.querySelector("#dashboardCategoryTotal"),
  dashboardCategoryLegend: document.querySelector("#dashboardCategoryLegend"),
  dashboardPaymentDonut: document.querySelector("#dashboardPaymentDonut"),
  dashboardPaymentTotal: document.querySelector("#dashboardPaymentTotal"),
  dashboardPaymentLegend: document.querySelector("#dashboardPaymentLegend"),
  dashboardCategoryTable: document.querySelector("#dashboardCategoryTable"),
  dashboardProductRanking: document.querySelector("#dashboardProductRanking"),
  locationReport: document.querySelector("#locationReport"),
  sellerReport: document.querySelector("#sellerReport"),
  customerReport: document.querySelector("#customerReport"),  timeclockDate: document.querySelector("#timeclockDate"),
  timeclockWeek: document.querySelector("#timeclockWeek"),
  timeclockMonth: document.querySelector("#timeclockMonth"),
  timeclockHistoryPanel: document.querySelector("#timeclockHistoryPanel"),
  timeclockDayHeader: document.querySelector("#timeclockDayHeader"),
  timeclockMonthPanel: document.querySelector("#timeclockMonthPanel"),
  timeclockTableWrap: document.querySelector("#timeclockTableWrap"),
  timeclockActionsHeader: document.querySelector("#timeclockActionsHeader"),
  clockStatus: document.querySelector("#clockStatus"),
  clockInBtn: document.querySelector("#clockInBtn"),
  clockOutBtn: document.querySelector("#clockOutBtn"),
  manualHoursForm: document.querySelector("#manualHoursForm"),
  manualHoursDate: document.querySelector("#manualHoursDate"),
  manualUserSelect: document.querySelector("#manualUserSelect"),
  manualLocationSelect: document.querySelector("#manualLocationSelect"),
  manualStartTime: document.querySelector("#manualStartTime"),
  manualEndTime: document.querySelector("#manualEndTime"),
  manualHoursNote: document.querySelector("#manualHoursNote"),
  timeclockSummary: document.querySelector("#timeclockSummary"),
  timeclockWeekSummary: document.querySelector("#timeclockWeekSummary"),
  timeclockMonthSummary: document.querySelector("#timeclockMonthSummary"),
  timeclockTable: document.querySelector("#timeclockTable"),
  employeeTimesheetPanel: document.querySelector("#employeeTimesheetPanel"),
  timesheetFilterForm: document.querySelector("#timesheetFilterForm"),
  timesheetUserSelect: document.querySelector("#timesheetUserSelect"),
  timesheetMonth: document.querySelector("#timesheetMonth"),
  timesheetOverview: document.querySelector("#timesheetOverview"),
  timesheetTable: document.querySelector("#timesheetTable"),
  exportTimesheetBtn: document.querySelector("#exportTimesheetBtn"),
  locationForm: document.querySelector("#locationForm"),
  newLocationInput: document.querySelector("#newLocationInput"),
  locationList: document.querySelector("#locationList"),
  flavorForm: document.querySelector("#flavorForm"),
  newFlavorInput: document.querySelector("#newFlavorInput"),
  flavorList: document.querySelector("#flavorList"),
  vaperForm: document.querySelector("#vaperForm"),
  newVaperNameInput: document.querySelector("#newVaperNameInput"),
  newVaperStockInput: document.querySelector("#newVaperStockInput"),
  vaperStockList: document.querySelector("#vaperStockList"),
  downloadMenuBtn: document.querySelector("#downloadMenuBtn"),
  clearDemoBtn: document.querySelector("#clearDemoBtn"),
};

init();

if (window.FirebaseService) {
  FirebaseService.onAuthStateChanged(async (firebaseUser) => {
    if (!firebaseUser) {
      currentUser = null;
      localStorage.removeItem(SESSION_KEY);
      showLoginScreen();
      setSyncStatus("Sin sesión");
      return;
    }

    try {
      const profile = await FirebaseService.getUser(firebaseUser.uid);
      if (!profile?.active) {
        elements.loginError.textContent = profile ? "Usuario desactivado" : "Usuario sin perfil";
        await FirebaseService.logout();
        return;
      }

      currentUser = normalizeUsers([profile])[0];
      saveSession();
      startAuthenticatedApp();
      if (!firebaseSyncReady) await syncFirestoreData();
    } catch (error) {
      console.error("No se pudo cargar el perfil del usuario:", error);
      elements.loginError.textContent = "No se pudo conectar con la base de datos";
      showLoginScreen();
    }
  });
}

function init() {
  showLoginScreen();
  bindAuthEvents();
}

function bindAuthEvents() {
  if (authEventsBound) return;
  authEventsBound = true;
  elements.loginForm.addEventListener("submit", handleLogin);
}

async function handleLogin(event) {
  event.preventDefault();
  const code = elements.loginPassword.value.trim();
  elements.loginError.textContent = "";
  const submitButton = elements.loginForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "Conectando...";

  const result = await FirebaseService.loginWithCode(code);
  if (!result.success) {
    elements.loginError.textContent = "Código incorrecto";
    submitButton.disabled = false;
    submitButton.textContent = "Iniciar sesión";
  }
}

async function logout() {
  firebaseUnsubscribers.forEach((unsubscribe) => unsubscribe());
  firebaseUnsubscribers = [];
  firebaseSyncReady = false;
  currentUser = null;
  localStorage.removeItem(SESSION_KEY);
  if (window.FirebaseService) await FirebaseService.logout();
  showLoginScreen();
}

function showLoginScreen() {
  elements.loginScreen.classList.remove("hidden");
  elements.appShell.style.display = "none";
  elements.loginPassword.value = "";
  const submitButton = elements.loginForm.querySelector('button[type="submit"]');
  submitButton.disabled = false;
  submitButton.textContent = "Iniciar sesión";
  bindAuthEvents();
}

function startAuthenticatedApp() {
  syncSessionWithCurrentUser();
  elements.loginScreen.classList.add("hidden");
  elements.appShell.style.display = "grid";
  configureNavigation();
  switchView("pos");
  setSidebarCollapsed(window.matchMedia("(max-width: 640px)").matches);
  renderUserInfo();
  elements.todayLabel.textContent = formatLongDate(new Date());
  elements.historyDateFrom.value = toDateInputValue(new Date());
  elements.historyDateTo.value = toDateInputValue(new Date());
  const dashboardNow = new Date();
  elements.dashboardDateFrom.value = toDateInputValue(new Date(dashboardNow.getFullYear(), dashboardNow.getMonth(), 1));
  elements.dashboardDateTo.value = toDateInputValue(dashboardNow);
  elements.timeclockDate.value = toDateInputValue(new Date());
  elements.manualHoursDate.value = toDateInputValue(new Date());
  elements.timeclockWeek.value = getWeekInputValue(new Date());
  elements.timeclockMonth.value = toDateInputValue(new Date()).slice(0, 7);
  elements.timesheetMonth.value = toDateInputValue(new Date()).slice(0, 7);
  bindEvents();
  renderAll();
}

function ensureStateIntegrity() {
  const normalized = normalizeState(state);
  state = normalized;
  saveState();
}

function syncSessionWithCurrentUser() {
  if (!currentUser) return;

  state.session.seller = currentUser.name;
  saveState();
}

function isManager() {
  return currentUser?.role === ROLES.manager;
}

function isEmployee() {
  return currentUser?.role === ROLES.employee;
}

function canManageTeam() {
  return isManager();
}

function canViewFullTimeclock() {
  return isManager();
}

function canAccessView(viewName) {
  if (isEmployee()) return ["pos", "history", "timeclock"].includes(viewName);
  return isManager();
}

function configureNavigation() {
  elements.appShell.classList.toggle("employee-mode", isEmployee());
  elements.navTabs.forEach((tab) => {
    tab.style.display = canAccessView(tab.dataset.view) ? "block" : "none";
  });
  elements.historyDateFrom.disabled = isEmployee();
  elements.historyDateTo.disabled = isEmployee();
  elements.historyLocation.disabled = isEmployee();
  elements.exportBtn.style.display = isEmployee() ? "none" : "inline-flex";
}

function getActiveUserNames() {
  return state.users
    .filter((user) => user.active)
    .map((user) => user.name)
    .filter(Boolean);
}
function saveSession() {
  if (currentUser) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(currentUser));
  }
}

function loadSession() {
  const saved = localStorage.getItem(SESSION_KEY);
  if (!saved) return null;

  try {
    const sessionUser = JSON.parse(saved);
    const activeUser = state.users.find((user) => user.id === sessionUser.id && user.active);
    if (!activeUser) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }

    const refreshedUser = { ...activeUser };
    delete refreshedUser.password;
    return refreshedUser;
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

function renderUserInfo() {
  elements.currentUserName.textContent = currentUser.name;
  elements.currentUserRole.textContent = getRoleLabel(currentUser.role);
  elements.currentUserRole.className = `role-badge ${currentUser.role}`;
  elements.userManagementSection.style.display = isManager() ? "block" : "none";
}

function getRoleLabel(role) {
  const roleLabels = { manager: "Gerente", employee: "Empleado" };
  return roleLabels[role] || role;
}

async function handleCreateUser(event) {
  event.preventDefault();
  if (!isManager()) return;

  const name = elements.newUserName.value.trim();
  const role = elements.newUserRole.value;

  if (!name) return;
  if (state.users.some((u) => normalizeName(u.name) === normalizeName(name))) {
    alert("Este nombre ya está registrado");
    return;
  }
  let code = "";
  let accountResult = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    code = generateUniqueUserCode(name);
    accountResult = await FirebaseService.createUserWithCode(code);
    if (accountResult.success) break;
    if (accountResult.error !== "auth/email-already-in-use") break;
  }

  if (!accountResult?.success) {
    console.error("No se pudo crear la cuenta Firebase:", accountResult?.error);
    alert("No se ha podido crear el usuario online.");
    return;
  }

  const user = {
    id: accountResult.uid,
    name,
    role,
    active: true,
    createdAt: new Date().toISOString(),
  };

  await FirebaseService.saveUser(user.id, user);
  state.users.push(user);
  persistLocalState();
  elements.newUserName.value = "";
  elements.newUserRole.value = "employee";
  renderSettings();
  alert(`Usuario creado. Código de acceso: ${code}`);
}

function renderUserManagement() {
  elements.usersTable.innerHTML = state.users
    .map(
      (user) => `
    <tr>
      <td class="user-name-cell" data-label="Nombre">
        <strong>${escapeHtml(user.name)}</strong>
        <span class="role-badge ${user.role}">${escapeHtml(getRoleLabel(user.role))}</span>
      </td>
      <td data-label="Perfil">
        <select data-user-role="${escapeHtml(user.id)}" ${user.id === currentUser.id ? "disabled" : ""}>
          <option value="employee" ${user.role === ROLES.employee ? "selected" : ""}>Empleado</option>
          <option value="manager" ${user.role === ROLES.manager ? "selected" : ""}>Gerente</option>
        </select>
      </td>
      <td data-label="Acceso">Código privado</td>
      <td data-label="Estado">${user.active ? "Activo" : "Inactivo"}</td>
      <td class="table-actions" data-label="Acciones">
        ${
          user.id === currentUser.id
            ? `<span class="empty-hint">Sesión actual</span>`
            : `<button class="inline-action" type="button" data-toggle-user="${escapeHtml(user.id)}">${user.active ? "Desactivar" : "Activar"}</button>
               <button class="delete-sale" type="button" data-delete-user="${escapeHtml(user.id)}">Borrar</button>`
        }
      </td>
    </tr>
  `,
    )
    .join("");

  elements.usersTable.querySelectorAll("[data-user-role]").forEach((select) => {
    select.addEventListener("change", () => updateUserRole(select.dataset.userRole, select.value));
  });

  elements.usersTable.querySelectorAll("[data-toggle-user]").forEach((button) => {
    button.addEventListener("click", () => toggleUserActive(button.dataset.toggleUser));
  });

  elements.usersTable.querySelectorAll("[data-delete-user]").forEach((button) => {
    button.addEventListener("click", () => deleteUser(button.dataset.deleteUser));
  });
}

function updateUserRole(userId, role) {
  if (!isManager() || userId === currentUser.id) return;
  const normalizedRole = normalizeRole(role);
  state.users = state.users.map((user) =>
    user.id === userId ? { ...user, role: normalizedRole } : user,
  );
  saveState();
  renderUserManagement();
}

function toggleUserActive(userId) {
  if (!isManager() || userId === currentUser.id) return;
  state.users = state.users.map((user) =>
    user.id === userId ? { ...user, active: !user.active } : user,
  );
  saveState();
  renderUserManagement();
}

function deleteUser(userId) {
  if (!isManager() || userId === currentUser.id) return;
  if (!confirm("Seguro que quieres eliminar este usuario?")) return;
  state.users = state.users.filter((user) => user.id !== userId);
  deleteRemoteRecord("deleteUser", userId);
  saveState();
  renderUserManagement();
}
function setSidebarCollapsed(collapsed) {
  elements.appShell.classList.toggle("sidebar-collapsed", collapsed);
  elements.sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  elements.sidebarToggle.setAttribute("aria-label", collapsed ? "Abrir menú" : "Cerrar menú");
}

function toggleSidebar() {
  setSidebarCollapsed(!elements.appShell.classList.contains("sidebar-collapsed"));
}

function bindEvents() {
  if (appEventsBound) return;
  appEventsBound = true;

  elements.navTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      switchView(tab.dataset.view);
      if (window.matchMedia("(max-width: 640px)").matches) setSidebarCollapsed(true);
    });
  });

  [
    elements.dashboardDateFrom,
    elements.dashboardDateTo,
    elements.dashboardLocation,
    elements.dashboardSeller,
    elements.dashboardCategory,
    elements.dashboardPayment,
  ].forEach((control) => control.addEventListener("change", renderStats));

  elements.dashboardRangeButtons.forEach((button) => {
    button.addEventListener("click", () => setDashboardRange(button.dataset.dashboardRange));
  });

  [elements.dashboardCategoryLegend, elements.dashboardPaymentLegend].forEach((legend) => {
    legend.addEventListener("click", (event) => {
      const button = event.target.closest("[data-dashboard-filter]");
      if (!button) return;
      const select = button.dataset.dashboardFilter === "category"
        ? elements.dashboardCategory
        : elements.dashboardPayment;
      select.value = select.value === button.dataset.value ? "all" : button.dataset.value;
      renderStats();
    });
  });

  elements.sidebarToggle.addEventListener("click", toggleSidebar);
  elements.logoutBtn.addEventListener("click", logout);

  elements.locationSelect.addEventListener("change", (event) => {
    state.session.location = event.target.value;
    saveState();
    applyRecommendedPrice();
    renderAll();
  });

  elements.productTypeButtons.forEach((button) => {
    button.addEventListener("click", () => selectProductType(button.dataset.productType));
  });

  elements.quickPaymentButtons.forEach((button) => {
    button.addEventListener("click", () => selectQuickPayment(button.dataset.paymentOption));
  });
  elements.vapeProductSelect.addEventListener("change", syncSelectedVaperPrice);

  elements.priceOptionButtons.forEach((button) => {
    button.addEventListener("click", () => selectPriceOption(button.dataset.priceOption));
  });

  elements.priceInput.addEventListener("input", () => {
    priceMode = "other";
    renderPriceControls();
  });
  elements.addFlavorBtn.addEventListener("click", addSelectedFlavor);
  elements.addHookahItemBtn.addEventListener("click", addSelectedHookahItem);
  elements.addVaperItemBtn.addEventListener("click", addSelectedVaperItem);
  elements.flavorInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addSelectedFlavor();
    }
  });
  elements.orderForm.addEventListener("submit", handleOrderSubmit);
  elements.historyDateFrom.addEventListener("change", renderHistory);
  elements.historyDateTo.addEventListener("change", renderHistory);
  elements.historyLocation.addEventListener("change", renderHistory);
  elements.historyCategory.addEventListener("change", renderHistory);
  elements.historyPayment.addEventListener("change", renderHistory);
  elements.historyStatus.addEventListener("change", renderHistory);
  elements.clockInBtn.addEventListener("click", clockIn);
  elements.clockOutBtn.addEventListener("click", clockOut);
  elements.manualHoursForm.addEventListener("submit", addManualTimeEntry);
  elements.timeclockDate.addEventListener("change", renderTimeclock);
  elements.timeclockWeek.addEventListener("change", renderTimeclock);
  elements.timeclockMonth.addEventListener("change", renderTimeclock);
  elements.timesheetFilterForm.addEventListener("submit", (event) => {
    event.preventDefault();
    renderEmployeeTimesheet();
  });
  elements.exportTimesheetBtn.addEventListener("click", exportEmployeeTimesheetPdf);
  elements.exportBtn.addEventListener("click", exportExcel);
  elements.locationForm.addEventListener("submit", (event) =>
    addListItem(event, "locations", "newLocationInput"),
  );
  elements.flavorForm.addEventListener("submit", (event) => addListItem(event, "flavors", "newFlavorInput"));
  elements.vaperForm.addEventListener("submit", addVaperItem);
  elements.downloadMenuBtn.addEventListener("click", downloadMenuPdf);

  elements.clearDemoBtn.addEventListener("click", clearOrders);
  elements.createUserForm.addEventListener("submit", handleCreateUser);
}

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      return normalizeState({ ...structuredClone(defaults), ...JSON.parse(saved) });
    } catch {
      return structuredClone(defaults);
    }
  }

  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!legacy) return structuredClone(defaults);

  try {
    const oldState = JSON.parse(legacy);
    return normalizeState({
      ...structuredClone(defaults),
      locations: oldState.locations || defaults.locations,
      locationSettings: oldState.locationSettings || defaults.locationSettings,
      flavors: oldState.flavors || defaults.flavors,
      vapers: oldState.vapers || defaults.vapers,
      session: oldState.session || defaults.session,
      timeEntries: oldState.timeEntries || [],
      orders: (oldState.sales || []).map((sale) => ({
        id: sale.id || crypto.randomUUID(),
        createdAt: sale.createdAt,
        paidAt: sale.createdAt,
        seller: sale.seller,
        location: sale.location,
        customer: sale.customer || "",
        flavor: sale.flavor,
        flavors: getOrderFlavorItems(sale),
        price: Number(sale.price || 0),
        commission: 0,
        notes: sale.notes || "",
        status: STATUS.paid,
        paymentMethod: PAYMENT.cash,
      })),
    });
  } catch {
    return structuredClone(defaults);
  }
}

function normalizeState(nextState) {
  const normalized = {
    ...structuredClone(defaults),
    ...nextState,
    orders: nextState.orders || [],
    timeEntries: nextState.timeEntries || [],
    vapers: nextState.vapers || defaults.vapers,
  };
  normalized.users = normalizeUsers(nextState.users);
  delete normalized.sellers;
  normalized.locationSettings = buildLocationSettings(normalized.locations, normalized.locationSettings);
  normalized.orders = normalized.orders.map((order) => ({
    ...order,
    id: String(order.id || crypto.randomUUID()),
    createdAt: normalizeDateValue(order.createdAt, new Date().toISOString()),
    paidAt: normalizeDateValue(order.paidAt),
    productType: order.productType === PRODUCT.vape ? PRODUCT.vape : PRODUCT.hookah,
    productName: order.productName || "",
    quantity: Math.max(Number(order.quantity || 1), 1),
    hookahs: getOrderHookahItems(order),
    vapeItems: getOrderVapeItems(order),
    flavors: getOrderFlavorItems(order),
    commission: Number(order.commission || 0),
    status: order.status === STATUS.paid ? STATUS.paid : STATUS.preparation,
    paymentMethod:
      order.paymentMethod === PAYMENT.card
        ? PAYMENT.card
        : order.paymentMethod === PAYMENT.cash
          ? PAYMENT.cash
          : null,
  }));
  normalized.timeEntries = normalized.timeEntries.map((entry) => ({
    id: entry.id || crypto.randomUUID(),
    seller: entry.seller || "",
    location: entry.location || "",
    clockInAt: normalizeDateValue(entry.clockInAt, new Date().toISOString()),
    clockOutAt: normalizeDateValue(entry.clockOutAt),
    manualDurationMinutes: Number(entry.manualDurationMinutes || 0),
    note: entry.note || "",
    source: entry.source || "clock",
  }));
  normalized.vapers = normalized.vapers.map((vaper) => ({
    id: vaper.id || crypto.randomUUID(),
    name: vaper.name || "Vaper",
    price: Number(vaper.price || 0),
    stock: Math.max(Number(vaper.stock || 0), 0),
  }));
  return normalized;
}

function normalizeDateValue(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000).toISOString();
  return fallback;
}

function normalizeRole(role) {
  if (role === "admin" || role === "manager") return ROLES.manager;
  return ROLES.employee;
}
function normalizeUsers(users = []) {
  const validUsers = Array.isArray(users)
    ? users
        .filter((user) => user && user.name && user.role)
        .map((user) => ({
          id: user.id || crypto.randomUUID(),
          name: user.name || user.email,
          role: normalizeRole(user.role),
          active: user.active !== false,
          createdAt: user.createdAt || new Date().toISOString(),
        }))
    : [];

  return validUsers;
}

function persistLocalState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function saveState() {
  persistLocalState();
  scheduleFirestoreSync();
}

function renderAll() {
  renderSelects();
  renderCustomerOptions();
  renderFlavorOptions();
  renderVaperOptions();
  renderProductControls();
  renderSelectedFlavors();
  renderSelectedHookahs();
  renderSelectedVapers();
  renderPriceControls();
  renderOrderBoard();
  renderTotals();
  renderHistory();
  renderStats();
  renderTimeclock();
  renderStock();
  renderSettings();
  renderLastOrder();
}

function renderSelects() {
  populateDashboardFilters();
  fillSelect(elements.locationSelect, state.locations, state.session.location);
  if (isEmployee()) {
    fillSelect(elements.historyLocation, [state.session.location], state.session.location);
    elements.historyDateFrom.value = toDateInputValue(new Date());
    elements.historyDateTo.value = toDateInputValue(new Date());
  } else {
    fillSelect(elements.historyLocation, ["Todos los centros", ...state.locations], elements.historyLocation.value || "Todos los centros");
  }
}
function populateDashboardFilters() {
  const locationValue = elements.dashboardLocation.value || "Todos los centros";
  const sellerValue = elements.dashboardSeller.value || "Todos los trabajadores";
  const locations = isManager() ? ["Todos los centros", ...state.locations] : [state.session.location];
  const sellers = isManager() ? ["Todos los trabajadores", ...getActiveUserNames()] : [currentUser.name];
  fillSelect(elements.dashboardLocation, locations, locations.includes(locationValue) ? locationValue : locations[0]);
  fillSelect(elements.dashboardSeller, sellers, sellers.includes(sellerValue) ? sellerValue : sellers[0]);
}

function fillSelect(select, items, selectedValue) {
  select.innerHTML = items.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join("");
  select.value = selectedValue;
}

function renderCustomerOptions() {
  elements.customerOptions.innerHTML = getKnownCustomers()
    .map((customer) => `<option value="${escapeHtml(customer)}"></option>`)
    .join("");
}

function buildLocationSettings(locations, currentSettings = {}) {
  return locations.reduce((settings, location, index) => {
    const fallbackPrice = index % 2 === 0 ? 10 : 15;
    const current = currentSettings[location] || {};
    const hookahRecommendedPrice = Number(current.hookahRecommendedPrice || current.recommendedPrice || fallbackPrice);
    settings[location] = {
      hookahRecommendedPrice,
      vapeRecommendedPrice: Number(current.vapeRecommendedPrice || 10),
      commission: Number(current.commission || 0),
    };
    return settings;
  }, {});
}

function getLocationConfig(location = state.session.location) {
  if (!state.locationSettings[location]) {
    state.locationSettings[location] = {
      hookahRecommendedPrice: 10,
      vapeRecommendedPrice: 10,
      commission: 0,
    };
  }
  return state.locationSettings[location];
}

function getRecommendedPriceForCurrentProduct() {
  const config = getLocationConfig();
  return productType === PRODUCT.vape ? config.vapeRecommendedPrice : config.hookahRecommendedPrice;
}

function applyRecommendedPrice() {
  const recommendedPrice = getRecommendedPriceForCurrentProduct();
  priceMode = String(recommendedPrice);
  elements.priceInput.value = recommendedPrice;
  renderPriceControls();
}

function selectProductType(nextType) {
  productType = nextType === PRODUCT.vape ? PRODUCT.vape : PRODUCT.hookah;
  if (productType === PRODUCT.vape) quickPaymentMethod = "";
  applyRecommendedPrice();
  renderProductControls();
  renderPriceControls();
}

function selectQuickPayment(paymentMethod) {
  quickPaymentMethod = paymentMethod === PAYMENT.card ? PAYMENT.card : PAYMENT.cash;
  renderProductControls();
}

function renderProductControls() {
  const isVape = productType === PRODUCT.vape;
  elements.orderTitle.textContent = isVape ? "Venta de vaper" : "Pedido de cachimba";
  elements.customerField.hidden = isVape;
  if (isVape) elements.customerInput.value = "";
  elements.hookahFields.hidden = isVape;
  elements.vapeFields.hidden = !isVape;
  if (isVape) {
    elements.vapeProductSelect.closest("label").after(elements.priceField);
  } else {
    elements.customerField.after(elements.priceField);
  }
  elements.quickPriceButtons.hidden = false;
  elements.priceInput.readOnly = false;
  elements.saveOrderBtn.textContent = isVape ? "Pagar" : "Poner en preparación";
  elements.saveOrderBtn.disabled = isVape && (!selectedVapers.length || !quickPaymentMethod);

  elements.productTypeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.productType === productType);
  });

  elements.quickPaymentButtons.forEach((button) => {
    button.classList.toggle("selected", button.dataset.paymentOption === quickPaymentMethod);
  });
}

function getSelectedVaper() {
  return state.vapers.find((vaper) => vaper.id === elements.vapeProductSelect.value && vaper.stock > 0);
}

function syncSelectedVaperPrice() {
  applyRecommendedPrice();
  renderProductControls();
}

function selectPriceOption(option) {
  priceMode = option;
  if (option === "other") {
    elements.priceInput.value = "";
    elements.otherPriceWrap.classList.add("visible");
    elements.priceInput.focus();
    renderPriceControls();
    return;
  }

  elements.priceInput.value = option;
  elements.otherPriceWrap.classList.remove("visible");
  renderPriceControls();
}

function renderPriceControls() {
  const recommendedPrice = getRecommendedPriceForCurrentProduct();
  const isVape = productType === PRODUCT.vape;
  
  if (!elements.priceInput.value && priceMode !== "other") {
    elements.priceInput.value = recommendedPrice;
  }

  const hasPrice = elements.priceInput.value !== "";
  const currentPrice = Number(elements.priceInput.value);
  const presetPrices = isVape ? [15, 10, 5] : [20, 15, 10];
  const numericButtons = [...elements.priceOptionButtons].filter(
    (button) => button.dataset.priceOption !== "other",
  );
  numericButtons.forEach((button, index) => {
    const price = presetPrices[index];
    button.dataset.priceOption = String(price);
    button.textContent = `${price} EUR`;
  });
  const isPreset = presetPrices.includes(currentPrice);
  const showOtherPrice = priceMode === "other" || (hasPrice && !isPreset);

  elements.recommendedPriceLabel.textContent = `Recomendado: ${formatMoney(recommendedPrice)}`;
  elements.otherPriceWrap.classList.toggle("visible", showOtherPrice);
  elements.priceOptionButtons.forEach((button) => {
    const option = button.dataset.priceOption;
    const optionPrice = Number(option);
    button.classList.toggle("recommended", option !== "other" && optionPrice === recommendedPrice);
    button.classList.toggle(
      "selected",
      option === "other" ? showOtherPrice : hasPrice && !showOtherPrice && currentPrice === optionPrice,
    );
  });
}

function renderFlavorOptions() {
  const currentFlavor = elements.flavorInput.value;
  elements.flavorInput.innerHTML = [
    `<option value="">Selecciona un sabor</option>`,
    ...state.flavors.map((flavor) => `<option value="${escapeHtml(flavor)}">${escapeHtml(flavor)}</option>`),
  ].join("");
  if (state.flavors.includes(currentFlavor)) elements.flavorInput.value = currentFlavor;
}

function renderVaperOptions() {
  const availableVapers = state.vapers.filter((vaper) => vaper.stock > 0);
  elements.vapeProductSelect.innerHTML = availableVapers.length
    ? availableVapers
        .map(
          (vaper) => `<option value="${escapeHtml(vaper.id)}">${escapeHtml(vaper.name)} · stock ${vaper.stock}</option>`,
        )
        .join("")
    : `<option value="">Sin stock disponible</option>`;
  elements.vapeProductSelect.disabled = !availableVapers.length;
  if (availableVapers.length && !availableVapers.some((vaper) => vaper.id === elements.vapeProductSelect.value)) {
    elements.vapeProductSelect.value = availableVapers[0].id;
  }
  if (productType === PRODUCT.vape) syncSelectedVaperPrice();
}



function addSelectedFlavor() {
  const flavorName = elements.flavorInput.value.trim();
  if (!flavorName || selectedFlavors.some((item) => normalize(item.name) === normalize(flavorName))) return;

  selectedFlavors.push({ name: flavorName, percentage: 0 });
  balanceSelectedFlavorPercentages();
  elements.flavorInput.value = "";
  renderSelectedFlavors();
}

function removeSelectedFlavor(flavorName) {
  selectedFlavors = selectedFlavors.filter((item) => item.name !== flavorName);
  balanceSelectedFlavorPercentages();
  renderSelectedFlavors();
}

function updateSelectedFlavorPercentage(flavorName, value) {
  selectedFlavors = selectedFlavors.map((flavor) =>
    flavor.name === flavorName ? { ...flavor, percentage: Number(value || 0) } : flavor,
  );
  renderSelectedFlavors();
}

function balanceSelectedFlavorPercentages() {
  if (!selectedFlavors.length) return;

  const base = Math.floor(100 / selectedFlavors.length);
  let remainder = 100 - base * selectedFlavors.length;
  selectedFlavors = selectedFlavors.map((flavor) => {
    const percentage = base + (remainder > 0 ? 1 : 0);
    remainder -= 1;
    return { ...flavor, percentage };
  });
}

function renderSelectedFlavors() {
  if (!selectedFlavors.length) {
    elements.selectedFlavors.innerHTML = `<span class="empty-hint">Sin sabores seleccionados.</span>`;
    elements.flavorTotal.textContent = "Total mezcla: 0%";
    elements.flavorTotal.classList.remove("is-valid");
    return;
  }

  elements.selectedFlavors.innerHTML = selectedFlavors
    .map(
      (flavor) => `
        <span class="flavor-chip">
          <span>${escapeHtml(flavor.name)}</span>
          <input type="number" min="0" max="100" step="1" value="${flavor.percentage}" data-flavor-percent="${escapeHtml(flavor.name)}" aria-label="Porcentaje de ${escapeHtml(flavor.name)}" />
          <span>%</span>
          <button type="button" data-remove-flavor="${escapeHtml(flavor.name)}">x</button>
        </span>
      `,
    )
    .join("");

  const total = sumSelectedFlavorPercentages();
  elements.flavorTotal.textContent = `Total mezcla: ${total}%`;
  elements.flavorTotal.classList.toggle("is-valid", total === 100);

  elements.selectedFlavors.querySelectorAll("[data-flavor-percent]").forEach((input) => {
    input.addEventListener("change", () => updateSelectedFlavorPercentage(input.dataset.flavorPercent, input.value));
  });

  elements.selectedFlavors.querySelectorAll("[data-remove-flavor]").forEach((button) => {
    button.addEventListener("click", () => removeSelectedFlavor(button.dataset.removeFlavor));
  });
}

function sumSelectedFlavorPercentages() {
  return selectedFlavors.reduce((total, flavor) => total + Number(flavor.percentage || 0), 0);
}

function addSelectedHookahItem() {
  addSelectedFlavor();
  if (!selectedFlavors.length) {
    alert("Selecciona al menos un sabor para esta cachimba.");
    return false;
  }
  if (sumSelectedFlavorPercentages() !== 100) {
    alert("El total de la mezcla debe sumar 100%.");
    return false;
  }

  const unitPrice = Number(elements.priceInput.value);
  if (Number.isNaN(unitPrice) || unitPrice <= 0) {
    alert("Indica un precio valido para esta cachimba.");
    return false;
  }

  const quantity = 1;
  selectedHookahs.push({
    id: crypto.randomUUID(),
    quantity,
    unitPrice,
    flavors: selectedFlavors.map((flavor) => ({ ...flavor })),
  });

  selectedFlavors.forEach((flavor) => {
    if (!state.flavors.some((item) => normalize(item) === normalize(flavor.name))) {
      state.flavors.push(flavor.name);
    }
  });

  selectedFlavors = [];
  elements.flavorInput.value = "";
  renderSelectedFlavors();
  renderSelectedHookahs();
  applyRecommendedPrice();
  return true;
}

function removeSelectedHookahItem(hookahId) {
  selectedHookahs = selectedHookahs.filter((hookah) => hookah.id !== hookahId);
  renderSelectedHookahs();
}

function renderSelectedHookahs() {
  if (!selectedHookahs.length) {
    elements.hookahItems.innerHTML = `<span class="empty-hint">Sin mezclas añadidas. Selecciona sabores y pulsa el botón para añadir.</span>`;
    return;
  }

  elements.hookahItems.innerHTML = selectedHookahs
    .map(
      (hookah, index) => `
        <article class="hookah-item">
          <div>
            <strong>${hookah.quantity} cachimba${hookah.quantity === 1 ? "" : "s"} · Mezcla ${index + 1}</strong>
            <span>${escapeHtml(formatFlavorItems(hookah.flavors))}</span>
            <span>${formatMoney(hookah.unitPrice)} EUR c/u - Total ${formatMoney(hookah.unitPrice * hookah.quantity)} EUR</span>
          </div>
          <button type="button" data-remove-hookah="${escapeHtml(hookah.id)}">x</button>
        </article>
      `,
    )
    .join("");

  const orderTotal = selectedHookahs.reduce(
    (total, hookah) => total + hookah.unitPrice * hookah.quantity,
    0,
  );
  elements.hookahItems.insertAdjacentHTML(
    "beforeend",
    `<div class="flavor-total is-valid">Total pedido: ${formatMoney(orderTotal)} EUR</div>`,
  );

  elements.hookahItems.querySelectorAll("[data-remove-hookah]").forEach((button) => {
    button.addEventListener("click", () => removeSelectedHookahItem(button.dataset.removeHookah));
  });
}

function addSelectedVaperItem() {
  const selectedVaper = getSelectedVaper();
  if (!selectedVaper) {
    alert("No hay stock disponible para este vaper.");
    return false;
  }
  
  const unitPrice = Number(elements.priceInput.value);
  if (Number.isNaN(unitPrice) || unitPrice <= 0) {
    alert("Indica un precio válido para continuar.");
    return false;
  }

  const alreadySelected = selectedVapers.filter((item) => item.vaperId === selectedVaper.id).length;
  if (alreadySelected >= selectedVaper.stock) {
    alert(`No hay mas unidades disponibles de ${selectedVaper.name}.`);
    return false;
  }

  selectedVapers.push({
    id: crypto.randomUUID(),
    vaperId: selectedVaper.id,
    vaperName: selectedVaper.name,
    quantity: 1,
    unitPrice,
  });

  renderSelectedVapers();
  syncSelectedVaperPrice();
  renderProductControls();
  return true;
}

function removeSelectedVaperItem(itemId) {
  selectedVapers = selectedVapers.filter((vaper) => vaper.id !== itemId);
  renderSelectedVapers();
  renderProductControls();
}

function renderSelectedVapers() {
  if (!selectedVapers.length) {
    elements.vaperItems.innerHTML = `<span class="empty-hint">Sin vapers añadidos. Selecciona un vaper y pulsa el botón para añadir.</span>`;
    return;
  }

  elements.vaperItems.innerHTML = selectedVapers
    .map(
      (item, index) => `
        <article class="vaper-item">
          <div>
            <strong>Vaper ${index + 1}</strong>
            <span>${escapeHtml(item.vaperName)}</span>
            <span>${formatMoney(item.unitPrice)} EUR</span>
          </div>
          <button type="button" data-remove-vaper="${escapeHtml(item.id)}">x</button>
        </article>
      `,
    )
    .join("");

  const orderTotal = selectedVapers.reduce((total, item) => total + item.unitPrice, 0);
  elements.vaperItems.insertAdjacentHTML(
    "beforeend",
    `<div class="flavor-total is-valid">Total pedido: ${formatMoney(orderTotal)} EUR</div>`,
  );

  elements.vaperItems.querySelectorAll("[data-remove-vaper]").forEach((button) => {
    button.addEventListener("click", () => removeSelectedVaperItem(button.dataset.removeVaper));
  });
}

function handleOrderSubmit(event) {
  event.preventDefault();

  const isVape = productType === PRODUCT.vape;

  if (isVape) {
    if (!selectedVapers.length) {
      alert("Selecciona al menos un vaper para continuar.");
      return;
    }

    if (!quickPaymentMethod) {
      alert("Selecciona Efectivo o Tarjeta para continuar.");
      return;
    }

    const paymentMethod = quickPaymentMethod;
    const paidAt = new Date().toISOString();
    const vapeItems = selectedVapers.map((item) => ({
      vaperId: item.vaperId,
      vaperName: item.vaperName,
      quantity: 1,
      unitPrice: item.unitPrice,
    }));
    const price = vapeItems.reduce((total, item) => total + item.unitPrice, 0);

    state.orders.push({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      paidAt,
      productType: PRODUCT.vape,
      productId: vapeItems[0]?.vaperId || "",
      productName: vapeItems.length === 1 ? vapeItems[0].vaperName : `${vapeItems.length} vapers`,
      quantity: vapeItems.length,
      vapeItems,
      hookahs: [],
      seller: state.session.seller,
      location: state.session.location,
      customer: "",
      flavor: "",
      flavors: [],
      price,
      commission: 0,
      notes: elements.notesInput.value.trim(),
      status: STATUS.paid,
      paymentMethod,
    });

    vapeItems.forEach((item) => {
      state.vapers = state.vapers.map((vaper) =>
        vaper.id === item.vaperId ? { ...vaper, stock: Math.max(vaper.stock - 1, 0) } : vaper,
      );
    });

    elements.orderForm.reset();
    selectedVapers = [];
    quickPaymentMethod = "";
    renderSelectedVapers();
    syncSelectedVaperPrice();
    saveState();
    renderAll();
  } else {
    if (selectedFlavors.length || elements.flavorInput.value.trim()) {
      if (!addSelectedHookahItem()) return;
    }
    if (!selectedHookahs.length) return;

    const hookahs = selectedHookahs.map((hookah) => ({
      quantity: hookah.quantity,
      unitPrice: hookah.unitPrice,
      flavors: hookah.flavors.map((flavor) => ({ ...flavor })),
    }));
    const quantity = hookahs.reduce((total, hookah) => total + Number(hookah.quantity || 0), 0);
    const flavors = hookahs[0]?.flavors || [];
    const commission = getLocationConfig().commission * quantity;
    const price = hookahs.reduce((total, hookah) => total + hookah.unitPrice * hookah.quantity, 0);

    state.orders.push({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      paidAt: null,
      productType: PRODUCT.hookah,
      productId: "",
      productName: "",
      quantity,
      hookahs,
      seller: state.session.seller,
      location: state.session.location,
      customer: cleanCustomerName(elements.customerInput.value),
      flavor: flavors.map((flavor) => flavor.name).join(", "),
      flavors,
      price,
      commission,
      notes: elements.notesInput.value.trim(),
      status: STATUS.preparation,
      paymentMethod: null,
    });

    elements.orderForm.reset();
      selectedFlavors = [];
    selectedHookahs = [];
    renderSelectedFlavors();
    renderSelectedHookahs();
    applyRecommendedPrice();
    elements.customerInput.focus();
    saveState();
    renderAll();
  }
}

function renderOrderBoard() {
  const today = getOrdersForDate(new Date()).filter(
    (order) => order.location === state.session.location,
  );
  const preparing = today.filter((order) => order.status === STATUS.preparation);
  const paid = today.filter((order) => order.status === STATUS.paid).reverse();

  elements.preparingCount.textContent = preparing.length;
  elements.paidCount.textContent = paid.length;
  elements.preparingOrders.innerHTML = preparing.length
    ? preparing.map(renderPreparingCard).join("")
    : `<div class="empty-state">No hay pedidos en preparación.</div>`;
  elements.paidOrders.innerHTML = paid.length
    ? paid.slice(0, 8).map(renderPaidCard).join("")
    : `<div class="empty-state">Todavía no hay cobros hoy.</div>`;

  elements.preparingOrders.querySelectorAll("[data-pay]").forEach((button) => {
    button.addEventListener("click", () => markOrderPaid(button.dataset.orderId, button.dataset.pay));
  });

  elements.preparingOrders.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteOrder(button.dataset.orderId));
  });

  document.querySelectorAll("[data-edit-order]").forEach((button) => {
    button.addEventListener("click", () => editOrder(button.dataset.orderId));
  });
}

function renderPreparingCard(order) {
  return `
    <article class="order-card status-preparation">
      <header>
        <div>
          <strong>${escapeHtml(order.customer || "Sin mesa/cliente")}</strong>
          <span>${getProductLabel(order)} · ${formatTime(order.createdAt)} · ${escapeHtml(order.seller)}</span>
        </div>
        <b>Total pedido: ${formatMoney(order.price)} EUR</b>
      </header>
      ${renderOrderItemLines(order)}
      <small>Comisión: ${formatMoney(order.commission)}</small>
      ${order.notes ? `<small>${escapeHtml(order.notes)}</small>` : ""}
      <div class="order-actions">
        <button class="pay-cash" type="button" data-order-id="${escapeHtml(order.id)}" data-pay="${PAYMENT.cash}">Efectivo</button>
        <button class="pay-card" type="button" data-order-id="${escapeHtml(order.id)}" data-pay="${PAYMENT.card}">Tarjeta</button>
        <button class="ghost-btn" type="button" data-order-id="${escapeHtml(order.id)}" data-edit-order>Editar</button>
        <button class="ghost-btn" type="button" data-order-id="${escapeHtml(order.id)}" data-delete>Borrar</button>
      </div>
    </article>
  `;
}

function renderPaidCard(order) {
  return `
    <article class="order-card status-paid">
      <header>
        <div>
          <strong>${escapeHtml(isVapeOrder(order) ? order.productName || "Vaper" : order.customer || "Sin mesa/cliente")}</strong>
          <span>${getProductLabel(order)} · ${formatTime(order.paidAt || order.createdAt)} · ${getPaymentLabel(order.paymentMethod)}</span>
        </div>
        <b>Total pedido: ${formatMoney(order.price)} EUR</b>
      </header>
      ${renderOrderItemLines(order)}
      ${isVapeOrder(order) ? "" : `<small>Comisión: ${formatMoney(order.commission)}</small>`}
      <div class="order-actions paid-actions">
        <button class="ghost-btn" type="button" data-order-id="${escapeHtml(order.id)}" data-edit-order>Editar</button>
      </div>
    </article>
  `;
}

function renderOrderItemLines(order) {
  if (isVapeOrder(order)) {
    const lines = getOrderVapeItems(order)
      .map(
        (item, index) => `
          <div class="order-item-line">
            <div>
              <strong>Vaper ${index + 1}</strong>
              <span>${escapeHtml(item.vaperName)}</span>
            </div>
            <strong>${formatMoney(item.unitPrice * item.quantity)} EUR</strong>
          </div>
        `,
      )
      .join("");
    return `<div class="order-item-lines">${lines}</div>`;
  }

  const lines = getOrderHookahItems(order)
    .map((hookah, index) => {
      const subtotal = hookah.unitPrice * hookah.quantity;
      return `
        <div class="order-item-line">
          <div>
            <strong>Cachimba ${index + 1}</strong>
            <span>${escapeHtml(formatFlavorItems(hookah.flavors))}</span>
          </div>
          <strong>${formatMoney(subtotal)} EUR</strong>
        </div>
      `;
    })
    .join("");

  return `<div class="order-item-lines">${lines}</div>`;
}
function markOrderPaid(id, paymentMethod) {
  state.orders = state.orders.map((order) =>
    order.id === id
      ? {
          ...order,
          status: STATUS.paid,
          paymentMethod,
          paidAt: new Date().toISOString(),
        }
      : order,
  );
  saveState();
  renderAll();
}

function renderTotals() {
  const today = getOrdersForDate(new Date());
  const filtered = today.filter((order) =>
    isManager() ? true : order.location === state.session.location,
  );
  const openOrders = filtered.filter((order) => order.status === STATUS.preparation);
  const paidOrders = filtered.filter((order) => order.status === STATUS.paid);
  const paidVapeOrders = paidOrders.filter((order) => order.productType === PRODUCT.vape);
  const paidHookahOrders = paidOrders.filter((order) => order.productType !== PRODUCT.vape);
  const paidCardOrders = paidOrders.filter((order) => order.paymentMethod === PAYMENT.card);
  const paidCashOrders = paidOrders.filter((order) => order.paymentMethod === PAYMENT.cash);
  elements.todayOpenOrders.textContent = openOrders.length;
  elements.todayRevenue.textContent = formatMoney(sumOrders(paidOrders));
  elements.todayCardRevenue.textContent = formatMoney(sumOrders(paidCardOrders));
  elements.todayCashRevenue.textContent = formatMoney(sumOrders(paidCashOrders));
  elements.todayVapeRevenue.textContent = formatMoney(sumOrders(paidVapeOrders));
  elements.todayHookahRevenue.textContent = formatMoney(sumOrders(paidHookahOrders));
}

function renderLastOrder() {
  const lastOrder = getOrdersVisibleToCurrentUser().at(-1);
  if (!lastOrder) {
    elements.lastOrderBox.innerHTML = `
      <p class="eyebrow">Último movimiento</p>
      <p>Todavía no hay pedidos registrados.</p>
    `;
    return;
  }

  elements.lastOrderBox.innerHTML = `
    <p class="eyebrow">Último movimiento</p>
    <p><strong>${escapeHtml(getProductLabel(lastOrder))}</strong> en ${escapeHtml(lastOrder.location)}</p>
    <p>${escapeHtml(formatSaleItem(lastOrder))} · ${getStatusLabel(lastOrder.status)} · ${formatShortDateTime(lastOrder.paidAt || lastOrder.createdAt)}</p>
  `;
}

function renderHistory() {
  const filtered = getFilteredHistory();

  if (!filtered.length) {
    elements.historyTable.innerHTML = `
      <tr>
        <td class="empty-state" colspan="12">No hay pedidos para estos filtros.</td>
      </tr>
    `;
    return;
  }

  elements.historyTable.innerHTML = filtered
    .map(
      (order) => `
      <tr>
        <td>${formatTime(order.createdAt)}</td>
        <td>${escapeHtml(order.location)}</td>
        <td>${escapeHtml(order.seller)}</td>
        <td>${escapeHtml(order.customer || "-")}</td>
        <td>${escapeHtml(getProductLabel(order))}</td>
        <td>${getOrderUnitCount(order)}</td>
        <td>${escapeHtml(formatSaleItem(order))}</td>
        <td><span class="status-badge ${order.status}">${getStatusLabel(order.status)}</span></td>
        <td>${getPaymentLabel(order.paymentMethod)}</td>
        <td>${formatMoney(order.price)}</td>
        <td>${formatMoney(order.commission)}</td>
        <td class="table-actions">
          <button class="inline-action" type="button" data-order-id="${escapeHtml(order.id)}" data-edit-order>Editar</button>
          <button class="delete-sale" type="button" data-order-id="${escapeHtml(order.id)}">Borrar</button>
        </td>
      </tr>
    `,
    )
    .join("");

  elements.historyTable.querySelectorAll(".delete-sale").forEach((button) => {
    button.addEventListener("click", () => deleteOrder(button.dataset.orderId));
  });

  elements.historyTable.querySelectorAll("[data-edit-order]").forEach((button) => {
    button.addEventListener("click", () => editOrder(button.dataset.orderId));
  });
}

function getFilteredHistory() {
  const today = toDateInputValue(new Date());
  const dateFrom = isEmployee() ? today : elements.historyDateFrom.value;
  const dateTo = isEmployee() ? today : elements.historyDateTo.value;
  const selectedLocation = isEmployee() ? state.session.location : elements.historyLocation.value;
  const selectedCategory = elements.historyCategory.value;
  const selectedPayment = elements.historyPayment.value;
  const selectedStatus = elements.historyStatus.value;

  return getOrdersVisibleToCurrentUser()
    .reverse()
    .filter((order) => {
      const orderDate = getLocalDateValue(order.createdAt);
      return (!dateFrom || orderDate >= dateFrom) && (!dateTo || orderDate <= dateTo);
    })
    .filter((order) => selectedLocation === "Todos los centros" || order.location === selectedLocation)
    .filter((order) => selectedCategory === "all" || order.productType === selectedCategory)
    .filter((order) => selectedPayment === "all" || order.paymentMethod === selectedPayment)
    .filter((order) => selectedStatus === "all" || order.status === selectedStatus);
}
function canModifyOrder(order) {
  if (isManager()) return true;
  return (
    isEmployee() &&
    order.location === state.session.location &&
    getLocalDateValue(order.createdAt) === toDateInputValue(new Date())
  );
}

function deleteOrder(id) {
  const order = state.orders.find((item) => item.id === id);
  if (!order || !canModifyOrder(order)) return;
  if (!confirm("Seguro que quieres borrar este pedido?")) return;

  if (isVapeOrder(order)) {
    getOrderVapeItems(order).forEach((item) => {
      state.vapers = state.vapers.map((vaper) =>
        vaper.id === item.vaperId
          ? { ...vaper, stock: Number(vaper.stock || 0) + item.quantity }
          : vaper,
      );
    });
  }

  state.orders = state.orders.filter((item) => item.id !== id);
  deleteRemoteRecord("deleteOrder", id);
  saveState();
  renderAll();
}

function editOrder(id) {
  const order = state.orders.find((item) => item.id === id);
  if (!order || !canModifyOrder(order)) return;

  const updatedOrder = { ...order };
  if (!isVapeOrder(order)) {
    const customer = prompt("Mesa o cliente:", order.customer || "");
    if (customer === null) return;
    updatedOrder.customer = cleanCustomerName(customer);

    const hookahs = getOrderHookahItems(order).map((hookah) => ({
      ...hookah,
      flavors: hookah.flavors.map((flavor) => ({ ...flavor })),
    }));
    for (let index = 0; index < hookahs.length; index += 1) {
      const value = prompt(`Precio de Cachimba ${index + 1}:`, String(hookahs[index].unitPrice));
      if (value === null) return;
      const unitPrice = Number(value);
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        alert("Indica un precio valido.");
        return;
      }
      hookahs[index].unitPrice = unitPrice;
    }
    updatedOrder.hookahs = hookahs;
    updatedOrder.price = hookahs.reduce(
      (total, hookah) => total + hookah.unitPrice * hookah.quantity,
      0,
    );
  } else {
    const vapeItems = getOrderVapeItems(order).map((item) => ({ ...item }));
    for (let index = 0; index < vapeItems.length; index += 1) {
      const value = prompt(`Precio de Vaper ${index + 1}:`, String(vapeItems[index].unitPrice));
      if (value === null) return;
      const unitPrice = Number(value);
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        alert("Indica un precio valido.");
        return;
      }
      vapeItems[index].unitPrice = unitPrice;
    }
    updatedOrder.vapeItems = vapeItems;
    updatedOrder.price = vapeItems.reduce(
      (total, item) => total + item.unitPrice * item.quantity,
      0,
    );
  }

  const notes = prompt("Notas del pedido:", order.notes || "");
  if (notes === null) return;
  updatedOrder.notes = notes.trim();

  if (order.status === STATUS.paid) {
    const payment = prompt(
      "Forma de pago (efectivo o tarjeta):",
      order.paymentMethod === PAYMENT.card ? "tarjeta" : "efectivo",
    );
    if (payment === null) return;
    const normalizedPayment = normalize(payment);
    if (normalizedPayment !== "efectivo" && normalizedPayment !== "tarjeta") {
      alert("La forma de pago debe ser efectivo o tarjeta.");
      return;
    }
    updatedOrder.paymentMethod = normalizedPayment === "tarjeta" ? PAYMENT.card : PAYMENT.cash;
  }

  state.orders = state.orders.map((item) => (item.id === id ? updatedOrder : item));
  saveState();
  renderAll();
}
function clockIn() {
  const activeEntry = getActiveTimeEntry(state.session.seller);
  if (activeEntry) {
    alert("Este trabajador ya tiene una jornada abierta.");
    return;
  }

  state.timeEntries.push({
    id: crypto.randomUUID(),
    seller: state.session.seller,
    location: state.session.location,
    clockInAt: new Date().toISOString(),
    clockOutAt: null,
    manualDurationMinutes: 0,
    note: "",
    source: "clock",
  });

  saveState();
  renderAll();
}

function clockOut() {
  const activeEntry = getActiveTimeEntry(state.session.seller);
  if (!activeEntry) {
    alert("Este trabajador no tiene una jornada abierta.");
    return;
  }

  state.timeEntries = state.timeEntries.map((entry) =>
    entry.id === activeEntry.id ? { ...entry, clockOutAt: new Date().toISOString() } : entry,
  );

  saveState();
  renderAll();
}

function getActiveTimeEntry(seller = state.session.seller) {
  return state.timeEntries.find((entry) => entry.seller === seller && entry.source !== "manual" && !entry.clockOutAt);
}

function addManualTimeEntry(event) {
  event.preventDefault();
  if (!isManager()) {
    alert("Solo los gerentes pueden anadir fichajes manuales.");
    return;
  }

  const userId = elements.manualUserSelect.value;
  const user = state.users.find((item) => item.id === userId && item.active);
  const location = elements.manualLocationSelect.value;
  const date = elements.manualHoursDate.value;
  const startTime = elements.manualStartTime.value;
  const endTime = elements.manualEndTime.value;
  const clockInAt = createLocalDateTimeIso(date, startTime);
  const clockOutAt = createLocalDateTimeIso(date, endTime);

  if (!user || !state.locations.includes(location) || !clockInAt || !clockOutAt) {
    alert("Completa todos los datos de la sesión.");
    return;
  }
  if (new Date(clockOutAt) <= new Date(clockInAt)) {
    alert("La hora de salida debe ser posterior a la hora de entrada.");
    return;
  }

  state.timeEntries.push({
    id: crypto.randomUUID(),
    seller: user.name,
    userId: user.id,
    location,
    clockInAt,
    clockOutAt,
    manualDurationMinutes: 0,
    note: elements.manualHoursNote.value.trim(),
    source: "manual",
  });

  elements.manualHoursNote.value = "";
  saveState();
  renderAll();
}

function renderManualTimeEntryOptions() {
  if (!isManager()) return;
  const previousUser = elements.manualUserSelect.value;
  const previousLocation = elements.manualLocationSelect.value;
  const users = state.users.filter((user) => user.active);

  elements.manualUserSelect.innerHTML = users
    .map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)}</option>`)
    .join("");
  elements.manualLocationSelect.innerHTML = state.locations
    .map((location) => `<option value="${escapeHtml(location)}">${escapeHtml(location)}</option>`)
    .join("");

  elements.manualUserSelect.value = users.some((user) => user.id === previousUser)
    ? previousUser
    : currentUser.id;
  elements.manualLocationSelect.value = state.locations.includes(previousLocation)
    ? previousLocation
    : state.session.location;
}

function editTimeEntry(entryId) {
  if (!isManager()) return;
  const entry = state.timeEntries.find((item) => item.id === entryId);
  if (!entry) return;

  const date = prompt("Fecha (AAAA-MM-DD):", getTimeEntryDate(entry));
  if (date === null) return;
  const startTime = prompt("Hora de entrada (HH:MM):", formatTimeInput(entry.clockInAt));
  if (startTime === null) return;
  const endTime = prompt("Hora de salida (HH:MM):", entry.clockOutAt ? formatTimeInput(entry.clockOutAt) : "");
  if (endTime === null) return;
  const location = prompt("Centro de trabajo:", entry.location);
  if (location === null) return;

  const clockInAt = createLocalDateTimeIso(date.trim(), startTime.trim());
  const clockOutAt = createLocalDateTimeIso(date.trim(), endTime.trim());
  if (!clockInAt || !clockOutAt || new Date(clockOutAt) <= new Date(clockInAt)) {
    alert("Revisa la fecha y las horas. La salida debe ser posterior a la entrada.");
    return;
  }
  if (!state.locations.includes(location.trim())) {
    alert("Selecciona un centro de trabajo existente.");
    return;
  }

  state.timeEntries = state.timeEntries.map((item) =>
    item.id === entryId
      ? { ...item, location: location.trim(), clockInAt, clockOutAt, manualDurationMinutes: 0, source: "manual" }
      : item,
  );
  saveState();
  renderAll();
}

function deleteTimeEntry(entryId) {
  if (!isManager()) return;
  if (!confirm("Seguro que quieres eliminar esta sesión de fichaje?")) return;
  state.timeEntries = state.timeEntries.filter((entry) => entry.id !== entryId);
  deleteRemoteRecord("deleteTimeEntry", entryId);
  saveState();
  renderAll();
}

function createLocalDateTimeIso(dateValue, timeValue) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue) || !/^\d{2}:\d{2}$/.test(timeValue)) return "";
  const date = new Date(`${dateValue}T${timeValue}:00`);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function formatTimeInput(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
function renderTimeclock() {
  const showFullTimeclock = canViewFullTimeclock();
  const activeEntry = getActiveTimeEntry(state.session.seller);
  const selectedDate = elements.timeclockDate.value || toDateInputValue(new Date());
  const weekRange = getWeekRange(elements.timeclockWeek.value || getWeekInputValue(new Date()));
  const monthRange = getMonthRange(elements.timeclockMonth.value || toDateInputValue(new Date()).slice(0, 7));
  const dayEntries = getTimeEntriesBetween(selectedDate, selectedDate).sort(
    (a, b) => new Date(b.clockInAt) - new Date(a.clockInAt),
  );
  const weekEntries = getTimeEntriesBetween(weekRange.start, weekRange.end);
  const monthEntries = getTimeEntriesBetween(monthRange.start, monthRange.end);

  elements.manualHoursForm.hidden = !showFullTimeclock;
  if (showFullTimeclock) renderManualTimeEntryOptions();
  elements.timeclockDayHeader.hidden = false;
  elements.timeclockSummary.hidden = false;
  elements.timeclockMonthPanel.hidden = false;
  elements.timeclockTableWrap.hidden = false;
  elements.timeclockActionsHeader.hidden = !showFullTimeclock;
  elements.employeeTimesheetPanel.hidden = false;

  elements.clockInBtn.disabled = Boolean(activeEntry);
  elements.clockOutBtn.disabled = !activeEntry;
  elements.clockStatus.innerHTML = activeEntry
    ? `
      <p class="eyebrow">Fichaje abierto</p>
      <strong>${escapeHtml(activeEntry.seller)}</strong>
      <span>${escapeHtml(activeEntry.location)} · Entrada ${formatTime(activeEntry.clockInAt)}</span>
      <small>Tiempo actual: ${formatDuration(getEntryDurationMs(activeEntry))}</small>
    `
    : `
      <p class="eyebrow">Fichaje cerrado</p>
      <strong>${escapeHtml(state.session.seller)}</strong>
      <span>${escapeHtml(state.session.location)}</span>
      <small>Listo para abrir jornada.</small>
    `;

  renderTimeclockSummary(elements.timeclockWeekSummary, weekEntries, "No hay fichajes para esta semana.");
  renderTimeclockSummary(elements.timeclockSummary, dayEntries, "No hay fichajes para este dia.");
  renderTimeclockSummary(elements.timeclockMonthSummary, monthEntries, "No hay fichajes para este mes.");
  renderTimeclockTable(dayEntries);
  renderEmployeeTimesheet();
}

function getTimeEntriesBetween(startDate, endDate) {
  return getTimeEntriesVisibleToCurrentUser().filter((entry) => {
    const entryDate = getTimeEntryDate(entry);
    return entryDate >= startDate && entryDate <= endDate;
  });
}

function getTimeEntryDate(entry) {
  return entry.clockInAt ? toDateInputValue(new Date(entry.clockInAt)) : "";
}

function renderTimeclockSummary(container, entries, emptyMessage) {
  const bySeller = entries.reduce((acc, entry) => {
    const key = `${entry.seller}__${entry.location}`;
    if (!acc[key]) {
      acc[key] = {
        seller: entry.seller,
        location: entry.location,
        totalMs: 0,
        shifts: 0,
      };
    }
    acc[key].totalMs += getEntryDurationMs(entry);
    acc[key].shifts += 1;
    return acc;
  }, {});

  const rows = Object.values(bySeller).sort((a, b) => a.seller.localeCompare(b.seller, "es"));
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">${emptyMessage}</div>`;
    return;
  }

  container.innerHTML = rows
    .map(
      (row) => `
        <article>
          <p class="eyebrow">${escapeHtml(row.location)}</p>
          <strong>${escapeHtml(row.seller)}</strong>
          <span>${formatDuration(row.totalMs)} · ${row.shifts} jornada${row.shifts === 1 ? "" : "s"}</span>
        </article>
      `,
    )
    .join("");
}

function renderEmployeeWeekBalance(entries) {
  const totalMs = entries.reduce((total, entry) => total + getEntryDurationMs(entry), 0);
  const shifts = entries.length;

  if (!entries.length) {
    elements.timeclockWeekSummary.innerHTML = `
      <article class="week-balance-card">
        <p class="eyebrow">Balance semanal</p>
        <strong>${formatDuration(0)}</strong>
        <span>No hay fichajes para esta semana.</span>
      </article>
    `;
    return;
  }

  const rows = Object.values(
    entries.reduce((acc, entry) => {
      const date = getTimeEntryDate(entry);
      if (!acc[date]) {
        acc[date] = {
          date,
          totalMs: 0,
          shifts: 0,
        };
      }
      acc[date].totalMs += getEntryDurationMs(entry);
      acc[date].shifts += 1;
      return acc;
    }, {}),
  ).sort((a, b) => a.date.localeCompare(b.date));

  elements.timeclockWeekSummary.innerHTML = `
    <article class="week-balance-card">
      <p class="eyebrow">Balance semanal</p>
      <strong>${formatDuration(totalMs)}</strong>
      <span>${shifts} jornada${shifts === 1 ? "" : "s"} registrada${shifts === 1 ? "" : "s"}</span>
    </article>
    ${rows
      .map(
        (row) => `
          <article class="week-day-row">
            <div>
              <strong>${escapeHtml(formatWeekday(row.date))}</strong>
              <span>${row.shifts} fichaje${row.shifts === 1 ? "" : "s"}</span>
            </div>
            <b>${formatDuration(row.totalMs)}</b>
          </article>
        `,
      )
      .join("")}
  `;
}

function renderEmployeeTimesheet() {

  const selectedUserId = elements.timesheetUserSelect.value;
  const users = [...state.users]
    .sort((a, b) => a.name.localeCompare(b.name, "es"));

  elements.timesheetUserSelect.innerHTML = `
    <option value="">Selecciona un usuario</option>
    ${users
      .map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)}${user.active ? "" : " (inactivo)"}</option>`)
      .join("")}
  `;
  elements.timesheetUserSelect.value = users.some((user) => user.id === selectedUserId)
    ? selectedUserId
    : "";

  if (!users.length) {
    elements.exportTimesheetBtn.disabled = true;
    elements.timesheetOverview.innerHTML = `<div class="empty-state">No hay usuarios registrados.</div>`;
    elements.timesheetTable.innerHTML = `<tr><td class="empty-state" colspan="6">Sin datos disponibles.</td></tr>`;
    return;
  }

  const selectedUser = users.find((user) => user.id === elements.timesheetUserSelect.value);
  if (!selectedUser) {
    elements.exportTimesheetBtn.disabled = true;
    elements.timesheetOverview.innerHTML = `
      <div class="empty-state timesheet-prompt">Selecciona un usuario y un mes para consultar su balance mensual.</div>
    `;
    elements.timesheetTable.innerHTML = `<tr><td class="empty-state" colspan="6">Realiza una consulta para ver las horas del empleado.</td></tr>`;
    return;
  }

  const monthValue = elements.timesheetMonth.value;
  if (!monthValue) {
    elements.exportTimesheetBtn.disabled = true;
    return;
  }
  elements.exportTimesheetBtn.disabled = false;
  const [year, month] = monthValue.split("-").map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthEntries = state.timeEntries
    .filter((entry) => {
      const sameUser = entry.userId
        ? entry.userId === selectedUser.id
        : normalizeName(entry.seller) === normalizeName(selectedUser.name);
      return sameUser && getTimeEntryDate(entry).startsWith(monthValue);
    })
    .sort((a, b) => new Date(a.clockInAt) - new Date(b.clockInAt));

  const entriesByDay = monthEntries.reduce((days, entry) => {
    const date = getTimeEntryDate(entry);
    if (!days[date]) days[date] = [];
    days[date].push(entry);
    return days;
  }, {});
  const totalMs = monthEntries.reduce((total, entry) => total + getEntryDurationMs(entry), 0);
  const workedDays = Object.keys(entriesByDay).length;
  const openEntries = monthEntries.filter((entry) => !entry.clockOutAt).length;

  elements.timesheetOverview.innerHTML = `
    <article>
      <p class="eyebrow">Empleado</p>
      <strong>${escapeHtml(selectedUser.name)}</strong>
      <span>${workedDays} dias trabajados</span>
    </article>
    <article>
      <p class="eyebrow">Balance mensual</p>
      <strong>${formatDuration(totalMs)}</strong>
      <span>${monthEntries.length} sesiones registradas</span>
    </article>
    <article>
      <p class="eyebrow">Incidencias</p>
      <strong>${openEntries}</strong>
      <span>sesiones abiertas</span>
    </article>
  `;

  elements.timesheetTable.innerHTML = Array.from({ length: daysInMonth }, (_, index) => {
    const date = `${monthValue}-${String(index + 1).padStart(2, "0")}`;
    const entries = entriesByDay[date] || [];
    const dayTotal = entries.reduce((total, entry) => total + getEntryDurationMs(entry), 0);
    const locations = [...new Set(entries.map((entry) => entry.location).filter(Boolean))];
    const starts = entries.map((entry) => formatTime(entry.clockInAt)).join(" / ");
    const ends = entries.map((entry) => (entry.clockOutAt ? formatTime(entry.clockOutAt) : "Abierta")).join(" / ");
    return `
      <tr class="${entries.length ? "" : "timesheet-empty-day"}">
        <td data-label="Día"><strong>${escapeHtml(formatWeekday(date))}</strong><span>${formatDate(date)}</span></td>
        <td data-label="Entrada">${starts || "-"}</td>
        <td data-label="Salida">${ends || "-"}</td>
        <td data-label="Centro">${locations.length ? escapeHtml(locations.join(" / ")) : "-"}</td>
        <td data-label="Sesiones">${entries.length || "-"}</td>
        <td data-label="Total"><strong>${entries.length ? formatDuration(dayTotal) : "-"}</strong></td>
      </tr>
    `;
  }).join("");
}
async function exportEmployeeTimesheetPdf() {
  const user = state.users.find((item) => item.id === elements.timesheetUserSelect.value);
  const monthValue = elements.timesheetMonth.value;
  if (!user || !monthValue) {
    alert("Consulta primero un empleado y un mes.");
    return;
  }

  const originalLabel = elements.exportTimesheetBtn.textContent;
  elements.exportTimesheetBtn.disabled = true;
  elements.exportTimesheetBtn.textContent = "Creando PDF...";

  try {
    const logoResponse = await fetch("assets/logo-criptoshishas.jpeg");
    if (!logoResponse.ok) throw new Error("No se pudo cargar el logotipo");
    const logoBytes = new Uint8Array(await logoResponse.arrayBuffer());
    const report = getEmployeeTimesheetReport(user, monthValue);
    const pdfBlob = createTimesheetPdf(report, logoBytes);
    const url = URL.createObjectURL(pdfBlob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `fichaje-${normalizeName(user.name).replace(/\s+/g, "-")}-${monthValue}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    console.error(error);
    alert("No se ha podido crear el PDF de fichaje.");
  } finally {
    elements.exportTimesheetBtn.disabled = false;
    elements.exportTimesheetBtn.textContent = originalLabel;
  }
}

function getEmployeeTimesheetReport(user, monthValue) {
  const [year, month] = monthValue.split("-").map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const entries = state.timeEntries
    .filter((entry) => {
      const sameUser = entry.userId
        ? entry.userId === user.id
        : normalizeName(entry.seller) === normalizeName(user.name);
      return sameUser && getTimeEntryDate(entry).startsWith(monthValue);
    })
    .sort((a, b) => new Date(a.clockInAt) - new Date(b.clockInAt));
  const entriesByDay = entries.reduce((days, entry) => {
    const date = getTimeEntryDate(entry);
    if (!days[date]) days[date] = [];
    days[date].push(entry);
    return days;
  }, {});
  const days = Array.from({ length: daysInMonth }, (_, index) => {
    const date = `${monthValue}-${String(index + 1).padStart(2, "0")}`;
    const dayEntries = entriesByDay[date] || [];
    return {
      date,
      entries: dayEntries,
      starts: dayEntries.map((entry) => formatTime(entry.clockInAt)).join(" / ") || "-",
      ends: dayEntries.map((entry) => (entry.clockOutAt ? formatTime(entry.clockOutAt) : "ABIERTA")).join(" / ") || "-",
      locations: [...new Set(dayEntries.map((entry) => entry.location).filter(Boolean))].join(" / ") || "-",
      total: dayEntries.length ? formatDuration(dayEntries.reduce((sum, entry) => sum + getEntryDurationMs(entry), 0)) : "-",
    };
  });
  return {
    user,
    monthValue,
    monthLabel: new Intl.DateTimeFormat("es-ES", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1)),
    entries,
    days,
    workedDays: days.filter((day) => day.entries.length).length,
    openEntries: entries.filter((entry) => !entry.clockOutAt).length,
    total: formatDuration(entries.reduce((sum, entry) => sum + getEntryDurationMs(entry), 0)),
  };
}

function createTimesheetPdf(report, logoBytes) {
  const pageWidth = 595;
  const pageHeight = 842;
  const rowsPerPage = 18;
  const pages = [];
  for (let index = 0; index < report.days.length; index += rowsPerPage) {
    pages.push(report.days.slice(index, index + rowsPerPage));
  }
  const objects = [];
  const pageIds = pages.map((_, index) => 6 + index * 2);
  objects[1] = pdfAscii("<< /Type /Catalog /Pages 2 0 R >>");
  objects[2] = pdfAscii(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects[3] = pdfAscii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects[4] = pdfAscii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  objects[5] = joinPdfBytes([
    pdfAscii(`<< /Type /XObject /Subtype /Image /Width 828 /Height 1472 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logoBytes.length} >>\nstream\n`),
    logoBytes,
    pdfAscii("\nendstream"),
  ]);

  pages.forEach((days, index) => {
    const pageId = pageIds[index];
    const contentId = pageId + 1;
    const commands = createTimesheetPageCommands(report, days, index, pages.length, pageWidth, pageHeight);
    const commandBytes = pdfAscii(commands);
    objects[pageId] = pdfAscii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << /Logo 5 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects[contentId] = joinPdfBytes([
      pdfAscii(`<< /Length ${commandBytes.length} >>\nstream\n`),
      commandBytes,
      pdfAscii("\nendstream"),
    ]);
  });

  const parts = [pdfAscii("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")];
  const offsets = [0];
  let length = parts[0].length;
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = length;
    const objectBytes = joinPdfBytes([pdfAscii(`${id} 0 obj\n`), objects[id], pdfAscii("\nendobj\n")]);
    parts.push(objectBytes);
    length += objectBytes.length;
  }
  const xrefOffset = length;
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  parts.push(pdfAscii(xref));
  return new Blob(parts, { type: "application/pdf" });
}

function createTimesheetPageCommands(report, days, pageIndex, pageCount, pageWidth, pageHeight) {
  const green = "0.055 0.235 0.180";
  const mint = "0.835 0.925 0.890";
  const pale = "0.965 0.975 0.970";
  const ink = "0.075 0.105 0.095";
  const muted = "0.390 0.445 0.420";
  const commands = [
    `1 1 1 rg 0 0 ${pageWidth} ${pageHeight} re f`,
    `${green} rg 0 700 ${pageWidth} 142 re f`,
    "1 1 1 rg 30 718 66 106 re f",
    "q 66 0 0 106 30 718 cm /Logo Do Q",
    pdfText("CRIPTOSHISHAS", 120, 792, 22, true, "1 1 1"),
    pdfText("HOJA MENSUAL DE FICHAJE", 120, 760, 14, true, "0.760 0.925 0.845"),
    pdfText(report.user.name, 120, 733, 12, true, "1 1 1"),
    pdfText(report.monthLabel.toUpperCase(), 120, 714, 9, false, "0.820 0.900 0.860"),
  ];

  if (pageIndex === 0) {
    commands.push(`${pale} rg 28 625 539 56 re f`);
    commands.push(pdfText("TOTAL MENSUAL", 46, 657, 8, true, muted));
    commands.push(pdfText(report.total, 46, 636, 17, true, green));
    commands.push(pdfText("DIAS TRABAJADOS", 218, 657, 8, true, muted));
    commands.push(pdfText(String(report.workedDays), 218, 636, 17, true, green));
    commands.push(pdfText("SESIONES", 376, 657, 8, true, muted));
    commands.push(pdfText(String(report.entries.length), 376, 636, 17, true, green));
    commands.push(pdfText("ABIERTAS", 492, 657, 8, true, muted));
    commands.push(pdfText(String(report.openEntries), 492, 636, 17, true, report.openEntries ? "0.760 0.180 0.140" : green));
  }

  const tableTop = pageIndex === 0 ? 596 : 665;
  const rowHeight = 27;
  const columns = [28, 112, 174, 236, 386, 457, 567];
  commands.push(`${green} rg 28 ${tableTop} 539 28 re f`);
  ["DIA", "ENTRADA", "SALIDA", "CENTRO", "SES.", "TOTAL"].forEach((label, index) => {
    commands.push(pdfText(label, columns[index] + 7, tableTop + 10, 7.5, true, "1 1 1"));
  });

  days.forEach((day, index) => {
    const y = tableTop - (index + 1) * rowHeight;
    commands.push(`${index % 2 === 0 ? pale : "1 1 1"} rg 28 ${y} 539 ${rowHeight} re f`);
    const hasEntries = day.entries.length > 0;
    const textColor = hasEntries ? ink : "0.620 0.650 0.635";
    commands.push(pdfText(formatDate(day.date), 35, y + 10, 8, true, textColor));
    commands.push(pdfText(truncatePdfText(day.starts, 12), 119, y + 10, 8, false, textColor));
    commands.push(pdfText(truncatePdfText(day.ends, 12), 181, y + 10, 8, false, day.ends.includes("ABIERTA") ? "0.760 0.180 0.140" : textColor));
    commands.push(pdfText(truncatePdfText(day.locations, 25), 243, y + 10, 8, false, textColor));
    commands.push(pdfText(String(day.entries.length || "-"), 407, y + 10, 8, false, textColor));
    commands.push(pdfText(day.total, 464, y + 10, 8, true, hasEntries ? green : textColor));
  });

  commands.push(`${green} rg 28 42 539 2 re f`);
  commands.push(pdfText("Documento de control horario", 28, 24, 7.5, false, muted));
  commands.push(pdfText(`Generado: ${formatDate(toDateInputValue(new Date()))}`, 225, 24, 7.5, false, muted));
  commands.push(pdfText(`Página ${pageIndex + 1} de ${pageCount}`, 500, 24, 7.5, false, muted));
  return commands.join("\n");
}
function renderTimeclockTable(entries) {
  const canEdit = isManager();
  if (!entries.length) {
    elements.timeclockTable.innerHTML = `
      <tr>
        <td class="empty-state" colspan="${canEdit ? 7 : 6}">No hay registros horarios para este dia.</td>
      </tr>
    `;
    return;
  }

  elements.timeclockTable.innerHTML = entries
    .map(
      (entry) => `
        <tr>
          <td data-label="Trabajador">${escapeHtml(entry.seller)}</td>
          <td data-label="Centro">${escapeHtml(entry.location)}</td>
          <td data-label="Entrada">${formatTime(entry.clockInAt)}</td>
          <td data-label="Salida">${entry.clockOutAt ? formatTime(entry.clockOutAt) : "Abierta"}</td>
          <td data-label="Total">${formatDuration(getEntryDurationMs(entry))}</td>
          <td data-label="Tipo">${entry.source === "manual" ? `Manual${entry.note ? ` · ${escapeHtml(entry.note)}` : ""}` : "Fichaje"}</td>
          ${canEdit ? `
            <td class="table-actions" data-label="Acciones">
              <button class="inline-action" type="button" data-edit-time-entry="${escapeHtml(entry.id)}">Editar</button>
              <button class="delete-sale" type="button" data-delete-time-entry="${escapeHtml(entry.id)}">Borrar</button>
            </td>
          ` : ""}
        </tr>
      `,
    )
    .join("");

  if (!canEdit) return;
  elements.timeclockTable.querySelectorAll("[data-edit-time-entry]").forEach((button) => {
    button.addEventListener("click", () => editTimeEntry(button.dataset.editTimeEntry));
  });
  elements.timeclockTable.querySelectorAll("[data-delete-time-entry]").forEach((button) => {
    button.addEventListener("click", () => deleteTimeEntry(button.dataset.deleteTimeEntry));
  });
}
function setDashboardRange(range) {
  const now = new Date();
  let from = new Date(now.getFullYear(), now.getMonth(), 1);
  if (range === "today") from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "7") {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    from.setDate(from.getDate() - 6);
  }
  elements.dashboardDateFrom.value = toDateInputValue(from);
  elements.dashboardDateTo.value = toDateInputValue(now);
  renderStats();
}

function getDashboardFilteredOrders() {
  const dateFrom = elements.dashboardDateFrom.value;
  const dateTo = elements.dashboardDateTo.value;
  const location = elements.dashboardLocation.value;
  const seller = elements.dashboardSeller.value;
  const category = elements.dashboardCategory.value;
  const payment = elements.dashboardPayment.value;

  return getOrdersVisibleToCurrentUser()
    .filter((order) => {
      const orderDate = getLocalDateValue(order.createdAt);
      return (!dateFrom || orderDate >= dateFrom) && (!dateTo || orderDate <= dateTo);
    })
    .filter((order) => location === "Todos los centros" || order.location === location)
    .filter((order) => seller === "Todos los trabajadores" || order.seller === seller)
    .filter((order) => category === "all" || (category === PRODUCT.vape ? isVapeOrder(order) : !isVapeOrder(order)))
    .filter((order) => payment === "all" || order.paymentMethod === payment);
}

function renderStats() {
  const filteredOrders = getDashboardFilteredOrders();
  const paidOrders = filteredOrders.filter((order) => order.status === STATUS.paid);
  const pendingOrders = filteredOrders.filter((order) => order.status === STATUS.preparation);
  const vapeOrders = paidOrders.filter(isVapeOrder);
  const hookahOrders = paidOrders.filter((order) => !isVapeOrder(order));
  const cardOrders = paidOrders.filter((order) => order.paymentMethod === PAYMENT.card);
  const cashOrders = paidOrders.filter((order) => order.paymentMethod === PAYMENT.cash);
  const revenue = sumOrders(paidOrders);
  const vapeUnits = vapeOrders.reduce((total, order) => total + getOrderUnitCount(order), 0);
  const hookahUnits = hookahOrders.reduce((total, order) => total + getOrderUnitCount(order), 0);
  const units = vapeUnits + hookahUnits;

  elements.dashboardRevenue.textContent = formatMoney(revenue);
  elements.dashboardRevenueMeta.textContent = `${paidOrders.length} ${paidOrders.length === 1 ? "pedido cobrado" : "pedidos cobrados"}`;
  elements.dashboardUnits.textContent = units;
  elements.dashboardUnitsMeta.textContent = `${vapeUnits} vapers · ${hookahUnits} cachimbas`;
  elements.dashboardAverageTicket.textContent = formatMoney(paidOrders.length ? revenue / paidOrders.length : 0);
  elements.dashboardCardRevenue.textContent = formatMoney(sumOrders(cardOrders));
  elements.dashboardCardMeta.textContent = `${cardOrders.length} ${cardOrders.length === 1 ? "cobro" : "cobros"}`;
  elements.dashboardCashRevenue.textContent = formatMoney(sumOrders(cashOrders));
  elements.dashboardCashMeta.textContent = `${cashOrders.length} ${cashOrders.length === 1 ? "cobro" : "cobros"}`;
  elements.dashboardPending.textContent = pendingOrders.length;
  elements.dashboardPendingMeta.textContent = `${formatMoney(sumOrders(pendingOrders))} pendientes`;
  elements.dashboardPeriodLabel.textContent = getDashboardPeriodLabel();

  renderDashboardTrend(paidOrders);
  renderDashboardDonut(
    elements.dashboardCategoryDonut,
    elements.dashboardCategoryTotal,
    elements.dashboardCategoryLegend,
    [
      { label: "Vaper", value: sumOrders(vapeOrders), count: vapeUnits, color: "#2563eb", filter: PRODUCT.vape },
      { label: "Cachimba", value: sumOrders(hookahOrders), count: hookahUnits, color: "#166534", filter: PRODUCT.hookah },
    ],
    "category",
    elements.dashboardCategory.value,
  );
  renderDashboardDonut(
    elements.dashboardPaymentDonut,
    elements.dashboardPaymentTotal,
    elements.dashboardPaymentLegend,
    [
      { label: "Tarjeta", value: sumOrders(cardOrders), count: cardOrders.length, color: "#0f766e", filter: PAYMENT.card },
      { label: "Efectivo", value: sumOrders(cashOrders), count: cashOrders.length, color: "#d97706", filter: PAYMENT.cash },
    ],
    "payment",
    elements.dashboardPayment.value,
  );

  renderRevenueRanking(elements.locationReport, aggregateDashboardOrders(paidOrders, "location"));
  renderRevenueRanking(elements.sellerReport, aggregateDashboardOrders(paidOrders, "seller"));
  renderDashboardCategoryTable(vapeOrders, hookahOrders, revenue);
  renderDashboardProductRanking(paidOrders);
  renderDashboardCustomers(paidOrders);
}

function getDashboardPeriodLabel() {
  const from = elements.dashboardDateFrom.value;
  const to = elements.dashboardDateTo.value;
  if (!from && !to) return "Todo el histórico";
  if (from && to && from === to) return formatDate(from);
  return `${from ? formatDate(from) : "Inicio"} – ${to ? formatDate(to) : "Hoy"}`;
}

function renderDashboardTrend(orders) {
  const series = buildDashboardSeries(orders);
  if (!series.length) {
    elements.dashboardTrend.innerHTML = `<div class="empty-state">No hay ventas cobradas para este periodo.</div>`;
    return;
  }
  const max = Math.max(...series.map((item) => item.value), 1);
  elements.dashboardTrend.innerHTML = `
    <div class="trend-scale"><span>${formatMoney(max)}</span><span>${formatMoney(max / 2)}</span><span>0 €</span></div>
    <div class="trend-bars" style="--trend-columns:${series.length}">
      ${series.map((item, index) => {
        const height = item.value ? Math.max((item.value / max) * 100, 4) : 0;
        const showLabel = series.length <= 12 || index === 0 || index === series.length - 1 || index % Math.ceil(series.length / 8) === 0;
        return `<div class="trend-column" title="${escapeHtml(item.fullLabel)}: ${escapeHtml(formatMoney(item.value))} · ${item.orders} pedidos"><span>${item.value ? escapeHtml(formatMoney(item.value)) : ""}</span><div class="trend-bar-wrap"><div class="trend-bar" style="height:${height}%"></div></div><small>${showLabel ? escapeHtml(item.label) : ""}</small></div>`;
      }).join("")}
    </div>`;
}

function buildDashboardSeries(orders) {
  const orderDates = orders.map((order) => getLocalDateValue(order.createdAt)).filter(Boolean).sort();
  const fromValue = elements.dashboardDateFrom.value || orderDates[0];
  const toValue = elements.dashboardDateTo.value || orderDates.at(-1);
  if (!fromValue || !toValue || fromValue > toValue) return [];
  const from = new Date(`${fromValue}T12:00:00`);
  const to = new Date(`${toValue}T12:00:00`);
  const dayCount = Math.floor((to - from) / 86400000) + 1;
  const monthly = dayCount > 45;
  const grouped = orders.reduce((acc, order) => {
    const localDate = getLocalDateValue(order.createdAt);
    const key = monthly ? localDate.slice(0, 7) : localDate;
    if (!acc[key]) acc[key] = { value: 0, orders: 0 };
    acc[key].value += Number(order.price || 0);
    acc[key].orders += 1;
    return acc;
  }, {});
  const series = [];
  if (monthly) {
    const cursor = new Date(from.getFullYear(), from.getMonth(), 1, 12);
    const end = new Date(to.getFullYear(), to.getMonth(), 1, 12);
    while (cursor <= end) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
      const label = new Intl.DateTimeFormat("es-ES", { month: "short", year: "2-digit" }).format(cursor);
      series.push({ key, label, fullLabel: label, value: grouped[key]?.value || 0, orders: grouped[key]?.orders || 0 });
      cursor.setMonth(cursor.getMonth() + 1);
    }
  } else {
    const cursor = new Date(from);
    while (cursor <= to) {
      const key = toDateInputValue(cursor);
      const label = new Intl.DateTimeFormat("es-ES", { day: "2-digit", month: "short" }).format(cursor);
      series.push({ key, label, fullLabel: formatDate(key), value: grouped[key]?.value || 0, orders: grouped[key]?.orders || 0 });
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return series;
}

function renderDashboardDonut(container, totalElement, legend, segments, filterType, selectedValue) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  let cursor = 0;
  const stops = segments.filter((segment) => segment.value > 0).map((segment) => {
    const start = cursor;
    cursor += (segment.value / total) * 360;
    return `${segment.color} ${start}deg ${cursor}deg`;
  });
  container.style.background = stops.length ? `conic-gradient(${stops.join(",")})` : "conic-gradient(#e2e8f0 0deg 360deg)";
  container.setAttribute("aria-label", segments.map((segment) => `${segment.label}: ${formatMoney(segment.value)}`).join(", "));
  totalElement.textContent = formatMoney(total);
  legend.innerHTML = segments.map((segment) => {
    const percent = total ? Math.round((segment.value / total) * 100) : 0;
    return `<button type="button" class="legend-item${selectedValue === segment.filter ? " active" : ""}" data-dashboard-filter="${filterType}" data-value="${segment.filter}"><i style="background:${segment.color}"></i><span><b>${escapeHtml(segment.label)}</b><small>${formatMoney(segment.value)} · ${percent}% · ${segment.count}</small></span></button>`;
  }).join("");
}

function aggregateDashboardOrders(orders, key) {
  const grouped = orders.reduce((acc, order) => {
    const label = order[key] || "Sin asignar";
    if (!acc[label]) acc[label] = { label, revenue: 0, orders: 0, units: 0 };
    acc[label].revenue += Number(order.price || 0);
    acc[label].orders += 1;
    acc[label].units += getOrderUnitCount(order);
    return acc;
  }, {});
  return Object.values(grouped).sort((a, b) => b.revenue - a.revenue);
}

function renderRevenueRanking(container, rows) {
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">Sin datos para los filtros seleccionados.</div>`;
    return;
  }
  const max = Math.max(...rows.map((row) => row.revenue), 1);
  container.innerHTML = rows.slice(0, 10).map((row) => `<div class="analytics-bar"><div><strong>${escapeHtml(row.label)}</strong><span>${row.orders} pedidos · ${row.units} unidades</span></div><b>${formatMoney(row.revenue)}</b><div class="analytics-track"><i style="width:${Math.max((row.revenue / max) * 100, 3)}%"></i></div></div>`).join("");
}

function renderDashboardCategoryTable(vapeOrders, hookahOrders, totalRevenue) {
  const rows = [
    { label: "Vaper", orders: vapeOrders, className: "vape" },
    { label: "Cachimba", orders: hookahOrders, className: "hookah" },
  ];
  elements.dashboardCategoryTable.innerHTML = rows.map((row) => {
    const revenue = sumOrders(row.orders);
    const units = row.orders.reduce((total, order) => total + getOrderUnitCount(order), 0);
    const weight = totalRevenue ? Math.round((revenue / totalRevenue) * 100) : 0;
    return `<tr><td><span class="category-dot ${row.className}"></span>${row.label}</td><td>${row.orders.length}</td><td>${units}</td><td>${formatMoney(revenue)}</td><td>${formatMoney(row.orders.length ? revenue / row.orders.length : 0)}</td><td>${weight}%</td></tr>`;
  }).join("");
}

function renderDashboardProductRanking(orders) {
  const products = {};
  orders.forEach((order) => {
    if (isVapeOrder(order)) {
      getOrderVapeItems(order).forEach((item) => {
        const label = `Vaper · ${item.vaperName || "Sin nombre"}`;
        products[label] = (products[label] || 0) + Math.max(Number(item.quantity || 1), 1);
      });
      return;
    }
    getOrderHookahItems(order).forEach((item) => {
      item.flavors.forEach((flavor) => {
        const label = `Cachimba · ${flavor.name}`;
        products[label] = (products[label] || 0) + Math.max(Number(item.quantity || 1), 1);
      });
    });
  });
  const rows = Object.entries(products).map(([label, units]) => ({ label, units })).sort((a, b) => b.units - a.units).slice(0, 10);
  if (!rows.length) {
    elements.dashboardProductRanking.innerHTML = `<div class="empty-state">Sin productos vendidos en el periodo.</div>`;
    return;
  }
  const max = Math.max(...rows.map((row) => row.units), 1);
  elements.dashboardProductRanking.innerHTML = rows.map((row) => `<div class="analytics-bar demand"><div><strong>${escapeHtml(row.label)}</strong><span>Demanda registrada</span></div><b>${row.units}</b><div class="analytics-track"><i style="width:${Math.max((row.units / max) * 100, 3)}%"></i></div></div>`).join("");
}

function renderDashboardCustomers(orders) {
  const grouped = orders.reduce((acc, order) => {
    const key = getCustomerKey(order.customer);
    if (!key) return acc;
    if (!acc[key]) acc[key] = { name: cleanCustomerName(order.customer), orders: 0, units: 0, revenue: 0, lastOrderAt: order.paidAt || order.createdAt };
    acc[key].orders += 1;
    acc[key].units += getOrderUnitCount(order);
    acc[key].revenue += Number(order.price || 0);
    if (new Date(order.paidAt || order.createdAt) > new Date(acc[key].lastOrderAt)) acc[key].lastOrderAt = order.paidAt || order.createdAt;
    return acc;
  }, {});
  const rows = Object.values(grouped).sort((a, b) => b.revenue - a.revenue).slice(0, 12);
  elements.customerReport.innerHTML = rows.length
    ? rows.map((customer) => `<tr><td>${escapeHtml(customer.name)}</td><td>${customer.orders}</td><td>${customer.units}</td><td>${formatMoney(customer.revenue)}</td><td>${formatShortDateTime(customer.lastOrderAt)}</td></tr>`).join("")
    : `<tr><td class="empty-state" colspan="5">No hay clientes identificados para estos filtros.</td></tr>`;
}
function renderSettings() {
  renderLocationSettings();
  if (isManager()) {
    renderUserManagement();
  }
}

function renderStock() {
  renderVaperStock();
  renderPills(elements.flavorList, state.flavors, "flavors");
}


function renderVaperStock() {
  if (!state.vapers.length) {
    elements.vaperStockList.innerHTML = `<div class="empty-state">No hay vapers en inventario.</div>`;
    return;
  }

  elements.vaperStockList.innerHTML = state.vapers
    .map(
      (vaper) => `
        <article class="stock-item">
          <div class="stock-item-main">
            <strong>${escapeHtml(vaper.name)}</strong>
            <span>${vaper.stock} unidades</span>
          </div>
          <div class="stock-item-controls">
            <label>
              Stock
              <input type="number" min="0" step="1" value="${vaper.stock}" data-vaper-stock="${escapeHtml(vaper.id)}" />
            </label>
          </div>
          <div class="stock-item-actions">
            <button class="delete-sale" type="button" data-delete-vaper="${escapeHtml(vaper.id)}">Borrar</button>
          </div>
        </article>
      `,
    )
    .join("");

  elements.vaperStockList.querySelectorAll("[data-vaper-stock]").forEach((input) => {
    input.addEventListener("change", () => updateVaperItem(input.dataset.vaperStock, "stock", input.value));
  });

  elements.vaperStockList.querySelectorAll("[data-delete-vaper]").forEach((button) => {
    button.addEventListener("click", () => deleteVaperItem(button.dataset.deleteVaper));
  });
}




function renderLocationSettings() {
  elements.locationList.innerHTML = state.locations
    .map((location) => {
      const config = getLocationConfig(location);
      return `
        <article class="location-config">
          <header>
            <strong>${escapeHtml(location)}</strong>
            <button type="button" data-type="locations" data-value="${escapeHtml(location)}">x</button>
          </header>
          <label>
            Precio recomendado cachimba
            <input type="number" min="0" step="0.5" value="${config.hookahRecommendedPrice}" data-location-hookah-price="${escapeHtml(location)}" />
          </label>
          <label>
            Precio recomendado vaper
            <input type="number" min="0" step="0.5" value="${config.vapeRecommendedPrice}" data-location-vape-price="${escapeHtml(location)}" />
          </label>
          <label>
            Comisión
            <input type="number" min="0" step="0.5" value="${config.commission}" data-location-commission="${escapeHtml(location)}" />
          </label>
        </article>
      `;
    })
    .join("");

  elements.locationList.querySelectorAll("[data-type='locations']").forEach((button) => {
    button.addEventListener("click", () => removeListItem(button.dataset.type, button.dataset.value));
  });

  elements.locationList.querySelectorAll("[data-location-hookah-price]").forEach((input) => {
    input.addEventListener("change", () =>
      updateLocationConfig(input.dataset.locationHookahPrice, "hookahRecommendedPrice", input.value),
    );
  });

  elements.locationList.querySelectorAll("[data-location-vape-price]").forEach((input) => {
    input.addEventListener("change", () =>
      updateLocationConfig(input.dataset.locationVapePrice, "vapeRecommendedPrice", input.value),
    );
  });

  elements.locationList.querySelectorAll("[data-location-commission]").forEach((input) => {
    input.addEventListener("change", () => updateLocationConfig(input.dataset.locationCommission, "commission", input.value));
  });
}

function updateLocationConfig(location, key, value) {
  const config = getLocationConfig(location);
  config[key] = Number(value || 0);
  saveState();
  if (
    location === state.session.location &&
    ((productType === PRODUCT.hookah && key === "hookahRecommendedPrice") ||
      (productType === PRODUCT.vape && key === "vapeRecommendedPrice"))
  ) {
    applyRecommendedPrice();
  } else {
    renderPriceControls();
  }
  renderStats();
}

function renderPills(container, items, type) {
  container.innerHTML = items
    .map(
      (item) => `
      <span class="pill">
        ${escapeHtml(item)}
        <button type="button" aria-label="Eliminar ${escapeHtml(item)}" data-type="${type}" data-value="${escapeHtml(item)}">x</button>
      </span>
    `,
    )
    .join("");

  container.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => removeListItem(button.dataset.type, button.dataset.value));
  });
}

function addVaperItem(event) {
  event.preventDefault();
  if (!isManager()) return;

  const name = elements.newVaperNameInput.value.trim();
  const stock = Number(elements.newVaperStockInput.value || 0);
  if (!name || stock < 0) return;
  if (state.vapers.some((vaper) => normalize(vaper.name) === normalize(name))) {
    alert("Este vaper ya existe en inventario.");
    return;
  }

  state.vapers.push({
    id: crypto.randomUUID(),
    name,
    price: 0,
    stock,
  });

  elements.newVaperNameInput.value = "";
  elements.newVaperStockInput.value = "";
  saveState();
  renderAll();
}

function updateVaperItem(vaperId, key, value) {
  if (!isManager()) return;
  state.vapers = state.vapers.map((vaper) =>
    vaper.id === vaperId ? { ...vaper, [key]: Math.max(Number(value || 0), 0) } : vaper,
  );
  saveState();
  renderAll();
}

function deleteVaperItem(vaperId) {
  if (!isManager()) return;
  if (!confirm("Seguro que quieres eliminar este vaper del inventario?")) return;
  state.vapers = state.vapers.filter((vaper) => vaper.id !== vaperId);
  saveState();
  renderAll();
}








function addListItem(event, key, inputKey) {
  event.preventDefault();
  const input = elements[inputKey];
  const value = input.value.trim();
  if (!value || state[key].some((item) => normalize(item) === normalize(value))) return;

  state[key].push(value);
  if (key === "locations") {
    state.locationSettings[value] = { hookahRecommendedPrice: 10, vapeRecommendedPrice: 10, commission: 0 };
    if (!state.session.location) state.session.location = value;
  }
  input.value = "";
  saveState();
  renderAll();
}

function removeListItem(key, value) {
  if (state[key].length <= 1 && key !== "flavors") return;
  state[key] = state[key].filter((item) => item !== value);
  if (key === "locations") delete state.locationSettings[value];

  if (key === "locations" && state.session.location === value) state.session.location = state.locations[0] || "";

  saveState();
  renderAll();
}

function clearOrders() {
  if (!confirm("Seguro que quieres borrar todos los pedidos guardados en todos los dispositivos?")) return;
  state.orders = [];
  if (firebaseSyncReady && window.FirebaseService) {
    FirebaseService.deleteAllOrders().catch((error) => {
      console.error("No se pudieron borrar todos los pedidos de Firestore:", error);
    });
  }
  saveState();
  renderAll();
}

async function downloadMenuPdf() {
  const vaperNames = state.vapers
    .map((vaper) => vaper.name.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "es"));
  const hookahFlavors = [...state.flavors]
    .map((flavor) => flavor.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "es"));

  const originalLabel = elements.downloadMenuBtn.textContent;
  elements.downloadMenuBtn.disabled = true;
  elements.downloadMenuBtn.textContent = "Creando carta...";

  try {
    const logoResponse = await fetch("assets/logo-criptoshishas.jpeg");
    if (!logoResponse.ok) throw new Error("No se pudo cargar el logotipo");
    const logoBytes = new Uint8Array(await logoResponse.arrayBuffer());
    const pdfBlob = createCatalogPdf(vaperNames, hookahFlavors, logoBytes);
    const url = URL.createObjectURL(pdfBlob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `carta-criptoshishas-${toDateInputValue(new Date())}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    console.error(error);
    alert("No se ha podido crear la carta PDF.");
  } finally {
    elements.downloadMenuBtn.disabled = false;
    elements.downloadMenuBtn.textContent = originalLabel;
  }
}

function createCatalogPdf(vaperNames, hookahFlavors, logoBytes) {
  const pageWidth = 595;
  const pageHeight = 842;
  const itemsPerPage = 25;
  const vapers = vaperNames.length ? vaperNames : ["Sin vapers disponibles"];
  const hookahs = hookahFlavors.length ? hookahFlavors : ["Sin sabores disponibles"];
  const pageCount = Math.max(1, Math.ceil(Math.max(vapers.length, hookahs.length) / itemsPerPage));
  const pages = Array.from({ length: pageCount }, (_, index) => ({
    vapers: vapers.slice(index * itemsPerPage, (index + 1) * itemsPerPage),
    hookahs: hookahs.slice(index * itemsPerPage, (index + 1) * itemsPerPage),
  }));

  const objects = [];
  const pageIds = pages.map((_, index) => 6 + index * 2);
  objects[1] = pdfAscii("<< /Type /Catalog /Pages 2 0 R >>");
  objects[2] = pdfAscii(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects[3] = pdfAscii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects[4] = pdfAscii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  objects[5] = joinPdfBytes([
    pdfAscii(`<< /Type /XObject /Subtype /Image /Width 828 /Height 1472 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logoBytes.length} >>\nstream\n`),
    logoBytes,
    pdfAscii("\nendstream"),
  ]);

  pages.forEach((page, index) => {
    const pageId = pageIds[index];
    const contentId = pageId + 1;
    const commands = createCatalogPageCommands(page, index, pages.length, pageWidth, pageHeight);
    const commandBytes = pdfAscii(commands);
    objects[pageId] = pdfAscii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << /Logo 5 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects[contentId] = joinPdfBytes([
      pdfAscii(`<< /Length ${commandBytes.length} >>\nstream\n`),
      commandBytes,
      pdfAscii("\nendstream"),
    ]);
  });

  const parts = [pdfAscii("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")];
  const offsets = [0];
  let length = parts[0].length;
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = length;
    const objectBytes = joinPdfBytes([pdfAscii(`${id} 0 obj\n`), objects[id], pdfAscii("\nendobj\n")]);
    parts.push(objectBytes);
    length += objectBytes.length;
  }

  const xrefOffset = length;
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  parts.push(pdfAscii(xref));
  return new Blob(parts, { type: "application/pdf" });
}

function createCatalogPageCommands(page, pageIndex, pageCount, pageWidth, pageHeight) {
  const green = "0.055 0.235 0.180";
  const mint = "0.835 0.925 0.890";
  const pale = "0.965 0.975 0.970";
  const ink = "0.075 0.105 0.095";
  const muted = "0.390 0.445 0.420";
  const date = formatDate(toDateInputValue(new Date()));
  const commands = [
    `1 1 1 rg 0 0 ${pageWidth} ${pageHeight} re f`,
    `${green} rg 0 670 ${pageWidth} 172 re f`,
    "1 1 1 rg 34 690 82 132 re f",
    "q 82 0 0 132 34 690 cm /Logo Do Q",
    pdfText("CRIPTOSHISHAS", 140, 775, 25, true, "1 1 1"),
    pdfText("CARTA DE SABORES", 140, 741, 15, true, "0.760 0.925 0.845"),
    pdfText("Vapers y cachimbas", 140, 716, 11, false, "1 1 1"),
    pdfText(`Actualizada: ${date}`, 140, 694, 9, false, "0.800 0.875 0.840"),
    `${pale} rg 28 92 260 548 re f`,
    `${pale} rg 307 92 260 548 re f`,
    `${mint} rg 28 590 260 50 re f`,
    `${green} rg 307 590 260 50 re f`,
    pdfText("VAPERS", 48, 610, 15, true, green),
    pdfText(`${page.vapers.length} sabores`, 210, 611, 8, false, muted),
    pdfText("CACHIMBAS", 327, 610, 15, true, "1 1 1"),
    pdfText(`${page.hookahs.length} sabores`, 489, 611, 8, false, "0.820 0.920 0.875"),
  ];

  appendCatalogItems(commands, page.vapers, 48, 559, 220, green, ink);
  appendCatalogItems(commands, page.hookahs, 327, 559, 220, green, ink);

  commands.push(`${green} rg 28 58 539 2 re f`);
  commands.push(pdfText("CRIPTOSHISHAS", 28, 38, 8, true, green));
  commands.push(pdfText("Disfruta y comparte", 245, 38, 8, false, muted));
  commands.push(pdfText(`Página ${pageIndex + 1} de ${pageCount}`, 500, 38, 8, false, muted));
  return commands.join("\n");
}

function appendCatalogItems(commands, items, x, startY, width, accent, ink) {
  items.forEach((item, index) => {
    const y = startY - index * 19;
    if (index % 2 === 0) commands.push(`1 1 1 rg ${x - 8} ${y - 5} ${width + 16} 17 re f`);
    commands.push(`${accent} rg ${x} ${y + 1} 4 4 re f`);
    commands.push(pdfText(truncatePdfText(item, 31), x + 13, y, 9.5, false, ink));
  });
}

function pdfText(value, x, y, size, bold, color) {
  const text = escapePdfText(toPdfAscii(value));
  return `${color} rg BT /${bold ? "F2" : "F1"} ${size} Tf ${x} ${y} Td (${text}) Tj ET`;
}

function truncatePdfText(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function pdfAscii(value) {
  const text = String(value);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

function joinPdfBytes(parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  parts.forEach((part) => {
    result.set(part, offset);
    offset += part.length;
  });
  return result;
}

function toPdfAscii(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "-");
}

function escapePdfText(value) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
function exportExcel() {
  const rows = getFilteredHistory();
  const headers = [
    "FECHA",
    "HORA",
    "CENTRO",
    "TRABAJADOR",
    "CLIENTE",
    "CATEGORÍA",
    "UNIDADES",
    "PEDIDO",
    "ESTADO",
    "PAGO",
    "PRECIO",
    "COMISIÓN",
  ];
  const bodyRows = rows
    .map(
      (order, index) => `
        <tr class="${index % 2 === 0 ? "even" : "odd"}">
          <td class="date">${escapeHtml(getLocalDateValue(order.createdAt))}</td>
          <td>${escapeHtml(formatTime(order.createdAt))}</td>
          <td>${escapeHtml(order.location)}</td>
          <td>${escapeHtml(order.seller)}</td>
          <td>${escapeHtml(order.customer || "-")}</td>
          <td>${escapeHtml(getProductLabel(order))}</td>
          <td class="integer">${getOrderUnitCount(order)}</td>
          <td>${escapeHtml(formatSaleItem(order))}</td>
          <td>${escapeHtml(getStatusLabel(order.status))}</td>
          <td>${escapeHtml(getPaymentLabel(order.paymentMethod))}</td>
          <td class="decimal">${Number(order.price || 0).toFixed(2)}</td>
          <td class="decimal">${Number(order.commission || 0).toFixed(2)}</td>
        </tr>
      `,
    )
    .join("");
  const lastRow = Math.max(rows.length + 1, 2);
  const workbook = `
    <!doctype html>
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
      <head>
        <meta charset="UTF-8" />
        <!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Historial</x:Name><x:WorksheetOptions><x:FreezePanes/><x:FrozenNoSplit/><x:SplitHorizontal>1</x:SplitHorizontal><x:TopRowBottomPane>1</x:TopRowBottomPane><x:AutoFilter x:Range="R1C1:R${lastRow}C12"/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
        <style>
          table { border-collapse: collapse; font-family: Arial, sans-serif; font-size: 10pt; }
          th { padding: 8px; border: 1px solid #315b4b; background: #0e3c2e; color: #ffffff; font-weight: bold; text-align: left; }
          td { padding: 7px; border: 1px solid #c7d8d0; vertical-align: top; }
          .even td { background: #f3f8f5; }
          .odd td { background: #ffffff; }
          .date { mso-number-format: "yyyy-mm-dd"; }
          .integer { text-align: right; mso-number-format: "0"; }
          .decimal { text-align: right; mso-number-format: "0.00"; }
        </style>
      </head>
      <body>
        <table>
          <thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </body>
    </html>
  `;
  const blob = new Blob(["\uFEFF", workbook], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `pedidos-criptoshishas-${elements.historyDateFrom.value || "inicio"}-${elements.historyDateTo.value || "fin"}.xls`;
  link.click();
  URL.revokeObjectURL(url);
}function switchView(viewName) {
  if (!canAccessView(viewName)) {
    if (viewName !== "pos") switchView("pos");
    return;
  }

  const titles = {
    pos: "TPV",
    history: isEmployee() ? "Historial de hoy" : "Historial",
    stats: "Resumen",
    timeclock: "Fichaje",
    stock: "Stock",
    settings: "Ajustes",
  };

  elements.appShell.dataset.activeView = viewName;
  elements.navTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.view === viewName));
  elements.views.forEach((view) => view.classList.remove("active"));
  document.querySelector(`#${viewName}View`).classList.add("active");
  elements.viewTitle.textContent = titles[viewName];
}

function getOrdersVisibleToCurrentUser() {
  if (isManager()) return [...state.orders];
  return state.orders.filter((order) => order.location === state.session.location);
}

function getTimeEntriesVisibleToCurrentUser() {
  if (canViewFullTimeclock()) return [...state.timeEntries];
  return state.timeEntries.filter((entry) => entry.seller === currentUser.name);
}

function getOrdersForDate(date) {
  const value = toDateInputValue(date);
  return state.orders.filter((order) => getLocalDateValue(order.createdAt) === value);
}

function getKnownCustomers() {
  const customers = new Map();
  getOrdersVisibleToCurrentUser().forEach((order) => {
    const key = getCustomerKey(order.customer);
    if (!key) return;
    customers.set(key, cleanCustomerName(order.customer));
  });
  return [...customers.values()].sort((a, b) => a.localeCompare(b, "es"));
}

function getCustomerStats(orders) {
  const byCustomer = orders
    .filter((order) => order.status === STATUS.paid)
    .reduce((acc, order) => {
      const key = getCustomerKey(order.customer);
      if (!key) return acc;

      if (!acc[key]) {
        acc[key] = {
          name: cleanCustomerName(order.customer),
          count: 0,
          revenue: 0,
          lastOrderAt: order.paidAt || order.createdAt,
          flavorCounts: {},
        };
      }

      acc[key].count += 1;
      acc[key].revenue += Number(order.price || 0);
      if (new Date(order.paidAt || order.createdAt) > new Date(acc[key].lastOrderAt)) {
        acc[key].lastOrderAt = order.paidAt || order.createdAt;
        acc[key].name = cleanCustomerName(order.customer);
      }
      getOrderFlavors(order).forEach((flavor) => {
        acc[key].flavorCounts[flavor] = (acc[key].flavorCounts[flavor] || 0) + 1;
      });
      return acc;
    }, {});

  return Object.values(byCustomer)
    .map((customer) => ({
      ...customer,
      topFlavor: Object.entries(customer.flavorCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "",
    }))
    .sort((a, b) => b.revenue - a.revenue || b.count - a.count || a.name.localeCompare(b.name, "es"));
}

function cleanCustomerName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function getCustomerKey(value) {
  return cleanCustomerName(value).toLocaleLowerCase("es");
}

function getOrderFlavors(order) {
  return getOrderFlavorItems(order).map((flavor) => flavor.name);
}

function getOrderFlavorItems(order) {
  const hookahs = getOrderHookahItems(order);
  if (hookahs.length) {
    return hookahs.flatMap((hookah) => hookah.flavors);
  }

  if (Array.isArray(order.flavors) && order.flavors.length) {
    if (typeof order.flavors[0] === "string") {
      const percentage = Math.floor(100 / order.flavors.length);
      let remainder = 100 - percentage * order.flavors.length;
      return order.flavors.map((flavorName) => {
        const flavorPercentage = percentage + (remainder > 0 ? 1 : 0);
        remainder -= 1;
        return { name: flavorName, percentage: flavorPercentage };
      });
    }

    return order.flavors.map((flavor) => ({
      name: flavor.name,
      percentage: Number(flavor.percentage || 0),
    }));
  }

  if (order.flavor) {
    const names = String(order.flavor)
      .split(",")
      .map((flavor) => flavor.trim())
      .filter(Boolean);
    const percentage = Math.floor(100 / names.length);
    let remainder = 100 - percentage * names.length;
    return names.map((name) => {
      const flavorPercentage = percentage + (remainder > 0 ? 1 : 0);
      remainder -= 1;
      return { name, percentage: flavorPercentage };
    });
  }
  return [];
}

function formatOrderFlavors(order) {
  return formatFlavorItems(getOrderFlavorItems(order));
}

function getOrderVapeItems(order) {
  if (Array.isArray(order.vapeItems) && order.vapeItems.length) {
    return order.vapeItems.map((item) => ({
      vaperId: item.vaperId || "",
      vaperName: item.vaperName || "Vaper",
      quantity: Math.max(Number(item.quantity || 1), 1),
      unitPrice: Number(item.unitPrice || 0),
    }));
  }

  if (!isVapeOrder(order)) return [];
  const quantity = Math.max(Number(order.quantity || 1), 1);
  return [
    {
      vaperId: order.productId || "",
      vaperName: order.productName || "Vaper",
      quantity,
      unitPrice: Number(order.price || 0) / quantity,
    },
  ];
}
function getOrderHookahItems(order) {
  if (Array.isArray(order.hookahs) && order.hookahs.length) {
    return order.hookahs.map((hookah) => ({
      quantity: Math.max(Number(hookah.quantity || 1), 1),
      unitPrice: Number(hookah.unitPrice || Number(order.price || 0) / Math.max(Number(order.quantity || 1), 1)),
      flavors: getFlavorItemsFromValue(hookah.flavors),
    }));
  }

  if (isVapeOrder(order)) return [];
  return [
    {
      quantity: Math.max(Number(order.quantity || 1), 1),
      unitPrice: Number(order.price || 0) / Math.max(Number(order.quantity || 1), 1),
      flavors: getFlavorItemsFromValue(order.flavors?.length ? order.flavors : order.flavor),
    },
  ].filter((hookah) => hookah.flavors.length);
}

function getFlavorItemsFromValue(value) {
  if (Array.isArray(value) && value.length) {
    if (typeof value[0] === "string") {
      return buildEvenFlavorItems(value);
    }

    return value.map((flavor) => ({
      name: flavor.name,
      percentage: Number(flavor.percentage || 0),
    }));
  }

  if (value) {
    const names = String(value)
      .split(",")
      .map((flavor) => flavor.trim())
      .filter(Boolean);
    return buildEvenFlavorItems(names);
  }

  return [];
}

function buildEvenFlavorItems(names) {
  if (!names.length) return [];
  const percentage = Math.floor(100 / names.length);
  let remainder = 100 - percentage * names.length;
  return names.map((name) => {
    const flavorPercentage = percentage + (remainder > 0 ? 1 : 0);
    remainder -= 1;
    return { name, percentage: flavorPercentage };
  });
}

function formatFlavorItems(flavors) {
  return flavors.map((flavor) => `${flavor.name} ${flavor.percentage}%`).join(", ") || "-";
}

function isVapeOrder(order) {
  return order.productType === PRODUCT.vape;
}

function getProductLabel(order) {
  return isVapeOrder(order) ? "Vaper" : "Cachimba";
}

function getOrderUnitCount(order) {
  const items = isVapeOrder(order) ? getOrderVapeItems(order) : getOrderHookahItems(order);
  if (items.length) {
    return items.reduce((total, item) => total + Math.max(Number(item.quantity || 1), 1), 0);
  }
  return Math.max(Number(order.quantity || 1), 1);
}

function formatOrderUnitCount(order) {
  const quantity = getOrderUnitCount(order);
  return `${quantity} ${quantity === 1 ? "unidad" : "unidades"}`;
}
function formatSaleItem(order) {
  if (isVapeOrder(order)) return getOrderVapeItems(order).map((item) => item.vaperName).join(", ") || "Vaper";
  return getOrderHookahItems(order)
    .map(
      (hookah, index) =>
        `${hookah.quantity} cachimba${hookah.quantity === 1 ? "" : "s"} mezcla ${index + 1}: ${formatFlavorItems(hookah.flavors)}`,
    )
    .join(" | ");
}

function getTopFlavor(orders) {
  const counts = orders.reduce((acc, order) => {
    getOrderFlavors(order).forEach((flavor) => {
      acc[flavor] = (acc[flavor] || 0) + 1;
    });
    return acc;
  }, {});
  const [name, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [];
  return name ? { name, count } : null;
}

function getTopItem(items, key) {
  const counts = items.reduce((acc, item) => {
    const value = item[key];
    if (!value) return acc;
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
  const [name, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [];
  return name ? { name, count } : null;
}

function sumOrders(orders) {
  return orders.reduce((total, order) => total + Number(order.price || 0), 0);
}

function sumCommissions(orders) {
  return orders.reduce((total, order) => total + Number(order.commission || 0), 0);
}

function countHookahs(orders) {
  return orders
    .filter((order) => !isVapeOrder(order))
    .reduce((total, order) => total + Math.max(Number(order.quantity || 1), 1), 0);
}

function getEntryDurationMs(entry) {
  if (Number(entry.manualDurationMinutes || 0) > 0) {
    return Number(entry.manualDurationMinutes || 0) * 60000;
  }
  const start = new Date(entry.clockInAt).getTime();
  const end = entry.clockOutAt ? new Date(entry.clockOutAt).getTime() : Date.now();
  return Math.max(end - start, 0);
}

function createLocalMiddayIso(dateValue) {
  return new Date(`${dateValue}T12:00:00`).toISOString();
}

function getWeekInputValue(date) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((target - yearStart) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNumber).padStart(2, "0")}`;
}

function getWeekRange(weekValue) {
  const [yearText, weekText] = weekValue.split("-W");
  const year = Number(yearText);
  const week = Number(weekText);
  const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
  const day = simple.getUTCDay() || 7;
  const monday = new Date(simple);
  monday.setUTCDate(simple.getUTCDate() - day + 1);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10),
  };
}

function getMonthRange(monthValue) {
  const [year, month] = monthValue.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} h ${String(minutes).padStart(2, "0")} min`;
}

function getStatusLabel(status) {
  return status === STATUS.paid ? "Cobrada" : "Preparación";
}

function getPaymentLabel(paymentMethod) {
  if (paymentMethod === PAYMENT.cash) return "Efectivo";
  if (paymentMethod === PAYMENT.card) return "Tarjeta";
  return "-";
}


function normalize(value) {
  return value.toLocaleLowerCase("es").trim();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLocaleLowerCase("es");
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("es");
}

function normalizeCode(value) {
  return String(value || "").trim().replace(/\s+/g, "").toLocaleLowerCase("es");
}

function generateUniqueUserCode(name, users = state.users) {
  const prefix = getCodeNamePrefix(name);
  return `${prefix.length >= 2 ? prefix : "Usuario"}${String(Math.floor(Math.random() * 1000000)).padStart(6, "0")}`;
}

function getCodeNamePrefix(name) {
  const cleaned = String(name || "Usuario")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "");
  return cleaned || "Usuario";
}

function formatMoney(value) {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(value || 0);
}

function formatLongDate(date) {
  return new Intl.DateTimeFormat("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function formatDate(value) {
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function formatWeekday(dateValue) {
  return new Intl.DateTimeFormat("es-ES", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(`${dateValue}T12:00:00`));
}

function formatShortDateTime(value) {
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatTime(value) {
  return new Intl.DateTimeFormat("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function toDateInputValue(date) {
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return offsetDate.toISOString().slice(0, 10);
}

function getLocalDateValue(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : toDateInputValue(date);
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
