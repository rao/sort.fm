import {afterAll,expect,test} from 'bun:test';
import {mkdtemp,mkdir,readFile,realpath,rename,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exportPrewarmPriority,parsePrewarmArguments} from './prewarm-priority';
import type {PrewarmPriorityPort} from '../apps/api/src/calibration/prewarm';
import {row,owner,now} from '../apps/api/src/calibration/test-fixtures';
const root=await realpath(await mkdtemp(join(tmpdir(),'sortfm-prewarm-files-')));
afterAll(()=>rm(root,{recursive:true,force:true}));
const port:PrewarmPriorityPort={readPrewarmSnapshot:async userId=>({userId,library:[row(1)],eligibleTrackIds:[row(1).track.trackId],recentExposures:[]})};

test('exports only track IDs to a new private file and refuses overwrite',async()=>{
 const output=join(root,'private','priority.json');
 expect(await exportPrewarmPriority(port,owner,output,{now})).toEqual({count:1,path:output});
 expect(JSON.parse(await readFile(output,'utf8'))).toEqual([row(1).track.trackId]);
 expect((await stat(join(root,'private'))).mode&0o777).toBe(0o700);
 expect((await stat(output)).mode&0o777).toBe(0o600);
 await expect(exportPrewarmPriority(port,owner,output,{now})).rejects.toThrow();
 expect(JSON.parse(await readFile(output,'utf8'))).toEqual([row(1).track.trackId]);
});
test('rejects repository destinations, Git worktrees, symlink directories and public directories before reading',async()=>{
 let reads=0;const guarded:PrewarmPriorityPort={readPrewarmSnapshot:async()=>{reads++;throw Error('should not read');}};
 const repo=join(root,'repo'),worktree=join(root,'worktree'),publicDir=join(root,'public');
 await mkdir(join(repo,'.git'),{recursive:true});await mkdir(worktree);await writeFile(join(worktree,'.git'),'gitdir: /not-used');await mkdir(publicDir,{mode:0o755});
 await symlink(repo,join(root,'repo-link'));await symlink(join(root,'private'),join(root,'private-link'));
 for(const output of [join(repo,'ignored','x.json'),join(worktree,'x.json'),join(root,'repo-link','x.json'),join(root,'private-link','x.json'),join(publicDir,'x.json'),'relative.json'])
  await expect(exportPrewarmPriority(guarded,owner,output,{now})).rejects.toThrow();
 expect(reads).toBe(0);
});
test('failed snapshot creates no output, and an existing symlink is never followed',async()=>{
 const directory=join(root,'fail');await mkdir(directory,{mode:0o700});const output=join(directory,'priority.json');
 await expect(exportPrewarmPriority({readPrewarmSnapshot:async()=>{throw Error('snapshot unavailable');}},owner,output,{now})).rejects.toThrow('snapshot unavailable');
 expect(await Bun.file(output).exists()).toBe(false);
 const victim=join(directory,'victim');await writeFile(victim,'unchanged');await symlink(victim,output);
 await expect(exportPrewarmPriority(port,owner,output,{now})).rejects.toThrow();expect(await readFile(victim,'utf8')).toBe('unchanged');
});
test('operator arguments are explicit and bounded; malformed arguments cannot open a DB',()=>{
 expect(parsePrewarmArguments(['--user-id',owner,'--output','/private/operator/priority.json','--limit','5','--recent-minutes','10'])).toEqual({userId:owner,output:'/private/operator/priority.json',limit:5,recentWindowMs:600000});
 for(const args of [[],['--user-id',owner],['--user-id',owner,'--output','relative'],['--user-id',owner,'--output','/x','--limit','26'],['--user-id',owner,'--output','/x','--limit','2x'],['--user-id',owner,'--output','/x','--recent-minutes','0'],['--user-id',owner,'--output','/x','--user-id','other'],['--user-id',owner,'--output','/x','--extra','yes']])expect(()=>parsePrewarmArguments(args)).toThrow();
});

test('directory substitution during the snapshot cannot redirect the private export',async()=>{
 const parent=join(root,'racing'),moved=join(root,'racing-original'),redirect=join(root,'redirect');
 await mkdir(parent,{mode:0o700});await mkdir(redirect,{mode:0o700});
 const raced:PrewarmPriorityPort={readPrewarmSnapshot:async(userId,query)=>{await rename(parent,moved);await symlink(redirect,parent);return port.readPrewarmSnapshot(userId,query);}};
 await expect(exportPrewarmPriority(raced,owner,join(parent,'priority.json'),{now})).rejects.toThrow();
 expect(await Bun.file(join(redirect,'priority.json')).exists()).toBe(false);expect(await Bun.file(join(moved,'priority.json')).exists()).toBe(false);
});
