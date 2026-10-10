import { api, el, table, pagination, errorState, openDetails, getContext, formatDate, formatFileSize } from '../ui.js';
import { ATTACHMENT_CATEGORIES, ATTACHMENT_STATUSES, CONTACT_CATEGORIES, CONTACT_STATUSES, getHistoryFields, normalizeHistorySnapshot, diffHistorySnapshots, formatTrialPriceCents } from '../data/history-fields.js';
import { compareAssessmentAnswers } from '../data/assessment-answers.js';
import { FOLLOWUP_KINDS, FOLLOWUP_STATUSES } from '../data/case-status-followup-editor.js';
import { INTERVIEW_STATUSES, isInterviewDate, formatInterviewDate } from '../data/interview-applicant-editor.js';
import { PERSONAL_CALENDAR_STATUSES, isPersonalCalendarDate } from '../data/personal-calendar-editor.js';

const PAGE_SIZE = 25;
const labels = {
  'announcement-status': { draft: '草稿', published: '已發布至本系統' },
  'announcement-audience': { all: '全體同仁', caregiver: '居服員', supervisor: '督導', finance: '財務', admin: '管理者' },
  'assessment-status': { draft: '草稿', submitted: '已提交' },
  'case-status': { active: '服務中', paused: '暫停', closed: '結案' },
  'plan-status': { draft: '草稿', active: '生效中', ended: '已結束' },
  'shift-status': { scheduled: '已排班', completed: '已完成', cancelled: '已取消' },
  'service-record-status': { draft: '草稿', submitted: '待核閱', approved: '已核閱', returned: '已退回' },
  'service-item-status': { active: '啟用', inactive: '停用' },
  'employee-status': { active: '啟用', inactive: '停用' },
  'leave-status': { pending: '待審核', approved: '已核准', rejected: '已駁回', cancelled: '已取消' },
  'certification-status': { active: '有效紀錄', revoked: '已撤銷' },
  'training-status': { completed: '已完成', cancelled: '已取消' },
  'training-category': { pre_service: '職前訓練', in_service: '在職訓練', other: '其他訓練' },
  'contact-category': Object.fromEntries(CONTACT_CATEGORIES.map(item => [item.value, item.label])),
  'contact-status': Object.fromEntries(CONTACT_STATUSES.map(item => [item.value, item.label])),
  'attachment-category': Object.fromEntries(ATTACHMENT_CATEGORIES.map(item => [item.value, item.label])),
  'attachment-status': Object.fromEntries(ATTACHMENT_STATUSES.map(item => [item.value, item.label])),
  'case-followup-kind': Object.fromEntries(FOLLOWUP_KINDS.map(item => [item.value, item.label])),
  'case-followup-status': Object.fromEntries(FOLLOWUP_STATUSES.map(item => [item.value, item.label])),
  'interview-status': Object.fromEntries(INTERVIEW_STATUSES.map(item => [item.value, item.label])),
  'personal-calendar-status': Object.fromEntries(PERSONAL_CALENDAR_STATUSES.map(item => [item.value, item.label])),
};
const titles = { 'personal-calendar-events': '個人行事曆版本歷程', announcements: '內部公告版本歷程', assessments: '評鑑填答版本歷程', cases: '個案版本歷程', 'care-plans': '照顧計畫版本歷程', shifts: '班次版本歷程', 'service-records': '服務紀錄版本歷程', 'service-items': '服務項目版本歷程', employees: '員工版本歷程', 'interview-applicants': '面試者版本歷程', 'case-contacts': '聯絡人版本歷程', 'case-status-followups': '暫停與結案追蹤版本歷程', 'case-attachments': '附件版本歷程', 'certification-attachments': '證照附件版本歷程', 'employee-certifications': '證照版本歷程', 'employee-training': '訓練版本歷程', 'leave-requests': '請假版本歷程' };
const contextIdentity = () => {
  const context = getContext();
  return `${context.user?.id || ''}:${context.organizationId || context.orgId || ''}:${context.role || ''}:${context.user?.employeeId || ''}`;
};
const text = value => value === null || value === undefined || value === '' ? '未提供' : String(value);
const timestamp = value => {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'medium' }).format(date)
    : '時間未記錄';
};

