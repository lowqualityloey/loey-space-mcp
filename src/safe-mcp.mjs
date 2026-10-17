#!/usr/bin/env node
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const require=createRequire('/home/heyloey/.local/share/loey-space-mcp/package.json');
const {McpServer}=await import(require.resolve('@modelcontextprotocol/sdk/server/mcp.js'));
const {StdioServerTransport}=await import(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'));
const {z}=await import(require.resolve('zod'));
const roots=new Set(['00-inbox','01-daily','02-projects','03-dev','04-learning','06-resources','07-reviews','08-concepts','99-templates']);
const rootFiles=new Set(['agents.md','claude.md','codex.md','gemini.md','promptkit.md','readme.md','home.md','handoff.md','memory.md']);
const maxOutput=24000;
process.umask(0o077);
const oneLine=(length,minLength=1)=>z.string().trim().min(minLength).max(length).regex(/^[^\x00-\x1f\x7f]+$/);

export async function createPolicy(vault){
  const root=await fs.realpath(vault);
  function permitted(file,directory=false){
    const relative=path.relative(root,file);
    if(relative==='')return directory;
    if(path.isAbsolute(relative)||relative==='..'||relative.startsWith('../'))return false;
    const parts=relative.split(path.sep).map(part=>part.toLowerCase());
    if(parts.some(part=>part.startsWith('.')||['secrets.md','credentials.md','passwords.md'].includes(part)))return false;
    if(parts.length===1&&rootFiles.has(parts[0]))return !directory;
    return roots.has(parts[0])&&(directory||parts.at(-1).endsWith('.md'));
  }
  async function resolve(input,{directory=false,missing=false}={}){
    if(input.includes('\0'))throw Error('Access denied by note policy');
    const candidate=path.resolve(root,input);
    if(!permitted(candidate,directory))throw Error('Access denied by note policy');
    let real;
    try{real=await fs.realpath(candidate);}catch(error){
      if(!missing||error.code!=='ENOENT')throw Error('Note or directory is unavailable');
      // Validate every existing parent before allowing a canonical CLI destination.
      let parent=path.dirname(candidate);
      while(true){
        try{real=await fs.realpath(parent);break;}catch(parentError){
          if(parentError.code!=='ENOENT'||parent===path.dirname(parent))throw Error('Access denied by note policy');
          parent=path.dirname(parent);
        }
      }
      if(!permitted(real,true))throw Error('Access denied by note policy');
      return candidate;
    }
    if(!permitted(real,directory))throw Error('Access denied by note policy');
    const info=await fs.stat(real);
    if(directory?!info.isDirectory():!info.isFile())throw Error('Unsupported note type');
    return real;
  }
  async function list(input='.'){
    const dir=await resolve(input,{directory:true});const rows=[];
    for(const entry of await fs.readdir(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name);
      // Do not traverse directory links; a file link must pass both path checks.
      if(entry.isSymbolicLink())continue;
      if(permitted(file,entry.isDirectory())&&(entry.isFile()||entry.isDirectory()))rows.push({name:entry.name,type:entry.isDirectory()?'directory':'file'});
    }
    return rows.sort((a,b)=>a.name.localeCompare(b.name));
  }
  async function read(input,head=150,offset=0,char_offset=0){
    const file=await resolve(input);
    const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const opened=await fs.realpath(`/proc/self/fd/${handle.fd}`);
      if(!permitted(opened))throw Error('Access denied by note policy');
      const info=await handle.stat();if(!info.isFile()||info.size>1024*1024)throw Error('Note exceeds the 1 MiB read limit');
      const full=await handle.readFile('utf8');
      const lines=full.split(/\r?\n/);
      const totalLines=lines.length;
      if(offset>=totalLines){
        return {text:'',truncated:false,totalLines,offset,head,char_offset,next_cursor:null};
      }
      let collected='',lineIndex=offset,linesCount=0,currentCharOffset=char_offset,nextCursor=null;
      while(lineIndex<totalLines&&linesCount<head){
        const lineText=lines[lineIndex].slice(currentCharOffset);
        const prefix=(linesCount>0&&currentCharOffset===0)?'\n':'';
        const needed=prefix.length+lineText.length;
        const available=maxOutput-collected.length;
        if(needed<=available){
          collected+=prefix+lineText;
          lineIndex++;
          linesCount++;
          currentCharOffset=0;
        }else{
          const canTake=Math.max(0,available-prefix.length);
          if(canTake>0)collected+=prefix+lineText.slice(0,canTake);
          nextCursor={offset:lineIndex,char_offset:currentCharOffset+canTake};
          break;
        }
      }
      if(nextCursor===null&&lineIndex<totalLines){
        nextCursor={offset:lineIndex,char_offset:0};
      }
      const truncated=Boolean(nextCursor!==null);
      return {text:collected,truncated,totalLines,offset,head,char_offset,next_cursor:nextCursor};
    }finally{await handle.close();}
  }
  return {root,resolve,list,read,permitted};
}

