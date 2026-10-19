// 有界的数学/时间表达式解析器；只处理数字与白名单运算，不执行用户代码。
export function chineseNumber(text) {
  if(/^\d+(?:\.\d+)?$/.test(text))return Number(text)
  const digits={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9}
  if(/^[零〇一二两三四五六七八九]+$/.test(text))return Number([...text].map(c=>digits[c]).join(''))
  if(text.includes('点')){const [a,b]=text.split('点');return chineseNumber(a)+chineseNumber('零'+b)/10**b.length}
  let sum=0,section=0,current=0
  for(const c of text){
    if(c in digits){current=digits[c];continue}
    const unit={十:10,百:100,千:1000,万:10000,亿:100000000}[c]
    if(!unit)throw Error('数字无法识别')
    if(unit>=10000){sum+=(section+current||1)*unit;section=0}else section+=(current||1)*unit
    current=0
  }
  return sum+section+current
}
const units={毫秒:.001,ms:.001,秒:1,秒钟:1,s:1,分:60,分钟:60,m:60,小时:3600,钟头:3600,时:3600,h:3600,天:86400,日:86400,d:86400,周:604800,星期:604800,w:604800,年:31536000,世纪:3153600000}
const functions={sqrt:x=>Math.sqrt(x),abs:Math.abs,floor:Math.floor,ceil:Math.ceil,round:Math.round,ln:Math.log,log:Math.log10,log10:Math.log10,log2:Math.log2,sin:Math.sin,cos:Math.cos,tan:Math.tan}
const UNIT='(?:分钟|小时|钟头|星期|秒钟|毫秒|ms|秒|分|时|天|日|周|年|世纪|[smhdw])'
function normalize(raw){
 let s=String(raw).normalize('NFKC').toLowerCase().replace(/\s/g,'').replace(/个/g,'')
 s=s.replace(/milliseconds?|msecs?/g,'毫秒').replace(/seconds?|secs?/g,'秒').replace(/minutes?|mins?/g,'分钟').replace(/hours?|hrs?/g,'小时').replace(/days?/g,'天').replace(/weeks?|wks?/g,'周')
 s=s.replace(/\*\*/g,'^')
 if(/^\d{1,3}:[0-5]\d:[0-5]\d$/.test(s)){const [h,m,sec]=s.split(':').map(Number);s=`${h*3600+m*60+sec}秒`}
 s=s.replace(/[零〇一二两三四五六七八九十百千万亿点]+/g,n=>String(chineseNumber(n)))
 s=s.replace(/乘以|乘|×|·/g,'*').replace(/(?<=\d|\))x(?=\d|\()/g,'*').replace(/除以|除|÷/g,'/').replace(/加上|加/g,'+').replace(/减去|减/g,'-')
 s=s.replace(/的(\d+(?:\.\d+)?)次方/g,'^$1').replace(/平方/g,'^2').replace(/立方/g,'^3').replace(/阶乘/g,'!')
 s=s.replace(/根号(\d+(?:\.\d+)?)/g,'sqrt($1)').replace(/√(\d+(?:\.\d+)?)/g,'sqrt($1)').replace(/√(?=\()/g,'sqrt')
 s=s.replace(/π|圆周率/g,'pi')
 s=s.replace(new RegExp(`(\\d+(?:\\.\\d+)?)半(${UNIT})`,'g'),(_,n,u)=>`${Number(n)+.5}${u}`)
 s=s.replace(new RegExp(`半(${UNIT})`,'g'),(_,u)=>`.5${u}`)
 s=s.replace(new RegExp(`(\\d+(?:\\.\\d+)?)(${UNIT})半`,'g'),(_,n,u)=>`${Number(n)+.5}${u}`)
 s=s.replace(/(?<=天|日|时|头|分|钟|秒|周|期)(?:又|零)(?=\d)/g,'+')
 return s
}
export function evaluateMuteDuration(raw){
 if(typeof raw!=='string'||raw.length>240)throw Error('数学式太长或没有明确时长')
 const s=normalize(raw),tokens=[]
 const re=/\d+(?:\.\d*)?(?:e[+-]?\d+)?|\.\d+|log10|log2|sqrt|floor|ceil|round|abs|sin|cos|tan|log|ln|pi|e|分钟|小时|钟头|星期|秒钟|毫秒|ms|秒|分|时|天|日|周|年|世纪|[smhdw]|[()+\-*/^!%]/gy
 let position=0
 while(position<s.length){re.lastIndex=position;const m=re.exec(s);if(!m)throw Error('数学式中含有不支持或不明确的字符');tokens.push(m[0]);position=re.lastIndex;if(tokens.length>120)throw Error('数学式过于复杂')}
 let index=0,steps=0,sawUnit=false
 const check=x=>{if(!Number.isFinite(x.v))throw Error('数学结果不是有限数');if(++steps>250)throw Error('数学式过于复杂');return x}
 function atom(){
   const token=tokens[index++];let x
   if(token==='('){x=add();if(tokens[index++]!==')')throw Error('括号不配对')}
   else if(token in functions){if(tokens[index++]!=='(')throw Error('数学函数需要括号');const a=add();if(tokens[index++]!==')'||a.d!==0)throw Error('数学函数参数无效');x={v:functions[token](a.v),d:0}}
   else if(token==='pi'||token==='e')x={v:token==='pi'?Math.PI:Math.E,d:0}
   else if(token&&/^(?:\d|\.)/.test(token))x={v:Number(token),d:0}
   else throw Error('数学式缺少数字')
   while(tokens[index]==='!'){index++;if(x.d||!Number.isInteger(x.v)||x.v<0||x.v>170)throw Error('阶乘参数无效或过大');let n=1;for(let i=2;i<=x.v;i++)n*=i;x={v:n,d:0}}
   return check(x)
 }
 function power(){let left=atom();if(tokens[index]==='^'){index++;const right=unary();if(left.d||right.d||Math.abs(right.v)>1024)throw Error('乘方参数无效或过大');left=check({v:left.v**right.v,d:0})}return left}
 function unary(){if(tokens[index]==='+'||tokens[index]==='-'){const sign=tokens[index++];const x=unary();return check({v:sign==='-'?-x.v:x.v,d:x.d})}return power()}
 function quantity(){let x=unary();if(tokens[index] in units){if(x.d)throw Error('时间单位重复');x={v:x.v*units[tokens[index++]],d:1};sawUnit=true}return check(x)}
 function multiply(){let left=quantity();while(true){const token=tokens[index],implicit=token==='('||token==='pi'||token==='e'||token in functions; if(!['*','/','%'].includes(token)&&!implicit)break;if(!implicit)index++;const right=quantity();if(token==='%'&&(left.d||right.d))throw Error('时间取余不支持');let d=token==='/'?left.d-right.d:left.d+right.d;if(d<0||d>1)throw Error('时间单位运算不成立');if((token==='/'||token==='%')&&right.v===0)throw Error('不能除以零');left=check({v:token==='/'?left.v/right.v:token==='%'?left.v%right.v:left.v*right.v,d})}return left}
 function add(){let left=multiply();while(index<tokens.length&&tokens[index]!==')'){
   const token=tokens[index],implicit=/^(?:\d|\.)/.test(token||'');if(!['+','-'].includes(token)&&!implicit)break;if(!implicit)index++;const right=multiply();if(left.d!==right.d)throw Error('加减两边需要相同单位');left=check({v:token==='-'?left.v-right.v:left.v+right.v,d:left.d})
 }return left}
 const answer=add();if(index!==tokens.length||!sawUnit||answer.d!==1)throw Error('请在完整数学式后注明秒、分钟、小时或天')
 if(answer.v<=0)throw Error('禁言时长必须为正数')
 if(answer.v>30*86400)return {overLimit:true}
 // QQ 以整数秒计；仅在最终结果处向上取整，避免逐项放大。
 const seconds=Math.max(1,Math.ceil(answer.v-1e-9))
 return {seconds,rounded:Math.abs(answer.v-seconds)>1e-7,defaulted:false}
}
