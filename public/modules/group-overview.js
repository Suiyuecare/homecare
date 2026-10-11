import { api, el, button, getContext, pageHeader, createForm, openDetails, table, pagination, badge, errorState, downloadCsv, today } from '../ui.js';
import { GROUP_METRICS, GROUP_OVERVIEW_NOTICE, groupOverviewIdentity, groupOverviewRequest, groupOverviewPath, confirmGroupDirectory, confirmGroupOverview, groupOverviewDrillRequest, groupOverviewRecordsPath, confirmGroupOverviewRecords } from '../data/group-overview-view.js';
const cancelled = () => new DOMException('群組總覽操作已取消', 'AbortError');
const count = value => new Intl.NumberFormat('zh-TW').format(value);
function overviewContent(output, onDrill) {
  const cards = el('section', { class: 'stats-grid', 'aria-label': '所選機構紀錄合計' }, GROUP_METRICS.map(metric => el('div', { class: 'stat' }, el('span', {}, metric.label), el('strong', {}, count(output.totals[metric.key])), el('small', {}, metric.help))));
  const organizations = table([{ key: 'name', label: '選取機構' }, ...GROUP_METRICS.map(metric => ({ label: metric.label, render: org => onDrill ? button(count(org.counts[metric.key]), () => onDrill(org, metric), { variant: 'outline', 'aria-label': `${org.name}／${metric.label}：${org.counts[metric.key]} 筆，追查紀錄` }) : count(org.counts[metric.key]) }))], output.organizations, { caption: '每個已授權機構的八項紀錄筆數，數字可追查來源' });
  const trend = table([{ key: 'organizationName', label: '機構' }, { key: 'date', label: '保存開始日' }, { label: '非取消班次', render: row => count(row.startsShifts) }, { label: '其中已完成', render: row => count(row.completedStartShifts) }, { label: '已核閱服務', render: row => count(row.approvedRecords) }], output.organizations.flatMap(org => org.trend.map(day => ({ ...day, organizationName: org.name }))), { caption: '各機構基準日前六日至基準日的七日開始日趨勢' });
  return el('section', { 'data-group-overview-result': true }, el('h2', {}, '已授權機構營運總覽'), el('p', { class: 'notice' }, output.notice), el('p', { class: 'muted' }, '使用中依目前保存狀態；當日班次排除取消；待核閱為目前全部submitted；基準月按開始日。不是歷史截至日統計。'), el('p', { class: 'pre-wrap' }, `基準日：${output.date} · 重新取得時間：${output.capturedAt}`), cards, el('h3', {}, '每機構目前紀錄'), organizations, el('h3', {}, '七日開始日趨勢'), el('p', { class: 'muted' }, '每行按保存開始日計筆數；不拆跨夜工時、不推財務金額。'), trend);
}
function openDrill({ overview, organization, metric, isCurrent, refreshOverview }) {
  let page = 1; const total = organization.counts[metric.key];
  return openDetails({ title: `${organization.name}／${metric.label}來源`, wide: true, guardedRead: true, isCurrent, loadingText: '正在重新確認來源與明細…',
    load: async (signal, helpers) => {
      const request = groupOverviewDrillRequest(overview, organization.id, metric.key, page);
      try {
        const result = confirmGroupOverviewRecords(await api(groupOverviewRecordsPath(request), { signal }), request, total);
        if (signal.aborted || !helpers.isCurrent()) throw cancelled();
        return el('section', { 'data-group-overview-drill': metric.key }, el('p', { class: 'notice' }, '這是所選機構目前保存的紀錄，不是跨機構去重人數或歷史時間點資料。'), el('p', {}, `${result.organization.name} · 基準日 ${result.date} · ${metric.label}`), table([{ key: 'name', label: '目前姓名（個案／員工）' }, { key: 'number', label: '目前案號／員編' }, { key: 'date', label: '保存開始日' }, { label: '保存狀態', render: item => badge(item.status) }, { key: 'version', label: '目前保存版次' }, { label: '保存識別', render: item => el('code', { class: 'pre-wrap' }, item.id) }], result.items, { caption: '目前紀錄識別與版次追查', emptyText: '這個指標目前沒有計入紀錄。' }), pagination({ page: result.page, pageSize: 25, total: result.total, onChange: value => { if (helpers.isCurrent()) { page = value; helpers.reload(); } } }), el('details', {}, el('summary', {}, '核對完整來源指紋'), el('code', { class: 'pre-wrap' }, result.fingerprint)));
      } catch (error) {
        if (signal.aborted || !helpers.isCurrent() || error.name === 'AbortError') throw cancelled();
        if (error.status === 409 || error.code === 'GROUP_SOURCE_CHANGED') return el('section', {}, errorState(error, refreshOverview), button('來源已變更，重新載入總覽', () => { if (helpers.isCurrent()) refreshOverview(); }, { variant: 'outline' }));
        throw error;
      }
    },
  });
}
function openGroupQuery({ isCurrent, trigger }) {
  const context = getContext(), identity = groupOverviewIdentity(context), hash = location.hash;
  const current = () => isCurrent() && trigger.isConnected && getContext() === context && groupOverviewIdentity(getContext()) === identity && location.hash === hash && getContext().role === 'admin';
  if (!current()) return Promise.resolve();
  const orgId = context.organizationId ?? context.orgId; let draft = { orgIds: [], date: today() }, query = null, generation = 0;
  return openDetails({ title: '群組總覽查詢', wide: true, guardedRead: true, isCurrent: current, loadingText: '正在確認目前已授權的管理者機構…',
    load: async (signal, helpers) => {
      const started = generation, requested = query ? groupOverviewRequest(query) : null, values = { orgIds: [...draft.orgIds], date: draft.date };
      const directory = confirmGroupDirectory(await api('/api/session', { signal }), { userId: context.user.id, orgId });
      if (signal.aborted || !helpers.isCurrent() || started !== generation) throw cancelled();
      let result, failure;
      if (requested) try { result = confirmGroupOverview(await api(groupOverviewPath(requested), { signal }), requested); } catch (error) { if (signal.aborted || !helpers.isCurrent() || error.name === 'AbortError') throw cancelled(); failure = error; }
      if (signal.aborted || !helpers.isCurrent() || started !== generation) throw cancelled();
      const results = el('div', { 'aria-live': 'polite' }), outputs = el('div', { class: 'actions', 'data-no-print': true }), outputStatus = el('div', { 'aria-live': 'polite', 'data-no-print': true });
      let initialized = false, enabled = Boolean(result);
      const ownerCurrent = () => helpers.isCurrent() && started === generation && form.isConnected;
      const resultCurrent = () => ownerCurrent() && enabled && query !== null;
      const clear = () => { enabled = false; results.replaceChildren(el('p', { role: 'status' }, '條件已變更，請明確查詢後再追查、下載或列印。')); outputs.replaceChildren(); outputStatus.replaceChildren(); };
      const form = createForm({ fields: [{ name: 'orgIds', label: '已授權管理者機構', type: 'checkbox-group', required: true, options: directory.map(org => ({ value: org.id, label: org.name })), help: '明確選取 1 至 10 個機構；不改變頁面原目前機構，也不替其他帳號開通。' }, { name: 'date', label: '基準日', type: 'date', required: true, min: '0001-01-01', max: '9999-12-31', help: '當日班次與基準月份按保存開始日；使用中與待核閱是目前保存狀態，並非歷史截至日。' }], initial: values, submitLabel: '查詢群組總覽', lockDuringSubmit: true,
        onChange: (next, nativeHelpers) => { if (!initialized || !helpers.isCurrent() || !form.isConnected) return; draft = { orgIds: [...next.orgIds], date: next.date }; query = null; generation++; clear(); },
        onSubmit: async next => { if (!helpers.isCurrent()) return false; const nextQuery = groupOverviewRequest(next); draft = { orgIds: [...nextQuery.orgIds], date: nextQuery.date }; query = nextQuery; generation++; await helpers.reload(); },
      }); initialized = true;
      const refresh = () => { if (helpers.isCurrent()) { generation++; helpers.reload(); } };
      if (result) {
        results.append(overviewContent(result, (org, metric) => { if (resultCurrent()) openDrill({ overview: result, organization: org, metric, isCurrent: resultCurrent, refreshOverview: refresh }); }));
        const csv = button('重新讀取並匯出目前總覽 CSV', () => {
          if (!resultCurrent()) return;
          return openDetails({ title: '群組總覽下載', wide: true, guardedRead: true, isCurrent: resultCurrent, loadingText: '正在重新確認完整機構授權與目前紀錄，再下載完整 CSV…',
            load: async (downloadSignal, downloadHelpers) => {
              const fresh = confirmGroupOverview(await api(groupOverviewPath(requested), { signal: downloadSignal }), requested);
              if (downloadSignal.aborted || !downloadHelpers.isCurrent()) throw cancelled();
              await downloadCsv(groupOverviewPath(requested, true), { filename: 'group-overview-' + requested.date + '.csv', signal: downloadSignal, isCurrent: downloadHelpers.isCurrent });
              if (downloadSignal.aborted || !downloadHelpers.isCurrent()) throw cancelled();
              return el('section', {}, el('h2', {}, '完整目前總覽下載已開始'), el('p', { class: 'notice' }, 'CSV在伺服器重新取得一次完整目前紀錄；不是先前畫面數字的歷史保存副本。'), el('p', {}, `基準日：${fresh.date} · 完整機構數：${fresh.organizations.length}`));
            },
          });
        }, { variant: 'outline' });
        const print = button('列印目前總覽', () => { if (!resultCurrent()) return; openDetails({ title: '群組營運總覽列印', wide: true, printable: true, guardedRead: true, isCurrent: resultCurrent, loadingText: '正在重新確認各機構目前紀錄…', load: async (printSignal, printHelpers) => { const fresh = confirmGroupOverview(await api(groupOverviewPath(requested), { signal: printSignal }), requested); if (printSignal.aborted || !printHelpers.isCurrent()) throw cancelled(); return overviewContent(fresh); } }); }, { variant: 'outline' });
        outputs.append(csv, print, button('重新取得總覽', refresh, { variant: 'outline' }), el('p', { class: 'muted' }, '匯出與列印會重新取得當下目前紀錄；來源變更時請重新查詢。CSV以安全文字表示，保存資料不變。'));
      } else if (failure) results.append(errorState(failure, refresh)); else results.append(el('p', { role: 'status' }, '請選取機構及日期，按「查詢群組總覽」。'));
      return el('section', { 'aria-label': '群組總覽條件與結果' }, el('p', { class: 'notice' }, GROUP_OVERVIEW_NOTICE), form, outputs, outputStatus, results);
    },
  });
}
/** Root adds /group-overview route; no new context, focus, dialog or Abort owner. */
export function mountGroupOverview(container, { isCurrent = () => true } = {}) {
  const context = getContext(), identity = groupOverviewIdentity(context), hash = location.hash;
  const current = () => isCurrent() && container.isConnected && getContext() === context && groupOverviewIdentity(getContext()) === identity && location.hash === hash;
  if (context.role !== 'admin') { container.replaceChildren(errorState(Object.assign(new Error('只有目前機構管理者可查詢本人已授權的機構。'), { status: 403 }))); return; }
  const launch = button('選擇機構與日期', () => { if (current()) openGroupQuery({ isCurrent: current, trigger: launch }); });
  container.replaceChildren(pageHeader('群組營運總覽', '查看自己已獲管理者授權的機構；明確選取，不更改目前工作機構。', [launch]), el('section', { class: 'panel' }, el('h2', {}, '以目前保存紀錄核對營運'), el('p', { class: 'notice' }, GROUP_OVERVIEW_NOTICE), el('p', {}, '選取機構及基準日後，查看八項紀錄合計、每機構筆數與七日開始日趨勢。各數字可追查原紀錄與保存版次。')));
}
