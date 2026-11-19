/* Transparent OHLC heuristics. No performance or probability claims. */
const definitions = [
['Order Block','Last opposing candle before a body larger than 1.5 ATR that breaks a confirmed swing. Uninvalidated zones are entry candidates.'],
['Fair Value Gap','Three-candle gap: current low exceeds the high two bars earlier (bullish), or current high is below the earlier low (bearish). Fully traversed gaps are removed.'],
['Break of Structure','Close crosses the latest confirmed swing in the prevailing swing trend direction.'],
['Change of Character','First close across an opposing confirmed swing against the prevailing structure.'],
['Market Structure Shift','A change of character with a candle body greater than 1.5 ATR.'],
['Liquidity Sweep','Wick passes the latest confirmed swing and the candle closes back inside.'],
['Liquidity Grab','A sweep with a rejection wick larger than its body; a narrower subset of the sweep heuristic.'],
['Breaker Block','An order block closed through its far edge, then retested from the opposing side.'],
['Mitigation Block','An uninvalidated order block revisited after at least three candles, with a close on its directional side.'],
['Premium / Discount','Position relative to the midpoint of the last 60 candles. Above is premium; below is discount.'],
['Equal Highs / Lows','Two confirmed swing prices within 0.15 ATR. Potential liquidity pools, not confirmed resting orders.'],
['Displacement','Directional candle body exceeds 1.5 times the preceding 14-bar ATR.'],
['Inducement','Heuristic: a minor confirmed swing inside the 60-bar range is swept before a displacement. This interpretation is subjective.'],
['Balanced Price Range','A price overlap between opposing three-candle gaps formed within the last 20 candles.']
];
function analyzeCandles(data){
 if(data.length<60)throw Error('At least 60 closed candles are required.');
 const n=data.length,last=data[n-1], tr=data.map((c,i)=>Math.max(c.h-c.l,i?Math.abs(c.h-data[i-1].c):0,i?Math.abs(c.l-data[i-1].c):0));
 const atrAt=i=>tr.slice(Math.max(0,i-14),i).reduce((a,b)=>a+b,0)/Math.min(14,i||1);
 const atr=tr.slice(-14).reduce((a,b)=>a+b,0)/14;if(!(atr>0))throw Error('Candles have no measurable volatility.');
 let highs=[],lows=[],events=[],zones=[],gaps=[],blocks=[],prevTrend=0,hi=null,lo=null,broken=new Set();
 const event=(name,dir,i,detail)=>events.push({name,dir,i,detail});
 for(let i=4;i<n;i++){
  const k=i-2,c=data[i],p=data[i-1],a=atrAt(i);
  if(data.slice(k-2,k+3).every((x,j)=>j===2||data[k].h>x.h)){hi={p:data[k].h,i:k};highs.push(hi)}
  if(data.slice(k-2,k+3).every((x,j)=>j===2||data[k].l<x.l)){lo={p:data[k].l,i:k};lows.push(lo)}
  let structure=highs.length>1&&lows.length>1?(highs.at(-1).p>highs.at(-2).p&&lows.at(-1).p>lows.at(-2).p?1:highs.at(-1).p<highs.at(-2).p&&lows.at(-1).p<lows.at(-2).p?-1:0):0;
  if(!prevTrend&&structure)prevTrend=structure;
  const disp=Math.abs(c.c-c.o)>1.5*a,dir=c.c>c.o?1:-1;
  if(disp)event('Displacement',dir,i,'Body exceeds 1.5 ATR');
  let swept=0;
  if(hi&&c.h>hi.p&&c.c<hi.p){event('Liquidity Sweep',-1,i,'Buy-side swing swept');swept=-1;if(c.h-Math.max(c.o,c.c)>Math.abs(c.c-c.o))event('Liquidity Grab',-1,i,'Upper wick rejection')}
  if(lo&&c.l<lo.p&&c.c>lo.p){event('Liquidity Sweep',1,i,'Sell-side swing swept');swept=1;if(Math.min(c.o,c.c)-c.l>Math.abs(c.c-c.o))event('Liquidity Grab',1,i,'Lower wick rejection')}
  const localRange=data.slice(Math.max(0,i-60),i),rangeHigh=Math.max(...localRange.map(x=>x.h)),rangeLow=Math.min(...localRange.map(x=>x.l));
  if(swept&&disp&&(swept===1?lo&&lo.p>rangeLow:hi&&hi.p<rangeHigh))event('Inducement',swept,i,'Internal swing sweep and displacement');
  for(const [s,d] of [[hi,1],[lo,-1]]){
   if(!s||broken.has(d+':'+s.i))continue;
   if(d===1?c.c>s.p&&p.c<=s.p:c.c<s.p&&p.c>=s.p){
    broken.add(d+':'+s.i);const change=prevTrend&&prevTrend!==d;
    event(change?'Change of Character':'Break of Structure',d,i,'Close broke a confirmed swing');
    if(change&&disp)event('Market Structure Shift',d,i,'Structure change with displacement');
    prevTrend=d;
    if(disp){for(let j=i-1;j>=Math.max(0,i-8);j--){if((data[j].c-data[j].o)*d<0){const z={name:'Order Block',dir:d,low:data[j].l,high:data[j].h,i:j,born:i,invalid:false};blocks.push(z);event('Order Block',d,i,'Opposing candle before displacement break');break}}}
   }
  }
  if(c.l>data[i-2].h){gaps.push({name:'Fair Value Gap',dir:1,low:data[i-2].h,high:c.l,i,born:i});event('Fair Value Gap',1,i,'Bullish three-candle imbalance')}
  if(c.h<data[i-2].l){gaps.push({name:'Fair Value Gap',dir:-1,low:c.h,high:data[i-2].l,i,born:i});event('Fair Value Gap',-1,i,'Bearish three-candle imbalance')}
  for(const b of blocks){if(i<=b.born)continue;if(!b.invalid&&(b.dir===1?c.c<b.low:c.c>b.high)){b.invalid=true;b.failedAt=i}
   if(b.invalid&&i>b.failedAt&&c.l<=b.high&&c.h>=b.low&&(b.dir===1?c.c<b.low:c.c>b.high))event('Breaker Block',-b.dir,i,'Failed block retest');
   if(!b.invalid&&i>b.born+2&&c.l<=b.high&&c.h>=b.low&&(b.dir===1?c.c>b.high:c.c<b.low))event('Mitigation Block',b.dir,i,'Valid block revisit');
  }
 }
 const recent=events.filter(e=>e.i>=n-20),rangeData=data.slice(-60),top=Math.max(...rangeData.map(c=>c.h)),bottom=Math.min(...rangeData.map(c=>c.l)),mid=(top+bottom)/2;
 for(const [arr,d,label] of [[highs,-1,'Equal highs'],[lows,1,'Equal lows']]){let found=false;for(let j=arr.length-1;j>=0&&!found;j--)for(let k=j-1;k>=0;k--)if(arr[j].i>=n-60&&Math.abs(arr[j].p-arr[k].p)<atr*.15){recent.push({name:'Equal Highs / Lows',dir:d,i:arr[j].i,detail:label+' within 0.15 ATR'});found=true;break}}
 const activeGaps=gaps.filter(g=>!data.slice(g.i+1).some(c=>g.dir===1?c.l<=g.low:c.h>=g.high));
 const rawRecent=gaps.filter(g=>g.i>=n-20);for(const g of rawRecent)for(const h of rawRecent)if(g.dir!==h.dir&&Math.max(g.low,h.low)<Math.min(g.high,h.high)){recent.push({name:'Balanced Price Range',dir:prevTrend,i:Math.max(g.i,h.i),detail:'Opposing gaps overlap'});break}
 zones=[...blocks.filter(b=>!b.invalid),...activeGaps].filter(z=>z.i>=n-100);
 const bull=new Set(recent.filter(e=>e.dir===1).map(e=>e.name)),bear=new Set(recent.filter(e=>e.dir===-1).map(e=>e.name));
 let long=(prevTrend===1?2:0)+(last.c<mid?1:0)+['Break of Structure','Change of Character','Market Structure Shift','Liquidity Sweep','Displacement'].filter(s=>bull.has(s)).length;
 let short=(prevTrend===-1?2:0)+(last.c>mid?1:0)+['Break of Structure','Change of Character','Market Structure Shift','Liquidity Sweep','Displacement'].filter(s=>bear.has(s)).length;
 const dir=long===short?prevTrend||1:long>short?1:-1,points=Math.max(long,short), candidates=zones.filter(z=>z.dir===dir&&(dir===1?z.high<last.c+atr:z.low>last.c-atr)).sort((a,b)=>Math.abs((a.low+a.high)/2-last.c)-Math.abs((b.low+b.high)/2-last.c));
 const zone=candidates[0], entry=zone?(zone.low+zone.high)/2:last.c,stop=dir===1?Math.min(zone?zone.low:entry-atr,lo?lo.p:entry-atr)-atr*.25:Math.max(zone?zone.high:entry+atr,hi?hi.p:entry+atr)+atr*.25;
 const distance=Math.abs(entry-stop),tp1=entry+dir*distance,tp2=entry+dir*distance*2,wait=points<3||Math.abs(long-short)<2||!zone||Math.abs(entry-last.c)>atr*2||distance/entry>.08;
 return {atr,top,bottom,mid,trend:prevTrend,dir,points,long,short,score:Math.round(points/8*100),entry,stop,tp1,tp2,wait,zone,zones,recent,highs,lows,last,reason:wait?'Conditions are mixed or entry is outside the active zone. Wait for a confirmed retest.':`Conditional ${dir===1?'long':'short'} bias. Watch for rejection at the ${zone.name.toLowerCase()}; invalidate beyond the stop.`};
}
if(typeof module!=='undefined')module.exports={analyzeCandles,definitions};
