export function discussionPrompt(vault:string,path:string,selection?:string){
 const uri='obsidian://open?'+new URLSearchParams({vault,file:path});
 const label=path.replaceAll('\\','\\\\').replaceAll('[','\\[').replaceAll(']','\\]');
 const source='来源文件：['+label+']('+uri+')\nVault 内路径：'+JSON.stringify(path);
 if(selection?.trim())return '讨论这篇文章中的选区：\n'+source+'\n\n选区：\n'+selection.split(/\r?\n/).map(line=>'> '+line).join('\n')+'\n\n我想进一步讨论：';
 return '讨论这篇文章：\n'+source+'\n\n我想进一步讨论：';
}
