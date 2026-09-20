import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-argv-probe-'));
const quote=(v:string)=>`'${v.replaceAll("'", "'\\''")}'`;
const shell=(v:string)=>v.replaceAll('\\','/');
const values=['C:\\owned\\config','\\\\server\\share\\config',"\\\\server\\share\\repo with ' quote $()",'\\\\\\\\server\\share\\config'];
const records:any[]=[];
function run(name:string,command:string,args:string[],options:any={}){
 const result=spawnSync(command,args,{encoding:'utf8',timeout:6000,...options});
 records.push({name,command,args,status:result.status,signal:result.signal,error:result.error?{name:result.error.name,message:result.error.message}:null,stdout:result.stdout,stderr:result.stderr});
}
try{
 const receiver=path.join(root,'receiver.ts');
 fs.writeFileSync(receiver,"console.log(JSON.stringify(process.argv.slice(2)));\n");
 const nodeReceiver=path.join(root,'receiver.cjs');
 fs.writeFileSync(nodeReceiver,"console.log(JSON.stringify(process.argv.slice(2)));\n");
 const bun=[shell(process.execPath),shell(receiver)].map(quote).join(' ');
 const payload=values.map(quote).join(' ');
 const builtin=`printf '%s\\n' ${payload}`;
 const command=bun+' '+payload;
 run('bun-direct',process.execPath,[receiver,...values]);
 run('node-direct','node',[nodeReceiver,...values]);
 run('bash-builtin','bash',['-c',builtin]);
 run('bash-to-bun','bash',['-c',command]);
 run('bash-to-node','bash',['-c',`node ${quote(shell(nodeReceiver))} ${payload}`]);
 run('bash-to-bun-no-msys-conversion','bash',['-c',command],{env:{...process.env,MSYS2_ARG_CONV_EXCL:'*',MSYS_NO_PATHCONV:'1'}});
 run('bash-stdin-to-bun','bash',['-s'],{input:command+'\n'});
 const script=path.join(root,'argv.sh');fs.writeFileSync(script,builtin+'\n'+command+'\n');
 run('bash-script-to-bun','bash',[shell(script)]);
 const parent=path.join(root,'node-parent.cjs');
 fs.writeFileSync(parent,"const {spawnSync}=require('node:child_process'); const r=spawnSync('bash',['-c',"+JSON.stringify(command)+"],{encoding:'utf8',timeout:6000}); console.log(JSON.stringify({status:r.status,stdout:r.stdout,stderr:r.stderr,error:r.error?.message}));\n");
 run('node-parent-to-bash-to-bun','node',[parent]);
 console.log(JSON.stringify({platform:process.platform,bun:Bun.version,values,records},null,2));
}finally{fs.rmSync(root,{recursive:true,force:true});}
