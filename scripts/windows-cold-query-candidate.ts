import {readFileSync,writeFileSync} from 'node:fs';
const file='design/src/daemon-state.ts';const before=readFileSync(file,'utf8');
const old='(Get-CimInstance Win32_Process';
if(!before.includes(old))throw Error('Missing native query boundary');
const variant=process.env.QUERY_VARIANT;
let after=before;
if(variant==='qualified')after=before.replace(old,'(CimCmdlets\\\\Get-CimInstance Win32_Process');
else if(variant!=='current')throw Error('Unknown variant');
writeFileSync(file,after);console.log('Native query candidate '+variant);
