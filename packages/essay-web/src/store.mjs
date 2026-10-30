import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
const digest=s=>createHash('sha256').update(s).digest('hex');
function passwordHash(password,salt=randomBytes(16).toString('hex')){return salt+':'+scryptSync(password,salt,64).toString('hex');}
function passwordMatches(password,stored){try{const [salt,expected]=stored.split(':');const actual=scryptSync(password,salt,64);const bytes=Buffer.from(expected,'hex');return actual.length===bytes.length&&timingSafeEqual(actual,bytes);}catch{return false;}}
export class Store {
  constructor(root,{bootstrapPassword}={}){
    mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);this.root=root;
    const keyPath=join(root,'master.key');if(!existsSync(keyPath))writeFileSync(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});
    this.master=readFileSync(keyPath);if(this.master.length!==32)throw new Error('invalid-storage-key');
    this.db=new DatabaseSync(join(root,'workbench.sqlite'));this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY, encrypted_key TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL, title TEXT NOT NULL, provider TEXT NOT NULL, input_json TEXT NOT NULL, state TEXT NOT NULL, stage TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', result_json TEXT, cost REAL NOT NULL DEFAULT 0, reserved REAL NOT NULL DEFAULT 0, unknown_usage INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id,request_key,provider));
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), phase TEXT NOT NULL, provider TEXT NOT NULL, state TEXT NOT NULL, reserved REAL NOT NULL, cost REAL, usage_json TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_calls(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), provider TEXT NOT NULL, state TEXT NOT NULL, reserved REAL NOT NULL, cost REAL, usage_json TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT NOT NULL, subject TEXT, created_at TEXT NOT NULL);`);
    chmodSync(join(root,'workbench.sqlite'),0o600);
    if(!this.db.prepare('SELECT id FROM users LIMIT 1').get()){
      const password=bootstrapPassword??randomBytes(21).toString('base64url');
      this.addUser({username:'admin',name:'管理员',password,role:'admin'});
      writeFileSync(join(root,'bootstrap-admin.txt'),'员工文书工作台\n账号：admin\n初始密码：'+password+'\n请登录后修改初始密码；不要对外分享此文件。\n',{mode:0o600,flag:'wx'});
    }
    // A process restart never silently repeats an uncertain paid call.
    this.db.prepare("UPDATE jobs SET state='interrupted',stage='运行中断',detail='服务重启，已保留原稿及调用记录。请检查后重试。' WHERE state IN ('queued','running')").run();
  }
  close(){this.db.close();}
  audit(userId,action,subject=null){this.db.prepare('INSERT INTO audit(user_id,action,subject,created_at) VALUES(?,?,?,?)').run(userId,action,subject,new Date().toISOString());}
  addUser({username,name,password,role='user'}){
    if(!/^[A-Za-z0-9._-]{3,60}$/.test(username)||typeof name!=='string'||!name.trim()||name.length>80||typeof password!=='string'||password.length<12||password.length>200||!['user','admin'].includes(role))throw new Error('invalid-account');
    const id=randomUUID();this.db.prepare('INSERT INTO users(id,username,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,username,name.trim(),passwordHash(password),role,new Date().toISOString());return{id,username,name,role};
  }
  listUsers(){return this.db.prepare('SELECT id,username,name,role,disabled,created_at FROM users ORDER BY created_at').all();}
  setDisabled(id,disabled){this.db.prepare('UPDATE users SET disabled=? WHERE id=?').run(disabled?1:0,id);if(disabled)this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);}
  changePassword(id,password){if(typeof password!=='string'||password.length<12||password.length>200)throw new Error('invalid-password');this.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash(password),id);this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);}
  login(username,password){
    const u=this.db.prepare('SELECT * FROM users WHERE username=?').get(username);
    const fallback='00000000000000000000000000000000:'+ '0'.repeat(128);
    const valid=passwordMatches(password,u?.password_hash??fallback);if(!u||u.disabled||!valid)return null;
    const token=randomBytes(32).toString('base64url');this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token),u.id,Date.now()+7*86400000);
    this.audit(u.id,'login');return{token,user:{id:u.id,username:u.username,name:u.name,role:u.role}};
  }
  user(token){if(!token)return null;return this.db.prepare('SELECT u.id,u.username,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0').get(digest(token),Date.now())??null;}
  logout(token){if(token)this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));}
  setProvider(id,key){if(!['glm','deepseek'].includes(id)||typeof key!=='string'||key.length<10||key.length>1024||/[\r\n]/.test(key))throw new Error('invalid-api-key');
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.master,nonce),data=Buffer.concat([cipher.update(key,'utf8'),cipher.final()]);
    const encrypted=Buffer.concat([nonce,cipher.getAuthTag(),data]).toString('base64');this.db.prepare('INSERT INTO providers VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET encrypted_key=excluded.encrypted_key,updated_at=excluded.updated_at').run(id,encrypted,new Date().toISOString());}
  providerKey(id){const r=this.db.prepare('SELECT encrypted_key FROM providers WHERE id=?').get(id);if(!r)return null;const b=Buffer.from(r.encrypted_key,'base64'),d=createDecipheriv('aes-256-gcm',this.master,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');}
  providerStatus(){return ['glm','deepseek'].map(id=>({id,configured:!!this.db.prepare('SELECT id FROM providers WHERE id=?').get(id)}));}
  existingRequest(userId,input,providers){const rows=providers.map(provider=>this.db.prepare('SELECT id,provider,input_json FROM jobs WHERE user_id=? AND request_key=? AND provider=?').get(userId,input.requestId,provider));if(!rows.some(Boolean))return null;if(rows.some(r=>!r||r.input_json!==JSON.stringify(input)))throw new Error('request-id-conflict');return rows.map(r=>({id:r.id,provider:r.provider}));}
  createJob(userId,input,provider){const id=randomUUID(),now=new Date().toISOString();this.db.prepare('INSERT INTO jobs(id,user_id,request_key,title,provider,input_json,state,stage,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,userId,input.requestId??randomUUID(),input.title||'未命名文书',provider,JSON.stringify(input),'queued','等待处理',now,now);this.audit(userId,'job-create',id);return id;}
  createJobs(userId,input,providers){this.db.exec('BEGIN IMMEDIATE');try{const replay=this.existingRequest(userId,input,providers);const rows=replay??providers.map(provider=>({id:this.createJob(userId,input,provider),provider}));this.db.exec('COMMIT');return rows;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  listJobs(userId){return this.db.prepare('SELECT id,title,provider,state,stage,cost,unknown_usage,created_at,updated_at FROM jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(userId);}
  getJob(userId,id){const r=this.db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(id,userId);if(!r)return null;return{...r,input:JSON.parse(r.input_json),result:r.result_json?JSON.parse(r.result_json):null};}
  internalJob(id){const r=this.db.prepare('SELECT user_id FROM jobs WHERE id=?').get(id);return r?this.getJob(r.user_id,id):null;}
  updateJob(id,state,stage,detail='',result){const value=result===undefined?undefined:JSON.stringify(result);const changed=value===undefined?this.db.prepare("UPDATE jobs SET state=?,stage=?,detail=?,updated_at=? WHERE id=? AND state IN ('queued','running')").run(state,stage,detail,new Date().toISOString(),id):this.db.prepare("UPDATE jobs SET state=?,stage=?,detail=?,result_json=?,updated_at=? WHERE id=? AND state IN ('queued','running')").run(state,stage,detail,value,new Date().toISOString(),id);return changed.changes>0;}
  reserveCall(jobId,phase,provider,amount,{maxCost=10,maxCalls=36}={}){
    if(!Number.isFinite(amount)||amount<=0)throw new Error('invalid-cost-reservation');
    if(this.dailyTotal()+amount>50)throw new Error('daily-api-budget-limit');
    const changed=this.db.prepare("UPDATE jobs SET reserved=reserved+?,calls=calls+1 WHERE id=? AND state='running' AND cost+reserved+?<=? AND calls<?").run(amount,jobId,amount,maxCost,maxCalls);
    if(!changed.changes)throw new Error('job-budget-or-call-limit');const id=randomUUID();this.db.prepare('INSERT INTO calls VALUES(?,?,?,?,?,?,?,?,?)').run(id,jobId,phase,provider,'pending',amount,null,null,new Date().toISOString());return id;
  }
  dailyTotal(){const date=new Date(Date.now()+8*3600000).toISOString().slice(0,10),start=new Date(date+'T00:00:00+08:00').toISOString();return this.db.prepare('SELECT COALESCE(SUM(COALESCE(cost,reserved)),0) AS total FROM calls WHERE created_at>=?').get(start).total+this.db.prepare('SELECT COALESCE(SUM(COALESCE(cost,reserved)),0) AS total FROM admin_calls WHERE created_at>=?').get(start).total;}
  reserveAdminCall(userId,provider,amount){if(!Number.isFinite(amount)||amount<=0)throw new Error('invalid-cost-reservation');if(this.dailyTotal()+amount>50)throw new Error('daily-api-budget-limit');const id=randomUUID();this.db.prepare('INSERT INTO admin_calls VALUES(?,?,?,?,?,?,?,?)').run(id,userId,provider,'pending',amount,null,null,new Date().toISOString());return id;}
  finishAdminCall(id,result){const c=this.db.prepare('SELECT * FROM admin_calls WHERE id=?').get(id);if(!c||c.state!=='pending')return;const known=result?.cost?.known===true;this.db.prepare('UPDATE admin_calls SET state=?,cost=?,usage_json=? WHERE id=?').run(known?'recorded':'usage-unknown',known?result.cost.cny:null,JSON.stringify(result??{}),id);}
  finishCall(id,result){const c=this.db.prepare('SELECT * FROM calls WHERE id=?').get(id);if(!c||c.state!=='pending')return;
    const known=result?.cost?.known===true,cost=known?result.cost.cny:null;
    this.db.prepare('UPDATE calls SET state=?,cost=?,usage_json=? WHERE id=?').run(known?'recorded':'usage-unknown',cost,JSON.stringify(result??{}),id);
    this.db.prepare('UPDATE jobs SET reserved=MAX(0,reserved-?),cost=cost+?,unknown_usage=unknown_usage+? WHERE id=?').run(c.reserved,known?cost:c.reserved,known?0:1,c.job_id);
  }
  finishUnsentCall(id){const c=this.db.prepare('SELECT * FROM calls WHERE id=?').get(id);if(!c||c.state!=='pending')return;this.db.prepare("UPDATE calls SET state='not-sent',cost=0,usage_json=? WHERE id=?").run(JSON.stringify({requestSent:false}),id);this.db.prepare('UPDATE jobs SET reserved=MAX(0,reserved-?) WHERE id=?').run(c.reserved,c.job_id);}
  cancelQueued(userId,id){const r=this.getJob(userId,id);if(!r||!['queued','running'].includes(r.state))return false;this.updateJob(id,'cancelled','已停止','已保留生成前的原稿和实际调用记录。');return true;}
  callsFor(id){return this.db.prepare('SELECT phase,provider,state,cost,usage_json FROM calls WHERE job_id=? ORDER BY created_at').all(id).map(x=>({...x,usage:x.usage_json?JSON.parse(x.usage_json):null,usage_json:undefined}));}
}
