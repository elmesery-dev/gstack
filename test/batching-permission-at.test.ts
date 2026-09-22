import {test,expect} from 'bun:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {createFilePermissionRecorder,recordFilePermission,currentFilePermissionEpoch} from './helpers/plan-count-file-permission';
import {createPlanCountPermissionGuard,classifyPlanCountFrame} from './helpers/claude-pty-runner';
import {E2E_TOUCHFILES,selectTests}from'./helpers/touchfiles';
import captured from './fixtures/batching-permission-at.json';

function renderPermissionScreen(expected: string, paths: Pick<typeof path, 'dirname' | 'basename'> = path): string {
 // The capture is already laid out at the runner's 120 columns. Replacing its
 // path must reflow that menu line, otherwise the PTY hard-wraps words in half.
 return captured.screen.split('\n').map(original => {
  const line = original.replaceAll(path.posix.dirname(captured.expectedPath), paths.dirname(expected))
   .replaceAll(path.posix.basename(captured.expectedPath), paths.basename(expected));
  if (line === original || line.length <= 120) return line;
  const indent = /^ */.exec(line)![0], lines: string[] = []; let current = indent;
  for (const word of line.trim().split(/\s+/)) {
   if (indent.length + word.length > 120) throw Error('Fixture path exceeds the permission panel width');
   if (current.length > indent.length && current.length + 1 + word.length > 120) { lines.push(current); current = indent; }
   current += (current.length > indent.length ? ' ' : '') + word;
  }
  return [...lines, current].join('\n');
 }).join('\n');
}

function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'batch-permission-')),cwd=path.join(dir,'cwd'),config=path.join(dir,'.claude'),expected=path.join(dir,'report.md');fs.mkdirSync(cwd);fs.writeFileSync(expected,'original');
 const recorder=createFilePermissionRecorder(cwd,config,expected)!;const startedAt=Date.now()-1000;
 const screen=renderPermissionScreen(expected);
 const transcript:any={status:'ready',calls:[],assistantMessages:[{sessionId:'synthetic-epoch',text:'Reviewing',timestamp:new Date().toISOString()}]};
 const record=(name:string,id:string,extra={})=>recordFilePermission(JSON.stringify({hook_event_name:name,tool_name:'Edit',session_id:'synthetic-epoch',tool_use_id:id,cwd,transcript_path:path.join(config,'projects','owned','synthetic-epoch.jsonl'),tool_input:{file_path:expected},...extra}),recorder.file,cwd,config,expected);
 const read=()=>currentFilePermissionEpoch(recorder.file,expected,cwd,config,startedAt,transcript,screen);
 return{dir,cwd,config,expected,recorder,screen,transcript,record,read,close(){recorder.dispose();fs.rmSync(dir,{recursive:true,force:true})}};
}

test('retained retry has a valid permission panel and real previous completion without a pending ID',()=>{
 expect(classifyPlanCountFrame(captured.screen)).toBe('permission');expect(captured.priorCompletedEdit[0]!.name).toBe('Edit');expect(captured.priorCompletedEdit[1]!.isError).toBe(false);
 expect(captured.pendingEditId).toBeNull();expect(captured.provenance.originalOutcome).toBe('timeout');expect(captured.provenance.paidOutcomeReclassified).toBe(false);
 const guard=createPlanCountPermissionGuard();expect(guard(captured.screen,captured.lastMatchedDisplayCompletion)).toBe('grant');expect(guard(captured.screen,captured.lastMatchedDisplayCompletion)).toBe('handled');
});

test('a substituted long fixture path reflows the menu without splitting permission words', () => {
 const prefix = '      always allow access to ', suffix = ' for this ';
 const directory = '/' + 'x'.repeat(120 - prefix.length - suffix.length - 3 - 1);
 const rawLine = `${prefix}${directory}${suffix}session`;
 expect(`${rawLine.slice(0, 120)}\n${rawLine.slice(120)}`).toContain('ses\nsion');
 for (const paths of [path.posix, path.win32]) {
  const expected = paths.join(directory, 'report.md');
  const screen = renderPermissionScreen(expected, paths);
  const menu = screen.slice(screen.indexOf(' Do you want to make this edit'));
  expect(menu.split('\n').every(line => line.length <= 120)).toBe(true);
  expect(menu).toContain(paths.dirname(expected));
  expect(menu).toContain('edit to report.md?');
  expect(menu).toMatch(/1\. Yes[\s\S]+2\. Yes,[\s\S]+3\. No/);
  expect(createPlanCountPermissionGuard()(screen, captured.lastMatchedDisplayCompletion)).toBe('grant');
 }
});

