import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLocalImportCsv,buildLocalImportRows} from '../public/data/local-import-core.js';
test('CSV retains leading zero ids, Unicode, quoted CRLF/comma/escaped quotes and source original boundary text',()=>{
 const csv='\ufeff姓名,案號,備註\r\n合成甲,0001," 原文\r\n逗號,引號""保留""尾端 "\r\n';
 const parsed=parseLocalImportCsv(csv);assert.equal(parsed.rows[0][2],' 原文\r\n逗號,引號"保留"尾端 ');
 assert.deepEqual(buildLocalImportRows('cases',csv,{'姓名':'name','案號':'caseNo','備註':'note'}).rows,[{rowNumber:2,data:{name:'合成甲',caseNo:'0001',note:parsed.rows[0][2]}}]);
});
test('malformed, ambiguous and oversized CSV never silently drops a partial row',()=>{
 for(const csv of ['a,a\n1,2','a,b\n1','a,b\n1,2,3','a\n"unfinished','a\n"text"tail','a\n\n','a\n\0','a\n"x'.repeat(100001),'a\n'+Array.from({length:101},(_,i)=>String(i)).join('\n')])assert.throws(()=>parseLocalImportCsv(csv));
 assert.throws(()=>parseLocalImportCsv('a\n""'),'explicit empty quoted rows are refused without silently dropping data');
});
test('mapping denies metadata, unsupported entities, duplicate targets, sparse boolean mapping and accessors',()=>{
 const csv='name,code,other\n合成甲,X1,unused';
 for(const mapping of [{name:'name',code:'caseNo',other:'id'},{name:'name',code:'caseNo',other:'name'},{name:'name',code:'caseNo',other:null},{name:'name'}])assert.throws(()=>buildLocalImportRows('cases',csv,mapping));
 assert.throws(()=>buildLocalImportRows('portal-bindings',csv,{name:'name',code:'caseNo'}));
 let calls=0;const getter={name:'name',code:'caseNo'};Object.defineProperty(getter,'other',{enumerable:true,get(){calls++;return '';}});assert.throws(()=>buildLocalImportRows('cases',csv,getter));assert.equal(calls,0);
});
test('integer cents never use floats, exponents, padded values, minus, unsafe integers or newline coercion',()=>{
 const mapping={code:'code',name:'name',minutes:'minutes',price:'unitPriceCents'};
 for(const value of ['0.1','1e2','-1','9007199254740993',' 1 ','"1\n"'])assert.throws(()=>buildLocalImportRows('service-items','code,name,minutes,price\nSYN,合成服務,60,'+value,mapping));
 const row=buildLocalImportRows('service-items','code,name,minutes,price\nSYN,合成服務,60,10001',mapping).rows[0];assert.equal(row.data.unitPriceCents,10001);assert.equal(row.data.minutes,60);
});
