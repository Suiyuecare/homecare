import {insert,now,audit,billingSnapshot} from './model.mjs';
export function seedDemo(db,ctx){
 if(db.prepare('SELECT 1 FROM demo_seeds WHERE org_id=?').get(ctx.orgId))return{seeded:false,message:'示範資料已建立，不重複新增'};
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());const year=today.slice(0,4);const org=ctx.orgId;
 const employees=[['合成督導甲','TEST-E001','supervisor'],['合成居服員甲','TEST-E002','caregiver'],['合成居服員乙','TEST-E003','caregiver']].map(([name,employeeNo,role])=>insert(db,org,'employees',{name,employeeNo,role,status:'active',qualification:'合成測試資格',regions:'測試區',hourlyRateCents:24000,note:'完全合成；非真實人員'}));
 const offsetDate=days=>new Date(Date.parse(today+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
 const issuedOn=(Number(year)-1)+'-01-01';
 employees.forEach((employee,i)=>insert(db,org,'employee-certifications',{employeeId:employee.id,name:['合成督導證明','合成照顧訓練證明','合成基本證明'][i],certificateNo:'TEST-CERT-00'+(i+1),issuer:'合成測試單位',issuedOn,expiresOn:[offsetDate(-1),offsetDate(15),''][i],status:'active',note:'完全合成；非真實證照，不作法定資格或排班阻擋'}));
 employees.slice(1).forEach((employee,i)=>insert(db,org,'employee-training',{employeeId:employee.id,name:['合成職前訓練','合成在職訓練'][i],category:['pre_service','in_service'][i],provider:'合成測試單位',date:today,trainingMinutes:[120,90][i],status:'completed',note:'完全合成訓練時數；不等同法定積分'}));
 const cases=['甲','乙','丙'].map((n,i)=>insert(db,org,'cases',{name:'合成個案'+n,caseNo:'TEST-C00'+(i+1),status:'active',supervisorId:employees[0].id,note:'完全合成；非真實個案',gender:'未指定',cmsLevel:2}));
 const items=[['TEST-CARE-01','合成測試照顧服務',30,10000],['TEST-HOME-02','合成測試家務服務',60,18000]].map(([code,name,minutes,unitPriceCents])=>insert(db,org,'service-items',{code,name,minutes,unitPriceCents,validFrom:year+'-01-01',validTo:year+'-12-31',status:'active',note:'測試代碼及合成價格，不代表政府支付標準'}));
 const plans=cases.map(c=>insert(db,org,'care-plans',{caseId:c.id,validFrom:year+'-01-01',validTo:year+'-12-31',status:'active',services:items.map(x=>({serviceItemId:x.id,quantity:20})),goals:'合成照顧目標',note:'示範計畫'}));
 const shifts=cases.map((c,i)=>insert(db,org,'shifts',{caseId:c.id,employeeId:employees[1+i%2].id,carePlanId:plans[i].id,date:today,startTime:['09:00','11:00','14:00'][i],endTime:['10:00','12:00','15:00'][i],services:[{serviceItemId:items[i%2].id,quantity:1}],status:i===2?'completed':'scheduled',note:'合成班次'}));
 shifts.forEach((s,i)=>{const record={shiftId:s.id,caseId:s.caseId,employeeId:s.employeeId,date:s.date,actualStart:s.startTime,actualEnd:s.endTime,services:s.services,status:['draft','submitted','approved'][i],note:'合成服務紀錄',reviewNote:i===2?'示範核閱紀錄；非正式服務':''};if(i===2)record.billingSnapshot={...billingSnapshot(db,org,record),source:'synthetic-demo'};insert(db,org,'service-records',record);});
 insert(db,org,'announcements',{title:'本機合成資料示範',body:'此系統是本機可操作測試版，資料、測試服務代碼及價格全部為合成示範，不可作正式申報。',audience:'all',status:'published'});
 insert(db,org,'assessments',{caseId:cases[0].id,templateId:'DEMO-NEEDS',date:today,answers:{summary:'合成需求評估範例'},status:'draft'});
 insert(db,org,'leave-requests',{employeeId:employees[1].id,date:today,startTime:'17:00',endTime:'18:00',type:'測試事假',reason:'合成請假範例',status:'pending'});
 db.prepare('INSERT INTO demo_seeds VALUES(?,?)').run(org,now());audit(db,ctx,'demo.seed',null,null,{synthetic:true});return{seeded:true,message:'已建立完全合成示範資料'};
}
