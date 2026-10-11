import { el, button, pageHeader, openDetails, openForm, confirmAction, toast } from '../ui.js';
import { SURVEY_NOTICE, surveyFragmentToken, confirmSurveyPublic, createSurveyAnswerEditor, createSurveySubmitAttempt, confirmSurveyAccepted } from '../data/survey-ui.js';
import { surveySame } from '../data/survey-core.js';
import { publicSurveyRequest } from './survey-requests.js';

const copy = value => structuredClone(value);
const aborted = () => new DOMException('此本機填答操作已取消。', 'AbortError');
const notice = value => el('p', { class: 'notice' }, value);

async function answer(open, token, current) {
  const editor = createSurveyAnswerEditor(open), attempt = createSurveySubmitAttempt(token, open);
  let previous, latest, generation = 0, checking = Promise.resolve(), sentValues;
  const show = (values, helpers) => { const visible = editor.visibility(values); for (const field of editor.snapshot.fields) helpers.setHidden('answer_' + field.key, !visible.has(field.key)); };
  const onChange = (values, helpers) => {
    if (!previous) { previous = copy(values); latest = copy(values); show(values, helpers); return; }
    if (sentValues) {
      if (!surveySame(values, sentValues)) { for (const [name, value] of Object.entries(sentValues)) helpers.setValue(name, value); show(sentValues, helpers); toast('上一份提交結果可能已保存；原答案保持，請以原提交識別重試。', 'error'); }
      return;
    }
    if (surveySame(values, latest)) return;
    const captured = copy(values), request = ++generation; latest = copy(captured);
    checking = checking.then(async () => {
      if (!current() || request !== generation) return;
      const before = copy(previous), hidden = editor.conditionalChange(before, captured);
      if (hidden.length) {
        const labels = editor.snapshot.fields.filter(field => hidden.includes(field.key)).map(field => field.label).join('、');
        // Confirmation and focus remain owned by the shared native dialog implementation.
        const agreed = await confirmAction({ title: '變更條件並清除不適用答案？', message: `「${labels}」將不再顯示。確認後清除此份尚未提交的答案；取消會回復原條件與原答案。`, confirmLabel: '變更並清除答案', danger: true, isCurrent: current });
        if (!current() || request !== generation) return;
        if (!agreed) { for (const [name, value] of Object.entries(before)) helpers.setValue(name, value); previous = before; latest = copy(before); show(before, helpers); return; }
        for (const key of hidden) { captured['answer_' + key] = editor.clearValue(key); helpers.setValue('answer_' + key, editor.clearValue(key)); }
      }
      previous = copy(captured); latest = copy(captured); show(captured, helpers);
    }).catch(error => { if (current() && error.name !== 'AbortError') toast(error.message, 'error'); });
  };
  const saved = await openForm({ title: open.title, fields: editor.fields, initial: editor.initial, isCurrent: current, onChange, submitLabel: '提交本次原始答案',
    onSubmit: async (values, owner) => {
      await checking; if (!owner.isCurrent()) throw aborted();
      if (!surveySame(values, latest)) throw new Error('顯示條件剛更新，請核對目前答案後重新提交。');
      const answers = editor.buildAnswers(values);
      if (!sentValues) {
        const agreed = await confirmAction({ title: '提交本次原始答案？', message: '提交後保存此份核准題目及原始答案，不計分。若回應中斷，請以原答案與原提交識別重試；不會自動新增另一份提交。', confirmLabel: '提交原始答案', signal: owner.signal, isCurrent: owner.isCurrent });
        if (!agreed) throw new Error('尚未提交，您的答案仍保留。');
      }
      const payload = attempt.build(answers); sentValues ||= copy(values);
      const result = await publicSurveyRequest('submit', payload, { signal: owner.signal, isCurrent: owner.isCurrent });
      if (!owner.isCurrent()) throw aborted(); confirmSurveyAccepted(result);
    },
  });
  if (saved && current()) await openDetails({ title: '本次原始答案已保存', isCurrent: current, load: async () => el('section', {}, notice(SURVEY_NOTICE), el('h3', {}, '謝謝您完成本次填答'), el('p', {}, '本次保存結果已確認。此頁不顯示分數，也不代表正式評鑑、閱讀義務或自然人去重。')) });
}

/** Anonymous entry uses the same shared UI owners, without reading or changing private session state. */
export function mountPublicSurvey(container, { isCurrent = () => true } = {}) {
  const fragment = location.hash;
  let token; try { token = surveyFragmentToken(fragment); } catch {
    container.replaceChildren(pageHeader('本機匿名填答', '請使用管理者核准的當次連結。'), el('section', { class: 'panel', role: 'alert' }, el('h2', {}, '此本機填答連結無法使用'), notice(SURVEY_NOTICE), el('p', {}, '請使用完整的當次連結。此頁不要求登入帳號、機構選擇或個案資料。'))); return;
  }
  const current = () => container.isConnected && isCurrent() && location.hash === fragment;
  let busy = false;
  const start = button('讀取核准題目並填答', async () => {
    if (busy || !current()) return; busy = true; start.setAttribute('aria-busy', 'true'); start.setAttribute('aria-disabled', 'true');
    try {
      await openDetails({ title: '本機核准公開填答', wide: true, guardedRead: true, isCurrent: current, loadingText: '正在讀取本次核准公開題目…', load: async (signal, owner) => {
        const open = await confirmSurveyPublic(await publicSurveyRequest('open', { token }, { signal, isCurrent: owner.isCurrent })); if (!owner.isCurrent()) throw aborted();
        const fill = button('開始填寫本次答案', async () => { if (!owner.isCurrent()) return; fill.disabled = true; try { await answer(open, token, () => owner.isCurrent() && fill.isConnected); } finally { if (owner.isCurrent()) fill.disabled = false; } });
        return el('section', {}, notice(open.notice), el('h2', {}, open.title), el('p', {}, `本次共 ${open.fields.length} 題；只有已核准題目及選項。依控制題可能顯示其他題目。`), el('p', {}, '請勿填入姓名、電話、身分證、個案或員工資料。原始答案完整保存，不作自動評分。'), fill);
      } });
    } finally { busy = false; start.removeAttribute('aria-busy'); start.removeAttribute('aria-disabled'); }
  });
  container.replaceChildren(pageHeader('本機匿名填答', '核對公開題目，保存本次原始答案。', [start]), el('section', { class: 'panel' }, notice(SURVEY_NOTICE), el('h2', {}, '不需要登入'), el('p', {}, '使用管理者明確核准的當次連結。連結只在本頁記憶體使用，答案提交不會改變既有私人登入或機構。'), el('p', {}, '這是本機功能；能開啟此頁不代表正式對外發布或官方評鑑。')));
}
