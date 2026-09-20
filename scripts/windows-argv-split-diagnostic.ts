import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'gstack-argv-split-'));
const plain=(v:string)=>"'" + v.replaceAll("'", "'\\''") + "'";
const quote=(v:string)=>"'" + v.replaceAll("'", "'\\''").replace(/\\{2,}/g,slashes=>slashes.split('').join("''")) + "'";
const shell=(v:string)=>v.replaceAll('\\','/');
const values=['C:\\owned\\config','\\\\server\\share\\config',"\\\\server\\share\\repo with ' quote $()", '\\\\\\\\server\\share\\config', 'C:\\interior\\\\separators\\\\', "C:\\directory\\'quoted", 'C:\\dollar$(echo NEVER_EXECUTE)\\'+String.fromCharCode(96)+'literal'+String.fromCharCode(96)];
const records:any[]=[];
try{
 const receiver=path.join(root,'receiver.ts');
 fs.writeFileSync(receiver,"console.log(JSON.stringify(process.argv.slice(2)));\n");
 for(const [kind,encode] of [['plain',plain],['split',quote]] as const){
  const command=[shell(process.execPath),shell(receiver),...values].map(encode).join(' ');
  for(const transport of ['-c','-s']){
   const result=spawnSync('bash',transport==='-c'?['-c',command]:['-s'],{encoding:'utf8',timeout:6000,...(transport==='-s'?{input:command+'\n'}:{})});
   let actual;try{actual=JSON.parse(result.stdout);}catch{}
   records.push({kind,transport,command,status:result.status,error:result.error?.message,stdout:result.stdout,stderr:result.stderr,exact:JSON.stringify(actual)===JSON.stringify(values)});
  }
 }
 console.log(JSON.stringify({platform:process.platform,bun:Bun.version,values,records},null,2));
}finally{fs.rmSync(root,{recursive:true,force:true});}
