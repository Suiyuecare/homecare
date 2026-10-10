import { openSavedRecordDetails } from './saved-record-details.js';
import { isServiceItemRecordDetailsId, serviceItemRecordDetailsIdentity,
  confirmServiceItemRecordDetails } from '../data/service-item-record-details.js';

const statusLabels = new Map([['active', '啟用'], ['inactive', '停用']]);
const fieldText = field => field.key === 'status' && field.kind === 'text'
  ? statusLabels.has(field.text)
    ? `${statusLabels.get(field.text)}（保存碼：${field.text}）`
    : `未辨識狀態（保存原文）：${field.text}`
  : field.text;

const profile = Object.freeze({
  entity: 'service-items', roles: Object.freeze(['admin', 'supervisor', 'finance']), requireActorScope: true,
  isId: isServiceItemRecordDetailsId, identity: serviceItemRecordDetailsIdentity, confirm: confirmServiceItemRecordDetails,
  title: '服務項目保存資料', loadingText: '正在讀取服務項目保存資料…', cancelMessage: '服務項目資料讀取已取消',
  regionLabel: '服務項目完整保存資料', fieldAttribute: 'data-service-item-field',
  fullWidthKeys: Object.freeze(['note']), formatField: fieldText,
  notice: '此處顯示目前保存的服務項目資料。保存分鐘與日期不推定實際服務或效期結果；金額僅供試算，正式支付碼與核定價格待確認，也不重算已核閱快照。',
});

/** One fresh saved service item read; no pricing, expiry or write action. */
export function openServiceItemRecordDetails({ id, isCurrent = () => true }) {
  return openSavedRecordDetails({ id, isCurrent, profile });
}