test('synthetic hook epochs release only the later exact request after its predecessor succeeds',()=>{
 const f=fixture();try{const guard=createPlanCountPermissionGuard(),input=()=>guard(f.screen,captured.lastMatchedDisplayCompletion,f.read());
 expect(input()).toBe('handled');f.record('PreToolUse','first');expect(input()).toBe('grant');expect(input()).toBe('handled');
 f.record('PostToolUse','first');expect(input()).toBe('handled');f.record('PreToolUse','first');expect(input()).toBe('handled');
 f.record('PreToolUse','second');expect(input()).toBe('grant');expect(input()).toBe('handled');f.record('PostToolUse','first');expect(input()).toBe('handled');
 }finally{f.close()}
});
for(const reason of ['failed','no-result','foreign-session','foreign-path','other-tool','sidechain'])test(`a later matching menu cannot replace ${reason} predecessor evidence`,()=>{
 const f=fixture();try{const guard=createPlanCountPermissionGuard(),input=()=>guard(f.screen,'',f.read());f.record('PreToolUse','first');expect(input()).toBe('grant');
 if(reason==='failed')f.record('PostToolUseFailure','first');else if(reason!=='no-result')f.record('PostToolUse','first',reason==='foreign-session'?{session_id:'foreign'}:reason==='foreign-path'?{tool_input:{file_path:path.join(f.dir,'foreign','report.md')}}:reason==='other-tool'?{tool_name:'Read'}:{agent_id:'child'});
 f.record('PreToolUse','second');expect(input()).toBe('handled');
 }finally{f.close()}
});

test('batching supplies permission scope without adding a report completion contract',()=>{
 const source=fs.readFileSync(path.join(import.meta.dir,'skill-e2e-plan-eng-multi-finding-batching.test.ts'),'utf8');expect(source).toContain('permissionPlanPath: planPath');expect(source).not.toContain('expectedPlanPath:');
 for(const file of ['test/batching-permission-at.test.ts','test/fixtures/batching-permission-at.json'])expect(selectTests([file],E2E_TOUCHFILES,[]).selected).toEqual(['plan-eng-multi-finding-batching']);
});

