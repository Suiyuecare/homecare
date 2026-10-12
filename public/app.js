import { spanRecordText, CALENDAR_SPAN_MODE } from './data/shift-span-editor.js';
import { api, el, button, badge, pageHeader, table, getContext, setContext, createForm, navigate, toast, today, formatDate, errorState, onSessionExpired, fetchAll, openDetails } from './ui.js';
import { renderOperations } from './modules/operations.js';
import { renderAdmin } from './modules/admin.js';
import { renderPersonnel } from './modules/personnel.js';
import { mountEmployeePayroll } from './views/employee-payroll.js';
import { icon } from './icons.js';
const app = document.querySelector('#app');
document.querySelector('.skip-link[href="#main-content"]')?.addEventListener('click', event => {
  event.preventDefault();
  const main = document.querySelector('main#main-content');
  if (!main) return;
  if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
  main.focus({ preventScroll: false });
});
let booting = false, routeVersion = 0;
const PRODUCT_NAME = '居家照顧作業系統', COMPANY_NAME = '歲悅長照集團';
const roleLabels = { admin: '管理者', supervisor: '督導', caregiver: '居服員', finance: '薪資／財務' };
let authSettings = { authMode: 'local', portalLoginUrl: null, portalHomeUrl: null };
let navigationDialog = null, disposeWorkspace = () => {};
function closeNavigation() { if (navigationDialog?.open) navigationDialog.close(); }
function portalUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('公司登入入口尚未設定，請聯絡管理者。');
  const url = new URL(value, location.origin);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error('公司登入入口設定不合法，請聯絡管理者。');
  return url.href;
}
function configureAuth(setup) {
  const authMode = setup.authMode ?? 'local';
  if (!['local', 'portal'].includes(authMode)) throw new Error('登入模式設定不合法，請聯絡管理者。');
  authSettings = { authMode, portalLoginUrl: authMode === 'portal' ? portalUrl(setup.portalLoginUrl) : null,
    portalHomeUrl: setup.portalHomeUrl ? portalUrl(setup.portalHomeUrl) : null };
}
function brandImage(size = 52) { return el('img', { src: '/suiyue-logo-transparent.png', alt: '歲悅長照形象標章', width: size, height: size, decoding: 'async' }); }
function navLink(route, name, iconName, mobile = false) {
  return el('a', { href: `#${route}`, class: mobile ? 'mobile-nav-link' : 'nav-link', 'data-route': route },
    el('span', { class: 'nav-icon', 'aria-hidden': 'true' }, icon(iconName)), el('span', { class: 'nav-text' }, name));
}
function showPortalAuth(notice = '') {
  closeNavigation(); disposeWorkspace();
  document.title = `公司登入 · ${PRODUCT_NAME}｜${COMPANY_NAME}`;
  const link = el('a', { href: authSettings.portalLoginUrl, class: 'btn btn-outline' }, '前往公司登入入口');
  const card = el('section', { class: 'auth-loading-card' }, brandImage(54),
    el('h1', { id: 'auth-loading-title' }, `正在進入${PRODUCT_NAME}`),
    el('p', { id: 'auth-loading-description' }, notice || '正在確認公司登入狀態，完成後會直接進入居家照顧作業系統。'),
    el('div', { class: 'auth-loading-bar', 'aria-hidden': 'true' }, el('b')), link);
  app.replaceChildren(el('main', { id: 'main-content', class: 'auth-loading-screen', role: 'status', 'aria-live': 'polite', 'aria-labelledby': 'auth-loading-title', 'aria-describedby': 'auth-loading-description' }, card));
  location.replace(authSettings.portalLoginUrl);
}
const navItems = [
  ['日常照顧', '/', '工作台', 'home'], ['/cases', '個案管理', 'cases'], ['/plans', '照顧計畫', 'clipboard'], ['/shifts', '排班調度', 'shifts'], ['/shift-series', '永久週期排班', 'shifts'], ['/case-contracts', '契約與期限', 'clipboard'], ['/records', '服務核閱', 'records'], ['/my-services', '我的服務', 'services'], ['/personal-calendar', '個人行事曆', 'calendar'],
  ['人員與機構', '/employees', '員工管理', 'users'], ['/interviews', '面試者登錄', 'interview'], ['/certifications', '證照與期限', 'certificate'], ['/training', '訓練紀錄', 'book'], ['/leave', '請假與差勤', 'leave'], ['/service-items', '服務項目', 'layers'], ['/announcements', '機構公告', 'announcement'],
  ['/shift-substitution', '人工代班申請', 'leave'], ['/contract-deadlines', '契約期限提醒', 'calendar'], ['/internal-notifications', '站內通知與回覆', 'announcement'],
  ['/attendance-exceptions', '人工出勤例外', 'leave'], ['/institution-holidays', '機構人工假日', 'calendar'], ['/training-credits', '年度人工積分', 'book'], ['/institution-calendar', '機構行事曆', 'calendar'], ['/internal-tasks', '內部待辦', 'clipboard'], ['/complaints', '申訴案件', 'clipboard'], ['/business-rules', '業務規則設定', 'settings'],
  ['紀錄與報表', '/assessments', '評估表單', 'clipboard'], ['/custom-forms', '自訂表單', 'clipboard'], ['/supervisory-visits', '督導訪視查詢', 'visit'], ['/needs-assessments', '需求評估查詢', 'search'], ['/case-followup-worklist', '人工追蹤查詢', 'activity'], ['/reports', '報表中心', 'reports'], ['/group-overview', '群組營運總覽', 'reports'], ['/surveys', '問卷與 QR 填答', 'clipboard'],
  ['財務作業', '/service-billing', '服務轉帳單', 'reports'], ['/billing-documents', '人工帳單與收款', 'reports'], ['/service-payroll', '服務轉薪資', 'reports'], ['/payroll-statements', '人工薪資結算', 'reports'], ['/claim-batches', '離線核銷與人工對帳', 'reports'], ['/calculations', '計價與薪資試算', 'reports'], ['/ltc-codes', 'BA／AA 清冊與試算', 'reports'], ['/employee-payroll', '員工薪資規則與月試算', 'reports'], ['/financial-adjustments', '財務更正調整單', 'reports'],
  ['系統管理', '/settings', '機構設定', 'settings'], ['/account-administration', '帳號與權限', 'users'], ['/local-imports', '本機資料匯入', 'layers'], ['/audit', '異動紀錄', 'history'], ['/help', '使用說明', 'help']
];
const names = Object.fromEntries(navItems.map(item => item.length === 4 ? [item[1], item[2]] : [item[0], item[1]]));
function brand(workspaceLabel = '') {
  return el('a', { href: '#/', class: 'brand', 'aria-label': '歲悅居家照顧首頁' },
    el('span', { class: 'brand-mark' }, brandImage()),
    el('span', { class: 'brand-copy' }, el('strong', {}, COMPANY_NAME), el('small', {}, `${PRODUCT_NAME}${workspaceLabel ? ` · ${workspaceLabel}` : ''}`)));
}
function canView(route) {
  const role = getContext().role;
  if (route === '/account-administration') return role === 'admin';
  if (['/calculations', '/ltc-codes', '/employee-payroll', '/financial-adjustments'].includes(route)) return ['admin', 'finance'].includes(role);
  if (route === '/surveys') return ['admin', 'supervisor'].includes(role);
  if (route === '/group-overview') return role === 'admin';
  if (route === '/shift-substitution') return ['admin','supervisor','caregiver'].includes(role);
  if (route === '/contract-deadlines') return ['admin','supervisor'].includes(role);
  if (route === '/internal-notifications') return ['admin','supervisor','finance','caregiver'].includes(role);
  if (route === '/local-imports') return role === 'admin';
  if (route === '/attendance-exceptions') return ['admin','supervisor','caregiver'].includes(role);
  if (route === '/institution-holidays') return ['admin', 'supervisor'].includes(role);
  if (route === '/training-credits') return ['admin', 'supervisor', 'caregiver'].includes(role);
  if (['/shift-series', '/case-contracts', '/custom-forms'].includes(route)) return ['admin', 'supervisor'].includes(role);
  if (route === '/internal-tasks') return ['admin', 'supervisor', 'caregiver', 'finance'].includes(role);
  if (['/service-payroll', '/service-billing', '/claim-batches', '/billing-documents', '/payroll-statements'].includes(route)) return ['admin', 'finance'].includes(role);
  if (route === '/institution-calendar') return ['admin', 'supervisor', 'caregiver', 'finance'].includes(role);
  if (route === '/business-rules') return ['admin', 'supervisor', 'finance'].includes(role);
  if (route === '/complaints') return ['admin', 'supervisor'].includes(role);
  if (route === '/personal-calendar') return ['admin', 'supervisor', 'caregiver', 'finance'].includes(role);
  if (['/interviews', '/supervisory-visits', '/needs-assessments', '/case-followup-worklist'].includes(route)) return ['admin', 'supervisor'].includes(role);
  if (role === 'caregiver') return ['/', '/my-services', '/cases', '/certifications', '/training', '/announcements', '/help'].includes(route);
  if (route === '/audit' || route === '/settings') return role === 'admin';
  if (role === 'finance') return ['/', '/cases', '/employees', '/service-items', '/reports', '/announcements', '/help'].includes(route);
  return true;
}
async function showAuth(needsSetup, notice = '') {
  if (authSettings.authMode === 'portal') { showPortalAuth(notice); return; }
  closeNavigation(); disposeWorkspace();
  document.title = `${needsSetup ? '首次建立' : '登入'} · ${PRODUCT_NAME}｜${COMPANY_NAME}`;
  const card = el('section', { class: 'auth-card' }, brand(), el('h2', {}, needsSetup ? '建立您的測試工作空間' : '登入機構工作空間'),
    el('p', { class: 'subtitle' }, needsSetup ? '設定第一位管理者，開始操作居家照顧流程。' : '請使用此系統建立的帳號登入。'),
    el('div', { class: 'notice' }, notice || '目前為本機測試版本。請使用合成資料進行流程驗證。'));
  const fields = [
    ...(needsSetup ? [{ name: 'name', label: '管理者姓名', required: true }, { name: 'organizationName', label: '機構名稱', required: true }] : []),
    { name: 'email', label: '電子信箱', type: 'email', required: true },
    { name: 'password', label: '密碼', type: 'password', required: true, minLength: needsSetup ? 12 : undefined, help: needsSetup ? '至少12個字元，可使用密碼管理器產生。' : undefined },
    ...(needsSetup ? [{ name: 'seedDemo', label: '載入合成示範資料', type: 'checkbox', help: '建立虛擬員工、個案、計畫與班次，方便立即試用。' }] : [])
  ];
  card.append(createForm({ fields, initial: { seedDemo: true, organizationName: '歲悅測試機構' }, submitLabel: needsSetup ? '建立工作空間' : '登入', onSubmit: async values => {
    const session = await api(needsSetup ? '/api/setup' : '/api/login', { method: 'POST', body: values });
    setContext(session); await showWorkspace(); toast(needsSetup ? '工作空間已建立。' : '已登入。');
  } }));
  app.replaceChildren(el('main', { class: 'auth-local-screen', id: 'main-content' }, card));
}
async function showWorkspace() {
  closeNavigation(); disposeWorkspace();
  const context = getContext();
  if (!context.user) { await boot(); return; }
  const roleLabel = roleLabels[context.role] || context.role;
  const sidebar = el('aside', { class: 'sidebar', id: 'sidebar' }, el('div', { class: 'sidebar-brand' }, brand()));
  const navigation = el('div', { class: 'sidebar-navigation' });
  let group, groupLabel;
  for (const item of navItems) {
    const [section, route, name, iconName] = item.length === 4 ? item : [null, ...item];
    if (section) { groupLabel = section; group = null; }
    if (canView(route)) {
      if (!group) { group = el('nav', { class: 'nav-group', 'aria-label': groupLabel }, el('p', { class: 'nav-label' }, groupLabel)); navigation.append(group); }
      group.append(navLink(route, name, iconName));
    }
  }
  sidebar.append(navigation);
  sidebar.addEventListener('click', event => { if (event.target.closest('a[href^="#"]')) closeNavigation(); });
  let signingOut = false;
  const signOut = async () => {
    if (signingOut || getContext() !== context) return;
    signingOut = true;
    const controls = [...app.querySelectorAll('[data-sign-out]'), ...(navigationDialog ? navigationDialog.querySelectorAll('[data-sign-out]') : [])];
    controls.forEach(control => { control.disabled = true; control.setAttribute('aria-busy', 'true'); });
    try { await api('/api/logout', { method: 'POST', body: {} }); setContext({ user: null }); await showAuth(false); }
    catch (error) { if (getContext() === context) toast(error.message, 'error'); }
    finally { signingOut = false; controls.forEach(control => { control.disabled = false; control.removeAttribute('aria-busy'); }); }
  };
  const sidebarLogout = button('登出', signOut, { variant: 'ghost', 'data-sign-out': true });
  const member = el('div', { class: 'sidebar-footer' },
    el('span', { class: 'user-avatar', 'aria-hidden': 'true' }, [...context.user.name].slice(0, 2).join('')),
    el('div', { class: 'member-copy' }, el('strong', {}, context.user.name), el('small', {}, roleLabel)), sidebarLogout);
  if (authSettings.portalHomeUrl) member.append(el('a', { href: authSettings.portalHomeUrl, class: 'sidebar-portal' }, '回模組頁'));
  sidebar.append(member);
  const main = el('main', { id: 'main-content', tabindex: '-1' });
  const layout = el('div', { class: 'layout' });
  const menu = button('選單', () => {
    if (navigationDialog?.open || !layout.isConnected || getContext() !== context) return;
    const previous = new Set(document.querySelectorAll('dialog'));
    const openedHash = location.hash;
    menu.setAttribute('aria-expanded', 'true'); mobileMore?.setAttribute('aria-expanded', 'true');
    const completion = openDetails({ title: '功能選單', guardedRead: true,
      isCurrent: () => layout.isConnected && getContext() === context && location.hash === openedHash,
      load: async () => sidebar });
    navigationDialog = [...document.querySelectorAll('dialog')].find(dialog => !previous.has(dialog));
    if (!navigationDialog) { menu.setAttribute('aria-expanded', 'false'); return; }
    const owned = navigationDialog;
    owned.classList.add('navigation-drawer'); sidebar.classList.add('is-open');
    owned.addEventListener('click', event => { if (event.target === owned) owned.close(); });
    owned.addEventListener('close', () => {
      sidebar.classList.remove('is-open'); menu.setAttribute('aria-expanded', 'false'); mobileMore?.setAttribute('aria-expanded', 'false');
      if (layout.isConnected) layout.prepend(sidebar);
      if (navigationDialog === owned) navigationDialog = null;
      if (window.matchMedia('(min-width: 1024px)').matches && main.isConnected) main.focus();
    }, { once: true });
    void completion;
  }, { variant: 'outline', class: 'btn btn-outline menu-toggle', 'aria-controls': 'sidebar', 'aria-expanded': 'false', 'aria-haspopup': 'dialog' });
  const pageTitle = el('span', { class: 'workspace-page-title' }, '工作台');
  const mobileBrand = el('a', { href: '#/', class: 'mobile-brand', 'aria-label': '歲悅居家照顧首頁' }, brandImage(28), el('span', {}, '居家照顧'));
  const status = el('div', { class: 'workspace-status', title: `${context.user.name} · ${roleLabel}`, 'aria-label': `登入身份：${context.user.name} · ${roleLabel}` }, el('span', { class: 'user-name' }, context.user.name), ' · ', el('span', { class: 'role-tag' }, roleLabel));
  const refresh = button('重新整理', async () => {
    if (getContext() !== context || refresh.disabled) return;
    refresh.disabled = true; refresh.setAttribute('aria-busy', 'true');
    try { await renderRoute(); } finally { refresh.disabled = false; refresh.removeAttribute('aria-busy'); }
  }, { variant: 'outline' });
  const actions = el('div', { class: 'topbar-actions' }, refresh,
    authSettings.portalHomeUrl && el('a', { href: authSettings.portalHomeUrl, class: 'btn btn-outline' }, '回模組頁'),
    button('登出', signOut, { variant: 'ghost', 'data-sign-out': true }));
  const notifications = el('a', { href: '#/announcements', class: 'notification-link', 'aria-label': '機構公告' }, icon('announcement'));
  const topbar = el('header', { class: 'topbar' }, el('div', { class: 'topbar-left' }, mobileBrand, pageTitle), actions, status, notifications, menu);
  const select = el('select', { id: 'organization', class: 'org-select', onchange: async event => {
    if (getContext() !== context) return;
    setContext(context, event.target.value); await showWorkspace();
  } }, context.organizations.map(org => el('option', { value: org.id, selected: org.id === context.organizationId }, org.name)));
  const scope = el('div', { class: 'workspace-scope' }, el('label', { for: 'organization' }, '目前機構'), select,
    el('span', { class: 'scope-role' }, `${roleLabel}工作台`));
  const mobileRoutes = context.role === 'caregiver' ? ['/', '/my-services', '/cases']
    : context.role === 'finance' ? ['/', '/reports', '/cases']
      : ['/', '/shifts', '/cases'];
  const mobileMore = el('button', { type: 'button', class: 'mobile-nav-more', 'aria-label': '更多功能', 'aria-expanded': 'false', 'aria-haspopup': 'dialog', 'aria-controls': 'sidebar', onclick: () => menu.click() }, el('span', { class: 'nav-icon', 'aria-hidden': 'true' }, icon('more')), '更多');
  const mobileNav = el('nav', { class: 'mobile-navigation', 'aria-label': '行動版導覽' }, mobileRoutes.filter(canView).map(route => {
    const item = navItems.find(value => (value.length === 4 ? value[1] : value[0]) === route);
    const [, , name, icon] = item.length === 4 ? item : [null, ...item];
    return navLink(route, name, icon, true);
  }));
  mobileNav.append(mobileMore);
  layout.append(sidebar, el('div', { class: 'workspace' }, topbar, scope,
    el('div', { class: 'test-banner', role: 'note' }, '測試工作空間 · 請使用合成資料；費用與薪資結果供規則核對。'), main), mobileNav);
  app.replaceChildren(layout);
  const breakpoint = window.matchMedia('(min-width: 1024px)');
  const closeForDesktop = event => { if (event.matches) closeNavigation(); };
  breakpoint.addEventListener('change', closeForDesktop);
  disposeWorkspace = () => breakpoint.removeEventListener('change', closeForDesktop);
  await renderRoute();
}
async function dashboard(container) {
  const ctx = getContext(); const date = today();
  const identity = () => { const current = getContext(); return JSON.stringify([current.user?.id ?? null, current.organizationId ?? current.orgId ?? null, current.role ?? null, current.user?.employeeId ?? null]); };
  const startedIdentity = identity(), startedHash = location.hash;
  const current = () => getContext() === ctx && identity() === startedIdentity && location.hash === startedHash && container.isConnected;
  const stale = () => { if (container.isConnected) container.replaceChildren(); };
  const primary = ctx.role === 'caregiver' ? { route: '/my-services', label: '查看我的服務', icon: 'services' }
    : ctx.role === 'finance' ? { route: '/reports', label: '查看作業報表', icon: 'reports' }
      : { route: '/shifts', label: '查看總班表', icon: 'shifts' };
  const organization = ctx.organizations.find(item => item.id === ctx.organizationId);
  container.classList.add('dashboard-workspace');
  container.append(pageHeader('今日服務工作台', '查看今日班次與待處理紀錄', canView(primary.route) ? [button([icon(primary.icon), el('span', {}, primary.label)], () => {
    if (current() && canView(primary.route)) navigate(primary.route);
  })] : []), el('div', { class: 'dashboard-context', 'aria-label': '目前日期與工作範圍' },
    el('span', {}, icon('calendar', { size: 16 }), el('span', {}, formatDate(date))),
    el('span', {}, icon('building', { size: 16 }), el('span', {}, organization?.name || '目前機構')),
    el('span', {}, roleLabels[ctx.role] || ctx.role)));
  let data, cases, employees;
  try {
    data = await api(`/api/dashboard?date=${date}&spanMode=${CALENDAR_SPAN_MODE}`);
    if (data.spanMode !== CALENDAR_SPAN_MODE) throw new Error('排班時段模式無法確認，請重新讀取。');
    if (!current()) { stale(); return; }
    [cases, employees] = await Promise.all([fetchAll('cases'), fetchAll('employees')]);
    if (!current()) { stale(); return; }
  } catch (error) {
    if (!current()) { stale(); return; }
    throw error;
  }
  const counts = data.counts || {};
  const casesMap = new Map(cases.map(x => [x.id, x.name])); const staffMap = new Map(employees.map(x => [x.id, x.name]));
  const shifts = data.todayShifts || [];
  const pending = data.pendingRecords || [];
  const countDefs = [['今日班次', counts.todayShifts ?? shifts.length, '依目前機構與角色範圍'], ['待核閱紀錄', counts.pendingRecords ?? pending.length, '送出後等待督導核閱'], ['服務中個案', counts.activeCases ?? cases.filter(x => x.status === 'active').length, '目前狀態為服務中'], ['在職人員', counts.activeEmployees ?? employees.filter(x => x.status === 'active').length, '目前狀態為在職']];
  const summary = el('section', { class: 'dashboard-summary', 'aria-label': '工作摘要' },
    el('h2', {}, '工作摘要'), el('div', { class: 'dashboard-metrics' }, countDefs.map(([name, value, hint]) => el('div', { class: 'dashboard-metric' }, el('span', {}, name), el('strong', {}, value), el('small', {}, hint)))));
  const services = shifts.length ? el('ul', { class: 'dashboard-service-list', 'aria-label': '今日服務安排' }, shifts.map(r =>
    el('li', { class: 'dashboard-service-row' },
      el('div', { class: Object.hasOwn(r, 'endDate') ? 'dashboard-service-time pre-wrap' : 'dashboard-service-time' }, el('span', { class: 'sr-only' }, '時段：'), Object.hasOwn(r, 'endDate') ? spanRecordText(r, 'shifts') : `${r.startTime}–${r.endTime}`),
      el('div', { class: 'dashboard-service-case' }, el('span', { class: 'sr-only' }, '個案：'), el('a', { href: `#/cases/${r.caseId}` }, r.caseName || casesMap.get(r.caseId) || '個案')),
      el('div', { class: 'dashboard-service-employee' }, el('span', { class: 'sr-only' }, '服務人員：'), r.employeeName || staffMap.get(r.employeeId) || '未指定'),
      el('div', { class: 'dashboard-service-status' }, el('span', { class: 'sr-only' }, '狀態：'), badge(r.status)))))
    : table([], [], { emptyText: '今天尚無班次，可到排班調度安排服務。' });
  const work = el('section', { class: 'panel dashboard-schedule' }, el('div', { class: 'section-heading' }, el('h2', {}, '今日服務安排'), el('span', { class: 'small muted' }, '服務資訊以最新排班為準；包含前日開始而於本日延續的班次')), services);
  const next = el('section', { class: 'panel dashboard-next' }, el('h2', {}, '接下來的工作'));
  const links = ctx.role === 'caregiver' ? [['/my-services', '填寫我的服務紀錄', '核對班次後，記錄實際服務時間與項目。'], ['/cases', '查閱服務個案', '服務前先確認聯絡資訊與照顧注意事項。']] : [['/records', `核閱服務紀錄${pending.length ? ` · ${pending.length} 筆` : ''}`, '檢查實際時間、服務項目與數量。'], ['/plans', '確認照顧計畫', '排班依據個案有效計畫與服務項目。'], ['/reports', '查看作業報表', '核對服務明細與費用試算。']];
  for (const [route, name, hint] of links) if (canView(route)) next.append(el('a', { href: `#${route}`, class: 'next-action' },
    el('strong', {}, name), el('span', {}, hint), icon('arrow-right', { size: 16 })));
  const shortcuts = {
    '/cases': ['個案管理', '聯絡資料與照顧資訊', 'cases'], '/shifts': ['排班調度', '安排與核對服務班次', 'shifts'],
    '/personal-calendar': ['個人行事曆', '查看自己的事件與安排', 'calendar'], '/reports': ['報表中心', '依保存資料查詢明細', 'reports'],
    '/my-services': ['我的服務', '核對班次與填寫紀錄', 'services'], '/announcements': ['機構公告', '閱讀機構發布的內容', 'announcement'],
  };
  const shortcutRoutes = ctx.role === 'caregiver' ? ['/my-services', '/cases', '/personal-calendar', '/announcements']
    : ctx.role === 'finance' ? ['/reports', '/cases', '/personal-calendar', '/announcements']
      : ['/cases', '/shifts', '/personal-calendar', '/reports'];
  const quick = el('section', { class: 'dashboard-shortcuts', 'aria-label': '快速入口' }, el('h2', {}, '快速入口'),
    el('div', { class: 'dashboard-shortcut-grid' }, shortcutRoutes.filter(canView).map(route => {
      const [label, hint, iconName] = shortcuts[route];
      return el('a', { href: `#${route}`, class: 'dashboard-shortcut' }, icon(iconName),
        el('div', { class: 'shortcut-copy' }, el('strong', {}, label), el('span', {}, hint)), icon('arrow-right', { size: 16 }));
    })));
  container.append(el('div', { class: 'dashboard-grid' }, work, next), summary, quick);
}
function help(container) {
  container.append(pageHeader('使用說明', '依角色與作業順序，完成一筆服務。'), el('section', { class: 'panel help-list' }, [['機構管理者', '先建立員工、個案及服務項目，再設定照顧計畫。新帳號從機構設定建立，居服員帳號需連結對應員工。'], ['督導', '依有效計畫安排班次，處理請假與代班，再核閱居服員送出的服務紀錄。核閱前可退回補充；已核准內容保留歷程。'], ['居服員', '從「我的服務」開啟班次，填寫實際起訖、服務項目與數量，儲存草稿或送交核閱。'], ['證照與訓練', '「證照與期限」依截至日期提醒已到期與30日內到期；「訓練紀錄」保存實際時數及歷程。管理者與督導維護，居服員可查自己的紀錄。提醒不等同法定資格審查，時數不自動換算積分。'], ['薪資與報表', '先核閱服務紀錄，再到報表中心查看明細與試算。費用與薪資規則仍需用機構核定案例驗證。'], ['遇到衝突或連線失敗', '表單會保留輸入內容。版本衝突請重新讀取最新資料；連線失敗可確認連線後再試。']].map(([title, text]) => el('div', {}, el('h3', {}, title), el('p', { class: 'muted' }, text)))));
}
async function renderRoute() {
  if (!getContext().user) return;
  const main = document.querySelector('#main-content'); if (!main) return;
  const route = (location.hash.slice(1) || '/').split('?')[0];
  const base = route.startsWith('/cases/') ? '/cases' : route; const name = names[base] || '頁面';
  document.title = `${name} · ${PRODUCT_NAME}｜${COMPANY_NAME}`;
  document.querySelectorAll('.workspace-page-title').forEach(title => { title.textContent = name; title.setAttribute('title', name); });
  const more = document.querySelector('.mobile-nav-more');
  more?.classList.toggle('is-current', ![...document.querySelectorAll('.mobile-nav-link')].some(link => link.dataset.route === base));
  document.querySelectorAll('.nav-link,.mobile-nav-link').forEach(link => link.setAttribute('aria-current', link.dataset.route === base ? 'page' : 'false'));
  const token = ++routeVersion;
  const container = el('div'); main.replaceChildren(container);
  const loading = el('div', { class: 'loading-state', role: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), '正在讀取資料…'); container.append(loading);
  try {
    if (!canView(base)) { const e = new Error('目前角色無法使用此頁面，請聯絡機構管理者。'); e.status = 403; throw e; }
    loading.remove();
    if (route === '/') await dashboard(container);
    else if (route === '/help') help(container);
    else if (route === '/employee-payroll') await mountEmployeePayroll(container, { isCurrent: () => token === routeVersion });
    else if (['/cases', '/plans', '/shifts', '/records', '/my-services'].includes(base)) await renderOperations(route, container);
    else if (['/certifications', '/training'].includes(base)) await renderPersonnel(route, container);
    else if (['/account-administration', '/calculations', '/ltc-codes', '/financial-adjustments', '/surveys', '/group-overview', '/service-payroll', '/service-billing', '/shift-substitution', '/contract-deadlines', '/internal-notifications', '/local-imports', '/attendance-exceptions', '/institution-holidays', '/training-credits', '/shift-series', '/case-contracts', '/internal-tasks', '/custom-forms', '/claim-batches', '/billing-documents', '/payroll-statements', '/business-rules', '/institution-calendar', '/complaints', '/personal-calendar', '/employees', '/interviews', '/service-items', '/leave', '/assessments', '/supervisory-visits', '/needs-assessments', '/case-followup-worklist', '/announcements', '/reports', '/settings', '/audit'].includes(base)) await renderAdmin(route, container);
    else container.append(pageHeader('找不到這個頁面'), button('回到工作台', () => navigate('/')));
    if (token !== routeVersion) return;
  } catch (e) { if (token === routeVersion) container.replaceChildren(errorState(e, renderRoute)); }
}
async function boot() {
  if (booting) return; booting = true;
  try {
    const setup = await api('/api/setup/status');
    configureAuth(setup);
    if (authSettings.authMode === 'local' && setup.needsSetup) await showAuth(true);
    else { const session = await api('/api/session'); setContext(session); if (session.user) await showWorkspace(); else await showAuth(false); }
  } catch (e) { app.replaceChildren(errorState(e, boot)); }
  finally { booting = false; }
}
onSessionExpired(() => { toast('登入已到期，請重新登入後再操作。', 'error'); if (!document.querySelector('dialog[open]')) boot(); });
window.addEventListener('hashchange', () => { closeNavigation(); renderRoute(); });
window.addEventListener('session-updated', showWorkspace);
boot();
