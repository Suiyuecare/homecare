import { api,el,button,pageHeader,openForm,confirmAction,toast,table,getContext } from '../ui.js';
import { LOCAL_IMPORT_TYPES,parseLocalImportCsv,buildLocalImportRows } from '../data/local-import-core.js';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).every(key=>typeof key==='string'&&Object.getOwnPropertyDescriptor(value,key)?.enumerable&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
const closed=(value,keys)=>plain(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const unknown=()=>{throw new Error('匯入回應未確認，請保留欄位對應並重新讀取。');};
const equal=(a,b)=>a===b;
const timestamp=value=>typeof value==='string'&&value.length===24&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const dense=value=>Array.isArray(value)&&value.length<=100&&Reflect.ownKeys(value).length===value.length+1&&Reflect.ownKeys(value).every(key=>typeof key==='string'&&(key==='length'||/^(?:0|[1-9]\d*)$/.test(key)&&Number(key)<value.length)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
export function confirmLocalImportPreview(result,input){
  const parsed=buildLocalImportRows(input.entity,input.csv,input.mapping);
  if(!closed(result,['entity','label','totalCount','validCount','ready','errors','rows','previewHash'])||result.entity!==input.entity||result.label!==LOCAL_IMPORT_TYPES[input.entity].label||result.totalCount!==parsed.rows.length||!Number.isInteger(result.validCount)||result.validCount<0||result.validCount>result.totalCount||typeof result.ready!=='boolean'||!dense(result.rows)||!dense(result.errors)||result.rows.length!==result.validCount||result.ready!==(result.errors.length===0)||result.validCount+result.errors.length!==result.totalCount||typeof result.previewHash!=='string'||!/^[a-f0-9]{64}$/.test(result.previewHash))unknown();
  const seen=new Set();
  for(const row of result.rows){
    if(!closed(row,['rowNumber','data']))unknown();
    const expected=parsed.rows.find(item=>item.rowNumber===row.rowNumber),defaults=input.entity==='employees'?{status:'active',hourlyRateCents:0,regions:''}:{status:'active'};
    const planned={...defaults,...expected?.data};
    if(!closed(row,['rowNumber','data'])||!expected||seen.has(row.rowNumber)||!closed(row.data,Object.keys(planned))||!Object.entries(planned).every(([key,value])=>row.data[key]===value))unknown();seen.add(row.rowNumber);
  }
  for(const error of result.errors){if(!closed(error,['rowNumber','code','message','fields'])||!parsed.rows.some(row=>row.rowNumber===error.rowNumber)||seen.has(error.rowNumber)||typeof error.code!=='string'||typeof error.message!=='string'||!plain(error.fields)||Object.values(error.fields).some(value=>typeof value!=='string'))unknown();seen.add(error.rowNumber);}
  if(seen.size!==parsed.rows.length)unknown();return result;
}
export function confirmLocalImportCommit(result,preview,orgId,sourceHash){
  if(!preview.ready||!closed(result,['batchId','entity','importedCount','sourceHash','items','mode'])||result.entity!==preview.entity||result.importedCount!==preview.totalCount||result.mode!=='local-new-records-only'||typeof result.batchId!=='string'||!result.batchId||result.sourceHash!==sourceHash||!dense(result.items)||result.items.length!==preview.rows.length)unknown();
  const ids=new Set();
  for(let i=0;i<result.items.length;i++){
    const item=result.items[i],data=preview.rows[i].data;
    if(!plain(item)||Object.keys(item).length!==Object.keys(data).length+5||!Object.keys(data).every(key=>Object.hasOwn(item,key)&&equal(item[key],data[key]))||typeof item.id!=='string'||!item.id||item.id!==item.id.trim()||/[\r\n]/.test(item.id)||ids.has(item.id)||item.orgId!==orgId||item.version!==1||!timestamp(item.createdAt)||item.updatedAt!==item.createdAt)unknown();ids.add(item.id);
  }
  return result;
}
export async function mountLocalImports(container,{isCurrent=()=>true}={}){
  const ctx=getContext(),orgId=ctx.organizationId||ctx.orgId,hash=location.hash,identity=JSON.stringify([ctx.user?.id,orgId,ctx.role]);
  const alive=()=>container.isConnected&&isCurrent()&&getContext()===ctx&&location.hash===hash&&identity===JSON.stringify([getContext().user?.id,getContext().organizationId||getContext().orgId,getContext().role]);
  if(ctx.role!=='admin'){container.replaceChildren(el('p',{role:'alert'},'只有目前機構管理者可使用本機新增匯入。'));return;}
  const resultRegion=el('section',{class:'panel','aria-live':'polite'}),newButton=button('選擇CSV並對應欄位',async()=>{if(alive())await chooseFile(newButton);});
  container.replaceChildren(pageHeader('本機資料匯入','新增個案、員工或服務項目；先檢查再整批保存。',newButton),el('p',{class:'notice'},'一次最多100筆。只新增，不覆寫或硬刪除既有資料；同機構精確編號重複即整批拒絕。只接受UTF-8 CSV，沒有公式執行或正式平台轉換。'),resultRegion);
  async function chooseFile(trigger){
    const owner=()=>alive()&&trigger.isConnected;
    const selected=await openForm({title:'選擇本機匯入檔案',returnSubmitResult:true,isCurrent:owner,fields:[{name:'entity',label:'新增資料類型',type:'select',required:true,options:Object.entries(LOCAL_IMPORT_TYPES).map(([value,spec])=>({value,label:spec.label}))},{name:'file',label:'UTF-8 CSV檔案',type:'file',required:true,accept:'.csv,text/csv',maxFileBytes:800000,filePolicy:'local-import-csv',help:'首列為唯一欄名；最多40欄及100筆資料。檔案只在本次表單記憶中使用。'}],initial:{entity:'cases'},submitLabel:'讀取欄名',onSubmit:async(values,form)=>{
      const buffer=await values.file.arrayBuffer();if(!form.isCurrent())throw new DOMException('操作已取消','AbortError');let csv;try{csv=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer);}catch{throw new Error('檔案不是完整UTF-8文字，尚未送出。');}
      const parsed=parseLocalImportCsv(csv);return{entity:values.entity,csv,headers:parsed.headers,fileName:values.file.name};
    }});
    if(!selected||typeof selected!=='object'||!owner())return;await mapColumns(selected,trigger);
  }
  async function mapColumns(selected,trigger){
    const owner=()=>alive()&&trigger.isConnected,spec=LOCAL_IMPORT_TYPES[selected.entity],keyByBody=new Map();let preview=null,previewInput=null;
    const sourceHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(selected.csv)))].map(value=>value.toString(16).padStart(2,'0')).join('');if(!owner())return;
    const fields=selected.headers.map((header,index)=>({name:'column'+index,label:`欄名：${header}`,type:'select',placeholder:'不匯入此欄',options:Object.entries(spec.fields).map(([value,label])=>({value,label}))}));
    const initial=Object.fromEntries(selected.headers.map((header,index)=>['column'+index,Object.hasOwn(spec.fields,header)?header:Object.keys(spec.fields).find(key=>spec.fields[key]===header)||'']));
    const inputFor=values=>({entity:selected.entity,csv:selected.csv,mapping:Object.fromEntries(selected.headers.map((header,index)=>[header,values['column'+index]]))});
    const saved=await openForm({title:`對應${spec.label}欄位：${selected.fileName}`,returnSubmitResult:true,keepOpenOnFalse:true,isCurrent:owner,fields,initial,previewInstruction:'請先對應必要欄位，再檢查全部資料；錯誤修正前不能保存。',previewRequiredMessage:'請重新檢查資料，處理錯誤後再整批保存。',previewLabel:'檢查匯入資料',submitLabel:'確認整批新增',onPreview:async(values,{signal})=>{
      const input=inputFor(values);buildLocalImportRows(input.entity,input.csv,input.mapping);const result=confirmLocalImportPreview(await api('/api/local-imports/preview',{method:'POST',body:input,signal}),input);preview=result;previewInput=JSON.stringify(input);
      return{canSubmit:result.ready,content:el('div',{},el('p',{class:'notice'},`共${result.totalCount}筆；可新增${result.validCount}筆；錯誤${result.errors.length}筆。${result.ready?'確認後整批新增。':'請修正CSV或欄位對應。'}`),table([{key:'rowNumber',label:'資料列（含欄名）'},{label:'結果',render:row=>row.message||'檢查通過'},{label:'精確編號',render:row=>row.data?.[spec.key]||'—'}],[...result.rows,...result.errors].sort((a,b)=>a.rowNumber-b.rowNumber)))};
    },onSubmit:async(values,form)=>{
      const input=inputFor(values);if(!preview?.ready||JSON.stringify(input)!==previewInput)throw new Error('欄位對應已變更，請重新檢查。');
      const agreed=await confirmAction({title:'確認整批新增？',message:`在目前機構新增${preview.totalCount}筆${spec.label}；編號重複或來源資料變更時整批不保存。`,confirmLabel:'整批新增',signal:form.signal,isCurrent:form.isCurrent});if(!agreed)return false;
      const body={...input,previewHash:preview.previewHash},signature=JSON.stringify(body);if(!keyByBody.has(signature))keyByBody.set(signature,crypto.randomUUID());let result;
      try{result=await api('/api/local-imports/commit',{method:'POST',body,headers:{'Idempotency-Key':keyByBody.get(signature)},signal:form.signal});}catch(error){if(error.status===409){preview=null;error.invalidatePreview=true;}throw error;}
      const confirmed=confirmLocalImportCommit(result,preview,orgId,sourceHash);if(!form.isCurrent())throw new DOMException('操作已取消','AbortError');return confirmed;
    }});
    if(saved&&typeof saved==='object'&&alive()){resultRegion.replaceChildren(el('h2',{},'已保存本機新增匯入'),el('p',{},`新增${saved.importedCount}筆${spec.label}。原有資料保持，各筆建立版次及操作人已留存。`),el('details',{},el('summary',{},'本次追溯識別'),el('p',{class:'pre-wrap'},saved.batchId)));toast('整批新增已保存。');}
  }
}
