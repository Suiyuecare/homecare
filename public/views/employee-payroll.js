import { api, el, button, pageHeader, table, pagination, searchBox, openForm, openDetails, confirmAction, toast, getContext, errorState, createForm, formatMoney } from '../ui.js';
import { EMPLOYEE_PAYROLL_NOTICE, profileStatuses, payrollModes, splitBases, aaTreatments, payrollRoundings, PROFILE_FIELDS, confirmPayrollEmployee, confirmPayrollHistory, confirmPayrollProfile, confirmPayrollAck, confirmPayrollList, confirmPayrollCandidates, buildPayrollProfile, confirmEmployeePayrollPreview } from '../data/employee-payroll-ui.js';
import { formatBillingCents } from '../data/billing-document-editor.js';

const options = values => Object.entries(values).map(([value, label]) => ({ value, label }));
const abort = () => { throw new DOMException('操作已取消，請重新讀取目前資料。', 'AbortError'); };
const identity = () => { const c = getContext(); return JSON.stringify([c.user?.id, c.organizationId || c.orgId, c.role, c.user?.employeeId || c.employeeId || '']); };
const details = pairs => el('dl', { class: 'detail-grid' }, pairs.map(([label, value]) => el('div', { class: ['核定依據', '備註'].includes(label) ? 'field-wide' : '' }, el('dt', {}, label), el('dd', { class: 'pre-wrap' }, value === '' ? '未填寫' : value))));
const savedView = (item, employee) => details([...(employee ? [['員工（目前姓名／編號）', `${employee.employeeNo} · ${employee.name}`]] : []), ['員工識別', item.employeeId], ['有效期間', item.validFrom + ' ～ ' + item.validTo], ['計薪方式', payrollModes[item.payrollMode]],
  ['時薪', item.hourlyRateCents === null ? '不適用' : formatMoney(item.hourlyRateCents)], ['拆帳比例', item.shareBasisPoints === null ? '不適用' : `${formatBillingCents(item.shareBasisPoints)}%`],
  ['拆帳基礎', item.splitBasis === null ? '不適用' : splitBases[item.splitBasis]], ['AA 加計方式', aaTreatments[item.aaTreatment]], ['每筆進位方式', payrollRoundings[item.rounding]],
  ['狀態', profileStatuses[item.status]], ['保存版次', `第 ${item.version} 版`], ['核定依據', item.approvalReference], ['備註', item.note]]);

