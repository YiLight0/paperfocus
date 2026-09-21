const $ = id => document.getElementById(id);
let doc, configured = false, scores = {}, sortMode = 'document', relevanceThreshold = 50, selected, running = false, controller, generation = 0, activeQuestion = '', history = [], shown = 60, questionStartedAt = 0, questionJevMs = 0;
let maxPdfBytes=200*1024*1024;
let zoom=100, columns=1;
function error(message='') { $('error').textContent=message; $('error').hidden=!message; }
async function api(path, body, signal) {
  const response = await fetch(path, {method:'POST',headers:{'Content-Type':body instanceof File?'application/pdf':'application/json'},body:body instanceof File?body:JSON.stringify(body),signal});
  const result=await response.json(); if(!response.ok) throw new Error(result.error || '请求失败'); return result;
}
function connection() { $('connection').textContent=configured?'已配置':'未配置'; $('connection').classList.toggle('ready',configured); }
function applyView() {
  $('pages').style.setProperty('--zoom-width',`${zoom}%`);
  $('pages').style.setProperty('--page-max',`${850*zoom/100}px`);
  $('pages').style.setProperty('--columns',columns);
  $('zoomValue').textContent=`${zoom}%`;
  $('zoomOut').disabled=zoom<=50;$('zoomIn').disabled=zoom>=200;
}
function updateAskButton() { const b=$('askButton');b.disabled=!doc;b.textContent=running?'':'↑';b.classList.toggle('is-paused',running);b.setAttribute('aria-label',running?'暂停分析':'定位原文');b.title=running?'暂停分析':'定位原文 · Enter'; }
function stop() { generation++; controller?.abort(); running=false;updateAskButton(); }
function busy(value) { running=value;updateAskButton(); }
async function upload(file) {
  if(!file) return; stop(); const token=generation; error();
  if(!/\.pdf$/i.test(file.name) && file.type!=='application/pdf')return error('请选择 PDF 文件。');
  if(file.size>maxPdfBytes) return error(`文件超过当前 ${Math.round(maxPdfBytes/1024/1024)} MB 上限，可在 .env 中调整 MAX_PDF_MB 后重启。`);
  $('readerStatus').textContent='正在本机解析 PDF…'; $('timing').textContent=''; $('askButton').disabled=true;
  try {
    const result=await api('/api/upload',file);
    if(token!==generation) return;
    doc=result; scores={}; history=[]; selected=null; activeQuestion='';
    $('history').hidden=true; $('progressArea').hidden=true; $('welcome').hidden=true; $('pages').replaceChildren();
    $('docName').textContent=file.name; $('pageCount').textContent=`${doc.pages.length} 页`;
    for(const page of doc.pages) {
      const node=document.createElement('div'); node.className='pdf-page'; node.id=`page-${page.number}`; node.style.aspectRatio=`${page.width}/${page.height}`;
      const img=document.createElement('img'); img.src=`/api/page/${doc.id}/${page.number}`; img.alt=`论文第 ${page.number} 页`; img.loading='lazy'; img.width=page.width; img.height=page.height;
      const overlay=document.createElement('div'); overlay.className='overlay';
      const tag=document.createElement('span'); tag.className='page-label'; tag.textContent=page.number;
      node.append(img,overlay,tag); $('pages').append(node);
    }
    $('readerScroll').scrollTop=0; $('readerStatus').textContent=`${doc.pages.length} 页 · ${doc.sentences.length} 句`;
    render();
  } catch(e) { error(e.message); $('readerStatus').textContent='上传未完成'; }
  finally { if(token===generation) $('askButton').disabled=!doc; $('fileInput').value=''; }
}
function entries() {
  if(!doc)return [];
  return [...doc.sentences,...doc.paragraphs,...(doc.figures||[]).map(f=>({...f,id:f.captionId,rects:f.rects,kind:'figure'}))];
}
const scoreOf=item=>item.score??scores[item.id]??0;
const asksForFigure=()=>/(?:figure|fig\.?|chart|plot|diagram|image|illustration|图|图表|示意图|曲线|可视化)/i.test(activeQuestion);
const priorityScoreOf=item=>scoreOf(item)+(item.kind==='figure'?(asksForFigure()?.65:.2):0);
const boundsOf=item=>item.rects.reduce((b,r)=>[Math.min(b[0],r[0]),Math.min(b[1],r[1]),Math.max(b[2],r[0]+r[2]),Math.max(b[3],r[1]+r[3])],[1,1,0,0]);
function mergeNearbyEvidence(items) {
  const ordered=[...items].sort((a,b)=>a.page-b.page||boundsOf(a)[1]-boundsOf(b)[1]||boundsOf(a)[0]-boundsOf(b)[0]),groups=[];
  for(const item of ordered) {
    const ib=boundsOf(item),last=groups.at(-1),lb=last?.bounds;
    const overlap=last&&Math.max(0,Math.min(lb[2],ib[2])-Math.max(lb[0],ib[0]))/Math.max(.001,Math.min(lb[2]-lb[0],ib[2]-ib[0]));
    const sameParagraph=last&&item.paragraphId&&last.paragraphIds.has(item.paragraphId);
    const mixesFigure=last&&((last.kind==='figure')!==(item.kind==='figure'));
    const nearby=last&&!mixesFigure&&last.page===item.page&&(sameParagraph||ib[1]-lb[3]<=.025&&ib[1]-lb[3]>=-.08&&overlap>=.25);
    if(nearby) {
      last.members.push(item);last.paragraphIds.add(item.paragraphId);last.score=Math.max(last.score,scoreOf(item));last.kind=last.kind==='figure'||item.kind==='figure'?'figure':'group';
      last.rects.push(...item.rects);last.bounds=[Math.min(lb[0],ib[0]),Math.min(lb[1],ib[1]),Math.max(lb[2],ib[2]),Math.max(lb[3],ib[3])];
    } else groups.push({page:item.page,members:[item],paragraphIds:new Set(item.paragraphId?[item.paragraphId]:[]),score:scoreOf(item),kind:item.kind,bounds:ib,rects:[...item.rects]});
  }
  return groups.map((g,index)=>({...g,id:`e${index}`,text:[...new Set(g.members.map(m=>m.text))].join(' '),rects:g.rects.filter((r,i,a)=>a.findIndex(x=>x.every((v,j)=>Math.abs(v-r[j])<.0001))===i)}));
}
function evidenceEntries() {
  if(!doc)return [];
  const maxParagraphs=24,maxEvidence=64;
  const figures=(doc.figures||[]).map(f=>({...f,id:f.captionId,paragraphId:f.captionId,rects:f.rects,kind:'figure'}));
  const units=[...doc.sentences,...figures], byParagraph=new Map();
  for(const unit of units) if(Number.isFinite(scores[unit.id])) {
    const list=byParagraph.get(unit.paragraphId)||[];list.push(unit);byParagraph.set(unit.paragraphId,list);
  }
  const paragraphs=doc.paragraphs.map(p=>({
    paragraph:p,
    units:(byParagraph.get(p.id)||[]).sort((a,b)=>priorityScoreOf(b)-priorityScoreOf(a)||a.page-b.page||a.rects[0][1]-b.rects[0][1])
  })).filter(x=>x.units.length||Number.isFinite(scores[x.paragraph.id]))
    .sort((a,b)=>(b.units[0]?priorityScoreOf(b.units[0]):scoreOf(b.paragraph))-(a.units[0]?priorityScoreOf(a.units[0]):scoreOf(a.paragraph))||scoreOf(b.paragraph)-scoreOf(a.paragraph)||a.paragraph.page-b.paragraph.page)
    .slice(0,maxParagraphs);
  const chosen=[];
  for(const {paragraph,units:matches} of paragraphs) {
    if(matches.length) chosen.push(...matches.slice(0,4));
    else chosen.push({...paragraph,kind:'paragraph'});
    if(chosen.length>=maxEvidence)break;
  }
  const merged=mergeNearbyEvidence(chosen.slice(0,maxEvidence));
  const ranked=[...merged].sort((a,b)=>priorityScoreOf(b)-priorityScoreOf(a)||a.page-b.page||a.bounds[1]-b.bounds[1]);
  const highest=priorityScoreOf(ranked[0]||{}),lowest=priorityScoreOf(ranked.at(-1)||{}),count=ranked.length;
  const rankById=new Map(ranked.map((item,index)=>[item.id,index]));
  return merged.map(item=>{
    const rank=rankById.get(item.id)||0;
    const rankBase=count<=1?1:(count-1-rank)/(count-1);
    const rankPart=100*Math.pow(rankBase,4.2);
    const gapPart=highest===lowest?rankPart:100*(priorityScoreOf(item)-lowest)/(highest-lowest);
    return {...item,salience:Math.round(rankPart*.9+gapPart*.1)};
  }).filter(item=>item.salience>=relevanceThreshold);
}
function box(overlay,r,className,title,click) {
  const b=document.createElement(click?'button':'div');b.className=className;
  Object.assign(b.style,{left:`${r[0]*100}%`,top:`${r[1]*100}%`,width:`${r[2]*100}%`,height:`${r[3]*100}%`});
  b.title=title;if(click){b.setAttribute('aria-label',title);b.onclick=click;}overlay.append(b);
}
function render() {
  const matched=evidenceEntries();
  $('matchCount').textContent=doc?`${matched.length} 处`:'—'; $('exportButton').disabled=!Object.keys(scores).length;
  document.querySelectorAll('.overlay').forEach(o=>o.replaceChildren());
  const visible=matched;
  for(const s of visible) for(const r of s.rects) {
    const b=document.createElement('button'); b.className=`mark ${s.kind==='figure'?'figure-frame ':''}${selected===s.id?' focused':''}`;
    Object.assign(b.style,{left:`${r[0]*100}%`,top:`${r[1]*100}%`,width:`${r[2]*100}%`,height:`${r[3]*100}%`});
    b.style.setProperty('--mark-opacity',(.12+.58*s.salience/100).toFixed(3));
    b.title=`${s.kind==='figure'?'根据图注关联 · ':''}本次分析相对显著度 ${s.salience}% · ${s.text}`; b.setAttribute('aria-label',b.title); b.onclick=()=>focusEvidence(s.id);
    $(`page-${s.page}`).querySelector('.overlay').append(b);
  }
  $('results').replaceChildren();
  if(!visible.length) {
    const p=document.createElement('p'); p.className='empty-results'; p.textContent=!doc?'上传 PDF 后提问。':!Object.keys(scores).length?'提问后，在这里定位相关原文。':running?'正在继续寻找相关句子…':'没有达到当前显著度阈值的内容。'; $('results').append(p); return;
  }
  const ordered=[...visible].sort(sortMode==='document'?(a,b)=>a.page-b.page||a.bounds[1]-b.bounds[1]||a.bounds[0]-b.bounds[0]:(a,b)=>b.salience-a.salience||a.page-b.page||a.bounds[1]-b.bounds[1]);
  for(const s of ordered.slice(0,shown)) {
    const b=document.createElement('button'); b.className=`result-item${selected===s.id?' selected':''}`; b.dataset.id=s.id;
    const meta=document.createElement('span'); meta.className='result-meta';
    const l=document.createElement('span'); l.className='level'; l.textContent=`${s.kind==='figure'?'图 · ':''}相对显著度 ${s.salience}%`;
    const p=document.createElement('span'); p.textContent=`第 ${s.page} 页`; meta.append(l,p);
    const excerpt=document.createElement('span'); excerpt.className='result-text'; excerpt.textContent=s.text;
    b.append(meta,excerpt); b.onclick=()=>focusEvidence(s.id); $('results').append(b);
  }
}
function focusEvidence(id) {
  const s=evidenceEntries().find(s=>s.id===id);if(!s)return;selected=id; render(); const page=$(`page-${s.page}`), scroll=$('readerScroll');
  const top=page.getBoundingClientRect().top-scroll.getBoundingClientRect().top+scroll.scrollTop+s.bounds[1]*page.clientHeight-scroll.clientHeight*.35;
  scroll.scrollTo({top,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  $('readerStatus').textContent=`第 ${s.page} 页 · 相对显著度 ${s.salience}%`;
}
function focusBestMatch() {
  const best=[...evidenceEntries()].sort((a,b)=>b.salience-a.salience||a.page-b.page)[0];
  if(best) focusEvidence(best.id);
}
function renderHistory() {
  $('history').hidden=!history.length; $('historyItems').replaceChildren();
  for(const item of history) { const ms=item.jevElapsedMs??item.elapsedMs;const b=document.createElement('button'); b.textContent=`${item.question} · Jev ${(ms/1000).toFixed(2)} 秒`;b.onclick=()=>{stop();activeQuestion=item.question;$('question').value=item.question;scores={...item.scores};$('timing').textContent=`Jev 处理 ${(ms/1000).toFixed(2)} 秒`;$('readerStatus').textContent='已恢复';$('progressArea').hidden=true;render();};$('historyItems').append(b); }
}
async function ask(event) {
  event?.preventDefault(); if(running||!doc) return; error();
  const question=$('question').value.trim(); if(!question) return error('先写下你想在论文里找的问题。');
  if(!configured) { $('settings').hidden=false;$('apiKey').focus();return error('请先配置 TypeSafe API key，才会进行真实评分。'); }
  activeQuestion=question; $('question').value=''; scores={};selected=null;shown=60; render(); busy(true);controller=new AbortController(); const token=++generation,started=performance.now();questionStartedAt=started;questionJevMs=0;let done=0,planned=0;
  $('timing').textContent='Jev 处理中…';
  $('progressArea').hidden=false;$('progress').max=1;$('progress').value=0;$('progressCount').textContent='0 / 1';$('progressText').textContent='正在筛选相关段落';
  try {
    const runBatches=async (batches,label)=>{
      let next=0,completed=0;const workerCount=Math.min(4,batches.length),workerTimes=Array(workerCount).fill(0),stageBase=questionJevMs;planned=batches.length;done=0;$('progress').max=Math.max(1,planned);$('progress').value=0;$('progressCount').textContent=`0 / ${planned}`;$('progressText').textContent=`${label} · ${planned} 批并行`;
      const worker=async workerIndex=>{while(true){const index=next++;if(index>=batches.length)return;const result=await api('/api/score',{docId:doc.id,question,ids:batches[index]},controller.signal);if(token!==generation)return;workerTimes[workerIndex]+=Number(result.elapsedMs)||0;questionJevMs=Math.max(questionJevMs,stageBase+workerTimes[workerIndex]);Object.assign(scores,result.scores);completed++;done=completed;$('progress').value=completed;$('progressCount').textContent=`${completed} / ${planned}`;$('readerStatus').textContent=`${label} ${completed} / ${planned} 批`;render();}};
      await Promise.all(Array.from({length:workerCount},(_,i)=>worker(i)));
    };
    const paragraphPlan=await api('/api/plan',{docId:doc.id,question,mode:'paragraphs'},controller.signal);if(token!==generation)return;
    await runBatches(paragraphPlan.batches,'筛选段落');if(token!==generation)return;
    const figureCaptions=new Set((doc.figures||[]).map(f=>f.captionId));
    const paragraphPriority=p=>scores[p.id]+(figureCaptions.has(p.id)?(asksForFigure()?.65:.2):0);
    const paragraphIds=doc.paragraphs.filter(p=>Number.isFinite(scores[p.id])&&scores[p.id]>0).sort((a,b)=>paragraphPriority(b)-paragraphPriority(a)||a.page-b.page).slice(0,24).map(p=>p.id);
    if(paragraphIds.length){
      const sentencePlan=await api('/api/plan',{docId:doc.id,question,mode:'sentences',paragraphIds},controller.signal);if(token!==generation)return;
      await runBatches(sentencePlan.batches,'定位证据');if(token!==generation)return;
    }
    const jevElapsedMs=questionJevMs;
    $('progressText').textContent='全文评分完成';$('readerStatus').textContent='分析完成';$('timing').textContent=`Jev 处理 ${(jevElapsedMs/1000).toFixed(2)} 秒`;
    history=[{question,scores:{...scores},jevElapsedMs},...history].slice(0,5);renderHistory();focusBestMatch();
  } catch(e) { if(token!==generation)return; error(e.message);$('progressText').textContent='分析中断，可重新提问';$('readerStatus').textContent=`仅完成 ${done} / ${planned} 批 · 保留已返回结果`;$('timing').textContent=`Jev 处理 ${(questionJevMs/1000).toFixed(2)} 秒（中断）`; }
  finally {if(token===generation){questionStartedAt=0;busy(false);}}
}
$('fileInput').onchange=e=>upload(e.target.files[0]);
// Handle file drops across the whole page, including the PDF and sidebar.
let dragDepth=0;
const hasFiles=e=>Array.from(e.dataTransfer?.types||[]).includes('Files');
window.addEventListener('dragenter',e=>{if(!hasFiles(e))return;e.preventDefault();dragDepth++;document.body.classList.add('file-drag');});
window.addEventListener('dragover',e=>{if(!hasFiles(e))return;e.preventDefault();e.dataTransfer.dropEffect='copy';});
window.addEventListener('dragleave',e=>{if(!hasFiles(e))return;dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)document.body.classList.remove('file-drag');});
window.addEventListener('drop',e=>{
  e.preventDefault();dragDepth=0;document.body.classList.remove('file-drag');
  const files=Array.from(e.dataTransfer?.files||[]);
  if(!files.length)for(const item of e.dataTransfer?.items||[]){if(item.kind==='file'){const f=item.getAsFile();if(f)files.push(f);}}
  const pdf=files.find(f=>/\.pdf$/i.test(f.name)||f.type==='application/pdf');
  if(pdf)upload(pdf);else error(files.length?'请拖入 PDF 文件。':'浏览器未收到文件，请点击“打开论文”选择。');
});
window.addEventListener('blur',()=>{dragDepth=0;document.body.classList.remove('file-drag');});
function pauseAnalysis(){stop();questionStartedAt=0;$('progressText').textContent='已暂停 · 保留已完成部分';$('readerStatus').textContent='已暂停后续批次；已发出的服务端请求可能仍会计费';$('timing').textContent=`Jev 处理 ${(questionJevMs/1000).toFixed(2)} 秒（已暂停）`;}
$('questionForm').onsubmit=e=>running?(e.preventDefault(),pauseAnalysis()):ask(e);$('question').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();running?pauseAnalysis():ask();}};
$('settingsButton').onclick=()=>{$('settings').hidden=!$('settings').hidden;};
$('keyForm').onsubmit=async e=>{e.preventDefault();error();try{await api('/api/key',{key:$('apiKey').value});configured=true;connection();$('apiKey').value='';$('settings').hidden=true;}catch(e){error(e.message);}};
document.querySelectorAll('[data-question]').forEach(b=>b.onclick=()=>{$('question').value=b.dataset.question;$('question').focus();});
$('resultSort').onchange=e=>{sortMode=e.target.value;render();};
$('relevanceThreshold').oninput=e=>{relevanceThreshold=Number(e.target.value);$('thresholdValue').textContent=`${relevanceThreshold}%`;selected=null;render();};
$('highlightToggle').onclick=()=>{const off=$('pages').classList.toggle('highlights-off');$('highlightToggle').textContent=`高亮 ${off?'关':'开'}`;$('highlightToggle').setAttribute('aria-pressed',!off);};
$('zoomOut').onclick=()=>{zoom=Math.max(50,zoom-10);applyView();};
$('zoomIn').onclick=()=>{zoom=Math.min(200,zoom+10);applyView();};
$('columnCount').onchange=e=>{columns=Number(e.target.value);applyView();};
$('panelToggle').onclick=()=>{const off=document.querySelector('main').classList.toggle('panel-closed');$('panelToggle').setAttribute('aria-expanded',!off);};
$('exportButton').title='导出本次问题与逐句评分（JSON）';
$('exportButton').onclick=()=>{const blob=new Blob([JSON.stringify({question:activeQuestion,model:'jev-latest',complete:[...doc.sentences,...doc.paragraphs].every(s=>scores[s.id]!==undefined),paragraphs:doc.paragraphs.map(p=>({...p,score:scores[p.id]})),figures:doc.figures.map(f=>({...f,score:scores[f.captionId],basis:'caption'})),sentences:doc.sentences.filter(s=>scores[s.id]!==undefined).map(s=>({id:s.id,page:s.page,text:s.text,score:scores[s.id]}))},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='paperfocus-results.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
async function refreshStatus() {
  try {const r=await fetch('/api/status');if(!r.ok)throw new Error();const state=await r.json();configured=state.configured;maxPdfBytes=state.maxPdfBytes||maxPdfBytes;connection();}
  catch { $('connection').textContent='服务未启动'; }
}
refreshStatus();
applyView();
window.addEventListener('focus',refreshStatus);
setInterval(()=>{if(!document.hidden)refreshStatus();},5000);


$('dropZone').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('fileInput').click();}};
