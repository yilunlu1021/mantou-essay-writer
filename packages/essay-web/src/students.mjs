import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';

const hash=value=>createHash('sha256').update(value).digest('hex');
const text=(max)=>z.string().trim().max(max);
export const materialStatusSchema=z.enum(['pending','confirmed','adopted','excluded']);
export const studentInput=z.object({name:text(80).min(1),cohort:text(40).default(''),notes:text(2000).default('')}).strict();
export const materialInput=z.object({title:text(120).min(1),kind:z.enum(['draft','facts','interview','feedback']).default('draft'),
  status:materialStatusSchema.default('pending'),body:z.string().min(1).max(60000).refine(t=>!!t.trim()),
  school:text(160).default(''),prompt:text(10000).default(''),previousId:z.string().uuid().nullable().default(null),
  fileBase64:z.string().min(1).max(7000000).optional(),fileExtension:z.enum(['.docx','.txt','.md']).optional()}).strict().superRefine((value,ctx)=>{if((value.fileBase64!==undefined)!==(value.fileExtension!==undefined))ctx.addIssue({code:'custom',message:'Supply both original bytes and their format, or neither.'});});

export class StudentLibrary {
  constructor(store){this.store=store;this.db=store.db;this.db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS students(id TEXT PRIMARY KEY,name TEXT NOT NULL,cohort TEXT NOT NULL,notes TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS student_members(student_id TEXT NOT NULL REFERENCES students(id),user_id TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(student_id,user_id));
    CREATE TABLE IF NOT EXISTS student_materials(id TEXT PRIMARY KEY,student_id TEXT NOT NULL REFERENCES students(id),created_by TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL,body_hash TEXT NOT NULL,school TEXT NOT NULL,prompt TEXT NOT NULL,previous_id TEXT UNIQUE REFERENCES student_materials(id),version INTEGER NOT NULL,file_base64 TEXT,file_extension TEXT,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS materials_by_student ON student_materials(student_id,created_at);
  `);}
  actor(id){return this.db.prepare('SELECT id,role FROM users WHERE id=? AND disabled=0').get(id);}
  canAccess(actorId,studentId){const actor=this.actor(actorId);return !!actor&&(actor.role==='admin'||!!this.db.prepare('SELECT 1 FROM student_members WHERE student_id=? AND user_id=?').get(studentId,actorId))&&!!this.db.prepare('SELECT 1 FROM students WHERE id=?').get(studentId);}
  require(actorId,studentId){if(!this.canAccess(actorId,studentId))throw new Error('student-not-found');}
  list(actorId){const actor=this.actor(actorId);if(!actor)return[];return this.db.prepare(`SELECT s.id,s.name,s.cohort,s.notes,s.created_at,(SELECT group_concat(u.name,'、') FROM student_members sm JOIN users u ON u.id=sm.user_id WHERE sm.student_id=s.id) AS advisors,(SELECT COUNT(*) FROM student_materials m WHERE m.student_id=s.id) AS materialCount FROM students s WHERE ?='admin' OR EXISTS(SELECT 1 FROM student_members sm WHERE sm.student_id=s.id AND sm.user_id=?) ORDER BY s.name,s.created_at`).all(actor.role,actorId);}
  create(actorId,raw){if(!this.actor(actorId))throw new Error('student-not-found');const input=studentInput.parse(raw),id=randomUUID();this.db.exec('BEGIN IMMEDIATE');try{
    this.db.prepare('INSERT INTO students VALUES(?,?,?,?,?,?)').run(id,input.name,input.cohort,input.notes,actorId,new Date().toISOString());
    this.db.prepare('INSERT INTO student_members VALUES(?,?)').run(id,actorId);this.store.audit(actorId,'student-create',id);this.db.exec('COMMIT');return this.list(actorId).find(s=>s.id===id);
  }catch(e){this.db.exec('ROLLBACK');throw e;}}
  members(actorId,studentId){this.require(actorId,studentId);if(this.actor(actorId).role!=='admin')throw new Error('admin-required');return this.db.prepare('SELECT u.id,u.username,u.name FROM student_members m JOIN users u ON u.id=m.user_id WHERE m.student_id=?').all(studentId);}
  setMembers(actorId,studentId,userIds){this.require(actorId,studentId);if(this.actor(actorId).role!=='admin')throw new Error('admin-required');
    const ids=z.array(z.string().uuid()).max(50).parse(userIds);if(new Set(ids).size!==ids.length||ids.some(id=>!this.actor(id)))throw new Error('invalid-student-members');
    this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('DELETE FROM student_members WHERE student_id=?').run(studentId);for(const id of ids)this.db.prepare('INSERT INTO student_members VALUES(?,?)').run(studentId,id);this.store.audit(actorId,'student-members',studentId);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  materials(actorId,studentId){this.require(actorId,studentId);return this.db.prepare(`SELECT id,title,kind,status,body,body_hash AS bodyHash,school,prompt,previous_id AS previousId,version,created_at AS createdAt,EXISTS(SELECT 1 FROM student_materials newer WHERE newer.previous_id=m.id) AS superseded FROM student_materials m WHERE student_id=? ORDER BY created_at DESC,id`).all(studentId);}
  material(actorId,studentId,id){this.require(actorId,studentId);const row=this.db.prepare('SELECT * FROM student_materials WHERE student_id=? AND id=?').get(studentId,id);if(!row)throw new Error('material-not-found');return row;}
  add(actorId,studentId,raw){this.require(actorId,studentId);const input=materialInput.parse(raw),previous=input.previousId?this.material(actorId,studentId,input.previousId):null;
    if(this.db.prepare('SELECT COUNT(*) AS n FROM student_materials WHERE student_id=?').get(studentId).n>=500)throw new Error('student-material-limit');
    if(previous&&this.db.prepare('SELECT 1 FROM student_materials WHERE previous_id=?').get(previous.id))throw new Error('material-version-conflict');
    const id=randomUUID();this.db.prepare('INSERT INTO student_materials VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,studentId,actorId,input.title,input.kind,input.status,input.body,hash(input.body),input.school,input.prompt,input.previousId,(previous?.version??0)+1,input.fileBase64??null,input.fileExtension??null,new Date().toISOString());
    this.store.audit(actorId,'material-create',id);return this.materials(actorId,studentId).find(m=>m.id===id);
  }
  setStatus(actorId,studentId,id,status){this.material(actorId,studentId,id);status=materialStatusSchema.parse(status);this.db.prepare('UPDATE student_materials SET status=? WHERE id=?').run(status,id);this.store.audit(actorId,'material-status:'+status,id);return this.materials(actorId,studentId).find(m=>m.id===id);}
  snapshot(actorId,studentId,selected){this.require(actorId,studentId);const student=this.list(actorId).find(s=>s.id===studentId),available=this.materials(actorId,studentId);
    const ids=z.array(z.string().uuid()).max(12).parse(selected??[]);if(new Set(ids).size!==ids.length)throw new Error('invalid-material-selection');
    const materials=ids.map(id=>{const row=available.find(m=>m.id===id);if(!row||row.status==='excluded')throw new Error('material-not-found');return row;}).map(({id,title,kind,status,body,bodyHash,school,prompt,version,createdAt})=>({id,title,kind,status,body,bodyHash,school,prompt,version,createdAt}));
    if(materials.reduce((n,m)=>n+m.body.length,0)>120000)throw new Error('material-selection-too-large');
    const value={student:{id:student.id,name:student.name,cohort:student.cohort},materials,createdAt:new Date().toISOString()};return {...value,hash:hash(JSON.stringify(value))};
  }
  jobAllowed(actorId,row){let input;try{input=JSON.parse(row.input_json);}catch{return false;}return row.user_id===actorId&&(!input.studentId||this.canAccess(actorId,input.studentId));}
}