export async function mountEmployeePayroll(container, { isCurrent = () => true } = {}) {
  const context = getContext(), stamp = identity(), hash = location.hash, orgId = context.organizationId || context.orgId;
  const alive = () => container.isConnected && isCurrent() && getContext() === context && identity() === stamp && location.hash === hash;
  if (!['admin', 'finance'].includes(context.role)) { const error = new Error('僅管理者與財務可查閱員工薪資規則。'); error.status = 403; container.replaceChildren(errorState(error)); return; }
  const writable = context.role === 'admin', content = el('div', { class: 'list-content', 'aria-live': 'polite' }), footer = el('div', { class: 'list-footer' });
  let page = 1, q = '', sequence = 0, controller;
  const focusSaved = id => { if (!alive()) return; const target = [...content.querySelectorAll('tr[data-profile-id]')].find(row => row.dataset.profileId === id)?.querySelector('button') || container.querySelector('h1'); if (target) { if (target.tagName === 'H1') target.tabIndex = -1; target.focus({ preventScroll: true }); } };
  const action = (label, run, variant = 'outline') => {
    let busy = false; const trigger = button(label, async () => {
      if (busy || !alive()) return; busy = true; trigger.setAttribute('aria-busy', 'true'); trigger.setAttribute('aria-disabled', 'true');
      try { await run(trigger); } catch (error) { if (alive() && error.name !== 'AbortError') toast(error.message, 'error'); }
      finally { busy = false; trigger.removeAttribute('aria-busy'); trigger.removeAttribute('aria-disabled'); }
    }, { variant }); return trigger;
  };
  const read = async (id, signal, current) => { const response = await api('/api/employee-payroll/profiles/' + encodeURIComponent(id), { signal }); if (!current()) abort(); return confirmPayrollAck(response, { orgId, id }); };
  const readEmployee = async (id, signal, current) => {
    const response = await api('/api/employees/' + encodeURIComponent(id), { signal }); if (!current()) abort();
    const item = response?.item;
    if (!item || item.orgId !== orgId || item.id !== id || typeof item.name !== 'string' || typeof item.employeeNo !== 'string') throw new Error('員工資料無法確認。');
    return confirmPayrollEmployee({ id: item.id, name: item.name, employeeNo: item.employeeNo, version: item.version }, id);
  };
  const employees = async (signal, current) => {
    const found = [], seen = new Set(); let count;
    for (let employeePage = 1; employeePage <= 100; employeePage++) {
      const response = await api(`/api/employees?status=active&page=${employeePage}&pageSize=100`, { signal }); if (!current()) abort();
      if (!Array.isArray(response.items) || !Number.isSafeInteger(response.total) || response.total < 0 || response.page !== employeePage || response.pageSize !== 100
          || count !== undefined && count !== response.total || response.items.length !== Math.min(100, Math.max(0, response.total - (employeePage - 1) * 100))) throw new Error('員工名單有變動，請重新讀取。');
      count = response.total;
      for (const row of response.items) {
        if (typeof row.id !== 'string' || !row.id || row.orgId !== orgId || row.status !== 'active' || typeof row.name !== 'string' || typeof row.employeeNo !== 'string' || !Number.isSafeInteger(row.version) || row.version < 1 || seen.has(row.id)) throw new Error('員工資料無法確認。');
        seen.add(row.id); found.push({ value: row.id, label: `${row.employeeNo} · ${row.name}` });
      }
      if (seen.size === count) return found;
    } throw new Error('員工名單超過可核對範圍，請先整理資料。');
  };
  const editor = (row, copy, trigger) => { const opened = openDetails({ title: '讀取員工薪資規則', guardedRead: true, isCurrent: () => alive() && trigger.isConnected,
    load: async (signal, owner) => {
      const item = row ? await read(row.id, signal, owner.isCurrent) : null, existing = item && !copy ? item : null;
      if (existing && existing.status !== 'draft') throw new Error('此版本已鎖定；請建立新版本。');
      const people = await employees(signal, owner.isCurrent); if (!owner.isCurrent()) abort();
      if (!people.length) throw new Error('請先建立有效員工，再設定薪資規則。');
      const launch = button('填寫薪資規則', async () => {
        if (!owner.isCurrent()) return;
        let signature, key;
        const saved = await openForm({ title: existing ? '編輯員工薪資草稿' : copy ? '建立員工薪資新版本' : '新增員工薪資規則', isCurrent: owner.isCurrent,
          returnSubmitResult: true, submitLabel: '儲存草稿', initial: { ...item, hourlyRateCents: item?.hourlyRateCents == null ? '' : formatBillingCents(item.hourlyRateCents), shareBasisPoints: item?.shareBasisPoints == null ? '' : formatBillingCents(item.shareBasisPoints) },
          fields: [{ name: 'employeeId', label: '員工', type: 'select', required: true, options: people, disabled: !!existing },
            { name: 'validFrom', label: '生效日期', type: 'date', required: true }, { name: 'validTo', label: '截止日期', type: 'date', required: true },
            { name: 'payrollMode', label: '計薪方式', type: 'select', required: true, options: options(payrollModes) },
            { name: 'hourlyRateCents', label: '核定時薪（元）', required: true, inputMode: 'decimal', maxLength: 20, hidden: true, help: '填寫每小時金額，最多兩位小數；不能直接沿用員工主檔試算值。' },
            { name: 'shareBasisPoints', label: '核定拆帳比例（%）', required: true, inputMode: 'decimal', maxLength: 10, hidden: true, help: '填寫 0.01 至 100 的百分比，最多兩位小數；須依機構核定規則。' },
            { name: 'splitBasis', label: '拆帳基礎', type: 'select', required: true, options: options(splitBases), hidden: true },
            { name: 'aaTreatment', label: 'AA 加計方式', type: 'select', required: true, options: options({ include: aaTreatments.include, exclude: aaTreatments.exclude }), hidden: true },
            { name: 'rounding', label: '每筆服務進位方式', type: 'select', required: true, options: options(payrollRoundings), help: '先對每筆服務進位至分，再加總試算；月薪淨額與法定扣款另待核定。' },
            { name: 'approvalReference', label: '核定依據', type: 'textarea', maxLength: 2000, help: '可先保存草稿；核定時必須提供機構核定文件與版次。' },
            { name: 'note', label: '備註', type: 'textarea', maxLength: 10000, help: EMPLOYEE_PAYROLL_NOTICE }],
          onChange: (values, helpers) => { helpers.setHidden('hourlyRateCents', values.payrollMode !== 'hourly'); for (const name of ['shareBasisPoints', 'splitBasis', 'aaTreatment']) helpers.setHidden(name, values.payrollMode !== 'split'); },
          onSubmit: async (values, formOwner) => {
            const data = buildPayrollProfile(values, 'draft', item), payload = existing ? { version: existing.version, ...data } : data, next = JSON.stringify(payload);
            if (signature !== next) { signature = next; key = crypto.randomUUID(); }
            const response = await api('/api/employee-payroll/profiles' + (existing ? '/' + encodeURIComponent(existing.id) : ''), { method: existing ? 'PATCH' : 'POST', body: payload, headers: { 'Idempotency-Key': key }, signal: formOwner.signal });
            if (!formOwner.isCurrent()) abort(); return confirmPayrollAck(response, { orgId, id: existing?.id, version: existing ? existing.version + 1 : 1, expected: data });
          } });
        if (saved && owner.isCurrent()) { owner.close(); await opened; await load(); if (alive()) { focusSaved(saved.id); toast('已儲存員工薪資草稿。'); } }
      });
      return el('section', {}, el('p', { class: 'notice' }, EMPLOYEE_PAYROLL_NOTICE), item && savedView(item, await readEmployee(item.employeeId, signal, owner.isCurrent)), launch);
    } }); return opened; };
  const transition = (row, next, trigger) => { const opened = openDetails({ title: '核對員工薪資規則', guardedRead: true, isCurrent: () => alive() && trigger.isConnected,
    load: async (signal, owner) => {
      const item = await read(row.id, signal, owner.isCurrent), employee = await readEmployee(item.employeeId, signal, owner.isCurrent);
      const allowed = next === 'approved' ? item.status === 'draft' : ['draft', 'approved'].includes(item.status);
      if (!allowed) throw new Error('目前狀態已變更，請重新讀取。');
      const run = button(next === 'approved' ? '確認核定規則' : '確認停用規則', async () => {
        if (!owner.isCurrent()) return;
        const key = crypto.randomUUID(), data = Object.fromEntries(PROFILE_FIELDS.map(name => [name, name === 'status' ? next : item[name]]));
        const saved = await confirmAction({ title: next === 'approved' ? '核定這份員工薪資規則？' : '停用這份員工薪資規則？', message: next === 'approved' ? '請確認員工、期間、參數與核定依據。核定後鎖定內容；不會建立薪資單或執行發薪。' : '停用後保留規則與版本歷程，不能繼續用此版試算；原服務及薪資單保持。', confirmLabel: next === 'approved' ? '核定規則' : '停用規則', danger: next === 'inactive', isCurrent: owner.isCurrent,
          onConfirm: async confirmation => { const response = await api('/api/employee-payroll/profiles/' + encodeURIComponent(item.id), { method: 'PATCH', body: { version: item.version, ...data }, headers: { 'Idempotency-Key': key }, signal: confirmation.signal }); if (!confirmation.isCurrent()) abort(); confirmPayrollAck(response, { orgId, id: item.id, version: item.version + 1, expected: data }); } });
        if (saved && owner.isCurrent()) { owner.close(); await opened; await load(); if (alive()) { focusSaved(item.id); toast(next === 'approved' ? '已核定員工薪資規則。' : '已停用員工薪資規則。'); } }
      }, { variant: next === 'inactive' ? 'outline' : 'primary' }); return el('section', {}, savedView(item, employee), run);
    } }); return opened; };
  const history = (row, trigger) => openDetails({ title: '員工薪資規則版本歷程', wide: true, guardedRead: true, isCurrent: () => alive() && trigger.isConnected,
    load: async (signal, owner) => {
      const response = confirmPayrollHistory(await api(`/api/employee-payroll/profiles/${encodeURIComponent(row.id)}/history`, { signal }), { orgId, id: row.id }); if (!owner.isCurrent()) abort();
      const employee = await readEmployee(response.items[0].snapshot.employeeId, signal, owner.isCurrent);
      return el('section', {}, el('p', { class: 'notice' }, EMPLOYEE_PAYROLL_NOTICE), response.items.map((entry, i) => {
        const item = confirmPayrollProfile(entry.snapshot, { orgId, id: row.id, version: entry.version });
        return el('details', { class: 'panel', open: i === 0 }, el('summary', {}, `第 ${item.version} 版 · ${profileStatuses[item.status]}`), savedView(item, employee));
      }));
    } });
  const preview = (row, trigger) => openDetails({ title: '員工每月服務薪資試算', wide: true, guardedRead: true, isCurrent: () => alive() && trigger.isConnected,
    load: async (signal, owner) => {
      const profile = await read(row.id, signal, owner.isCurrent), employee = await readEmployee(profile.employeeId, signal, owner.isCurrent); if (profile.status !== 'approved') throw new Error('只有機構已核定版本可試算。');
      let sourcePage = 1, month = '', generation = 0, queryGeneration = 0;
      const selected = new Map(), sources = el('div', {}), results = el('div', { 'aria-live': 'polite' }), selectedCount = el('p', { role: 'status' }, '尚未選取來源。');
      const retract = () => { generation++; results.replaceChildren(); };
      const selection = () => { selectedCount.textContent = `已明確選取 ${selected.size} 筆服務；最多 100 筆。此合計只含選取來源。`; retract(); };
      const execute = createForm({ readOnlySubmission: true, submitLabel: '執行選取來源月試算', fields: [], onSubmit: async () => {
        if (!owner.isCurrent()) abort(); if (!selected.size) throw new Error('請明確選取至少一筆服務來源。');
        const own = generation, payload = { profile: { id: profile.id, version: profile.version }, month, sources: [...selected.values()].map(item => ({ id: item.id, version: item.version })) };
        const response = await api('/api/employee-payroll/preview', { method: 'POST', body: payload, signal });
        const confirmed = await confirmEmployeePayrollPreview(response, payload, orgId, profile); if (!owner.isCurrent() || own !== generation) abort();
        const section = el('section', { class: 'panel', tabindex: '-1', 'aria-label': '員工月試算結果' }, el('h3', {}, '員工月試算結果'), el('p', { class: 'notice' }, EMPLOYEE_PAYROLL_NOTICE),
          details([['員工（目前保存名稱）', confirmed.employeeSnapshot.name], ['月份', confirmed.month], ['已選服務筆數', String(confirmed.lines.length)], ['選取來源試算合計', formatMoney(confirmed.totalAmountCents)], ['每筆進位方式', payrollRoundings[profile.rounding]]]),
          table([{ key: 'date', label: '服務日期' }, { key: 'serviceRecordId', label: '來源識別' }, { key: 'serviceMinutes', label: '保存分鐘' }, { label: '拆帳基礎金額', render: line => line.basisCents === null ? '不適用' : formatMoney(line.basisCents) }, { label: '試算金額', render: line => formatMoney(line.amountCents) }, { label: '精確算式', render: line => `${line.trace.numerator} ÷ ${line.trace.denominator}，餘數 ${line.trace.remainderNumerator}；${payrollRoundings[line.trace.rounding]}` }], confirmed.lines, { caption: '每筆服務試算與追溯' }),
          confirmed.warnings.map(message => el('p', { class: 'notice' }, message)));
        results.replaceChildren(section); section.focus({ preventScroll: true }); section.scrollIntoView({ block: 'nearest' });
      } });
      const loadSources = async (requestedMonth, requestedPage) => {
        const own = ++queryGeneration; retract(); sources.replaceChildren(el('p', { role: 'status' }, '正在讀取已核閱服務…'));
        try {
          const query = { employeeId: profile.employeeId, month: requestedMonth, page: requestedPage, pageSize: 25 };
          const data = confirmPayrollCandidates(await api('/api/employee-payroll/candidates?' + new URLSearchParams(query), { signal }), { ...query, orgId });
          if (!owner.isCurrent() || own !== queryGeneration) return;
          sources.replaceChildren(table([{ label: '選取', render: item => {
            const checkbox = el('input', { type: 'checkbox', checked: selected.has(item.id), 'aria-label': `選取 ${item.date} ${item.label} 第 ${item.version} 版` });
            checkbox.addEventListener('change', () => { if (!owner.isCurrent()) return; if (checkbox.checked && selected.size >= 100) { checkbox.checked = false; toast('每次最多選取 100 筆，請分開核對。', 'error'); return; } if (checkbox.checked) selected.set(item.id, item); else selected.delete(item.id); selection(); }); return el('div', { class: 'field' }, el('label', { class: 'choice-option' }, checkbox, el('span', {}, '選取')));
          } }, { key: 'date', label: '服務日期' }, { key: 'label', label: '保存來源' }, { key: 'serviceMinutes', label: '服務分鐘' }, { label: '保存版次', render: item => `第 ${item.version} 版` }], data.items, { emptyText: '此月份沒有可試算的已核閱服務。', caption: '明確選取已核閱服務來源' }),
          pagination({ page: requestedPage, total: data.total, onChange: value => { sourcePage = value; loadSources(month, sourcePage); } }));
        } catch (error) { if (owner.isCurrent() && own === queryGeneration && error.name !== 'AbortError') sources.replaceChildren(errorState(error, () => loadSources(requestedMonth, requestedPage))); }
      };
      const monthForm = createForm({ readOnlySubmission: true, submitLabel: '查詢已核閱服務', fields: [{ name: 'month', label: '試算月份（YYYY-MM）', required: true, maxLength: 7 }],
        onChange: () => { queryGeneration++; month = ''; selected.clear(); sources.replaceChildren(); selection(); },
        onSubmit: async values => { if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(values.month)) { const error = new Error('請填寫有效月份，例如 2026-10。'); error.fields = { month: error.message }; throw error; } month = values.month; sourcePage = 1; await loadSources(month, sourcePage); } });
      return el('section', {}, el('p', { class: 'notice' }, EMPLOYEE_PAYROLL_NOTICE), savedView(profile, employee), monthForm, sources, selectedCount, execute, results);
    } });
  async function load() {
    const own = ++sequence; controller?.abort(); controller = new AbortController(); content.replaceChildren(el('p', { role: 'status' }, '正在讀取員工薪資規則…')); footer.replaceChildren();
    try {
      const result = confirmPayrollList(await api('/api/employee-payroll/profiles?' + new URLSearchParams({ page, pageSize: 25, q }), { signal: controller.signal }), { orgId, page });
      if (!alive() || own !== sequence) return;
      if (page > 1 && !result.items.length && result.total) { page = Math.ceil(result.total / 25); return load(); }
      const employeeMap = new Map(result.employeeSnapshots.map(employee => [employee.id, employee]));
      content.replaceChildren(table([{ label: '員工', render: item => { const employee = employeeMap.get(item.employeeId); return el('span', {}, `${employee.employeeNo} · ${employee.name}`, el('small', { class: 'muted' }, ' · ' + item.employeeId)); } }, { label: '計薪方式', render: item => payrollModes[item.payrollMode] }, { label: '有效期間', render: item => item.validFrom + ' ～ ' + item.validTo },
        { label: '狀態／版次', render: item => `${profileStatuses[item.status]} · 第 ${item.version} 版` }, { label: '核定依據', key: 'approvalReference' }, { label: '操作', render: item => el('div', { class: 'actions row-actions' },
          action('查看規則', trigger => openDetails({ title: '員工薪資規則詳情', wide: true, guardedRead: true, isCurrent: () => alive() && trigger.isConnected, load: async (signal, owner) => { const current = await read(item.id, signal, owner.isCurrent); return savedView(current, await readEmployee(current.employeeId, signal, owner.isCurrent)); } })),
          action('版本歷程', trigger => history(item, trigger)), item.status === 'approved' && action('月服務試算', trigger => preview(item, trigger)),
          writable && item.status === 'draft' && action('編輯草稿', trigger => editor(item, false, trigger)), writable && item.status === 'draft' && action('核定', trigger => transition(item, 'approved', trigger)),
          writable && ['draft', 'approved'].includes(item.status) && action('停用', trigger => transition(item, 'inactive', trigger)), writable && action('建立新版本', trigger => editor(item, true, trigger))) }], result.items,
        { emptyText: q ? '找不到符合條件的規則，請調整搜尋。' : '尚未建立員工薪資規則，請由管理者新增待核定草稿。' }));
      [...content.querySelectorAll('tbody tr')].forEach((row, index) => { row.dataset.profileId = result.items[index].id; });
      footer.replaceChildren(pagination({ page, total: result.total, onChange: value => { page = value; load(); } }));
    } catch (error) { if (alive() && own === sequence && error.name !== 'AbortError') content.replaceChildren(errorState(error, load)); }
  }
  container.replaceChildren(pageHeader('員工薪資規則與月試算', '依員工及有效期間保存時薪或拆帳規則；沒有核定參數時先保留待辦。', writable ? action('新增員工薪資規則', trigger => editor(null, false, trigger), 'primary') : null),
    el('p', { class: 'notice' }, EMPLOYEE_PAYROLL_NOTICE), ...(!writable ? [el('p', { class: 'notice' }, '財務可查閱及試算；規則維護與核定由機構管理者操作。')] : []),
    searchBox({ label: '搜尋員工薪資規則', placeholder: '搜尋員工、核定依據或備註', onSearch: value => { q = value; page = 1; load(); } }), content, footer);
  await load();
}