test.skipIf(process.platform==='win32')('real fake CLI observes two file epochs without imposing terminal report validation',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'batch-permission-pty-')),fake=path.join(dir,'fake-claude'),worker=path.join(dir,'worker.ts'),events=path.join(dir,'events.jsonl'),output=path.join(dir,'output.json'),expected=path.join(dir,'report.md');fs.writeFileSync(expected,'original');
 const screen=renderPermissionScreen(expected);
 fs.writeFileSync(fake,`#!${process.execPath}\n`+String.raw`
import * as fs from 'node:fs';import * as path from 'node:path';
const item=JSON.parse(process.env.FILE_EPOCH_CASE);const log=e=>fs.appendFileSync(item.events,JSON.stringify(e)+'\n');
const sid='epoch-main';const nativePath=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','epoch',sid+'.jsonl');fs.mkdirSync(path.dirname(nativePath),{recursive:true});
const native=(role,content,extra={})=>fs.appendFileSync(nativePath,JSON.stringify({cwd:process.cwd(),sessionId:sid,isSidechain:false,timestamp:new Date().toISOString(),message:{role,content},...extra})+'\n');
native('assistant',[{type:'text',text:'Reviewing fixture.'}]);log({type:'start',pid:process.pid,cwd:process.cwd()});
const settings=JSON.parse(process.argv[process.argv.indexOf('--settings')+1]);
if(settings.hooks.PreToolUse[0].matcher!=='^ExitPlanMode$')throw Error('Exit recorder changed');
const hook=async(name,id)=>{
 const entries=(settings.hooks[name]??[]).filter(h=>h.matcher==='^(Write|Edit)$');
 if(entries.length!==1)throw Error('Expected exactly one caller-owned file recorder');
 for(const entry of entries){
 const event={hook_event_name:name,tool_name:'Edit',session_id:sid,tool_use_id:id,cwd:process.cwd(),transcript_path:nativePath,tool_input:{file_path:item.activePlan?path.join(process.cwd(),'PLAN.md'):item.expected,old_string:'old',new_string:'new'}};
 const p=Bun.spawn(['bash','-c',entry.hooks[0].command],{stdin:new Blob([JSON.stringify(event)]),stdout:'pipe',stderr:'pipe'});
 const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);if(code||out||err)throw Error('hook was not silent');log({type:'hook',name,id});
 }
};
let stage='startup';const paint=()=>process.stdout.write('\x1b[2J\x1b[H'+item.screen.replaceAll('__ACTIVE_PLAN_PATH__',path.join(process.cwd(),'PLAN.md')).replaceAll('\n','\r\n'));
process.stdin.setRawMode?.(true);process.stdin.on('data',async data=>{
 const input=data.toString();log({type:'input',stage,input});
 if(stage==='startup'){stage='first';await hook('PreToolUse','first');paint();return;}
 if(stage==='old-pane'||stage==='done'){log({type:'unexpected'});return;}
 if(input!=='1\r')throw Error('default permission input changed');
 if(stage==='first'){stage='old-pane';await hook('PostToolUse','first');if(item.intervening){await hook('PreToolUse','automatic');await hook('PostToolUse','automatic');}paint();setTimeout(async()=>{await hook('PreToolUse','second');stage='second';paint();},3200);return;}
 stage='done';await hook('PostToolUse','second');
 const q={header:'Finding',question:'Apply this repair?',options:[{label:'Fix'},{label:'Keep'}]};
 native('assistant',[{type:'tool_use',name:'AskUserQuestion',id:'finding',input:{questions:[q]}}]);native('user',[{type:'tool_result',tool_use_id:'finding',content:'Answered'}],{toolUseResult:{answers:{[q.question]:'Fix'}}});
 process.stdout.write('\x1b[2J\x1b[HCompletion summary\r\n');
});process.on('SIGINT',()=>process.exit(0));process.stdin.resume();process.stdout.write('FILE_EPOCH_READY\r\n');
`);fs.chmodSync(fake,0o755);
 fs.writeFileSync(worker,`import {runPlanSkillCounting} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir,'helpers/claude-pty-runner.ts')).href)};const o=await runPlanSkillCounting({skillName:'plan-eng-review',slashCommand:'/plan-eng-review',followUpPrompt:'Review this disposable batching fixture.',permissionPlanPath:${JSON.stringify(expected)},startupReadyMarker:'FILE_EPOCH_READY',isLastStep0AUQ:()=>false,isReviewAUQ:()=>true,reviewCountCeiling:2,timeoutMs:28000,env:{FILE_EPOCH_CASE:${JSON.stringify(JSON.stringify({events,expected,screen}))}}});await Bun.write(${JSON.stringify(output)},JSON.stringify(o));`);
 const child=Bun.spawn([process.execPath,worker],{env:{...process.env,BROWSE_TERMINAL_BINARY:fake,EVALS_HERMETIC:'1'},stdout:'pipe',stderr:'pipe'});const killer=setTimeout(()=>child.kill('SIGKILL'),33000);
 try{const[code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect(code,out+err).toBe(0);
  const o=JSON.parse(fs.readFileSync(output,'utf8'));expect(o.outcome,JSON.stringify(o)).toBe('completion_summary');expect(o.reviewCount).toBe(1);expect(fs.readFileSync(expected,'utf8')).toBe('original');
  const rows=fs.readFileSync(events,'utf8').trim().split('\n').map(l=>JSON.parse(l));expect(rows.filter(e=>e.type==='input').map(e=>e.input)).toEqual(['/plan-eng-review\r','1\r','1\r']);expect(rows.some(e=>e.type==='unexpected')).toBe(false);
  expect(()=>process.kill(rows[0].pid,0)).toThrow();expect(fs.existsSync(rows[0].cwd)).toBe(false);
 }finally{clearTimeout(killer);child.kill('SIGKILL');if(fs.existsSync(events)){const first=JSON.parse(fs.readFileSync(events,'utf8').split('\n')[0]!);try{process.kill(first.pid,'SIGKILL');}catch{}}fs.rmSync(dir,{recursive:true,force:true});}
},35000);
