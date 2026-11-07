import {SQL, type TransactionSQL} from 'bun';
export type Transaction = TransactionSQL;
export class Database {
 readonly sql: SQL;
 constructor(url: string, readonly schema='sortfm') {
  if(!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('INVALID_DATABASE_SCHEMA');
  if(!/^postgres(?:ql)?:\/\//.test(url)) throw new Error('DATABASE_URL_REQUIRED');
  this.sql=new SQL(url,{prepare:false,max:8,connectionTimeout:10,idleTimeout:30});
 }
 async transaction<T>(work:(tx:Transaction)=>Promise<T>,serializable=false):Promise<T> {
  return this.sql.begin(serializable?'isolation level serializable':'read write',async tx=>{
   await tx.unsafe(`SET LOCAL search_path TO "${this.schema}", public`);
   return work(tx);
  }) as Promise<T>;
 }
 close(){return this.sql.close();}
}
export function connectDatabase(url=process.env.DATABASE_URL,schema=process.env.DATABASE_SCHEMA??'sortfm') {
 if(!url) throw new Error('DATABASE_URL_REQUIRED');return new Database(url,schema);
}
export class PersistenceError extends Error { constructor(readonly code:string){super(code);} }
export const json=(value:unknown)=>JSON.stringify(value);