function referenceValue(reference, value, lookups) {
  if (value === null) return el('span', { class: 'muted' }, '未提供');
  const item = lookups[reference]?.get?.(value);
  const name = item?.name;
  let description;
  if (reference === 'care-plans') {
    description = item ? `目前照顧計畫：${item.validFrom ? formatDate(item.validFrom) : '未提供生效日期'} 至 ${item.validTo ? formatDate(item.validTo) : '未設定結束日'}（${labels['plan-status'][item.status] || text(item.status)}）` : '目前照顧計畫無法取得';
  } else if (reference === 'shifts') {
    description = item ? `目前班次：${item.date ? formatDate(item.date) : '未提供日期'} ${text(item.startTime)} 至 ${text(item.endTime)}（${labels['shift-status'][item.status] || text(item.status)}）` : '目前班次無法取得';
  } else if (reference === 'assessment-templates') {
    description = name ? `目前目錄名稱：${name}` : '目前模板名稱無法取得';
  } else {
    description = name ? `目前名稱：${reference === 'service-items' && item.code ? `${item.code} ` : ''}${name}` : '目前名稱無法取得';
  }
  return el('div', { class: 'history-reference' },
    el('span', { class: 'pre-wrap' }, description),
    el('details', {}, el('summary', {}, '查看保存的識別碼'), el('code', { class: 'pre-wrap' }, text(value))),
  );
}

const answerContainers = {
  missing: '未保存填答容器', null: '保存填答空值（null）',
  'empty-object': '保存空填答物件', object: '保存填答物件',
  array: '保存填答陣列；內容未展示', string: '保存填答文字容器；內容未展示',
  number: '保存填答數值容器；內容未展示', boolean: '保存填答布林容器；內容未展示',
  unsupported: '不支援展示的填答容器；內容未展示', unavailable: '題項規格未核定，填答內容未顯示。',
};
const answerTags = {
  missing: '未保存此題', null: '保存空值（null）', 'empty-string': '保存空字串（文字）',
  array: '保存陣列；內容未展示', object: '保存物件；內容未展示',
  'non-finite-number': '保存非有限數值；內容未展示', unsupported: '不支援展示的保存型別；內容未展示',
};
function answerValueNode(answer) {
  const attrs = { class: 'history-reference', 'data-answer-kind': answer.kind };
  if (answer.kind === 'string' || answer.kind === 'number' || answer.kind === 'boolean') {
    const label = { string: '保存文字：', number: '保存數值：', boolean: '保存布林值：' }[answer.kind];
    const value = answer.kind === 'number' && Object.is(answer.value, -0) ? '-0' : String(answer.value);
    return el('div', attrs, el('span', { class: 'muted' }, label), el('span', { class: 'pre-wrap' }, value));
  }
  return el('span', { ...attrs, class: 'muted' }, answerTags[answer.kind] || answerTags.unsupported);
}
const questionLabel = question => el('span', { class: 'pre-wrap' }, `${question.label}（${question.key}）`);
function assessmentAnswersNode(projection, caption = '保存填答（目前題名）') {
  if (projection.templateState !== 'known') return el('p', { class: 'notice', 'data-answer-container': 'unavailable' }, answerContainers.unavailable);
  return el('div', { 'data-answer-container': projection.container },
    el('p', { class: 'muted' }, answerContainers[projection.container]),
    projection.hasUnknownKeys && el('p', { class: 'notice' }, '另有未列入目前模板的欄位，未顯示其鍵名或內容。'),
    projection.hasUnsupportedValues && el('p', { class: 'notice' }, '部分題項只顯示保存型別；未展示或比較其內文。'),
    projection.questions.length ? table([
      { label: '題項（目前題名）', render: questionLabel },
      { label: '保存值', render: question => answerValueNode(question.answer) },
    ], projection.questions, { caption }) : el('p', { class: 'muted' }, '此容器無法按目前題項展示填答。'),
  );
}