async function cliPreflight(policy,command){
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Pacific/Auckland',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const month=day.slice(0,7);
  for(const file of ['memory.md','handoff.md',`01-Daily/${month}/${day}.md`,`07-Reviews/handoff-archive-${month}.md`])await policy.resolve(file,{missing:true});
  if(command==='context'){
    // The CLI walks project hubs and runbooks directly; reject linked entries first.
    for(const folder of ['02-Projects','03-Dev']){
      async function inspect(dir,depth){
        let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
        for(const entry of entries){
          const file=path.join(dir,entry.name);
          if(entry.isSymbolicLink())throw Error('CLI context refused: linked project/runbook entry');
          if(entry.isDirectory()&&depth>0)await inspect(file,depth-1);
          if(entry.isFile()&&entry.name.endsWith('.md'))await policy.resolve(file);
        }
      }
      const dir=path.join(policy.root,folder);await policy.resolve(dir,{directory:true,missing:true});await inspect(dir,1);
    }
  }
  // brief optionally loads this local helper. It must stay within the non-private scripts directory.
  const helper=path.join(policy.root,'06-Resources/scripts/weekly-ai-summary.js');
  try{
    const real=await fs.realpath(helper);
    if(real!==helper)throw Error('CLI brief refused: linked helper script');
  }catch(error){if(error.code!=='ENOENT')throw error;}
}

async function findProcessTree(rootPid){
  const pids=new Set([rootPid]),pgids=new Set([rootPid]);
  try{
    const entries=await fs.readdir('/proc');
    const procList=[];
    for(const entry of entries){
      if(!/^[0-9]+$/.test(entry))continue;
      try{
        const stat=await fs.readFile(`/proc/${entry}/stat`,'utf8');
        const rParen=stat.lastIndexOf(')');
        const rest=stat.slice(rParen+2).split(' ');
        procList.push({pid:Number(entry),ppid:Number(rest[1]),pgid:Number(rest[2])});
      }catch{}
    }
    let added=true;
    while(added){
      added=false;
      for(const p of procList){
        if(!pids.has(p.pid)&&pids.has(p.ppid)){
          pids.add(p.pid);
          if(p.pgid)pgids.add(p.pgid);
          added=true;
        }
      }
    }
  }catch{}
  return {pids:Array.from(pids),pgids:Array.from(pgids)};
}

async function isAnyProcessAlive(pids){
  for(const pid of pids){
    try{
      const stat=await fs.readFile(`/proc/${pid}/stat`,'utf8');
      if(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]!=='Z')return true;
    }catch{}
  }
  return false;
}

export async function runCanonical(policy,command,args,{cli='/home/heyloey/.local/bin/heyloey',node=process.execPath}={}){
  if(!['brief','context','done','lock-state'].includes(command))throw Error('Unsupported canonical command');
  await cliPreflight(policy,command);
  const env={PATH:path.dirname(node)+':/usr/bin:/bin',HOME:os.homedir(),LANG:'C.UTF-8',TZ:'Pacific/Auckland',LOEY_SPACE_DIR:policy.root};
  return new Promise((resolve,reject)=>{
    const child=spawn(node,[cli,command,...args],{cwd:os.homedir(),env,stdio:['ignore','pipe','pipe'],detached:true});
    const childPid=child.pid;
    const allPids=new Set(),allPgids=new Set();
    if(childPid){allPids.add(childPid);allPgids.add(childPid);}
    let output='',bytes=0,terminated=false,settled=false;
    let timer=null,killTimer=null,forceSettleTimer=null;

    function cleanup(){
      if(timer)clearTimeout(timer);
      if(killTimer)clearTimeout(killTimer);
      if(forceSettleTimer)clearTimeout(forceSettleTimer);
      try{child.stdout?.destroy();}catch{}
      try{child.stderr?.destroy();}catch{}
    }
    function settleReject(err){
      if(settled)return;
      settled=true;
      cleanup();
      reject(err);
    }
    function settleResolve(val){
      if(settled)return;
      settled=true;
      cleanup();
      resolve(val);
    }
    async function recordTree(){
      if(!childPid)return;
      const tree=await findProcessTree(childPid);
      for(const p of tree.pids)allPids.add(p);
      for(const g of tree.pgids)allPgids.add(g);
    }
    function signalTree(signal){
      for(const g of allPgids)try{process.kill(-g,signal);}catch{}
      for(const p of allPids)try{process.kill(p,signal);}catch{}
      if(childPid){
        try{process.kill(-childPid,signal);}catch{}
        try{child.kill(signal);}catch{}
      }
    }
    async function stopTree(){
      await recordTree();
      signalTree('SIGKILL');
      for(let i=0;i<10;i++){
        if(!await isAnyProcessAlive(allPids))break;
        signalTree('SIGKILL');
        await new Promise(r=>setTimeout(r,50));
      }
    }
    async function terminate(){
      if(terminated)return;
      terminated=true;
      await recordTree();
      signalTree('SIGTERM');
      try{child.stdout?.destroy();}catch{}
      try{child.stderr?.destroy();}catch{}
      killTimer=setTimeout(async ()=>{
        await stopTree();
        settleReject(Error('Canonical CLI did not complete; inspect records before retrying'));
      },2000);
      forceSettleTimer=setTimeout(async ()=>{
        await stopTree();
        settleReject(Error('Canonical CLI did not complete; inspect records before retrying'));
      },2500);
    }

    timer=setTimeout(terminate,30000);
    const consume=chunk=>{
      bytes+=chunk.length;
      if(bytes>128*1024){terminate();return;}
      output+=chunk.toString();
      if(allPids.size<=1)recordTree().catch(()=>{});
    };
    child.stdout?.on('data',consume);
    child.stderr?.on('data',consume);
    child.once('error',err=>settleReject(err));

    child.once('exit',async (code,signal)=>{
      if(terminated||signal){
        terminated=true;
        await stopTree();
        settleReject(Error('Canonical CLI did not complete; inspect records before retrying'));
      }
    });

    child.once('close',async (code,signal)=>{
      if(terminated||signal){
        await stopTree();
        settleReject(Error('Canonical CLI did not complete; inspect records before retrying'));
        return;
      }
      const result=output.split(/\r?\n/).find(line=>line.startsWith('[heyloey] RESULT '))??null;
      const successful=command==='done'?code===0&&/RESULT done (logged|already-recorded)(?: |$)/.test(result??''):code===0;
      settleResolve({exitCode:code,result,output:output.slice(0,maxOutput),truncated:output.length>maxOutput,successful});
    });
  });
}

