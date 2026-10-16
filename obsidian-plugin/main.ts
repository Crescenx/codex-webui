import { Plugin, ItemView, PluginSettingTab, Setting, Notice, FileSystemAdapter, MarkdownView, FuzzySuggestModal, TFile, Menu } from 'obsidian';
import type { App, WorkspaceLeaf } from 'obsidian';
import { createApp } from 'vue';
import VaultApp from './VaultApp.vue';
import { desktopClient } from './client.ts';
import { createViewerStore } from '../web/store.ts';
import { setViewerRoot, setMaterialHost } from '../web/environment.ts';
import type { VaultBinding } from '../shared/vault.ts';
import { request } from 'node:http';
import { posix } from 'node:path';
import { discussionPrompt } from './discussion.ts';
import '../web/style.css';
import 'katex/dist/katex.min.css';
import './style.css';
const VIEW='vault-assistant';
type Data={endpoint:string;binding?:VaultBinding;lastSession?:string;storage:Record<string,string>};
class MaterialPicker extends FuzzySuggestModal<TFile>{
 resolve:(value:TFile|null)=>void;chosen=false;
 constructor(app:App,resolve:(value:TFile|null)=>void){super(app);this.resolve=resolve;this.setPlaceholder('选择笔记或论文');}
 getItems(){return this.app.vault.getFiles().filter(f=>['md','pdf'].includes(f.extension));}
 getItemText(file:TFile){return file.path;}
 onChooseItem(file:TFile){this.chosen=true;this.resolve(file);}
 onClose(){if(!this.chosen)this.resolve(null);}
}
async function pairRequest(endpoint:string,body:unknown):Promise<any>{
 return new Promise((resolve,reject)=>{
  const data=Buffer.from(JSON.stringify(body));
  const req=request(new URL('/api/vault/pair',endpoint),{method:'POST',headers:{'Content-Type':'application/json','Content-Length':String(data.length)}},res=>{
   let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>{try{const result=JSON.parse(text);if(res.statusCode!==200)reject(new Error(result.error));else resolve(result);}catch(e){reject(e);}});
  });req.on('error',reject);req.setTimeout(10000,()=>req.destroy(new Error('Viewer 后端连接超时')));req.end(data);
 });
}
export default class VaultAssistantPlugin extends Plugin {
 data:Data={endpoint:'http://127.0.0.1:8787',storage:{}};
 saveTimer:ReturnType<typeof setTimeout>|undefined; discussionPending=false;
 async onload(){
  this.data={...this.data,...await this.loadData()};this.data.storage||={};
  this.registerView(VIEW,leaf=>new AssistantView(leaf,this));
  this.addRibbonIcon('messages-square','Vault Assistant',()=>void this.open());
  this.addCommand({id:'open',name:'打开独立助手窗口',callback:()=>void this.open()});
  this.addCommand({id:'discuss-file',name:'讨论当前文章',checkCallback:checking=>{
   const file=this.app.workspace.getActiveFile();if(!file || !['md','pdf'].includes(file.extension))return false;
   if(!checking)void this.discuss(file);return true;
  }});
  this.addCommand({id:'discuss-selection',name:'讨论当前选区',editorCheckCallback:(checking,editor,info)=>{
   const text=editor.getSelection();if(!info.file || !text.trim())return false;
   if(!checking)void this.discuss(info.file,text);return true;
  }});
  this.registerEvent(this.app.workspace.on('file-menu',(menu,file)=>{
   if(file instanceof TFile && ['md','pdf'].includes(file.extension))menu.addItem(item=>item.setTitle('讨论该文章').setIcon('messages-square').onClick(()=>void this.discuss(file)));
  }));
  this.registerEvent(this.app.workspace.on('editor-menu',(menu,editor,info)=>{
   if(!info.file)return;const file=info.file,text=editor.getSelection();
   menu.addItem(item=>item.setTitle(text.trim()?'讨论该选区':'讨论该文章').setIcon('messages-square').onClick(()=>void this.discuss(file,text.trim()?text:undefined)));
  }));
  // Reading mode and PDF selections have no Editor; capture only the right-clicked selection.
  const observed=new Set<Document>();const observe=(doc:Document)=>{
   if(observed.has(doc))return;observed.add(doc);
   const listener=(event:MouseEvent)=>{
    const target=event.target as Element|null;
    if(!target?.closest?.('.markdown-preview-view, .pdf-container'))return;
    const selection=doc.getSelection();if(!selection?.toString().trim())return;
    let file:TFile|undefined;this.app.workspace.iterateAllLeaves(leaf=>{
     const view=leaf.view as typeof leaf.view & {file?:TFile};
     if(view.getViewType()!==VIEW && view.file && view.containerEl.contains(target) && selection.anchorNode && selection.focusNode && view.containerEl.contains(selection.anchorNode) && view.containerEl.contains(selection.focusNode))file=view.file;
    });
    if(!file || !['md','pdf'].includes(file.extension))return;const selected=selection.toString(),source=file;
    event.preventDefault();event.stopPropagation();
    new Menu().addItem(item=>item.setTitle('复制').setIcon('copy').onClick(()=>void doc.defaultView?.navigator.clipboard.writeText(selected).catch(e=>new Notice(String(e))))).addSeparator().addItem(item=>item.setTitle('讨论该选区').setIcon('messages-square').onClick(()=>void this.discuss(source,selected))).showAtMouseEvent(event);
   };
   doc.addEventListener('contextmenu',listener,true);this.register(()=>doc.removeEventListener('contextmenu',listener,true));
  };
  observe(document);this.app.workspace.iterateAllLeaves(l=>observe(l.view.containerEl.ownerDocument));this.registerEvent(this.app.workspace.on('window-open',(_win,win)=>observe(win.document)));
  this.addSettingTab(new AssistantSettings(this.app,this));
 }
 onunload(){clearTimeout(this.saveTimer);void this.saveData(this.data);}
 persist(){clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>void this.saveData(this.data),400);}
 async discuss(file:TFile,selection?:string){
  if(this.discussionPending){new Notice('正在准备会话');return;}this.discussionPending=true;
  try{const view=await this.open();if(!view.preparePrompt)throw new Error('请先在插件设置中连接当前 vault');await view.preparePrompt(discussionPrompt(this.app.vault.getName(),file.path,selection));}
  catch(e){new Notice(String(e));}finally{this.discussionPending=false;}
 }
 secretId(){return 'vault-assistant-'+(this.data.binding?.id||'').replaceAll('-','');}
 client(){
  if(!this.data.binding)return null;
  const token=this.app.secretStorage.getSecret(this.secretId());if(!token)return null;
  return desktopClient({endpoint:this.data.endpoint,token,binding:this.data.binding,open:t=>this.openMaterial(t)});
 }
 async pair(link:string){
  if(!(this.app.vault.adapter instanceof FileSystemAdapter))throw new Error('仅支持桌面文件 vault');
  const url=new URL(link);if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('仅接受本地 Viewer 启动链接');
  const token=url.searchParams.get('token');if(!token)throw new Error('请粘贴包含 token 的完整 Viewer 启动链接');
  const result=await pairRequest(url.origin,{launchToken:token,name:this.app.vault.getName(),windowsRoot:this.app.vault.adapter.getBasePath()});
  this.data.endpoint=url.origin;this.data.binding=result.binding;this.app.secretStorage.setSecret(this.secretId(),result.token);await this.saveData(this.data);
  for(const leaf of this.app.workspace.getLeavesOfType(VIEW))leaf.detach();
  new Notice('Vault Assistant 已连接到当前 vault');await this.open();
 }
 async open(){
  const existing=this.app.workspace.getLeavesOfType(VIEW)[0];if(existing){await this.app.workspace.revealLeaf(existing);return existing.view as AssistantView;}
  const leaf=this.app.workspace.openPopoutLeaf({size:{width:1100,height:850}});await leaf.setViewState({type:VIEW,active:true});await this.app.workspace.revealLeaf(leaf);return leaf.view as AssistantView;
 }
 async openMaterial(target:string){
  const root=this.data.binding?.root || '';
  let raw=target.startsWith(root+'/')?target.slice(root.length+1):target;
  const page=/#page=(\d+)$/.exec(raw);if(page)raw=raw.slice(0,page.index);
  const line=/:(\d+)(?::\d+)?$/.exec(raw);if(line)raw=raw.slice(0,line.index);
  const file=this.app.vault.getFileByPath(raw.split('#')[0]);if(!file)throw new Error('材料不存在：'+raw);
  const leaf=this.app.workspace.getLeavesOfType('markdown').find(l=>l!==this.app.workspace.getLeavesOfType(VIEW)[0]) || this.app.workspace.getLeaf('tab');
  await leaf.openFile(file,{active:true,state:page?{page:Number(page[1])}:line?{line:Number(line[1])-1}:undefined});
  if(raw.includes('#')&&!page && leaf.view instanceof MarkdownView){const heading=raw.split('#').slice(1).join('#'),cache=this.app.metadataCache.getFileCache(file);const target=heading.startsWith('^')?cache?.blocks?.[heading.slice(1)]?.position.start.line:cache?.headings?.find(h=>h.heading===heading)?.position.start.line;if(target!==undefined){leaf.view.editor.setCursor({line:target,ch:0});leaf.view.editor.scrollIntoView({from:{line:target,ch:0},to:{line:target,ch:0}},true);}}
  await this.app.workspace.revealLeaf(leaf);
 }
 async choose(){return new Promise<TFile|null>(resolve=>new MaterialPicker(this.app,resolve).open());}
 async save(text:string){
  const file=await this.choose();if(!file)return;if(file.extension!=='md')throw new Error('请选择 Markdown 笔记');
  const editor=this.app.workspace.getLeavesOfType('markdown').map(l=>l.view).find(v=>v instanceof MarkdownView && v.file?.path===file.path) as MarkdownView|undefined;
  const content=editor?.editor.getValue() ?? await this.app.vault.read(file);
  const addition='\n\n## 讨论记录\n\n'+text+'\n';
  if(editor){editor.editor.setValue(content+addition);}else await this.app.vault.process(file,old=>old+addition);
 }
}
class AssistantView extends ItemView {
 plugin:VaultAssistantPlugin;unmount?:()=>void;preparePrompt?:(text:string)=>Promise<void>;
 constructor(leaf:WorkspaceLeaf,plugin:VaultAssistantPlugin){super(leaf);this.plugin=plugin;}
 getViewType(){return VIEW;}getDisplayText(){return 'Vault Assistant';}getIcon(){return 'messages-square';}
 async onOpen(){
  const p=this.plugin;this.contentEl.empty();this.contentEl.addClass('vault-assistant');setViewerRoot(this.contentEl);
  const client=p.client();
  if(!client||!p.data.binding){this.contentEl.createEl('h2',{text:'连接 Codex Viewer'});this.contentEl.createEl('p',{text:'在插件设置中粘贴现有 Viewer 的完整启动链接。执行仍在 WSL Codex，论文与笔记留在当前 vault。'});return;}
  const storage={getItem:(key:string)=>p.data.storage[key]??null,setItem:(key:string,value:string)=>{p.data.storage[key]=value;p.persist();},removeItem:(key:string)=>{delete p.data.storage[key];p.persist();}};
  const store=createViewerStore(client,storage,{reloadOnRestart:false});
  setMaterialHost(target=>store.openFile(store.state.currentId,target),target=>{
   const root=p.data.binding!.root,absolute=posix.resolve(store.current.value?.cwd || root,target);
   if(!absolute.startsWith(root+'/'))return '';
   const relative=absolute.slice(root.length+1);if(relative.split('/').some(s=>s.startsWith('.')))return '';
   return p.app.vault.adapter.getResourcePath(relative);
  },p.app.vault.getName(),p.data.binding.root);
  const host={binding:p.data.binding,lastSession:p.data.lastSession,save:(text:string)=>p.save(text),selection:()=>this.contentEl.ownerDocument.getSelection()?.toString()||'',remember:(id:string)=>{p.data.lastSession=id;p.persist();}};
  const app=createApp(VaultApp,{store,host});const component=app.mount(this.contentEl) as unknown as {preparePrompt:(text:string)=>Promise<void>};this.preparePrompt=text=>component.preparePrompt(text);this.unmount=()=>app.unmount();
  this.contentEl.onWindowMigrated(()=>setViewerRoot(this.contentEl));
 }
 async onClose(){this.unmount?.();this.unmount=undefined;this.preparePrompt=undefined;setViewerRoot(undefined);setMaterialHost();}
}
class AssistantSettings extends PluginSettingTab {
 plugin:VaultAssistantPlugin;
 constructor(app:App,plugin:VaultAssistantPlugin){super(app,plugin);this.plugin=plugin;}
 display(){
  this.containerEl.empty();this.containerEl.createEl('h2',{text:'Vault Assistant'});
  let link='';
  new Setting(this.containerEl).setName('Viewer 启动链接').setDesc('连接与网页相同的后端，共享已授权项目的会话与引用。令牌保存于本机 Obsidian SecretStorage，不写入插件配置。').addText(text=>text.setPlaceholder('http://127.0.0.1:8787/?token=…').onChange(value=>link=value)).addButton(button=>button.setButtonText('连接当前 vault').onClick(()=>void this.plugin.pair(link).catch(e=>new Notice(String(e)))));
  new Setting(this.containerEl).setName('当前连接').setDesc(this.plugin.data.binding?this.plugin.data.endpoint+' · '+this.plugin.data.binding.name:'尚未连接');
 }
}