function valueNode(field, value, lookups) {
  if (value === null) return el('span', { class: 'muted' }, field.emptyLabel || '未提供');
  if (field.type.startsWith('personal-calendar-') && typeof value !== 'string') return el('span', { class: 'muted', 'data-personal-calendar-value': 'unsupported' }, '非文字保存值；內容未展示。');
  if (field.type === 'personal-calendar-text') return el('span', { class: 'pre-wrap' }, value);
  if (field.type === 'personal-calendar-date') return isPersonalCalendarDate(value)
    ? el('time', { datetime: value, class: 'history-date' }, value.replaceAll('-', '/'))
    : el('span', { class: 'pre-wrap' }, `保存文字：${value}`);
  if (field.type.startsWith('interview-') && typeof value !== 'string') return el('span', { class: 'muted', 'data-interview-value': 'unsupported' }, '非文字保存值；內容未展示。');
  if (field.type === 'interview-text') return el('span', { class: 'pre-wrap' }, value);
  if (field.type === 'interview-date') return isInterviewDate(value)
    ? el('time', { datetime: value, class: 'history-date' }, formatInterviewDate(value))
    : el('span', { class: 'pre-wrap' }, `保存文字：${value}`);
  if (field.type.startsWith('announcement-') && typeof value === 'object') return el('span', { class: 'muted', 'data-announcement-value': 'unsupported' }, '非文字保存值；內容未展示。');
  if (field.type === 'announcement-text') return el('div', { class: 'history-reference' },
    el('span', { class: 'muted' }, '保存文字：'), el('span', { class: 'pre-wrap' }, value),
  );
  if (field.type === 'assessment-answers') return assessmentAnswersNode(value);
  if (field.type === 'reference') return referenceValue(field.reference, value, lookups);
  if (field.type === 'regions') {
    if (typeof value === 'object' && !Array.isArray(value)) return el('span', { class: 'muted' }, '[欄位格式無法判讀]');
    if (Array.isArray(value)) {
      if (!value.length) return el('span', { class: 'muted' }, '空清單（0 項）');
      return el('div', { class: 'history-reference' },
        el('span', { class: 'muted' }, `保存清單（${value.length} 項）`),
        el('ol', {}, value.map(item => el('li', { class: 'pre-wrap' }, item === '' ? '空字串' : `「${item}」`))),
      );
    }
    return el('div', { class: 'history-reference' },
      el('span', { class: 'muted' }, '保存文字：'), el('span', { class: 'pre-wrap' }, value),
    );
  }
  if (field.type === 'services' && Array.isArray(value)) {
    if (!value.length) return el('span', { class: 'muted' }, '未設定服務項目');
    return el('div', { class: 'history-services' }, value.map(item => el('div', { class: 'history-service' },
      referenceValue('service-items', item.serviceItemId, lookups),
      el('p', {}, `${field.quantityLabel || '數量'}：${text(item.quantity)}`),
    )));
  }
  if (field.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return el('time', { datetime: value, class: 'history-date' }, formatDate(value));
  }
  if (field.type === 'bytes' && Number.isSafeInteger(value) && value >= 0) return el('span', {}, `${formatFileSize(value)}（${value.toLocaleString('zh-TW')} 位元組）`);
  if (field.type === 'minutes' && Number.isSafeInteger(value)) return el('span', {}, `${value} 分鐘`);
  if (field.type === 'trial-price-cents') return el('span', { class: 'pre-wrap' }, formatTrialPriceCents(value));
  if (['announcement-audience', 'announcement-status', 'case-followup-kind', 'case-followup-status', 'interview-status', 'personal-calendar-status'].includes(field.type)) {
    return el('span', { class: 'pre-wrap' }, Object.hasOwn(labels[field.type], value)
      ? `${labels[field.type][value]}（${value}）` : `保存文字：${text(value)}`);
  }
  return el('span', { class: 'pre-wrap' }, labels[field.type]?.[value] || text(value));
}

