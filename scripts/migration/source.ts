import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
const execute=promisify(execFile);
export type Cell={type:'null'|'integer'|'real'|'blob'|'text';value:string|null};
export type SourceTable={name:string;ddl:string|null;columns:Cell[][];rows:Cell[][]};
export type Snapshot={format:1;integrity:'ok';checksum:string;tables:SourceTable[]};
export async function snapshotBackup(source:string,target:string){await execute('python3',[resolve('scripts/migration/snapshot.py'),'--backup',source,target]);}
export async function readSnapshot(path:string):Promise<Snapshot>{
 const {stdout}=await execute('python3',[resolve('scripts/migration/snapshot.py'),'--read',path],{maxBuffer:256*1024*1024});
 const data=JSON.parse(stdout) as Snapshot;
 if(data.format!==1||data.integrity!=='ok'||!/^[a-f0-9]{64}$/.test(data.checksum)||!Array.isArray(data.tables))throw new Error('Snapshot inválido.');
 return data;
}
export function records(table:SourceTable):Record<string,string|null>[]{const names=table.columns.map(c=>String(c[1].value));return table.rows.map(row=>Object.fromEntries(row.map((v,i)=>[names[i],v.value])));}
