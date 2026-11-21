/* IRA QUIZ V5 — synchronized TV, player and host interfaces. */
'use strict';
const legacyAppHandle = window.handle;
const GUEST_TOKEN_KEY='ira_guest_token';
const IS_TV=new URLSearchParams(location.search).get('screen')==='1';
const IS_HOST_REMOTE=new URLSearchParams(location.search).get('admin')==='1';
let gameSnapshot=null,gameDraft=null,gameDraftKey='',gameChannel=null,tvAudioChannel=null,presentationChannel=null,timerChannel=null;
let presentationState={stage:'idle',clip_index:0,round_no:-1,question_no:-1};
// Preload current question images so each TV slide is instant after synchronization.
const iraSlideImageCache=new Map();
function preloadQuestionImages(){
 const q=currentQuestionRemote();
 if(!IS_TV||!q)return;
 const files=[...(Array.isArray(q.images)?q.images:[]),q.image,q.revealImage].filter(Boolean);
 for(const file of files){
  if(iraSlideImageCache.has(file))continue;
  const img=new Image();img.decoding='async';img.src='assets/'+file;iraSlideImageCache.set(file,img);
 }
}

let timerState={status:'idle',duration_seconds:30,remaining_seconds:30,deadline_at:null};
// Server clock is authoritative. Each device calibrates its own clock skew.
let quizServerClockOffsetMs=0, quizServerClockReady=false;
let tvAudioUnlocked=false,lastTvClip='',timerExpiryRequested=false,timerInterval=null,answerSending=false,hostActionRunning=false;
const ROUND_TITLES=ROUNDS.map(r=>r.title),ROUND_COUNTS=ROUNDS.map(r=>r.questions.length);
const COUNTRY_FLAGS={'Исландия':'🇮🇸','Италия':'🇮🇹','Япония':'🇯🇵','Австралия':'🇦🇺','Аргентина':'🇦🇷'};
function gameControl(){return gameSnapshot?.control||{phase:'lobby',round_no:0,question_no:0,actual_count:null}}
function currentQuestionRemote(){const raw=gameSnapshot?.question;if(!raw)return null;return {...raw.public_payload,title:raw.title,prompt:raw.prompt,type:raw.kind,max_points:raw.max_points,strict:raw.strict_order,round_no:raw.round_no,question_no:raw.question_no}}
function isTeamQuestion(c=gameControl()){return (c.round_no>=0&&c.round_no<=3)||(c.round_no===5&&c.question_no<2)}
function currentRoundName(){const c=gameControl();if(c.round_no===5)return c.question_no<2?'Командный тай-брейк':'Индивидуальный тай-брейк';return ROUND_TITLES[c.round_no]||'Квиз'}
function displayOrderLabel(value){return String(value??'').replace(/^(?:IS|IT|JP|AU|AR)\s+/i,'').trim()}
function isAnswerSubmitted(){return gameSnapshot?.my_answer!==null&&gameSnapshot?.my_answer!==undefined}
function remoteCanAnswer(){const p=gameSnapshot?.participant,c=gameControl();if(!p||c.phase!=='question'||presentationState.stage!=='answers')return false;if(timerState.status==='running'&&timerRemaining()<=0)return false;if(timerState.status==='stopped'&&Number(timerState.remaining_seconds)===0)return false;if(c.round_no===5&&c.question_no===2){const rows=gameSnapshot?.leaderboard?.individual||[];if(!rows.length)return false;const highest=Math.max(...rows.map(r=>Number(r.points)||0));return rows.some(r=>r.participant_id===p.id&&Number(r.points)===highest)}if(isTeamQuestion(c))return !!p.team_id&&!!p.is_captain;return true}
function ensureGameDraft(q){const c=gameControl(),sequence=c.round_no===2||(c.round_no===0&&c.question_no===0),key=`${c.round_no}_${c.question_no}_${sequence?presentationState.stage:'main'}`;if(gameDraftKey!==key){gameDraftKey=key;gameDraft=q.type==='order'?(q.labels||[]).map((_,i)=>i):q.type==='multi'?[]:q.type==='number'?'':-1}}
function currentReviewRaw(){const c=gameControl();return (gameSnapshot?.review_questions||[]).find(x=>Number(x.round_no)===Number(c.round_no)&&Number(x.question_no)===Number(c.question_no))||null}
function publicQuestion(raw){if(!raw)return null;return {...raw.public_payload,title:raw.title,prompt:raw.prompt,type:raw.kind,max_points:raw.max_points,strict:raw.strict_order,round_no:raw.round_no,question_no:raw.question_no}}
async function refreshGameSnapshot(shouldRender=true){
 if(!supabaseClient)return;
 const pid=localStorage.getItem('ira_self')||null,token=localStorage.getItem(GUEST_TOKEN_KEY)||null;
 // Capture the server timestamp with a per-request round-trip midpoint.
 // This eliminates the difference between the TV's and phone's local clocks.
 const serverClockPromise=(async()=>{
  const sentAt=Date.now();
  const result=await supabaseClient.rpc('quiz_server_now');
  return {...result,sentAt,receivedAt:Date.now()};
 })();
 const [snap,pres,timer,serverClock]=await Promise.all([
  supabaseClient.rpc('get_quiz_snapshot_v5',{p_participant_id:pid,p_token:token}),
  supabaseClient.from('quiz_presentation_state').select('*').eq('id',1).maybeSingle(),
  supabaseClient.from('quiz_timer_state').select('*').eq('id',1).maybeSingle(),
  serverClockPromise
 ]);
 if(snap.error){console.error('get_quiz_snapshot_v5',snap.error);if(shouldRender)notify('Не удалось обновить состояние игры');return}
 if(!serverClock.error&&serverClock.data){
  const timestamp=Date.parse(serverClock.data);
  if(Number.isFinite(timestamp)){
   quizServerClockOffsetMs=timestamp-(serverClock.sentAt+serverClock.receivedAt)/2;
   quizServerClockReady=true;
  }
 }else if(serverClock.error){console.warn('Server clock synchronization unavailable:',serverClock.error.message)}
 gameSnapshot=snap.data;
 if(pres.data)presentationState=pres.data;
 if(timer.data)timerState=timer.data;
 preloadQuestionImages();
 if(shouldRender)render();
}
async function joinRemote(){const name=document.getElementById('personname')?.value.trim();if(!name){notify('Введи имя');return}const {data,error}=await supabaseClient.rpc('register_guest_secure',{p_display_name:name});if(error){notify(error.message.includes('уже зарегистрирован')?'Это имя уже зарегистрировано':error.message.includes('заняты')?'Все 11 мест уже заняты':'Не удалось зарегистрироваться: '+error.message);return}userId=data.participant_id;localStorage.setItem('ira_self',userId);localStorage.setItem(GUEST_TOKEN_KEY,data.token);await loadRemoteRoster();await refreshGameSnapshot(false);setPage('game');notify('Ты зарегистрирована! Команду назначит организатор.')}
async function submitRemoteAnswer(){
 if(answerSending||!remoteCanAnswer()||isAnswerSubmitted())return;
 const q=currentQuestionRemote(),p=gameSnapshot.participant;let answer=gameDraft;
 if(q.type==='number'){const v=document.getElementById('remote-number')?.value;if(v===''||!Number.isSafeInteger(Number(v))||Number(v)<0){notify('Введи целое неотрицательное число');return}answer=Number(v)}
 if(q.type==='multi'&&(!Array.isArray(answer)||answer.length!==5)){notify('Выбери ровно пять вариантов');return}
 if(q.type==='order'&&(!Array.isArray(answer)||answer.length!==(q.labels||[]).length)){notify('Распредели все варианты');return}
 if(q.type!=='multi'&&q.type!=='order'&&q.type!=='number'&&(!Number.isInteger(answer)||answer<0)){notify('Выбери ответ');return}
 answerSending=true;
 try{
  const {error}=await supabaseClient.rpc('submit_quiz_answer_v5',{p_participant_id:p.id,p_token:localStorage.getItem(GUEST_TOKEN_KEY),p_answer:answer});
  if(error){notify(error.message);return}
  await refreshGameSnapshot(false);render();notify('Ответ принят. Изменить его нельзя.');
 }catch(err){console.error('submit quiz answer',err);notify('Ошибка соединения. Проверь интернет и попробуй ещё раз.')}
 finally{answerSending=false}
}
async function adminGameAction(action){
 if(!admin||hostActionRunning)return;
 hostActionRunning=true;
 document.querySelectorAll('[data-gq-action]').forEach(b=>{if(b.closest('.remote-shell'))b.disabled=true});
 try{
 if(action==='presentation-next'){
  const {data,error}=await supabaseClient.rpc('quiz_presentation_next');
  if(error){notify(error.message);return}
  // The server returns the authoritative new slide; do not wait for three reads.
  if(data&&typeof data.stage==='string')presentationState=data;
  // Start each music clip only after the host advances the synchronized
  // presentation. The TV receives the event through quiz_audio_events.
  const control=gameControl();
  const q=currentQuestionRemote()||publicQuestion(currentReviewRaw());
  let clipToPlay=null;
  if(control.phase==='question'&&control.round_no===2&&presentationState.stage==='audio'){
   clipToPlay=currentAudioClip(q);
  }else if(control.phase==='review'&&presentationState.stage==='review_explanation'&&q?.audio_reveal){
   clipToPlay=q.audio_reveal;
  }
  if(clipToPlay?.file){
   const audioResult=await supabaseClient.rpc('broadcast_quiz_audio',{p_clip:clipToPlay.file,p_action:'play'});
   if(audioResult.error)console.error('Не удалось запустить аудио квиза',audioResult.error);
  }
  render();return;
 }
 if(action.startsWith('timer-')){
  const map={'timer-pause':'pause','timer-resume':'resume','timer-reset':'reset','timer-add':'add','timer-set':'set'};
  const seconds=action==='timer-set'?Number(document.getElementById('timer-set-seconds')?.value):action==='timer-add'?15:null;
  if(action==='timer-set'&&(!Number.isInteger(seconds)||seconds<10||seconds>600)){notify('Укажи время от 10 до 600 секунд');return}
  const {error}=await supabaseClient.rpc('quiz_timer_action',{p_action:map[action],p_seconds:seconds});if(error){notify(error.message);return}await refreshGameSnapshot(false);render();return;
 }
 if(action==='repeat-audio'){
  const q=currentQuestionRemote()||publicQuestion(currentReviewRaw()),clip=(gameControl().phase==='review'&&presentationState.stage==='review_explanation'&&q?.audio_reveal)?q.audio_reveal:currentAudioClip(q);if(!clip?.file){notify('Сейчас нет аудиофрагмента для повтора');return}
  const {error}=await supabaseClient.rpc('broadcast_quiz_audio',{p_clip:clip.file,p_action:'play'});if(error)notify(error.message);else notify('Повторяю фрагмент на телевизоре');return;
 }
 if(action==='stop-audio'){const {error}=await supabaseClient.rpc('broadcast_quiz_audio',{p_clip:null,p_action:'stop'});if(error)notify(error.message);return}
 if((action==='next_question'||action==='close_question')&&gameControl().round_no===5&&gameControl().question_no===0){if(action==='close_question'&&!confirm('Закрыть приём ответов сейчас? Команда без ответа пропустит этот вопрос.'))return;const {error}=await supabaseClient.rpc('close_team_tiebreak_question');if(error){notify(error.message);return}await refreshGameSnapshot(false);render();return}
 if(action==='close_question'&&!confirm('Закрыть приём ответов сейчас? Те, кто ещё не ответил, пропустят этот вопрос.'))return;
 let actual=null;if(action==='set_actual'){const v=document.getElementById('remote-actual')?.value;if(v===''||!Number.isSafeInteger(Number(v))||Number(v)<0){notify('Введи целое неотрицательное число');return}actual=Number(v)}
 if(action==='reset'&&!confirm('Сбросить игру и удалить все отправленные ответы? Участники, команды и капитаны сохранятся.'))return;
 const {error}=await supabaseClient.rpc('admin_advance_game',{p_action:action,p_actual_count:actual});if(error){notify(error.message);return}gameDraft=null;await refreshGameSnapshot(false);render();notify('Состояние игры обновлено');
 }catch(err){console.error('admin game action',err);notify('Не удалось переключить этап. Проверь подключение и повтори действие.')}
 finally{hostActionRunning=false;document.querySelectorAll('.remote-shell [data-gq-action]').forEach(b=>b.disabled=false)}
}
function remoteImage(file,cls='tv-media',zoom=!IS_TV){if(!file)return '';return `<img class="${cls}" src="assets/${h(file)}" alt="" loading="eager" ${zoom?'data-quiz-zoom="1"':''}>`}
function audioList(q){return Array.isArray(q?.audio_clips)?q.audio_clips:[]}
function currentAudioClip(q=currentQuestionRemote()){return audioList(q)[Number(presentationState.clip_index)||0]||null}
function musicRules(q){if(q.question_no===0)return 'Прослушайте четыре фрагмента. После этого выберите песню, которую Ира действительно слушает до сих пор.';if(q.question_no===1)return 'Прослушайте четыре фрагмента и расставьте песни в порядке личного рейтинга Иры.';if(q.question_no===2)return 'Прослушайте фрагмент до конца и выберите продолжение строки. Правильное продолжение прозвучит при разборе.';return 'Прослушайте фрагмент и выберите, с кем у Иры связана эта песня.'}
function audioWave(){return `<div class="audio-wave" aria-hidden="true">${Array.from({length:32},(_,i)=>`<i style="--bar:${18+((i*17)%67)}%"></i>`).join('')}</div>`}
function questionMedia(q,screen=false){if(!q?.image)return '';const cls=screen?'tv-media':'q-media';const file=q.imageMode==='masked'?'quiz_soap_crop.webp':q.image;return `<div class="quiz-image-frame">${remoteImage(file,cls,!screen)}</div>`}
function optionLetter(i){return ['А','Б','В','Г','Д','Е','Ж','З','И'][i]||String(i+1)}
function countryName(label){return String(label||'').replace(/^🇮🇸\s*|^🇮🇹\s*|^🇯🇵\s*|^🇦🇺\s*|^🇦🇷\s*/, '').trim()}
function countryFlag(label){const name=countryName(label);return COUNTRY_FLAGS[name]||'🌍'}
function answerOptionsHtml(q,screen=false,mode='question',correctAnswer=null){
 const options=q.options||[],labels=q.labels||[],images=q.images||[];
 const isCorrect=(i)=>Array.isArray(correctAnswer)?correctAnswer.map(Number).includes(i):Number(correctAnswer)===i;
 if(q.type==='number')return screen?'<div class="tv-number-prompt">ОТВЕТЬТЕ ЧИСЛОМ НА ТЕЛЕФОНЕ</div>':'';
 if(q.type==='order'){
  if(screen){
   const order=mode==='correct'&&Array.isArray(correctAnswer)?correctAnswer.map(Number):labels.map((_,i)=>i);
   const countries=labels.length&&labels.every(x=>Object.keys(COUNTRY_FLAGS).some(country=>String(x).includes(country)));
   return `<div class="tv-order-grid ${countries?'country-ranking':''}">${order.map((idx,pos)=>{const label=labels[idx]??'';const correct=mode==='correct';return `<article class="tv-order-card ${correct?'is-correct':''}"><span class="tv-order-position">${correct?pos+1:'?'}</span>${images[idx]?remoteImage(images[idx],'tv-order-image',false):countries?`<div class="country-flag">${countryFlag(label)}</div>`:''}<div class="tv-order-name">${h(countries?countryName(label):label)}</div></article>`}).join('')}</div>`;
  }
  const order=isAnswerSubmitted()&&Array.isArray(gameSnapshot.my_answer)?gameSnapshot.my_answer:(Array.isArray(gameDraft)?gameDraft:labels.map((_,i)=>i));
  return `<div class="phone-order-list" data-order-list><p class="phone-order-instructions">Меняй порядок стрелками или перетаскивай за значок ☰</p>${order.map((idx,pos)=>`<div class="phone-order-item" draggable="${remoteCanAnswer()&&!isAnswerSubmitted()}" data-order-index="${pos}"><span class="phone-order-handle" aria-label="Перетащить вариант" title="Перетащить">☰</span><span class="phone-order-rank">${pos+1}</span>${images[idx]?remoteImage(images[idx],'phone-order-image',true):Object.keys(COUNTRY_FLAGS).some(country=>String(labels[idx]||'').includes(country))?`<span class="phone-order-flag">${countryFlag(labels[idx])}</span>`:''}<b>${h(countryName(labels[idx]||''))}</b><span class="phone-order-actions"><button type="button" data-gq-move="${pos}" data-dir="up" ${pos===0||!remoteCanAnswer()||isAnswerSubmitted()?'disabled':''}>↑</button><button type="button" data-gq-move="${pos}" data-dir="down" ${pos===order.length-1||!remoteCanAnswer()||isAnswerSubmitted()?'disabled':''}>↓</button></span></div>`).join('')}</div>`;
 }
 if(q.type==='multi'){
  return `<div class="${screen?'tv-options tv-bingo-grid':'phone-bingo-grid'}">${options.map((o,i)=>{const cls=mode==='correct'?(isCorrect(i)?'is-correct':'is-dimmed'):'';return screen?`<div class="tv-option bingo-option ${cls}"><span class="tv-letter">${optionLetter(i)}</span><span class="bingo-option-text">${h(o)}</span></div>`:`<button class="answer bingo-answer ${Array.isArray(gameDraft)&&gameDraft.includes(i)?'active':''}" data-gq-multi="${i}" ${!remoteCanAnswer()||isAnswerSubmitted()?'disabled':''}><span class="letter">${optionLetter(i)}</span><span>${h(o)}</span></button>`}).join('')}</div>`;
 }
 if(q.type==='media-select'){
  if(screen&&mode==='question'&&q.round_no===0&&q.question_no===0&&presentationState.stage==='answers')return `<div class="tv-options tv-choice-grid">${options.map((o,i)=>`<div class="tv-option"><span class="tv-letter">${optionLetter(i)}</span><span>${h(o)}</span></div>`).join('')}</div>`;
  return `<div class="${screen?'tv-options tv-meme-grid':'phone-meme-grid'}">${options.map((o,i)=>{const cls=mode==='correct'?(isCorrect(i)?'is-correct':'is-dimmed'):'';return screen?`<article class="tv-meme-card ${cls}">${images[i]?remoteImage(images[i],'tv-meme-image',false):''}<div><b>${optionLetter(i)}</b> ${h(o)}</div></article>`:`<button class="answer meme-answer ${gameDraft===i?'active':''}" data-gq-single="${i}" ${!remoteCanAnswer()||isAnswerSubmitted()?'disabled':''}>${images[i]?remoteImage(images[i],'phone-meme-image',true):''}<span><b>${optionLetter(i)}</b> ${h(o)}</span></button>`}).join('')}</div>`;
 }
 return `<div class="${screen?'tv-options tv-choice-grid':'answers'}">${options.map((o,i)=>{const cls=mode==='correct'?(isCorrect(i)?'is-correct':'is-dimmed'):'';return screen?`<div class="tv-option ${cls}"><span class="tv-letter">${optionLetter(i)}</span><span>${h(o)}</span></div>`:`<button class="answer ${gameDraft===i?'active':''}" data-gq-single="${i}" ${!remoteCanAnswer()||isAnswerSubmitted()?'disabled':''}><span class="letter">${optionLetter(i)}</span><span>${h(o)}</span></button>`}).join('')}</div>`;
}
function playerTimerMarkup(){if(!timerState||['idle','stopped'].includes(timerState.status))return '';const remaining=timerRemaining(),duration=Math.max(1,Number(timerState.duration_seconds)||30),pct=Math.max(0,Math.min(100,remaining/duration*100));return `<div class="player-timer ${remaining<=10?'is-warning':''} ${remaining<=5?'is-critical':''}"><div><span>ОСТАЛОСЬ</span><strong data-timer-value>${formatClock(remaining)}</strong></div><div class="player-timer-track"><span data-timer-progress style="width:${pct}%"></span></div></div>`}
function remoteQuestionCard(){
 const c=gameControl(),q=currentQuestionRemote(),p=gameSnapshot?.participant;if(!q)return panel('<div class="pad">Ожидаем вопрос…</div>');ensureGameDraft(q);
 const submitted=isAnswerSubmitted(),editing=remoteCanAnswer()&&!submitted,teamMode=isTeamQuestion(c);
 const role=teamMode?'командное задание · отвечает капитан':c.round_no===4?'индивидуальный финал':'индивидуальный тай-брейк';
 const waitingSequence=(c.round_no===2||(c.round_no===0&&c.question_no===0))&&presentationState.stage!=='answers';
 let inputs=waitingSequence?`<div class="music-wait-panel">${c.round_no===2?'♫ Слушайте фрагменты на общем экране. Варианты ответа появятся после прослушивания.':'Смотрите мемы на большом экране. Варианты ответа появятся после показа всех четырёх.'}</div>`:q.type==='number'?`<label class="formlabel">Твой ответ — целое число</label><input id="remote-number" class="input" type="number" min="0" step="1" value="${h(submitted?gameSnapshot.my_answer:gameDraft)}" ${!editing?'disabled':''}>`:answerOptionsHtml(q,false);
 let note=!p?'Сначала зарегистрируйся на вписку.':submitted?'Ответ принят. Изменить его нельзя.':waitingSequence?'Сначала посмотри все слайды на общем экране, затем появятся варианты.':!editing?(teamMode?'Ответ за команду может отправить только назначенный капитан.':'Сейчас приём ответов закрыт.'):'Выбери ответ и отправь его. После отправки изменить его нельзя.';
 return `<div class="game-hero"><span class="eyebrow">${c.round_no===5?'Тай-брейк':`Раунд ${c.round_no+1} из 5`} · ${h(role)}</span><h1>${h(currentRoundName())}</h1><p>${c.round_no===5?'Задание':'Вопрос'} ${c.question_no+1} из ${ROUND_COUNTS[c.round_no]||3}</p></div>${panel(`<div class="pad player-question"><h2 class="h1">${h(q.title)}</h2>${questionMedia(q)}${waitingSequence&&c.round_no===0&&Array.isArray(q.images)?`<div class="phone-meme-grid phone-meme-preview">${q.images.map((file,i)=>`<div class="phone-meme-preview-card">${remoteImage(file,'phone-meme-image',true)}<b>${optionLetter(i)}</b></div>`).join('')}</div>`:''}<p class="player-prompt">${h(q.prompt)}</p>${inputs}${q.type==='multi'?`<div class="selection-counter">Выбрано: ${Array.isArray(gameDraft)?gameDraft.length:0} из 5</div>`:''}${!waitingSequence?playerTimerMarkup():''}<div class="player-note ${submitted?'is-submitted':''}">${h(note)}</div>${editing?'<button class="primary wide submit-answer" data-gq-action="submit">Зафиксировать ответ</button>':''}${submitted?'<div class="submitted-stamp">✓ ОТВЕТ ЗАФИКСИРОВАН</div>':''}</div>`)}`;
}
function reviewAnswerText(q,answer){if(q.type==='order')return (answer||[]).map(i=>displayOrderLabel(q.labels?.[Number(i)]??i)).join(' → ');if(q.type==='multi')return (answer||[]).map(i=>q.options?.[Number(i)]??i).join('; ');if(q.type==='number'){const actual=gameControl().actual_count;return actual===null||actual===undefined?'Фактическое число не зафиксировано':`Фактическое число: ${actual}`}return q.options?.[Number(answer)]??String(answer??'')}
function remoteReview(){return `<div class="game-hero"><span class="eyebrow">Раунд ${gameControl().round_no+1} · разбор</span><h1>Разбор на большом экране</h1><p>Следи за раскрытием ответа на телевизоре.</p></div><div class="panel"><div class="pad"><b>Текущий этап:</b> ${h(presentationState.stage||'review_options')}<p class="muted">Ведущая переключает этапы разбора с пульта.</p></div></div>`}
function scoreCards(rows,compact=false){const medals=['👑','🥈','🥉'];const all=rows||[];const top=compact?all:all.slice(0,3);const rest=compact?[]:all.slice(3);return `${all.length?`<div class="score-cards ${compact?'compact':'podium-cards'}">${top.map((r,i)=>`<article class="score-card ${!compact&&i===0?'score-leader':''}"><div class="score-place">${compact?(i+1)+'.':medals[i]||`${i+1} МЕСТО`}</div><div class="score-team-name">${h(r.name)}</div><div class="score-points">${r.points} <small>баллов</small></div></article>`).join('')}</div>${rest.length?`<div class="score-rest">${rest.map((r,i)=>`<div><span>${i+4}. ${h(r.name)}</span><b>${r.points} б.</b></div>`).join('')}</div>`:''}`:'<p class="muted">Пока нет результатов</p>'}`}
function remoteScorePanel(){const lb=gameSnapshot?.leaderboard||{team:[],individual:[],individual_visible:false};let html=`<section class="panel"><div class="panel-head"><b>Командный рейтинг</b></div><div class="pad">${scoreCards(lb.team,true)}</div></section>`;if(lb.individual_visible)html+=`<section class="panel"><div class="panel-head"><b>Индивидуальный рейтинг</b></div><div class="pad">${scoreCards(lb.individual,true)}</div></section>`;return html}
function remoteLobby(){const p=gameSnapshot?.participant;let lines=state.people.map(s=>`<div class="roundline"><div><b class="blue">${h(s.name)}</b><span class="muted tiny"> · ${s.team>=0?h(teamLabel(s.team)):'команда пока не назначена'}</span></div>${s.isCaptain?'<span class="pill">капитан</span>':''}</div>`).join('');let teams=remoteTeams.map((t,i)=>`<div class="roundline"><div><b class="blue">${h(t.name)}</b><div class="muted tiny">${teamsize(i)} участн.</div></div></div>`).join('');return `<section class="panel"><div class="pad"><h2 class="h1">Вписка · Сбор друзей</h2><p class="muted">${state.people.length}/11 участников. Команды сформируем на мероприятии.</p><h3>Команды</h3><div class="roundlist">${teams||'<p class="muted">Команды пока не созданы.</p>'}</div><h3 style="margin-top:16px">Участники</h3><div class="roundlist">${lines||'<p class="muted">Пока никого нет.</p>'}</div>${p?`<p class="stepnote">Ты: ${h(p.display_name)}. ${p.team_id?'Команда назначена.':'Команда будет назначена организатором.'} ${p.is_captain?'Ты капитан — сможешь отправлять ответы команды.':''}</p>`:''}${admin?`<div class="admin-controls"><b>Управление организатора</b>${teamManagement()}<p class="stepnote">Когда все участники распределены и у каждой команды назначен капитан, игру можно запускать с пульта ведущей.</p><a class="outline" href="?admin=1">Открыть пульт ведущей</a></div>`:''}</div></section>`}
function guestRegistration(){const c=gameControl();if(c.phase!=='lobby')return panel('<div class="pad"><h2>Регистрация закрыта</h2><p class="muted">Игра уже началась. Попроси организатора помочь с доступом.</p></div>');return `<section class="panel"><div class="pad"><h2 class="h1">Заявка в друзья</h2><p class="muted">Добавься к Ире, чтобы получить доступ к вписке.</p><label class="formlabel" for="personname">Имя участника</label><input class="input" id="personname" placeholder="Как тебя зовут?" maxlength="40" autocomplete="name"><p class="stepnote">Команду назначит организатор на мероприятии.</p><button class="primary wide" data-gq-action="join" ${state.people.length>=11?'disabled':''}>Отправить заявку</button><p class="muted tiny">${state.people.length}/11 мест занято</p></div></section>`}
function remoteGame(){const c=gameControl(),p=gameSnapshot?.participant;if(c.phase==='lobby'&&!p&&!admin)return guestRegistration()+remoteAdminEntry();let body=`<div class="game-hero"><div class="eyebrow">Ира Перцовская · 2017</div><h1>Кто меня знает, тот знает</h1><p>Четыре командных раунда, затем индивидуальный экзамен на близость.</p></div>`;if(c.phase==='lobby')body+=remoteLobby();else if(c.phase==='question')body+=remoteQuestionCard();else if(c.phase==='review')body+=remoteReview();else body+=`<div class="game-hero"><h1>Вписка окончена 🎉</h1><p>Спасибо за игру!</p></div>${remoteScorePanel()}`;body+=remoteAdminEntry();return body}
function remoteAdminEntry(){return admin?`<div class="panel"><div class="pad"><a href="?admin=1" class="outline">Открыть пульт ведущей</a></div></div>`:`<div class="panel"><div class="pad"><button class="outline" data-gq-action="toggle-login">Я организатор · открыть управление</button>${adminLoginOpen?`<div class="admin-controls"><label class="formlabel" for="admin-email">Электронная почта организатора</label><input class="input" id="admin-email" type="email" autocomplete="username" placeholder="Email"><label class="formlabel" for="admin-password">Пароль</label><input class="input" id="admin-password" type="password" autocomplete="current-password" placeholder="Пароль"><button class="primary wide" data-gq-action="login">Войти в админку</button></div>`:''}</div></div>`}
function timerRemaining(){if(timerState.status==='running'&&timerState.deadline_at){const now=Date.now()+(quizServerClockReady?quizServerClockOffsetMs:0);const remaining=Math.ceil((new Date(timerState.deadline_at).getTime()-now)/1000);return Math.max(0,Math.min(Number(timerState.duration_seconds)||30,remaining));}if(timerState.status==='paused')return Math.max(0,Number(timerState.remaining_seconds)||0);return Math.max(0,Number(timerState.remaining_seconds)||0)}
function formatClock(s){const n=Math.max(0,Math.ceil(s));return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`}
function timerMarkup(){if(!timerState||timerState.status==='idle'||timerState.status==='stopped')return '';const remaining=timerRemaining(),duration=Math.max(1,Number(timerState.duration_seconds)||30),pct=Math.max(0,Math.min(100,remaining/duration*100));return `<div class="tv-timer ${remaining<=10?'is-warning':''} ${remaining<=5?'is-critical':''}"><div class="tv-timer-label">ВРЕМЯ НА ОТВЕТ</div><strong data-timer-value>${formatClock(remaining)}</strong><div class="tv-timer-track"><span data-timer-progress style="width:${pct}%"></span></div></div>`}
function timerHostMarkup(){const status=timerState.status||'idle',remaining=timerRemaining(),duration=Number(timerState.duration_seconds)||30;return `<section class="host-timer"><div class="host-timer-top"><b>Таймер ответа</b><strong data-timer-value>${formatClock(remaining)}</strong></div><div class="remote-progress"><span data-timer-progress style="width:${Math.min(100,remaining/Math.max(1,duration)*100)}%"></span></div><div class="host-timer-actions">${status==='running'?'<button class="outline" data-gq-action="timer-pause">Пауза</button>':status==='paused'?'<button class="outline" data-gq-action="timer-resume">Продолжить</button>':'<button class="outline" data-gq-action="timer-set">Запустить таймер</button>'}<button class="outline" data-gq-action="timer-add">+15 сек.</button><button class="outline" data-gq-action="timer-reset">Сбросить</button></div><div class="host-timer-set"><input id="timer-set-seconds" type="number" min="10" max="600" value="${duration}" aria-label="Время в секундах"><button class="secondary" data-gq-action="timer-set">Установить, сек.</button></div><p class="remote-help">${status==='running'?'Идёт отсчёт. По нулю ответы автоматически закроются.':status==='paused'?'Таймер на паузе.':'Таймер ожидает запуска.'}</p></section>`}
function screenBoard(title,rows){return `<section class="tv-podium-wrap"><div class="tv-topline">ИТОГИ РАУНДА</div><h1 class="tv-title">${h(title)}</h1>${scoreCards(rows,false)}</section>`}
function tvMusicIntro(q){return `<section class="tv-music-intro"><div class="tv-sticker">♫ РАУНД 03 · МУЗЫКА</div><div class="tv-music-kicker">ВОПРОС ${q.question_no+1} ИЗ 4</div><h1 class="tv-title">${h(q.title)}</h1><p class="tv-prompt">${h(musicRules(q))}</p><div class="tv-music-cta">Слушайте внимательно · ответы появятся после всех фрагментов</div></section>`}
function tvMusicAudio(q){const clip=currentAudioClip(q),clips=audioList(q);return `<section class="tv-audio-stage"><div class="tv-music-kicker">МУЗЫКАЛЬНЫЙ ФРАГМЕНТ ${Number(presentationState.clip_index)+1} ИЗ ${clips.length}</div><div class="tv-audio-disc"><span>♫</span></div><h1 class="tv-title">${h(clip?.label||'Аудиофрагмент')}</h1><p class="tv-prompt">Слушайте внимательно</p>${audioWave()}<div class="tv-audio-note">Варианты ответа появятся после прослушивания всех фрагментов</div></section>`}
function tvMemeIntro(q){return `<section class="tv-music-intro"><div class="tv-sticker">★ РАУНД 01 · МЕМЫ</div><div class="tv-music-kicker">ВОПРОС 1 ИЗ 4</div><h1 class="tv-title">${h(q.title)}</h1><p class="tv-prompt">Сейчас на экране по очереди появятся четыре мема. Запомните их и выберите тот, который Ира действительно лайкнула.</p><div class="tv-music-cta">Сначала смотрим · потом выбираем</div></section>`}
function tvMemeSlide(q){const i=Number(presentationState.clip_index)||0;const file=q.images?.[i];return `<section class="tv-meme-slide"><div class="tv-music-kicker">МЕМ ${i+1} ИЗ ${q.images?.length||4}</div><div class="tv-meme-slide-frame">${remoteImage(file,'tv-meme-slide-image',false)}</div><div class="tv-meme-slide-caption"><b>${optionLetter(i)}</b> · Запомните этот мем</div></section>`}
function tvQuestion(q){const c=gameControl(),teamMode=isTeamQuestion(c),isMusic=c.round_no===2,isMemeSequence=c.round_no===0&&c.question_no===0,stage=presentationState.stage||'answers';if(isMusic&&stage==='intro')return tvMusicIntro(q);if(isMusic&&stage==='audio')return tvMusicAudio(q);if(isMemeSequence&&stage==='intro')return tvMemeIntro(q);if(isMemeSequence&&stage==='media_slide')return tvMemeSlide(q);
 const order=q.type==='order',media=q.type==='media-select',multi=q.type==='multi';
 return `<div class="tv-question-layout ${order?'is-order':''} ${media?'is-media':''} ${multi?'is-bingo':''}"><div class="tv-question-heading"><div class="tv-top"><span>РАУНД ${c.round_no+1} ИЗ 5 · ${h(currentRoundName())}</span><span>ВОПРОС ${c.question_no+1} ИЗ ${ROUND_COUNTS[c.round_no]}</span></div><h1 class="tv-title">${h(q.title)}</h1><p class="tv-prompt">${h(q.prompt)}</p></div>${!order&&!media&&!multi?questionMedia(q,true):''}${answerOptionsHtml(q,true)}<div class="tv-question-meta"><span>${teamMode?'Отвечает капитан команды':'Отвечают все участники'}</span><span>Ответов: ${gameSnapshot.submission_count}/${gameSnapshot.required_count}</span></div>${timerMarkup()}</div>`}
function tvReview(q,raw){const stage=presentationState.stage||'review_options',c=gameControl();if(stage==='round_results')return (c.round_no===4||(c.round_no===5&&c.question_no===2))?screenBoard('Индивидуальный рейтинг',gameSnapshot?.leaderboard?.individual||[]):screenBoard('Командный рейтинг',gameSnapshot?.leaderboard?.team||[]);
 const answerVisible=stage==='review_correct'||stage==='review_explanation';
 const visualReveal=['order','multi','media-select'].includes(q.type);
 const revealTitle=q.type==='multi'?'Пять фактов — правда':q.type==='media-select'?'Вот тот самый мем':q.type==='order'?(q.images?'Правильная хронология':'Рейтинг Иры'):reviewAnswerText(q,raw.correct_answer);
 const content=stage==='review_explanation'?`<section class="tv-explanation-stage ${visualReveal?'has-visual-reveal':''}"><div class="tv-top">РАУНД ${c.round_no+1} · РАЗБОР</div><div class="tv-reveal-burst">✓</div><div class="tv-reveal-kicker">ПРАВИЛЬНЫЙ ОТВЕТ</div><h1 class="tv-title">${h(revealTitle)}</h1>${visualReveal?answerOptionsHtml(q,true,'correct',raw.correct_answer):''}${raw.explanation?`<p class="tv-prompt">${h(raw.explanation)}</p>`:''}${q.revealImage?remoteImage(q.revealImage,'tv-reveal-image',false):(!visualReveal&&q.image?remoteImage(q.image,'tv-reveal-image',false):'')}${q.audio_reveal?`<div class="tv-audio-note">♫ ${h(q.audio_reveal.label||'Правильное продолжение прозвучало')}</div>`:''}</section>`:
 `<section class="tv-review-stage"><div class="tv-top"><span>РАУНД ${c.round_no+1} · РАЗБОР</span><span>ВОПРОС ${c.question_no+1} ИЗ ${ROUND_COUNTS[c.round_no]}</span></div><h1 class="tv-title">${stage==='review_correct'?'Правильный ответ':'Разбираем вопрос'}</h1><h2 class="tv-review-question-title">${h(q.title)}</h2><p class="tv-prompt">${h(q.prompt)}</p>${q.type==='number'?`<div class="tv-number-review">${answerVisible?h(reviewAnswerText(q,raw.correct_answer)):'Ответ — число'}</div>`:answerOptionsHtml(q,true,answerVisible?'correct':'options',raw.correct_answer)}${q.image?questionMedia(q,true):''}</section>`;
 return content;
}
function screenView(){
 const c=gameControl(),q=currentQuestionRemote(),lb=gameSnapshot?.leaderboard||{};let content='';
 if(c.phase==='lobby')content=`<div class="tv-welcome"><div class="tv-sticker">★ ВЕЧЕРИНКА 2017 ★</div><h1 class="tv-title">Кто меня знает,<br>тот знает?</h1><p class="tv-prompt">Собирайтесь в команды. Будет неловко, смешно и очень по-нашему.</p><div class="tv-welcome-stats"><b>${state.people.length}</b> участников · <b>${remoteTeams.length}</b> команд</div></div>`;
 else if(c.phase==='question'&&q)content=tvQuestion(q);
 else if(c.phase==='review'){
  if(presentationState.stage==='round_results'){
   const individualTieBreak=c.round_no===4||(c.round_no===5&&c.question_no===2);
   content=screenBoard(individualTieBreak?'Индивидуальный рейтинг':'Командный рейтинг',individualTieBreak?(lb.individual||[]):(lb.team||[]));
  }else{
   const raw=currentReviewRaw();const rq=publicQuestion(raw);content=rq?tvReview(rq,raw):'<div class="tv-loading">Загружаем разбор…</div>'
  }
 }
 else content=`<div class="tv-welcome"><div class="tv-sticker">★ ФИНАЛ ★</div><h1 class="tv-title">${c.phase==='finished'?'Вот это была вписка!':'Наши победители'}</h1>${lb.team_tied?'<p class="tv-prompt">Командная ничья — совместная победа!</p>':''}</div>${screenBoard('Командный рейтинг',lb.team||[])}${lb.individual_visible?screenBoard('Индивидуальный рейтинг',lb.individual||[]):''}`;
 return `<main class="tv-wrap tv-round-${c.round_no} tv-phase-${c.phase}">${content}<div class="tv-footer"><span>Вписка · 2017</span><span id="tv-audio-hint">${tvAudioUnlocked?'Звук готов':'Звук телевизора не активирован'}</span><div class="tv-footer-actions">${!tvAudioUnlocked?'<button class="tv-fullscreen" data-gq-audio-unlock>Разрешить звук</button>':''}<button class="tv-fullscreen" data-gq-fullscreen>На весь экран</button></div></div></main>`;
}
function hostAudioPanel(q){const clip=currentAudioClip(q);if(!audioList(q).length&&!q?.audio_reveal)return '';return `<section class="remote-audio-panel"><div class="remote-audio-heading">Музыка на телевизоре</div>${clip?`<div class="host-current-clip"><b>Сейчас:</b> ${h(clip.label)}</div><button class="outline remote-action" data-gq-action="repeat-audio">↻ Повторить текущий фрагмент</button>`:''}<button class="audio-stop-button" data-gq-action="stop-audio">■ Остановить звук</button></section>`}
function adminPultView(){
 if(!admin)return `<main class="remote-shell"><h1>Пульт ведущей</h1><p class="remote-help">Войди в аккаунт организатора, чтобы управлять квизом.</p><label class="formlabel" for="admin-email">Электронная почта</label><input class="input" id="admin-email" type="email" placeholder="Email"><label class="formlabel" for="admin-password">Пароль</label><input class="input" id="admin-password" type="password" placeholder="Пароль"><button class="primary remote-action" data-gq-action="login">Войти</button><a href="./">Вернуться к профилю Иры</a></main>`;
 const c=gameControl(),lb=gameSnapshot?.leaderboard||{},stage=presentationState.stage||'idle';let controls='';
 if(c.phase==='lobby'){
  const ready=state.people.length>0&&state.people.every(p=>p.teamId)&&remoteTeams.length>0&&remoteTeams.every(t=>state.people.some(p=>p.teamId===t.id&&p.isCaptain));
  controls=`<h2>Команды и участники</h2>${teamManagement()}<div class="remote-status"><label class="formlabel" for="remote-actual">Непрочитанные сообщения Telegram</label><input class="input" id="remote-actual" type="number" min="0" step="1" value="${c.actual_count??''}" placeholder="Введи число до старта"><button class="secondary remote-action" data-gq-action="set_actual">Зафиксировать число</button><p class="remote-help">Число будет скрыто от гостей до разбора «У неё 99+».</p></div><button class="primary remote-action" data-gq-action="start" ${ready&&c.actual_count!==null?'':'disabled'}>Начать игру</button>${!ready?'<p class="remote-help">Распредели всех участников и назначь капитана каждой команде.</p>':c.actual_count===null?'<p class="remote-help">Сначала зафиксируй счётчик Telegram.</p>':''}`;
 }else if(c.phase==='question'){
  const q=currentQuestionRemote(),ready=gameSnapshot.submission_count>=gameSnapshot.required_count,isMusic=c.round_no===2,isMemeSequence=c.round_no===0&&c.question_no===0;
  if((isMusic||isMemeSequence)&&stage!=='answers'){
   const clip=currentAudioClip(q),clips=audioList(q),count=isMusic?clips.length:(q.images||[]).length,stageLabel=stage==='intro'?'Вступление и правила':isMusic?`Фрагмент ${Number(presentationState.clip_index)+1} из ${count}`:`Мем ${Number(presentationState.clip_index)+1} из ${count}`;
   controls=`<h2>${h(q?.title||(isMusic?'Музыкальный вопрос':'Вопрос с мемами'))}</h2><div class="remote-preview"><b>${stageLabel}</b><div class="remote-preview-meta">${stage==='intro'?h(isMusic?musicRules(q):'Показываем четыре мема по очереди. После показа появятся варианты ответа.'):h(isMusic?clip?.label||'Аудиофрагмент':q.options?.[presentationState.clip_index]||'Мем')}</div></div>${isMusic?hostAudioPanel(q):''}<button class="primary remote-action" data-gq-action="presentation-next">${stage==='intro'?(isMusic?'Начать прослушивание':'Показать первый мем'):Number(presentationState.clip_index)+1<count?(isMusic?'Следующий фрагмент →':'Следующий мем →'):'Перейти к вариантам ответа →'}</button><p class="remote-help">Каждый переход переключает телевизор${isMusic?' и запускает аудио':''}.</p>`;
  }else{
   const isLast=(c.round_no===5)||(c.round_no<5&&c.question_no===(ROUND_COUNTS[c.round_no]||1)-1),advanceAction=ready?'next_question':'close_question';
   controls=`<h2>${h(q?.title||'Текущий вопрос')}</h2><div class="remote-preview"><b>${h(q?.prompt||'')}</b><div class="remote-preview-meta">${isTeamQuestion(c)?'Командный ответ · только капитан':'Индивидуальный ответ'}</div></div>${isMusic?hostAudioPanel(q):''}<div class="remote-status"><div class="remote-countline"><span>Получено ответов</span><b>${gameSnapshot.submission_count}/${gameSnapshot.required_count}</b></div><div class="remote-progress"><span style="width:${gameSnapshot.required_count?100*gameSnapshot.submission_count/gameSnapshot.required_count:0}%"></span></div></div>${timerHostMarkup()}<p class="remote-help">После закрытия вопроса сначала покажем варианты, затем правильный ответ и объяснение.</p><button class="primary remote-action" data-gq-action="${advanceAction}">${ready?'Закрыть ответы и начать разбор':'Закрыть приём ответов досрочно'}</button>`;
  }
 }else if(c.phase==='review'){
  const raw=currentReviewRaw(),rq=publicQuestion(raw),last=c.question_no===(ROUND_COUNTS[c.round_no]||1)-1;
  if(stage==='review_options')controls=`<h2>Разбор · вопрос ${c.question_no+1} из ${ROUND_COUNTS[c.round_no]||1}</h2><div class="remote-preview"><b>${h(rq?.title||'')}</b><div class="remote-preview-meta">Сначала показываем все варианты без подсказки.</div></div><button class="primary remote-action" data-gq-action="presentation-next">Показать правильный ответ →</button>`;
  else if(stage==='review_correct')controls=`<h2>Правильный ответ</h2><div class="remote-preview"><b>${h(rq?.title||'')}</b><div class="remote-preview-answer">${h(raw?reviewAnswerText(rq,raw.correct_answer):'')}</div></div><button class="primary remote-action" data-gq-action="presentation-next">Показать пояснение и оригинал →</button>`;
  else if(stage==='review_explanation')controls=`<h2>Пояснение и оригинал</h2>${rq?.audio_reveal?`<button class="outline remote-action" data-gq-action="repeat-audio">↻ Повторить правильный аудиофрагмент</button>`:''}${last?'<button class="primary remote-action" data-gq-action="presentation-next">Показать итоги раунда →</button>':'<button class="primary remote-action" data-gq-action="presentation-next">Открыть следующий вопрос →</button>'}`;
  else if(stage==='round_results'){
   if(c.round_no===5&&c.question_no<2){const stillTied=!!lb.team_tied;controls=`<h2>Итоги тай-брейка</h2>${remoteScorePanel()}${c.question_no===0&&stillTied?'<button class="primary remote-action" data-gq-action="next_team_tiebreak">Ничья сохраняется — открыть второе командное задание</button>':''}<button class="secondary remote-action" data-gq-action="finish_team_tiebreak">${stillTied?'Зафиксировать совместную победу':'Продолжить'}</button>`}
   else if(c.round_no===5&&c.question_no===2)controls=`<h2>Итоги индивидуального тай-брейка</h2>${remoteScorePanel()}<button class="primary remote-action" data-gq-action="finish_individual_tiebreak">Завершить индивидуальный тай-брейк</button>`;
   else controls=`<h2>Итоги раунда</h2>${remoteScorePanel()}<button class="primary remote-action" data-gq-action="next_round">${c.round_no===4?'Показать финальные рейтинги':'Перейти к следующему раунду'}</button>`;
  }
 }else if(c.phase==='final_results'){
  const teamPending=!!lb.team_tied&&!lb.team_tiebreak_used,individualPending=!!lb.individual_tied&&!lb.individual_tiebreak_used;
  controls=`<h2>Итоги основной игры</h2>${remoteScorePanel()}${teamPending?'<button class="primary remote-action" data-gq-action="start_team_tiebreak">Командная ничья — начать «Великие цитаты»</button>':lb.team_tied?'<p class="remote-help">Командная ничья сохранилась: совместная победа.</p>':'<p class="remote-help">Командный победитель определён.</p>'}${individualPending?'<button class="primary remote-action" data-gq-action="start_individual_tiebreak">Ничья в индивидуальном рейтинге — начать «У неё 99+»</button>':lb.individual_tied?'<p class="remote-help">Индивидуальная ничья сохранилась.</p>':'<p class="remote-help">Индивидуальный победитель определён.</p>'}<button class="secondary remote-action" data-gq-action="finish">Завершить игру</button>`;
 }else controls=`${remoteScorePanel()}<button class="secondary remote-action" data-gq-action="reset">Сбросить игру для новой партии</button>`;
 const status=c.round_no===5?(c.question_no<2?'Командный тай-брейк':'Индивидуальный тай-брейк'):`Раунд ${c.round_no+1}: ${h(ROUND_TITLES[c.round_no]||'')}`;
 return `<main class="remote-shell"><div class="quickline" style="justify-content:space-between"><div><div class="remote-kicker">ВПИСКА · 2017</div><h1>Пульт ведущей</h1></div><button class="outline" data-gq-action="logout">Выйти</button></div><div class="remote-status"><b>${c.phase==='question'&&c.round_no===2?`Музыка · ${stage}`:c.phase==='review'?`Разбор · ${stage}`:c.phase}</b><div class="remote-help">${status}${c.phase==='question'?` · вопрос ${c.question_no+1}`:''}</div></div><a class="outline remote-tv-link" href="?screen=1" target="_blank">Открыть экран телевизора ↗</a>${controls}</main>`;
}
function remoteRender(){document.body.classList.toggle('screen-mode',IS_TV);document.body.classList.toggle('admin-remote-mode',IS_HOST_REMOTE);if(IS_TV){document.getElementById('app').innerHTML=screenView();return}if(IS_HOST_REMOTE){document.getElementById('app').innerHTML=adminPultView();return}const pageContent=page==='game'?remoteGame():page==='scores'?remoteScorePanel():view();document.getElementById('app').innerHTML=pageContent+`<footer class="footer">ВКонтакте © 2017 · Шуточная страница для дня рождения</footer>`;document.querySelectorAll('[data-page]').forEach(x=>x.classList.toggle('active',x.dataset.page===page));document.getElementById('topuser').textContent=currentUser()?.name||(admin?'организатор':'гость')}
function remoteReviewForGame(){return remoteReview()}
window.render=remoteRender;window.game=remoteGame;window.join=joinRemote;window.quizCard=remoteQuestionCard;window.review=remoteReviewForGame;window.scorePanel=remoteScorePanel;window.adminEntry=remoteAdminEntry;window.question=currentQuestionRemote;window.canAnswer=remoteCanAnswer;window.ownAnswer=()=>gameSnapshot?.my_answer;
window.handle=function(doWhat){if(doWhat==='admin-toggle'){adminLoginOpen=!adminLoginOpen;render();return}if(doWhat==='admin-login')return adminLogin();if(doWhat==='admin-logout')return adminLogout();if(doWhat==='team-create')return createTeam();return legacyAppHandle?.(doWhat)};
function openQuizZoom(src){if(IS_TV)return;photoList=[src];photoIndex=0;const box=document.getElementById('lightbox');const img=document.getElementById('light-img');img.style.transform='scale(1)';img.style.transformOrigin='center';document.getElementById('light-count').textContent='Увеличение · двойное нажатие или жест двумя пальцами';document.getElementById('prev-photo').style.display='none';document.getElementById('next-photo').style.display='none';img.src=src;box.classList.remove('hidden');box.classList.add('quiz-zoom-open')}
function restorePhotoLightbox(){document.getElementById('prev-photo').style.display='';document.getElementById('next-photo').style.display='';document.getElementById('lightbox').classList.remove('quiz-zoom-open')}
const lightboxClose=document.getElementById('close-lightbox');lightboxClose?.addEventListener('click',restorePhotoLightbox);
let zoomScale=1,pinchStart=0,pinchBase=1;
const zoomImg=document.getElementById('light-img');zoomImg?.addEventListener('dblclick',()=>{zoomScale=zoomScale>1?1:2;zoomImg.style.transform=`scale(${zoomScale})`});
zoomImg?.addEventListener('wheel',e=>{if(!document.getElementById('lightbox').classList.contains('quiz-zoom-open'))return;e.preventDefault();zoomScale=Math.max(1,Math.min(4,zoomScale+(e.deltaY<0?.2:-.2)));zoomImg.style.transform=`scale(${zoomScale})`},{passive:false});
zoomImg?.addEventListener('touchstart',e=>{if(e.touches.length===2){pinchStart=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);pinchBase=zoomScale}},{passive:true});
zoomImg?.addEventListener('touchmove',e=>{if(e.touches.length===2&&pinchStart){const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);zoomScale=Math.max(1,Math.min(4,pinchBase*d/pinchStart));zoomImg.style.transform=`scale(${zoomScale})`}},{passive:true});
zoomImg?.addEventListener('touchend',()=>{pinchStart=0});
document.addEventListener('click',async e=>{
 const zoom=e.target.closest('[data-quiz-zoom]');if(zoom){e.preventDefault();e.stopPropagation();zoomScale=1;openQuizZoom(zoom.src);return}
 const n=e.target.closest('[data-gq-action],[data-gq-single],[data-gq-multi],[data-gq-move],[data-gq-fullscreen],[data-gq-audio-unlock]');if(!n)return;
 if(n.hasAttribute('data-gq-audio-unlock')){await unlockTvAudio();return}
 if(n.hasAttribute('data-gq-fullscreen')){try{await document.documentElement.requestFullscreen()}catch(err){notify('Полноэкранный режим не поддерживается этим браузером')}return}
 if(n.dataset.gqSingle!==undefined){gameDraft=Number(n.dataset.gqSingle);render();return}
 if(n.dataset.gqMulti!==undefined){const i=Number(n.dataset.gqMulti);gameDraft=Array.isArray(gameDraft)?(gameDraft.includes(i)?gameDraft.filter(x=>x!==i):gameDraft.length<5?[...gameDraft,i]:gameDraft):[i];render();return}
 if(n.dataset.gqMove!==undefined){const i=Number(n.dataset.gqMove),j=i+(n.dataset.dir==='up'?-1:1);if(!Array.isArray(gameDraft)||j<0||j>=gameDraft.length)return;[gameDraft[i],gameDraft[j]]=[gameDraft[j],gameDraft[i]];render();return}
 const action=n.dataset.gqAction;if(action==='join')return joinRemote();if(action==='submit')return submitRemoteAnswer();if(action==='login')return adminLogin();if(action==='logout')return adminLogout();if(action==='toggle-login'){adminLoginOpen=!adminLoginOpen;render();return}
 if(['start','next_question','close_question','next_round','start_team_tiebreak','next_team_tiebreak','finish_team_tiebreak','start_individual_tiebreak','finish_individual_tiebreak','set_actual','finish','reset','presentation-next','timer-pause','timer-resume','timer-reset','timer-add','timer-set','repeat-audio','stop-audio'].includes(action))return adminGameAction(action);
});
// Ordering: desktop HTML drag/drop plus touch handle for phones. Arrow buttons remain available.
function moveQuizOrder(from,to){
 if(!remoteCanAnswer()||isAnswerSubmitted()||!Array.isArray(gameDraft)||!Number.isInteger(from)||!Number.isInteger(to)||from===to||from<0||to<0||from>=gameDraft.length||to>=gameDraft.length)return false;
 const [moved]=gameDraft.splice(from,1);gameDraft.splice(to,0,moved);render();return true;
}
document.addEventListener('dragstart',e=>{const item=e.target.closest('[data-order-index]');if(!item)return;if(!remoteCanAnswer()||isAnswerSubmitted()){e.preventDefault();return}e.dataTransfer.setData('text/plain',item.dataset.orderIndex);e.dataTransfer.effectAllowed='move'});
document.addEventListener('dragover',e=>{if(e.target.closest('[data-order-index]')&&remoteCanAnswer()&&!isAnswerSubmitted())e.preventDefault()});
document.addEventListener('drop',e=>{const target=e.target.closest('[data-order-index]');if(!target)return;e.preventDefault();moveQuizOrder(Number(e.dataTransfer.getData('text/plain')),Number(target.dataset.orderIndex))});
let touchOrderDrag=null;
document.addEventListener('touchstart',e=>{const handle=e.target.closest('.phone-order-handle');if(!handle||!remoteCanAnswer()||isAnswerSubmitted()||e.touches.length!==1)return;const item=handle.closest('[data-order-index]');if(!item)return;touchOrderDrag={id:e.touches[0].identifier,from:Number(item.dataset.orderIndex),to:Number(item.dataset.orderIndex),item};item.classList.add('is-dragging')},{passive:true});
document.addEventListener('touchmove',e=>{if(!touchOrderDrag)return;const touch=Array.from(e.touches).find(t=>t.identifier===touchOrderDrag.id);if(!touch)return;e.preventDefault();const target=document.elementFromPoint(touch.clientX,touch.clientY)?.closest('[data-order-index]');if(target){document.querySelectorAll('.phone-order-item.is-drop-target').forEach(n=>n.classList.remove('is-drop-target'));target.classList.add('is-drop-target');touchOrderDrag.to=Number(target.dataset.orderIndex)}},{passive:false});
function finishTouchOrderDrag(){if(!touchOrderDrag)return;const {from,to}=touchOrderDrag;touchOrderDrag.item.classList.remove('is-dragging');document.querySelectorAll('.phone-order-item.is-drop-target').forEach(n=>n.classList.remove('is-drop-target'));touchOrderDrag=null;moveQuizOrder(from,to)}
document.addEventListener('touchend',e=>{if(touchOrderDrag&&Array.from(e.changedTouches).some(t=>t.identifier===touchOrderDrag.id))finishTouchOrderDrag()},{passive:true});
document.addEventListener('touchcancel',()=>{if(touchOrderDrag){touchOrderDrag.item.classList.remove('is-dragging');document.querySelectorAll('.phone-order-item.is-drop-target').forEach(n=>n.classList.remove('is-drop-target'));touchOrderDrag=null}},{passive:true});
function timerTick(){const remaining=timerRemaining(),duration=Math.max(1,Number(timerState.duration_seconds)||30),pct=Math.max(0,Math.min(100,remaining/duration*100));document.querySelectorAll('[data-timer-value]').forEach(n=>n.textContent=formatClock(remaining));document.querySelectorAll('[data-timer-progress]').forEach(n=>n.style.width=pct+'%');document.querySelectorAll('.tv-timer,.player-timer').forEach(n=>{n.classList.toggle('is-warning',remaining<=10);n.classList.toggle('is-critical',remaining<=5)});if(timerState.status==='running'&&remaining<=0&&!timerExpiryRequested){timerExpiryRequested=true;supabaseClient.rpc('expire_quiz_timer').then(({error})=>{if(error)console.error(error);refreshGameSnapshot(true)}).finally(()=>{timerExpiryRequested=false})}}
async function unlockTvAudio(){const player=document.getElementById('quiz-tv-audio');if(!player)return;try{player.src='assets/audio/quiz_silence.wav';player.volume=0;await player.play();player.pause();player.currentTime=0;player.volume=1;tvAudioUnlocked=true;const hint=document.getElementById('tv-audio-hint');if(hint)hint.textContent='Звук готов · управление с телефона';document.querySelector('[data-gq-audio-unlock]')?.remove();const q=currentQuestionRemote(),clip=currentAudioClip(q);if(gameControl().phase==='question'&&presentationState.stage==='audio'&&clip?.file)playTvClip(clip.file)}catch(e){notify('Не удалось активировать звук в этом браузере')}}
function playTvClip(file){const player=document.getElementById('quiz-tv-audio');if(!player||!file)return;player.pause();player.src='assets/audio/'+file;player.currentTime=0;player.load();player.play().catch(()=>{const hint=document.getElementById('tv-audio-hint');if(hint)hint.textContent='Нажми «Разрешить звук» на экране телевизора один раз.'});lastTvClip=file}
function handleTvAudioEvent(row){if(!IS_TV||!row)return;if(row.action==='stop'){const p=document.getElementById('quiz-tv-audio');p?.pause();if(p)p.currentTime=0;return}if(row.clip)playTvClip(row.clip)}
async function initRemoteGame(){
 if(!supabaseClient){notify('Не удалось подключить Supabase');return}
 const {data}=await supabaseClient.auth.getSession();admin=!!data.session&&data.session.user?.id===ORGANIZER_UID;if(data.session&&!admin)await supabaseClient.auth.signOut();
 await loadRemoteRoster();await refreshGameSnapshot(false);
 if(IS_TV)tvAudioChannel=supabaseClient.channel('ira-quiz-audio-v5').on('postgres_changes',{event:'INSERT',schema:'public',table:'quiz_audio_events'},payload=>handleTvAudioEvent(payload.new)).subscribe();
 gameChannel=supabaseClient.channel('ira-game-live-v5').on('postgres_changes',{event:'*',schema:'public',table:'quiz_control'},()=>refreshGameSnapshot()).on('postgres_changes',{event:'*',schema:'public',table:'teams'},async()=>{await loadRemoteRoster();await refreshGameSnapshot(false);render()}).on('postgres_changes',{event:'*',schema:'public',table:'participants'},async()=>{await loadRemoteRoster();await refreshGameSnapshot(false);render()}).subscribe();
 presentationChannel=supabaseClient.channel('ira-presentation-v5').on('postgres_changes',{event:'*',schema:'public',table:'quiz_presentation_state'},payload=>{
  // The realtime row already contains the next slide and clip index.
  if(payload.new&&typeof payload.new.stage==='string'){
   presentationState=payload.new;
   if(gameSnapshot&&Number(gameControl().round_no)===Number(payload.new.round_no)&&Number(gameControl().question_no)===Number(payload.new.question_no)){render();return}
  }
  refreshGameSnapshot();
 }).subscribe();
 timerChannel=supabaseClient.channel('ira-timer-v5').on('postgres_changes',{event:'*',schema:'public',table:'quiz_timer_state'},()=>refreshGameSnapshot()).subscribe();
 supabaseClient.auth.onAuthStateChange(async(_event,session)=>{admin=!!session&&session.user?.id===ORGANIZER_UID;if(session&&!admin)await supabaseClient.auth.signOut();await refreshGameSnapshot(false);render()});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshGameSnapshot()});
 if(timerInterval)clearInterval(timerInterval);timerInterval=setInterval(timerTick,250);setInterval(()=>{if(!document.hidden&&timerState.status==='running')refreshGameSnapshot(false)},20000);render();
}
initRemoteGame();