function actorNode(actor) {
  if (!actor || (!actor.id && !actor.name)) return el('span', { class: 'muted' }, '未記錄操作者');
  return el('div', { class: 'history-reference' },
    el('span', { class: 'pre-wrap' }, actor.name || '姓名未記錄'),
    actor.id && el('details', {}, el('summary', {}, '查看操作者識別碼'), el('code', { class: 'pre-wrap' }, actor.id)),
  );
}

function assessmentComparisonNode(entry, lookups, metadataChanges) {
  const comparison = compareAssessmentAnswers(entry.comparison.previousSnapshot, entry.snapshot, lookups['assessment-templates']);
  const answerSection = (label, projection) => el('section', { 'aria-label': label },
    el('h4', {}, label), assessmentAnswersNode(projection, `${label}（目前題名）`));
  let answers;
  if (comparison.mode === 'template-changed') {
    answers = [el('p', { class: 'notice' }, '模板已更換；兩組填答依各自目前題項展示，不將同名題號配對比較。'),
      answerSection('原模板保存填答', comparison.before), answerSection('新模板保存填答', comparison.after)];
  } else if (comparison.mode === 'unavailable') {
    answers = el('p', { class: 'notice' }, '題項規格未核定，填答內容未顯示；無法逐題比較。');
  } else {
    answers = [
      comparison.containerChanged && table([
        { label: '變更前', render: () => answerContainers[comparison.before.container] },
        { label: '變更後', render: () => answerContainers[comparison.after.container] },
      ], [{}], { caption: '填答容器狀態變更' }),
      comparison.canCompareQuestions
        ? comparison.changes.length ? table([
          { label: '題項（目前題名）', render: questionLabel },
          { label: '變更前', render: question => answerValueNode(question.before) },
          { label: '變更後', render: question => answerValueNode(question.after) },
        ], comparison.changes, { caption: `第 ${entry.version} 版已知題項變更` })
          : el('p', { class: 'muted' }, '可展示的已知題項沒有可確認的變更。')
        : el('p', { class: 'notice' }, '填答容器無法逐題比較；只顯示可確認的容器狀態與安全保存值。'),
      !comparison.canCompareQuestions && comparison.containerChanged && [
        answerSection('前版保存填答', comparison.before), answerSection('本版保存填答', comparison.after),
      ],
    ];
  }
  return el('section', { 'aria-label': '變更前後' },
    el('h3', {}, '變更前後'), el('p', { class: 'muted' }, `與第 ${entry.comparison.previousVersion} 版比較`),
    metadataChanges.length ? table([
      { key: 'label', label: '欄位' },
      { label: '變更前', render: field => valueNode(field, field.before, lookups) },
      { label: '變更後', render: field => valueNode(field, field.after, lookups) },
    ], metadataChanges, { caption: `第 ${entry.version} 版填答基本欄位變更` })
      : el('p', { class: 'muted' }, '個案、模板、填寫日期與儲存狀態沒有可確認的變更。'),
    answers,
    comparison.limited && el('p', { class: 'notice' }, '比較僅涵蓋可展示的已知題項與型別；未顯示的欄位或內文不在比較範圍，不能據此判定整份填答未變更。'),
  );
}

