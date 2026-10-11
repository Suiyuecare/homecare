// Plain local CSV mapping. No formulas, evaluation, caller ids or existing-row edits.
export const LOCAL_IMPORT_MAX_ROWS=100;
export const LOCAL_IMPORT_MAX_TEXT=200000;
export const LOCAL_IMPORT_TYPES={
  cases:{label:'個案',key:'caseNo',fields:{name:'姓名',caseNo:'案號',birthDate:'出生日期',gender:'性別',phone:'電話',address:'地址',cmsLevel:'CMS等級',welfare:'福利身分',primaryCarer:'主要照顧者',contactName:'聯絡人姓名',contactPhone:'聯絡人電話',note:'備註'},required:['name','caseNo'],numbers:['cmsLevel']},
  employees:{label:'員工',key:'employeeNo',fields:{name:'姓名',employeeNo:'員工編號',role:'職務文字',phone:'電話',email:'電子郵件',qualification:'資格文字',regions:'服務區域文字',note:'備註'},required:['name','employeeNo'],numbers:[]},
  'service-items':{label:'服務項目',key:'code',fields:{code:'服務代碼',name:'服務名稱',minutes:'分鐘',unitPriceCents:'原值單價（整數分）',validFrom:'起日',validTo:'迄日',note:'備註'},required:['code','name','minutes','unitPriceCents'],numbers:['minutes','unitPriceCents']},
};
export function localImportFail(message){const error=new Error(message);Object.assign(error,{status:422,code:'IMPORT_INVALID'});throw error;}
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).every(key=>typeof key==='string'&&Object.getOwnPropertyDescriptor(value,key)?.enumerable&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
/** Strict CSV including quoted commas, escaped quotes and exact quoted CRLF. */
export function parseLocalImportCsv(source){
  if(typeof source!=='string'||!source.length||source.length>LOCAL_IMPORT_MAX_TEXT||source.includes('\0'))localImportFail('CSV須為完整UTF-8文字，最多200,000字。');
  if(source.charCodeAt(0)===0xfeff)source=source.slice(1);
  const rows=[];let row=[],cell='',quoted=false,afterQuote=false,atStart=true;
  const pushCell=()=>{if(cell.length>10000)localImportFail('單一欄位最多10,000字。');row.push(cell);cell='';afterQuote=false;atStart=true;if(row.length>40)localImportFail('CSV最多40欄。');};
  const pushRow=()=>{pushCell();rows.push(row);row=[];if(rows.length>LOCAL_IMPORT_MAX_ROWS+1)localImportFail('一次最多100筆資料。');};
  for(let i=0;i<source.length;i++){
    const character=source[i];
    if(quoted){if(character==='"'){if(source[i+1]==='"'){cell+='"';i++;}else{quoted=false;afterQuote=true;}}else cell+=character;continue;}
    if(character==='"'){if(!atStart||afterQuote)localImportFail('CSV引號位置不合法。');quoted=true;atStart=false;continue;}
    if(character===','){pushCell();continue;}
    if(character==='\r'||character==='\n'){if(character==='\r'&&source[i+1]==='\n')i++;pushRow();continue;}
    if(afterQuote)localImportFail('引號結束後只能是分隔符號或換行。');cell+=character;atStart=false;
  }
  if(quoted)localImportFail('CSV引號未結束。');
  if(row.length||cell.length||afterQuote||source.endsWith(','))pushRow();
  if(rows.length<2)localImportFail('CSV需包含欄名及至少一筆資料。');
  const headers=rows.shift();
  if(headers.some(header=>!header.trim()||header.length>100||/[\r\n]/.test(header))||new Set(headers).size!==headers.length)localImportFail('欄名需完整、唯一且為100字內單行文字。');
  if(rows.some(values=>values.length!==headers.length||values.every(value=>value==='')))localImportFail('資料欄數必須與欄名相同，不能有空白資料列。');
  return {headers,rows};
}
export function buildLocalImportRows(entity,csv,mapping){
  if(!Object.hasOwn(LOCAL_IMPORT_TYPES,entity))localImportFail('只支援本機個案、員工或服務項目新增。');
  const spec=LOCAL_IMPORT_TYPES[entity],parsed=parseLocalImportCsv(csv);
  if(!plain(mapping)||Object.keys(mapping).length>40||Object.values(mapping).some(value=>typeof value!=='string'))localImportFail('欄位對應格式不合法。');
  const targets=Object.values(mapping).filter(Boolean);
  if(Object.keys(mapping).some(header=>!parsed.headers.includes(header))||targets.some(target=>typeof target!=='string'||!Object.hasOwn(spec.fields,target))||new Set(targets).size!==targets.length||spec.required.some(field=>!targets.includes(field)))localImportFail('請完整且不重複對應必要欄位；不能提供未知欄位或保存識別碼。');
  return {headers:parsed.headers,rows:parsed.rows.map((values,index)=>{
    const data={};for(const [header,field]of Object.entries(mapping)){
      if(!field)continue;const value=values[parsed.headers.indexOf(header)];
      if(spec.numbers.includes(field)&&value!==''){
        if(!/^(?:0|[1-9]\d*)$/.test(value)||value!==value.trim()||!Number.isSafeInteger(Number(value)))localImportFail(`第${index+2}行數值須為非負安全整數。`);data[field]=Number(value);
      }else data[field]=value;
    }
    return {rowNumber:index+2,data};
  })};
}
