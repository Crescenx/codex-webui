import type { Processor } from 'unified';
import type { Construct, State, Token, Tokenizer } from 'micromark-util-types';
import type { Extension, Handle } from 'mdast-util-from-markdown';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    viewerMath: 'viewerMath';
    viewerMathFlow: 'viewerMathFlow';
    viewerMathPending: 'viewerMathPending';
    viewerMathFlowPending: 'viewerMathFlowPending';
    viewerMathData: 'viewerMathData';
  }
}

const lineEnding = (code:number|null) => code === -3 || code === -4 || code === -5;
const codeFence:Construct={partial:true,tokenize(effects,ok,nok){
  let marker:number|null;let size=0;
  const sequence:State=code=>{if(code!==marker)return nok(code);effects.consume(code);return ++size===3?ok:sequence;};
  return code=>{marker=code;return sequence(code);};
}};
function construct(flow:boolean, dollar=false):Construct {
  const tokenize:Tokenizer=function(effects,ok,nok) {
    // Closed display math can interrupt prose: its '=' lines are not Setext headings.
    let token:Token;let close:number;let count=0;
    let dataOpen=false;
    const consume=(code:number)=>{count++;if(!dataOpen){effects.enter('viewerMathData');dataOpen=true;}effects.consume(code);};
    const flush=()=>{if(dataOpen){effects.exit('viewerMathData');dataOpen=false;}};
    const start:State=code=>{
      if(dollar && this.previous===36)return nok(code);
      token=effects.enter(flow?'viewerMathFlow':'viewerMath');consume(code!);return open;
    };
    const open:State=code=>{
      if(dollar){if(code!==36)return nok(code);close=36;consume(code);return code=>code===36?nok(code):body(code);}
      if(code!==91 && (flow || code!==40))return nok(code);
      close=code===91?93:41;consume(code);return body;
    };
    const body:State=code=>{
      // ponytail: bound delimiter lookahead; oversized/unclosed input remains plain text.
      if(code===null || count>=32768) {
        if(flow && code!==null)return nok(code);
        flush();token.type=flow?'viewerMathFlowPending':'viewerMathPending';effects.exit(token.type);return ok(code);
      }
      if(lineEnding(code)){count++;flush();effects.enter('lineEnding');effects.consume(code);effects.exit('lineEnding');return flow?lineStart:body;}
      consume(code);return code===92?escape:dollar && code===36?dollarClose:body;
    };
    const dollarClose:State=code=>{
      if(code===36){consume(code);return after;}
      return body(code);
    };
    const lineStart:State=code=>{
      if(count<32768 && (code===32 || code===-1 || code===-2)){consume(code);return lineStart;}
      return code===96 || code===126?effects.check(codeFence,nok,body)(code):body(code);
    };
    const escape:State=code=>{
      if(count>=32768)return body(code);
      if(!dollar && code===close){consume(code);return after;}
      if(dollar && code===36){consume(code);return body;}
      // Do not repeatedly scan later formulas when an earlier block was left open.
      if(flow && !dollar && code===91)return nok(code);
      // An escaped backslash cannot also start a closing delimiter.
      if(code===92){consume(code);return body;}
      return body(code);
    };
    const after:State=code=>{
      if(dollar && code===36)return nok(code);
      if(flow && code!==null && !lineEnding(code))return nok(code);
      flush();effects.exit(token.type);return ok(code);
    };
    return start;
  };
  return {name:flow?'viewerMathFlow':'viewerMath',tokenize,concrete:flow};
}

// Run inside Markdown's tokenizer, before character escapes. Code and link destinations
// use their own constructs, so their backslashes never enter this math tokenizer.
export function remarkBracketMath(this:Processor) {
  const data=this.data();
  // Dollar displays may close after TeX on the same line, without swallowing later prose.
  (data.micromarkExtensions??=[]).push({flow:{92:construct(true),36:construct(true,true)},text:{92:construct(false),36:construct(false,true)}});
  const enter:Handle=function(token) {
    const raw=this.sliceSerialize(token);
    if(token.type==='viewerMathFlowPending') {this.enter({type:'paragraph',children:[{type:'text',value:raw}]},token);this.buffer();return;}
    if(token.type==='viewerMathPending') {this.enter({type:'text',value:raw},token);this.buffer();return;}
    const value=raw.slice(2,-2).trim();const display=raw[1]==='[' || raw.startsWith('$$');
    const code={type:'element' as const,tagName:'code',properties:{className:['language-math',display?'math-display':'math-inline']},children:[{type:'text' as const,value}]};
    this.enter(token.type==='viewerMathFlow'
      ?{type:'math',value,data:{hName:'pre',hChildren:[code]}}
      :{type:'inlineMath',value,data:{hName:'code',hProperties:code.properties,hChildren:code.children}},token);
    this.buffer();
  };
  const exit:Handle=function(token){this.resume();this.exit(token);};
  const extension:Extension={enter:{viewerMath:enter,viewerMathFlow:enter,viewerMathPending:enter,viewerMathFlowPending:enter},exit:{viewerMath:exit,viewerMathFlow:exit,viewerMathPending:exit,viewerMathFlowPending:exit}};
  (data.fromMarkdownExtensions??=[]).push(extension);
}