function comparisonNode(entity, entry, lookups) {
  const comparison = entry.comparison;
  if (comparison?.status === 'initial') return el('p', { class: 'notice' }, '初始版本；沒有上一版本可比較。');
  // Never compare adjacent list items: visibility gaps and pagination break adjacency.
  const hasExactPrevious = comparison?.status === 'available'
    && Number.isSafeInteger(entry.version) && comparison.previousVersion === entry.version - 1
    && comparison.previousSnapshot && typeof comparison.previousSnapshot === 'object'
    && !Array.isArray(comparison.previousSnapshot);
  if (!hasExactPrevious) return el('p', { class: 'notice' }, '上一版本不可取得，只顯示本版保存資料。');
  const changes = diffHistorySnapshots(entity, comparison.previousSnapshot, entry.snapshot, lookups['assessment-templates']);
  if (entity === 'assessments') return assessmentComparisonNode(entry, lookups, changes.filter(field => field.key !== 'answers'));
  return el('section', { 'aria-label': '變更前後' },
    el('h3', {}, '變更前後'), el('p', { class: 'muted' }, `與第 ${comparison.previousVersion} 版比較`),
    changes.length ? table([
      { key: 'label', label: '欄位' },
      { label: '變更前', render: field => valueNode(field, field.before, lookups) },
      { label: '變更後', render: field => valueNode(field, field.after, lookups) },
    ], changes, { caption: `第 ${entry.version} 版變更前後` })
      : el('p', { class: 'muted' }, entity === 'announcements' ? '可展示的公告文字沒有可確認的變更。'
        : entity === 'interview-applicants' ? '可展示的面試保存文字沒有可確認的變更。'
          : entity === 'personal-calendar-events' ? '可展示的事件保存文字沒有可確認的變更。' : '此版沒有業務欄位變更。'),
    entity === 'announcements' && el('p', { class: 'muted' }, '比較僅涵蓋四個保存文字欄位；非文字值的隱藏內容不在比較範圍。'),
    entity === 'interview-applicants' && el('p', { class: 'muted' }, '比較僅涵蓋八個保存文字欄位；非文字值的隱藏內容不在比較範圍。'),
    entity === 'personal-calendar-events' && el('p', { class: 'muted' }, '比較僅涵蓋六個保存文字欄位；非文字值的隱藏內容不在比較範圍。'),
  );
}

function versionCard(entity, entry, lookups, first, actions) {
  const snapshot = normalizeHistorySnapshot(entity, entry.snapshot, lookups['assessment-templates']);
  const metadata = el('dl', { class: 'history-fields history-meta' },
    el('div', {}, el('dt', {}, '修改時間'), el('dd', {}, el('time', { datetime: entry.createdAt, class: 'history-date' }, timestamp(entry.createdAt)))),
    el('div', {}, el('dt', {}, '操作者（目前名稱）'), el('dd', {}, actorNode(entry.actor))),
  );
  const saved = el('details', { class: 'history-snapshot' }, el('summary', {}, '完整保存欄位'),
    el('dl', { class: 'history-fields' }, getHistoryFields(entity).map(field => el('div', {},
      el('dt', {}, field.label), el('dd', {}, valueNode(field, snapshot[field.key], lookups)),
    ))),
  );
  return el('details', { class: 'panel history-version', open: first },
    el('summary', {}, el('strong', {}, `第 ${entry.version} 版`)),
    metadata, comparisonNode(entity, entry, lookups), saved, actions,
  );
}

