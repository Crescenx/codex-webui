import type { Plugin } from 'postcss';

export function vaultStyles(): Plugin {
 return {postcssPlugin:'vault-assistant-scope',OnceExit(root){
  root.walkRules(rule=>{
   if(rule.parent?.type==='atrule' && /keyframes$/.test(rule.parent.name))return;
   // Scope each selector separately: :is() drops pseudo-elements and raises grouped specificity.
   rule.selectors=rule.selectors.map(selector=>{
    if([':root','body','html','#app'].includes(selector))return '.vault-assistant';
    return /^\.vault-assistant(?=$|[\s.:#\[])/.test(selector)?selector:'.vault-assistant '+selector;
   });
  });
 }};
}