export async function createServer(options={}){
  const policy=await createPolicy(options.vault??'/mnt/c/Users/jonel/Documents/loey_space');
  const server=new McpServer({name:'loey-space-safe',version:'1.0.0'},{instructions:'External coding access: ordinary notes are read-only. Use heyloey_brief/context for orientation and heyloey_done only for completed milestones. Private/hidden paths and generic writes are unavailable. The Curator owns daily-note creation and general editing.'});
  function tool(name,description,schema,handler,readOnly=true){
    server.registerTool(name,{description,inputSchema:schema,annotations:{readOnlyHint:readOnly,destructiveHint:false}},async args=>{
      try{
        const result=await handler(args);
        const isError=Boolean(result&&typeof result==='object'&&'successful' in result&&!result.successful);
        return {isError,content:[{type:'text',text:JSON.stringify(result)}]};
      }
      catch(error){return {isError:true,content:[{type:'text',text:error.code?'Operation unavailable':error.message}]};}
    });
  }
  tool('list_allowed_directories','Return the fixed vault root and note access policy; MCP client roots cannot expand it.',z.object({}).strict(),async()=>({root:policy.root,readOnly:true,privatePathsExcluded:true}));
  tool('list_directory','List up to 200 permitted note entries; hidden and private entries are omitted.',z.object({path:z.string().max(2000).default('.')}).strict(),async args=>{const entries=await policy.list(args.path);return {entries:entries.slice(0,200),truncated:entries.length>200};});
  tool('read_text_file','Read an ordinary Markdown note, at most 300 lines / 24,000 characters. Private paths and symlink escapes are denied.',z.object({path:z.string().max(2000),head:z.number().int().min(1).max(300).default(150),offset:z.number().int().min(0).default(0),char_offset:z.number().int().min(0).default(0)}).strict(),async args=>policy.read(args.path,args.head,args.offset,args.char_offset));
  tool('get_file_info','Return metadata only for a permitted Markdown note.',z.object({path:z.string().max(2000)}).strict(),async args=>{const info=await fs.stat(await policy.resolve(args.path));return {bytes:info.size,modified:info.mtime.toISOString()};});
  tool('heyloey_brief','Get condensed context through the canonical CLI. Private Kiwi/SOUL mode is unavailable.',z.object({}).strict(),async()=>runCanonical(policy,'brief',[],options));
  tool('heyloey_context','Find project/runbook context through the canonical CLI; no arbitrary file paths or flags.',z.object({query:oneLine(300).refine(value=>!value.startsWith('--'))}).strict(),async args=>runCanonical(policy,'context',[args.query],options));
  tool('heyloey_lock_state','Inspect the canonical writer lock without writing.',z.object({}).strict(),async()=>runCanonical(policy,'lock-state',[],options));
  server.registerTool('heyloey_done',{description:'Log one completed milestone through the canonical locked CLI. Refuses if daily note or handoff is missing; never scaffolds notes.',inputSchema:z.object({summary:oneLine(600,5).refine(value=>!value.startsWith('--'))}).strict(),annotations:{readOnlyHint:false,destructiveHint:false}},async args=>{
    try{const result=await runCanonical(policy,'done',[args.summary],options);return {isError:!result.successful,content:[{type:'text',text:JSON.stringify(result)}]};}
    catch(error){return {isError:true,content:[{type:'text',text:error.code?'Canonical milestone operation unavailable':error.message}]};}
  });
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  createServer().then(server=>server.connect(new StdioServerTransport())).catch(()=>{console.error('loey-space-safe failed to start');process.exitCode=1;});
}