/** Read-only history; supplied lookup maps must already be authorized by the caller. */
export function openRecordHistory({ entity, id, lookups = {}, isCurrent = () => true, versionActions }) {
  getHistoryFields(entity);
  const identity = contextIdentity(), hash = window.location.hash;
  const current = () => identity === contextIdentity() && hash === window.location.hash && isCurrent();
  const title = titles[entity];
  return openDetails({
    title,
    wide: true,
    isCurrent: current,
    load: async signal => {
      if (!current()) throw new Error('頁面或機構已切換，請關閉歷程後重新開啟。');
      let page = 1, sequence = 0, controller;
      const versions = el('div', { class: 'history-versions', 'aria-live': 'polite' });
      const footer = el('div');
      const content = el('section', { class: 'record-history', 'aria-label': title },
        el('p', { class: 'muted' }, entity === 'shifts'
          ? '只比較可取得的精確上一版本。照顧計畫顯示目前可讀的期間與狀態，其餘關聯顯示目前可讀名稱；保存的識別碼可展開查閱。'
          : entity === 'announcements' ? '只比較可取得的精確上一版本。居服員僅可讀取目前及各保存版已發布且對象為全體或居服員的公告；隱藏前版不跳版比較。發布狀態只代表本系統保存狀態，不代表已寄送或已讀。'
          : entity === 'assessments' ? '只比較可取得的精確上一版本。模板與題名依目前目錄顯示，不代表當時題目版本或正式表單；個案顯示目前可讀名稱。填答保留可展示的保存型別，不推算分數、風險或資格。'
          : entity === 'service-records' ? '只比較可取得的精確上一版本。班次顯示目前可讀的日期、時段與狀態，其餘關聯顯示目前可讀名稱；實際時間保留保存文字，保存的識別碼可展開查閱。'
          : entity === 'service-items' ? '只比較可取得的精確上一版本。合成測試價格，不代表政府支付標準；預設分鐘及有效日期保留保存值，不重算已核閱快照。'
          : entity === 'employees' ? '只比較可取得的精確上一版本。職務為保存文字，不代表登入權限；服務區域保留文字或清單型別、順序及空項。保存的試算時薪不是核定薪資，資格文字不推定合格，不重算已核閱快照。'
          : entity === 'personal-calendar-events' ? '只比較本人在目前機構可取得的精確上一版本，列出實際保存操作者。人工事件日期與時間不代表排班、出勤或請假，不自動發送提醒。'
          : entity === 'interview-applicants' ? '只比較可取得的精確上一版本，列出實際保存操作者。這裡保存人工面試日期與內容；名單啟用或停用不代表錄取、到職或薪資核定，不會建立員工或帳號。'
          : entity === 'employee-certifications' ? '只比較可取得的精確上一版本。員工顯示目前可讀名稱，保存的識別碼可展開查閱。日期保留當時保存值，不依目前基準日重新計算效期，也不代表法定資格核定。'
          : entity === 'employee-training' ? '只比較可取得的精確上一版本。員工顯示目前可讀名稱，保存的識別碼可展開查閱。實際訓練時間保留原整數分鐘，不換算法定積分。'
          : entity === 'leave-requests' ? '只比較可取得的精確上一版本。員工顯示目前可讀名稱，保存的識別碼可展開查閱。假別與時段保留原保存文字，不換算請假時數或假額。'
          : entity === 'case-status-followups' ? '只比較可取得的精確上一版本。個案顯示目前可讀名稱，保存的識別碼可展開查閱。這裡保存原因、期間與人工追蹤結果；不代表正式結案認定，不改個案服務狀態、班次或收費。'
          : entity === 'certification-attachments' ? '只比較可取得的精確上一版本。證照與員工顯示目前可讀名稱，保存的識別碼可展開查閱；檔案僅比較保存資料與校驗碼，不比較檔案內文，也不代表資格核定。'
          : '只比較可取得的精確上一版本。關聯名稱為目前可讀名稱，保存的識別碼可展開查閱。'), versions, footer,
      );
      const abort = () => controller?.abort();
      signal.addEventListener('abort', abort, { once: true });
      const loadPage = async (initial = false) => {
        if (signal.aborted || !current()) return;
        const request = ++sequence;
        controller?.abort(); controller = new AbortController();
        versions.replaceChildren(el('p', { role: 'status' }, '正在讀取歷程…')); footer.replaceChildren();
        try {
          const result = await api(`/api/${entity}/${encodeURIComponent(id)}/history?page=${page}&pageSize=${PAGE_SIZE}&compare=previous`, { signal: controller.signal });
          if (signal.aborted || request !== sequence || !current()) return;
          const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
          if (page > lastPage) { page = lastPage; return loadPage(initial); }
          versions.replaceChildren(...(result.items.length
            ? result.items.map((entry, index) => versionCard(entity, entry, lookups, index === 0,
              Number.isSafeInteger(entry.version) && entry.version > 0 && versionActions
                ? versionActions({ version: entry.version, signal, isCurrent: () => !signal.aborted && request === sequence && content.isConnected && current() })
                : null))
            : [el('div', { class: 'empty-state', role: 'status' }, '尚無可讀取的版本歷程。')]));
          footer.replaceChildren(pagination({ page: result.page, pageSize: result.pageSize, total: result.total, onChange: next => { page = next; void loadPage(); } }));
          if (!initial) versions.querySelector('summary')?.focus();
        } catch (error) {
          if (signal.aborted || request !== sequence || error.name === 'AbortError' || !current()) return;
          if (initial) { signal.removeEventListener('abort', abort); throw error; }
          versions.replaceChildren(errorState(error, () => loadPage()));
        }
      };
      await loadPage(true);
      return content;
    },
  });
}
